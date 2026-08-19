# SmartRecap AWS hackathon deployment and judging brief

## What AWS does in the live solution

AWS is part of the executable path, not a logo on the architecture slide:

1. **AWS Amplify Hosting** serves the production React/Vite student experience over HTTPS and its CDN.
2. **Amazon CloudFront** provides a stable HTTPS and WebSocket endpoint for the API, avoiding browser mixed-content failures.
3. **Amazon EC2 (`t3.xlarge`)** runs the active FastAPI backend, native document extraction, RapidOCR/PaddleOCR, citation validation, background jobs, quizzes, and multiplayer lobbies.
4. **Elastic IP** keeps the CloudFront origin stable across Learner Lab stop/start cycles.
5. **Amazon S3** stores private source uploads, oversized durable records, generated recap snapshots, and cached study illustrations. The browser uploads through a short-lived presigned PUT URL, while EC2 reads objects using its instance role.
6. **Amazon DynamoDB** stores shared materials, immutable quiz versions, attempts, flashcard schedules, forum posts, and share links so friends see the same workspace and EC2 restarts do not erase study state.
7. **AWS Lambda** observes completed Binder source uploads, checks the PDF signature with a five-byte ranged S3 read, and writes an idempotent seven-day receipt without changing the EC2 workflow.
8. **Amazon EventBridge** routes only object-created events under `smartrecap/uploads/` to the observer Lambda and retries transient failures.
9. **CloudFormation** creates the durable data and upload-observer resources independently from the existing EC2, and the original full-stack template remains available when a new backend host is needed.

If EC2 is unavailable, uploads cannot be extracted, grounded, summarized, queried, or turned into quizzes. If Amplify is unavailable, students cannot access the product. That makes AWS central to delivery and core processing.

## Why these services

- **EC2 instead of Lambda:** PaddleOCR and PDF processing need native libraries, model caches, generous memory, and jobs longer than a typical request. A `t3.xlarge` gives 4 vCPUs and 16 GiB RAM for concurrent extraction while remaining simple enough to explain and debug live.
- **Amplify instead of a local Vite server:** it gives the judges a repeatable HTTPS URL, CDN delivery, immutable build artifacts, and SPA hosting without keeping a laptop online.
- **CloudFront between Amplify and EC2:** Amplify is HTTPS, so browsers reject a plain HTTP API. CloudFront supplies a trusted AWS HTTPS hostname and forwards API calls and lobby WebSockets to nginx on EC2.
- **S3 instead of keeping upload bytes in process memory:** short-lived presigned PUT URLs send private source files directly to an encrypted bucket. EC2 retrieves them with `LabInstanceProfile`, and generated recap snapshots provide durable demo evidence. Objects expire after seven days.
- **DynamoDB plus S3 instead of process memory:** DynamoDB indexes shared app entities with on-demand billing and point-in-time recovery; S3 holds uploads and records too large for DynamoDB's item boundary. The backend keeps a memory cache for speed but hydrates it from durable storage at startup.
- **EC2 plus Lambda:** EC2 keeps the persistent FastAPI, native OCR, AI orchestration, WebSockets, and image caching in one warm service. An additive Lambda observes completed S3 source uploads, validates the PDF signature, and writes an idempotent seven-day receipt to an isolated DynamoDB namespace. Lambda failure cannot block the existing upload or extraction path.
- **Optional Pollinations visuals:** the backend asks Azure/OpenAI to turn a grounded topic into a short visual brief, strips URLs/emails/instruction-like text, then calls an allowlisted Pollinations image host. It never sends raw files, filenames, citations, provider keys, or full OCR text, and text notes remain authoritative.

## Live architecture

```text
Student browser
  |-- HTTPS --> AWS Amplify Hosting (React 19 + Vite)
  |-- HTTPS --> Amazon S3 (private presigned source upload)
  |                  |
  |                  +-- Object Created --> EventBridge --> Lambda upload observer
  |                                                               |
  |                                                               +--> DynamoDB receipt (TTL 7 days)
  |-- HTTPS/WSS --> Amazon CloudFront
                         |
                         +-- HTTP origin --> Elastic IP --> nginx on EC2 t3.xlarge
                                                        |
                                                        +--> FastAPI :8000
                                                             |-- native PDF/PPTX/DOCX extraction
                                                             |-- RapidOCR/PaddleOCR
                                                             |-- Gemini recap + quiz draft
                                                             |-- Azure GPT-5.6 Sol chat/review
                                                             +-- OpenAI final hard-quiz audit
```

The Lambda branch is intentionally observational: EC2 still owns upload commit and extraction, so Lambda retries or outages cannot break the student workflow. The external AI providers qualify under the organizers' broadened AI bonus. Hard quizzes use all three providers sequentially, then backend code restores citations to exact raw-source substrings and rejects unsupported questions.

## Deployment runbook (us-east-1)

### 1. Install fresh Learner Lab credentials locally

The credentials pasted into chat must be considered exposed. Start/restart the lab, copy a fresh block directly into `~/.aws/credentials`, and never place it in this repository. Verify:

```powershell
aws sts get-caller-identity --region us-east-1
```

### 2. Deploy durable data resources for the existing EC2

This stack creates only DynamoDB and S3. It does not create or replace your EC2, CloudFront distribution, or any Lambda function.

```powershell
aws cloudformation deploy `
  --template-file backend/infra/fastapi-data.yaml `
  --stack-name smartrecap-data `
  --parameter-overrides WebOrigin=https://YOUR_AMPLIFY_DOMAIN `
  --region us-east-1

aws cloudformation describe-stacks `
  --stack-name smartrecap-data `
  --query "Stacks[0].Outputs" --output table `
  --region us-east-1
```

Set the outputs as `TABLE_NAME` and `S3_BUCKET` in `/etc/smartrecap.env`. `LabInstanceProfile` needs `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:DeleteItem`, and `dynamodb:Query` on the table, plus `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` under `smartrecap/*`. The backend uses the instance role credential chain; never copy AWS keys into the app environment.

### 3. Optional: create a new EC2 and HTTPS backend stack

Find your current public IPv4 address and pass it as `/32`; this keeps SSH closed to everyone else.

```powershell
aws cloudformation deploy `
  --template-file backend/infra/ec2-fastapi.yaml `
  --stack-name smartrecap-fastapi `
  --parameter-overrides KeyName=vockey InstanceType=t3.xlarge SshCidr=YOUR.IP.ADDRESS/32 `
  --region us-east-1

aws cloudformation describe-stacks `
  --stack-name smartrecap-fastapi `
  --query "Stacks[0].Outputs" --output table `
  --region us-east-1
```

If Learner Lab rejects `t3.xlarge`, use `t3.large` and explain the constrained fallback. Do not create a NAT Gateway.

### 4. Install or update the application on EC2

Copy or clone the repository to `/home/ec2-user/smartrecap`, excluding `.env`, `.venv`, `node_modules`, and `.git`. On the instance:

```bash
cd /home/ec2-user/smartrecap
bash backend/infra/setup-ec2.sh
sudo vi /etc/smartrecap.env
sudo systemctl restart smartrecap
curl http://127.0.0.1/api/health
```

Put provider secrets only in `/etc/smartrecap.env`. Set `CORS_ORIGINS` to the final Amplify URL exactly, with no trailing slash. Set `S3_BUCKET` to the stack's `StorageBucket` output and `AWS_REGION=us-east-1`; the `LabInstanceProfile` must allow `s3:GetObject` and `s3:PutObject` on that bucket. Set `ENABLE_MATH_OCR=true` only after installing the pinned Pix2Text dependencies and allowing its CPU models to download during setup. The systemd unit uses one worker because current application state is in memory.

### 5. Deploy the frontend to Amplify

Use the stack's `ApiBaseUrl` output (it must end in `/api`):

```powershell
.\scripts\deploy-amplify.ps1 -ApiBaseUrl "https://CLOUDFRONT_DOMAIN/api"
```

The script builds production assets locally, creates or updates a manually deployed Amplify app, uploads a zip, and installs the SPA rewrite. This avoids requiring a Git-provider token. Amplify manual deployments are documented by [AWS](https://docs.aws.amazon.com/amplify/latest/userguide/manual-deploys.html), and the rewrite follows the [Amplify SPA rewrite guidance](https://docs.aws.amazon.com/amplify/latest/userguide/redirect-rewrite-examples.html).

## Rubric evidence

| Criterion | Evidence to show live |
|---|---|
| Cloud implementation (10) | Open the Amplify production URL, CloudFormation stack, CloudFront distribution, and EC2 instance. Upload processing visibly depends on EC2. Explain why OCR model memory and native libraries led to EC2. |
| Relevance (10) | Upload a real lesson, show a polished recap and normal-notes view, hover a citation to its exact source, ask a question, then generate a conceptual quiz. |
| Technical complexity (8) | Native extraction + selective OCR, three-provider hard-quiz pipeline, strict citation canonicalization, background jobs, immutable quiz attempts, WebSocket matchmaking, and responsive document rendering. |
| UX (7) | First-time flow: upload → background notification → recap/normal notes → difficulty/count → solo or multiplayer → results/weak-topic retry. |
| Presentation (10) | Tell the student pain point first, then demonstrate one complete path. Keep AWS console tabs and a prepared source file open before judging starts. |
| AI bonus (5) | Gemini synthesizes and drafts; Azure GPT-5.6 Sol handles notebook chat and hard-quiz review; OpenAI performs the final hard-quiz audit. Unsupported citations are rejected in code. |

## Five-minute demo order

1. State the problem: students need useful notes quickly but cannot trust unsupported summaries.
2. Show Amplify, CloudFront, and the running `t3.xlarge` in AWS, then return to the product.
3. Upload a lecture file and minimize the processing tray while navigating.
4. Open the completion notification; switch between Smart Recap and Normal notes.
5. Hover a takeaway to show the exact source rail connection and show a preserved code block.
6. Ask one source-grounded question.
7. Generate a Hard quiz and explain Gemini → Azure → OpenAI plus exact-citation validation.
8. Start a two-browser lobby, complete one short match, and show the leaderboard.
9. Close with measurable value: source traceability, selective OCR, multiple difficulty levels, weak-topic retries, and improvement history.

## Operational and security notes

- The pasted AWS session credentials and SSH private key are compromised. Reissue both before allowing SSH or deploying.
- Restrict `SshCidr` to one `/32`; never expose SSH globally. IMDSv2 and an encrypted gp3 root disk are enforced by the template.
- With `TABLE_NAME` and `S3_BUCKET` configured, materials, source records, immutable quizzes, attempts, flashcard schedules, forum posts, and share links survive restarts and are shared by every browser using this demo workspace. Active jobs, lobby sessions, and WebSocket connections remain in memory, so use one Uvicorn worker and recreate live rooms after a restart.
- Authentication is still a local compatibility stub, so this is a shared hackathon workspace rather than private per-user storage. Do not upload confidential student records to the public demo.
- The CloudFront endpoint forwards to an HTTP EC2 origin but encrypts browser traffic. Direct EC2 HTTP remains reachable for origin traffic and troubleshooting.
- Stop the instance whenever it is not being tested. Delete the stack after the event to release the Elastic IP and CloudFront distribution.

## Teardown

```powershell
aws cloudformation delete-stack --stack-name smartrecap-fastapi --region us-east-1
aws amplify delete-app --app-id YOUR_APP_ID --region us-east-1
```

Wait for stack deletion and confirm the Elastic IP is gone. The private S3 bucket is retained intentionally to prevent accidental data loss; empty and delete the `StorageBucket` output separately after the demo. A public IPv4 address can incur charges even when attached; do not rely on older “free while attached” guidance.

## AWS references

- [Amplify manual deployments](https://docs.aws.amazon.com/amplify/latest/userguide/manual-deploys.html)
- [Amplify redirects and SPA rewrites](https://docs.aws.amazon.com/amplify/latest/userguide/redirect-rewrite-examples.html)
- [EC2 launch tutorial](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/tutorial-launch-a-test-ec2-instance.html)
- [EC2 quotas and vCPU limits](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-resource-limits.html)
- [Pollinations API documentation](https://github.com/pollinations/pollinations/blob/main/APIDOCS.md)

Content from AWS documentation was rephrased for compliance with licensing restrictions.
