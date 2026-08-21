# SmartRecap

Turns lecture slides and notes into a structured recap and a revision quiz —
where every line of the recap points back at the slide it came from, and
anything the model could not trace to the source is dropped before the student
sees it.

Built for the Nanyang Polytechnic Cloud Computing Club AWS hackathon,
**Problem Statement 1: Automated Class Recap Generator.** The active cloud path
uses **AWS Amplify Hosting** for React and **Amazon EC2 `t3.xlarge`** for the
FastAPI/OCR/AI backend; see [`docs/AWS-HACKATHON.md`](docs/AWS-HACKATHON.md).

---

## The idea

Any model will summarise a deck. The problem is that a student cannot check the
summary without re-reading the deck — which is exactly the work the tool was
supposed to save. A recap you have to verify costs the same time as the original
and adds doubt.

So SmartRecap is built around one constraint: **every claim must be traceable to
a specific slide, and untraceable claims must not appear as fact.**

Hover any line in the reader and a lit thread is drawn from it to the extracted
passage it was written from. Claims that could not be traced are listed
separately as dropped, with the reason. Quiz questions the material does not
settle are shown, explained, and excluded from your score.

---

## Running it

Start the active FastAPI backend from the repository root:

```powershell
backend\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Then start Vite in another terminal:

```powershell
npm install
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` and `/ws` to FastAPI. To use
the bundled offline sample instead, set `VITE_USE_MOCK_API=true`; mock mode is
explicit and never presented as real AI output.

For production, follow `docs/AWS-HACKATHON.md`. The Amplify build must use the
CloudFormation `ApiBaseUrl`, including its `/api` suffix:

```dotenv
VITE_API_BASE_URL=https://your-cloudfront-domain/api
VITE_USE_MOCK_API=false
```

Production build:

```powershell
npm run build
```

---

## What it does

**Upload and extraction** — PDF, PowerPoint, Word, plain text, and supported
images are uploaded to FastAPI. Native text is used first; RapidOCR/PaddleOCR
runs only for image-based or low-text pages, with strict page and time budgets.

**Recap** — two depths. *Last-minute cram* is the eight things likely to be on
the paper. *Deep revision* keeps the worked reasoning and the edge cases. Both
come with key terms, exam tips, and a list of what was dropped.

**Quiz** — multiple choice with explanations, per-topic scoring, and a "retry
weak topics only" path that skips what you already know.

**Flashcards** — key terms and missed questions on an SM-2 spaced-repetition
schedule.

**Ask this material** — grounded Q&A that quotes your slides, or says plainly
that the deck does not cover it.

**Progress** — mastery per topic, score trend, and a twelve-week activity map.

**Export** — Markdown, Anki CSV, print/PDF, and a read-only share link.

**Rec** — the 3D assistant. During the 20-40 seconds the pipeline runs, its
animation state is driven by the actual backend stage: it reads while text is
being extracted and thinks while the model is being called. See
`docs/MASCOT-BRIEF.md`.

---

## Stack

**Frontend** — React 19, Vite, react-router-dom v7, GSAP, Motion, ogl,
three.js/R3F for the mascot, and 39 [React Bits](https://reactbits.dev)
components (`docs/REACT-BITS-MAP.md`).

**Backend** — the same API runs on **EC2 behind Express** or on **Lambda behind
API Gateway**; both call the same `core/` functions. DynamoDB + S3 for state,
Cognito for identity, Textract for OCR, Polly for read-aloud.

**Generation** — OpenRouter with automatic failover to NVIDIA NIM. Amazon
Bedrock is not available in AWS Academy Learner Lab, so both providers run on
free tiers and are called only from the server — no key ever reaches the browser.

---

## Repository

The frontend is the root npm package — `package.json`, `vite.config.js`,
`index.html`, `public/` and `src/` all live at the top level, and Amplify builds
it from there. There is no `frontend/` directory for that reason; the backend is
the part that had to be nested.

```
src/                    the frontend, built by Vite from the repository root
  pages/                25 page components, each with its own stylesheet
  components/           all UI, including:
    auth/               sign-in methods — Google, face enrolment
    avatar/             the learner's own GLB, thought bubbles, stage
    mascot/             Rec — GLB loader, procedural fallback, state machine
    practice/           the code editor, its Pyodide worker, the AI helper
    layout/             shells, the topbar, the mobile drawer
    charts/             hand-built SVG charts
  lib/                  logic and state only: API client, auth, store,
                        spaced repetition, exporters, preferences
  reactbits/            vendored React Bits components (see its README)
  styles/               design tokens and shared surfaces
backend/
  app/                  THE BACKEND THAT RUNS — FastAPI, deployed to EC2
    main.py             app assembly and router mounting
    ui_api.py           the routes the frontend calls
    binder_api.py       multi-source binders
    social_api.py       lobbies, matchmaking, shared plans
    ai_service.py       provider failover, prompts, grounding
    model_chain.py      remembers which provider answered
    repository.py       persistence
    extractors.py       PDF/PPTX/DOCX/image extraction, OCR, chunking
  src/                  the Node/serverless alternative, kept in-tree as a
                        second architecture — NOT what serves the app
  infra/                EC2 provisioning: CloudFormation, systemd, nginx
  test/                 tests for the Node backend, no AWS needed
  Dockerfile            containerised FastAPI for EC2
  binder_smoke.py       end-to-end binder lifecycle check, no AWS or network:
                        backend/.venv/Scripts/python.exe backend/binder_smoke.py
docs/
  ARCHITECTURE.md       how it works and why it is shaped this way
  RUN-LOCALLY.md        getting both halves running on one machine
  DOCKER.md             building and running the backend container
  EC2-DEPLOYMENT.md     running the API on EC2, and surviving lab sessions
  AWS-DEPLOYMENT.md     the serverless alternative
  LEARNER-LAB-LIMITS.md what the account can and cannot do
  MASCOT-BRIEF.md       3D model specification and animation clip names
  REACT-BITS-MAP.md     which component is used where, and why
scripts/
  backend.mjs           creates the Python venv and runs uvicorn
  copy-pyodide.mjs      stages the Pyodide runtime into public/
  check-learner-lab.sh  probes your account for what is actually permitted
```

---

## Accessibility

Reduced motion is a first-class setting, not an afterthought: on it, every WebGL
backdrop and the 3D mascot **unmount entirely** rather than slowing down — a
paused shader still holds a GPU context. The system preference seeds the
default. The recap reader runs on a light surface at a 74-character measure with
an Atkinson Hyperlegible option, and the chart palette is validated for contrast
and colour-vision deficiency against both surfaces.

---

## Security

Never commit API keys, AWS credentials, private keys (`*.pem`), `.env` files,
`/etc/smartrecap.env`, or `backend/samconfig.toml`. All are gitignored.

Provider keys live in server-side environment variables and are never sent to
the browser — which is also why demo mode cannot generate recaps. AWS access on
EC2 comes from the instance profile, so no long-lived keys sit on the box
either.

`./scripts/check-learner-lab.sh` probes what your lab account actually permits
without changing anything.

---

## Credits

Interface components from [React Bits](https://reactbits.dev) by David Haz,
MIT + Commons Clause. Vendored with attribution and a changelog of local edits
in `src/reactbits/README.md`.
