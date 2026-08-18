import { dispatchBackgroundJob } from '../core/dispatch.js';

/**
 * Lambda adapter for every background pipeline (Material generation, Source
 * extraction, Binder generation).
 *
 * The work itself lives in `core/` so the EC2 server can call it directly —
 * there it runs in-process, because a long-lived server has no 29-second
 * gateway timeout to work around.
 */
export const handler = async (event) => dispatchBackgroundJob(event);
