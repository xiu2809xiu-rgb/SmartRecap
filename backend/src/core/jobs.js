import { keys, newId, getItem, putItem, ttlDays } from '../lib/db.js';
import { presignUpload, sourceKey } from '../lib/s3.js';
import { badRequest, notFound, forbidden, HttpError } from '../lib/http.js';
import { configuredProviders } from '../ai/provider.js';
import { normaliseLanguage } from '../ai/languages.js';
import { QUIZ_DIFFICULTIES } from '../ai/prompts.js';

/**
 * Uploads and job control.
 * Plain functions — see the note at the top of `core/auth.js`.
 */

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The browser PUTs the file straight to S3 with this URL, so a 25 MB deck never
 * touches the server and never hits API Gateway's 6 MB payload cap.
 */
export async function createUpload(userId, { fileName, contentType, sizeBytes }) {
  if (!fileName) throw badRequest('fileName is required.');
  if (Number(sizeBytes ?? 0) > MAX_UPLOAD_BYTES) throw new HttpError(413, 'That file is over the 25 MB limit.');

  const materialId = newId('m');
  const key = sourceKey(userId, materialId, fileName);
  return { materialId, uploadUrl: await presignUpload(key, contentType), key };
}

/**
 * Writes the job row and the placeholder material, then hands the actual work
 * to `dispatch`.
 *
 * `dispatch` is injected rather than chosen here because it is the one thing
 * that genuinely differs between hosts: on Lambda it is an async
 * `InvokeCommand`, on EC2 it is a bare call that is not awaited. Everything
 * else about starting a job is identical.
 */
/**
 * Everything the student chose, clamped to something the pipeline can run.
 *
 * A request body is untrusted input, and an unrecognised difficulty or language
 * is a typo far more often than an attack — so both fall back to the default
 * rather than rejecting the upload the student just waited on.
 */
function optionsFrom(body) {
  return {
    mode: body.mode === 'cram' ? 'cram' : 'deep',
    moduleName: body.module || '',
    quizLength: Math.min(20, Math.max(3, Number(body.quizLength) || 10)),
    difficulty: QUIZ_DIFFICULTIES.includes(body.difficulty) ? body.difficulty : 'balanced',
    language: normaliseLanguage(body.language),
  };
}

export async function startJob(userId, body, dispatch) {
  if (!body?.materialId || !body?.fileName) throw badRequest('materialId and fileName are required.');

  if (!configuredProviders().length) {
    throw new HttpError(503, 'No AI provider is configured on this deployment, so recaps cannot be generated.');
  }

  const jobId = newId('job');
  const key = sourceKey(userId, body.materialId, body.fileName);
  const options = optionsFrom(body);

  await putItem({
    ...keys.job(jobId),
    id: jobId,
    userId,
    materialId: body.materialId,
    status: 'running',
    stage: 'upload',
    progress: 0,
    log: [],
    // The processing screen reads this to decide whether to show the
    // translation stage at all, so an English job never displays a step that
    // is not going to run.
    language: options.language,
    createdAt: new Date().toISOString(),
    expiresAt: ttlDays(2),
  });

  // Placeholder so the material shows in the library while it processes.
  await putItem({
    ...keys.material(userId, body.materialId),
    id: body.materialId,
    title: String(body.fileName).replace(/\.[^.]+$/, ''),
    fileName: body.fileName,
    module: body.module || 'Unfiled',
    mode: options.mode,
    difficulty: options.difficulty,
    language: options.language,
    status: 'processing',
    s3Key: key,
    createdAt: new Date().toISOString(),
  });

  await dispatch({
    jobId,
    userId,
    materialId: body.materialId,
    fileName: body.fileName,
    key,
    ...options,
  });

  return { jobId, materialId: body.materialId };
}

export async function getJob(userId, jobId) {
  const job = await getItem(keys.job(jobId));
  if (!job) throw notFound('That job has expired or never existed.');
  if (job.userId !== userId) throw forbidden();
  const { pk, sk, userId: _owner, expiresAt, ...rest } = job;
  return rest;
}
