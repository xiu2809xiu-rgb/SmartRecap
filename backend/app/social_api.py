from __future__ import annotations

import asyncio
import hashlib
import hmac
import secrets
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.concurrency import run_in_threadpool

from .auth import AuthenticatedRoute, auth_service, current_owner_id, current_user
from .config import Settings
from .repository import DurableRepository
from .storage import ObjectStorage


FRIEND_KIND = "social_friend"
REQUEST_KIND = "social_friend_request"
CONVERSATION_KIND = "social_conversation"
MESSAGE_KIND = "social_conversation_message"
PLAN_KIND = "social_plan_item"
INVITE_KIND = "social_conversation_invite"
INVITE_INDEX_KIND = "social_conversation_invite_index"
STUDY_SESSION_KIND = "social_study_session"
INVITE_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60
INVITE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60
_INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def _utcnow() -> datetime:
    """Single clock seam so timer and expiry behavior can be tested deterministically."""
    return datetime.now(timezone.utc)


def _now() -> str:
    return _utcnow().isoformat()


def _parse_time(value: Any) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        raise HTTPException(status_code=500, detail="Stored social timestamp is invalid.")


def _invite_index_key(kind: str, value: str) -> str:
    normalized = value.upper() if kind == "code" else value
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return f"{kind}:{digest}"


def _id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(12)}"


class FriendRequestCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    user_id: str = Field(min_length=1, max_length=128, alias="userId")


class ConversationCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    kind: Literal["direct", "group"]
    member_ids: List[str] = Field(default_factory=list, max_length=49, alias="memberIds")
    name: Optional[str] = Field(default=None, max_length=100)


class MessageCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    text: str = Field(min_length=1, max_length=4000)


class PlanSession(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=200)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    start_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$", alias="startTime")
    duration_minutes: int = Field(ge=5, le=1440, alias="durationMinutes")
    assignee_id: Optional[str] = Field(default=None, max_length=128, alias="assigneeId")
    completed: bool = False

    @field_validator("date")
    @classmethod
    def valid_date(cls, value: str) -> str:
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError("date must be a real calendar date") from exc
        return value


class CollaborativePlan(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=200)
    sessions: List[PlanSession] = Field(default_factory=list, max_length=200)
    expected_revision: Optional[int] = Field(default=None, ge=0, alias="expectedRevision")


class InviteCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    expires_in_seconds: int = Field(
        default=INVITE_DEFAULT_TTL_SECONDS,
        ge=300,
        le=INVITE_MAX_TTL_SECONDS,
        alias="expiresInSeconds",
    )
    max_uses: int = Field(default=1, ge=1, le=100, alias="maxUses")


class InviteReference(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    invite: str = Field(min_length=4, max_length=512)


class StudySessionStart(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    title: Optional[str] = Field(default=None, max_length=200)


def build_social_router(settings: Settings) -> APIRouter:
    """Build authenticated, owner-partitioned social APIs."""
    router = APIRouter(prefix="/api", route_class=AuthenticatedRoute)
    repository = DurableRepository(settings, ObjectStorage(settings))
    cache: Dict[str, Dict[str, Dict[str, Dict[str, Any]]]] = {}
    loaded: set[tuple[str, str]] = set()
    profiles: Dict[str, Dict[str, Any]] = {}
    email_index: Dict[str, str] = {}
    lock = asyncio.Lock()

    def actor() -> Dict[str, Any]:
        user = current_user()
        if user.get("guest"):
            raise HTTPException(status_code=403, detail="Social features require a non-guest account.")
        user_id = current_owner_id()
        profile = {key: deepcopy(user.get(key)) for key in ("id", "email", "name", "picture", "createdAt")}
        profiles[user_id] = profile
        if user.get("email"):
            email_index[str(user["email"]).strip().casefold()] = user_id
        return user


    def owner_bucket(owner_id: str, kind: str) -> Dict[str, Dict[str, Any]]:
        return cache.setdefault(owner_id, {}).setdefault(kind, {})

    async def load(owner_id: str, kind: str) -> List[Dict[str, Any]]:
        bucket = owner_bucket(owner_id, kind)
        key = (owner_id, kind)
        if key not in loaded:
            if repository.ready:
                rows = await run_in_threadpool(repository.load_kind, owner_id, kind)
                for row in rows:
                    if isinstance(row.get("value"), dict):
                        bucket[str(row["id"])] = deepcopy(row["value"])
            loaded.add(key)
        return [deepcopy(value) for value in bucket.values()]

    async def get(owner_id: str, kind: str, record_id: str) -> Optional[Dict[str, Any]]:
        bucket = owner_bucket(owner_id, kind)
        if record_id in bucket:
            return deepcopy(bucket[record_id])
        if (owner_id, kind) in loaded or not repository.ready:
            return None
        value = await run_in_threadpool(repository.get, owner_id, kind, record_id)
        if isinstance(value, dict):
            bucket[record_id] = deepcopy(value)
            return deepcopy(value)
        return None

    async def save(owner_id: str, kind: str, record_id: str, value: Dict[str, Any]) -> Dict[str, Any]:
        copy = deepcopy(value)
        copy.setdefault("ownerId", owner_id)
        copy["partitionOwnerId"] = owner_id
        owner_bucket(owner_id, kind)[record_id] = copy
        if repository.ready:
            await run_in_threadpool(repository.save, owner_id, kind, record_id, copy)
        return deepcopy(copy)

    async def remove(owner_id: str, kind: str, record_id: str) -> None:
        owner_bucket(owner_id, kind).pop(record_id, None)
        if repository.ready:
            await run_in_threadpool(repository.delete, owner_id, kind, record_id)

    async def save_for_members(kind: str, record_id: str, value: Dict[str, Any], members: List[str]) -> None:
        for member_id in members:
            await save(member_id, kind, record_id, value)

    async def account(user_id: str) -> Optional[Dict[str, Any]]:
        if user_id in profiles:
            return deepcopy(profiles[user_id])
        if repository.ready:
            value = await run_in_threadpool(repository.get, user_id, "account", user_id)
        else:
            value = auth_service().get_user(user_id)
        if not isinstance(value, dict) or value.get("guest"):
            return None
        profile = {key: deepcopy(value.get(key)) for key in ("id", "email", "name", "picture", "createdAt")}
        profiles[user_id] = profile
        if value.get("email"):
            email_index[str(value["email"]).strip().casefold()] = user_id
        return deepcopy(profile)

    async def public_profile(user_id: str) -> Optional[Dict[str, Any]]:
        found = await account(user_id)
        if found:
            return found
        if not repository.ready:
            return None
        value = await run_in_threadpool(repository.get_public, "profile", user_id)
        if not isinstance(value, dict):
            return None
        profile = {key: deepcopy(value.get(key)) for key in ("id", "name", "picture", "createdAt")}
        profiles[user_id] = profile
        return profile

    async def require_account(user_id: str) -> Dict[str, Any]:
        found = await account(user_id)
        if not found:
            raise HTTPException(status_code=404, detail="That non-guest account does not exist.")
        return found

    async def require_conversation(conversation_id: str) -> Dict[str, Any]:
        owner_id = current_owner_id()
        conversation = await get(owner_id, CONVERSATION_KIND, conversation_id)
        if not conversation or owner_id not in conversation.get("memberIds", []):
            raise HTTPException(status_code=404, detail="Conversation not found.")
        return conversation

    async def conversation_view(conversation: Dict[str, Any]) -> Dict[str, Any]:
        value = deepcopy(conversation)
        value.pop("partitionOwnerId", None)
        value["members"] = [profile for profile in [await public_profile(item) for item in value["memberIds"]] if profile]
        return value

    invite_indexes: Dict[str, Dict[str, str]] = {}

    async def save_invite_index(lookup_kind: str, value: str, invite: Dict[str, Any]) -> None:
        key = _invite_index_key(lookup_kind, value)
        index = {
            "lookupKind": lookup_kind,
            "inviteId": str(invite["id"]),
            "ownerId": str(invite["ownerId"]),
        }
        invite_indexes[key] = index
        if repository.ready:
            await run_in_threadpool(repository.save_public, INVITE_INDEX_KIND, key, index)

    async def find_invite(reference: str) -> tuple[Dict[str, Any], Dict[str, Any]]:
        candidate = reference.strip()
        lookups = (("token", candidate), ("id", candidate), ("code", candidate.upper()))
        for lookup_kind, value in lookups:
            key = _invite_index_key(lookup_kind, value)
            index = invite_indexes.get(key)
            if not index and repository.ready:
                loaded_index = await run_in_threadpool(repository.get_public, INVITE_INDEX_KIND, key)
                if isinstance(loaded_index, dict):
                    index = loaded_index
                    invite_indexes[key] = deepcopy(index)
            if not index:
                continue
            invite = await get(str(index.get("ownerId") or ""), INVITE_KIND, str(index.get("inviteId") or ""))
            if not invite:
                continue
            matches = {
                "token": hmac.compare_digest(hashlib.sha256(candidate.encode("utf-8")).hexdigest(), str(invite.get("tokenHash") or "")),
                "id": hmac.compare_digest(candidate, str(invite.get("id") or "")),
                "code": hmac.compare_digest(candidate.upper(), str(invite.get("code") or "")),
            }
            if matches[lookup_kind]:
                conversation = await get(str(invite.get("ownerId") or ""), CONVERSATION_KIND, str(invite.get("conversationId") or ""))
                if conversation and conversation.get("kind") == "group":
                    return invite, conversation
        raise HTTPException(status_code=404, detail="Conversation invite not found.")

    def ensure_invite_usable(invite: Dict[str, Any], user_id: str) -> None:
        if invite.get("revokedAt"):
            raise HTTPException(status_code=410, detail="That conversation invite was revoked.")
        if _parse_time(invite.get("expiresAt")) <= _utcnow():
            raise HTTPException(status_code=410, detail="That conversation invite expired.")
        redeemed_by = [str(item) for item in invite.get("redeemedBy", [])]
        if user_id not in redeemed_by and int(invite.get("useCount", 0)) >= int(invite.get("maxUses", 1)):
            raise HTTPException(status_code=410, detail="That conversation invite has no redemptions remaining.")

    def invite_view(invite: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": invite["id"],
            "conversationId": invite["conversationId"],
            "code": invite["code"],
            "createdBy": invite["createdBy"],
            "createdAt": invite["createdAt"],
            "expiresAt": invite["expiresAt"],
            "maxUses": invite["maxUses"],
            "useCount": invite.get("useCount", 0),
            "revokedAt": invite.get("revokedAt"),
        }

    def session_elapsed(session: Dict[str, Any], now: Optional[datetime] = None) -> int:
        elapsed = max(0, int(session.get("elapsedSeconds", 0)))
        if session.get("state") == "running":
            resumed = _parse_time(session.get("lastResumedAt"))
            elapsed += max(0, int(((now or _utcnow()) - resumed).total_seconds()))
        return elapsed

    def session_view(session: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        value = deepcopy(session)
        value.pop("partitionOwnerId", None)
        value["elapsedSeconds"] = session_elapsed(session, now)
        return value

    @router.get("/social/users")
    async def search_profiles(q: str = Query(min_length=1, max_length=254)) -> List[Dict[str, Any]]:
        actor()
        needle = q.strip().casefold()
        matches: List[Dict[str, Any]] = []
        if "@" in needle:
            user_id = email_index.get(needle)
            if not user_id and repository.ready:
                index = await run_in_threadpool(repository.get_public, "account_email", needle)
                if isinstance(index, dict):
                    user_id = str(index.get("userId") or "")
            profile = await account(user_id or "") if user_id else None
            if profile:
                matches.append(profile)
        else:
            candidates = list(profiles.values()) + auth_service().known_accounts()
            if repository.ready:
                rows = await run_in_threadpool(repository.load_public_kind, "profile")
                candidates.extend(row["value"] for row in rows if isinstance(row.get("value"), dict))
            seen: set[str] = set()
            for candidate in candidates:
                user_id = str(candidate.get("id") or "")
                name = str(candidate.get("name") or "").strip().casefold()
                if not user_id or user_id in seen or (needle not in name and needle not in user_id.casefold()):
                    continue
                seen.add(user_id)
                profile = await public_profile(user_id)
                if profile:
                    matches.append(profile)
        return sorted(matches, key=lambda item: (str(item.get("name") or "").casefold(), str(item.get("id"))))[:50]

    @router.post("/friends/requests", status_code=201)
    async def create_friend_request(body: FriendRequestCreate) -> Dict[str, Any]:
        user = actor()
        owner_id = current_owner_id()
        target_id = body.user_id
        if target_id == owner_id:
            raise HTTPException(status_code=422, detail="You cannot send a friend request to yourself.")
        await require_account(target_id)
        async with lock:
            if await get(owner_id, FRIEND_KIND, target_id):
                raise HTTPException(status_code=409, detail="That account is already your friend.")
            existing = await load(owner_id, REQUEST_KIND)
            if any(
                request.get("status") == "pending" and {request.get("requesterId"), request.get("recipientId")} == {owner_id, target_id}
                for request in existing
            ):
                raise HTTPException(status_code=409, detail="A friend request is already pending.")
            timestamp = _now()
            request = {
                "id": _id("frq"), "requesterId": owner_id, "recipientId": target_id,
                "status": "pending", "createdAt": timestamp, "updatedAt": timestamp,
            }
            await save_for_members(REQUEST_KIND, request["id"], request, [owner_id, target_id])
        return await get(owner_id, REQUEST_KIND, request["id"]) or request


    @router.get("/friends/requests")
    async def list_friend_requests() -> Dict[str, List[Dict[str, Any]]]:
        actor()
        owner_id = current_owner_id()
        requests = [item for item in await load(owner_id, REQUEST_KIND) if item.get("status") == "pending"]
        requests.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
        incoming = [item for item in requests if item.get("recipientId") == owner_id]
        outgoing = [item for item in requests if item.get("requesterId") == owner_id]
        for item in incoming:
            item["requester"] = await public_profile(str(item.get("requesterId") or ""))
        for item in outgoing:
            item["recipient"] = await public_profile(str(item.get("recipientId") or ""))
        return {"incoming": incoming, "outgoing": outgoing}

    @router.post("/friends/requests/{request_id}/accept")
    async def accept_friend_request(request_id: str) -> Dict[str, Any]:
        actor()
        owner_id = current_owner_id()
        async with lock:
            request = await get(owner_id, REQUEST_KIND, request_id)
            if not request:
                raise HTTPException(status_code=404, detail="Friend request not found.")
            if request.get("recipientId") != owner_id:
                raise HTTPException(status_code=403, detail="Only the recipient may accept this request.")
            if request.get("status") != "pending":
                raise HTTPException(status_code=409, detail="That friend request is no longer pending.")
            requester_id = str(request.get("requesterId") or "")
            await require_account(requester_id)
            timestamp = _now()
            friendship_id = "friend_" + "_".join(sorted((owner_id, requester_id)))
            friendship = {"id": friendship_id, "userIds": sorted((owner_id, requester_id)), "createdAt": timestamp}
            await save(owner_id, FRIEND_KIND, requester_id, {**friendship, "friendId": requester_id})
            await save(requester_id, FRIEND_KIND, owner_id, {**friendship, "friendId": owner_id})
            await remove(owner_id, REQUEST_KIND, request_id)
            await remove(requester_id, REQUEST_KIND, request_id)
        result = await get(owner_id, FRIEND_KIND, requester_id) or friendship
        result["profile"] = await public_profile(requester_id)
        return result

    @router.delete("/friends/requests/{request_id}", status_code=204)
    async def remove_friend_request(request_id: str) -> None:
        actor()
        owner_id = current_owner_id()
        async with lock:
            request = await get(owner_id, REQUEST_KIND, request_id)
            if not request:
                raise HTTPException(status_code=404, detail="Friend request not found.")
            participants = {str(request.get("requesterId") or ""), str(request.get("recipientId") or "")}
            if owner_id not in participants:
                raise HTTPException(status_code=403, detail="Only request participants may remove it.")
            for participant in participants:
                if participant:
                    await remove(participant, REQUEST_KIND, request_id)


    @router.get("/friends")
    async def list_friends() -> List[Dict[str, Any]]:
        actor()
        friendships = await load(current_owner_id(), FRIEND_KIND)
        friendships.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
        for friendship in friendships:
            friendship["profile"] = await public_profile(str(friendship.get("friendId") or ""))
        return friendships

    @router.delete("/friends/{friend_id}", status_code=204)
    async def remove_friend(friend_id: str) -> None:
        actor()
        owner_id = current_owner_id()
        async with lock:
            friendship = await get(owner_id, FRIEND_KIND, friend_id)
            if not friendship or friend_id not in friendship.get("userIds", []):
                raise HTTPException(status_code=404, detail="Friendship not found.")
            if owner_id not in friendship.get("userIds", []):
                raise HTTPException(status_code=403, detail="Only friends may remove this friendship.")
            await remove(owner_id, FRIEND_KIND, friend_id)
            await remove(friend_id, FRIEND_KIND, owner_id)

    @router.post("/conversations", status_code=201)
    async def create_conversation(body: ConversationCreate) -> Dict[str, Any]:
        actor()
        owner_id = current_owner_id()
        members = list(dict.fromkeys([owner_id, *body.member_ids]))
        if body.kind == "direct" and len(members) != 2:
            raise HTTPException(status_code=422, detail="Direct conversations require exactly two distinct members.")
        if body.kind == "group" and len(members) < 2:
            raise HTTPException(status_code=422, detail="Group conversations require at least two distinct members.")
        if body.kind == "group" and not str(body.name or "").strip():
            raise HTTPException(status_code=422, detail="Group conversations require a name.")
        for member_id in members:
            await require_account(member_id)
            if member_id != owner_id and not await get(owner_id, FRIEND_KIND, member_id):
                raise HTTPException(status_code=403, detail="Only accepted friends can be added to conversations.")
        async with lock:
            if body.kind == "direct":
                for existing in await load(owner_id, CONVERSATION_KIND):
                    if existing.get("kind") == "direct" and set(existing.get("memberIds", [])) == set(members):
                        return await conversation_view(existing)
            timestamp = _now()
            conversation = {
                "id": _id("con"), "kind": body.kind,
                "name": body.name if body.kind == "group" else None,
                "ownerId": owner_id, "adminIds": [owner_id], "memberIds": members,
                "createdBy": owner_id, "createdAt": timestamp, "updatedAt": timestamp,
            }
            await save_for_members(CONVERSATION_KIND, conversation["id"], conversation, members)
        return await conversation_view(await get(owner_id, CONVERSATION_KIND, conversation["id"]) or conversation)


    @router.get("/conversations")
    async def list_conversations() -> List[Dict[str, Any]]:
        actor()
        conversations = await load(current_owner_id(), CONVERSATION_KIND)
        conversations.sort(key=lambda item: str(item.get("updatedAt") or ""), reverse=True)
        return [await conversation_view(item) for item in conversations]

    @router.get("/conversations/{conversation_id}")
    async def get_conversation(conversation_id: str) -> Dict[str, Any]:
        actor()
        return await conversation_view(await require_conversation(conversation_id))

    @router.get("/conversations/{conversation_id}/messages")
    async def list_messages(conversation_id: str) -> List[Dict[str, Any]]:
        actor()
        await require_conversation(conversation_id)
        messages = [
            item for item in await load(current_owner_id(), MESSAGE_KIND)
            if item.get("conversationId") == conversation_id
        ]
        return sorted(messages, key=lambda item: (str(item.get("createdAt") or ""), str(item.get("id") or "")))

    @router.post("/conversations/{conversation_id}/messages", status_code=201)
    async def create_message(conversation_id: str, body: MessageCreate) -> Dict[str, Any]:
        user = actor()
        owner_id = current_owner_id()
        async with lock:
            conversation = await require_conversation(conversation_id)
            timestamp = _now()
            message = {
                "id": _id("msg"), "ownerId": conversation["ownerId"],
                "conversationId": conversation_id, "senderId": owner_id,
                "text": body.text, "createdAt": timestamp,
            }
            await save_for_members(MESSAGE_KIND, message["id"], message, conversation["memberIds"])
            conversation["updatedAt"] = timestamp
            await save_for_members(CONVERSATION_KIND, conversation_id, conversation, conversation["memberIds"])
        return await get(owner_id, MESSAGE_KIND, message["id"]) or message

    @router.post("/conversations/{conversation_id}/invites", status_code=201)
    async def create_conversation_invite(conversation_id: str, body: InviteCreate) -> Dict[str, Any]:
        actor()
        owner_id = current_owner_id()
        async with lock:
            conversation = await require_conversation(conversation_id)
            if conversation.get("kind") != "group":
                raise HTTPException(status_code=422, detail="Invites can only be created for group conversations.")
            if owner_id not in conversation.get("adminIds", []):
                raise HTTPException(status_code=403, detail="Only a group administrator may create invites.")
            token = secrets.token_urlsafe(32)
            code = ""
            for _ in range(10):
                candidate = "".join(secrets.choice(_INVITE_CODE_ALPHABET) for _ in range(8))
                key = _invite_index_key("code", candidate)
                existing = invite_indexes.get(key)
                if not existing and repository.ready:
                    existing = await run_in_threadpool(repository.get_public, INVITE_INDEX_KIND, key)
                if not existing:
                    code = candidate
                    break
            if not code:
                raise HTTPException(status_code=503, detail="Could not allocate a unique invite code.")
            created = _utcnow()
            invite = {
                "id": _id("inv"),
                "ownerId": str(conversation["ownerId"]),
                "conversationId": conversation_id,
                "code": code,
                "tokenHash": hashlib.sha256(token.encode("utf-8")).hexdigest(),
                "createdBy": owner_id,
                "createdAt": created.isoformat(),
                "expiresAt": (created + timedelta(seconds=body.expires_in_seconds)).isoformat(),
                "maxUses": body.max_uses,
                "useCount": 0,
                "redeemedBy": [],
                "revokedAt": None,
            }
            await save(str(conversation["ownerId"]), INVITE_KIND, str(invite["id"]), invite)
            await save_invite_index("token", token, invite)
            await save_invite_index("code", code, invite)
            await save_invite_index("id", str(invite["id"]), invite)
        return {
            **invite_view(invite),
            "token": token,
            "redeemUrl": f"/social/join?invite={token}",
        }

    @router.get("/conversations/{conversation_id}/invites")
    async def list_conversation_invites(conversation_id: str) -> List[Dict[str, Any]]:
        actor()
        owner_id = current_owner_id()
        conversation = await require_conversation(conversation_id)
        if conversation.get("kind") != "group" or owner_id not in conversation.get("adminIds", []):
            raise HTTPException(status_code=403, detail="Only a group administrator may list invites.")
        invites = [
            invite_view(item) for item in await load(str(conversation["ownerId"]), INVITE_KIND)
            if item.get("conversationId") == conversation_id
        ]
        return sorted(invites, key=lambda item: str(item.get("createdAt") or ""), reverse=True)

    @router.delete("/conversations/{conversation_id}/invites/{invite_id}")
    async def revoke_conversation_invite(conversation_id: str, invite_id: str) -> Dict[str, Any]:
        actor()
        owner_id = current_owner_id()
        async with lock:
            conversation = await require_conversation(conversation_id)
            if conversation.get("kind") != "group" or owner_id not in conversation.get("adminIds", []):
                raise HTTPException(status_code=403, detail="Only a group administrator may revoke invites.")
            invite = await get(str(conversation["ownerId"]), INVITE_KIND, invite_id)
            if not invite or invite.get("conversationId") != conversation_id:
                raise HTTPException(status_code=404, detail="Conversation invite not found.")
            if not invite.get("revokedAt"):
                invite["revokedAt"] = _now()
                invite["revokedBy"] = owner_id
                await save(str(conversation["ownerId"]), INVITE_KIND, invite_id, invite)
        return invite_view(invite)

    @router.post("/conversation-invites/resolve")
    async def resolve_conversation_invite(body: InviteReference) -> Dict[str, Any]:
        actor()
        owner_id = current_owner_id()
        invite, conversation = await find_invite(body.invite)
        ensure_invite_usable(invite, owner_id)
        is_member = owner_id in conversation.get("memberIds", [])
        if is_member:
            conversation_result: Dict[str, Any] = await conversation_view(conversation)
        else:
            conversation_result = {
                "id": conversation["id"],
                "kind": conversation["kind"],
                "name": conversation.get("name"),
                "memberCount": len(conversation.get("memberIds", [])),
                "createdAt": conversation.get("createdAt"),
            }
        return {"invite": invite_view(invite), "isMember": is_member, "conversation": conversation_result}

    @router.post("/conversation-invites/redeem")
    async def redeem_conversation_invite(body: InviteReference) -> Dict[str, Any]:
        actor()
        owner_id = current_owner_id()
        async with lock:
            invite, conversation = await find_invite(body.invite)
            ensure_invite_usable(invite, owner_id)
            members = [str(item) for item in conversation.get("memberIds", [])]
            redeemed_by = [str(item) for item in invite.get("redeemedBy", [])]
            if owner_id not in members:
                await require_account(owner_id)
                members.append(owner_id)
                conversation["memberIds"] = members
                conversation["updatedAt"] = _now()
                await save_for_members(CONVERSATION_KIND, str(conversation["id"]), conversation, members)
                for message in await load(str(conversation["ownerId"]), MESSAGE_KIND):
                    if message.get("conversationId") == conversation["id"]:
                        await save(owner_id, MESSAGE_KIND, str(message["id"]), message)
                plan = await get(str(conversation["ownerId"]), PLAN_KIND, str(conversation["id"]))
                if plan:
                    await save(owner_id, PLAN_KIND, str(conversation["id"]), plan)
                if owner_id not in redeemed_by:
                    redeemed_by.append(owner_id)
                    invite["redeemedBy"] = redeemed_by
                    invite["useCount"] = int(invite.get("useCount", 0)) + 1
                    invite["lastRedeemedAt"] = _now()
                    await save(str(conversation["ownerId"]), INVITE_KIND, str(invite["id"]), invite)
        return await conversation_view(conversation)

    @router.get("/conversations/{conversation_id}/plan")
    async def get_plan(conversation_id: str) -> Dict[str, Any]:
        actor()
        conversation = await require_conversation(conversation_id)
        plan = await get(str(conversation["ownerId"]), PLAN_KIND, conversation_id)
        if not plan:
            return {"conversationId": conversation_id, "title": "Study plan", "sessions": [], "revision": 0}
        result = deepcopy(plan)
        result.pop("partitionOwnerId", None)
        result["revision"] = max(0, int(result.get("revision", 0)))
        return result

    @router.put("/conversations/{conversation_id}/plan")
    async def put_plan(conversation_id: str, body: CollaborativePlan) -> Dict[str, Any]:
        actor()
        owner_id = current_owner_id()
        async with lock:
            conversation = await require_conversation(conversation_id)
            current = await get(str(conversation["ownerId"]), PLAN_KIND, conversation_id)
            current_revision = max(0, int((current or {}).get("revision", 0)))
            # One compatibility exception allows legacy clients to initialize an
            # as-yet nonexistent plan. Every subsequent write must send a revision.
            expected_revision = body.expected_revision
            if expected_revision is None:
                if current:
                    raise HTTPException(status_code=422, detail="expectedRevision is required.")
                expected_revision = 0
            if expected_revision != current_revision:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "The collaborative plan changed; reload it before saving.",
                        "currentRevision": current_revision,
                    },
                )
            member_ids = set(conversation["memberIds"])
            session_ids: set[str] = set()
            for session in body.sessions:
                if session.id in session_ids:
                    raise HTTPException(status_code=422, detail="Plan session ids must be unique.")
                session_ids.add(session.id)
                if session.assignee_id and session.assignee_id not in member_ids:
                    raise HTTPException(status_code=422, detail="Every assigneeId must be a conversation member.")
            timestamp = _now()
            plan = {
                "conversationId": conversation_id,
                "ownerId": conversation["ownerId"],
                **body.model_dump(by_alias=True, exclude={"expected_revision"}),
                "revision": current_revision + 1,
                "updatedAt": timestamp,
                "updatedBy": owner_id,
            }
            await save_for_members(PLAN_KIND, conversation_id, plan, conversation["memberIds"])
            conversation["updatedAt"] = timestamp
            await save_for_members(CONVERSATION_KIND, conversation_id, conversation, conversation["memberIds"])
        result = deepcopy(plan)
        result.pop("partitionOwnerId", None)
        return result

    @router.post("/conversations/{conversation_id}/study-sessions/start", status_code=201)
    async def start_study_session(conversation_id: str, body: StudySessionStart) -> Dict[str, Any]:
        actor()
        owner_id = current_owner_id()
        async with lock:
            await require_conversation(conversation_id)
            existing = [
                item for item in await load(owner_id, STUDY_SESSION_KIND)
                if item.get("conversationId") == conversation_id and item.get("state") in {"running", "paused"}
            ]
            if existing:
                raise HTTPException(status_code=409, detail="You already have an active study session in this conversation.")
            timestamp = _now()
            session = {
                "id": _id("ses"),
                "ownerId": owner_id,
                "conversationId": conversation_id,
                "userId": owner_id,
                "title": body.title,
                "state": "running",
                "startedAt": timestamp,
                "lastResumedAt": timestamp,
                "pausedAt": None,
                "stoppedAt": None,
                "elapsedSeconds": 0,
                "createdAt": timestamp,
                "updatedAt": timestamp,
            }
            await save(owner_id, STUDY_SESSION_KIND, str(session["id"]), session)
        return session_view(session)

    @router.get("/conversations/{conversation_id}/study-sessions")
    async def list_study_sessions(conversation_id: str) -> List[Dict[str, Any]]:
        actor()
        owner_id = current_owner_id()
        await require_conversation(conversation_id)
        now = _utcnow()
        sessions = [
            session_view(item, now) for item in await load(owner_id, STUDY_SESSION_KIND)
            if item.get("conversationId") == conversation_id and item.get("userId") == owner_id
        ]
        return sorted(sessions, key=lambda item: str(item.get("startedAt") or ""), reverse=True)

    @router.post("/conversations/{conversation_id}/study-sessions/{session_id}/pause")
    async def pause_study_session(conversation_id: str, session_id: str) -> Dict[str, Any]:
        actor()
        owner_id = current_owner_id()
        async with lock:
            await require_conversation(conversation_id)
            session = await get(owner_id, STUDY_SESSION_KIND, session_id)
            if not session or session.get("conversationId") != conversation_id or session.get("userId") != owner_id:
                raise HTTPException(status_code=404, detail="Study session not found.")
            if session.get("state") != "running":
                raise HTTPException(status_code=409, detail="Only a running study session can be paused.")
            now = _utcnow()
            session["elapsedSeconds"] = session_elapsed(session, now)
            session["state"] = "paused"
            session["pausedAt"] = now.isoformat()
            session["lastResumedAt"] = None
            session["updatedAt"] = now.isoformat()
            await save(owner_id, STUDY_SESSION_KIND, session_id, session)
        return session_view(session)

    @router.post("/conversations/{conversation_id}/study-sessions/{session_id}/resume")
    async def resume_study_session(conversation_id: str, session_id: str) -> Dict[str, Any]:
        actor()
        owner_id = current_owner_id()
        async with lock:
            await require_conversation(conversation_id)
            session = await get(owner_id, STUDY_SESSION_KIND, session_id)
            if not session or session.get("conversationId") != conversation_id or session.get("userId") != owner_id:
                raise HTTPException(status_code=404, detail="Study session not found.")
            if session.get("state") != "paused":
                raise HTTPException(status_code=409, detail="Only a paused study session can be resumed.")
            timestamp = _now()
            session["state"] = "running"
            session["lastResumedAt"] = timestamp
            session["pausedAt"] = None
            session["updatedAt"] = timestamp
            await save(owner_id, STUDY_SESSION_KIND, session_id, session)
        return session_view(session)

    @router.post("/conversations/{conversation_id}/study-sessions/{session_id}/stop")
    async def stop_study_session(conversation_id: str, session_id: str) -> Dict[str, Any]:
        actor()
        owner_id = current_owner_id()
        async with lock:
            await require_conversation(conversation_id)
            session = await get(owner_id, STUDY_SESSION_KIND, session_id)
            if not session or session.get("conversationId") != conversation_id or session.get("userId") != owner_id:
                raise HTTPException(status_code=404, detail="Study session not found.")
            if session.get("state") not in {"running", "paused"}:
                raise HTTPException(status_code=409, detail="Only an active study session can be stopped.")
            now = _utcnow()
            session["elapsedSeconds"] = session_elapsed(session, now)
            session["state"] = "stopped"
            session["lastResumedAt"] = None
            session["stoppedAt"] = now.isoformat()
            session["updatedAt"] = now.isoformat()
            await save(owner_id, STUDY_SESSION_KIND, session_id, session)
        return session_view(session)

    @router.get("/conversations/{conversation_id}/study-sessions/stats")
    async def study_session_stats(conversation_id: str) -> Dict[str, Any]:
        actor()
        owner_id = current_owner_id()
        conversation = await require_conversation(conversation_id)
        now = _utcnow()
        member_totals: Dict[str, int] = {}
        daily_totals: Dict[str, int] = {}
        weekly_totals: Dict[str, int] = {}
        own_total = 0
        for member_id in [str(item) for item in conversation.get("memberIds", [])]:
            total = 0
            for session in await load(member_id, STUDY_SESSION_KIND):
                if session.get("conversationId") != conversation_id or session.get("userId") != member_id:
                    continue
                elapsed = session_elapsed(session, now)
                total += elapsed
                started = _parse_time(session.get("startedAt")).astimezone(timezone.utc)
                day = started.date().isoformat()
                week = (started.date() - timedelta(days=started.weekday())).isoformat()
                daily_totals[day] = daily_totals.get(day, 0) + elapsed
                weekly_totals[week] = weekly_totals.get(week, 0) + elapsed
            member_totals[member_id] = total
            if member_id == owner_id:
                own_total = total
        return {
            "conversationId": conversation_id,
            "asOf": now.isoformat(),
            "ownTotalSeconds": own_total,
            "groupTotalSeconds": sum(member_totals.values()),
            "memberTotals": [
                {"userId": member_id, "totalSeconds": total}
                for member_id, total in member_totals.items()
            ],
            "dailyTotals": [
                {"date": day, "totalSeconds": total}
                for day, total in sorted(daily_totals.items())
            ],
            "weeklyTotals": [
                {"weekStart": week, "totalSeconds": total}
                for week, total in sorted(weekly_totals.items())
            ],
        }

    return router
