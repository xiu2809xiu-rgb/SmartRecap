import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  AdminConfirmSignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { keys, newId, getItem, putItem, ttlDays } from '../lib/db.js';
import { issueToken } from '../lib/jwt.js';
import { badRequest, conflict, unauthorized, HttpError } from '../lib/http.js';

/**
 * Identity, as plain functions.
 *
 * Nothing here knows about API Gateway events or Express requests — the two
 * adapters (`handlers/api.js` for Lambda, `server.js` for EC2) each turn their
 * own request shape into these arguments. That is the whole point of the
 * `core/` layer: the business logic is portable between the two hosts, so
 * choosing EC2 does not mean rewriting it.
 */

const cognito = new CognitoIdentityProviderClient({});

export const publicUser = (u) => ({
  id: u.id,
  email: u.email ?? null,
  name: u.name,
  guest: !!u.guest,
  createdAt: u.createdAt,
});

export async function signup({ email: rawEmail, password, name: rawName }) {
  if (!rawEmail || !password) throw badRequest('Email and password are required.');
  const email = String(rawEmail).trim().toLowerCase();
  const name = String(rawName ?? '').trim() || email.split('@')[0];

  const existing = await getItem(keys.emailIndex(email));
  if (existing) throw conflict('An account already uses that email.');

  try {
    await cognito.send(
      new SignUpCommand({
        ClientId: process.env.USER_POOL_CLIENT_ID,
        Username: email,
        Password: password,
        UserAttributes: [{ Name: 'name', Value: name }],
      }),
    );
    // No email delivery is configured — SES would need an IAM role Learner Lab
    // cannot create — so accounts are confirmed immediately. A production
    // deployment would send a verification code instead.
    await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: process.env.USER_POOL_ID, Username: email }));
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

  return { token: issueToken({ sub: user.id, email, name }), user: publicUser(user) };
}

export async function login({ email: rawEmail, password }) {
  if (!rawEmail || !password) throw badRequest('Email and password are required.');
  const email = String(rawEmail).trim().toLowerCase();

  try {
    await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: process.env.USER_POOL_CLIENT_ID,
        AuthParameters: { USERNAME: email, PASSWORD: password },
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

  return { token: issueToken({ sub: user.id, email: user.email, name: user.name }), user: publicUser(user) };
}

/**
 * A guest gets a real, scoped identity rather than a client-side pretence, so
 * the same authorizer protects every route and the same partitioning keeps
 * their material private. The TTL clears abandoned guest data out of a finite
 * credit budget on its own.
 */
export async function guest() {
  const user = {
    id: newId('g'),
    email: null,
    name: 'Guest',
    guest: true,
    createdAt: new Date().toISOString(),
    expiresAt: ttlDays(30),
  };
  await putItem({ ...keys.user(user.id), ...user });
  return { token: issueToken({ sub: user.id, name: user.name, guest: true }), user: publicUser(user) };
}

export async function me(userId) {
  const user = await getItem(keys.user(userId));
  if (!user) throw unauthorized('That account no longer exists.');
  return publicUser(user);
}
