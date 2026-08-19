import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, openLobbySocket } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useStore } from '../lib/store.jsx';
import { StudyShell } from '../components/layout/Shells.jsx';
import { CopyButton, Empty, Icon, Select, Spinner, useToast } from '../components/ui.jsx';
import { AvatarPicker, MatchAvatar, safeAvatarId } from '../components/MatchAvatar.jsx';
import './matchmaking.css';

const sessionKey = (id) => `smartrecap.lobby.${id}`;
const isMatchCompatible = (quiz) => !(quiz?.questions || []).some((question) => (question?.type || 'single') === 'short');
const saveSession = (id, session) => localStorage.setItem(sessionKey(id), JSON.stringify(session));
const readSession = (id) => {
  try { return JSON.parse(localStorage.getItem(sessionKey(id)) || 'null'); } catch { return null; }
};

export default function Matchmaking() {
  const { id, lobbyId } = useParams();
  const [searchParams] = useSearchParams();
  const requestedQuizId = searchParams.get('quizId');
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const { materialById, upsertMaterial } = useStore();
  const [material, setMaterial] = useState(materialById(id) ?? null);
  const [quizzes, setQuizzes] = useState([]);
  const [selectedQuizId, setSelectedQuizId] = useState(requestedQuizId || '');
  const [lobbies, setLobbies] = useState([]);
  const [lobby, setLobby] = useState(null);
  const [session, setSession] = useState(() => lobbyId ? readSession(lobbyId) : null);
  const [name, setName] = useState(user?.name || 'Student');
  const [avatarId, setAvatarId] = useState('nova');
  const [roomName, setRoomName] = useState('Study showdown');
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [visibility, setVisibility] = useState('public');
  const [roomPassword, setRoomPassword] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingQuizzes, setLoadingQuizzes] = useState(!lobbyId);
  const [lobbyLoading, setLobbyLoading] = useState(Boolean(lobbyId));
  const [lobbyReload, setLobbyReload] = useState(0);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (lobbyId) {
      setLoadingQuizzes(false);
      return undefined;
    }
    setLoadingQuizzes(true);
    Promise.all([api.materials.get(id), api.quiz.list()])
      .then(([value, versions]) => {
        setMaterial(value);
        upsertMaterial(value);
        const saved = (versions || []).filter((quiz) => String(quiz.materialId ?? quiz.material_id) === String(id));
        const playable = saved.filter(isMatchCompatible);
        setQuizzes(saved);
        setSelectedQuizId((current) => current && playable.some((quiz) => quiz.id === current)
          ? current
          : (requestedQuizId && playable.some((quiz) => quiz.id === requestedQuizId) ? requestedQuizId : playable[0]?.id || ''));
      })
      .catch(setError)
      .finally(() => setLoadingQuizzes(false));
    return undefined;
  }, [id, lobbyId, requestedQuizId, upsertMaterial]);

  useEffect(() => {
    if (lobbyId) {
      let cancelled = false;
      setLobbyLoading(true);
      setError(null);
      api.lobbies.get(lobbyId)
        .then((value) => { if (!cancelled) setLobby(value); })
        .catch((cause) => { if (!cancelled) setError(cause); })
        .finally(() => { if (!cancelled) setLobbyLoading(false); });
      return () => { cancelled = true; };
    }
    const refresh = () => api.lobbies.list().then(setLobbies).catch(setError);
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [lobbyId, lobbyReload]);

  useEffect(() => {
    if (!lobbyId || !session) return undefined;
    let socket;
    let pollTimer;
    const refresh = () => api.lobbies.get(lobbyId).then(setLobby).catch(() => {});
    const startPolling = () => {
      if (!pollTimer) pollTimer = setInterval(refresh, 1500);
    };
    refresh();
    startPolling();
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
    const lobbyQuizId = lobby?.quizId ?? lobby?.quiz_id;
    if (lobbyQuizId) setSelectedQuizId(lobbyQuizId);
    if (lobby?.status === 'playing' && session) navigate(`/app/material/${id}/quiz?match=${lobby.id}`);
  }, [id, lobby, navigate, session]);

  const selectedQuiz = useMemo(() => quizzes.find((quiz) => quiz.id === selectedQuizId), [quizzes, selectedQuizId]);
  const quizOptions = useMemo(() => quizzes.map((quiz) => {
    const compatible = isMatchCompatible(quiz);
    return {
      value: quiz.id,
      label: quiz.title || `${titleCase(quiz.difficulty || 'medium')} quiz`,
      secondary: compatible
        ? `${quiz.questionCount || quiz.questions?.length || 0} questions · ${quiz.generatedAt ? new Date(quiz.generatedAt).toLocaleDateString() : 'Saved version'}`
        : 'Solo only · contains written-answer questions',
      disabled: !compatible,
    };
  }), [quizzes]);
  const matchingRooms = useMemo(
    () => lobbies.filter((item) => String(item.materialId ?? item.material_id) === String(id) && item.quizId === selectedQuizId),
    [id, lobbies, selectedQuizId],
  );

  const createRoom = async () => {
    if (!selectedQuiz?.id) return;
    setBusy(true); setError(null);
    try {
      const result = await api.lobbies.create({
        name: roomName.trim() || 'Study showdown',
        host_name: name.trim() || 'Student',
        materialId: id,
        quizId: selectedQuiz.id,
        avatarId: safeAvatarId(avatarId),
        max_players: maxPlayers,
        difficulty: titleCase(selectedQuiz.difficulty || 'medium'),
        visibility,
        password: visibility === 'private' ? roomPassword : undefined,
        questionCount: selectedQuiz.questions?.length || selectedQuiz.questionCount || 0,
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
        avatarId: safeAvatarId(avatarId),
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

  if (lobbyId && lobbyLoading) {
    return <StudyShell title="Matchmaking"><div className="shell match-loading"><Spinner size={22} />Loading quiz room…</div></StudyShell>;
  }
  if (lobbyId && !lobby) {
    return (
      <StudyShell title="Room unavailable" backTo="/app/quizzes">
        <div className="shell">
          <Empty
            icon="error"
            title="This quiz room could not be loaded"
            body={error?.message || 'The room may have closed. Ask the host for a new invitation.'}
            action={<button className="btn btn-primary" onClick={() => setLobbyReload((value) => value + 1)}>Try again</button>}
          />
        </div>
      </StudyShell>
    );
  }
  if (!lobbyId && (!material || loadingQuizzes)) return <StudyShell title="Matchmaking"><div className="shell match-loading"><Spinner size={22} />Loading saved quiz versions…</div></StudyShell>;
  if (!lobbyId && (!quizzes.length || !quizzes.some(isMatchCompatible))) {
    const onlyWritten = quizzes.length > 0;
    return <StudyShell title={material.title} backTo={`/app/material/${id}`}><div className="shell"><Empty icon="quiz" title={onlyWritten ? 'Create an objective quiz for matchmaking' : 'Create a quiz first'} body={onlyWritten ? 'Written answers are graded after submission, so they cannot drive a fair live speed leaderboard. Generate a saved version with Single and/or Multi question types.' : 'A multiplayer room uses one immutable saved quiz so every player receives the exact same questions.'} action={<Link className="btn btn-primary" to={`/app/material/${id}`}>{onlyWritten ? 'Create objective quiz' : 'Create quiz'}</Link>} /></div></StudyShell>;
  }

  if (lobbyId) {
    const me = lobby?.players?.find((player) => player.id === session?.playerId);
    const isHost = me?.is_host ?? me?.isHost;
    const guestsReady = lobby?.players?.filter((player) => !(player.is_host ?? player.isHost)).every((player) => player.ready);
    if (lobby && !session) {
      return (
        <StudyShell title={lobby.name} subtitle="Join this quiz room" backTo="/app/quizzes">
          <div className="shell match-shell">
            <section className="match-join panel-solid">
              <Icon name={lobby.has_password ? 'lock' : 'groups'} size={34} />
              <h1>Join {lobby.name}</h1>
              <p>{lobby.players.length} of {lobby.max_players} players · {lobby.difficulty} · {lobby.visibility === 'private' ? 'Private' : 'Public'}</p>
              <label className="field"><span>Display name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} /></label>
              <AvatarPicker value={avatarId} onChange={setAvatarId} />
              {lobby.has_password && <label className="field"><span>Room password</span><input className="input" type="password" value={joinPassword} onChange={(event) => setJoinPassword(event.target.value)} maxLength={64} autoComplete="current-password" /></label>}
              <button className="btn btn-primary" onClick={() => joinRoom()} disabled={busy || (lobby.has_password && !joinPassword)}>{busy ? <Spinner size={17} /> : <Icon name="login" size={18} />}Join room</button>
            </section>
          </div>
        </StudyShell>
      );
    }
    return (
      <StudyShell title={lobby?.name || 'Quiz room'} subtitle={`Room ${lobbyId} · ${lobby?.difficulty || 'Quiz'}`} backTo="/app/quizzes">
        <div className="shell match-shell">
          <header className="match-room-head">
            <div><p className="eyebrow">Live quiz lobby</p><h1>{lobby?.status === 'finished' ? 'Final standings' : 'Waiting for players'}</h1><p>Everyone receives the same immutable snapshot of {lobby?.total_questions || lobby?.totalQuestions || selectedQuiz?.questionCount || 0} questions.</p></div>
            <div className="room-code"><span>Room code</span><strong>{lobbyId}</strong><CopyButton value={lobbyId} /></div>
          </header>
          {error && <p className="field-error">{error.message}</p>}
          <section className="match-players panel-solid">
            <header><h2>Players</h2><span>{lobby?.players?.length || 0} / {lobby?.max_players || 0}</span></header>
            <ol>
              {[...(lobby?.players || [])].sort((a, b) => (b.score || 0) - (a.score || 0)).map((player, index) => (
                <li key={player.id} className={player.id === session?.playerId ? 'is-me' : ''}>
                  <span className="player-rank">{lobby.status === 'finished' ? index + 1 : <MatchAvatar avatarId={player.avatarId ?? player.avatar_id} size="sm" label={`${player.name}'s avatar`} />}</span>
                  <div><strong>{player.name}{(player.is_host ?? player.isHost) ? ' · Host' : ''}</strong><span>{player.submitted ? `${player.accuracy ?? 0}% accuracy` : player.answered ? `${player.answered} answered · ${player.accuracy ?? 0}% accuracy` : player.ready || (player.is_host ?? player.isHost) ? 'Ready' : 'Getting ready'}</span></div>
                  {lobby.status === 'finished' ? <strong className="player-score">{Number(player.score || 0).toLocaleString()} pts</strong> : <span className={`ready-dot ${player.ready || (player.is_host ?? player.isHost) ? 'is-on' : ''}`} />}
                </li>
              ))}
            </ol>
          </section>

          <div className="match-room-actions">
            {lobby?.status === 'finished' ? (
              <Link className="btn btn-primary" to={isHost ? `/app/material/${id}` : '/app/quizzes'}><Icon name="menu_book" size={18} />{isHost ? 'Back to notes' : 'Back to quizzes'}</Link>
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
            <div className="field"><span>Saved quiz version</span><Select label="Saved quiz version" value={selectedQuizId} onChange={setSelectedQuizId} options={quizOptions} /></div>
            <label className="field"><span>Your name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} /></label>
            <AvatarPicker value={avatarId} onChange={setAvatarId} />
            <label className="field"><span>Room name</span><input className="input" value={roomName} onChange={(event) => setRoomName(event.target.value)} maxLength={50} /></label>
            <div className="field"><span>Maximum players</span><Select label="Maximum players" value={maxPlayers} onChange={(value) => setMaxPlayers(Number(value))} options={[2, 4, 6, 8].map((value) => ({ value, label: `${value} players` }))} /></div>
            <div className="field"><span>Party visibility</span><Select label="Party visibility" value={visibility} onChange={setVisibility} options={[{ value: 'public', label: 'Public', secondary: 'Discoverable by other students', icon: 'public' }, { value: 'private', label: 'Private', secondary: 'Protected by a room password', icon: 'lock' }]} /></div>
            {visibility === 'private' && <label className="field"><span>Party password</span><input className="input" type="password" value={roomPassword} onChange={(event) => setRoomPassword(event.target.value)} minLength={4} maxLength={64} placeholder="At least 4 characters" autoComplete="new-password" /></label>}
            <button className="btn btn-primary" onClick={createRoom} disabled={busy || (visibility === 'private' && roomPassword.trim().length < 4)}>{busy ? <Spinner size={17} /> : <Icon name={visibility === 'private' ? 'lock' : 'groups'} size={18} />}Create lobby</button>
          </section>
          <section className="match-open panel-solid">
            <span className="match-feature-icon"><Icon name="travel_explore" size={25} /></span><h2>Open rooms</h2><p>Rooms using this exact quiz version appear here.</p>
            <div className="field"><span>Browse rooms for</span><Select label="Quiz version for open rooms" value={selectedQuizId} onChange={setSelectedQuizId} options={quizOptions} /></div>
            <label className="field"><span>Your name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} /></label>
            <AvatarPicker value={avatarId} onChange={setAvatarId} label="Your room avatar" />
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

function titleCase(value) {
  // Falls back to 'Medium', not 'Mixed'. 'Mixed' was a label the backend had
  // never heard of, so an empty difficulty produced a 422 on room creation.
  return value ? value[0].toUpperCase() + value.slice(1).toLowerCase() : 'Medium';
}