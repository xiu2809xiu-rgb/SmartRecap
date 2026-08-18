import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { json, noContent, withErrors, parseBody } from '../lib/http.js';
import { requireUser } from '../lib/jwt.js';
import * as auth from '../core/auth.js';
import * as library from '../core/library.js';
import * as study from '../core/study.js';
import * as jobs from '../core/jobs.js';

/**
 * Lambda adapter.
 *
 * This file only translates between API Gateway's event shape and the plain
 * functions in `core/`. The Express server in `server.js` does the same job for
 * EC2 against the identical functions, so the two hosts cannot drift apart.
 */

const lambda = new LambdaClient({});

/**
 * On Lambda a job cannot run here: generation takes 20-40 seconds and API
 * Gateway caps a request at 29. It goes to a second function instead.
 * (`server.js` passes a dispatcher that simply calls `runPipeline` in-process,
 * because an EC2 process is long-lived and has no such cap.)
 */
const dispatchToProcessor = (payload) =>
  lambda.send(
    new InvokeCommand({
      FunctionName: process.env.PROCESSOR_FUNCTION,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );

const publicOrigin = () => (process.env.PUBLIC_WEB_ORIGIN ?? (process.env.ALLOWED_ORIGIN !== '*' ? process.env.ALLOWED_ORIGIN : '') ?? '');

const ROUTES = [
  ['POST', /^\/auth\/signup$/, async (e) => json(201, await auth.signup(parseBody(e)))],
  ['POST', /^\/auth\/login$/, async (e) => json(200, await auth.login(parseBody(e)))],
  ['POST', /^\/auth\/guest$/, async () => json(201, await auth.guest())],
  ['GET', /^\/auth\/me$/, async (e) => json(200, await auth.me(requireUser(e).id))],

  ['GET', /^\/materials$/, async (e) => json(200, await library.listMaterials(requireUser(e).id))],
  ['GET', /^\/materials\/([^/]+)$/, async (e, id) => json(200, await library.getMaterial(requireUser(e).id, id))],
  ['PATCH', /^\/materials\/([^/]+)$/, async (e, id) => json(200, await library.renameMaterial(requireUser(e).id, id, parseBody(e).title))],
  [
    'DELETE',
    /^\/materials\/([^/]+)$/,
    async (e, id) => {
      await library.deleteMaterial(requireUser(e).id, id);
      return noContent();
    },
  ],
  ['GET', /^\/materials\/([^/]+)\/flashcards$/, async (e, id) => json(200, await library.getCards(requireUser(e).id, id))],
  ['PUT', /^\/materials\/([^/]+)\/flashcards$/, async (e, id) => json(200, await library.saveCards(requireUser(e).id, id, parseBody(e).cards))],
  ['POST', /^\/materials\/([^/]+)\/share$/, async (e, id) => json(201, await library.createShare(requireUser(e).id, id, publicOrigin()))],
  ['GET', /^\/shared\/([^/]+)$/, async (_e, token) => json(200, await library.getShared(token))],

  ['POST', /^\/uploads$/, async (e) => json(201, await jobs.createUpload(requireUser(e).id, parseBody(e)))],
  ['POST', /^\/jobs$/, async (e) => json(202, await jobs.startJob(requireUser(e).id, parseBody(e), dispatchToProcessor))],
  ['GET', /^\/jobs\/([^/]+)$/, async (e, id) => json(200, await jobs.getJob(requireUser(e).id, id))],

  ['POST', /^\/quiz\/attempts$/, async (e) => json(201, await study.submitAttempt(requireUser(e).id, parseBody(e)))],
  ['GET', /^\/quiz\/attempts$/, async (e) => json(200, await study.listAttempts(requireUser(e).id, e.queryStringParameters?.materialId))],

  ['POST', /^\/ask$/, async (e) => json(200, await study.ask(requireUser(e).id, parseBody(e)))],
  ['POST', /^\/tts$/, async (e) => json(200, await study.textToSpeech(requireUser(e).id, parseBody(e)))],
];

export const handler = withErrors(async (event) => {
  const method = event.httpMethod ?? event.requestContext?.http?.method;
  if (method === 'OPTIONS') return noContent();

  const path = (event.path ?? event.rawPath ?? '/').replace(/\/+$/, '') || '/';

  for (const [routeMethod, pattern, fn] of ROUTES) {
    if (routeMethod !== method) continue;
    const match = pattern.exec(path);
    if (match) return fn(event, ...match.slice(1).map(decodeURIComponent));
  }

  return json(404, { message: `No route for ${method} ${path}` });
});
