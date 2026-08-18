# SmartRecap architecture

> **Current deployment architecture:** see [`AWS-HACKATHON.md`](AWS-HACKATHON.md) for the active Amplify + CloudFront + EC2 FastAPI path. The serverless Node architecture below remains a preserved alternative, not the current runtime.

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

## Practice: running code in the browser

For programming and DSA modules a recap is only half of revising — the other
half is writing the thing. `/app/material/:id/practice` puts the exercise brief
and the slide it came from on the left, and an editor on the right.

### Run and Check are separate controls

The page does two different things and they are two different buttons.

- **Run** executes what is in the editor and shows the output. It never grades
  anything.
- **Check answer** runs the exercise's tests.

An earlier version had one button doing both. Typing `print(21)` to see what
happened answered with *"0 of 3 tests passing"* and three NameErrors — a tool
telling someone they are wrong for experimenting. Exploring and being marked
are different intentions and now look different.

Two consequences of the same principle:

- A **Playground** tab has no tests at all and needs no backend, so it works
  even when exercise generation is unavailable. It keeps a separate draft per
  language.
- When the code simply does not define the function yet, the page says so in
  one sentence instead of printing one near-identical NameError per test. Not
  having written it is where you start, not an error.

**The exercises come from the student's own material and cite it.** Same
contract as everything else: `ai/prompts.js`'s `practicePrompt` requires a
`citations` array, and `groundPractice` drops any exercise whose citation does
not resolve or does not share the cited slide's distinctive vocabulary. A
binary-search exercise pointed at the hash-table slide is removed. This is what
separates it from an embedded playground: a lecture on binary search gets a
binary search to write, not FizzBuzz.

**"This material does not teach programming" is an expected answer.** Most
uploads are not code. Two independent checks have to agree before a student is
offered exercises:

1. `looks_like_code` — a local regex pass with weighted signals, run *before*
   any model call so a history deck never costs a request. Literal syntax
   (`def foo(`, `SELECT ... FROM`) counts double, because nothing else writes
   like that; vocabulary ("algorithm", "recursion") counts single, because any
   subject might use it, and scores per *distinct* term so a lecture naming
   both "linked list" and "hash table" qualifies without showing code. Words
   with everyday senses — "stack", "queue", "class", "return" — are not signals
   at all, or a timetable would qualify.
2. The model, which is told that declining is correct and expected.

This lives in **both** backends and must stay in step: `backend/app/ai_service.py`
for the FastAPI host that is currently deployed, and `backend/src/core/practice.js`
for the Node host kept as the serverless alternative. `backend/test/practice.test.mjs`
pins the Node behaviour.

The result is cached on the material either way. "No" is a result, and
re-deciding it on every visit would cost a request to reach the same answer.

### Execution model

Code runs **entirely in the browser**, in a Web Worker.

- **Python** — Pyodide, self-hosted from `public/pyodide/`. `npm i` puts it in
  `node_modules`; `scripts/copy-pyodide.mjs` copies the five files the runtime
  actually loads into `public/` on `predev`/`prebuild`. It is gitignored: 13 MB
  of build output that changes only when the dependency version does.
- **JavaScript** — a direct `eval` inside a generated function, so a test can
  call whatever the student declared. No download at all.

Nothing is sent to a server. That is right for a study tool on its own merits,
and it also means the feature costs nothing to operate and cannot be taken down
by a Learner Lab session expiring mid-demo.

**Server-side execution was considered and rejected.** Judge0 on the EC2 box, a
container sandbox, Lambda — all of them mean accepting arbitrary code from the
internet onto infrastructure we cannot properly isolate inside a Learner Lab,
on a four-hour session, days before a deadline. The blast radius of getting it
wrong is the whole AWS account. WASM in a worker has none of that exposure and
works offline.

The cost is language coverage: Python and JavaScript only. Java and C would
need a server runner, and the page says so rather than pretending otherwise.

### Why the timeout lives on the main thread

A student learning loops writes an infinite loop. That is normal, and the page
has to survive it. `while True:` inside the interpreter never yields, so the
worker cannot time itself out — only something outside it can. `useRunner.js`
holds the timer and calls `terminate()`, which is the only thing that reliably
stops running WASM.

Terminating means Pyodide reloads on the next Python run. That is the right
trade: a page you have to reload to recover from your own mistake is a page
students stop using. Verified end to end in headless Chrome — loop killed at
10.1s, the next run passed 3 of 3.

### Tests are expression/expected pairs

`{ "call": "binary_search([1,3,5], 5)", "expect": "2" }`. One protocol checks
both languages, and neither needs a test framework shipped to the browser.
`groundPractice` throws out any exercise whose tests do not call the function
the starter defines — those can never pass, so the student would be debugging
our bug rather than their code.

---

## Multi-language recaps, and why translation runs last

A student can ask to read their recap in Chinese, Malay or Tamil. The obvious
implementation — tell the model to write it in Malay — quietly destroys the
guarantee above.

Overlap checking is lexical. A Malay sentence and an English slide share no
content vocabulary, so `overlapRatio` would score every claim near zero and the
grounding pass would delete the entire recap. Worse, `contentTokens` strips
anything outside `[a-z0-9]`, so a recap in Chinese or Tamil tokenises to the
empty set — and an empty claim returns `1`, a perfect score. Every claim would
pass a check that had silently stopped checking anything, and the pipeline would
report success.

So the order is: **generate → ground → translate.** The recap is written, cited
and checked in the material's own language. Only the lines that survived are
translated, in `ai/generate.js`'s `translateStudyPack`, which:

- sends strings as an id-keyed object, so the model cannot reorder, merge or
  drop them the way it does with a numbered list;
- never sends citations, chunk ids, answer indices or `verified` flags — those
  are structure, and translating structure is how you break it;
- leaves a key term's *name* in the original language and translates only its
  definition, because the exam paper will use the original term;
- keeps the original wording for anything that does not come back, so a
  translation failure degrades to an English recap rather than a failed job.

The source panel is never translated. A translated point still cites the
original slide and the reader still quotes that slide verbatim, which is what
makes the citation checkable by a student who wants to go and look.

`test/translate.test.mjs` pins all of this: citations, indices and flags must
survive a translation byte-for-byte.

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
