import { keys, newId, getItem, putItem, deleteItem, updateItem, queryPrefix } from '../lib/db.js';
import { deleteObject } from '../lib/s3.js';
import { badRequest, notFound } from '../lib/http.js';

/**
 * The library: materials, flashcard state and share links.
 * Plain functions — see the note at the top of `core/auth.js`.
 */

/** Strips DynamoDB keys and the S3 path so storage internals never ship. */
export const publicMaterial = ({ pk, sk, expiresAt, s3Key, shareToken, ...rest }) => rest;

export async function loadMaterial(userId, materialId) {
  const item = await getItem(keys.material(userId, materialId));
  if (!item) throw notFound('That material is not in your library.');
  return item;
}

/**
 * The list view does not need chunks or full quizzes, and a library of twenty
 * materials with recaps inlined would otherwise be megabytes.
 */
export async function listMaterials(userId) {
  const items = await queryPrefix(keys.materialPrefix(userId));
  return items
    .map(publicMaterial)
    .map(({ chunks, quiz, recap, ...rest }) => ({
      ...rest,
      pageCount: rest.pageCount ?? 0,
      recap: recap ? { summary: recap.summary, readMinutes: recap.readMinutes } : null,
      questionCount: quiz?.questions?.length ?? 0,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function getMaterial(userId, materialId) {
  return publicMaterial(await loadMaterial(userId, materialId));
}

export async function renameMaterial(userId, materialId, rawTitle) {
  const title = String(rawTitle ?? '').trim();
  if (!title) throw badRequest('A title is required.');
  if (title.length > 200) throw badRequest('That title is too long.');
  await loadMaterial(userId, materialId);
  return publicMaterial(await updateItem(keys.material(userId, materialId), { title }));
}

export async function deleteMaterial(userId, materialId) {
  const material = await loadMaterial(userId, materialId);
  await deleteObject(material.s3Key);
  await deleteItem(keys.material(userId, materialId));
  await deleteItem(keys.cards(userId, materialId));
}

/* ------------------------------------------------------------- flashcards */

export async function getCards(userId, materialId) {
  const item = await getItem(keys.cards(userId, materialId));
  return item?.cards ?? null;
}

export async function saveCards(userId, materialId, cards) {
  if (!Array.isArray(cards)) throw badRequest('"cards" must be an array.');
  await putItem({ ...keys.cards(userId, materialId), cards, updatedAt: new Date().toISOString() });
  return cards;
}

/* ------------------------------------------------------------------ share */

export async function createShare(userId, materialId, publicOrigin = '') {
  const material = await loadMaterial(userId, materialId);
  const token = newId('s').replace('s_', '');
  await putItem({ ...keys.share(token), userId, materialId, createdAt: new Date().toISOString() });
  // Kept on the material so that moving a guest's library onto a real account
  // can repoint the share record too, instead of leaving a dead link.
  await putItem({ ...material, shareToken: token });
  return { token, url: `${publicOrigin}/s/${token}` };
}

/**
 * Public and unauthenticated. Deliberately partial: the recap and its sources
 * are visible, the owner's quiz history is not.
 */
export async function getShared(token) {
  const share = await getItem(keys.share(token));
  if (!share) throw notFound('This link is no longer valid.');
  const material = await getItem(keys.material(share.userId, share.materialId));
  if (!material) throw notFound('This link is no longer valid.');

  const { pk, sk, s3Key, expiresAt, quiz, ...rest } = material;
  return rest;
}
