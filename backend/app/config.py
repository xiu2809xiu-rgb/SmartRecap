from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    azure_ai_endpoint: str = ""
    azure_ai_api_key: SecretStr = SecretStr("")
    azure_openai_deployment: str = "gpt-5.6-sol"
    azure_fast_deployment: str = "gpt-5.6-sol"
    azure_content_endpoint: str = ""
    azure_content_api_key: SecretStr = SecretStr("")
    azure_content_analyzer_id: str = "prebuilt-layout"
    gemini_api_key: SecretStr = SecretStr("")
    gemini_model: str = "gemini-2.5-flash"
    openai_api_key: SecretStr = SecretStr("")
    openai_chat_model: str = "gpt-4.1-mini"
    # Must match VITE_GOOGLE_CLIENT_ID on the frontend exactly: the token's
    # audience is checked against it, so a mismatch rejects every sign-in.
    # NVIDIA NIM. Powers the coding help in the practice panel
    # (qwen2.5-coder-32b-instruct) and is the declared generation failover.
    nvidia_api_key: SecretStr = SecretStr("")
    google_client_id: str = ""
    demo_mode: bool = False
    cors_origins: str = "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3000,http://localhost:3000"
    max_file_mb: int = 25
    enable_paddle_ocr: bool = True
    enable_math_ocr: bool = False
    math_ocr_max_pages: int = 8
    ocr_max_images: int = 24
    ocr_time_budget_seconds: int = 120
    ai_timeout_seconds: int = 300
    aws_region: str = "us-east-1"
    s3_bucket: str = ""
    s3_prefix: str = "smartrecap"
    table_name: str = ""
    enable_study_images: bool = False
    pollinations_base_url: str = "https://gen.pollinations.ai"
    pollinations_model: str = "flux"
    pollinations_api_key: SecretStr = SecretStr("")

    model_config = SettingsConfigDict(env_file=Path(__file__).resolve().parents[1] / ".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def allowed_origins(self) -> List[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def azure_ready(self) -> bool:
        return bool(self.azure_ai_endpoint and self.azure_ai_api_key.get_secret_value())

    @property
    def content_understanding_ready(self) -> bool:
        key = self.azure_content_api_key.get_secret_value() or self.azure_ai_api_key.get_secret_value()
        return bool(self.azure_content_endpoint and key)

    @property
    def gemini_ready(self) -> bool:
        return bool(self.gemini_api_key.get_secret_value())

    @property
    def openai_ready(self) -> bool:
        return bool(self.openai_api_key.get_secret_value())


@lru_cache
def get_settings() -> Settings:
    return Settings()