# SmartRecap backend

Serverless API: API Gateway → Lambda → DynamoDB + S3, with Cognito for identity
and Textract for OCR. Generation runs on external free-tier models called only
from Lambda.

## Why it is shaped this way

Three constraints from AWS Academy Learner Lab drive most of the design.

**You cannot create IAM roles.** Every function is given the pre-existing
`LabRole` through the `LabRoleArn` parameter. That is why `template.yaml` has no
`Policies:` blocks — SAM would try to generate a role and the deploy would fail.

**Bedrock is not available.** Generation goes to OpenRouter first and falls back
to NVIDIA NIM. Both are OpenAI-compatible, so it is one client and two base
URLs. Failover is on 429/5xx/timeout only: a 400 means our request is malformed
and the second provider will reject it identically.

**Credits are finite.** Pay-per-request DynamoDB, S3 lifecycle rules that expire
source files after 30 days, `LoggingLevel: ERROR` on the API stage, and a
context budget in `extract/chunk.js` that caps how much of a long document is
sent to a model.

Two other decisions are worth knowing about:

**Generation is asynchronous.** A recap takes 20-40 seconds; API Gateway caps a
request at 29. `POST /jobs` writes a job row, invokes the processor function
with `InvocationType: Event`, and returns. The client polls `GET /jobs/{id}`.

**The API mints its own session token.** Real sign-ups authenticate against
Cognito first, then receive an HS256 token from `lib/jwt.js`; guests get one
directly with no Cognito user behind them. One token format means one
verification path — and it means a Cognito problem can never lock a live demo
out of the guest route.

## Layout

```
src/
  handlers/
    api.js         every synchronous route, with a small regex router
    processor.js   the asynchronous pipeline, invoked by POST /jobs
  ai/
    provider.js    OpenRouter → NVIDIA NIM failover, one OpenAI-shaped client
    prompts.js     recap, quiz, ask and repair prompts
    generate.js    call → tolerant JSON parse → validate → one repair round
    ground.js      the citation check that makes the citations mean something
  extract/
    index.js       PDF / PPTX / DOCX / text / image, page boundaries preserved
    textract.js    OCR for scans — sync for images, async job for PDFs
    chunk.js       pages → citable chunks, and the context budget
  lib/
    db.js          single-table DynamoDB access
    s3.js          presigned upload and download
    jwt.js         HS256 session tokens, written on node:crypto
    http.js        responses, typed errors, the error boundary
```

## Grounding

This is the part worth reading. `ai/ground.js` runs two checks on every claim
the model produces:

1. **Resolution** — does each cited chunk id exist in the set we actually sent?
   Models invent ids, especially late in a long generation. A claim with no
   resolvable citation is removed from the recap.

2. **Overlap** — does the claim share meaningful vocabulary with the chunk it
   cites? This catches the more dangerous failure that resolution alone waves
   through: a true statement attached to the wrong slide. It is a lexical
   heuristic, so the threshold is set low (0.18) — its job is to catch a claim
   citing an unrelated chunk, not to referee close paraphrase.

Everything dropped is kept with a reason and shown in the reader. A quiz
question that cannot be traced is removed outright; one that resolves but reads
as weakly supported is kept with `verified: false`, so it still teaches but does
not count toward the score.

## Deploying

Full walkthrough with Learner Lab specifics in `../docs/AWS-DEPLOYMENT.md`.
Short version:

```bash
cd backend
npm install
sam build
sam deploy --guided
```

You will be asked for:

| Parameter | Where to get it |
|---|---|
| `LabRoleArn` | IAM → Roles → LabRole in the Learner Lab console |
| `JwtSecret` | `openssl rand -base64 32` |
| `OpenRouterApiKey` | <https://openrouter.ai/keys> |
| `NvidiaApiKey` | <https://build.nvidia.com> |
| `AllowedOrigin` | Your deployed frontend URL, or `*` while developing |

Take `ApiUrl` from the outputs and put it in the frontend's
`VITE_API_BASE_URL`.

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/signup` | — | Create a Cognito user, return a session token |
| POST | `/auth/login` | — | Authenticate against Cognito, return a session token |
| POST | `/auth/guest` | — | Throwaway scoped identity, 30-day TTL |
| GET | `/auth/me` | ✓ | Current account |
| GET | `/materials` | ✓ | Library, without chunks or full quizzes |
| GET | `/materials/{id}` | ✓ | One material in full |
| PATCH | `/materials/{id}` | ✓ | Rename |
| DELETE | `/materials/{id}` | ✓ | Delete the record, the cards and the S3 object |
| GET/PUT | `/materials/{id}/flashcards` | ✓ | Spaced-repetition state |
| POST | `/materials/{id}/share` | ✓ | Create a read-only link |
| GET | `/shared/{token}` | — | Public recap view, never quiz history |
| POST | `/uploads` | ✓ | Presigned S3 PUT, valid five minutes |
| POST | `/jobs` | ✓ | Start the pipeline, returns immediately |
| GET | `/jobs/{id}` | ✓ | Poll stage, progress and log |
| POST | `/quiz/attempts` | ✓ | Score and store an attempt |
| GET | `/quiz/attempts` | ✓ | Attempt history, optionally per material |
| POST | `/ask` | ✓ | Grounded Q&A over one material |
| POST | `/tts` | ✓ | Amazon Polly read-aloud of the recap |

## Costs

Everything here is inside the AWS Free Tier at demo volumes, and both model
providers are used on their free tiers. The line items worth watching on a $50
budget are Textract (per page, only on scans) and Polly (per character, only
when read-aloud is used). S3 and DynamoDB at this scale round to nothing.

## Never commit

API keys, the JWT secret, `.env` files, or `samconfig.toml` if you let
`--guided` write your parameter values into it.
