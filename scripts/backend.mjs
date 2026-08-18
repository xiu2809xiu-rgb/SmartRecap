/**
 * Starts (or sets up) the FastAPI backend using the project's own virtualenv.
 *
 * `npm run backend:dev` used to invoke a bare `python`, which on Windows
 * resolves to the Microsoft Store shim — a different interpreter from the one
 * `backend/.venv` was built with. The result was "No module named uvicorn" even
 * with a venv sitting right there, and the obvious next move (installing
 * uvicorn) puts it in the wrong Python and still does not work.
 *
 * So the venv is located explicitly, and if anything is missing the error says
 * which command fixes it instead of naming a module.
 *
 *   node scripts/backend.mjs setup   create the venv and install dependencies
 *   node scripts/backend.mjs dev     run the API on :8000
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backend = join(root, 'backend');
const isWindows = process.platform === 'win32';

const venvPython = join(backend, '.venv', isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python');

const die = (...lines) => {
  console.error(`\n${lines.join('\n')}\n`);
  process.exit(1);
};

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

/** The interpreter to build the venv FROM. */
function basePython() {
  // The `py` launcher is the reliable way to pick a version on Windows, and
  // the ML dependencies do not publish wheels for the newest interpreters —
  // hence asking for an older one first rather than taking whatever `python`
  // happens to be.
  const candidates = isWindows
    ? [['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.13']], ['python', []]]
    : [['python3.12', []], ['python3.11', []], ['python3', []]];

  for (const [cmd, prefix] of candidates) {
    const probe = spawnSync(cmd, [...prefix, '--version'], { encoding: 'utf8' });
    if (probe.status === 0) return [cmd, prefix];
  }
  return null;
}

const mode = process.argv[2];

if (mode === 'setup') {
  if (!existsSync(venvPython)) {
    const base = basePython();
    if (!base) die('No Python found. Install Python 3.12 from https://www.python.org/downloads/ and try again.');
    const [cmd, prefix] = base;
    console.log(`Creating backend/.venv with ${cmd} ${prefix.join(' ')}`.trim());
    const made = run(cmd, [...prefix, '-m', 'venv', join(backend, '.venv')]);
    if (made.status !== 0) die('Could not create backend/.venv.');
  }

  // The light set by default: the OCR stack (torch, paddle, pix2text) is
  // imported lazily inside functions, so the API runs without it and only
  // scanned-document OCR is unavailable. Installing all of requirements.txt
  // takes 20-40 minutes and several GB, and does not build on every
  // interpreter — see docs/RUN-LOCALLY.md.
  const full = process.argv.includes('--full');
  const file = join(backend, full ? 'requirements.txt' : 'requirements-dev.txt');
  console.log(`Installing ${full ? 'the FULL stack (this takes a while)' : 'the light dependency set'} from ${file}`);
  const installed = run(venvPython, ['-m', 'pip', 'install', '-r', file]);
  if (installed.status !== 0) die('Dependency install failed. See the output above.');

  console.log('\nDone. Start the API with:  npm run backend:dev\n');
  process.exit(0);
}

if (!existsSync(venvPython)) {
  die(
    'The backend virtualenv does not exist yet.',
    '',
    '  npm run backend:setup',
    '',
    'Then start it with:  npm run backend:dev',
  );
}

const hasUvicorn = spawnSync(venvPython, ['-c', 'import uvicorn'], { stdio: 'ignore' }).status === 0;
if (!hasUvicorn) {
  die(
    'The backend virtualenv exists but has no dependencies installed.',
    '',
    '  npm run backend:setup',
  );
}

const result = run(venvPython, [
  '-m',
  'uvicorn',
  'app.main:app',
  '--app-dir',
  backend,
  '--port',
  '8000',
  '--reload',
]);
process.exit(result.status ?? 0);
