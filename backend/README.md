# SmartRecap backend

The API runs **on EC2 behind Express** or **on Lambda behind API Gateway**.
Both hosts call the same functions, so behaviour is identical either way.

```
src/
  core/          the actual logic — plain functions, no framework, no event shapes
    auth.js        signup / login / guest / me
    library.js     materials, flashcard state, share links
    study.js       quiz attempts, grounded Q&A, Polly read-aloud
    jobs.js        presigned uploads, job start and status
    pipeline.js    extract → chunk → generate → ground → persist
  ai/
    provider.js    OpenRouter → NVIDIA NIM failover, one OpenAI-shaped client
    prompts.js     recap, quiz, ask and repair prompts
    generate.js    call → tolerant JSON parse → validate → one repair round
    ground.js      the citation check that makes the citations mean something
  extract/
    index.js       PDF / PPTX / DOCX / text / image, page boundaries preserved
    textract.js    OCR for scans — sync for images, async job for PDFs
    chunk.js       pages → citable chunks, and the context budget
  lib/             DynamoDB, S3, HS256 tokens, HTTP helpers
  server.js        ← EC2 adapter (Express)
  handlers/
    api.js         ← Lambda adapter (API Gateway)
    processor.js   ← Lambda adapter for the pipeline
infra/             EC2: CloudFormation for data, systemd unit, nginx, setup script
template.yaml      Lambda: the full serverless stack
test/              extraction, chunking, grounding and token tests
```

`core/` knows nothing about Express or API Gateway. That is the whole point —
the two adapters are about 60 lines each and cannot drift apart.

## Which host

|  | EC2 | Lambda |
|---|---|---|
| Survives a lab session ending | ❌ instance stops, public IP changes | ✅ keeps serving |
| Long jobs | ✅ runs in-process, no timeout | ⚠️ needs a second function (29s gateway cap) |
| Debugging | ✅ SSH in, tail the journal | CloudWatch |
| Setup | ~20 minutes | `sam deploy --guided` |
| Idle cost | ~$0.02/hour while running | $0 |

If you stay on EC2, allocate an **Elastic IP** first — otherwise the address
changes every time the lab restarts and the frontend config breaks.

## Running it

```bash
npm install
npm test          # 19 tests, no AWS needed
npm start         # needs the environment below
```

Environment:

```bash
AWS_REGION=us-east-1
TABLE_NAME=            # from the CloudFormation stack
BUCKET_NAME=
USER_POOL_ID=
USER_POOL_CLIENT_ID=
JWT_SECRET=            # openssl rand -base64 32
OPENROUTER_API_KEY=    # https://openrouter.ai/keys
NVIDIA_API_KEY=        # https://build.nvidia.com
ALLOWED_ORIGIN=*
PORT=3000
```

`GET /health` reports which providers were picked up, so a misconfigured key is
one curl away rather than a mystery 503 later.

**Deployment guides:** `../docs/EC2-DEPLOYMENT.md` · `../docs/AWS-DEPLOYMENT.md`

## Why it is shaped this way

Three Learner Lab constraints drive most of it.

**You cannot create IAM roles.** On EC2 the instance uses the pre-existing
`LabInstanceProfile`; on Lambda every function takes `LabRole` through a
parameter. That is why `template.yaml` has no `Policies:` blocks — SAM would try
to generate a role and the deploy would fail.

**Bedrock is not available.** Generation goes to OpenRouter first and falls back
to NVIDIA NIM. Both are OpenAI-compatible, so it is one client and two base
URLs. Failover fires on 429/5xx/timeout only: a 400 means our request is
malformed and the second provider will reject it identically.

**Credits are finite.** Pay-per-request DynamoDB, S3 lifecycle rules that expire
source files at 30 days, `LoggingLevel: ERROR` on the API stage, and a context
budget in `extract/chunk.js` that caps how much of a long document reaches a
model.

Two more worth knowing:

**Generation is asynchronous — differently per host.** On EC2 the process is
long-lived, so `POST /jobs` calls `runPipeline` without awaiting it. On Lambda
it invokes a second function with `InvocationType: Event`, because API Gateway
caps a request at 29 seconds and generation takes 20-40. `core/jobs.js` takes
the dispatcher as an argument; that is the only difference.

**The API mints its own session token.** Real sign-ups authenticate against
Cognito inside the server, then receive an HS256 token from `lib/jwt.js`; guests
get one directly with no Cognito user behind them. One token format means one
verification path — and a Cognito problem can never lock a live demo out of the
guest route.

## Grounding

The part the product rests on. `ai/ground.js` runs two checks on every claim:

1. **Resolution** — does each cited chunk id exist in the set we actually sent?
   Models invent ids, especially late in a long generation.

2. **Overlap** — does the claim share the *distinctive* vocabulary of the chunk
   it cites? This catches the failure resolution alone waves through: a true
   statement attached to the wrong slide.

   Terms are weighted by inverse document frequency across the chunk set. An
   unweighted count does not work inside one subject — every chunk of a database
   lecture contains "table", "row" and "data", so a claim about joins scored 0.37
   against a chunk about primary keys purely on shared vocabulary. A test caught
   that; `test/extract.test.mjs` now pins it.

Everything dropped is kept with a reason and shown in the reader. A quiz
question that cannot be traced is removed outright; one that resolves but reads
as weakly supported is kept with `verified: false`, so it still teaches but does
not count toward the score.

## Tests

```bash
npm test
```

19 tests, no AWS and no network. They cover the two places a silent regression
is expensive: extraction, where a wrong page label makes every citation subtly
wrong (including the `slide10` sorting trap), and grounding, where the checks
either work or the product claim is false. `test/jwt.test.mjs` covers the
forgery paths on the hand-rolled token — tampering, wrong secret, `alg=none`,
expiry and malformed input.

## Costs

Everything is inside the AWS Free Tier at demo volumes and both model providers
are used on their free tiers. On a $50 budget the ones to watch are the EC2
instance itself (~$0.02/hour), Textract (per page, scans only) and Polly (per
character, read-aloud only). Never create a NAT Gateway: ~$32/month, and unlike
EC2 it does not stop when the lab session ends.

## Never commit

API keys, the JWT secret, `.env` files, `/etc/smartrecap.env`, `*.pem`, or
`samconfig.toml`. All are gitignored.
