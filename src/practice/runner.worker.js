/**
 * Runs a student's code and checks it against the exercise's tests.
 *
 * In a worker for one reason above all others: a student learning loops writes
 * an infinite loop, and there has to be something the page can kill. A worker
 * can be terminated from the outside mid-execution; a promise on the main
 * thread cannot, and neither can a WASM interpreter that has stopped yielding.
 * The main thread owns the timeout and the terminate — see `useRunner.js`.
 *
 * Both languages run in the browser. Nothing a student writes here is sent
 * anywhere, which is the right default for a study tool and also means the
 * feature costs nothing to operate and cannot be taken down by a lab session
 * expiring.
 *
 * Tests are expression/expected pairs so one protocol covers both languages:
 * evaluate the call, evaluate the expected value, compare. No test framework is
 * shipped to the browser in either language.
 */

let pyodide = null;
let pyodideLoading = null;

/* -------------------------------------------------------------- javascript */

const fmt = (v) => {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

// Enough for the value shapes the prompt allows: numbers, strings, booleans,
// null, and arrays of those. Deliberately not a general deep-equal.
const same = (a, b) => {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

function runJavaScript(code, tests) {
  const out = [];
  const capture = {
    log: (...args) => out.push(args.map((a) => (typeof a === 'string' ? a : fmt(a))).join(' ')),
  };
  capture.info = capture.log;
  capture.warn = capture.log;
  capture.error = capture.log;

  // `eval` inside the function body is a direct eval, so it sees whatever the
  // student declared above it. That is what lets a test call their function
  // without us having to guess how they exported it.
  const source = `
${code}
;return __TESTS.map(function (t) {
  try {
    var actual = eval(t.call);
    var want = eval(t.expect);
    return { call: t.call, expect: t.expect, actual: __fmt(actual), pass: __same(actual, want) };
  } catch (e) {
    return { call: t.call, expect: t.expect, actual: String(e && e.message ? e.name + ': ' + e.message : e), pass: false };
  }
});`;

  try {
    const runner = new Function('__TESTS', '__fmt', '__same', 'console', source);
    const results = runner(tests, fmt, same, capture);
    return { ok: true, stdout: out.join('\n'), tests: results };
  } catch (e) {
    // A syntax error or a throw at top level — the student's code never got as
    // far as defining anything, so there is nothing to test.
    return { ok: false, stdout: out.join('\n'), error: `${e?.name ?? 'Error'}: ${e?.message ?? e}`, tests: [] };
  }
}

/* ------------------------------------------------------------------ python */

async function loadPyodide(base) {
  if (pyodide) return pyodide;
  if (!pyodideLoading) {
    pyodideLoading = (async () => {
      const indexURL = `${base}pyodide/`;
      // Vite must not try to resolve this at build time: the runtime is copied
      // into public/ by scripts/copy-pyodide.mjs and served as a static asset,
      // so it is a URL, not a module in the graph.
      const mod = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
      pyodide = await mod.loadPyodide({ indexURL });
      return pyodide;
    })();
  }
  return pyodideLoading;
}

// The harness runs after the student's code, in the same globals, so their
// definitions are in scope. Tests arrive as a JSON literal rather than through
// a JS→Python proxy, which keeps the boundary to one well-understood type.
const PY_HARNESS = `
import json as __json

def __smartrecap_check(__spec):
    __out = []
    for __t in __json.loads(__spec):
        try:
            __actual = eval(__t["call"], globals())
            __want = eval(__t["expect"], globals())
            __out.append({
                "call": __t["call"],
                "expect": __t["expect"],
                "actual": repr(__actual),
                "pass": bool(__actual == __want),
            })
        except Exception as __e:
            __out.append({
                "call": __t["call"],
                "expect": __t["expect"],
                "actual": "%s: %s" % (type(__e).__name__, __e),
                "pass": False,
            })
    return __json.dumps(__out)
`;

async function runPython(code, tests, base) {
  const py = await loadPyodide(base);
  const out = [];
  const err = [];
  py.setStdout({ batched: (s) => out.push(s) });
  py.setStderr({ batched: (s) => err.push(s) });

  // A fresh namespace per run, not Pyodide's shared module globals.
  //
  // The interpreter outlives a single run, so with shared globals a function
  // the student defined earlier is still bound on the next attempt. Delete it,
  // or rename it, and the tests keep calling the previous definition and keep
  // passing — the student is told working code works when what is in the
  // editor does nothing. A false pass is the worst failure a learning tool
  // has, so each attempt gets its own namespace and sees only itself.
  const namespace = py.globals.get('dict')();

  try {
    try {
      await py.runPythonAsync(code, { globals: namespace });
    } catch (e) {
      // Their code did not compile or threw on the way in. The traceback's
      // last few lines are the part that names the line and the mistake;
      // everything above it is our harness.
      return {
        ok: false,
        stdout: out.join('\n'),
        error: String(e?.message ?? e).trim().split('\n').slice(-6).join('\n'),
        tests: [],
      };
    }

    try {
      py.runPython(PY_HARNESS, { globals: namespace });
      const json = py.runPython(`__smartrecap_check(${JSON.stringify(JSON.stringify(tests))})`, {
        globals: namespace,
      });
      return { ok: true, stdout: out.join('\n'), stderr: err.join('\n'), tests: JSON.parse(json) };
    } catch (e) {
      return { ok: false, stdout: out.join('\n'), error: String(e?.message ?? e), tests: [] };
    }
  } finally {
    // PyProxies are not garbage collected from the JS side; leaking one per
    // run would grow the heap for as long as the page is open.
    namespace.destroy();
  }
}

/* ---------------------------------------------------------------- protocol */

self.onmessage = async (event) => {
  const { id, language, code, tests, base } = event.data ?? {};
  try {
    if (language === 'python') {
      // Loading the runtime is the slow part and only happens once per worker,
      // so the page is told about it separately from "running".
      if (!pyodide) self.postMessage({ id, type: 'status', phase: 'loading-runtime' });
      const result = await runPython(code, tests ?? [], base ?? '/');
      self.postMessage({ id, type: 'result', ...result });
      return;
    }
    self.postMessage({ id, type: 'result', ...runJavaScript(code, tests ?? []) });
  } catch (e) {
    self.postMessage({
      id,
      type: 'result',
      ok: false,
      stdout: '',
      error: e?.message ?? 'The runner failed unexpectedly.',
      tests: [],
    });
  }
};
