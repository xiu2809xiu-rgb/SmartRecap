from __future__ import annotations

import base64
import contextvars
import hashlib
import hmac
import json
import secrets
import time
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, Iterable, Optional

from fastapi import HTTPException, Request
from fastapi.routing import APIRoute
from starlette.concurrency import run_in_threadpool

from .config import Settings
from .google_auth import verify_google_id_token
from .repository import DurableRepository

_current_user: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar("current_user", default=None)
_service: Optional["AuthService"] = None
_hydrators: list[Callable[[str], Awaitable[None]]] = []


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    if not value or any(ch not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for ch in value):
        raise ValueError("invalid base64url")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def public_user(user: Dict[str, Any]) -> Dict[str, Any]:
    return {key: deepcopy(user.get(key)) for key in ("id", "email", "name", "picture", "guest", "createdAt")}


def _password_hash(password: str, salt: Optional[bytes] = None) -> Dict[str, Any]:
    if not isinstance(password, str) or len(password) < 8 or len(password) > 256:
        raise HTTPException(status_code=422, detail="Password must be between 8 and 256 characters.")
    salt = salt or secrets.token_bytes(16)
    rounds = 310_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return {"algorithm": "pbkdf2-sha256", "rounds": rounds, "salt": _b64encode(salt), "hash": _b64encode(digest)}


def _password_matches(password: str, record: Dict[str, Any]) -> bool:
    try:
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), _b64decode(str(record["salt"])), int(record["rounds"])
        )
        return hmac.compare_digest(candidate, _b64decode(str(record["hash"])))
    except (KeyError, TypeError, ValueError):
        return False


class AuthService:
    def __init__(self, settings: Settings, repository: DurableRepository) -> None:
        self.settings = settings
        self.repository = repository
        self.secret = settings.jwt_secret.get_secret_value().encode("utf-8")
        self.ttl = max(300, int(settings.session_ttl_seconds))
        self._users: Dict[str, Dict[str, Any]] = {}
        self._email_index: Dict[str, str] = {}
        self._google_index: Dict[str, str] = {}

    def issue(self, user_id: str) -> str:
        now = int(time.time())
        header = _b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64encode(json.dumps({"sub": user_id, "iat": now, "exp": now + self.ttl}, separators=(",", ":")).encode())
        signature = _b64encode(hmac.new(self.secret, f"{header}.{payload}".encode("ascii"), hashlib.sha256).digest())
        return f"{header}.{payload}.{signature}"

    def verify(self, token: str) -> Dict[str, Any]:
        try:
            parts = token.split(".")
            if len(parts) != 3:
                raise ValueError("parts")
            header_raw, payload_raw, signature_raw = parts
            header = json.loads(_b64decode(header_raw))
            payload = json.loads(_b64decode(payload_raw))
            expected = hmac.new(self.secret, f"{header_raw}.{payload_raw}".encode("ascii"), hashlib.sha256).digest()
            if header != {"alg": "HS256", "typ": "JWT"} or not hmac.compare_digest(expected, _b64decode(signature_raw)):
                raise ValueError("signature")
            now = int(time.time())
            if not isinstance(payload.get("sub"), str) or not payload["sub"] or int(payload.get("exp", 0)) <= now:
                raise ValueError("expired")
            if int(payload.get("iat", now + 1)) > now + 60:
                raise ValueError("future")
        except (ValueError, TypeError, KeyError, json.JSONDecodeError, UnicodeDecodeError):
            raise HTTPException(status_code=401, detail="Bearer token is malformed, invalid, or expired.")
        user = self.get_user(payload["sub"])
        if not user:
            raise HTTPException(status_code=401, detail="Bearer session no longer identifies an account.")
        return user

    def get_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        if not user_id:
            return None
        if user_id in self._users:
            return deepcopy(self._users[user_id])
        value = self.repository.get(user_id, "account", user_id) if self.repository.ready else None
        if isinstance(value, dict):
            self._users[user_id] = value
            return deepcopy(value)
        return None

    def known_accounts(self) -> list[Dict[str, Any]]:
        return [deepcopy(user) for user in self._users.values() if not user.get("guest")]

    def _save(self, user: Dict[str, Any]) -> None:
        user_id = str(user["id"])
        self._users[user_id] = deepcopy(user)
        self.repository.save(user_id, "account", user_id, user)
        if not user.get("guest"):
            profile = {key: user.get(key) for key in ("id", "name", "picture", "createdAt")}
            self.repository.save_public("profile", user_id, profile)

    def _index_get(self, kind: str, key: str, cache: Dict[str, str]) -> Optional[str]:
        if key in cache:
            return cache[key]
        value = self.repository.get_public(kind, key)
        if isinstance(value, dict) and isinstance(value.get("userId"), str):
            cache[key] = value["userId"]
            return value["userId"]
        return None

    def _index_save(self, kind: str, key: str, user_id: str, cache: Dict[str, str]) -> None:
        cache[key] = user_id
        self.repository.save_public(kind, key, {"userId": user_id})

    def guest(self) -> Dict[str, Any]:
        user = {"id": "usr_" + secrets.token_urlsafe(16), "email": None, "name": "Guest", "picture": None,
                "guest": True, "createdAt": _now(), "auth": {"kind": "guest"}}
        self._save(user)
        return self.session(user)

    def signup(self, email: Any, password: Any, name: Any, guest: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        normalized = str(email or "").strip().casefold()
        if "@" not in normalized or len(normalized) > 254:
            raise HTTPException(status_code=422, detail="A valid email address is required.")
        if self._index_get("account_email", normalized, self._email_index):
            raise HTTPException(status_code=409, detail="An account already exists for that email address.")
        user_id = str(guest["id"]) if guest and guest.get("guest") else "usr_" + secrets.token_urlsafe(16)
        created = str(guest.get("createdAt")) if guest else _now()
        user = {"id": user_id, "email": normalized, "name": str(name or normalized.split("@")[0]).strip()[:100],
                "picture": None, "guest": False, "createdAt": created, "auth": {"kind": "password", **_password_hash(str(password or ""))}}
        self._save(user)
        self._index_save("account_email", normalized, user_id, self._email_index)
        return self.session(user)

    def login(self, email: Any, password: Any) -> Dict[str, Any]:
        normalized = str(email or "").strip().casefold()
        user_id = self._index_get("account_email", normalized, self._email_index)
        user = self.get_user(user_id or "")
        if not user or not _password_matches(str(password or ""), user.get("auth") or {}):
            raise HTTPException(status_code=401, detail="Email or password is incorrect.")
        return self.session(user)

    def google(self, profile: Dict[str, Any], guest: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        sub = str(profile.get("sub") or "")
        if not sub:
            raise HTTPException(status_code=401, detail="Google did not provide a stable account identifier.")
        # An established Google account always wins. In particular, signing in
        # while holding an unrelated guest session must never silently combine
        # two owner partitions; the guest library remains under its guest id.
        indexed_id = self._index_get("account_google", sub, self._google_index)
        if indexed_id:
            established = self.get_user(indexed_id)
            if established:
                established.update(
                    email=profile["email"], name=profile["name"],
                    picture=profile.get("picture"), guest=False,
                )
                self._save(established)
                return self.session(established)

        # For a new Google account, promote the current guest in place. Keeping
        # its id preserves every owner-scoped material, quiz and attempt without
        # copying or exposing another partition.
        derived_id = "usr_g_" + hashlib.sha256(sub.encode("utf-8")).hexdigest()[:32]
        derived_user = self.get_user(derived_id)
        if derived_user:
            user_id = derived_id
            user = derived_user
        elif guest and guest.get("guest"):
            user_id = str(guest["id"])
            user = deepcopy(guest)
        else:
            user_id = derived_id
            user = None
        if not user:
            user = {"id": user_id, "email": profile["email"], "name": profile["name"], "picture": profile.get("picture"),
                    "guest": False, "createdAt": _now(), "auth": {"kind": "google", "sub": sub}}
        else:
            user.update(email=profile["email"], name=profile["name"], picture=profile.get("picture"), guest=False,
                        auth={"kind": "google", "sub": sub})
        self._save(user)
        self._index_save("account_google", sub, user_id, self._google_index)
        return self.session(user)

    def session(self, user: Dict[str, Any]) -> Dict[str, Any]:
        return {"token": self.issue(str(user["id"])), "user": public_user(user)}


def configure_auth(settings: Settings, repository: DurableRepository) -> AuthService:
    global _service
    if _service is None or _service.settings is not settings:
        _service = AuthService(settings, repository)
    return _service


def auth_service() -> AuthService:
    if _service is None:
        raise RuntimeError("Authentication has not been configured.")
    return _service


def bearer_token(request: Request) -> Optional[str]:
    value = request.headers.get("authorization", "")
    if not value:
        return None
    scheme, _, token = value.partition(" ")
    if scheme.casefold() != "bearer" or not token or " " in token:
        raise HTTPException(status_code=401, detail="A valid Bearer token is required.")
    return token


def optional_user(request: Request) -> Optional[Dict[str, Any]]:
    token = bearer_token(request)
    return auth_service().verify(token) if token else None


def require_user(request: Request) -> Dict[str, Any]:
    user = optional_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="A Bearer session is required.")
    return user


def current_user() -> Dict[str, Any]:
    user = _current_user.get()
    if not user:
        raise HTTPException(status_code=401, detail="A Bearer session is required.")
    return user


def current_owner_id() -> str:
    return str(current_user()["id"])


def register_owner_hydrator(callback: Callable[[str], Awaitable[None]]) -> None:
    if callback not in _hydrators:
        _hydrators.append(callback)


_PUBLIC_ROUTES = {
    ("GET", "/api/health"),
    ("POST", "/api/auth/guest"), ("POST", "/api/auth/signup"), ("POST", "/api/auth/login"),
    ("POST", "/api/auth/google"), ("GET", "/api/auth/face/status"),
    ("GET", "/api/forum/posts"), ("GET", "/api/practice/help-available"),
    ("GET", "/api/lobbies"),
}


def _is_public_route(method: str, path: str) -> bool:
    if (method, path) in _PUBLIC_ROUTES:
        return True
    if method == "GET" and (path.startswith("/api/shared/") or path.startswith("/api/lobbies/")):
        return True
    if method == "POST" and path.startswith("/api/lobbies/"):
        return path.endswith(("/join", "/ready", "/start", "/answer", "/score"))
    return False


class AuthenticatedRoute(APIRoute):
    """Authenticate private API routes and bind identity to task-local state."""

    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request):
            path = request.url.path
            is_public = _is_public_route(request.method, path)
            user = optional_user(request) if is_public else require_user(request)
            marker = _current_user.set(user)
            try:
                if user:
                    for hydrate in tuple(_hydrators):
                        await hydrate(str(user["id"]))
                return await original(request)
            finally:
                _current_user.reset(marker)

        return handler


class OwnerMap(dict):
    """A mapping facade whose contents are isolated by authenticated owner."""

    def __init__(self) -> None:
        super().__init__()
        self._owners: Dict[str, Dict[str, Any]] = {}

    def _data(self) -> Dict[str, Any]:
        return self._owners.setdefault(current_owner_id(), {})

    def __getitem__(self, key): return self._data()[key]
    def __setitem__(self, key, value): self._data()[key] = value
    def __delitem__(self, key): del self._data()[key]
    def __iter__(self): return iter(self._data())
    def __len__(self): return len(self._data())
    def get(self, key, default=None): return self._data().get(key, default)
    def pop(self, key, default=None): return self._data().pop(key, default)
    def values(self): return self._data().values()
    def items(self): return self._data().items()
    def keys(self): return self._data().keys()
    def __contains__(self, key): return key in self._data()
    def clear(self): self._data().clear()
    def owner_data(self, owner_id: str) -> Dict[str, Any]: return self._owners.setdefault(owner_id, {})


class OwnerList:
    def __init__(self) -> None:
        self._owners: Dict[str, list[Any]] = {}

    def _data(self) -> list[Any]:
        return self._owners.setdefault(current_owner_id(), [])

    def __iter__(self): return iter(self._data())
    def __len__(self): return len(self._data())
    def __getitem__(self, key): return self._data()[key]
    def __setitem__(self, key, value): self._data()[key] = value
    def insert(self, index: int, value: Any): self._data().insert(index, value)
    def append(self, value: Any): self._data().append(value)
    def sort(self, *args, **kwargs): self._data().sort(*args, **kwargs)
    def owner_data(self, owner_id: str) -> list[Any]: return self._owners.setdefault(owner_id, [])


class OwnerSet:
    """A set facade isolated by authenticated owner."""

    def __init__(self) -> None:
        self._owners: Dict[str, set[Any]] = {}

    def _data(self) -> set[Any]:
        return self._owners.setdefault(current_owner_id(), set())

    def __contains__(self, value: Any) -> bool: return value in self._data()
    def add(self, value: Any) -> None: self._data().add(value)
    def discard(self, value: Any) -> None: self._data().discard(value)
    def owner_data(self, owner_id: str) -> set[Any]: return self._owners.setdefault(owner_id, set())
