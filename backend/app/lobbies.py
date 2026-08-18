import asyncio
import hashlib
import hmac
import secrets
from datetime import datetime, timezone
from typing import Dict, List, Set, Tuple

from fastapi import HTTPException, WebSocket

from .models import Lobby, LobbyAnswerAction, LobbyCreate, LobbyJoin, LobbyScoreAction, LobbySession, Player


def _unique_name(wanted: str, players) -> str:
    """`Student` → `Student`, then `Student 2`, `Student 3`, ...

    Case-insensitive, because two people reading "student" and "Student" off a
    leaderboard cannot tell them apart either.
    """
    taken = {player.name.casefold() for player in players}
    if wanted.casefold() not in taken:
        return wanted
    for suffix in range(2, len(taken) + 3):
        candidate = "{} {}".format(wanted, suffix)
        if candidate.casefold() not in taken:
            return candidate
    return wanted


class LobbyStore:
    def __init__(self) -> None:
        self._lobbies: Dict[str, Lobby] = {}
        self._tokens: Dict[str, str] = {}
        self._passwords: Dict[str, Tuple[bytes, bytes]] = {}
        self._answers: Dict[str, Dict[str, Set[str]]] = {}
        self._sockets: Dict[str, List[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def list_open(self) -> List[Lobby]:
        return [lobby for lobby in self._lobbies.values() if lobby.status == "open"]

    @staticmethod
    def _password_digest(password: str, salt: bytes) -> bytes:
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 210_000)

    def _password_matches(self, lobby_id: str, password: str) -> bool:
        stored = self._passwords.get(lobby_id)
        if not stored:
            return True
        salt, expected = stored
        return hmac.compare_digest(self._password_digest(password, salt), expected)

    async def get(self, lobby_id: str) -> Lobby:
        lobby = self._lobbies.get(lobby_id)
        if not lobby:
            raise HTTPException(status_code=404, detail="That lobby does not exist.")
        return lobby

    async def create(self, request: LobbyCreate) -> LobbySession:
        if request.visibility == "private" and not request.password:
            raise HTTPException(status_code=422, detail="Private rooms require a password of at least 4 characters.")
        async with self._lock:
            lobby_id, player_id = secrets.token_urlsafe(5), secrets.token_urlsafe(8)
            player = Player(id=player_id, name=request.host_name.strip(), is_host=True)
            lobby = Lobby(
                id=lobby_id,
                name=request.name.strip(),
                host_id=player_id,
                material_id=request.material_id,
                quiz_id=request.quiz_id,
                max_players=request.max_players,
                difficulty=request.difficulty,
                visibility=request.visibility,
                has_password=request.visibility == "private",
                total_questions=request.question_count,
                players=[player],
                created_at=datetime.now(timezone.utc).isoformat(),
            )
            self._lobbies[lobby_id] = lobby
            self._answers[lobby_id] = {player_id: set()}
            if request.visibility == "private" and request.password:
                salt = secrets.token_bytes(16)
                self._passwords[lobby_id] = (salt, self._password_digest(request.password, salt))
            token = secrets.token_urlsafe(24)
            self._tokens[player_id] = token
            return LobbySession(lobby=lobby, player_id=player_id, reconnect_token=token)

    async def join(self, lobby_id: str, request: LobbyJoin) -> LobbySession:
        async with self._lock:
            lobby = self._lobbies.get(lobby_id)
            if not lobby or lobby.status != "open":
                raise HTTPException(status_code=404, detail="This lobby is no longer open.")
            if lobby.has_password and not self._password_matches(lobby_id, request.password or ""):
                raise HTTPException(status_code=403, detail="That room password is incorrect.")
            if len(lobby.players) >= lobby.max_players:
                raise HTTPException(status_code=409, detail="This lobby is full.")
            # A clashing display name is disambiguated, not refused.
            #
            # Refusing it made the very first interaction of the multiplayer
            # demo fail: the auth stub is a single shared record, so every
            # browser reports the same name ("Student"). The host took it, and
            # the second student was turned away at the door with a 409 for
            # something they did not choose and could not see.
            name = _unique_name(request.player_name.strip() or "Player", lobby.players)
            player_id, token = secrets.token_urlsafe(8), secrets.token_urlsafe(24)
            lobby.players.append(Player(id=player_id, name=name))
            self._tokens[player_id] = token
            self._answers.setdefault(lobby_id, {})[player_id] = set()
        await self.broadcast(lobby_id)
        return LobbySession(lobby=lobby, player_id=player_id, reconnect_token=token)

    def _authorize(self, lobby_id: str, player_id: str, token: str) -> Lobby:
        lobby = self._lobbies.get(lobby_id)
        if not lobby or self._tokens.get(player_id) != token or not any(player.id == player_id for player in lobby.players):
            raise HTTPException(status_code=403, detail="Invalid or expired lobby session.")
        return lobby

    async def set_ready(self, lobby_id: str, player_id: str, token: str, ready: bool) -> Lobby:
        async with self._lock:
            lobby = self._authorize(lobby_id, player_id, token)
            if lobby.status != "open":
                raise HTTPException(status_code=409, detail="This match has already started.")
            player = next(item for item in lobby.players if item.id == player_id)
            player.ready = ready
        await self.broadcast(lobby_id)
        return lobby

    async def start(self, lobby_id: str, player_id: str, token: str) -> Lobby:
        async with self._lock:
            lobby = self._authorize(lobby_id, player_id, token)
            if lobby.host_id != player_id:
                raise HTTPException(status_code=403, detail="Only the host can start the match.")
            if lobby.status != "open":
                raise HTTPException(status_code=409, detail="This match has already started.")
            if len(lobby.players) < 2:
                raise HTTPException(status_code=409, detail="At least 2 players are required to start the match.")
            guests = [player for player in lobby.players if not player.is_host]
            if not all(player.ready for player in guests):
                raise HTTPException(status_code=409, detail="Everyone must ready up before the match starts.")
            for player in lobby.players:
                player.score = 0
                player.submitted = False
                player.answered = 0
                player.correct = 0
                player.accuracy = 0.0
                player.last_correct = None
                self._answers.setdefault(lobby_id, {})[player.id] = set()
            lobby.current_question = 0
            lobby.status = "playing"
        await self.broadcast(lobby_id)
        return lobby

    async def submit_answer(self, lobby_id: str, request: LobbyAnswerAction) -> Lobby:
        async with self._lock:
            lobby = self._authorize(lobby_id, request.player_id, request.reconnect_token)
            if lobby.status != "playing":
                raise HTTPException(status_code=409, detail="The match must be active before answers can be submitted.")
            answered = self._answers.setdefault(lobby_id, {}).setdefault(request.player_id, set())
            if request.question_id in answered:
                raise HTTPException(status_code=409, detail="That question was already scored for this player.")
            answered.add(request.question_id)
            player = next(item for item in lobby.players if item.id == request.player_id)
            player.answered += 1
            player.last_correct = request.correct
            if request.correct:
                player.correct += 1
                speed_bonus = max(0, 500 - min(request.response_ms, 30_000) // 60)
                player.score += 1000 + speed_bonus
            player.accuracy = round(player.correct / player.answered * 100, 1)
            lobby.current_question = max((item.answered for item in lobby.players), default=0)
        await self.broadcast(lobby_id)
        return lobby

    async def submit_score(self, lobby_id: str, request: LobbyScoreAction) -> Lobby:
        async with self._lock:
            lobby = self._authorize(lobby_id, request.player_id, request.reconnect_token)
            if lobby.status not in {"playing", "finished"}:
                raise HTTPException(status_code=409, detail="The match must be started before scores can be submitted.")
            player = next(item for item in lobby.players if item.id == request.player_id)
            if player.answered:
                player.accuracy = float(request.score)
            else:
                player.score = request.score
                player.accuracy = float(request.score)
            player.submitted = True
            if all(item.submitted for item in lobby.players):
                lobby.status = "finished"
        await self.broadcast(lobby_id)
        return lobby

    async def connect(self, lobby_id: str, player_id: str, token: str, websocket: WebSocket) -> bool:
        try:
            lobby = self._authorize(lobby_id, player_id, token)
        except HTTPException:
            await websocket.close(code=4403)
            return False
        await websocket.accept()
        self._sockets.setdefault(lobby_id, []).append(websocket)
        await websocket.send_json({"type": "lobby.snapshot", "data": lobby.model_dump(by_alias=True)})
        return True

    def disconnect(self, lobby_id: str, websocket: WebSocket) -> None:
        sockets = self._sockets.get(lobby_id, [])
        if websocket in sockets:
            sockets.remove(websocket)

    async def broadcast(self, lobby_id: str) -> None:
        lobby = self._lobbies.get(lobby_id)
        if not lobby:
            return
        stale = []
        for socket in self._sockets.get(lobby_id, []):
            try:
                await socket.send_json({"type": "lobby.snapshot", "data": lobby.model_dump(by_alias=True)})
            except Exception:
                stale.append(socket)
        for socket in stale:
            self.disconnect(lobby_id, socket)


store = LobbyStore()