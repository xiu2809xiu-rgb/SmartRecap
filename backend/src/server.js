import express from 'express';
import cors from 'cors';

import { HttpError } from './lib/http.js';
import { verifyToken } from './lib/jwt.js';
import * as auth from './core/auth.js';
import * as library from './core/library.js';
import * as study from './core/study.js';
import * as jobs from './core/jobs.js';
import { runPipeline } from './core/pipeline.js';
import { configuredProviders } from './ai/provider.js';

/**
 * SmartRecap API on EC2.
 *
 * Every route below is a thin wrapper over the same `core/` functions the
 * Lambda handler calls, so the two hosts cannot drift apart. Choosing EC2 costs
 * you nothing in behaviour.
 *
 * One genuine difference, and it is a simplification: this process is
 * long-lived, so a generation job runs in-process rather than being handed to a
 * second Lambda. There is no 29-second gateway timeout to work around, no
 * second function to deploy, and no invoke permission to arrange.
 *
 * The tradeoff is that a job dies if the process restarts mid-run. The job row
 * in DynamoDB is left marked `running`, which the client shows as a stall
 * rather than a false success — see `reapStaleJobs` below.
 *
 * Run it:
 *   node src/server.js
 * Or, so it survives your SSH session and comes back on boot:
 *   sudo systemctl enable --now smartrecap
 */

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1); // nginx sits in front; needed for correct client IPs

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN && process.env.ALLOWED_ORIGIN !== '*' ? process.env.ALLOWED_ORIGIN : true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// The file itself goes straight to S3 with a presigned URL, so nothing posted
// to this API is ever large. A small cap is free protection.
app.use(express.json({ limit: '256kb' }));

/* --------------------------------------------------------------- helpers */

/** Turns a core function's return value or thrown HttpError into a response. */
const send = (fn, status = 200) => async (req, res, next) => {
  try {
    const body = await fn(req, res);
    if (res.headersSent) return;
    if (body === undefined) res.status(204).end();
    else res.status(status).json(body);
  } catch (e) {
    next(e);
  }
};

/** Bearer-token gate. Mirrors `requireUser` on the Lambda side. */
function requireUser(req) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw new HttpError(401, 'Sign in to continue.');
  const claims = verifyToken(token);
  if (!claims.sub) throw new HttpError(401, 'Session token is missing a subject.');
  return { id: claims.sub, email: claims.email ?? null, name: claims.name ?? 'Student', guest: !!claims.guest };
}

/**
 * On EC2 a job is just a promise nobody awaits. `runPipeline` handles its own
 * errors and writes failures to the job row, so an unhandled rejection here
 * would be a bug in that function rather than a normal outcome — log it loudly
 * instead of letting it take the process down.
 */
const dispatchInProcess = async (payload) => {
  runPipeline(payload).catch((e) => console.error('Pipeline threw outside its own handler', payload.jobId, e));
};

/* ---------------------------------------------------------------- routes */

app.get(
  '/health',
  send(async () => ({
    ok: true,
    providers: configuredProviders().map((p) => p.name),
    region: process.env.AWS_REGION ?? 'unset',
    table: process.env.TABLE_NAME ?? 'unset',
    uptimeSeconds: Math.round(process.uptime()),
  })),
);

app.post('/auth/signup', send((req) => auth.signup(req.body), 201));
app.post('/auth/login', send((req) => auth.login(req.body)));
app.post('/auth/guest', send(() => auth.guest(), 201));
app.get('/auth/me', send((req) => auth.me(requireUser(req).id)));

app.get('/materials', send((req) => library.listMaterials(requireUser(req).id)));
app.get('/materials/:id', send((req) => library.getMaterial(requireUser(req).id, req.params.id)));
app.patch('/materials/:id', send((req) => library.renameMaterial(requireUser(req).id, req.params.id, req.body?.title)));
app.delete(
  '/materials/:id',
  send(async (req) => {
    await library.deleteMaterial(requireUser(req).id, req.params.id);
  }),
);

app.get('/materials/:id/flashcards', send((req) => library.getCards(requireUser(req).id, req.params.id)));
app.put('/materials/:id/flashcards', send((req) => library.saveCards(requireUser(req).id, req.params.id, req.body?.cards)));

app.post(
  '/materials/:id/share',
  send((req) => library.createShare(requireUser(req).id, req.params.id, process.env.PUBLIC_WEB_ORIGIN ?? ''), 201),
);
app.get('/shared/:token', send((req) => library.getShared(req.params.token)));

app.post('/uploads', send((req) => jobs.createUpload(requireUser(req).id, req.body), 201));
app.post('/jobs', send((req) => jobs.startJob(requireUser(req).id, req.body, dispatchInProcess), 202));
app.get('/jobs/:id', send((req) => jobs.getJob(requireUser(req).id, req.params.id)));

app.post('/quiz/attempts', send((req) => study.submitAttempt(requireUser(req).id, req.body), 201));
app.get('/quiz/attempts', send((req) => study.listAttempts(requireUser(req).id, req.query.materialId)));

app.post('/ask', send((req) => study.ask(requireUser(req).id, req.body)));
app.post('/tts', send((req) => study.textToSpeech(requireUser(req).id, req.body)));

app.use((req, res) => res.status(404).json({ message: `No route for ${req.method} ${req.path}` }));

/* ------------------------------------------------------------- error sink */

// Four arguments — Express identifies error middleware by arity, so the unused
// `next` is load-bearing and must stay.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message, ...(err.details ? { details: err.details } : null) });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Request body was not valid JSON.' });
  }
  console.error('Unhandled error', { path: req.path, message: err?.message, stack: err?.stack });
  return res.status(500).json({ message: 'Something went wrong on our side. Try again in a moment.' });
});

/* -------------------------------------------------------------- lifecycle */

const server = app.listen(PORT, () => {
  const providers = configuredProviders().map((p) => p.name);
  console.log(`SmartRecap API listening on :${PORT}`);
  console.log(`  region    ${process.env.AWS_REGION ?? '(unset — set AWS_REGION)'}`);
  console.log(`  table     ${process.env.TABLE_NAME ?? '(unset — set TABLE_NAME)'}`);
  console.log(`  bucket    ${process.env.BUCKET_NAME ?? '(unset — set BUCKET_NAME)'}`);
  console.log(`  providers ${providers.length ? providers.join(', ') : '(none — recaps will 503)'}`);
});

// systemd sends SIGTERM on restart. Finish in-flight requests rather than
// cutting them off; a generation job already in progress is lost either way,
// which is why the client treats a stalled job as a stall and not a success.
const shutdown = (signal) => {
  console.log(`${signal} received, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
