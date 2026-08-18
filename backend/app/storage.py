import json
from typing import Any, Dict, Tuple

from .config import Settings


class ObjectStorage:
    """Private S3 storage using the EC2 role or the local AWS credential chain."""

    def __init__(self, settings: Settings) -> None:
        self.bucket = settings.s3_bucket.strip()
        self.region = settings.aws_region.strip() or "us-east-1"
        self.prefix = settings.s3_prefix.strip().strip("/") or "smartrecap"
        self._client = None

    @property
    def ready(self) -> bool:
        return bool(self.bucket)

    @property
    def client(self):
        if self._client is None:
            import boto3
            self._client = boto3.client("s3", region_name=self.region)
        return self._client

    def object_key(self, key: str) -> str:
        return f"{self.prefix}/{key.lstrip('/')}"

    def upload_key(self, material_id: str) -> str:
        return self.object_key(f"uploads/{material_id}/source")

    def presign_upload(self, material_id: str, content_type: str) -> Tuple[str, str]:
        key = self.upload_key(material_id)
        url = self.client.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": content_type},
            ExpiresIn=900,
        )
        return key, url

    def get_bytes(self, key: str, max_bytes: int, material_id: str) -> bytes:
        if key != self.upload_key(material_id):
            raise ValueError("The S3 upload key does not belong to this material.")
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        body = response["Body"]
        try:
            if int(response.get("ContentLength", 0)) > max_bytes:
                raise ValueError("The S3 upload exceeds the configured file-size limit.")
            content = body.read(max_bytes + 1)
            if len(content) > max_bytes:
                raise ValueError("The S3 upload exceeds the configured file-size limit.")
            return content
        finally:
            body.close()

    def put_json(self, key: str, value: Any) -> str:
        object_key = self.object_key(key)
        self.client.put_object(
            Bucket=self.bucket,
            Key=object_key,
            Body=json.dumps(value, ensure_ascii=False).encode("utf-8"),
            ContentType="application/json",
            ServerSideEncryption="AES256",
        )
        return object_key

    def get_json(self, key: str, max_bytes: int = 8_000_000) -> Any:
        if not key.startswith(f"{self.prefix}/"):
            raise ValueError("The S3 state key is outside the configured prefix.")
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        body = response["Body"]
        try:
            if int(response.get("ContentLength", 0)) > max_bytes:
                raise ValueError("The S3 state record exceeds the safety limit.")
            content = body.read(max_bytes + 1)
            if len(content) > max_bytes:
                raise ValueError("The S3 state record exceeds the safety limit.")
            return json.loads(content.decode("utf-8"))
        finally:
            body.close()

    def put_image(self, key: str, content: bytes, content_type: str) -> str:
        object_key = self.object_key(key)
        self.client.put_object(
            Bucket=self.bucket,
            Key=object_key,
            Body=content,
            ContentType=content_type,
            ServerSideEncryption="AES256",
        )
        return object_key

    def get_image(self, key: str, max_bytes: int = 8_000_000) -> Tuple[bytes, str]:
        if not key.startswith(f"{self.prefix}/"):
            raise ValueError("The S3 image key is outside the configured prefix.")
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        body = response["Body"]
        try:
            content = body.read(max_bytes + 1)
            if len(content) > max_bytes:
                raise ValueError("The generated image exceeds the safety limit.")
            return content, str(response.get("ContentType") or "image/jpeg")
        finally:
            body.close()

    def delete_key(self, key: str) -> None:
        if not self.ready:
            return
        if not key.startswith(f"{self.prefix}/"):
            raise ValueError("The S3 deletion key is outside the configured prefix.")
        self.client.delete_object(Bucket=self.bucket, Key=key)
