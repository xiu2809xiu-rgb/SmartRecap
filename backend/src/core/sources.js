import { keys, newId, getItem, putItem, deleteItem, updateItem, queryPrefix, incrementItem } from '../lib/db.js';
import { presignUpload, presignDownload, binderSourceKey, deleteObject } from '../lib/s3.js';
import { badRequest, notFound } from '../lib/http.js';
import { loadBinder } from './binders.js';

/**
 * Sources: one uploaded PDF inside a Binder, and its async extraction status.
 *
 * The upload itself follows the same direct-to-S3 shape every upload in this
 * app uses (see `core/jobs.createUpload`): the browser PUTs the file straight
 * to S3 with a presigned URL, so a source's bytes never pass through this
 * server. That is also why creating a Source is a two-step handshake —
 * `createSources` hands out the upload URL(s) and writes `status: "pending"`
 * rows, and `commitSource` is the point where the browser confirms the PUT
 * finished and the actual ingestion work (extraction) can be queued.
 *
 * Plain functions — see the note at the top of `core/auth.js`.
 */

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_PAGES_PER_BINDER = 300;

/** Strips DynamoDB keys and the S3 paths so storage internals never ship. */
export const publicSource = ({ pk, sk, s3Key, textS3Key, ...rest }) => rest;

export async function loadSource(userId, binderId, sourceId) {
  const item = await getItem(keys.source(userId, binderId, sourceId));
  if (!item) throw notFound('That source is not in this binder.');
  return item;
}

/** Resolves a bare source id to its binder, via the pointer `deleteSource` etc. rely on. */
async function loadSourceByIndex(userId, sourceId) {
  const pointer = await getItem(keys.sourceIndex(userId, sourceId));
  if (!pointer) throw notFound('That source does not exist.');
  return loadSource(userId, pointer.binderId, sourceId);
}

function isPdf(fileName) {
  return /\.pdf$/i.test(String(fileName ?? ''));
}

/**
 * Creates one Source row per file and returns a presigned upload URL for each.
 * Nothing is extracted yet — that starts only once `commitSource` confirms the
 * bytes have actually landed in S3.
 *
 * Rejects non-PDF names outright and creates no row for them, per the
 * acceptance criteria — a partial batch (some PDFs, some not) still creates
 * rows for the PDFs and reports the rejected ones back individually.
 */
export async function createSources(userId, binderId, files) {
  await loadBinder(userId, binderId);
  if (!Array.isArray(files) || files.length === 0) throw badRequest('At least one file is required.');

  const created = [];
  const rejected = [];

  for (const file of files) {
    const fileName = String(file?.fileName ?? '').trim();
    const sizeBytes = Number(file?.sizeBytes ?? 0);

    if (!fileName) {
      rejected.push({ fileName: fileName || '(unnamed)', reason: 'A file name is required.' });
      continue;
    }
    if (!isPdf(fileName)) {
      rejected.push({ fileName, reason: 'Only PDF files are accepted.' });
      continue;
    }
    if (sizeBytes > MAX_UPLOAD_BYTES) {
      rejected.push({ fileName, reason: 'That file is over the 25 MB limit.' });
      continue;
    }
    if (sizeBytes === 0) {
      rejected.push({ fileName, reason: 'That file is empty.' });
      continue;
    }

    const sourceId = newId('src');
    const key = binderSourceKey(userId, binderId, sourceId);
    const now = new Date().toISOString();

    const source = {
      ...keys.source(userId, binderId, sourceId),
      id: sourceId,
      binderId,
      displayName: fileName.replace(/\.pdf$/i, ''),
      originalFilename: fileName,
      s3Key: key,
      textS3Key: null,
      pageCount: 0,
      sizeBytes,
      status: 'pending',
      extractionMethod: null,
      errorMessage: null,
      uploadedAt: now,
    };

    await putItem(source);
    await putItem({ ...keys.sourceIndex(userId, sourceId), binderId });

    created.push({ ...publicSource(source), uploadUrl: await presignUpload(key, 'application/pdf') });
  }

  if (created.length) {
    await incrementItem(keys.binder(userId, binderId), 'sourceCount', created.length);
    await updateItem(keys.binder(userId, binderId), { updatedAt: new Date().toISOString() });
  }

  return { created, rejected };
}

/**
 * Confirms the browser's S3 PUT finished for a source and queues extraction.
 * `dispatch` is the same injected fire-and-forget hook `startJob` uses — see
 * `core/dispatch.js`.
 */
export async function commitSource(userId, binderId, sourceId, dispatch) {
  const source = await loadSource(userId, binderId, sourceId);
  if (source.status !== 'pending') return publicSource(source); // already committed — idempotent

  // The page cap is enforced at commit time using the *previous* ready+pending
  // total, because page counts for other pending sources are not known until
  // their own extraction runs. A source that pushes the binder over the cap
  // once its real page count is known is failed in `sourceExtract.js` instead.
  const updated = await updateItem(keys.source(userId, binderId, sourceId), { status: 'processing' });
  await dispatch({ kind: 'source-extract', userId, binderId, sourceId });
  return publicSource(updated);
}

/** Re-queues extraction for a source stuck in `failed`. */
export async function retrySource(userId, binderId, sourceId, dispatch) {
  const source = await loadSource(userId, binderId, sourceId);
  if (source.status !== 'failed') throw badRequest('Only a failed source can be retried.');
  const updated = await updateItem(keys.source(userId, binderId, sourceId), { status: 'processing', errorMessage: null });
  await dispatch({ kind: 'source-extract', userId, binderId, sourceId });
  return publicSource(updated);
}

export async function listSources(userId, binderId) {
  await loadBinder(userId, binderId);
  const items = await queryPrefix(keys.sourcePrefix(userId, binderId));
  return items.map(publicSource).sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));
}

export async function getSourceStatus(userId, sourceId) {
  const source = await loadSourceByIndex(userId, sourceId);
  const { id, status, extractionMethod, errorMessage, pageCount } = source;
  return { id, status, extractionMethod, errorMessage, pageCount };
}

/**
 * A short-lived link straight to the source's original PDF in S3, for a
 * citation chip's "open this page" action. `#page=N` is a PDF open-parameter
 * every major browser's built-in viewer honours, so appending it client-side
 * is enough to land on the right page — no separate rendering endpoint or
 * PDF library needed on either side.
 */
export async function getSourceDownloadUrl(userId, sourceId) {
  const source = await loadSourceByIndex(userId, sourceId);
  if (source.status !== 'ready') throw badRequest('That source is not ready yet.');
  return { url: await presignDownload(source.s3Key) };
}

export async function renameSource(userId, sourceId, rawName) {
  const source = await loadSourceByIndex(userId, sourceId);
  const displayName = String(rawName ?? '').trim();
  if (!displayName) throw badRequest('A name is required.');
  if (displayName.length > 200) throw badRequest('That name is too long.');
  // Metadata only — renaming never touches s3Key or textS3Key.
  return publicSource(await updateItem(keys.source(userId, source.binderId, sourceId), { displayName }));
}

export async function deleteSource(userId, sourceId) {
  const source = await loadSourceByIndex(userId, sourceId);
  await deleteObject(source.s3Key);
  await deleteObject(source.textS3Key);
  await deleteItem(keys.source(userId, source.binderId, sourceId));
  await deleteItem(keys.sourceIndex(userId, sourceId));
  await incrementItem(keys.binder(userId, source.binderId), 'sourceCount', -1);
  await updateItem(keys.binder(userId, source.binderId), { updatedAt: new Date().toISOString() });
  return { binderId: source.binderId };
}

export { MAX_PAGES_PER_BINDER, isPdf };
