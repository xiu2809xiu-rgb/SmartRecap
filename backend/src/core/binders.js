import { keys, newId, getItem, putItem, deleteItem, updateItem, queryPrefix, ttlDays } from '../lib/db.js';
import { deleteObject } from '../lib/s3.js';
import { badRequest, notFound, HttpError } from '../lib/http.js';
import { configuredProviders } from '../ai/provider.js';

/**
 * Binders: a folder of Source documents that share one Recap.
 *
 * A Binder is deliberately thin — it carries no pipeline state of its own.
 * Ingestion status lives on each Source (see `core/sources.js`), and a
 * generation job's progress lives on the job row (see `core/dispatch.js`),
 * the same split `core/jobs.js` already uses for a single Material. The
 * Binder row only gains `recap`/`generatedAt` once a generation succeeds.
 *
 * Plain functions — see the note at the top of `core/auth.js`.
 */

/** Strips DynamoDB keys so storage internals never ship to the client. */
export const publicBinder = ({ pk, sk, ...rest }) => rest;

function validateName(rawName) {
  const name = String(rawName ?? '').trim();
  if (!name) throw badRequest('A binder name is required.');
  if (name.length > 100) throw badRequest('Binder names must be 100 characters or fewer.');
  return name;
}

export async function loadBinder(userId, binderId) {
  const item = await getItem(keys.binder(userId, binderId));
  if (!item) throw notFound('That binder is not in your library.');
  return item;
}

export async function createBinder(userId, { name } = {}) {
  const cleanName = validateName(name);
  const id = newId('binder');
  const now = new Date().toISOString();
  const binder = {
    ...keys.binder(userId, id),
    id,
    name: cleanName,
    isFavourite: false,
    sourceCount: 0,
    recap: null,
    generatedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await putItem(binder);
  return publicBinder(binder);
}

/** Favourites first, then most recently updated — same rule the cards render by. */
export async function listBinders(userId) {
  const items = await queryPrefix(keys.binderPrefix(userId));
  return items
    .map(publicBinder)
    .map(({ recap, ...rest }) => rest) // list view does not need the (possibly large) recap body
    .sort((a, b) => (b.isFavourite === a.isFavourite ? new Date(b.updatedAt) - new Date(a.updatedAt) : b.isFavourite ? 1 : -1));
}

export async function getBinder(userId, binderId) {
  return publicBinder(await loadBinder(userId, binderId));
}

export async function updateBinder(userId, binderId, { name, isFavourite } = {}) {
  await loadBinder(userId, binderId);

  const patch = { updatedAt: new Date().toISOString() };
  if (name !== undefined) patch.name = validateName(name);
  if (isFavourite !== undefined) {
    if (typeof isFavourite !== 'boolean') throw badRequest('isFavourite must be a boolean.');
    patch.isFavourite = isFavourite;
  }
  if (Object.keys(patch).length === 1) throw badRequest('Nothing to update — provide a name and/or isFavourite.');

  return publicBinder(await updateItem(keys.binder(userId, binderId), patch));
}

/** Cascade: every source's two S3 objects, every source row, then the binder. */
export async function deleteBinder(userId, binderId) {
  await loadBinder(userId, binderId);
  const sources = await queryPrefix(keys.sourcePrefix(userId, binderId));

  for (const source of sources) {
    await deleteObject(source.s3Key);
    await deleteObject(source.textS3Key);
    await deleteItem(keys.source(userId, binderId, source.id));
    await deleteItem(keys.sourceIndex(userId, source.id));
  }

  await deleteItem(keys.binder(userId, binderId));
}

/**
 * Starts a Recap generation job over every currently-ready source. Mirrors
 * `jobs.startJob`: writes a job row, hands the real work to `dispatch`, and
 * returns immediately so the client polls `GET /jobs/{id}` exactly like a
 * Material job does.
 */
export async function generateBinder(userId, binderId, dispatch) {
  await loadBinder(userId, binderId);

  if (!configuredProviders().length) {
    throw new HttpError(503, 'No AI provider is configured on this deployment, so recaps cannot be generated.');
  }

  const sources = await queryPrefix(keys.sourcePrefix(userId, binderId));
  const readyCount = sources.filter((s) => s.status === 'ready').length;
  if (readyCount === 0) {
    throw badRequest('Add at least one processed source before generating a recap.');
  }

  const jobId = newId('job');
  await putItem({
    ...keys.job(jobId),
    id: jobId,
    userId,
    binderId,
    kind: 'binder-generate',
    status: 'running',
    stage: 'read',
    progress: 0,
    log: [],
    createdAt: new Date().toISOString(),
    expiresAt: ttlDays(2),
  });

  await dispatch({ kind: 'binder-generate', jobId, userId, binderId });

  return { jobId, binderId };
}
