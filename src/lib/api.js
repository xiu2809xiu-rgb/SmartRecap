import { mockApi, PIPELINE_STAGES } from './mockApi.js';

/**
 * API client.
 *
 * With `VITE_API_BASE_URL` set, every call goes to the deployed API Gateway
 * stage. Without it, the identical surface is served by `mockApi` so the app
 * runs with no AWS session at all. Components import `api` and never branch on
 * which one is behind it.
 */

const USE_MOCK = import.meta.env?.VITE_USE_MOCK_API === 'true';
const BASE = (import.meta.env?.VITE_API_BASE_URL?.replace(/\/$/, '') || '/api');
export const isDemo = USE_MOCK;
export { PIPELINE_STAGES };

const TOKEN_KEY = 'smartrecap.token';

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t) => {
    try {
      t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage disabled */
    }
  },
};

/**
 * Shown when nothing is listening on the API.
 *
 * Names the actual cause and the actual fix. The person reading it is either a
 * teammate who forgot to start the backend, or a judge watching a demo — both
 * are better served by one concrete instruction than by a status code.
 */
export const API_UNREACHABLE =
  'The SmartRecap API is not responding. If you are running this locally, start the backend with "npm run backend:dev" in a second terminal.';

/**
 * The human-readable reason out of an error body.
 *
 * FastAPI sends two different shapes under the same key. A thrown
 * `HTTPException` gives `detail` as a string; a validation failure gives it as
 * an ARRAY of `{loc, msg, type}`. Passing that array to `new Error()` renders
 * it as the literal text "[object Object]", which is what a student saw for
 * every rejected form in the app — a room name a character too short, a
 * password too weak, a value the server did not recognise.
 */
function readDetail(payload) {
  const detail = payload?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => item?.msg || item?.message).filter(Boolean);
    if (messages.length) {
      // Sentence-cased and joined: pydantic writes "String should have at
      // least 3 characters" without a full stop.
      return messages.map((m) => (m.endsWith('.') ? m : `${m}.`)).join(' ');
    }
  }
  return typeof payload?.message === 'string' ? payload.message : null;
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, signal, auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = auth ? tokenStore.get() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new ApiError(API_UNREACHABLE, 0, null);
  }

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!res.ok) {
    if (res.status === 401) tokenStore.set(null);

    // A dead backend and a broken one look identical to `fetch`, and they need
    // completely different responses from whoever is reading the screen.
    //
    // When the API process is not running, Vite's dev proxy answers 5xx with an
    // EMPTY body; nginx does much the same in production. A real server error
    // always carries a body — FastAPI sends `{"detail": ...}`. So an empty 5xx
    // means "nothing is listening", and saying "Request failed (500)" for that
    // sends people looking for a bug in code that is fine.
    if (res.status >= 500 && !text.trim()) {
      throw new ApiError(API_UNREACHABLE, res.status, null);
    }

    throw new ApiError(readDetail(payload) || `Request failed (${res.status})`, res.status, payload);
  }
  return payload;
}

function lobbyRequest(path, options = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12_000);
  return request(path, { ...options, signal: controller.signal })
    .catch((cause) => {
      if (cause?.name === 'AbortError') {
        throw new ApiError('The lobby server took too long to respond. Check your connection and try again.', 0, null);
      }
      throw cause;
    })
    .finally(() => window.clearTimeout(timer));
}

const live = {
  mode: 'live',

  auth: {
    me: () => request('/auth/me'),
    signup: async (payload) => {
      // Sent WITH the current token on purpose: if the caller is a guest, the
      // API moves their library onto the new account. The route itself stays
      // unauthenticated, so a missing token is fine.
      const r = await request('/auth/signup', { method: 'POST', body: payload, auth: true });
      tokenStore.set(r.token);
      return r.user;
    },
    login: async (payload) => {
      const r = await request('/auth/login', { method: 'POST', body: payload, auth: false });
      tokenStore.set(r.token);
      return r.user;
    },
    guest: async () => {
      const r = await request('/auth/guest', { method: 'POST', auth: false });
      tokenStore.set(r.token);
      return r.user;
    },
    /**
     * The Google ID token is passed straight through — it is verified on the
     * server against Google's keys, never here. Sent with the current token so
     * a guest signing in with Google keeps the work they already did.
     */
    google: async (credential) => {
      const r = await request('/auth/google', { method: 'POST', body: { credential }, auth: true });
      tokenStore.set(r.token);
      return r.user;
    },
    /** Face sign-in. See docs/FACE-AUTH-CONTRACT.md. */
    face: async (image) => {
      const r = await request('/auth/face', { method: 'POST', body: { image }, auth: false });
      tokenStore.set(r.token);
      return r.user;
    },
    enrolFace: (image) => request('/auth/face/enrol', { method: 'POST', body: { image } }),
    faceStatus: () => request('/auth/face/status'),
    removeFace: () => request('/auth/face', { method: 'DELETE' }),
    logout: async () => {
      tokenStore.set(null);
    },
  },

  materials: {
    list: () => request('/materials'),
    get: (id) => request(`/materials/${id}`),
    remove: (id) => request(`/materials/${id}`, { method: 'DELETE' }),
    rename: (id, title) => request(`/materials/${id}`, { method: 'PATCH', body: { title } }),
  },

  uploads: {
    create: (payload) => request('/uploads', { method: 'POST', body: payload }),
    /** Resolve backend-relative upload URLs against the deployed API origin. */
    put: async (uploadUrl, file) => {
      const apiOrigin = BASE.startsWith('http') ? new URL(BASE).origin : window.location.origin;
      const target = new URL(uploadUrl, apiOrigin).toString();
      const res = await fetch(target, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) throw new ApiError('Could not upload your file. Check your connection and try again.', res.status, null);
    },
  },

  jobs: {
    start: (payload) => request('/jobs', { method: 'POST', body: payload }),
    status: (jobId, signal) => request(`/jobs/${jobId}`, { signal }),
  },

  practice: {
    /** Generated on first ask and cached on the material; `refresh` regenerates. */
    get: (materialId, { refresh } = {}) =>
      request(`/materials/${materialId}/practice${refresh ? '?refresh=1' : ''}`),
    /** Whether this deployment has a coding model configured. */
    helpAvailable: () => request('/practice/help-available'),
    /** Why did this attempt fail? Never returns a corrected solution. */
    explain: (payload) => request('/practice/explain', { method: 'POST', body: payload }),
  },

  binders: {
    list: () => request('/binders'),
    get: (id) => request(`/binders/${id}`),
    create: (name) => request('/binders', { method: 'POST', body: { name } }),
    update: (id, patch) => request(`/binders/${id}`, { method: 'PATCH', body: patch }),
    remove: (id) => request(`/binders/${id}`, { method: 'DELETE' }),
    generate: (id, sourceIds) => request(`/binders/${id}/generate`, { method: 'POST', body: { sourceIds } }),
  },

  sources: {
    list: (binderId) => request(`/binders/${binderId}/sources`),
    /** Presigns one upload URL per accepted file; rejects non-PDF names up front, per file. */
    create: (binderId, files) => request(`/binders/${binderId}/sources`, { method: 'POST', body: { files } }),
    /** Adds a ready, owner-scoped pasted note without an upload round trip. */
    createText: (binderId, title, text) => request(`/binders/${binderId}/sources/text`, { method: 'POST', body: { title, text } }),
    /** Direct-to-S3 PUT — same shape as `uploads.put` for a single Material. */
    put: async (uploadUrl, file) => {
      const apiOrigin = BASE.startsWith('http') ? new URL(BASE).origin : window.location.origin;
      const target = new URL(uploadUrl, apiOrigin).toString();
      const res = await fetch(target, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: file,
      });
      if (!res.ok) throw new ApiError('Could not upload your file. Check your connection and try again.', res.status, null);
    },
    commit: (binderId, sourceId) => request(`/binders/${binderId}/sources/${sourceId}/commit`, { method: 'POST' }),
    retry: (binderId, sourceId) => request(`/binders/${binderId}/sources/${sourceId}/retry`, { method: 'POST' }),
    rename: (sourceId, displayName) => request(`/sources/${sourceId}`, { method: 'PATCH', body: { displayName } }),
    remove: (sourceId) => request(`/sources/${sourceId}`, { method: 'DELETE' }),
    status: (sourceId, signal) => request(`/sources/${sourceId}/status`, { signal }),
    /** A short-lived link to the source's original PDF, for a citation chip's "open this page" action. */
    download: (sourceId) => request(`/sources/${sourceId}/download`),
  },

  quiz: {
    list: () => request('/quizzes'),
    get: (quizId) => request(`/quizzes/${encodeURIComponent(quizId)}`),
    generate: (materialId, payload) => request(`/materials/${materialId}/quiz`, { method: 'POST', body: payload }),
    save: (materialId, payload) => request(`/materials/${materialId}/quiz`, { method: 'PUT', body: payload }),
    submit: (payload) => request('/quiz/attempts', { method: 'POST', body: payload }),
    attempts: (materialId) => request(`/quiz/attempts${materialId ? `?materialId=${materialId}` : ''}`),
  },

  social: {
    search: (query) => request(`/social/users?q=${encodeURIComponent(query)}`),
    friends: () => request('/friends'),
    requests: () => request('/friends/requests'),
    requestFriend: (userId) => request('/friends/requests', { method: 'POST', body: { userId } }),
    acceptRequest: (requestId) => request(`/friends/requests/${requestId}/accept`, { method: 'POST' }),
    removeRequest: (requestId) => request(`/friends/requests/${requestId}`, { method: 'DELETE' }),
    removeFriend: (friendId) => request(`/friends/${friendId}`, { method: 'DELETE' }),
    conversations: () => request('/conversations'),
    createConversation: (payload) => request('/conversations', { method: 'POST', body: payload }),
    conversation: (id) => request(`/conversations/${id}`),
    messages: (id) => request(`/conversations/${id}/messages`),
    sendMessage: (id, text) => request(`/conversations/${id}/messages`, { method: 'POST', body: { text } }),
    plan: (id) => request(`/conversations/${id}/plan`),
    savePlan: (id, payload) => request(`/conversations/${id}/plan`, { method: 'PUT', body: payload }),
    createInvite: (id, payload = {}) => request(`/conversations/${id}/invites`, { method: 'POST', body: payload }),
    redeemInvite: (invite) => request('/conversation-invites/redeem', { method: 'POST', body: { invite } }),
    sessions: (conversationId) => request(`/conversations/${conversationId}/study-sessions`),
    startTimer: (conversationId, title) => request(`/conversations/${conversationId}/study-sessions/start`, { method: 'POST', body: { title } }),
    pauseTimer: (conversationId, sessionId) => request(`/conversations/${conversationId}/study-sessions/${sessionId}/pause`, { method: 'POST' }),
    resumeTimer: (conversationId, sessionId) => request(`/conversations/${conversationId}/study-sessions/${sessionId}/resume`, { method: 'POST' }),
    stopTimer: (conversationId, sessionId) => request(`/conversations/${conversationId}/study-sessions/${sessionId}/stop`, { method: 'POST' }),
    analytics: (conversationId) => request(`/conversations/${conversationId}/study-sessions/stats`),
  },

  lobbies: {
    list: () => lobbyRequest('/lobbies', { auth: false }),
    get: (id) => lobbyRequest(`/lobbies/${id}`, { auth: false }),
    quiz: (id, playerId, reconnectToken) => lobbyRequest(`/lobbies/${id}/quiz?playerId=${encodeURIComponent(playerId)}&token=${encodeURIComponent(reconnectToken)}`, { auth: false }),
    create: (payload) => lobbyRequest('/lobbies', { method: 'POST', body: payload }),
    join: (id, payload) => lobbyRequest(`/lobbies/${id}/join`, { method: 'POST', body: payload, auth: false }),
    ready: (id, payload) => lobbyRequest(`/lobbies/${id}/ready`, { method: 'POST', body: payload, auth: false }),
    start: (id, payload) => lobbyRequest(`/lobbies/${id}/start`, { method: 'POST', body: payload, auth: false }),
    answer: (id, payload) => lobbyRequest(`/lobbies/${id}/answer`, { method: 'POST', body: payload, auth: false }),
    score: (id, payload) => lobbyRequest(`/lobbies/${id}/score`, { method: 'POST', body: payload, auth: false }),
  },

  forum: {
    list: () => request('/forum/posts'),
    create: (payload) => request('/forum/posts', { method: 'POST', body: payload }),
    like: (id) => request(`/forum/posts/${id}/like`, { method: 'POST' }),
    comment: (id, payload) => request(`/forum/posts/${id}/comments`, { method: 'POST', body: payload }),
  },

  illustrations: {
    create: (materialId, payload = { count: 2 }) => request(`/materials/${materialId}/illustrations`, { method: 'POST', body: payload }),
    createFromChat: (materialId, answerId) => request(`/materials/${materialId}/chat-illustrations`, { method: 'POST', body: { answerId } }),
  },

  flashcards: {
    get: (materialId) => request(`/materials/${materialId}/flashcards`),
    save: (materialId, cards) => request(`/materials/${materialId}/flashcards`, { method: 'PUT', body: { cards } }),
  },

  share: {
    create: (materialId) => request(`/materials/${materialId}/share`, { method: 'POST' }),
    get: (token) => request(`/shared/${token}`, { auth: false }),
  },

  /** `deep` additionally probes each AWS service the backend depends on. */
  health: ({ deep } = {}) => request(`/health${deep ? '?deep=1' : ''}`, { auth: false }),
  ask: (payload) => request('/ask', { method: 'POST', body: payload }),
  tts: (payload) => request('/tts', { method: 'POST', body: payload }),
};

export const api = USE_MOCK ? mockApi : live;

export function apiAssetUrl(path) {
  if (!path) return '';
  if (/^https:\/\//i.test(path) || /^data:/i.test(path)) return path;
  if (path.startsWith('/api/')) return `${BASE}${path.slice(4)}`;
  return new URL(path, window.location.origin).toString();
}

export function openLobbySocket(lobbyId, playerId, reconnectToken) {
  const apiUrl = BASE.startsWith('http') ? new URL(BASE, window.location.href) : null;
  const protocol = (apiUrl?.protocol ?? window.location.protocol) === 'https:' ? 'wss:' : 'ws:';
  const host = apiUrl?.host ?? window.location.host;
  const params = new URLSearchParams({ player_id: playerId, token: reconnectToken });
  return new WebSocket(`${protocol}//${host}/ws/lobbies/${encodeURIComponent(lobbyId)}?${params}`);
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('Polling cancelled', 'AbortError'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Polls a recap or quiz job until it finishes, even while routes change. */
export async function pollJob(jobId, onTick, { intervalMs = 900, timeoutMs = 1_200_000, signal } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const job = await api.jobs.status(jobId, signal);
    onTick?.(job);
    if (job.stage === 'done' || job.status === 'ready') return job;
    if (job.status === 'failed') throw new ApiError(job.error || 'Processing failed', 500, job);
    if (Date.now() - startedAt > timeoutMs) throw new ApiError('Processing timed out', 504, job);
    await abortableDelay(intervalMs, signal);
  }
}

/**
 * Polls one source's extraction status every `intervalMs` until it settles
 * (`ready` or `failed`). Used from the binder detail page, one interval per
 * pending/processing source — see `useSourcePolling` in `BinderDetail.jsx` for
 * why this is deliberately a single poll rather than a loop: the page needs to
 * start and stop polling per-source as sources individually settle, not wait
 * for all of them at once.
 */
export async function pollSourceOnce(sourceId, signal) {
  return api.sources.status(sourceId, signal);
}

/**
 * Opens a source's original PDF at a given page, in a new tab.
 *
 * `#page=N` is a PDF open-parameter every major browser's built-in viewer
 * honours (Chrome, Firefox, Safari and Edge all jump straight to that page),
 * so a presigned download link plus this fragment is enough to land a
 * citation chip on the right page with no PDF-rendering code on either side.
 */
export async function openSourcePage(sourceId, page) {
  const { url } = await api.sources.download(sourceId);
  const win = window.open(`${url}#page=${Math.max(1, Number(page) || 1)}`, '_blank', 'noopener,noreferrer');
  if (!win) throw new ApiError('Your browser blocked opening that page. Allow pop-ups for this site and try again.', 0, null);
}
