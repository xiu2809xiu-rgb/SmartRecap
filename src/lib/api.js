import { mockApi, PIPELINE_STAGES } from './mockApi.js';

/**
 * API client.
 *
 * With `VITE_API_BASE_URL` set, every call goes to the deployed API Gateway
 * stage. Without it, the identical surface is served by `mockApi` so the app
 * runs with no AWS session at all. Components import `api` and never branch on
 * which one is behind it.
 */

const BASE = import.meta.env?.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '';
export const isDemo = !BASE;
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
    throw new ApiError('Could not reach the SmartRecap API. Check your connection and try again.', 0, null);
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
    throw new ApiError(payload?.message || `Request failed (${res.status})`, res.status, payload);
  }
  return payload;
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
    /** Direct-to-S3 PUT — the file never passes through Lambda. */
    put: async (uploadUrl, file) => {
      const res = await fetch(uploadUrl, {
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

  quiz: {
    submit: (payload) => request('/quiz/attempts', { method: 'POST', body: payload }),
    attempts: (materialId) => request(`/quiz/attempts${materialId ? `?materialId=${materialId}` : ''}`),
  },

  flashcards: {
    get: (materialId) => request(`/materials/${materialId}/flashcards`),
    save: (materialId, cards) => request(`/materials/${materialId}/flashcards`, { method: 'PUT', body: { cards } }),
  },

  share: {
    create: (materialId) => request(`/materials/${materialId}/share`, { method: 'POST' }),
    get: (token) => request(`/shared/${token}`, { auth: false }),
  },

  ask: (payload) => request('/ask', { method: 'POST', body: payload }),
  tts: (payload) => request('/tts', { method: 'POST', body: payload }),
};

export const api = isDemo ? mockApi : live;

/**
 * Polls a job until it finishes. `onTick` fires on every poll so the pipeline
 * view can stream stage changes rather than jumping from 0 to 100.
 */
export async function pollJob(jobId, onTick, { intervalMs = 700, timeoutMs = 180_000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const job = await api.jobs.status(jobId);
    onTick?.(job);
    if (job.stage === 'done' || job.status === 'ready') return job;
    if (job.status === 'failed') throw new ApiError(job.error || 'Processing failed', 500, job);
    if (Date.now() - startedAt > timeoutMs) throw new ApiError('Processing timed out', 504, job);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
