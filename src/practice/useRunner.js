import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Owns the worker that runs student code, and the ability to kill it.
 *
 * The timeout lives here rather than in the worker on purpose. A `while True:`
 * inside the interpreter never yields, so the worker cannot time itself out —
 * only something outside it can, and `terminate()` is the only thing that
 * reliably stops running WASM. When that happens the worker is gone for good,
 * so the next run starts a fresh one.
 *
 * The cost of terminating is that Pyodide has to load again on the next Python
 * run. That is the correct trade: an infinite loop is a normal thing for a
 * student to write while learning loops, and a page that has to be reloaded to
 * recover from it is a page they stop using.
 */

const TIMEOUT_MS = 10_000;

// Vite rewrites this to the hashed worker chunk. `type: 'module'` so the worker
// can dynamically import the Pyodide runtime.
const spawn = () => new Worker(new URL('./runner.worker.js', import.meta.url), { type: 'module' });

export default function useRunner() {
  const workerRef = useRef(null);
  const pendingRef = useRef(null);
  const timerRef = useRef(null);
  const seqRef = useRef(0);

  const [state, setState] = useState({ status: 'idle' });

  const teardown = useCallback(() => {
    clearTimeout(timerRef.current);
    workerRef.current?.terminate();
    workerRef.current = null;
    pendingRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;
    const worker = spawn();
    worker.onmessage = (event) => {
      const { id, type, phase, ...rest } = event.data ?? {};
      const pending = pendingRef.current;
      // A message from a run we already gave up on. Ignore it rather than
      // letting a late result overwrite the timeout the student was shown.
      if (!pending || pending.id !== id) return;

      if (type === 'status') {
        setState({ status: 'running', phase });
        return;
      }
      clearTimeout(timerRef.current);
      pendingRef.current = null;
      setState({ status: 'done', ...rest });
      pending.resolve(rest);
    };
    worker.onerror = (event) => {
      const pending = pendingRef.current;
      clearTimeout(timerRef.current);
      pendingRef.current = null;
      teardown();
      const result = {
        ok: false,
        tests: [],
        stdout: '',
        error: event?.message ?? 'The code runner could not start.',
      };
      setState({ status: 'done', ...result });
      pending?.resolve(result);
    };
    workerRef.current = worker;
    return worker;
  }, [teardown]);

  const run = useCallback(
    ({ language, code, tests }) =>
      new Promise((resolve) => {
        const id = (seqRef.current += 1);
        const worker = ensureWorker();
        pendingRef.current = { id, resolve };
        setState({ status: 'running', phase: 'running' });

        timerRef.current = setTimeout(() => {
          teardown();
          const result = {
            ok: false,
            tests: [],
            stdout: '',
            timedOut: true,
            error: `Stopped after ${TIMEOUT_MS / 1000} seconds. Something is not finishing — check for a loop whose condition never becomes false.`,
          };
          setState({ status: 'done', ...result });
          resolve(result);
        }, TIMEOUT_MS);

        worker.postMessage({
          id,
          language,
          code,
          tests,
          // The app is not guaranteed to be served from the domain root, and
          // the worker has no router to ask.
          base: import.meta.env.BASE_URL,
        });
      }),
    [ensureWorker, teardown],
  );

  const reset = useCallback(() => {
    teardown();
    setState({ status: 'idle' });
  }, [teardown]);

  return { run, reset, state };
}
