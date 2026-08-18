# Face sign-in — backend contract

The frontend is finished. This is everything you need to make it work.

**Files to fill in:** `backend/src/core/face.js` — two functions, `encodeFace`
and `matchFace`. Everything else (routes, validation, storage, the session
token) is already wired and will start working the moment those two return
real values.

---

## Decide this first

**Store a template, not the photo.** `encodeFace` should return a numeric
descriptor — a face embedding — from which the original image cannot be
reconstructed. Storing student selfies in DynamoDB or S3 makes the team
responsible for a pile of biometric data, and it is not necessary: matching only
needs the vector.

**Face is never the only way in.** Every account keeps its password or its
Google link, and the UI says so. A biometric that can lock someone out of their
own revision the night before an exam is worse than no biometric.

**Rate limit `POST /auth/face`.** It is unauthenticated by design — the face
*is* the credential — which makes it a brute-force target. Something like 5
attempts per IP per minute is enough.

---

## The two functions

```js
// backend/src/core/face.js

/**
 * @param {string} image  data:image/jpeg;base64,... — 480x480, already validated
 * @returns {Promise<number[]>} the descriptor to store on the user record
 * @throws  if no face is found, or more than one
 */
async function encodeFace(image) { ... }

/**
 * @param {string} image  same shape
 * @returns {Promise<string|null>} the matching userId, or null
 */
async function matchFace(image) { ... }
```

`matchFace` **must return `null` rather than a best guess** when nothing clears
your distance threshold. Returning the closest face regardless is how a
recognition system signs someone into a stranger's account.

Where the descriptors live: `faceDescriptor` on the user record,
`pk: USER#<id>, sk: PROFILE`. `enrol`, `status` and `remove` already read and
write it, so you only have to produce the vector.

To find candidates in `matchFace` you need to iterate enrolled users. At this
project's scale a `Scan` filtered on `attribute_exists(faceDescriptor)` is fine.
If it ever is not, add a GSI on a constant partition key — do not reach for a
vector database for a class project.

---

## What the frontend sends and expects

### `POST /auth/face` — sign in *(no auth header)*

```jsonc
// request
{ "image": "data:image/jpeg;base64,/9j/4AAQ..." }   // 480x480 JPEG, q=0.82, ~40-80 KB

// 200 — signed in
{ "token": "<session jwt>", "user": { "id": "u_...", "email": "...", "name": "...", "guest": false } }

// 404 — no match. Rendered as "No match" with a retry button.
{ "message": "That did not match a saved face. Try again, or sign in with your email." }

// 400 — malformed payload
{ "message": "Expected a data:image/jpeg;base64 payload." }
```

### `POST /auth/face/enrol` — save a face *(auth required)*

```jsonc
{ "image": "data:image/jpeg;base64,..." }
// 201
{ "enrolled": true }
```

### `GET /auth/face/status` *(auth required)*

```jsonc
{ "enrolled": true, "enrolledAt": "2026-08-18T09:12:00.000Z" }
```

### `DELETE /auth/face` *(auth required)*

```jsonc
{ "enrolled": false }
```

**Error messages are shown to the student verbatim.** Write them for a person
who does not know what a descriptor is. A 501 from any of these renders as "Not
available yet" rather than an error, so the frontend is safe to ship before you
are done — which it currently is.

---

## Suggested implementation

**`@vladmandic/face-api`** (a maintained fork of face-api.js) runs on Node with
`@tensorflow/tfjs-node` and gives you both functions in about forty lines.

```js
import * as faceapi from '@vladmandic/face-api';
import * as tf from '@tensorflow/tfjs-node';
import canvas from 'canvas';

faceapi.env.monkeyPatch({ Canvas: canvas.Canvas, Image: canvas.Image });
await faceapi.nets.ssdMobilenetv1.loadFromDisk('./models');
await faceapi.nets.faceLandmark68Net.loadFromDisk('./models');
await faceapi.nets.faceRecognitionNet.loadFromDisk('./models');

async function descriptorFrom(image) {
  const img = await canvas.loadImage(Buffer.from(image.split(',')[1], 'base64'));
  const det = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
  return det ? Array.from(det.descriptor) : null;   // 128 floats
}
```

Match with euclidean distance; **0.6 is the conventional threshold** for that
model. Lower is stricter. Test with real faces before trusting it — and test
with two different people, not just yourself twice.

**On EC2 this needs native modules.** `@tensorflow/tfjs-node` and `canvas` both
compile at install time, so the box needs `gcc-c++`, `make`, `cairo-devel`,
`libjpeg-turbo-devel` and `pango-devel`. That is another reason `.npmrc` sets
`omit=optional` — do not let the main install start pulling native builds by
accident. Budget half an hour for this the first time.

Alternative if the native build fights you: **AWS Rekognition** has
`IndexFaces` and `SearchFacesByImage`, is available in Learner Lab, and needs no
native modules at all. It costs about $1 per 1,000 images, and it would mean
face images pass through an AWS service rather than staying in your own process
— worth a sentence in the privacy copy if you go that way.

---

## Testing without a real face

`/auth/face` returns 501 today, and the frontend renders that as a normal
"cannot do this right now" state, so the flow is walkable end to end already.

To test the happy path before recognition works, stub `matchFace` to return a
known user id:

```js
async function matchFace() {
  return process.env.FACE_STUB_USER_ID ?? null;
}
```

Then set `FACE_STUB_USER_ID` in `/etc/smartrecap.env`. **Do not deploy that.**

---

## What the frontend already handles

You do not need to build any of this:

- Consent before the camera is ever requested
- Permission denied, no camera present, camera in use by another app, and
  non-HTTPS origins — each with its own message
- Camera teardown on close, cancel, success, failure, unmount, and tab hidden
- A 3-2-1 countdown, square centre crop, and JPEG compression to keep the
  payload small
- Retry, and a fallback to email sign-in from every failure state
- Enrolment and removal in Settings, including the "not available yet" state

Files: `src/components/auth/FaceSignIn.jsx`,
`src/components/auth/FaceEnrolment.jsx`, and the API client in
`src/lib/api.js`.
