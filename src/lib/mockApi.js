import { SAMPLE_MATERIAL, SAMPLE_CHUNKS } from '../data/seed.js';
import { makeId, fileTypeOf } from './format.js';

/**
 * Demo backend.
 *
 * Runs whenever `VITE_API_BASE_URL` is unset, so `npm run dev` gives a working
 * app on a laptop with no AWS session. It mirrors the real API surface exactly
 * — same method names, same shapes, same job-polling contract — so swapping to
 * the deployed backend is one environment variable and no component changes.
 *
 * It does NOT generate recaps. There is no model here. An upload in demo mode
 * produces a material carrying the sample recap, flagged `demo: true`, and the
 * UI shows a standing banner saying so. Presenting fabricated summaries as real
 * model output would make the one screen that has to be trustworthy — the
 * grounded recap — a lie.
 */

const KEY = 'smartrecap.demo.v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* fall through to a fresh store */
  }
  return { user: null, materials: [SAMPLE_MATERIAL], attempts: [], flashcards: {}, shares: {} };
}

function write(db) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* quota or private mode — demo data stays in memory for this session */
  }
  return db;
}

let db = read();
const jobs = new Map();

const persist = () => write(db);

/** Mirrors `backend/src/handlers/process.js` so the UI shows the real pipeline. */
export const PIPELINE_STAGES = [
  { id: 'upload', label: 'Uploading your file', detail: 'Stored privately — only you can open it', ms: 900 },
  { id: 'extract', label: 'Reading the text', detail: 'Keeping track of which slide each part came from', ms: 1600 },
  { id: 'chunk', label: 'Sorting it by slide', detail: 'So every point can link back to where it came from', ms: 700 },
  { id: 'recap', label: 'Writing your recap', detail: 'Every point has to name the slide it came from', ms: 4200 },
  { id: 'quiz', label: 'Writing your quiz', detail: 'Every answer traced back to your material', ms: 3200 },
  { id: 'ground', label: 'Checking every claim', detail: 'Anything that cannot be traced is dropped', ms: 1400 },
  { id: 'store', label: 'Saving to your library', detail: 'Recap, quiz and sources', ms: 600 },
];

async function runJob(jobId, material) {
  const job = jobs.get(jobId);
  const total = PIPELINE_STAGES.reduce((n, s) => n + s.ms, 0);
  let elapsed = 0;

  for (const stage of PIPELINE_STAGES) {
    job.stage = stage.id;
    job.stageLabel = stage.label;
    job.log.push({ at: Date.now(), stage: stage.id, message: stage.label, detail: stage.detail });

    const steps = Math.max(4, Math.round(stage.ms / 220));
    for (let i = 0; i < steps; i += 1) {
      await sleep(stage.ms / steps);
      elapsed += stage.ms / steps;
      job.progress = Math.min(99, Math.round((elapsed / total) * 100));
    }
  }

  job.progress = 100;
  job.stage = 'done';
  job.status = 'ready';
  material.status = 'ready';
  persist();
}

const clone = (v) => JSON.parse(JSON.stringify(v));

export const mockApi = {
  mode: 'demo',

  auth: {
    async me() {
      await sleep(120);
      return db.user;
    },
    async signup({ email, name }) {
      await sleep(600);
      db.user = { id: makeId('u'), email, name: name || email.split('@')[0], guest: false, createdAt: new Date().toISOString() };
      persist();
      return db.user;
    },
    async login({ email }) {
      await sleep(600);
      db.user = { id: makeId('u'), email, name: email.split('@')[0], guest: false, createdAt: new Date().toISOString() };
      persist();
      return db.user;
    },
    async guest() {
      await sleep(200);
      db.user = { id: makeId('g'), email: null, name: 'Guest', guest: true, createdAt: new Date().toISOString() };
      persist();
      return db.user;
    },
    async logout() {
      db.user = null;
      persist();
    },
  },

  materials: {
    async list() {
      await sleep(200);
      return clone(db.materials);
    },
    async get(id) {
      await sleep(160);
      const found = db.materials.find((m) => m.id === id);
      if (!found) throw Object.assign(new Error('Material not found'), { status: 404 });
      return clone(found);
    },
    async remove(id) {
      db.materials = db.materials.filter((m) => m.id !== id);
      persist();
    },
    async rename(id, title) {
      const m = db.materials.find((x) => x.id === id);
      if (m) m.title = title;
      persist();
      return clone(m);
    },
  },

  uploads: {
    /** The real backend returns a presigned S3 URL here; demo mode skips the PUT. */
    async create({ fileName }) {
      await sleep(300);
      return { materialId: makeId('m'), uploadUrl: null, fileName };
    },
    async put() {
      await sleep(400);
    },
  },

  jobs: {
    async start({ materialId, fileName, mode, module: moduleName }) {
      const material = {
        id: materialId,
        demo: true,
        title: fileName.replace(/\.[^.]+$/, ''),
        fileName,
        fileType: fileTypeOf(fileName),
        sizeBytes: 0,
        module: moduleName || 'Unfiled',
        mode,
        status: 'processing',
        pageCount: SAMPLE_CHUNKS.length * 2,
        createdAt: new Date().toISOString(),
        chunks: clone(SAMPLE_CHUNKS),
        recap: clone(SAMPLE_MATERIAL.recap),
        quiz: clone(SAMPLE_MATERIAL.quiz),
        provider: { name: 'Demo mode', model: 'no model called', latencyMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
      };
      db.materials = [material, ...db.materials];
      persist();

      const jobId = makeId('job');
      jobs.set(jobId, { id: jobId, materialId, status: 'running', stage: 'upload', stageLabel: '', progress: 0, log: [] });
      runJob(jobId, material);
      return { jobId, materialId };
    },

    async status(jobId) {
      await sleep(120);
      const job = jobs.get(jobId);
      if (!job) throw Object.assign(new Error('Job not found'), { status: 404 });
      return clone(job);
    },
  },

  quiz: {
    async submit({ materialId, answers, durationMs }) {
      await sleep(400);
      const material = db.materials.find((m) => m.id === materialId);
      const questions = material?.quiz?.questions ?? [];
      const scored = questions.filter((q) => q.verified);
      const correct = scored.filter((q) => answers[q.id] === q.answer).length;
      const attempt = {
        id: makeId('a'),
        materialId,
        at: new Date().toISOString(),
        durationMs,
        correct,
        total: scored.length,
        score: scored.length ? Math.round((correct / scored.length) * 100) : 0,
        byTopic: Object.entries(
          scored.reduce((acc, q) => {
            acc[q.topic] ??= { correct: 0, total: 0 };
            acc[q.topic].total += 1;
            if (answers[q.id] === q.answer) acc[q.topic].correct += 1;
            return acc;
          }, {}),
        ).map(([topic, v]) => ({ topic, ...v })),
        answers,
      };
      db.attempts = [attempt, ...db.attempts];
      persist();
      return attempt;
    },
    async attempts(materialId) {
      await sleep(140);
      return clone(materialId ? db.attempts.filter((a) => a.materialId === materialId) : db.attempts);
    },
  },

  flashcards: {
    async get(materialId) {
      await sleep(120);
      return clone(db.flashcards[materialId] ?? null);
    },
    async save(materialId, cards) {
      db.flashcards[materialId] = cards;
      persist();
      return clone(cards);
    },
  },

  share: {
    async create(materialId) {
      await sleep(300);
      const token = makeId('s');
      db.shares[token] = materialId;
      persist();
      return { token, url: `${location.origin}/s/${token}` };
    },
    async get(token) {
      await sleep(200);
      const id = db.shares[token];
      const material = db.materials.find((m) => m.id === id);
      if (!material) throw Object.assign(new Error('Shared recap not found'), { status: 404 });
      return clone(material);
    },
  },

  /** Grounded Q&A. Demo mode does keyword retrieval only — no model is called. */
  async ask({ materialId, question }) {
    await sleep(900);
    const material = db.materials.find((m) => m.id === materialId);
    const words = question.toLowerCase().match(/[a-z]{4,}/g) ?? [];
    const ranked = (material?.chunks ?? [])
      .map((c) => ({ chunk: c, hits: words.filter((w) => c.text.toLowerCase().includes(w)).length }))
      .filter((r) => r.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 3);

    if (!ranked.length) {
      return {
        answer: 'Nothing in this material covers that. Demo mode retrieves passages by keyword only — connect a backend for a model-written answer.',
        citations: [],
        grounded: false,
      };
    }
    return {
      answer: ranked.map((r) => r.chunk.text).join('\n\n'),
      citations: ranked.map((r) => r.chunk.id),
      grounded: true,
      demo: true,
    };
  },

  async tts() {
    throw Object.assign(new Error('Read-aloud is not available in demo mode.'), { status: 501 });
  },

  /** Test hook — lets Settings reset the demo store. */
  async _reset() {
    db = { user: db.user, materials: [SAMPLE_MATERIAL], attempts: [], flashcards: {}, shares: {} };
    persist();
  },
};
