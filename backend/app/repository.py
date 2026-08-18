import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List

from .config import Settings
from .storage import ObjectStorage

logger = logging.getLogger("smartrecap.repository")


class DurableRepository:
    """Optional DynamoDB index with S3 overflow for shared FastAPI state."""

    partition = "SMARTRECAP#SHARED"

    def __init__(self, settings: Settings, storage: ObjectStorage) -> None:
        self.table_name = settings.table_name.strip()
        self.region = settings.aws_region.strip() or "us-east-1"
        self.storage = storage
        self._table = None

    @property
    def ready(self) -> bool:
        return bool(self.table_name)

    @property
    def table(self):
        if self._table is None:
            import boto3

            self._table = boto3.resource("dynamodb", region_name=self.region).Table(self.table_name)
        return self._table

    @staticmethod
    def _json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    def save(self, kind: str, record_id: str, value: Any) -> None:
        if not self.ready:
            return
        payload = self._json(value)
        item: Dict[str, Any] = {
            "pk": self.partition,
            "sk": f"{kind}#{record_id}",
            "kind": kind,
            "recordId": record_id,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        overflow_key = self.storage.object_key(f"state/{kind}/{record_id}.json")
        if len(payload.encode("utf-8")) > 280_000 or kind in {"source", "binder_source"}:
            if not self.storage.ready:
                raise ValueError("Large durable records require S3_BUCKET to be configured.")
            item["s3Key"] = self.storage.put_json(f"state/{kind}/{record_id}.json", value)
        else:
            item["payload"] = payload
        self.table.put_item(Item=item)
        if "s3Key" not in item and self.storage.ready:
            self.storage.delete_key(overflow_key)

    def load_kind(self, kind: str) -> List[Dict[str, Any]]:
        if not self.ready:
            return []
        from boto3.dynamodb.conditions import Key

        records: List[Dict[str, Any]] = []
        query: Dict[str, Any] = {
            "KeyConditionExpression": Key("pk").eq(self.partition)
            & Key("sk").begins_with(f"{kind}#")
        }
        while True:
            try:
                response = self.table.query(**query)
            except Exception as exc:
                logger.warning("Could not query durable %s records: %s", kind, exc)
                break
            for item in response.get("Items", []):
                try:
                    record_id = str(item["recordId"])
                    if item.get("s3Key"):
                        value = self.storage.get_json(str(item["s3Key"]))
                    else:
                        value = json.loads(str(item.get("payload") or "null"))
                    records.append({"id": record_id, "value": value})
                except Exception as exc:
                    logger.warning(
                        "Skipping invalid durable %s record %s: %s",
                        kind,
                        item.get("sk", "unknown"),
                        exc,
                    )
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                break
            query["ExclusiveStartKey"] = last_key
        return records

    def delete(self, kind: str, record_id: str) -> None:
        if not self.ready:
            return
        self.table.delete_item(
            Key={"pk": self.partition, "sk": f"{kind}#{record_id}"}
        )
        if self.storage.ready:
            self.storage.delete_key(self.storage.object_key(f"state/{kind}/{record_id}.json"))

    def health(self) -> str:
        return "Amazon DynamoDB shared state" if self.ready else "in-memory state"
