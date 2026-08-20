import secrets
from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic import Field, SecretStr
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
    openrouter_api_key: SecretStr = SecretStr("")
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_model: str = ""
    # The IDE coding agent. Separate from `openrouter_model` so changing the
    # recap failover model does not silently change what reviews code.
    openrouter_code_model: str = "poolside/laguna-s-2.1:free"
    # Read-aloud. Both are overridable from the environment because a model id
    # is a moving target — the previous coding model was retired mid-project.
    # Turns a recap into a script meant to be heard rather than read. Separate
    # from the TTS model: one writes the words, the other speaks them.
    openrouter_narration_model: str = "z-ai/glm-5.2:free"
    openrouter_tts_model: str = "deepgram/flux-tts:free"
    openrouter_tts_voice: str = "flux-alexis-en"
    nvidia_api_key: SecretStr = SecretStr("")
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    nvidia_model: str = ""
    # Must match VITE_GOOGLE_CLIENT_ID on the frontend exactly: the token's
    # audience is checked against it, so a mismatch rejects every sign-in.
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
    # If JWT_SECRET is absent, each process gets an unpredictable development-only
    # key. Sessions intentionally stop working after a restart rather than using a
    # checked-in or deterministic fallback.
    jwt_secret: SecretStr = Field(default_factory=lambda: SecretStr(secrets.token_urlsafe(48)))
    session_ttl_seconds: int = 60 * 60 * 24 * 14

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

    @property
    def openrouter_ready(self) -> bool:
        return bool(
            self.openrouter_api_key.get_secret_value()
            and self.openrouter_base_url.strip()
            and self.openrouter_model.strip()
        )

    @property
    def nvidia_ready(self) -> bool:
        return bool(
            self.nvidia_api_key.get_secret_value()
            and self.nvidia_base_url.strip()
            and self.nvidia_model.strip()
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()