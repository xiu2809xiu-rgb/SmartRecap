import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .config import Settings
from .storage import ObjectStorage

logger = logging.getLogger("smartrecap.repository")


class DurableRepository:
    """Owner-partitioned durable records with an explicit, index-only PUBLIC area."""

    public_partition = "PUBLIC"

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

    @staticmethod
    def _owner_partition(owner_id: str) -> str:
        owner = str(owner_id).strip()
        if not owner:
            raise ValueError("owner_id is required")
        return f"USER#{owner}"

    @staticmethod
    def _overflow_path(owner_id: str, kind: str, record_id: str) -> str:
        owner_key = hashlib.sha256(owner_id.encode("utf-8")).hexdigest()
        record_key = hashlib.sha256(record_id.encode("utf-8")).hexdigest()
        safe_kind = "".join(ch for ch in kind if ch.isalnum() or ch in "_-")[:64]
        if not safe_kind:
            raise ValueError("kind is invalid")
        return f"state/users/{owner_key}/{safe_kind}/{record_key}.json"

    def _save_partition(self, partition: str, overflow_owner: str, kind: str, record_id: str, value: Any) -> None:
        if not self.ready:
            return
        payload = self._json(value)
        path = self._overflow_path(overflow_owner, kind, record_id)
        item: Dict[str, Any] = {
            "pk": partition, "sk": f"{kind}#{record_id}", "kind": kind,
            "recordId": record_id, "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        if len(payload.encode("utf-8")) > 280_000 or kind in {"source", "binder_source", "message"}:
            if not self.storage.ready:
                raise ValueError("Large durable records require S3_BUCKET to be configured.")
            item["s3Key"] = self.storage.put_json(path, value)
        else:
            item["payload"] = payload
        self.table.put_item(Item=item)
        if "s3Key" not in item and self.storage.ready:
            self.storage.delete_key(self.storage.object_key(path))

    def save(self, owner_id: str, kind: str, record_id: str, value: Any) -> None:
        self._save_partition(self._owner_partition(owner_id), owner_id, kind, record_id, value)

    def save_public(self, kind: str, record_id: str, value: Any) -> None:
        self._save_partition(self.public_partition, self.public_partition, kind, record_id, value)

    def _decode(self, item: Dict[str, Any]) -> Any:
        if item.get("s3Key"):
            return self.storage.get_json(str(item["s3Key"]))
        return json.loads(str(item.get("payload") or "null"))

    def _get_partition(self, partition: str, kind: str, record_id: str) -> Any:
        if not self.ready:
            return None
        response = self.table.get_item(Key={"pk": partition, "sk": f"{kind}#{record_id}"})
        item = response.get("Item")
        return self._decode(item) if item else None

    def get(self, owner_id: str, kind: str, record_id: str) -> Any:
        return self._get_partition(self._owner_partition(owner_id), kind, record_id)

    def get_public(self, kind: str, record_id: str) -> Any:
        return self._get_partition(self.public_partition, kind, record_id)

    def _load_partition(self, partition: str, kind: str) -> List[Dict[str, Any]]:
        if not self.ready:
            return []
        from boto3.dynamodb.conditions import Key
        records: List[Dict[str, Any]] = []
        query: Dict[str, Any] = {"KeyConditionExpression": Key("pk").eq(partition) & Key("sk").begins_with(f"{kind}#")}
        while True:
            try:
                response = self.table.query(**query)
            except Exception as exc:
                logger.warning("Could not query durable %s records: %s", kind, exc)
                break
            for item in response.get("Items", []):
                try:
                    records.append({"id": str(item["recordId"]), "value": self._decode(item)})
                except Exception as exc:
                    logger.warning("Skipping invalid durable %s record %s: %s", kind, item.get("sk", "unknown"), exc)
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                break
            query["ExclusiveStartKey"] = last_key
        return records

    def load_kind(self, owner_id: str, kind: str) -> List[Dict[str, Any]]:
        return self._load_partition(self._owner_partition(owner_id), kind)

    def load_public_kind(self, kind: str) -> List[Dict[str, Any]]:
        return self._load_partition(self.public_partition, kind)

    def _delete_partition(self, partition: str, overflow_owner: str, kind: str, record_id: str) -> None:
        if not self.ready:
            return
        self.table.delete_item(Key={"pk": partition, "sk": f"{kind}#{record_id}"})
        if self.storage.ready:
            self.storage.delete_key(self.storage.object_key(self._overflow_path(overflow_owner, kind, record_id)))

    def delete(self, owner_id: str, kind: str, record_id: str) -> None:
        self._delete_partition(self._owner_partition(owner_id), owner_id, kind, record_id)

    def delete_public(self, kind: str, record_id: str) -> None:
        self._delete_partition(self.public_partition, self.public_partition, kind, record_id)

    def health(self) -> str:
        return "Amazon DynamoDB owner-partitioned state" if self.ready else "in-memory state"
