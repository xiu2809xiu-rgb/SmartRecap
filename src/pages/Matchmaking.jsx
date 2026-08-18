import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, openLobbySocket } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useStore } from '../lib/store.jsx';
import { StudyShell } from '../components/layout/Shells.jsx';
import { CopyButton, Empty, Icon, Spinner, useToast } from '../components/ui.jsx';
import './matchmaking.css';

const sessionKey = (id) => `smartrecap.lobby.${id}`;
const saveSession = (id, session) => localStorage.setItem(sessionKey(id), JSON.stringify(session));
const readSession = (id) => {
  try { return JSON.parse(localStorage.getItem(sessionKey(id)) || 'null'); } catch { return null; }
};

export default function Matchmaking() {
  const { id, lobbyId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const { materialById, upsertMaterial } = useStore();
  const [material, setMaterial] = useState(materialById(id) ?? null);
  const [lobbies, setLobbies] = useState([]);
  const [lobby, setLobby] = useState(null);
  const [session, setSession] = useState(() => lobbyId ? readSession(lobbyId) : null);
  const [name, setName] = useState(user?.name || 'Student');
  const [roomName, setRoomName] = useState('Study showdown');
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [visibility, setVisibility] = useState('public');
  const [roomPassword, setRoomPassword] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.materials.get(id).then((value) => { setMaterial(value); upsertMaterial(value); }).catch(setError);
  }, [id, upsertMaterial]);

  useEffect(() => {
    if (lobbyId) {
      api.lobbies.get(lobbyId).then(setLobby).catch(setError);
      return undefined;
    }
    const refresh = () => api.lobbies.list().then(setLobbies).catch(setError);
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [lobbyId]);

  useEffect(() => {
    if (!lobbyId || !session) return undefined;
    let socket;
    let pollTimer;
    const refresh = () => api.lobbies.get(lobbyId).then(setLobby).catch(() => {});
    const startPolling = () => {
      if (!pollTimer) pollTimer = setInterval(refresh, 1500);
    };
    refresh();
    if (api.mode === 'live') {
      try {
        socket = openLobbySocket(lobbyId, session.playerId, session.reconnectToken);
        socket.onopen = () => {
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = undefined;
        };
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'lobby.snapshot') setLobby(message.data);
          } catch { /* ignore malformed snapshots */ }
        };
        socket.onerror = startPolling;
        socket.onclose = startPolling;
      } catch {
        startPolling();
      }
    } else {
      startPolling();
    }
    return () => {
      if (pollTimer) clearInterval(pollTimer);
      socket?.close();
    };
  }, [lobbyId, session]);

  useEffect(() => {
    if (lobby?.status === 'playing' && session) navigate(`/app/material/${id}/quiz?match=${lobby.id}`);
  }, [id, lobby, navigate, session]);

  const matchingRooms = useMemo(
    () => lobbies.filter((item) => item.materialId === id && item.quizId === material?.quiz?.id),
    [id, lobbies, material],
  );

  const createRoom = async () => {
    if (!material?.quiz?.id) return;
    setBusy(true); setError(null);
    try {
      const result = await api.lobbies.create({
        name: roomName.trim() || 'Study showdown',
        host_name: name.trim() || 'Student',
        materialId: id,
        quizId: material.quiz.id,
        max_players: maxPlayers,
        difficulty: titleCase(material.quiz.difficulty || 'medium'),
        visibility,
        password: visibility === 'private' ? roomPassword : undefined,
        questionCount: material.quiz.questions?.length || material.quiz.questionCount || 0,
      });
      const saved = { playerId: result.player_id, reconnectToken: result.reconnect_token };
      saveSession(result.lobby.id, saved);
      setSession(saved);
      setLobby(result.lobby);
      navigate(`/app/material/${id}/match/${result.lobby.id}`);
    } catch (cause) { setError(cause); toast.error(cause.message); }
    finally { setBusy(false); }
  };

  const joinRoom = async (targetId = lobbyId) => {
    setBusy(true); setError(null);
    try {
      const result = await api.lobbies.join(targetId, {
        playerName: name.trim() || 'Student',
        password: joinPassword || undefined,
      });
      const saved = { playerId: result.player_id, reconnectToken: result.reconnect_token };
      saveSession(targetId, saved); setSession(saved); setLobby(result.lobby);
      if (!lobbyId) navigate(`/app/material/${id}/match/${targetId}`);
    } catch (cause) { setError(cause); toast.error(cause.message); }
    finally { setBusy(false); }
  };

  const act = async (kind, extra = {}) => {
    if (!session) return;
    setBusy(true); setError(null);
    try {
      const payload = { playerId: session.playerId, reconnectToken: session.reconnectToken, ...extra };
      setLobby(await api.lobbies[kind](lobbyId, payload));
    } catch (cause) { setError(cause); toast.error(cause.message); }
    finally { setBusy(false); }
  };

  if (!material) return <StudyShell title="Matchmaking"><div className="shell match-loading"><Spinner size={22} />Loading quiz…</div></StudyShell>;
  if (!material.quiz?.id) {
    return <StudyShell title={material.title} backTo={`/app/material/${id}`}><div className="shell"><Empty icon="quiz" title="Create a quiz first" body="A multiplayer room uses the current generated quiz so every player receives the same questions." action={<Link className="btn btn-primary" to={`/app/material/${id}`}>Create quiz</Link>} /></div></StudyShell>;
  }

  if (lobbyId) {
    const me = lobby?.players?.find((player) => player.id === session?.playerId);
    const isHost = me?.is_host ?? me?.isHost;
    const guestsReady = lobby?.players?.filter((player) => !(player.is_host ?? player.isHost)).every((player) => player.ready);
    if (lobby && !session) {
      return (
        <StudyShell title={lobby.name} subtitle="Join this quiz room" backTo={`/app/material/${id}/match`}>
          <div className="shell match-shell">
            <section className="match-join panel-solid">
              <Icon name={lobby.has_password ? 'lock' : 'groups'} size={34} />
              <h1>Join {lobby.name}</h1>
              <p>{lobby.players.length} of {lobby.max_players} players · {lobby.difficulty} · {lobby.visibility === 'private' ? 'Private' : 'Public'}</p>
              <label className="field"><span>Display name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} /></label>
              {lobby.has_password && <label className="field"><span>Room password</span><input className="input" type="password" value={joinPassword} onChange={(event) => setJoinPassword(event.target.value)} maxLength={64} autoComplete="current-password" /></label>}
              <button className="btn btn-primary" onClick={() => joinRoom()} disabled={busy || (lobby.has_password && !joinPassword)}>{busy ? <Spinner size={17} /> : <Icon name="login" size={18} />}Join room</button>
            </section>
          </div>
        </StudyShell>
      );
    }
    return (
      <StudyShell title={lobby?.name || 'Quiz room'} subtitle={`Room ${lobbyId} · ${lobby?.difficulty || material.quiz.difficulty}`} backTo={`/app/material/${id}/match`}>
        <div className="shell match-shell">
          <header className="match-room-head">
            <div><p className="eyebrow">Live quiz lobby</p><h1>{lobby?.status === 'finished' ? 'Final standings' : 'Waiting for players'}</h1><p>Everyone receives the same {material.quiz.questionCount} conceptual questions.</p></div>
            <div className="room-code"><span>Room code</span><strong>{lobbyId}</strong><CopyButton value={lobbyId} /></div>
          </header>
          {error && <p className="field-error">{error.message}</p>}
          <section className="match-players panel-solid">
            <header><h2>Players</h2><span>{lobby?.players?.length || 0} / {lobby?.max_players || 0}</span></header>
            <ol>
              {[...(lobby?.players || [])].sort((a, b) => (b.score || 0) - (a.score || 0)).map((player, index) => (
                <li key={player.id} className={player.id === session?.playerId ? 'is-me' : ''}>
                  <span className="player-rank">{lobby.status === 'finished' ? index + 1 : <Icon name="person" size={18} />}</span>
                  <div><strong>{player.name}{(player.is_host ?? player.isHost) ? ' · Host' : ''}</strong><span>{player.submitted ? `${player.accuracy ?? 0}% accuracy` : player.answered ? `${player.answered} answered · ${player.accuracy ?? 0}% accuracy` : player.ready || (player.is_host ?? player.isHost) ? 'Ready' : 'Getting ready'}</span></div>
                  {lobby.status === 'finished' ? <strong className="player-score">{Number(player.score || 0).toLocaleString()} pts</strong> : <span className={`ready-dot ${player.ready || (player.is_host ?? player.isHost) ? 'is-on' : ''}`} />}
                </li>
              ))}
            </ol>
          </section>

          <div className="match-room-actions">
            {lobby?.status === 'finished' ? (
              <Link className="btn btn-primary" to={`/app/material/${id}`}><Icon name="menu_book" size={18} />Back to notes</Link>
            ) : isHost ? (
              <button className="btn btn-primary" onClick={() => act('start')} disabled={busy || lobby?.players?.length < 2 || !guestsReady}>
                {busy ? <Spinner size={17} /> : <Icon name="play_arrow" size={18} />}Start match
              </button>
            ) : (
              <button className={`btn ${me?.ready ? 'btn-ghost' : 'btn-primary'}`} onClick={() => act('ready', { ready: !me?.ready })} disabled={busy}>
                {busy ? <Spinner size={17} /> : <Icon name={me?.ready ? 'undo' : 'check_circle'} size={18} />}{me?.ready ? 'Not ready' : 'Ready up'}
              </button>
            )}
            <CopyButton value={`${window.location.origin}/app/material/${id}/match/${lobbyId}`} />
            {isHost && lobby?.players?.length < 2 && <span className="match-help">Invite at least one player to begin.</span>}
          </div>
        </div>
      </StudyShell>
    );
  }

  return (
    <StudyShell title={material.title} subtitle="Solo or multiplayer quiz" backTo={`/app/material/${id}`}>
      <div className="shell match-shell">
        <header className="match-browser-head"><p className="eyebrow">Matchmaking</p><h1>Challenge your study group</h1><p>Create a public party anyone can discover, or protect a private party with a password.</p></header>
        <div className="match-browser-grid">
          <section className="match-create panel-solid">
            <span className="match-feature-icon"><Icon name="add_circle" size={25} /></span><h2>Create a room</h2><p>You host the lobby and start when everyone is ready.</p>
            <label className="field"><span>Your name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} /></label>
            <label className="field"><span>Room name</span><input className="input" value={roomName} onChange={(event) => setRoomName(event.target.value)} maxLength={50} /></label>
            <label className="field"><span>Maximum players</span><select className="input" value={maxPlayers} onChange={(event) => setMaxPlayers(Number(event.target.value))}>{[2, 4, 6, 8].map((value) => <option key={value} value={value}>{value} players</option>)}</select></label>
            <label className="field"><span>Party visibility</span><select className="input" value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="public">Public · discoverable</option><option value="private">Private · password protected</option></select></label>
            {visibility === 'private' && <label className="field"><span>Party password</span><input className="input" type="password" value={roomPassword} onChange={(event) => setRoomPassword(event.target.value)} minLength={4} maxLength={64} placeholder="At least 4 characters" autoComplete="new-password" /></label>}
            <button className="btn btn-primary" onClick={createRoom} disabled={busy || (visibility === 'private' && roomPassword.trim().length < 4)}>{busy ? <Spinner size={17} /> : <Icon name={visibility === 'private' ? 'lock' : 'groups'} size={18} />}Create lobby</button>
          </section>
          <section className="match-open panel-solid">
            <span className="match-feature-icon"><Icon name="travel_explore" size={25} /></span><h2>Open rooms</h2><p>Rooms using this exact quiz version appear here.</p>
            <label className="field"><span>Your name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} /></label>
            <div className="open-room-list">
              {matchingRooms.length ? matchingRooms.map((room) => (
                <article key={room.id}>
                  <div><strong><Icon name={room.has_password ? 'lock' : 'public'} size={15} /> {room.name}</strong><span>{room.players.length}/{room.max_players} players · {room.difficulty} · {room.visibility === 'private' ? 'Private' : 'Public'}</span></div>
                  <button className="btn btn-ghost btn-sm" onClick={() => room.has_password ? navigate(`/app/material/${id}/match/${room.id}`) : joinRoom(room.id)} disabled={busy}>{room.has_password ? 'Unlock' : 'Join'}</button>
                </article>
              )) : <p className="no-rooms">No open rooms yet. Create the first one.</p>}
            </div>
          </section>
        </div>
        {error && <p className="field-error match-error">{error.message}</p>}
      </div>
    </StudyShell>
  );
}

function titleCase(value) { return value ? value[0].toUpperCase() + value.slice(1).toLowerCase() : 'Mixed'; }