import { keys, getItem, putItem, updateItem } from '../lib/db.js';
import { badRequest, HttpError } from '../lib/http.js';

/**
 * Face sign-in — the seam, not the implementation.
 *
 * The recognition itself is owned by whoever is building it; these functions
 * exist so the frontend has real routes to call, real error shapes to render,
 * and a contract that cannot drift. Every one of them throws 501 until
 * `matchFace` and `encodeFace` below are filled in.
 *
 * The full contract, including payload shapes and the storage decision that has
 * to be made before this ships, is in docs/FACE-AUTH-CONTRACT.md.
 *
 * Two things are already decided, and should stay decided:
 *
 *   1. **Face is never the only way in.** Every account keeps its password or
 *      its Google link. A biometric that can lock you out of your own revision
 *      the night before an exam is a worse feature than no biometric.
 *   2. **Store a template, never the photo.** What gets persisted should be a
 *      numeric descriptor from which the original face cannot be reconstructed.
 *      A bucket of student selfies is a liability nobody on a hackathon team
 *      wants to be responsible for.
 */

const MAX_IMAGE_BYTES = 400 * 1024;

/** Rejects payloads that are not a plausible JPEG data URL before doing work. */
function assertImage(image) {
  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    throw badRequest('Expected a data:image/jpeg;base64 payload.');
  }
  // base64 is 4 characters per 3 bytes.
  if (image.length * 0.75 > MAX_IMAGE_BYTES) {
    throw badRequest('That image is too large. The client should send a 480px JPEG.');
  }
}

const notImplemented = (what) =>
  new HttpError(
    501,
    `Face ${what} is not connected yet. Sign in with your email or Google instead.`,
    { contract: 'docs/FACE-AUTH-CONTRACT.md' },
  );

/* ------------------------------------------------------------ to implement */

/**
 * Turn a captured frame into a stored template.
 * @returns {Promise<number[]>} descriptor, e.g. a 128-float face embedding
 */
// eslint-disable-next-line no-unused-vars
async function encodeFace(image) {
  throw notImplemented('enrolment');
}

/**
 * Find the account whose stored template matches this frame.
 * Must return null rather than a guess when nothing is close enough — the
 * threshold decision belongs here, not in the route.
 * @returns {Promise<string|null>} userId
 */
// eslint-disable-next-line no-unused-vars
async function matchFace(image) {
  throw notImplemented('sign-in');
}

/* -------------------------------------------------------------- the routes */

export async function enrol(userId, { image }) {
  assertImage(image);
  const descriptor = await encodeFace(image);
  await updateItem(keys.user(userId), { faceDescriptor: descriptor, faceEnrolledAt: new Date().toISOString() });
  return { enrolled: true };
}

export async function status(userId) {
  const user = await getItem(keys.user(userId));
  return { enrolled: !!user?.faceDescriptor, enrolledAt: user?.faceEnrolledAt ?? null };
}

export async function remove(userId) {
  // Written as null rather than removed, so "was enrolled, now is not" stays
  // distinguishable from "never enrolled" if that ever matters for support.
  await updateItem(keys.user(userId), { faceDescriptor: null, faceEnrolledAt: null });
  return { enrolled: false };
}

/**
 * Unauthenticated by nature — the face IS the credential. That is exactly why
 * the implementation behind `matchFace` needs rate limiting: an endpoint that
 * accepts unlimited anonymous images and returns a session on a match is a
 * brute-force target.
 */
export async function signIn({ image }) {
  assertImage(image);
  const userId = await matchFace(image);
  if (!userId) throw new HttpError(404, 'That did not match a saved face. Try again, or sign in with your email.');

  const user = await getItem(keys.user(userId));
  if (!user) throw new HttpError(404, 'That did not match a saved face.');

  const { issueToken } = await import('../lib/jwt.js');
  const { publicUser } = await import('./auth.js');
  await putItem({ ...user, lastSignInAt: new Date().toISOString() });

  return { token: issueToken({ sub: user.id, email: user.email, name: user.name }), user: publicUser(user) };
}
