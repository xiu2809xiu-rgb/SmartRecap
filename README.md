# SmartRecap

Turns lecture slides and notes into a structured recap and a revision quiz —
where every line of the recap points back at the slide it came from, and
anything the model could not trace to the source is dropped before the student
sees it.

Built for the Nanyang Polytechnic Cloud Computing Club AWS hackathon,
**Problem Statement 1: Automated Class Recap Generator.**

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

```bash
npm install
npm run dev
```

Opens on <http://localhost:5173>. No AWS session needed — the frontend runs
against a local demo backend with a bundled sample deck, and says so on screen
rather than passing sample content off as model output.

To generate real recaps, deploy the backend — `docs/EC2-DEPLOYMENT.md` for the
EC2 path, `docs/AWS-DEPLOYMENT.md` for serverless — then point the frontend at
it:

```bash
echo "VITE_API_BASE_URL=http://your-api-host" > .env.local
```

Production build:

```bash
npm run build     # → dist/
```

---

## What it does

**Upload** — PDF, PowerPoint, Word, plain text, or a photo of handwritten notes.
The file goes straight to a private S3 bucket with a presigned URL; it never
passes through a server. If there is no text layer, Amazon Textract reads it.

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

```
src/
  pages/        13 routes
  components/   shared UI, the citation ribbon, hand-built SVG charts
  mascot/       Rec — GLB loader, procedural fallback, state machine
  reactbits/    vendored React Bits components (see its README)
  lib/          API client, auth, store, spaced repetition, exporters
  styles/       design tokens and shared surfaces
backend/
  src/core/     the logic — plain functions, no framework
  src/ai/       provider failover, prompts, grounding
  src/extract/  PDF/PPTX/DOCX/image extraction, OCR, chunking
  src/server.js EC2 adapter (Express)
  src/handlers/ Lambda adapters
  infra/        EC2 provisioning: CloudFormation, systemd, nginx
  template.yaml Lambda: the full serverless stack
  test/         19 tests, no AWS needed
docs/
  ARCHITECTURE.md      how it works and why it is shaped this way
  EC2-DEPLOYMENT.md    running the API on EC2, and surviving lab sessions
  AWS-DEPLOYMENT.md    the serverless alternative
  LEARNER-LAB-LIMITS.md what the account can and cannot do
  MASCOT-BRIEF.md      3D model specification and animation clip names
  REACT-BITS-MAP.md    which component is used where, and why
scripts/
  check-learner-lab.sh probes your account for what is actually permitted
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
