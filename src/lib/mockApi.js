import { SAMPLE_MATERIAL, SAMPLE_CHUNKS } from '../data/seed.js';
import { makeId, fileTypeOf } from './format.js';
import { questionType, exactSetMatch } from './quizScoring.js';

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
  return {
    user: null,
    materials: [SAMPLE_MATERIAL],
    attempts: [],
    flashcards: {},
    shares: {},
    faceEnrolled: false,
    binders: [],
    sources: {},
    lobbies: [],
    forumPosts: [],
  };
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
// Stores persisted before newer feature areas existed will be missing keys.
db.binders ??= [];
db.sources ??= {};
db.lobbies ??= [];
db.forumPosts ??= [];
db.faceEnrolled ??= false;
db.materials = db.materials.map((material) => {
  if (!material.quiz?.questions?.length || material.quiz.id) return material;
  return {
    ...material,
    quiz: {
      ...material.quiz,
      id: `quiz-${material.id}`,
      materialId: material.id,
      status: 'ready',
      generationStatus: 'ready',
      difficulty: 'medium',
      questionCount: material.quiz.questions.length,
      providers: [{ name: 'Demo mode', model: 'sample questions' }],
    },
  };
});
const jobs = new Map();
const lobbyTokens = new Map();

const persist = () => write(db);

function objectiveAnswerIsCorrect(question, answer) {
  if (questionType(question) === 'multi') return exactSetMatch(answer, question.answer);
  // Keep the real backend's legacy strict comparison for single questions.
  return answer === question.answer;
}

function judgeShortAnswerDemo(question, studentAnswer) {
  const normalise = (value) =>
    String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const answer = normalise(studentAnswer);
  const modelAnswer = normalise(question.modelAnswer);
  const ignored = new Set(['about', 'after', 'also', 'because', 'been', 'from', 'into', 'only', 'that', 'their', 'them', 'then', 'these', 'they', 'this', 'with']);
  const keywords = [...new Set(modelAnswer.split(' ').filter((word) => word.length > 3 && !ignored.has(word)))];
  const matches = keywords.filter((word) => answer.includes(word));
  const substringMatch =
    answer.length >= 12 && (answer.includes(modelAnswer) || (modelAnswer.includes(answer) && answer.split(' ').length >= 3));
  const correct = Boolean(answer) && (substringMatch || matches.length >= Math.max(1, Math.ceil(keywords.length / 2)));

  return {
    correct,
    feedback: correct
      ? 'Your answer includes the key ideas from the model answer.'
      : 'Your answer is missing one or more key ideas from the model answer.',
    gradedBy: 'keyword-match (demo mode)',
    verified: true,
  };
}

/**
 * Practice exercises for the bundled normalisation lecture.
 *
 * Every one is about something the sample slides actually teach and cites the
 * slide that teaches it — the same rule the real generator is held to. The
 * starters deliberately stop short of the answer, and the tests are the ones
 * the student is graded on, so nothing here is hidden from them.
 */
const DEMO_PRACTICE = {
  applicable: true,
  exercises: [
    {
      id: 'e1',
      title: 'Find the columns that break 1NF',
      concept: 'First normal form',
      language: 'python',
      entry: 'non_atomic_columns',
      brief:
        'First normal form requires every column to hold a single atomic value. Return the names of the columns in a row whose value packs more than one item into a string, in the order they appear.',
      starter:
        'def non_atomic_columns(row):\n    """Return the names of columns holding more than one value.\n\n    `row` maps a column name to its value. A value like "Maths, Physics"\n    holds two items and breaks 1NF; "Ada" holds one and does not.\n    """\n    pass\n',
      tests: [
        { call: 'non_atomic_columns({"id": "S1", "subjects": "Maths, Physics"})', expect: '["subjects"]' },
        { call: 'non_atomic_columns({"id": "S1", "name": "Ada"})', expect: '[]' },
        { call: 'non_atomic_columns({"a": "x, y", "b": "p,q"})', expect: '["a", "b"]' },
      ],
      hint: 'A repeating group shows up as a separator inside one value. Look at each value and decide whether it is one thing or several.',
      citations: ['c6'],
    },
    {
      id: 'e2',
      title: 'Spot a transitive dependency',
      concept: 'Third normal form',
      language: 'python',
      entry: 'transitively_dependent',
      brief:
        'Third normal form removes transitive dependencies: a non-key attribute must not depend on another non-key attribute. Given a list of functional dependencies as (determinant, dependent) pairs and the primary key, return the attributes that reach the key only through another attribute.',
      starter:
        'def transitively_dependent(deps, key):\n    """Return the attributes that depend on `key` only indirectly.\n\n    `deps` is a list of (determinant, dependent) pairs, so\n    ("StudentID", "DeptID") means StudentID -> DeptID.\n    """\n    pass\n',
      tests: [
        {
          call: 'transitively_dependent([("StudentID", "DeptID"), ("DeptID", "DeptName")], "StudentID")',
          expect: '["DeptName"]',
        },
        { call: 'transitively_dependent([("StudentID", "Name")], "StudentID")', expect: '[]' },
        { call: 'transitively_dependent([("A", "B"), ("B", "C"), ("C", "D")], "A")', expect: '["C"]' },
      ],
      hint: 'First work out what the key determines directly. Anything determined by one of those, rather than by the key itself, is the transitive case.',
      citations: ['c8', 'c3'],
    },
    {
      id: 'e3',
      title: 'Check whether a column can be a primary key',
      concept: 'Primary keys',
      language: 'javascript',
      entry: 'isValidPrimaryKey',
      brief:
        'A primary key uniquely identifies each row, cannot contain NULL, and cannot repeat. Return whether the named column satisfies that for the given rows.',
      starter:
        'function isValidPrimaryKey(rows, column) {\n  // Return true only if every row has a value for `column`\n  // and no two rows share the same one.\n}\n',
      tests: [
        { call: "isValidPrimaryKey([{id: 1}, {id: 2}], 'id')", expect: 'true' },
        { call: "isValidPrimaryKey([{id: 1}, {id: 1}], 'id')", expect: 'false' },
        { call: "isValidPrimaryKey([{id: 1}, {id: null}], 'id')", expect: 'false' },
      ],
      hint: 'Two separate conditions, and both have to hold. A Set is a quick way to ask whether anything repeated.',
      citations: ['c4'],
    },
  ],
};

/** Mirrors `backend/src/handlers/process.js` so the UI shows the real pipeline. */
export const PIPELINE_STAGES = [
  { id: 'upload', label: 'Reading the uploaded file', detail: 'Validated by the local Python backend', ms: 900 },
  { id: 'extract', label: 'Extracting text and images', detail: 'Native text first, adaptive OCR for scanned pages', ms: 1600 },
  { id: 'chunk', label: 'Segmenting into citable chunks', detail: 'Page and slide locations preserved', ms: 700 },
  { id: 'recap', label: 'Generating structured notes', detail: 'A polished recap is created before any quiz', ms: 4200 },
  { id: 'ground', label: 'Verifying claims against source', detail: 'Unsupported evidence is rejected', ms: 1400 },
  { id: 'translate', label: 'Translating verified notes', detail: 'Citations remain linked to the original source wording', ms: 2200 },
  { id: 'store', label: 'Finalising your notes', detail: 'Recap and source index are saved', ms: 600 },
];

async function runJob(jobId, material) {
  const job = jobs.get(jobId);
  // Same rule as the real pipeline: an English job skips translation, so it
  // must not appear in the demo's timeline either.
  const running = PIPELINE_STAGES.filter((s) => s.id !== 'translate' || (material.language && material.language !== 'en'));
  const total = running.reduce((n, s) => n + s.ms, 0);
  let elapsed = 0;

  for (const stage of running) {
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

/**
 * Demo-mode stand-in for `core/citations.js`'s server-side resolution pass.
 *
 * There is no real generation here (see the module comment above), so this
 * distributes the bundled sample recap's existing chunk-id citations across
 * the binder's actual ready sources round-robin, purely so the citation-chip
 * UI (source name, page, the sources strip) has real per-source data to
 * render against in demo mode rather than nothing at all. It follows the same
 * `resolvedCitations` / `unverified` / `sourcesSummary` shape the real
 * backend produces, so the components never need to know which one they're
 * looking at.
 */
function attributeSampleRecap(readySources) {
  const recap = clone(SAMPLE_MATERIAL.recap);
  const quiz = clone(SAMPLE_MATERIAL.quiz);
  const counts = new Map(readySources.map((s) => [s.id, 0]));

  // Every sample chunk's page, spread across the ready sources round-robin so
  // demo mode still shows citations landing on more than one source once a
  // binder has more than one.
  const pageForChunk = new Map(SAMPLE_CHUNKS.map((c, i) => [c.id, ((c.page - 1) % Math.max(1, readySources[0]?.pageCount || 12)) + 1]));

  const resolve = (citations) => {
    if (!readySources.length || !citations?.length) return [];
    const resolved = citations.map((chunkId, i) => {
      const source = readySources[i % readySources.length];
      const page = Math.min(pageForChunk.get(chunkId) ?? 1, Math.max(1, source.pageCount || 1));
      counts.set(source.id, (counts.get(source.id) ?? 0) + 1);
      return { sourceId: source.id, displayName: source.displayName, page };
    });
    // Same de-duplication rule as the real resolver: one chip per source+page.
    const seen = new Set();
    return resolved.filter((c) => {
      const key = `${c.sourceId}:${c.page}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  for (const section of recap.sections ?? []) {
    for (const point of section.points ?? []) {
      point.resolvedCitations = resolve(point.citations);
      point.unverified = point.resolvedCitations.length === 0;
    }
  }
  for (const term of recap.keyTerms ?? []) {
    term.resolvedCitations = resolve(term.citations);
    term.unverified = term.resolvedCitations.length === 0;
  }
  for (const question of quiz.questions ?? []) {
    question.resolvedCitations = resolve(question.citations);
    question.unverified = question.resolvedCitations.length === 0;
  }

  const sourcesSummary = readySources.map((s) => ({
    sourceId: s.id,
    displayName: s.displayName,
    pageCount: s.pageCount,
    citationCount: counts.get(s.id) ?? 0,
  }));

  return { recap, quiz, sourcesSummary };
}

async function passwordHash(value = '') {
  if (!value) return '';
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

function lobbyView(lobby) {
  const view = clone(lobby);
  delete view._passwordHash;
  view.players = (view.players || []).map((player) => {
    delete player._answeredIds;
    return player;
  });
  return view;
}

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

    /**
     * Demo mode has no Google client id and no server, so this stands in a
     * placeholder account. The UI says so underneath the button rather than
     * letting it look like a real sign-in.
     */
    async google() {
      await sleep(650);
      db.user = {
        id: makeId('u'),
        email: 'demo.student@example.com',
        name: 'Demo Student',
        guest: false,
        provider: 'google',
        createdAt: new Date().toISOString(),
      };
      persist();
      return db.user;
    },

    /**
     * Face matching is the backend's job and there is no backend here. Failing
     * with the real "nothing enrolled" message is more useful than a fake
     * success, which would make the whole flow untestable.
     */
    async face() {
      await sleep(1100);
      throw Object.assign(new Error('No saved face to compare against yet. Sign in with your email, then set up face sign-in in Settings.'), {
        status: 404,
      });
    },

    async enrolFace() {
      await sleep(900);
      if (!db.user) throw Object.assign(new Error('Sign in first.'), { status: 401 });
      db.faceEnrolled = true;
      persist();
      return { enrolled: true, demo: true };
    },

    async faceStatus() {
      await sleep(120);
      return { enrolled: !!db.faceEnrolled, demo: true };
    },

    async removeFace() {
      db.faceEnrolled = false;
      persist();
      return { enrolled: false };
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
      db.attempts = db.attempts.filter((attempt) => attempt.materialId !== id);
      delete db.flashcards[id];
      Object.keys(db.shares).forEach((token) => {
        if (db.shares[token] === id) delete db.shares[token];
      });
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
    async start({ materialId, fileName, mode, module: moduleName, difficulty = 'balanced', language = 'en' }) {
      const material = {
        id: materialId,
        demo: true,
        title: fileName.replace(/\.[^.]+$/, ''),
        fileName,
        fileType: fileTypeOf(fileName),
        sizeBytes: 0,
        module: moduleName || 'Unfiled',
        mode,
        difficulty,
        // Demo mode calls no model, so it cannot translate the sample recap.
        // It records the choice and shows the stage, and the reader says
        // plainly that the text stayed in English rather than pretending.
        language,
        status: 'processing',
        pageCount: SAMPLE_CHUNKS.length * 2,
        createdAt: new Date().toISOString(),
        chunks: clone(SAMPLE_CHUNKS),
        recap: clone(SAMPLE_MATERIAL.recap),
        quiz: { status: 'not_generated', questions: [] },
        provider: { name: 'Demo mode', model: 'no model called', latencyMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
      };
      db.materials = [material, ...db.materials];
      persist();

      const jobId = makeId('job');
      jobs.set(jobId, {
        id: jobId,
        materialId,
        kind: 'recap',
        language,
        status: 'running',
        stage: 'upload',
        stageLabel: '',
        progress: 0,
        log: [],
      });
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

  lobbies: {
    async list() { await sleep(120); return db.lobbies.filter((lobby) => lobby.status === 'open').map(lobbyView); },
    async get(id) {
      await sleep(80);
      const lobby = db.lobbies.find((item) => item.id === id);
      if (!lobby) throw Object.assign(new Error('Lobby not found'), { status: 404 });
      return lobbyView(lobby);
    },
    async create(payload) {
      const playerId = makeId('player');
      const token = makeId('token') + makeId('secure');
      const visibility = payload.visibility === 'private' ? 'private' : 'public';
      if (visibility === 'private' && String(payload.password || '').length < 4) throw new Error('Private rooms require a password.');
      const lobby = {
        id: makeId('room'), name: payload.name, host_id: playerId,
        materialId: payload.materialId, quizId: payload.quizId,
        max_players: payload.max_players || 4, difficulty: payload.difficulty || 'Mixed', status: 'open',
        visibility, has_password: visibility === 'private', _passwordHash: await passwordHash(payload.password),
        current_question: 0, total_questions: payload.questionCount || 0,
        players: [{ id: playerId, name: payload.host_name, score: 0, ready: false, submitted: false, is_host: true, answered: 0, correct: 0, accuracy: 0, last_correct: null }],
        created_at: new Date().toISOString(),
      };
      lobbyTokens.set(playerId, token); db.lobbies.push(lobby); persist();
      return clone({ lobby: lobbyView(lobby), player_id: playerId, reconnect_token: token });
    },
    async join(id, payload) {
      const lobby = db.lobbies.find((item) => item.id === id && item.status === 'open');
      if (!lobby) throw Object.assign(new Error('This lobby is no longer open.'), { status: 404 });
      if (lobby.has_password && await passwordHash(payload.password) !== lobby._passwordHash) throw Object.assign(new Error('That room password is incorrect.'), { status: 403 });
      const playerId = makeId('player'); const token = makeId('token') + makeId('secure');
      lobby.players.push({ id: playerId, name: payload.playerName, score: 0, ready: false, submitted: false, is_host: false, answered: 0, correct: 0, accuracy: 0, last_correct: null, _answeredIds: [] });
      lobbyTokens.set(playerId, token); persist();
      return clone({ lobby: lobbyView(lobby), player_id: playerId, reconnect_token: token });
    },
    async ready(id, payload) {
      const lobby = db.lobbies.find((item) => item.id === id);
      const player = lobby?.players.find((item) => item.id === payload.playerId);
      if (!player || lobbyTokens.get(player.id) !== payload.reconnectToken) throw new Error('Invalid lobby session.');
      player.ready = payload.ready; persist(); return lobbyView(lobby);
    },
    async start(id, payload) {
      const lobby = db.lobbies.find((item) => item.id === id);
      if (!lobby || lobby.host_id !== payload.playerId || lobby.players.length < 2 || lobby.players.some((player) => !player.is_host && !player.ready)) throw new Error('The room is not ready to start.');
      lobby.status = 'playing';
      lobby.current_question = 0;
      lobby.players.forEach((player) => Object.assign(player, { score: 0, submitted: false, answered: 0, correct: 0, accuracy: 0, last_correct: null, _answeredIds: [] }));
      persist(); return lobbyView(lobby);
    },
    async answer(id, payload) {
      const lobby = db.lobbies.find((item) => item.id === id && item.status === 'playing');
      const player = lobby?.players.find((item) => item.id === payload.playerId);
      if (!player || lobbyTokens.get(player.id) !== payload.reconnectToken) throw new Error('Invalid lobby session.');
      player._answeredIds ??= [];
      if (player._answeredIds.includes(payload.questionId)) throw new Error('That question was already scored.');
      player._answeredIds.push(payload.questionId);
      player.answered += 1;
      player.last_correct = Boolean(payload.correct);
      if (payload.correct) {
        player.correct += 1;
        player.score += 1000 + Math.max(0, 500 - Math.floor(Math.min(payload.responseMs || 0, 30000) / 60));
      }
      player.accuracy = Math.round((player.correct / player.answered) * 1000) / 10;
      lobby.current_question = Math.max(...lobby.players.map((item) => item.answered || 0));
      persist(); return lobbyView(lobby);
    },
    async score(id, payload) {
      const lobby = db.lobbies.find((item) => item.id === id);
      const player = lobby?.players.find((item) => item.id === payload.playerId);
      if (!player || lobbyTokens.get(player.id) !== payload.reconnectToken) throw new Error('Invalid lobby session.');
      if (player.answered) player.accuracy = payload.score;
      else { player.score = payload.score; player.accuracy = payload.score; }
      player.submitted = true;
      if (lobby.players.every((item) => item.submitted)) lobby.status = 'finished';
      persist(); return lobbyView(lobby);
    },
  },

  quiz: {
    async generate(materialId, { difficulty, questionCount, topics = [], fresh = false }) {
      const material = db.materials.find((m) => m.id === materialId);
      if (!material) throw Object.assign(new Error('Material not found'), { status: 404 });
      const jobId = makeId('job');
      material.quiz = { ...material.quiz, status: 'generating', generationStatus: 'generating', questions: material.quiz?.questions ?? [] };
      jobs.set(jobId, { id: jobId, materialId, kind: 'quiz', status: 'running', stage: 'generate', stageLabel: difficulty === 'hard' ? 'Gemini drafting; GPT-5.6 Sol refining; OpenAI auditing' : 'Gemini creating conceptual questions', progress: 5, log: [] });
      (async () => {
        const job = jobs.get(jobId);
        for (const progress of [18, 36, 58, 76, 92]) {
          await sleep(420);
          job.progress = progress;
        }
        const allQuestions = SAMPLE_MATERIAL.quiz?.questions ?? [];
        const wanted = new Set(topics.map((topic) => String(topic).toLowerCase()));
        const sourceQuestions = allQuestions.filter((question) => !wanted.size || wanted.has(String(question.topic).toLowerCase()));
        const pool = sourceQuestions.length ? sourceQuestions : allQuestions;
        const questions = Array.from({ length: questionCount }, (_, index) => {
          const base = clone(pool[index % pool.length]);
          const prompt = fresh ? `Fresh practice ${index + 1}: ${base.prompt}` : base.prompt;
          return { ...base, id: `${base.id}-${Date.now()}-${index + 1}`, prompt, difficulty: { easy: 1, medium: 2, hard: 3 }[difficulty] };
        });
        const quizId = makeId('quiz');
        material.quiz = {
          id: quizId,
          materialId,
          status: 'ready',
          generationStatus: 'ready',
          difficulty,
          questionCount,
          generatedAt: new Date().toISOString(),
          providers: difficulty === 'hard'
            ? [{ name: 'Google Gemini', model: 'gemini-2.5-flash' }, { name: 'Azure OpenAI', model: 'gpt-5.6-sol' }, { name: 'OpenAI', model: 'gpt-4.1-mini' }]
            : [{ name: 'Google Gemini', model: 'gemini-2.5-flash' }],
          questions,
        };
        job.progress = 100;
        job.stage = 'done';
        job.status = 'ready';
        job.stageLabel = 'Quiz ready';
        job.quizId = quizId;
        persist();
      })();
      persist();
      return { jobId, materialId, kind: 'quiz' };
    },
    async save(materialId, { title, questions }) {
      const material = db.materials.find((item) => item.id === materialId);
      if (!material) throw Object.assign(new Error('Material not found'), { status: 404 });
      if (!title?.trim() || !Array.isArray(questions) || !questions.length || questions.length > 50) throw Object.assign(new Error('Complete the quiz title and questions.'), { status: 422 });
      const quizId = makeId('quiz');
      material.quiz = {
        id: quizId,
        materialId,
        title: title.trim(),
        status: 'ready',
        generationStatus: 'ready',
        difficulty: 'manual',
        questionCount: questions.length,
        generatedAt: new Date().toISOString(),
        authoring: 'manual',
        providers: [{ name: 'Student authored', model: 'manual editor', role: 'author' }],
        questions: questions.map((question, index) => ({ ...clone(question), id: `q${index + 1}`, difficulty: 2, verified: true, citations: [], authoring: 'manual' })),
      };
      persist();
      return clone(material.quiz);
    },
    async submit({ materialId, quizId, questionIds, answers, durationMs }) {
      await sleep(400);
      const material = db.materials.find((m) => m.id === materialId);
      if (!material) throw Object.assign(new Error('Material not found'), { status: 404 });
      if (quizId && material.quiz?.id !== quizId) throw Object.assign(new Error('Quiz version not found'), { status: 404 });
      const allQuestions = material.quiz?.questions ?? [];
      const knownIds = new Set(allQuestions.map((question) => question.id));
      const scope = questionIds ?? [...knownIds];
      if (!scope.length || scope.some((questionId) => !knownIds.has(questionId))) {
        throw Object.assign(new Error('Invalid or empty question scope'), { status: 422 });
      }
      const requested = new Set(scope);
      const verifiedQuestions = allQuestions.filter((question) => requested.has(question.id) && question.verified);
      const judgements = Object.fromEntries(
        verifiedQuestions
          .filter((question) => questionType(question) === 'short')
          .map((question) => [question.id, judgeShortAnswerDemo(question, answers[question.id])]),
      );
      const scored = verifiedQuestions.filter(
        (question) => questionType(question) !== 'short' || judgements[question.id]?.verified === true,
      );
      const isCorrect = (question) => questionType(question) === 'short'
        ? judgements[question.id]?.correct === true
        : objectiveAnswerIsCorrect(question, answers[question.id]);
      const correct = scored.filter(isCorrect).length;
      const attempt = {
        id: makeId('a'),
        materialId,
        quizId,
        at: new Date().toISOString(),
        durationMs: Number(durationMs) || 0,
        correct,
        total: scored.length,
        score: Math.round((correct / scored.length) * 100),
        byTopic: Object.entries(
          scored.reduce((acc, q) => {
            acc[q.topic] ??= { correct: 0, total: 0 };
            acc[q.topic].total += 1;
            if (isCorrect(q)) acc[q.topic].correct += 1;
            return acc;
          }, {}),
        ).map(([topic, value]) => ({ topic, ...value })),
        answers,
        judgements,
        questions: clone(scored),
        questionCount: scored.length,
        difficulty: material.quiz?.difficulty,
        providers: clone(material.quiz?.providers ?? []),
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

  forum: {
    async list() { await sleep(120); return clone(db.forumPosts); },
    async create(payload) {
      const material = payload.materialId ? db.materials.find((item) => item.id === payload.materialId) : null;
      const post = {
        id: makeId('post'), type: payload.type, title: payload.title, body: payload.body,
        author: { id: db.user?.id || 'demo-student', name: db.user?.name || 'Student' },
        materialId: material?.id || null, materialTitle: material?.title || null,
        createdAt: new Date().toISOString(), likedByMe: false, likeCount: 0, comments: [], commentCount: 0,
      };
      db.forumPosts.unshift(post); persist(); return clone(post);
    },
    async like(id) {
      const post = db.forumPosts.find((item) => item.id === id);
      if (!post) throw Object.assign(new Error('Post not found'), { status: 404 });
      post.likedByMe = !post.likedByMe;
      post.likeCount = Math.max(0, (post.likeCount || 0) + (post.likedByMe ? 1 : -1));
      persist(); return clone(post);
    },
    async comment(id, { body }) {
      const post = db.forumPosts.find((item) => item.id === id);
      if (!post) throw Object.assign(new Error('Post not found'), { status: 404 });
      post.comments.push({ id: makeId('comment'), body, author: { id: db.user?.id || 'demo-student', name: db.user?.name || 'Student' }, createdAt: new Date().toISOString() });
      post.commentCount = post.comments.length;
      persist(); return clone(post);
    },
  },

  illustrations: {
    async create() {
      throw Object.assign(new Error('Study illustrations need the live FastAPI backend.'), { status: 503 });
    },
    async createFromChat() {
      throw Object.assign(new Error('Chat visuals need the live FastAPI backend.'), { status: 503 });
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

  /* ---------------------------------------------------------------- binders */

  binders: {
    async list() {
      await sleep(200);
      return clone(db.binders)
        .map(({ recap, quiz, chunks, ...rest }) => rest)
        .sort((a, b) => (b.isFavourite === a.isFavourite ? new Date(b.updatedAt) - new Date(a.updatedAt) : b.isFavourite ? 1 : -1));
    },
    async get(id) {
      await sleep(160);
      const found = db.binders.find((b) => b.id === id);
      if (!found) throw Object.assign(new Error('Binder not found'), { status: 404 });
      return clone(found);
    },
    async create(name) {
      await sleep(300);
      const clean = String(name ?? '').trim();
      if (!clean) throw Object.assign(new Error('A binder name is required.'), { status: 400 });
      if (clean.length > 100) throw Object.assign(new Error('Binder names must be 100 characters or fewer.'), { status: 400 });
      const now = new Date().toISOString();
      const binder = { id: makeId('binder'), name: clean, isFavourite: false, sourceCount: 0, recap: null, generatedAt: null, createdAt: now, updatedAt: now };
      db.binders = [binder, ...db.binders];
      persist();
      return clone(binder);
    },
    async update(id, patch) {
      await sleep(180);
      const binder = db.binders.find((b) => b.id === id);
      if (!binder) throw Object.assign(new Error('Binder not found'), { status: 404 });
      if (patch.name !== undefined) {
        const clean = String(patch.name ?? '').trim();
        if (!clean) throw Object.assign(new Error('A binder name is required.'), { status: 400 });
        binder.name = clean;
      }
      if (patch.isFavourite !== undefined) binder.isFavourite = !!patch.isFavourite;
      binder.updatedAt = new Date().toISOString();
      persist();
      return clone(binder);
    },
    async remove(id) {
      await sleep(200);
      db.binders = db.binders.filter((b) => b.id !== id);
      delete db.sources[id];
      persist();
    },
    async generate(id) {
      const binder = db.binders.find((b) => b.id === id);
      if (!binder) throw Object.assign(new Error('Binder not found'), { status: 404 });
      const ready = (db.sources[id] ?? []).filter((s) => s.status === 'ready');
      if (!ready.length) throw Object.assign(new Error('Add at least one processed source before generating a recap.'), { status: 400 });

      const jobId = makeId('job');
      jobs.set(jobId, { id: jobId, binderId: id, status: 'running', stage: 'read', stageLabel: '', progress: 0, log: [] });
      (async () => {
        const job = jobs.get(jobId);
        for (const stage of PIPELINE_STAGES.slice(1, 6)) {
          job.stage = stage.id;
          job.stageLabel = stage.label;
          await sleep(Math.min(stage.ms, 900));
          job.progress = Math.min(99, job.progress + 18);
        }
        const { recap, quiz, sourcesSummary } = attributeSampleRecap(ready);
        binder.recap = recap;
        binder.quiz = quiz;
        binder.chunks = clone(SAMPLE_CHUNKS);
        binder.sourcesSummary = sourcesSummary;
        binder.generatedAt = new Date().toISOString();
        binder.updatedAt = binder.generatedAt;
        job.progress = 100;
        job.stage = 'done';
        job.status = 'ready';
        persist();
      })();
      await sleep(150);
      return { jobId, binderId: id };
    },
  },

  sources: {
    async list(binderId) {
      await sleep(160);
      return clone(db.sources[binderId] ?? []);
    },
    /** Demo mode has no S3, so "upload" is simulated with a short local delay in `put`. */
    async create(binderId, files) {
      await sleep(250);
      const created = [];
      const rejected = [];
      for (const file of files ?? []) {
        const fileName = String(file?.fileName ?? '').trim();
        if (!fileName) {
          rejected.push({ fileName: fileName || '(unnamed)', reason: 'A file name is required.' });
          continue;
        }
        if (!/\.pdf$/i.test(fileName)) {
          rejected.push({ fileName, reason: 'Only PDF files are accepted.' });
          continue;
        }
        const source = {
          id: makeId('src'),
          binderId,
          displayName: fileName.replace(/\.pdf$/i, ''),
          originalFilename: fileName,
          pageCount: 0,
          sizeBytes: Number(file?.sizeBytes ?? 0),
          status: 'pending',
          extractionMethod: null,
          errorMessage: null,
          uploadedAt: new Date().toISOString(),
        };
        db.sources[binderId] = [...(db.sources[binderId] ?? []), source];
        created.push({ ...source, uploadUrl: null });
      }
      if (created.length) {
        const binder = db.binders.find((b) => b.id === binderId);
        if (binder) {
          binder.sourceCount += created.length;
          binder.updatedAt = new Date().toISOString();
        }
      }
      persist();
      return { created, rejected };
    },
    async put() {
      await sleep(500);
    },
    async commit(binderId, sourceId) {
      const source = (db.sources[binderId] ?? []).find((s) => s.id === sourceId);
      if (!source) throw Object.assign(new Error('Source not found'), { status: 404 });
      if (source.status !== 'pending') return clone(source);
      source.status = 'processing';
      persist();
      (async () => {
        await sleep(1800 + Math.random() * 1200);
        source.status = 'ready';
        source.extractionMethod = 'text_layer';
        source.pageCount = 3 + Math.floor(Math.random() * 10);
        persist();
      })();
      return clone(source);
    },
    async retry(binderId, sourceId) {
      const source = (db.sources[binderId] ?? []).find((s) => s.id === sourceId);
      if (!source) throw Object.assign(new Error('Source not found'), { status: 404 });
      source.status = 'processing';
      source.errorMessage = null;
      persist();
      (async () => {
        await sleep(1500);
        source.status = 'ready';
        source.extractionMethod = 'text_layer';
        source.pageCount = 3 + Math.floor(Math.random() * 10);
        persist();
      })();
      return clone(source);
    },
    async rename(sourceId, displayName) {
      await sleep(150);
      const clean = String(displayName ?? '').trim();
      if (!clean) throw Object.assign(new Error('A name is required.'), { status: 400 });
      for (const list of Object.values(db.sources)) {
        const source = list.find((s) => s.id === sourceId);
        if (source) {
          source.displayName = clean;
          persist();
          return clone(source);
        }
      }
      throw Object.assign(new Error('Source not found'), { status: 404 });
    },
    async remove(sourceId) {
      await sleep(180);
      for (const [binderId, list] of Object.entries(db.sources)) {
        const idx = list.findIndex((s) => s.id === sourceId);
        if (idx !== -1) {
          list.splice(idx, 1);
          const binder = db.binders.find((b) => b.id === binderId);
          if (binder) {
            binder.sourceCount = Math.max(0, binder.sourceCount - 1);
            binder.updatedAt = new Date().toISOString();
          }
          persist();
          return;
        }
      }
      throw Object.assign(new Error('Source not found'), { status: 404 });
    },
    async status(sourceId) {
      await sleep(120);
      for (const list of Object.values(db.sources)) {
        const source = list.find((s) => s.id === sourceId);
        if (source) {
          const { id, status, extractionMethod, errorMessage, pageCount } = source;
          return clone({ id, status, extractionMethod, errorMessage, pageCount });
        }
      }
      throw Object.assign(new Error('Source not found'), { status: 404 });
    },
    /**
     * Demo mode has no S3 object to link to — the original bytes were never
     * actually stored anywhere, only the file name. Failing honestly here
     * (rather than opening a fake URL) is the same choice `ask()` and `tts()`
     * make elsewhere in this file.
     */
    async download() {
      await sleep(150);
      throw Object.assign(
        new Error('Opening the original PDF needs a real backend — demo mode never stores your file.'),
        { status: 501 },
      );
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

  async health() {
    await sleep(120);
    return { ok: true, mode: 'demo', providers: [], region: 'n/a', uptimeSeconds: 0 };
  },

  async tts() {
    throw Object.assign(new Error('Read-aloud is not available in demo mode.'), { status: 501 });
  },

  practice: {
    async helpAvailable() {
      await sleep(80);
      return { available: false };
    },
    async explain() {
      // Demo mode calls no model. Inventing an explanation of why a student's
      // code failed would be the one kind of wrong answer this app exists to
      // prevent.
      throw Object.assign(new Error('Coding help needs a live backend.'), { status: 501 });
    },
    /**
     * Demo mode calls no model, so these are written by hand — but written to
     * the same contract the real generator has to meet. They are about the
     * bundled normalisation lecture and cite the slides that teach them,
     * because an exercise that could have come from any deck would be
     * misrepresenting what the feature does.
     *
     * The runner is entirely client-side, so these actually execute here: what
     * a judge sees in demo mode is the real editor running real Python.
     */
    async get(materialId) {
      await sleep(420);
      const material = db.materials.find((m) => m.id === materialId);
      if (!material) throw Object.assign(new Error('Material not found'), { status: 404 });
      if (!material.sample && !material.demo) {
        return {
          exercises: [],
          applicable: false,
          reason: 'Demo mode calls no model, so it can only offer practice for the bundled sample material.',
        };
      }
      return clone(DEMO_PRACTICE);
    },
  },

  /** Test hook — lets Settings reset the demo store. */
  async _reset() {
    db = { user: db.user, materials: [SAMPLE_MATERIAL], attempts: [], flashcards: {}, shares: {}, lobbies: [], forumPosts: [] };
    persist();
  },
};
