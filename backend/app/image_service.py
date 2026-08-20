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
# fal returns a link rather than bytes, so the host it may be fetched from is
# pinned here. Without this the provider could point us at anything.
_ALLOWED_IMAGE_CDN = ("fal.media", "fal.ai", "together.ai", "togethercomputer.com")

# Latched when Hugging Face answers 401/402/403 for a model. Its "free" image
# tier is a small credit balance, not an allowance that resets per request, so
# once it is spent every model answers 402 -- and without this every single
# illustration would pay two dead round trips before reaching a provider that
# works. A restart clears it, which is also when a topped-up token is noticed.
_hf_paywalled = set()

# Appended to every brief. The prompt writer is already told not to ask for
# text, but diffusion models add lettering unprompted, and FLUX renders it as
# plausible-looking nonsense -- "next" comes back as "nest", "riest", "nesd".
# Garbled pseudo-words make a diagram look broken and undermine the notes it is
# supposed to support, so shapes and colour carry the meaning instead.
_NO_TEXT_SUFFIX = (
    " Purely visual: no text, no letters, no words, no numbers, no captions, "
    "no labels, no watermark. Shape, arrangement and colour carry the meaning."
)
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


def _generate_via_together(brief: str, settings: Settings) -> Tuple[bytes, str, str, str, str]:
    """FLUX.1-schnell on Together AI.

    Tried before Hugging Face because its free endpoint is rate-limited rather
    than credit-limited: the HF token stops working entirely once its small
    balance is spent, and answers 402 for every model after that.
    """
    key = settings.together_api_key.get_secret_value().strip()
    model = settings.together_image_model.strip()
    if not key or not model:
        raise ValueError("Together AI is not configured.")

    with httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0)) as client:
        response = client.post(
            settings.together_base_url.rstrip("/") + "/images/generations",
            headers={"Authorization": "Bearer {}".format(key), "Content-Type": "application/json"},
            json={
                "model": model,
                "prompt": brief + _NO_TEXT_SUFFIX,
                "width": 1024,
                "height": 768,
                # Schnell is distilled for exactly this many; more is wasted.
                "steps": 4,
                "n": 1,
                "response_format": "b64_json",
            },
        )
    response.raise_for_status()

    entry = (response.json().get("data") or [{}])[0]
    if entry.get("b64_json"):
        content = base64.b64decode(entry["b64_json"])
    elif entry.get("url"):
        content = _fetch_generated(entry["url"])
    else:
        raise ValueError("Together AI returned no image data.")
    if len(content) > 8_000_000:
        raise ValueError("The generated image exceeds the 8 MB safety limit.")

    content_type = verify_raster_image(content)
    digest = hashlib.sha256("{}|{}".format(model, brief).encode("utf-8")).hexdigest()[:20]
    return content, content_type, digest, "Together AI", model


def _fetch_generated(url: str) -> bytes:
    """Download an image the provider returned a link to, from a pinned host."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not any(
        host == domain or host.endswith("." + domain) for domain in _ALLOWED_IMAGE_CDN
    ):
        raise ValueError("The image provider returned a link outside the allowed hosts.")
    with httpx.Client(timeout=httpx.Timeout(90.0, connect=15.0)) as client:
        response = client.get(url, headers={"Accept": "image/jpeg,image/png,image/webp"})
    response.raise_for_status()
    return response.content


def _hf_headers(token: str) -> dict:
    return {"Authorization": "Bearer {}".format(token), "Content-Type": "application/json"}


def _generate_flux_dev(brief: str, settings: Settings, token: str) -> Tuple[bytes, str, str, str, str]:
    """FLUX.1-dev on its provider's own route, at full step count.

    Worth the extra couple of seconds: schnell is distilled to one-to-four steps
    and loses fine detail doing it, which is exactly what shows up as smeared
    labels and mangled arrows in a diagram.
    """
    if "dev" in _hf_paywalled:
        raise ValueError("FLUX.1-dev needs provider credit on this token.")

    provider = re.sub(r"[^a-z0-9-]", "", settings.hf_image_provider.lower()) or "fal-ai"
    path = settings.hf_image_path.strip("/") or "fal-ai/flux/dev"
    steps = max(1, min(50, int(settings.hf_image_steps or 28)))

    with httpx.Client(timeout=httpx.Timeout(180.0, connect=15.0)) as client:
        response = client.post(
            "{}/{}/{}".format(_HF_ROUTER, provider, path),
            headers=_hf_headers(token),
            json={"prompt": brief + _NO_TEXT_SUFFIX, "num_inference_steps": steps},
        )
    if response.status_code in (401, 402, 403):
        # Out of credit, or not entitled. Either way it will not start working
        # mid-process, so stop asking and let the next provider carry it.
        _hf_paywalled.add("dev")
        raise ValueError("FLUX.1-dev is not available on this token ({}).".format(response.status_code))
    response.raise_for_status()
    body = response.json()

    # The provider screens its own output; a flagged image is not shown.
    if any(body.get("has_nsfw_concepts") or []):
        raise ValueError("The image provider flagged the generated image.")

    images = body.get("images") or []
    if not images or not images[0].get("url"):
        raise ValueError("The image provider returned no image.")
    content = _fetch_generated(images[0]["url"])
    if len(content) > 8_000_000:
        raise ValueError("The generated image exceeds the 8 MB safety limit.")

    content_type = verify_raster_image(content)
    model = settings.hf_image_model.strip() or "black-forest-labs/FLUX.1-dev"
    digest = hashlib.sha256("{}\n{}\n{}".format(model, steps, brief).encode("utf-8")).hexdigest()[:20]
    return content, content_type, digest, "Hugging Face ({})".format(provider), model


def _generate_flux_schnell(brief: str, settings: Settings, token: str) -> Tuple[bytes, str, str, str, str]:
    """Schnell through the OpenAI-style route, which returns the bytes inline."""
    if "schnell" in _hf_paywalled:
        raise ValueError("FLUX.1-schnell needs provider credit on this token.")

    provider = re.sub(r"[^a-z0-9-]", "", settings.hf_fallback_provider.lower()) or "nscale"
    model = settings.hf_fallback_model.strip() or "black-forest-labs/FLUX.1-schnell"

    with httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0)) as client:
        response = client.post(
            "{}/{}/v1/images/generations".format(_HF_ROUTER, provider),
            headers=_hf_headers(token),
            json={"model": model, "prompt": brief + _NO_TEXT_SUFFIX, "response_format": "b64_json"},
        )
    if response.status_code in (401, 402, 403):
        _hf_paywalled.add("schnell")
        raise ValueError("FLUX.1-schnell is not available on this token ({}).".format(response.status_code))
    response.raise_for_status()

    encoded = ((response.json().get("data") or [{}])[0]).get("b64_json")
    if not encoded:
        raise ValueError("The image provider returned no image data.")
    content = base64.b64decode(encoded)
    if len(content) > 8_000_000:
        raise ValueError("The generated image exceeds the 8 MB safety limit.")

    content_type = verify_raster_image(content)
    digest = hashlib.sha256("{}\n{}".format(model, brief).encode("utf-8")).hexdigest()[:20]
    return content, content_type, digest, "Hugging Face ({})".format(provider), model


def generate_image(prompt: str, settings: Settings) -> Tuple[bytes, str, str, str, str]:
    """Returns the image plus the provider and model that really made it.

    Reported rather than assumed: the label was hard-coded to Pollinations at
    the call sites, so a FLUX image would still have been filed under the
    wrong generator.
    """
    brief = sanitize_visual_brief(prompt)
    if settings.together_api_key.get_secret_value().strip():
        try:
            return _generate_via_together(brief, settings)
        except Exception as exc:
            logger.warning("Together AI image generation failed: %s", str(exc)[:200])

    token = settings.hf_api_token.get_secret_value().strip()
    if token:
        # Quality first, then speed, then Pollinations. Each step down is a real
        # drop in output, so none of them is skipped for being slower -- but an
        # optional study aid is never worth failing the whole request over.
        for attempt in (_generate_flux_dev, _generate_flux_schnell):
            try:
                return attempt(brief, settings, token)
            except Exception as exc:
                logger.warning("%s failed: %s", attempt.__name__, str(exc)[:200])

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
    return response.content, content_type, digest, "Pollinations.ai", model
