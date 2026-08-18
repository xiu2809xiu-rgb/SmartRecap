import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  AdminConfirmSignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { keys, newId, getItem, putItem, deleteItem, queryPrefix, ttlDays } from '../lib/db.js';
import { issueToken } from '../lib/jwt.js';
import { badRequest, conflict, unauthorized, HttpError } from '../lib/http.js';
import { verifyGoogleIdToken } from '../lib/googleToken.js';

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
  picture: u.picture ?? null,
  provider: u.provider ?? 'password',
  createdAt: u.createdAt,
});

/**
 * Moves a guest's library onto a real account.
 *
 * Settings tells a guest their work comes with them when they sign up. Without
 * this it did not: a guest's items live under `USER#<guestId>` and signing up
 * minted a fresh `USER#<newId>`, orphaning everything they had made. A promise
 * the product does not keep is worse than not offering the upgrade at all.
 *
 * DynamoDB cannot rename a partition key, so each item is rewritten under the
 * new one and the original deleted. A student library is tens of items, so a
 * read-then-write pass is fine; it is not a general-purpose migration.
 */
async function claimGuestLibrary(fromUserId, toUserId) {
  const moved = { materials: 0, attempts: 0, cards: 0 };

  for (const [prefix, counter] of [
    ['MATERIAL#', 'materials'],
    ['ATTEMPT#', 'attempts'],
    ['CARDS#', 'cards'],
  ]) {
    const items = await queryPrefix({ pk: `USER#${fromUserId}`, prefix });
    for (const item of items) {
      const { pk, ...rest } = item;
      await putItem({ ...rest, pk: `USER#${toUserId}` });
      await deleteItem({ pk, sk: item.sk });

      // A share link points at the owner by id, so it would 404 after the move.
      // The token is kept on the material precisely so it can be repointed.
      if (item.shareToken) {
        const share = await getItem(keys.share(item.shareToken));
        if (share) await putItem({ ...share, userId: toUserId });
      }
      moved[counter] += 1;
    }
  }

  // The guest profile is left to expire on its own TTL rather than deleted, so
  // a half-finished migration cannot strand a session with no account behind it.
  console.log('Claimed guest library', { fromUserId, toUserId, ...moved });
  return moved;
}

/**
 * `claimFromUserId` is the id from the caller's current token, when that token
 * belongs to a guest. The adapters pass it; a signed-in real user passes null.
 */
export async function signup({ email: rawEmail, password, name: rawName }, claimFromUserId = null) {
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

  let claimed = null;
  if (claimFromUserId && claimFromUserId !== user.id) {
    const previous = await getItem(keys.user(claimFromUserId));
    // Only a guest identity can be claimed. Honouring this for a real account
    // would let anyone who obtained a token migrate someone else's library.
    if (previous?.guest) {
      try {
        claimed = await claimGuestLibrary(claimFromUserId, user.id);
      } catch (e) {
        // The account exists and is usable; losing the migration is bad but
        // failing the whole sign-up over it is worse.
        console.error('Guest library claim failed', claimFromUserId, e?.message);
      }
    }
  }

  return { token: issueToken({ sub: user.id, email, name }), user: publicUser(user), claimed };
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

/**
 * Google sign-in.
 *
 * Accounts are linked by verified email: if someone signed up with a password
 * and later uses Google with the same address, they land in the same account
 * rather than a duplicate. This is only safe because `verifyGoogleIdToken`
 * rejects tokens whose `email_verified` is false — without that check, linking
 * by email would let anyone claim an address they do not own.
 *
 * `claimFromUserId` behaves exactly as it does for `signup`: a guest signing in
 * with Google brings their library with them.
 */
export async function loginWithGoogle({ credential }, claimFromUserId = null) {
  if (!credential) throw badRequest('No Google credential was supplied.');

  const profile = await verifyGoogleIdToken(credential, process.env.GOOGLE_CLIENT_ID);

  const index = await getItem(keys.emailIndex(profile.email));
  let user = index ? await getItem(keys.user(index.userId)) : null;
  const isNew = !user;

  if (user) {
    // Keep the name and avatar in step with the Google account, which is what
    // a student expects after changing them there.
    user = {
      ...user,
      name: profile.name || user.name,
      picture: profile.picture ?? user.picture ?? null,
      googleSub: profile.sub,
      lastSignInAt: new Date().toISOString(),
    };
    await putItem({ ...keys.user(user.id), ...user });
  } else {
    user = {
      id: newId('u'),
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
      googleSub: profile.sub,
      provider: 'google',
      guest: false,
      createdAt: new Date().toISOString(),
    };
    await putItem({ ...keys.user(user.id), ...user });
    await putItem({ ...keys.emailIndex(profile.email), userId: user.id });
  }

  let claimed = null;
  if (isNew && claimFromUserId && claimFromUserId !== user.id) {
    const previous = await getItem(keys.user(claimFromUserId));
    if (previous?.guest) {
      try {
        claimed = await claimGuestLibrary(claimFromUserId, user.id);
      } catch (e) {
        console.error('Guest library claim failed', claimFromUserId, e?.message);
      }
    }
  }

  return {
    token: issueToken({ sub: user.id, email: user.email, name: user.name }),
    user: publicUser(user),
    claimed,
  };
}

export async function me(userId) {
  const user = await getItem(keys.user(userId));
  if (!user) throw unauthorized('That account no longer exists.');
  return publicUser(user);
}
