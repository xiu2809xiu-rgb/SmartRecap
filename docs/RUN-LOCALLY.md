# Running SmartRecap locally

**Two terminals. The frontend alone is not enough** — it proxies `/api` to the
backend, and with nothing listening every sign-in fails.

```bash
# Terminal 1 — the API on :8000
npm run backend:setup     # once
npm run backend:dev

# Terminal 2 — the app on :5173
npm run dev
```

Then open <http://localhost:5173>.

---

## What `backend:setup` installs, and what it leaves out

The light set in `backend/requirements-dev.txt` — roughly 150 MB, a couple of
minutes.

It deliberately skips the OCR stack in `requirements.txt` (torch,
paddlepaddle, paddleocr, pix2text, opencv): several GB, 20–40 minutes, and no
wheels for every interpreter. Those imports are **lazy**, inside the functions
that use them (`extractors.py:301`, `:428`), so the API starts and serves
without them.

What you give up locally: OCR of scanned PDFs and photos of handwriting. Text
PDFs, PowerPoint, Word, plain text and Markdown all extract normally — every
demo path works.

The deployed instance should have the full stack:

```bash
npm run backend:setup -- --full
```

---

## Python version

The pinned ML stack does not publish wheels for the newest interpreters. **Use
Python 3.12 or 3.11.** `backend:setup` asks the `py` launcher for one of those
before falling back.

Check what you have:

```powershell
py --list
```

If you only have 3.13 or 3.14, the light set still installs fine and the app
runs; only `--full` needs an older interpreter.

---

## Secrets

`backend/.env` — gitignored, never commit it. Copy `backend/.env.example`.

| Variable | Effect if missing |
|---|---|
| `GEMINI_API_KEY` / `AZURE_AI_*` / `OPENAI_API_KEY` | `/api/health` reports `ai_configured: false` and recaps fall back to a local extractive summary rather than a written one. The app works; the output is weaker |
| `GOOGLE_CLIENT_ID` | Google sign-in returns 503. Must match `VITE_GOOGLE_CLIENT_ID` in `.env.local` exactly, or every attempt fails with "could not be verified" while email sign-in still works |

Check what the running backend thinks:

```bash
curl http://127.0.0.1:8000/api/health
```

---

## Without a backend at all

```bash
VITE_USE_MOCK_API=true npm run dev
```

Serves the whole app from `src/lib/mockApi.js` against the bundled sample
material — no Python, no keys, no network. Every screen works; nothing calls a
model. This is the fallback in the demo runbook if the backend dies on stage.

---

## When it does not work

| Symptom | Cause |
|---|---|
| `No module named uvicorn` | Dependencies are not in the venv. `npm run backend:setup`. This used to happen because the npm script called a bare `python` — the Windows Store shim — instead of `backend/.venv` |
| Sign-in shows "The SmartRecap API is not responding" | Terminal 1 is not running, or it crashed. Check its output |
| `Port 8000 is already in use` | An older backend is still running. `netstat -ano \| findstr :8000` then `taskkill /PID <pid> /F` |
| Recaps come back thin and generic | `ai_configured: false` — no model key in `backend/.env`. The extractive fallback is working as designed |
| Google sign-in fails, email works | `GOOGLE_CLIENT_ID` missing or not matching the frontend's |
| Uploads of scanned PDFs fail | Expected on the light set. Use a text-based PDF, or install with `--full` |
