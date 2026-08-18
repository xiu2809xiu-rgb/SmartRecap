import { createPublicKey, createVerify } from 'node:crypto';
import { unauthorized, HttpError } from './http.js';

/**
 * Verifying a Google ID token.
 *
 * The browser hands us a signed JWT and claims it represents a Google account.
 * That claim is worth nothing until the signature is checked against Google's
 * own public keys — an unverified ID token is just a base64 string anyone can
 * write, and accepting one would let a person sign in as any email they liked.
 *
 * Verified locally rather than by calling Google's `tokeninfo` endpoint. That
 * endpoint is simpler but puts a Google round trip in the middle of every
 * login, and it fails closed if Google is slow. The JWKS is cached for as long
 * as Google's own Cache-Control says, so most logins do no network I/O at all.
 *
 * No dependency: Node can import a JWK directly and verify RS256.
 */

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const VALID_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
// Google's clock and ours will not agree exactly.
const CLOCK_SKEW_SECONDS = 60;

let cache = { keys: null, expiresAt: 0 };

async function getGoogleKeys() {
  if (cache.keys && Date.now() < cache.expiresAt) return cache.keys;

  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new HttpError(502, 'Could not reach Google to verify your sign-in. Try again in a moment.');

  const body = await res.json();
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1]);
  cache = {
    keys: body.keys ?? [],
    // Fall back to an hour if the header is missing; Google rotates slowly.
    expiresAt: Date.now() + (Number.isFinite(maxAge) ? maxAge : 3600) * 1000,
  };
  return cache.keys;
}

const decodeSegment = (segment) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

/**
 * Returns the verified claims, or throws. Never returns unverified data — the
 * whole point is that the caller cannot accidentally use an unchecked token.
 */
export async function verifyGoogleIdToken(credential, expectedAudience) {
  if (!expectedAudience) {
    throw new HttpError(503, 'Google sign-in is not configured on this deployment.');
  }
  if (typeof credential !== 'string' || credential.split('.').length !== 3) {
    throw unauthorized('That Google sign-in was not in a form we could read.');
  }

  const [headerB64, payloadB64, signatureB64] = credential.split('.');

  let header;
  let claims;
  try {
    header = decodeSegment(headerB64);
    claims = decodeSegment(payloadB64);
  } catch {
    throw unauthorized('That Google sign-in could not be decoded.');
  }

  // Only RS256 is accepted. Reading the algorithm out of the token and trusting
  // it is the classic JWT hole — `alg: none` would otherwise verify trivially.
  if (header.alg !== 'RS256') throw unauthorized('Unexpected signing algorithm on the Google token.');

  const keys = await getGoogleKeys();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // A rotated key is the usual cause; drop the cache so a retry refetches.
    cache = { keys: null, expiresAt: 0 };
    throw unauthorized('Google signed that token with a key we do not recognise. Try again.');
  }

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();

  const ok = verifier.verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signatureB64, 'base64url'));
  if (!ok) throw unauthorized('That Google sign-in failed verification.');

  const now = Math.floor(Date.now() / 1000);

  if (!VALID_ISSUERS.has(claims.iss)) throw unauthorized('That token was not issued by Google.');
  // Without this check any Google account from any app could sign in here.
  if (claims.aud !== expectedAudience) throw unauthorized('That Google sign-in was issued for a different app.');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) {
    throw unauthorized('That Google sign-in has expired. Try again.');
  }
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > now) {
    throw unauthorized('That Google sign-in is dated in the future.');
  }
  if (!claims.email) throw unauthorized('Google did not share an email address.');
  // Accounts are linked by email, so an unverified one would let someone claim
  // an address they do not control.
  if (claims.email_verified === false) throw unauthorized('That Google account has an unverified email address.');

  return {
    sub: claims.sub,
    email: String(claims.email).toLowerCase(),
    name: claims.name || String(claims.email).split('@')[0],
    picture: claims.picture ?? null,
  };
}
