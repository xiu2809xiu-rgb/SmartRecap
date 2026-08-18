import hashlib
import re
from io import BytesIO
from typing import Tuple
from urllib.parse import quote, urlparse

import httpx
from PIL import Image, UnidentifiedImageError

from .config import Settings

_ALLOWED_HOSTS = {"gen.pollinations.ai", "image.pollinations.ai"}
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


def generate_image(prompt: str, settings: Settings) -> Tuple[bytes, str, str]:
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
