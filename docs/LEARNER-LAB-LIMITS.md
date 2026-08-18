# AWS Academy Learner Lab — what you can and cannot use

Run `./scripts/check-learner-lab.sh` to probe your own account. This file is the
reference for what the probe results mean and what they cost you.

---

## The four that actually bite

### 1. You cannot create IAM roles

`iam:CreateRole` is denied. You get a pre-made role called **LabRole** and you
attach it to things.

Consequences:
- SAM's "Allow SAM CLI IAM role creation" prompt must be answered **no**.
- Every Lambda needs an explicit `Role:` — that is why `backend/template.yaml`
  takes a `LabRoleArn` parameter and has no `Policies:` blocks.
- An EC2 instance that needs AWS access must use the **LabInstanceProfile**,
  set at launch under Advanced Details → IAM instance profile.

Find it: `aws iam get-role --role-name LabRole --query Role.Arn --output text`

### 2. Amazon Bedrock is blocked

This is why generation runs on OpenRouter and NVIDIA NIM. It is also why the
organisers broadened the AI criterion — you are not being penalised for it.

Textract, Polly, Comprehend, Rekognition and Transcribe *are* available, which
is how the pipeline still uses AWS AI services meaningfully.

### 3. Region lock: us-east-1 or us-west-2

Anything created elsewhere silently fails or is unreachable. Pick one and put it
in every teammate's `~/.aws/config`:

```ini
[default]
region = us-east-1
```

### 4. Sessions expire, and EC2 stops with them

**This is the one that decides your architecture.** Read the next section.

---

## What happens when the lab session ends

| Resource | On session end | Public endpoint |
|---|---|---|
| **EC2 instance** | **STOPPED** | Public IP is **released and changes** on restart |
| Lambda | Keeps serving | Stable |
| API Gateway | Keeps serving | Stable |
| DynamoDB | Keeps serving | Stable |
| S3 | Keeps serving | Stable |
| Cognito | Keeps serving | Stable |
| RDS | Keeps running (**and keeps billing**) | Stable |
| Your CLI credentials | **Expire** | — |

Sessions are four hours. Restarting the lab gives you a new session and new
credentials, but a stopped EC2 instance does not restart itself, and when you do
restart it the public IP has changed — so every URL baked into the frontend
breaks.

For a hackathon this means:

- **Serverless demo:** deploy once, it stays live. You need an active session to
  *deploy*, not to *run*. You can demo at 9am from a stack you deployed at
  midnight without touching the console.
- **EC2 demo:** before every demo you must start the lab, wait for the instance
  to boot, find the new IP, and update the frontend. If the session expires
  mid-presentation, the backend goes down live.

If you stay on EC2, the mitigations are:
1. **Allocate an Elastic IP** and associate it with the instance. Learner Lab
   allows this and it survives stop/start, which removes the changing-IP
   problem entirely. Do this first.
2. Make the API a **systemd service** so it comes back on boot without an SSH
   session (`systemctl enable`). Otherwise a `node server.js` in a terminal dies
   with your SSH connection.
3. Budget ten minutes before any demo to start the lab and the instance.

---

## Full service status

Green = confirmed usable for this project. Amber = usable with a caveat. Red =
do not plan around it.

| Service | Status | Notes |
|---|---|---|
| S3 | ✅ | Uploads, static site hosting. Bucket names are globally unique |
| Lambda | ✅ | Must be given LabRole |
| API Gateway | ✅ | 29-second request cap — why generation is async |
| DynamoDB | ✅ | Use PAY_PER_REQUEST, not provisioned |
| CloudFormation | ✅ | SAM deploys through it |
| CloudWatch Logs | ✅ | Set API logging to ERROR to save credits |
| EC2 | ✅ | Instance type and volume caps apply; stops with the session |
| Elastic IP | ✅ | Strongly recommended if you use EC2 |
| VPC / Security Groups | ✅ | Default VPC is provided |
| Cognito | 🟡 | Works, but fussy. No SMS/MFA (needs a role you cannot create). Confirm users with `AdminConfirmSignUp` rather than email |
| Textract | ✅ | Sync for images, async job for PDFs. ~$1.50/1,000 pages |
| Polly | ✅ | ~$4 per million characters |
| Comprehend / Rekognition / Transcribe / Translate | ✅ | Available if you want more AWS AI surface |
| Step Functions | ✅ | Works, but an async Lambda invoke is simpler here |
| SNS / SQS / EventBridge | ✅ | |
| Secrets Manager / SSM Parameter Store | 🟡 | Usually fine. Lambda env vars are simpler and free |
| RDS | 🟡 | Available, **keeps billing after the session ends**. DynamoDB is safer on $50 |
| CloudFront | 🟡 | Often works. S3 static hosting is the reliable fallback |
| Amplify Hosting | 🟡 | Frequently restricted. Do not build the demo around it |
| Route 53 | 🟡 | Hosted zones usually work; domain registration does not |
| ACM | 🟡 | Certificate issuance often restricted, so plan for HTTP or an ALB |
| **IAM (create)** | ❌ | Use LabRole / LabInstanceProfile |
| **Bedrock** | ❌ | Use OpenRouter / NVIDIA NIM |
| SageMaker | ❌ | Training is blocked |
| Organizations / Control Tower | ❌ | |
| Budgets / Cost Explorer | ❌ | Watch the credit counter in the lab UI instead |

---

## Watching the $50

The counter in the Learner Lab UI updates roughly every 8 hours, so it lags —
do not treat it as live.

What actually costs money at this project's scale:

| Line item | Risk | Why |
|---|---|---|
| **EC2 left running** | 🔴 Highest | A t3.small left up for a week is real money. It stops with the session, which is accidentally protective |
| **NAT Gateway** | 🔴 Highest | ~$32/month and it does **not** stop with the session. Never create one |
| **RDS** | 🟠 High | Keeps billing after the session ends |
| Elastic IP **not attached** | 🟠 | Free while attached to a running instance, charged while idle |
| Textract | 🟡 | Per page, scans only |
| Polly | 🟡 | Per character, read-aloud only |
| Lambda / API GW / DynamoDB / S3 | 🟢 | Free tier covers a hackathon comfortably |

The single most expensive mistake available to you is a NAT Gateway created by
following a "production VPC" tutorial. There is no reason for one here.

---

## Credential hygiene

Session credentials are short-lived but they are still credentials, and the
**SSH private key from the lab is not short-lived** — it is the same key for
every instance you launch.

- Put credentials in `~/.aws/credentials` only. Never in the repo, a chat, a
  ticket, or a screenshot.
- The SSH `.pem`: `chmod 400`, keep it outside the repo. `.gitignore` covers
  `*.pem` and `*.ppk` already.
- If a key is ever exposed, restrict the instance's security group to your own
  IP (`My IP` in the console) and replace `~/.ssh/authorized_keys` on the box.
- Anyone who needs to deploy pulls their own credentials from their own Learner
  Lab. Nobody should be sharing a set.
