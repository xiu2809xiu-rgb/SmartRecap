# SmartRecap architecture

## The problem

Problem Statement 1 asks for an application where students upload lecture slides
or class notes and receive structured summaries plus revision quizzes.

The hard part is not summarising. Any model will summarise a deck. The hard part
is that **a student cannot check the summary without re-reading the deck**,
which is the exact work the tool was supposed to save. A recap you have to
verify is worse than no recap, because it costs the same time and adds doubt.

So the design goal is narrower than "summarise well": every claim in the output
must be traceable to a specific slide in the input, and anything that cannot be
traced must not appear as fact.

That single constraint drives almost every decision below.

---

## Shape

```
Browser (React 19 + Vite)
   │
   │  1. POST /uploads  ──────────────►  Lambda  ──►  presigned S3 PUT URL
   │  2. PUT file ────────────────────────────────►  S3 (private bucket)
   │  3. POST /jobs  ─────────────────►  Lambda  ──┐
   │                                                │ async invoke
   │  4. GET /jobs/{id}  (poll) ──────►  Lambda ◄───┤
   │                                                ▼
   │                                        Processor Lambda
   │                                          ├─ S3 GetObject
   │                                          ├─ extract (pdf/pptx/docx/img)
   │                                          ├─ Amazon Textract  (scans only)
   │                                          ├─ chunk → citable units
   │                                          ├─ OpenRouter ─┐ failover
   │                                          │  NVIDIA NIM ─┘
   │                                          ├─ ground (drop uncited claims)
   │                                          └─ DynamoDB PutItem
   │
   └─ 5. GET /materials/{id} ─────────►  Lambda  ──►  DynamoDB
```

**AWS services:** S3, Lambda, API Gateway, DynamoDB, Cognito, Textract, Polly,
CloudFormation, CloudWatch, IAM (consumed, not created).

**Outside AWS:** OpenRouter and NVIDIA NIM for generation, because Bedrock is
not available in AWS Academy Learner Lab. Both are called only from Lambda.

---

## Why each piece

### Direct-to-S3 upload

The browser PUTs the file straight to a private bucket with a five-minute
presigned URL. The file never passes through Lambda.

This is not only about cost. API Gateway caps a request payload at 6 MB and the
limit here is 25 MB, so routing the file through the API would have capped the
product at "short decks only". It also means the source file exists in exactly
one place, which makes deletion honest.

### Asynchronous generation

A recap takes 20 to 40 seconds. API Gateway hard-caps a request at 29.

`POST /jobs` writes a job row to DynamoDB, invokes the processor function with
`InvocationType: Event`, and returns `202` immediately. The client polls
`GET /jobs/{id}`, which reads that row.

The stage ids the processor writes are the same ones the frontend renders, which
is what lets the mascot's animation state be bound to what the backend is
actually doing rather than to a timer.

### Single-table DynamoDB

Every access pattern this app has is either "everything belonging to one user"
or "one item by id". A `pk`/`sk` pair covers both, so a second table would add
cost and deploy surface for nothing.

```
PK                SK                    Item
USER#<id>         PROFILE               account
USER#<id>         MATERIAL#<id>         metadata + chunks + recap + quiz
USER#<id>         ATTEMPT#<ts>#<id>     quiz attempt (sk sorts chronologically)
USER#<id>         CARDS#<materialId>    spaced-repetition state
JOB#<id>          JOB                   pipeline status, TTL 2 days
SHARE#<token>     SHARE                 public share pointer
EMAIL#<email>     INDEX                 email → user id
```

Recaps are stored inline on the material rather than normalised out. A recap is
read as a whole, every time, and never partially — splitting it would turn one
`GetItem` into a `Query` plus assembly for no benefit.

### Identity: Cognito behind our own token

Sign-up and sign-in go to a Cognito user pool from inside Lambda. The browser
never talks to Cognito and never sees a Cognito token — it exchanges email and
password for an HS256 session token the API mints itself.

Two reasons. It keeps the client free of an SDK, and it makes the **guest path**
first-class: a guest gets a real token scoped to a real, TTL'd identity, so the
same authorizer protects every endpoint and the same partitioning keeps their
data private. A Cognito problem during a live demo can never block the guest
route, because there is no Cognito in it.

### OCR

A PDF exported from PowerPoint has a text layer. A PDF that is photographs of a
whiteboard does not, and neither does a phone photo of handwritten notes.

`extract/index.js` measures text density per page. Below 40 characters per page
it routes to **Amazon Textract** — synchronous for images, an async job with
polling for multi-page PDFs. Textract is available in Learner Lab, which makes
this real AWS AI in the pipeline rather than a service named on a slide.

### Two model providers

OpenRouter first: the widest free-tier catalogue, but a hard 20 requests per
minute on `:free` variants regardless of credit, so it is the one that
rate-limits first on a demo day. NVIDIA NIM second: a separate free tier on
entirely different infrastructure.

Both are OpenAI-compatible, so it is one client and two base URLs. Failover
fires on 429, 5xx and timeout only — a 400 means our request is malformed and
the second provider will reject it identically, so retrying there just doubles
the latency of a certain failure.

---

## The grounding pipeline

This is the part the product rests on.

**1. Chunking preserves provenance.** Extraction returns pages, not a document.
Each page becomes one or more chunks with a stable label — `Slide 12`,
`Page 4` — and empty pages are dropped rather than renumbered, so a chunk
labelled Slide 12 is genuinely slide 12 of the file the student uploaded.

**2. The model writes against ids.** Chunks are rendered into the prompt as
`[c7] (Slide 12)\n<text>` and the schema requires a `citations` array on every
point, key term and question. Asking for citations after generation does not
work — the model has to be writing against the ids as it goes.

**3. Two checks, not one.** `ai/ground.js`:

- **Resolution** — does each cited id exist in the set we actually sent? Models
  invent ids, especially late in a long generation.
- **Overlap** — does the claim share content vocabulary with the chunk it cites?
  This catches the failure resolution alone waves through: a *true* statement
  attached to the *wrong* slide. It is a lexical heuristic, so the threshold is
  low (0.18) — its job is to catch a claim citing an unrelated chunk, not to
  referee close paraphrase.

**4. Failures are surfaced, not deleted.** A claim that fails either check is
removed from the recap and listed under "Dropped from this recap" with the
reason. A student learns more from seeing what the model wanted to claim and
could not support than from a recap that is quietly shorter than it should be.

**5. Unverifiable questions do not score.** A quiz question that cannot be
traced is removed. One that resolves but reads as weakly supported is kept with
`verified: false` — shown, explained, and excluded from the percentage. The
score measures whether the student learned the deck, not whether they guessed
what the model meant.

**6. The reader shows it.** Hovering any recap line draws a lit thread from that
line to the extracted passage it came from. That is the whole argument made
visible in one interaction.

---

## Frontend

**React 19 + Vite, `react-router-dom` v7.** No state library — auth, library and
preferences are three small contexts, and the data is a list of materials and a
list of attempts.

**Two luminances, one token set.** Aurora Maximalism held across both: the
marketing, auth and app chrome run the mesh gradient at full strength; the study
surfaces (reader, quiz, flashcards) invert to a light panel so long-form reading
is comfortable. Same accents, same type, same motion. Switched by `data-surface`
on `<html>` so the body background follows.

**Bundle discipline.** three.js is 946 kB and only the mascot needs it, so
`Mascot.jsx` lazy-loads the canvas behind a flat SVG badge. The entry chunk is
33 kB gzipped; three, gsap, motion and ogl are all separate chunks that load
when a route asks for them.

**Reduced motion removes rather than slows.** Every WebGL backdrop and the
mascot unmount entirely — a paused shader still holds a GPU context. The system
preference seeds the default and the user can override it either way.

**Demo mode is honest.** With `VITE_API_BASE_URL` unset the app runs against a
local mock that mirrors the real API surface exactly, so the whole thing works
with no AWS session. It does not generate recaps: an upload in demo mode carries
the bundled sample and the UI says so in a standing banner. Presenting fabricated
summaries as model output would make the one screen that has to be trustworthy a
lie.

---

## What is deliberately not here

**No RAG over a vector store.** A single lecture deck is 10 to 40 chunks —
small enough to send whole. A vector database for one document is architecture
theatre, and it would introduce retrieval failure modes the grounding check
cannot see.

**No streaming.** The recap is validated and grounded as a whole before it is
shown. Streaming would mean rendering claims that the grounding pass has not run
on yet, which contradicts the entire product.

**No fine-tuning.** The behaviour that matters is enforced in code
(`ai/ground.js`), not learned. A fine-tune would make citations more likely; the
grounding pass makes uncited claims impossible.

**No WebSocket.** Polling a DynamoDB row every 700ms for 30 seconds is roughly
40 reads. A WebSocket API would be more infrastructure for a progress bar.

---

## Cost

Everything is inside the AWS Free Tier at demo volumes, and both model providers
are used on their free tiers. On a $50 Learner Lab budget the line items worth
watching are Textract (per page, scans only) and Polly (per character, read-aloud
only). S3 and DynamoDB at this scale round to nothing.

Resources persist across Learner Lab sessions — only EC2 stops, and there is no
EC2 here. A deployed stack keeps serving between lab sessions, which is what
makes a live demo safe.
