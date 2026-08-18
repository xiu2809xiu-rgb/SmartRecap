import { runPipeline } from './pipeline.js';
import { runSourceExtraction } from './sourceExtract.js';
import { runBinderPipeline } from './binderPipeline.js';

/**
 * Routes one background-job payload to the pipeline that handles it.
 *
 * There are now three kinds of async work that get fired-and-forgotten the
 * same way: a Material's full generation (`runPipeline`, no `kind` — kept
 * untagged so existing job payloads already queued or replayed keep working),
 * a single Source's extraction (`source-extract`), and a Binder's recap
 * generation over its ready sources (`binder-generate`).
 *
 * Both hosts route through this one function so `server.js` (EC2, calls it
 * in-process) and `handlers/processor.js` (Lambda, invoked asynchronously)
 * cannot drift on which payload shape goes where — see the note atop
 * `core/pipeline.js` for why the hosts differ only in *how* this gets called.
 */
export async function dispatchBackgroundJob(payload) {
  switch (payload?.kind) {
    case 'source-extract':
      return runSourceExtraction(payload);
    case 'binder-generate':
      return runBinderPipeline(payload);
    default:
      return runPipeline(payload);
  }
}
