const ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const baseHeaders = () => ({
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  ...(ORIGIN === '*' ? {} : { Vary: 'Origin' }),
});

export const json = (statusCode, body) => ({
  statusCode,
  headers: baseHeaders(),
  body: body === undefined ? '' : JSON.stringify(body),
});

export const noContent = () => ({ statusCode: 204, headers: baseHeaders(), body: '' });

/**
 * Errors that are safe to show a user.
 *
 * Anything thrown that is not an HttpError becomes a generic 500 — an
 * unexpected stack trace should never reach the browser, but it should always
 * reach CloudWatch.
 */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (m, d) => new HttpError(400, m, d);
export const unauthorized = (m = 'Sign in to continue.') => new HttpError(401, m);
export const forbidden = (m = 'You do not have access to that.') => new HttpError(403, m);
export const notFound = (m = 'Not found.') => new HttpError(404, m);
export const conflict = (m) => new HttpError(409, m);
export const tooLarge = (m) => new HttpError(413, m);
export const upstream = (m, d) => new HttpError(502, m, d);

export function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest('Request body was not valid JSON.');
  }
}

export function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) throw badRequest(`Missing required ${missing.length === 1 ? 'field' : 'fields'}: ${missing.join(', ')}`);
  return body;
}

/** Wraps a handler so thrown HttpErrors become responses and nothing else leaks. */
export function withErrors(fn) {
  return async (event, context) => {
    try {
      return await fn(event, context);
    } catch (e) {
      if (e instanceof HttpError) {
        return json(e.status, { message: e.message, ...(e.details ? { details: e.details } : null) });
      }
      console.error('Unhandled error', { message: e?.message, stack: e?.stack });
      return json(500, { message: 'Something went wrong on our side. Try again in a moment.' });
    }
  };
}
