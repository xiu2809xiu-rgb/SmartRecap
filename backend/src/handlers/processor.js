import { runPipeline } from '../core/pipeline.js';

/**
 * Lambda adapter for the pipeline.
 *
 * The work itself lives in `core/pipeline.js` so the EC2 server can call it
 * directly — there it runs in-process, because a long-lived server has no
 * 29-second gateway timeout to work around.
 */
export const handler = async (event) => runPipeline(event);
