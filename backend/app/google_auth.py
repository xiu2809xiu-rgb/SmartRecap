"""Verifying a Google ID token.

The browser hands the API a signed JWT and claims it represents a Google
account. That claim is worth nothing until the signature is checked against
Google's own public keys — an unverified ID token is just a base64 string
anyone can write, and accepting one would let a person sign in as any email
address they liked.

Verification is delegated to `google-auth`, Google's own library, rather than
hand-rolled here. It fetches and caches Google's JWKS, checks the RS256
signature, and validates the issuer, audience and expiry. Hand-rolling JWT
verification is how `alg: none` bugs happen; the Node implementation in
`backend/src/lib/googleToken.js` does it by hand only because Node's crypto
makes it dependency-free, and it applies exactly the same rules.

Two checks `google-auth` does not make for us, both of which matter:

  * the email must be present, because accounts are linked by it
  * `email_verified` must not be false, or someone could claim an address they
    do not control
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import HTTPException

from .config import Settings

logger = logging.getLogger("smartrecap.google")

_VALID_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}

# Google's clock and ours will not agree exactly.
_CLOCK_SKEW_SECONDS = 60


def verify_google_id_token(credential: str, settings: Settings) -> Dict[str, Any]:
    """Return the verified claims, or raise HTTPException.

    Never returns unverified data — the caller cannot accidentally use an
    unchecked token because there is no path through this function that
    produces one.
    """
    client_id = (settings.google_client_id or "").strip()
    if not client_id:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured on this deployment.")

    if not isinstance(credential, str) or credential.count(".") != 2:
        raise HTTPException(status_code=401, detail="That Google sign-in was not in a form we could read.")

    try:
        from google.auth.transport import requests as google_requests
        from google.oauth2 import id_token
    except ImportError as exc:  # pragma: no cover - depends on the deployment
        logger.error("google-auth is not installed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="Google sign-in is unavailable on this deployment.",
        ) from exc

    try:
        claims = id_token.verify_oauth2_token(
            credential,
            google_requests.Request(),
            client_id,
            clock_skew_in_seconds=_CLOCK_SKEW_SECONDS,
        )
    except ValueError as exc:
        # Covers a bad signature, the wrong audience, an expired token and a
        # malformed one. The message is deliberately not echoed back to the
        # browser: it can name internal specifics, and a caller who failed
        # verification does not need to know which check caught them.
        logger.warning("Google ID token rejected: %s", exc)
        raise HTTPException(status_code=401, detail="That Google sign-in could not be verified.") from exc
    except Exception as exc:  # network failure reaching Google's certs
        logger.warning("Google ID token verification failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail="Could not reach Google to verify your sign-in. Try again in a moment.",
        ) from exc

    if claims.get("iss") not in _VALID_ISSUERS:
        raise HTTPException(status_code=401, detail="That token was not issued by Google.")

    email = claims.get("email")
    if not email:
        raise HTTPException(status_code=401, detail="Google did not share an email address.")
    if claims.get("email_verified") is False:
        raise HTTPException(status_code=401, detail="That Google account has an unverified email address.")

    email = str(email).lower()
    return {
        "sub": str(claims.get("sub", "")),
        "email": email,
        "name": claims.get("name") or email.split("@")[0],
        "picture": claims.get("picture"),
    }
