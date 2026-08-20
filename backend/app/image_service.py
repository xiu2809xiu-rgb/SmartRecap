import base64
import hashlib
import logging
import re
from io import BytesIO
from typing import Tuple
from urllib.parse import quote, urlparse

import httpx
from PIL import Image, UnidentifiedImageError

from .config import Settings

logger = logging.getLogger("smartrecap.images")

_ALLOWED_HOSTS = {"gen.pollinations.ai", "image.pollinations.ai"}
_HF_ROUTER = "https://router.huggingface.co"
_FORMAT_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}


def sanitize_visual_brief(value: str) -> str:
    text = re.sub(r"https?://\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "", value)
    text = re.sub(r"(?i)\b(?:ignore previous|system prompt|api key|password|secret|token)\b", "", text)
    return re.sub(r"\s+", " ", text).strip()[:900]


def verify_raster_image(content: bytes) -> str:
    """Validate provider bytes and return a canonical raster content type."""
    if not content:
        raise ValueError("The image provider returned an empty response.")
    try:
        with Image.open(BytesIO(content)) as image:
            content_type = _FORMAT_TYPES.get(str(image.format or "").upper())
            if not content_type:
                raise ValueError("The image provider returned an unsupported image format.")
            if image.width * image.height > 20_000_000:
                raise ValueError("The generated image dimensions exceed the safety limit.")
            image.verify()
            return content_type
    except (UnidentifiedImageError, OSError, SyntaxError) as exc:
        raise ValueError("The image provider returned invalid raster data.") from exc


def _generate_via_huggingface(brief: str, settings: Settings) -> Tuple[bytes, str, str]:
    """FLUX.1-schnell through the Hugging Face router.

    Preferred over Pollinations when a token is configured: the diagrams come
    back sharper and follow the brief far more closely, which matters when the
    image is meant to explain a data structure rather than decorate a page.

    The provider is named explicitly. `hf-inference` no longer serves FLUX --
    it answers 410 "deprecated and no longer supported" -- so routing through
    the default would silently lose the feature.
    """
    token = settings.hf_api_token.get_secret_value().strip()
    if not token:
        raise ValueError("No Hugging Face token is configured.")

    provider = re.sub(r"[^a-z0-9-]", "", settings.hf_image_provider.lower()) or "nscale"
    model = settings.hf_image_model.strip() or "black-forest-labs/FLUX.1-schnell"
    payload = {
        "model": model,
        "prompt": brief,
        "response_format": "b64_json",
    }
    with httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0)) as client:
        response = client.post(
            "{}/{}/v1/images/generations".format(_HF_ROUTER, provider),
            headers={"Authorization": "Bearer {}".format(token), "Content-Type": "application/json"},
            json=payload,
        )
    response.raise_for_status()

    encoded = ((response.json().get("data") or [{}])[0]).get("b64_json")
    if not encoded:
        raise ValueError("The image provider returned no image data.")
    content = base64.b64decode(encoded)
    if len(content) > 8_000_000:
        raise ValueError("The generated image exceeds the 8 MB safety limit.")

    content_type = verify_raster_image(content)
    digest = hashlib.sha256("{}\n{}".format(model, brief).encode("utf-8")).hexdigest()[:20]
    return content, content_type, digest


def generate_image(prompt: str, settings: Settings) -> Tuple[bytes, str, str]:
    if settings.hf_api_token.get_secret_value().strip():
        try:
            return _generate_via_huggingface(sanitize_visual_brief(prompt), settings)
        except Exception as exc:
            # Fall through to Pollinations rather than losing the illustration:
            # this is an optional aid, and one provider having a bad minute is
            # not a reason to show the student nothing.
            logger.warning("Hugging Face image generation failed: %s", str(exc)[:200])

    base = settings.pollinations_base_url.rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme != "https" or parsed.hostname not in _ALLOWED_HOSTS:
        raise ValueError("Pollinations must use the allowlisted HTTPS host.")
    brief = sanitize_visual_brief(prompt)
    if len(brief) < 12:
        raise ValueError("The visual brief is too short to generate safely.")
    model = re.sub(r"[^A-Za-z0-9._-]", "", settings.pollinations_model) or "zimage"
    url = f"{base}/image/{quote(brief, safe='')}"
    headers = {"Accept": "image/jpeg,image/png,image/webp"}
    api_key = settings.pollinations_api_key.get_secret_value().strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    params = {"model": model, "width": 1280, "height": 720, "safe": "true"}
    timeout = httpx.Timeout(90.0, connect=15.0)
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        response = client.get(url, params=params, headers=headers)
        # The current gen endpoint advertises authentication, while the legacy
        # image endpoint remains a verified no-key compatibility path.
        if response.status_code == 401 and not api_key:
            legacy_url = "https://image.pollinations.ai/prompt/{}".format(quote(brief, safe=""))
            response = client.get(legacy_url, params={**params, "nologo": "true"}, headers=headers)
    response.raise_for_status()
    if len(response.content) > 8_000_000:
        raise ValueError("The generated image exceeds the 8 MB safety limit.")
    content_type = verify_raster_image(response.content)
    digest = hashlib.sha256((model + "\n" + brief).encode("utf-8")).hexdigest()[:20]
    return response.content, content_type, digest
