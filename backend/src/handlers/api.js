import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  AdminConfirmSignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';

import { json, noContent, withErrors, parseBody, requireFields, badRequest, notFound, conflict, unauthorized, forbidden, HttpError } from '../lib/http.js';
import { issueToken, requireUser } from '../lib/jwt.js';
import { keys, newId, getItem, putItem, deleteItem, updateItem, queryPrefix, ttlDays } from '../lib/db.js';
import { presignUpload, sourceKey, deleteObject, putObject, presignDownload, audioKey } from '../lib/s3.js';
import { answerQuestion } from '../ai/generate.js';
import { configuredProviders } from '../ai/provider.js';

const lambda = new LambdaClient({});
const cognito = new CognitoIdentityProviderClient({});
const polly = new PollyClient({});

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/* --------------------------------------------------------------- utilities */

const publicUser = (u) => ({ id: u.id, email: u.email ?? null, name: u.name, guest: !!u.guest, createdAt: u.createdAt });

/** Strips the DynamoDB keys so the client never sees storage internals. */
const publicMaterial = ({ pk, sk, expiresAt, s3Key, ...rest }) => rest;

async function loadMaterial(userId, materialId) {
  const item = await getItem(keys.material(userId, materialId));
  if (!item) throw notFound('That material is not in your library.');
  return item;
}

/* ------------------------------------------------------------------- auth */

async function signup(event) {
  const body = requireFields(parseBody(event), ['email', 'password']);
  const email = String(body.email).trim().toLowerCase();
  const name = String(body.name ?? '').trim() || email.split('@')[0];

  const existing = await getItem(keys.emailIndex(email));
  if (existing) throw conflict('An account already uses that email.');

  try {
    await cognito.send(
      new SignUpCommand({
        ClientId: process.env.USER_POOL_CLIENT_ID,
        Username: email,
        Password: body.password,
        UserAttributes: [{ Name: 'name', Value: name }],
      }),
    );
    // No email delivery is configured (SES would need an IAM role Learner Lab
    // cannot create), so accounts are confirmed straight away. A production
    // deployment would send a verification code instead.
    await cognito.send(
      new AdminConfirmSignUpCommand({ UserPoolId: process.env.USER_POOL_ID, Username: email }),
    );
  } catch (e) {
    if (e.name === 'UsernameExistsException') throw conflict('An account already uses that email.');
    if (e.name === 'InvalidPasswordException') {
      throw badRequest('That password does not meet the policy: at least 8 characters, with upper case, lower case and a number.');
    }
    console.error('Cognito sign-up failed', e.name, e.message);
    throw new HttpError(502, 'Could not create the account. Try again in a moment.');
  }

  const user = { id: newId('u'), email, name, guest: false, createdAt: new Date().toISOString() };
  await putItem({ ...keys.user(user.id), ...user });
  await putItem({ ...keys.emailIndex(email), userId: user.id });

  return json(201, { token: issueToken({ sub: user.id, email, name }), user: publicUser(user) });
}

async function login(event) {
  const body = requireFields(parseBody(event), ['email', 'password']);
  const email = String(body.email).trim().toLowerCase();

  try {
    await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: process.env.USER_POOL_CLIENT_ID,
        AuthParameters: { USERNAME: email, PASSWORD: body.password },
      }),
    );
  } catch (e) {
    if (e.name === 'NotAuthorizedException' || e.name === 'UserNotFoundException') {
      throw unauthorized('That email and password do not match an account.');
    }
    console.error('Cognito sign-in failed', e.name, e.message);
    throw new HttpError(502, 'Could not sign you in. Try again in a moment.');
  }

  const index = await getItem(keys.emailIndex(email));
  if (!index) throw unauthorized('That email and password do not match an account.');
  const user = await getItem(keys.user(index.userId));
  if (!user) throw unauthorized('That account no longer exists.');

  return json(200, {
    token: issueToken({ sub: user.id, email: user.email, name: user.name }),
    user: publicUser(user),
  });
}

/**
 * A guest gets a real, scoped identity — not a client-side pretence. The same
 * authorizer protects every endpoint, and the same DynamoDB partitioning keeps
 * their material private. The record carries a TTL so abandoned guest data
 * clears itself out of a $50 credit budget.
 */
async function guest() {
  const user = {
    id: newId('g'),
    email: null,
    name: 'Guest',
    guest: true,
    createdAt: new Date().toISOString(),
    expiresAt: ttlDays(30),
  };
  await putItem({ ...keys.user(user.id), ...user });
  return json(201, { token: issueToken({ sub: user.id, name: user.name, guest: true }), user: publicUser(user) });
}

async function me(event) {
  const claims = requireUser(event);
  const user = await getItem(keys.user(claims.id));
  if (!user) throw unauthorized('That account no longer exists.');
  return json(200, publicUser(user));
}

/* -------------------------------------------------------------- materials */

async function listMaterials(event) {
  const user = requireUser(event);
  const items = await queryPrefix(keys.materialPrefix(user.id));
  // Newest first. The list view does not need chunks or the full quiz, and
  // stripping them keeps a 20-material response well under the payload limit.
  const summaries = items
    .map(publicMaterial)
    .map(({ chunks, quiz, recap, ...rest }) => ({
      ...rest,
      pageCount: rest.pageCount ?? 0,
      recap: recap ? { summary: recap.summary, readMinutes: recap.readMinutes } : null,
      questionCount: quiz?.questions?.length ?? 0,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return json(200, summaries);
}

async function getMaterial(event, materialId) {
  const user = requireUser(event);
  return json(200, publicMaterial(await loadMaterial(user.id, materialId)));
}

async function deleteMaterial(event, materialId) {
  const user = requireUser(event);
  const material = await loadMaterial(user.id, materialId);
  await deleteObject(material.s3Key);
  await deleteItem(keys.material(user.id, materialId));
  await deleteItem(keys.cards(user.id, materialId));
  return noContent();
}

async function patchMaterial(event, materialId) {
  const user = requireUser(event);
  const body = parseBody(event);
  const title = String(body.title ?? '').trim();
  if (!title) throw badRequest('A title is required.');
  if (title.length > 200) throw badRequest('That title is too long.');
  await loadMaterial(user.id, materialId);
  const updated = await updateItem(keys.material(user.id, materialId), { title });
  return json(200, publicMaterial(updated));
}

/* ---------------------------------------------------------------- uploads */

async function createUpload(event) {
  const user = requireUser(event);
  const body = requireFields(parseBody(event), ['fileName']);
  const size = Number(body.sizeBytes ?? 0);
  if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'That file is over the 25 MB limit.');

  const materialId = newId('m');
  const key = sourceKey(user.id, materialId, body.fileName);
  const uploadUrl = await presignUpload(key, body.contentType);

  return json(201, { materialId, uploadUrl, key });
}

/* ------------------------------------------------------------------- jobs */

async function startJob(event) {
  const user = requireUser(event);
  const body = requireFields(parseBody(event), ['materialId', 'fileName']);

  if (!configuredProviders().length) {
    throw new HttpError(503, 'No AI provider is configured on this deployment, so recaps cannot be generated.');
  }

  const jobId = newId('job');
  const key = sourceKey(user.id, body.materialId, body.fileName);

  const job = {
    ...keys.job(jobId),
    id: jobId,
    userId: user.id,
    materialId: body.materialId,
    status: 'running',
    stage: 'upload',
    progress: 0,
    log: [],
    createdAt: new Date().toISOString(),
    expiresAt: ttlDays(2),
  };
  await putItem(job);

  // Placeholder so the material appears in the library while it processes.
  await putItem({
    ...keys.material(user.id, body.materialId),
    id: body.materialId,
    title: String(body.fileName).replace(/\.[^.]+$/, ''),
    fileName: body.fileName,
    module: body.module || 'Unfiled',
    mode: body.mode === 'cram' ? 'cram' : 'deep',
    status: 'processing',
    s3Key: key,
    createdAt: new Date().toISOString(),
  });

  // Generation takes 20-40 seconds and API Gateway caps a request at 29, so
  // the work is handed to a second function and this returns immediately.
  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.PROCESSOR_FUNCTION,
      InvocationType: 'Event',
      Payload: Buffer.from(
        JSON.stringify({
          jobId,
          userId: user.id,
          materialId: body.materialId,
          fileName: body.fileName,
          key,
          mode: body.mode === 'cram' ? 'cram' : 'deep',
          moduleName: body.module || '',
          quizLength: Math.min(20, Math.max(3, Number(body.quizLength) || 10)),
        }),
      ),
    }),
  );

  return json(202, { jobId, materialId: body.materialId });
}

async function getJob(event, jobId) {
  const user = requireUser(event);
  const job = await getItem(keys.job(jobId));
  if (!job) throw notFound('That job has expired or never existed.');
  if (job.userId !== user.id) throw forbidden();
  const { pk, sk, userId, expiresAt, ...rest } = job;
  return json(200, rest);
}

/* ------------------------------------------------------------------- quiz */

async function submitAttempt(event) {
  const user = requireUser(event);
  const body = requireFields(parseBody(event), ['materialId', 'answers']);
  const material = await loadMaterial(user.id, body.materialId);

  const questions = material.quiz?.questions ?? [];
  const scored = questions.filter((q) => q.verified);
  const correct = scored.filter((q) => body.answers[q.id] === q.answer).length;

  const byTopic = Object.entries(
    scored.reduce((acc, q) => {
      acc[q.topic] ??= { correct: 0, total: 0 };
      acc[q.topic].total += 1;
      if (body.answers[q.id] === q.answer) acc[q.topic].correct += 1;
      return acc;
    }, {}),
  ).map(([topic, v]) => ({ topic, ...v }));

  const at = new Date().toISOString();
  const attempt = {
    id: newId('a'),
    materialId: body.materialId,
    at,
    durationMs: Number(body.durationMs) || 0,
    correct,
    total: scored.length,
    score: scored.length ? Math.round((correct / scored.length) * 100) : 0,
    byTopic,
    answers: body.answers,
  };

  await putItem({ ...keys.attempt(user.id, at, attempt.id), ...attempt });
  return json(201, attempt);
}

async function listAttempts(event) {
  const user = requireUser(event);
  const materialId = event.queryStringParameters?.materialId;
  const items = await queryPrefix(keys.attemptPrefix(user.id));
  const attempts = items
    .map(({ pk, sk, ...rest }) => rest)
    .filter((a) => !materialId || a.materialId === materialId)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  return json(200, attempts);
}

/* ------------------------------------------------------------- flashcards */

async function getCards(event, materialId) {
  const user = requireUser(event);
  const item = await getItem(keys.cards(user.id, materialId));
  return json(200, item?.cards ?? null);
}

async function saveCards(event, materialId) {
  const user = requireUser(event);
  const body = parseBody(event);
  if (!Array.isArray(body.cards)) throw badRequest('"cards" must be an array.');
  await putItem({ ...keys.cards(user.id, materialId), cards: body.cards, updatedAt: new Date().toISOString() });
  return json(200, body.cards);
}

/* ------------------------------------------------------------------ share */

async function createShare(event, materialId) {
  const user = requireUser(event);
  await loadMaterial(user.id, materialId);
  const token = newId('s').replace('s_', '');
  await putItem({ ...keys.share(token), userId: user.id, materialId, createdAt: new Date().toISOString() });
  const origin = process.env.ALLOWED_ORIGIN !== '*' ? process.env.ALLOWED_ORIGIN : '';
  return json(201, { token, url: `${origin}/s/${token}` });
}

/** Public and unauthenticated: the recap and its sources, never quiz history. */
async function getShared(_event, token) {
  const share = await getItem(keys.share(token));
  if (!share) throw notFound('This link is no longer valid.');
  const material = await getItem(keys.material(share.userId, share.materialId));
  if (!material) throw notFound('This link is no longer valid.');

  const { pk, sk, s3Key, expiresAt, quiz, ...rest } = material;
  return json(200, rest);
}

/* -------------------------------------------------------------------- ask */

async function ask(event) {
  const user = requireUser(event);
  const body = requireFields(parseBody(event), ['materialId', 'question']);
  const question = String(body.question).slice(0, 500);
  const material = await loadMaterial(user.id, body.materialId);
  if (!material.chunks?.length) throw badRequest('That material has no extracted text to search.');
  return json(200, await answerQuestion({ chunks: material.chunks, question, history: body.history ?? [] }));
}

/* -------------------------------------------------------------------- tts */

/** Read-aloud via Amazon Polly, for revising on the bus. */
async function tts(event) {
  const user = requireUser(event);
  const body = requireFields(parseBody(event), ['materialId']);
  const material = await loadMaterial(user.id, body.materialId);
  const recap = material.recap;
  if (!recap) throw badRequest('That material has no recap to read.');

  const script = [
    recap.summary,
    ...recap.sections.flatMap((s) => [`${s.heading}.`, ...s.points.map((p) => p.text)]),
  ]
    .join(' ')
    // Polly's standard engine caps a single request at 3000 characters.
    .slice(0, 2900);

  const res = await polly.send(
    new SynthesizeSpeechCommand({ Text: script, OutputFormat: 'mp3', VoiceId: 'Amy', Engine: 'neural' }),
  );
  const key = audioKey(user.id, body.materialId);
  await putObject(key, Buffer.from(await res.AudioStream.transformToByteArray()), 'audio/mpeg');
  return json(200, { url: await presignDownload(key, 3600), characters: script.length });
}

/* ----------------------------------------------------------------- router */

const ROUTES = [
  ['POST', /^\/auth\/signup$/, signup],
  ['POST', /^\/auth\/login$/, login],
  ['POST', /^\/auth\/guest$/, guest],
  ['GET', /^\/auth\/me$/, me],

  ['GET', /^\/materials$/, listMaterials],
  ['GET', /^\/materials\/([^/]+)$/, getMaterial],
  ['DELETE', /^\/materials\/([^/]+)$/, deleteMaterial],
  ['PATCH', /^\/materials\/([^/]+)$/, patchMaterial],
  ['GET', /^\/materials\/([^/]+)\/flashcards$/, getCards],
  ['PUT', /^\/materials\/([^/]+)\/flashcards$/, saveCards],
  ['POST', /^\/materials\/([^/]+)\/share$/, createShare],
  ['GET', /^\/shared\/([^/]+)$/, getShared],

  ['POST', /^\/uploads$/, createUpload],
  ['POST', /^\/jobs$/, startJob],
  ['GET', /^\/jobs\/([^/]+)$/, getJob],

  ['POST', /^\/quiz\/attempts$/, submitAttempt],
  ['GET', /^\/quiz\/attempts$/, listAttempts],

  ['POST', /^\/ask$/, ask],
  ['POST', /^\/tts$/, tts],
];

export const handler = withErrors(async (event) => {
  const method = event.httpMethod ?? event.requestContext?.http?.method;
  if (method === 'OPTIONS') return noContent();

  const path = (event.path ?? event.rawPath ?? '/').replace(/\/+$/, '') || '/';

  for (const [routeMethod, pattern, fn] of ROUTES) {
    if (routeMethod !== method) continue;
    const match = pattern.exec(path);
    if (match) return fn(event, ...match.slice(1).map(decodeURIComponent));
  }

  return json(404, { message: `No route for ${method} ${path}` });
});
