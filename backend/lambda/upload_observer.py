from __future__ import annotations

import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote_plus

import boto3

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
_s3_client = None
_table = None


def _settings() -> tuple[str, str, int]:
    bucket = os.environ.get("SOURCE_BUCKET", "").strip()
    prefix = os.environ.get("OBJECT_PREFIX", "smartrecap").strip().strip("/")
    ttl_days = max(1, min(30, int(os.environ.get("OBSERVATION_TTL_DAYS", "7"))))
    if not bucket or not prefix or not os.environ.get("TABLE_NAME", "").strip():
        raise RuntimeError("SOURCE_BUCKET, OBJECT_PREFIX, and TABLE_NAME are required")
    return bucket, prefix, ttl_days


def _clients():
    global _s3_client, _table
    if _s3_client is None:
        _s3_client = boto3.client("s3")
    if _table is None:
        _table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
    return _s3_client, _table


def _upload(event: dict[str, Any], expected_bucket: str, prefix: str):
    if event.get("source") != "aws.s3" or event.get("detail-type") != "Object Created":
        return None
    detail = event.get("detail") or {}
    bucket = str((detail.get("bucket") or {}).get("name") or "")
    object_data = detail.get("object") or {}
    key = unquote_plus(str(object_data.get("key") or ""))
    match = re.fullmatch(rf"{re.escape(prefix)}/uploads/([^/]+)/source", key)
    if bucket != expected_bucket or not match:
        return None
    return match.group(1), bucket, key, object_data


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    expected_bucket, prefix, ttl_days = _settings()
    upload = _upload(event, expected_bucket, prefix)
    if upload is None:
        return {"observed": False, "reason": "event_not_in_upload_scope"}

    source_id, bucket, key, object_data = upload
    s3, table = _clients()
    response = s3.get_object(Bucket=bucket, Key=key, Range="bytes=0-4")
    body = response["Body"]
    try:
        is_pdf = body.read(5) == b"%PDF-"
    finally:
        body.close()

    now = datetime.now(timezone.utc)
    observed_at = event.get("time") if isinstance(event.get("time"), str) else now.isoformat()
    item = {
        "pk": f"UPLOAD#{source_id}",
        "sk": "OBSERVATION",
        "kind": "upload_observation",
        "sourceId": source_id,
        "status": "valid_pdf" if is_pdf else "invalid_pdf",
        "bucket": bucket,
        "objectKey": key,
        "eventId": str(event.get("id") or "unknown"),
        "etag": str(object_data.get("etag") or "").strip('"'),
        "sizeBytes": int(object_data.get("size") or 0),
        "contentType": str(response.get("ContentType") or "application/octet-stream"),
        "observedAt": observed_at,
        "expiresAt": int(time.time()) + ttl_days * 86_400,
    }
    table.put_item(Item=item)
    logger.info("Observed source upload source_id=%s status=%s", source_id, item["status"])
    return {
        "observed": True,
        "sourceId": source_id,
        "status": item["status"],
        "receiptKey": {"pk": item["pk"], "sk": item["sk"]},
    }
