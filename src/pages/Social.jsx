import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { CopyButton, Empty, Icon, Select, Spinner, useToast } from '../components/ui.jsx';
import './social.css';

const list = (value) => Array.isArray(value) ? value : [];
const secondsLabel = (seconds = 0) => {
  const minutes = Math.floor(Number(seconds) / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
};
const timerLabel = (seconds = 0) => {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`;
};
const profileName = (profile) => profile?.name || profile?.email || 'Student';
const makeSession = () => ({ id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title: 'Study session', date: new Date().toISOString().slice(0, 10), startTime: '17:00', durationMinutes: 45, assigneeId: null, completed: false });

export default function Social() {
  const { user, isGuest } = useAuth();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const [loading, setLoading] = useState(!isGuest);
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState({ incoming: [], outgoing: [] });
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [messages, setMessages] = useState([]);
  const [plan, setPlan] = useState({ title: 'Study plan', sessions: [], revision: 0 });
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [message, setMessage] = useState('');
  const [groupName, setGroupName] = useState('');
  const [groupMembers, setGroupMembers] = useState([]);
  const [invite, setInvite] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [redeem, setRedeem] = useState(() => searchParams.get('invite') || '');
  const [timerTitle, setTimerTitle] = useState('Focused study');
  const [clockNow, setClockNow] = useState(Date.now());
  const [busy, setBusy] = useState('');

  const active = conversations.find((conversation) => conversation.id === activeId);
  const friendOptions = useMemo(() => friends.map((friend) => ({ value: friend.friendId, label: profileName(friend.profile), secondary: friend.profile?.email || 'Friend' })), [friends]);

  const loadOverview = useCallback(async () => {
    if (isGuest) return;
    try {
      const [friendRows, requestRows, conversationRows] = await Promise.all([api.social.friends(), api.social.requests(), api.social.conversations()]);
      setFriends(list(friendRows));
      setRequests(requestRows || { incoming: [], outgoing: [] });
      setConversations(list(conversationRows));
      setActiveId((current) => current || conversationRows?.[0]?.id || '');
    } catch (error) {
      toast.error(error.message || 'Social spaces could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [isGuest, toast]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  const loadConversation = useCallback(async (conversationId) => {
    if (!conversationId) return;
    try {
      const [messageRows, planValue, sessionRows, statValue] = await Promise.all([
        api.social.messages(conversationId), api.social.plan(conversationId), api.social.sessions(conversationId), api.social.analytics(conversationId),
      ]);
      setMessages(list(messageRows));
      setPlan(planValue || { title: 'Study plan', sessions: [], revision: 0 });
      setSessions(list(sessionRows).map((session) => ({ ...session, _clientLoadedAt: Date.now() })));
      setStats(statValue || null);
    } catch (error) { toast.error(error.message || 'That study space could not be opened.'); }
  }, [toast]);

  useEffect(() => { if (activeId && !isGuest) loadConversation(activeId); }, [activeId, isGuest, loadConversation]);

  const run = async (key, action, success) => {
    setBusy(key);
    try { const value = await action(); if (success) toast.success(success); return value; }
    catch (error) { toast.error(error.message || 'That action could not be completed.'); return null; }
    finally { setBusy(''); }
  };

  const search = async (event) => {
    event.preventDefault();
    if (!query.trim()) return;
    const value = await run('search', () => api.social.search(query.trim()));
    if (value) setResults(value.filter((profile) => profile.id !== user?.id));
  };

  const refreshActive = () => activeId && loadConversation(activeId);
  const currentTimer = sessions.find((session) => session.state === 'running' || session.state === 'paused');
  const inviteUrl = useMemo(() => invite
    ? (invite.url || `${window.location.origin}/app/social?invite=${encodeURIComponent(invite.token || invite.code || invite.id)}`)
    : '', [invite]);

  useEffect(() => {
    if (!inviteUrl) { setQrDataUrl(''); return undefined; }
    let cancelled = false;
    QRCode.toDataURL(inviteUrl, {
      errorCorrectionLevel: 'M', margin: 1, width: 220,
      color: { dark: '#130b2b', light: '#ffffff' },
    }).then((value) => { if (!cancelled) setQrDataUrl(value); })
      .catch(() => { if (!cancelled) setQrDataUrl(''); });
    return () => { cancelled = true; };
  }, [inviteUrl]);

  useEffect(() => {
    if (currentTimer?.state !== 'running') return undefined;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [currentTimer?.id, currentTimer?.state]);

  const displayedTimerSeconds = Number(currentTimer?.elapsedSeconds || 0)
    + (currentTimer?.state === 'running'
      ? Math.max(0, Math.floor((clockNow - Number(currentTimer?._clientLoadedAt || clockNow)) / 1000))
      : 0);

  if (isGuest) return (
    <div className="shell social-page">
      <section className="social-guest panel-solid">
        <span><Icon name="diversity_3" size={34} /></span>
        <p className="eyebrow">Social study</p><h1>Build your study circle.</h1>
        <p>Friends, private chats, collaborative plans, group timers and shared analytics are tied to a durable account so the right people—and only those people—can return to them.</p>
        <Link to="/signup" className="btn btn-primary"><Icon name="person_add" size={18} />Create an account to continue</Link>
        <small>Your current guest library moves with you when you sign up.</small>
      </section>
    </div>
  );

  if (loading) return <div className="shell social-loading" role="status"><Spinner size={24} />Opening your study circle…</div>;

  return (
    <div className="shell social-page">
      <header className="social-hero">
        <div><p className="eyebrow">Social study</p><h1>Plan together. Focus together.</h1><p className="lede">Private study spaces with real collaboration—not a public feed.</p></div>
        <div className="social-summary"><span><strong>{friends.length}</strong>friends</span><span><strong>{conversations.length}</strong>spaces</span><span><strong>{secondsLabel(stats?.groupTotalSeconds)}</strong>group focus</span></div>
      </header>

      <section className="social-people-grid">
        <div className="panel social-card">
          <header><div><p className="eyebrow">Find people</p><h2>Search accounts</h2></div><Icon name="person_search" size={22} /></header>
          <form className="social-search" onSubmit={search}><input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or exact email" aria-label="Search accounts" /><button className="btn btn-primary btn-sm" disabled={busy === 'search'}>{busy === 'search' ? <Spinner size={16} /> : <Icon name="search" size={17} />}Search</button></form>
          <ul className="social-person-list">{results.map((profile) => <li key={profile.id}><Person profile={profile} /><button className="btn btn-ghost btn-sm" onClick={async () => { const value = await run(`request-${profile.id}`, () => api.social.requestFriend(profile.id), 'Friend request sent.'); if (value) loadOverview(); }} disabled={busy === `request-${profile.id}`}><Icon name="person_add" size={16} />Add</button></li>)}</ul>
        </div>
        <div className="panel social-card">
          <header><div><p className="eyebrow">Requests</p><h2>Pending</h2></div><span className="chip">{requests.incoming?.length || 0} incoming</span></header>
          <ul className="social-person-list">{list(requests.incoming).map((request) => <li key={request.id}><Person profile={request.requester} /><div className="row gap-1"><button className="icon-btn" aria-label="Accept request" onClick={async () => { await run(`accept-${request.id}`, () => api.social.acceptRequest(request.id), 'Friend added.'); loadOverview(); }}><Icon name="check" size={18} /></button><button className="icon-btn" aria-label="Decline request" onClick={async () => { await run(`decline-${request.id}`, () => api.social.removeRequest(request.id)); loadOverview(); }}><Icon name="close" size={18} /></button></div></li>)}</ul>
          {!requests.incoming?.length && <p className="social-muted">No incoming requests. Outgoing: {requests.outgoing?.length || 0}.</p>}
        </div>
      </section>

      <section className="social-workspace panel-solid">
        <aside className="social-sidebar">
          <header><div><p className="eyebrow">Study spaces</p><h2>Chats</h2></div></header>
          <div className="social-conversation-list">{conversations.map((conversation) => <button key={conversation.id} className={activeId === conversation.id ? 'is-on' : ''} onClick={() => setActiveId(conversation.id)}><Icon name={conversation.kind === 'group' ? 'groups' : 'person'} size={18} /><span><strong>{conversation.name || conversation.members?.filter((member) => member.id !== user.id).map(profileName).join(', ') || 'Direct chat'}</strong><small>{conversation.kind === 'group' ? `${conversation.memberIds?.length || 0} members` : 'Direct message'}</small></span></button>)}</div>
          <div className="social-new-space">
            <h3>New conversation</h3>
            <Select label="Friend for direct chat" value="" placeholder="Message a friend" options={friendOptions} onChange={async (friendId) => { const value = await run('direct', () => api.social.createConversation({ kind: 'direct', memberIds: [friendId] }), 'Direct chat ready.'); if (value) { await loadOverview(); setActiveId(value.id); } }} disabled={!friendOptions.length} emptyText="Add a friend first" />
            <input className="input" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Group name" aria-label="Group name" />
            <div className="social-member-checks">{friends.map((friend) => <label key={friend.friendId}><input type="checkbox" checked={groupMembers.includes(friend.friendId)} onChange={() => setGroupMembers((current) => current.includes(friend.friendId) ? current.filter((id) => id !== friend.friendId) : [...current, friend.friendId])} />{profileName(friend.profile)}</label>)}</div>
            <button className="btn btn-ghost btn-sm" disabled={!groupName.trim() || !groupMembers.length || busy === 'group'} onClick={async () => { const value = await run('group', () => api.social.createConversation({ kind: 'group', name: groupName.trim(), memberIds: groupMembers }), 'Group created.'); if (value) { setGroupName(''); setGroupMembers([]); await loadOverview(); setActiveId(value.id); } }}><Icon name="group_add" size={17} />Create group</button>
          </div>
        </aside>

        <div className="social-main">
          {!active ? <Empty icon="forum" title="Choose or create a study space" body="Direct and group chats keep messages, plans and focus sessions together." /> : <>
            <header className="social-space-head"><div><p className="eyebrow">{active.kind} space</p><h2>{active.name || active.members?.filter((member) => member.id !== user.id).map(profileName).join(', ') || 'Conversation'}</h2></div><span>{active.memberIds?.length || 0} members</span></header>
            <nav className="social-tabs" aria-label="Study space tools"><a href="#messages">Messages</a><a href="#planner">Planner</a><a href="#focus">Focus</a><a href="#analytics">Analytics</a></nav>

            <section id="messages" className="social-section"><header><h3>Messages</h3><span>{messages.length}</span></header><div className="message-list">{messages.map((item) => <article key={item.id} className={item.senderId === user.id ? 'is-me' : ''}><strong>{item.senderId === user.id ? 'You' : active.members?.find((member) => member.id === item.senderId)?.name || 'Member'}</strong><p>{item.text}</p><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></article>)}</div><form className="message-form" onSubmit={async (event) => { event.preventDefault(); if (!message.trim()) return; const value = await run('message', () => api.social.sendMessage(activeId, message.trim())); if (value) { setMessage(''); setMessages((current) => [...current, value]); } }}><input className="input" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4000} placeholder="Write a message…" aria-label="Message" /><button className="btn btn-primary" disabled={!message.trim() || busy === 'message'}><Icon name="send" size={18} />Send</button></form></section>

            {active.kind === 'group' && <section className="social-section share-panel"><header><div><h3>Invite link or code</h3><p>Scan the locally generated QR with a phone camera, or share the expiring link or short code.</p></div><Icon name="share" size={21} /></header>{invite ? <div className="share-values">{qrDataUrl && <figure className="invite-qr"><img src={qrDataUrl} alt={`QR code for joining ${active.name || 'this study group'}`} /><figcaption>Scan to join</figcaption></figure>}<label>Invite link<input className="input" readOnly value={inviteUrl} /></label><CopyButton value={inviteUrl} /><label>Code<input className="input" readOnly value={invite.code || ''} /></label><CopyButton value={invite.code || ''} />{navigator.share && <button className="btn btn-ghost btn-sm" onClick={() => navigator.share({ title: active.name || 'SmartRecap study group', url: inviteUrl })}><Icon name="ios_share" size={17} />Share</button>}</div> : <button className="btn btn-ghost" onClick={async () => { const value = await run('invite', () => api.social.createInvite(activeId, { expiresInSeconds: 604800, maxUses: 25 }), 'Invite created.'); if (value) setInvite(value); }} disabled={busy === 'invite'}><Icon name="add_link" size={18} />Create invite</button>}</section>}

            <section className="social-section redeem-panel"><header><h3>Redeem an invite</h3></header><div><input className="input" value={redeem} onChange={(event) => setRedeem(event.target.value)} placeholder="Paste invite URL, token, or code" aria-label="Invite URL, token, or code" /><button className="btn btn-ghost" disabled={!redeem.trim() || busy === 'redeem'} onClick={async () => { const reference = redeem.includes('invite=') ? new URL(redeem, window.location.origin).searchParams.get('invite') : redeem.trim(); const value = await run('redeem', () => api.social.redeemInvite(reference), 'Group joined.'); if (value) { setRedeem(''); await loadOverview(); setActiveId(value.id); } }}><Icon name="login" size={18} />Join group</button></div></section>

            <section id="planner" className="social-section planner"><header><div><h3>Collaborative planner</h3><p>Revision {plan.revision || 0} · optimistic conflict protection</p></div><button className="btn btn-ghost btn-sm" onClick={() => setPlan((current) => ({ ...current, sessions: [...current.sessions, makeSession()] }))}><Icon name="add" size={17} />Session</button></header><label className="field"><span>Plan title</span><input className="input" value={plan.title} onChange={(event) => setPlan((current) => ({ ...current, title: event.target.value }))} /></label><div className="plan-list">{list(plan.sessions).map((session, index) => <div key={session.id}><input className="input" value={session.title} onChange={(event) => setPlan((current) => ({ ...current, sessions: current.sessions.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item) }))} aria-label="Session title" /><input className="input" type="date" value={session.date} onChange={(event) => setPlan((current) => ({ ...current, sessions: current.sessions.map((item, itemIndex) => itemIndex === index ? { ...item, date: event.target.value } : item) }))} aria-label="Session date" /><input className="input" type="time" value={session.startTime} onChange={(event) => setPlan((current) => ({ ...current, sessions: current.sessions.map((item, itemIndex) => itemIndex === index ? { ...item, startTime: event.target.value } : item) }))} aria-label="Start time" /><input className="input" type="number" min="5" max="1440" value={session.durationMinutes} onChange={(event) => setPlan((current) => ({ ...current, sessions: current.sessions.map((item, itemIndex) => itemIndex === index ? { ...item, durationMinutes: Number(event.target.value) } : item) }))} aria-label="Duration minutes" /><button className="icon-btn" aria-label="Remove session" onClick={() => setPlan((current) => ({ ...current, sessions: current.sessions.filter((_, itemIndex) => itemIndex !== index) }))}><Icon name="delete" size={18} /></button></div>)}</div><button className="btn btn-primary" disabled={busy === 'plan'} onClick={async () => { setBusy('plan'); try { const saved = await api.social.savePlan(activeId, { title: plan.title, sessions: plan.sessions, expectedRevision: plan.revision || 0 }); setPlan(saved); toast.success('Collaborative plan saved.'); } catch (error) { if (error.status === 409) { const latest = await api.social.plan(activeId); setPlan(latest); toast.info('Someone updated the plan first. Their latest revision is loaded; review and save again.'); } else toast.error(error.message || 'Plan could not be saved.'); } finally { setBusy(''); } }}><Icon name="save" size={18} />Save plan</button></section>

            <section id="focus" className="social-section focus"><header><div><h3>Study timer</h3><p>One start, pause, resume and stop record shared with this group.</p></div><strong className="focus-clock">{timerLabel(displayedTimerSeconds)}</strong></header><input className="input" value={timerTitle} onChange={(event) => setTimerTitle(event.target.value)} placeholder="Session title" aria-label="Timer title" disabled={!!currentTimer} /><div className="row wrap gap-2">{!currentTimer ? <button className="btn btn-primary" onClick={async () => { const value = await run('timer', () => api.social.startTimer(activeId, timerTitle.trim() || null), 'Focus session started.'); if (value) refreshActive(); }}><Icon name="play_arrow" size={18} />Start</button> : <>{currentTimer.state === 'running' ? <button className="btn btn-ghost" onClick={async () => { await run('timer', () => api.social.pauseTimer(activeId, currentTimer.id)); refreshActive(); }}><Icon name="pause" size={18} />Pause</button> : <button className="btn btn-primary" onClick={async () => { await run('timer', () => api.social.resumeTimer(activeId, currentTimer.id)); refreshActive(); }}><Icon name="play_arrow" size={18} />Resume</button>}<button className="btn btn-ghost" onClick={async () => { await run('timer', () => api.social.stopTimer(activeId, currentTimer.id), 'Focus session saved.'); refreshActive(); }}><Icon name="stop" size={18} />Stop</button></>}</div></section>

            <section id="analytics" className="social-section analytics"><header><div><h3>Study analytics</h3><p>Daily, weekly and group totals from completed and active timers.</p></div><button className="icon-btn" onClick={refreshActive} aria-label="Refresh analytics"><Icon name="refresh" size={18} /></button></header><div className="analytics-grid"><article><Icon name="today" size={20} /><strong>{secondsLabel(stats?.dailyTotals?.at(-1)?.totalSeconds)}</strong><span>Latest day</span></article><article><Icon name="date_range" size={20} /><strong>{secondsLabel(stats?.weeklyTotals?.at(-1)?.totalSeconds)}</strong><span>Latest week</span></article><article><Icon name="person" size={20} /><strong>{secondsLabel(stats?.ownTotalSeconds)}</strong><span>Your total</span></article><article><Icon name="groups" size={20} /><strong>{secondsLabel(stats?.groupTotalSeconds)}</strong><span>Group total</span></article></div></section>
          </>}
        </div>
      </section>
    </div>
  );
}

function Person({ profile }) {
  return <div className="social-person"><span>{profileName(profile).slice(0, 1).toUpperCase()}</span><div><strong>{profileName(profile)}</strong><small>{profile?.email || 'SmartRecap member'}</small></div></div>;
}