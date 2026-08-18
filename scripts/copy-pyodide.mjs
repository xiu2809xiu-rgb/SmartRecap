/**
 * Copies the Pyodide runtime out of node_modules into `public/pyodide/`.
 *
 * Why not just point at a CDN: the practice panel has to work on conference
 * wifi and in demo mode with no backend, which is the promise the rest of the
 * app already makes (see docs/DEMO-SCRIPT.md — the offline fallback is the last
 * row of the failure table). A CDN fetch is a dependency on the network being
 * good at exactly the moment it is worst.
 *
 * Why not commit the files: they are 13 MB of build output that changes only
 * when the dependency version changes. `public/pyodide/` is gitignored and this
 * runs from `predev` and `prebuild`, so a fresh clone gets it from `npm i`.
 *
 * Only the five files the runtime actually loads are copied. The package also
 * ships source maps, type definitions and two demo HTML pages, none of which
 * belong in a deployment.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'pyodide');
const to = join(root, 'public', 'pyodide');

const FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

if (!existsSync(from)) {
  // Not fatal. The practice panel probes for the runtime before offering it
  // and falls back to JavaScript, so a missing Pyodide degrades rather than
  // breaks the build.
  console.warn('[pyodide] not installed — skipping. Python practice will be unavailable.');
  process.exit(0);
}

mkdirSync(to, { recursive: true });

let copied = 0;
let bytes = 0;
for (const file of FILES) {
  const src = join(from, file);
  if (!existsSync(src)) {
    console.warn(`[pyodide] missing ${file} — the runtime may not load.`);
    continue;
  }
  const dest = join(to, file);
  const size = statSync(src).size;
  // Skip unchanged files so a rebuild does not rewrite 13 MB every time.
  if (existsSync(dest) && statSync(dest).size === size) continue;
  copyFileSync(src, dest);
  copied += 1;
  bytes += size;
}

if (copied) console.log(`[pyodide] copied ${copied} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB → public/pyodide/`);
