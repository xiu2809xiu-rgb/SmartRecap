import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { unauthorized } from './http.js';

/**
 * Session tokens.
 *
 * The API mints its own HS256 token rather than passing Cognito's through.
 * Real sign-ups authenticate against the Cognito user pool first, then get one
 * of these; guests get one directly with no Cognito user behind it. One token
 * format means one verification path, and it means a Cognito outage or a
 * Learner Lab quirk can never lock a demo out of the guest route.
 *
 * Written with node:crypto rather than a library so the Lambda bundle stays
 * small — this is ~60 lines of well-understood code.
 */

const SECRET = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not configured');
  return s;
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');

const sign = (data) => createHmac('sha256', SECRET()).update(data).digest();

export const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function issueToken(claims, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds, jti: randomBytes(8).toString('hex') }),
  );
  const body = `${header}.${payload}`;
  return `${body}.${b64url(sign(body))}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') throw unauthorized();
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('Malformed session token.');

  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`);
  const given = fromB64url(signature);

  // Length check first: timingSafeEqual throws on a length mismatch, and that
  // throw is itself a side channel.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw unauthorized('Session token failed verification.');
  }

  let claims;
  try {
    claims = JSON.parse(fromB64url(payload).toString('utf8'));
  } catch {
    throw unauthorized('Malformed session token.');
  }

  if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) {
    throw unauthorized('Your session has expired. Sign in again.');
  }
  return claims;
}

/** Pulls the bearer token off an API Gateway event and returns its claims. */
export function requireUser(event) {
  const header = event.headers?.Authorization ?? event.headers?.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw unauthorized();
  const claims = verifyToken(token);
  if (!claims.sub) throw unauthorized('Session token is missing a subject.');
  return { id: claims.sub, email: claims.email ?? null, name: claims.name ?? 'Student', guest: !!claims.guest };
}

/* ---------------------------------------------------------------------------
   Password hashing for the guest-upgrade path. Cognito owns real passwords;
   this exists only so a guest account can be converted without a round trip.
   ------------------------------------------------------------------------ */

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = createHmac('sha256', salt).update(password).digest('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt] = String(stored).split(':');
  if (!salt) return false;
  const candidate = Buffer.from(hashPassword(password, salt));
  const expected = Buffer.from(stored);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
