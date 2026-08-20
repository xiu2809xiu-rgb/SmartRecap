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
    # Tried in order after the model above. These are free tiers, so the failure
    # to design around is a 429, not an outage: the first live attempt at
    # narration died on "temporarily rate-limited upstream" while a perfectly
    # good model sat configured beside it. Comma separated so it is tunable
    # from the environment without a code change.
    openrouter_code_fallbacks: str = "google/gemma-4-31b-it:free,z-ai/glm-5.2:free"
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
    # Hugging Face is the preferred image generator when a token is present:
    # FLUX.1-schnell produces markedly better diagrams than the Pollinations
    # default, and Pollinations stays as the no-token fallback.
    #
    # The provider is part of the route, not a detail. hf-inference no longer
    # serves FLUX at all -- it answers 410 "deprecated" -- while nscale, fal-ai
    # and wavespeed serve it fine. nscale is used because it returns the image
    # bytes as base64 in one response, where fal-ai returns a URL that would
    # need a second fetch to a host we would then have to allowlist.
    # Together AI first when configured. Its schnell endpoint has a genuinely
    # free tier rather than a credit balance that runs out, which is what the
    # Hugging Face token does after a few dozen images.
    together_api_key: SecretStr = SecretStr("")
    together_base_url: str = "https://api.together.xyz/v1"
    together_image_model: str = "black-forest-labs/FLUX.1-schnell-Free"
    hf_api_token: SecretStr = SecretStr("")
    # Preferred: FLUX.1-dev on fal-ai, at 28 steps. Schnell is distilled down to
    # one-to-four steps for speed and drops fine detail to get there, which is
    # what makes its diagrams look smeared. Dev costs a couple of seconds more
    # and comes back sharp.
    #
    # This one uses the provider's own route because the OpenAI-style
    # /v1/images/generations path answers "Model not supported by provider" for
    # dev on every provider that serves it.
    hf_image_provider: str = "fal-ai"
    hf_image_path: str = "fal-ai/flux/dev"
    hf_image_model: str = "black-forest-labs/FLUX.1-dev"
    hf_image_steps: int = 28
    # Fallback: schnell on nscale, which answers the OpenAI-style route and
    # returns the bytes inline. Faster, lower quality, no second fetch.
    hf_fallback_provider: str = "nscale"
    hf_fallback_model: str = "black-forest-labs/FLUX.1-schnell"
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