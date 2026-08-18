# Demo runbook

Presentation & Demo is 7 of 50 marks, and it is the only category where the
work already being finished counts for nothing if the live run falls over.
This is the script, the pre-flight, and the fallbacks.

---

## Pre-flight — 20 minutes before, not 2

Run these in order. Every one has bitten a hackathon team before.

```bash
# 1. The lab session is live and credentials are fresh
aws sts get-caller-identity

# 2. The EC2 box is running, and the API is up on the address you will use
curl http://<elastic-ip>/health

# 3. Every AWS service the pipeline needs is reachable RIGHT NOW
curl "http://<elastic-ip>/health?deep=1"
#    or open  https://<your-site>/architecture  and read the status panel

# 4. The AI providers have not silently rate-limited you
./scripts/verify-deployment.sh http://<elastic-ip>
```

Then, in a browser you are actually going to present from:

- [ ] Sign in **as a guest** once, so the library is warm and not empty
- [ ] Upload the demo deck once end to end — this also warms every lazy chunk
- [ ] Leave that finished recap open in a second tab as the fallback
- [ ] Zoom to **110–125%** — judges are looking at a projector, not your laptop
- [ ] Settings → Text size → **Large** if the room is big
- [ ] Close every other tab; disable notifications

> **The single most likely failure is an expired Learner Lab session.** It ends
> four hours after you started it. If your slot is late in the day, restart the
> lab *before* the pre-flight, not after it breaks.

---

## The 3-minute run

### 0:00 — The problem, in one sentence you actually believe

> "A week before exams you have four modules, sixty slides each, and no idea
> which parts matter. You can re-read all of it, or you can trust a summary you
> have no way to check. We built the third option."

Do not spend more than 20 seconds here. The judges have read the problem
statement more times than you have.

### 0:20 — Upload

Open `/app/upload`. Drop in the demo deck. Talk while it uploads:

> "This goes straight to a private S3 bucket with a presigned URL — the file
> never passes through our server. If it were a photo of handwritten notes,
> Amazon Textract would read the text off it instead."

Do not click ahead. The processing screen is doing work worth narrating.

### 0:35 — The pipeline screen

Point at the stage list as it moves.

> "Every slide is kept separate, with its number. That is the whole trick —
> you cannot show a student where something came from if you threw away where
> it came from."

Rec's animation is bound to the actual backend stage, not a timer. Worth one
sentence, not three.

### 1:00 — **The moment.** The recap, and the citation ribbon

This is the demo. Everything else is context.

Hover a line in the recap. The thread draws to the slide it came from and the
source panel lights up.

> "Every line points back at the slide it came from. Hover it and you can see
> exactly where it came from — no re-reading the deck to check."

Then scroll to **Dropped from this recap**.

> "And this is the part we care about most. The model wanted to claim these two
> things. Nothing in the upload backs them up, so they are not in the recap —
> they are listed here with the reason. It tells you what it could not verify
> instead of hiding it."

**If you only get to show one thing, show this.** It is the answer to "how do
you handle incorrect AI-generated information", which the problem statement
asks about explicitly.

### 1:45 — Quiz

Answer one correctly, one wrong. Land on the results.

> "Explanations cite the slide too. Questions the material does not actually
> settle are shown and explained, but excluded from your score — so the score
> measures whether you learned the deck, not whether you guessed the model."

Click **Retry weak topics only**.

> "It knows which topics you missed and rebuilds a shorter quiz from just those."

### 2:20 — One innovation, chosen for your audience

Pick **one**. Do not list them all.

- **Binders** — several lessons combined into one revision guide *(strongest if
  they ask about scale)*
- **Flashcards** — spaced repetition, for the "does it help beyond today" question
- **Ask this material** — grounded Q&A, quotes the slides or says it is not covered
- **Settings** — themes, text size, reduced motion, face sign-in *(strongest if
  a judge has mentioned accessibility)*
- **Recap in four languages** — Chinese, Malay or Tamil, translated *after*
  grounding so the citations still point at the original slides *(strongest if a
  judge asks who else could use this)*
- **Practice** — write and run real code against exercises taken from your own
  lecture, in the browser *(strongest for a technical judge, and the most
  visually convincing thing we have after the ribbon)*

> **If you demo Practice, run it once during the pre-flight.** The first Python
> run downloads the runtime. After that it is cached and instant, but a cold
> first run on conference wifi is not what you want on stage. The JavaScript
> exercise needs no download at all — use that one if you are unsure.

### 2:40 — Close on the constraint

> "The bonus is for meaningful use of AI, so here is ours: the model is one
> stage of seven, and the other six exist to make its output checkable. The
> points it wrote that failed the check are the ones you just saw listed.
> Generation runs on OpenRouter with automatic failover to NVIDIA
> NIM, called only from the server. Textract reads scans, Polly reads recaps
> aloud, and everything stateful is S3, DynamoDB and Cognito."

If you have a spare 15 seconds, open `/architecture` and let the live status
panel finish the sentence for you.

---

## Questions you will be asked

**"How do you know the recap is accurate?"**
> Two checks on every claim. The cited chunk has to exist, and the claim has to
> share the distinctive vocabulary of that chunk — weighted so that words every
> slide contains, like "table" or "data", count for almost nothing. That second
> check catches a true statement attached to the wrong slide, which the first
> one lets through. Anything that fails is dropped and shown as dropped.

**"Why not Bedrock?"**
> It is not available in AWS Academy Learner Lab, and the organisers relaxed the
> bonus criteria to meaningful use of AI rather than a specific AWS service.
> Generation runs on OpenRouter with failover to NVIDIA NIM, called only from
> the server so no key reaches the browser. Textract and Polly are the AWS AI in
> the pipeline. Do not get drawn into a vendor conversation — the interesting
> part is what we do with the output, not where it came from.

**"What if the file is a scan, or nearly empty?"**
> Under 40 characters a page we treat it as a scan and send it to Textract. If
> there is still no usable text the job fails with a message that says what to
> try instead, rather than producing a confident summary of nothing.

**"Can it handle students who do not read English well?"**
> The recap can be read in Chinese, Malay or Tamil. The order matters: we
> generate and ground in the material's own language first, then translate only
> the lines that passed. Translating first would have compared a Malay sentence
> to an English slide, which shares no vocabulary — the check would have deleted
> everything, or passed everything while reporting that it had checked. Key
> terms stay in the original language, because that is what the exam paper uses.

**"Where does the student's code run? Is that not dangerous?"**
> Entirely in their own browser, in a Web Worker — Pyodide for Python,
> JavaScript natively. Nothing is sent to us. We deliberately did not build a
> server-side runner: accepting arbitrary code onto a Learner Lab instance we
> cannot properly isolate, days before a deadline, risks the whole AWS account
> for no benefit a student would notice. The trade is that we support Python
> and JavaScript, not Java or C, and the page says so.

**"How do you stop an infinite loop hanging the page?"**
> The worker is killed from the main thread after ten seconds. The interpreter
> never yields inside a `while True`, so nothing inside it can time itself out —
> terminating from outside is the only thing that works. The next run starts a
> fresh worker.

**"Is this just a wrapper around an LLM?"**
> The model is one of six stages. Extraction preserves slide numbers, chunking
> keeps them citable, and the grounding pass throws away output the model was
> perfectly happy with. That last part is the product.

**"What does AWS actually do here?"**
> Open `/architecture` — the status panel probes each service live.

**"How much did it cost?"**
> Nothing so far. Free tier plus free model tiers. Textract and Polly are the
> only per-use line items and both are opt-in per action.

---

## When it breaks

| What died | What you do |
|---|---|
| Wifi | Second tab already has a finished recap. Demo from there — the ribbon, dropped claims and quiz are all client-side |
| Lab session expired | Say so plainly, switch to the warm tab, keep going. Do not debug on stage |
| Generation 503s | Both providers are rate limited. Open an existing recap from the library instead |
| A page is slow | Keep talking. The sweep and the stage list are designed to cover exactly this |
| Total failure | `npm run dev` with no `VITE_API_BASE_URL` runs the whole frontend on the bundled sample, offline. Every screen works. Have it running before you start |

**Never debug live.** If something fails, name it in one sentence, move to the
fallback, and carry on. Judges score the recovery as competence; they score
three minutes of silent typing as a broken project.

---

## Splitting it across the team

- **One person drives**, and only that person touches the keyboard.
- **One person talks**, and does not narrate clicks — narrate *decisions*.
- **Whoever built the backend takes the AWS questions.** Have `/architecture`
  open on a second machine if you have one.

Rehearse it twice against the clock. The first run is always four minutes.
