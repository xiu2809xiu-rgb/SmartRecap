import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-24-chars';

const { issueToken, verifyToken, requireUser, hashPassword, verifyPassword } = await import('../src/lib/jwt.js');

/**
 * Session tokens.
 *
 * These are hand-rolled on node:crypto rather than pulled from a library, which
 * is a reasonable trade for ~60 lines — but only if the forgery paths are
 * actually tested. Every case below is a way an attacker would try to get in.
 */

test('a freshly issued token round-trips', () => {
  const claims = verifyToken(issueToken({ sub: 'u_1', email: 'a@b.com', name: 'Ada' }));
  assert.equal(claims.sub, 'u_1');
  assert.equal(claims.email, 'a@b.com');
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));
});

test('a tampered payload is rejected', () => {
  const [header, payload, signature] = issueToken({ sub: 'u_1' }).split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: 2 ** 31 })).toString('base64url');
  assert.throws(() => verifyToken(`${header}.${forged}.${signature}`), /verification/i);
});

test('a token signed with a different secret is rejected', () => {
  const token = issueToken({ sub: 'u_1' });
  const original = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'a-completely-different-secret-value';
  try {
    assert.throws(() => verifyToken(token), /verification/i);
  } finally {
    process.env.JWT_SECRET = original;
  }
});

test('the alg=none forgery is rejected', () => {
  // Swapping the header to {"alg":"none"} and dropping the signature is the
  // classic JWT bypass. This implementation never reads `alg`, so the
  // signature check catches it — but assert that, do not assume it.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'admin', exp: 2 ** 31 })).toString('base64url');
  assert.throws(() => verifyToken(`${header}.${payload}.`), /verification|Malformed/i);
});

test('an expired token is rejected with a message that says so', () => {
  assert.throws(() => verifyToken(issueToken({ sub: 'u_1' }, -10)), /expired/i);
});

test('garbage is rejected rather than throwing something unhandled', () => {
  for (const bad of ['', 'not-a-token', 'a.b', 'a.b.c.d', null, undefined, 42]) {
    assert.throws(() => verifyToken(bad), /Malformed|verification|Sign in/i, `accepted: ${String(bad)}`);
  }
});

test('requireUser reads a bearer header and rejects everything else', () => {
  const token = issueToken({ sub: 'g_1', name: 'Guest', guest: true });
  const user = requireUser({ headers: { Authorization: `Bearer ${token}` } });
  assert.equal(user.id, 'g_1');
  assert.equal(user.guest, true);

  // Lowercase header name, as API Gateway sometimes delivers it.
  assert.equal(requireUser({ headers: { authorization: `bearer ${token}` } }).id, 'g_1');

  assert.throws(() => requireUser({ headers: {} }), /Sign in/i);
  assert.throws(() => requireUser({ headers: { Authorization: token } }), /Sign in/i);
  assert.throws(() => requireUser({ headers: { Authorization: `Basic ${token}` } }), /Sign in/i);
});

test('password hashing is salted and verifies only the right password', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.notEqual(stored, hashPassword('correct horse battery staple'), 'salt should differ per call');
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
  assert.equal(verifyPassword('wrong password', stored), false);
  assert.equal(verifyPassword('x', 'not-a-valid-stored-value'), false);
});
