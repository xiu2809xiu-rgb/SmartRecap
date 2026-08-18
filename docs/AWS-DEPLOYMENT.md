# Deploying to AWS Academy Learner Lab

> **Active 2026 deployment:** the production app now uses the Python FastAPI backend on EC2 and React on Amplify. Follow [`AWS-HACKATHON.md`](AWS-HACKATHON.md). The Lambda/Node instructions below are retained only as a legacy alternative.

Written for the Learner Lab specifically, because the things that go wrong there
are not the things that go wrong in a normal AWS account.

## Before you start

- Region must be **us-east-1**. Learner Lab only allows us-east-1 and us-west-2,
  and every service used here is available in us-east-1.
- Install the AWS SAM CLI and Node 20.
- Start the lab and wait for the AWS indicator to turn green.

## Step 1 — credentials

Click **AWS Details** in the Learner Lab, then **AWS CLI: Show**. Copy the block
into `~/.aws/credentials`. It looks like:

```ini
[default]
aws_access_key_id=ASIA...
aws_secret_access_key=...
aws_session_token=...
```

**These expire when the lab session ends.** Every time you restart the lab you
must copy them again. This is the single most common cause of "it worked
yesterday" — the resources are fine, your credentials are not.

Check it took:

```bash
aws sts get-caller-identity
```

## Step 2 — find your LabRole ARN

Learner Lab accounts **cannot create IAM roles**, which is why `template.yaml`
takes an existing one as a parameter instead of letting SAM generate policies.

```bash
aws iam get-role --role-name LabRole --query 'Role.Arn' --output text
```

Save what it prints — `arn:aws:iam::123456789012:role/LabRole`.

## Step 3 — get your model API keys

Both are free and neither asks for a card.

**OpenRouter** — sign up at <https://openrouter.ai>, then Keys → Create Key.
Free-tier limits are 50 requests per day (1,000 if you have ever bought $10 of
credit) and 20 per minute on `:free` model variants. That per-minute cap is why
the backend has a second provider.

**NVIDIA NIM** — sign up at <https://build.nvidia.com>, join the free developer
programme, generate an API key. Roughly 40 requests per minute.

Configure both. One rate-limiting mid-demo with no fallback is the failure mode
this is designed around.

## Step 4 — generate a JWT secret

```bash
openssl rand -base64 32
```

Session tokens are signed with this. Rotating it signs everyone out.

## Step 5 — deploy

```bash
cd backend
npm install
sam build
sam deploy --guided
```

Answer the prompts:

| Prompt | Answer |
|---|---|
| Stack Name | `smartrecap` |
| AWS Region | `us-east-1` |
| `LabRoleArn` | From step 2 |
| `OpenRouterApiKey` | From step 3 |
| `NvidiaApiKey` | From step 3 |
| `OpenRouterModel` | Accept the default, or any `:free` model id |
| `NvidiaModel` | Accept the default |
| `JwtSecret` | From step 4 |
| `AllowedOrigin` | `*` for now |
| Confirm changes before deploy | `n` |
| Allow SAM CLI IAM role creation | **`n`** — this is the one that matters |
| Disable rollback | `n` |
| Save arguments to configuration file | `y` |

The deploy takes three to five minutes, mostly Cognito.

When it finishes, copy `ApiUrl` from the Outputs table.

> `samconfig.toml` now contains your API keys and JWT secret. It is gitignored.
> Keep it that way.

## Step 6 — point the frontend at it

In the repository root:

```bash
echo "VITE_API_BASE_URL=https://xxxx.execute-api.us-east-1.amazonaws.com/prod" > .env.local
npm install
npm run dev
```

The amber "Demo mode" banner disappears once the frontend can reach the API.
Upload a real deck to confirm the pipeline end to end.

## Step 7 — host the frontend

```bash
npm run build
aws s3 mb s3://smartrecap-web-$(aws sts get-caller-identity --query Account --output text)
aws s3 website s3://smartrecap-web-... --index-document index.html --error-document index.html
aws s3 sync dist/ s3://smartrecap-web-... --delete
```

Then make the bucket publicly readable with a bucket policy — S3 static website
hosting needs it, and this bucket holds only your compiled frontend.

Set `--error-document index.html`. SmartRecap is a single-page app, so a direct
hit on `/app/progress` must serve `index.html` and let the router take over,
otherwise every deep link and every shared recap link 404s.

Finally, redeploy the backend with `AllowedOrigin` set to your site URL rather
than `*`.

**Note on Amplify Hosting:** it is usually restricted in Learner Lab. S3 static
hosting works reliably and costs effectively nothing at this scale.

---

## Things that will go wrong

**`User is not authorized to perform: iam:CreateRole`**
You answered `y` to "Allow SAM CLI IAM role creation". Delete the stack and
redeploy answering `n`.

**`ExpiredToken` / `InvalidClientTokenId`**
Lab session ended. Copy fresh credentials from AWS Details (step 1).

**Stack stuck in `ROLLBACK_COMPLETE`**
CloudFormation cannot update a stack in that state. Delete and redeploy:
`aws cloudformation delete-stack --stack-name smartrecap`

**`NotAuthorizedException` on sign-up**
The user pool client is missing `ALLOW_USER_PASSWORD_AUTH`. It is in the
template — confirm the stack updated rather than partially rolling back.

**Recap generation returns 502**
Check the logs: `sam logs --stack-name smartrecap --name ProcessorFunction --tail`
Usually one of: both provider keys missing, both rate limited (wait a minute), or
the chosen model id no longer exists on OpenRouter — the free roster rotates,
so check <https://openrouter.ai/models?q=free> and update the `OpenRouterModel`
parameter.

**Textract `AccessDeniedException`**
LabRole covers Textract, but confirm you are in us-east-1. Some services in the
Learner Lab allowlist are region-limited.

**Bucket name already exists**
S3 bucket names are globally unique. The template appends your account id, but
if you deployed once, deleted the stack, and redeployed, the old bucket may
still exist — S3 buckets are not deleted with the stack if they contain objects.
Empty and delete it manually.

---

## Costs on a $50 budget

| Service | At demo volume | Notes |
|---|---|---|
| Lambda | Free tier | 1M requests/month free |
| API Gateway | ~$0 | 1M calls/month free for 12 months |
| DynamoDB | ~$0 | Pay-per-request; a demo is thousands of units, not millions |
| S3 | ~$0 | Decks are megabytes, and a lifecycle rule expires them at 30 days |
| Cognito | Free | 50,000 monthly active users free |
| Textract | **~$1.50 per 1,000 pages** | Only fires on scans with no text layer |
| Polly | **$4 per 1M characters** | Only fires on read-aloud; each recap is ~3,000 characters |
| CloudWatch | ~$0 | API logging is set to ERROR for this reason |
| OpenRouter / NVIDIA NIM | $0 | Free tiers |

The two to watch are Textract and Polly, and both are opt-in per action. A
hackathon's worth of testing will not come close to $50.

## Between lab sessions

Resources persist. Only EC2 instances stop when a session ends, and there are
none here — Lambda, API Gateway, DynamoDB, S3 and Cognito keep serving.

That means **your deployed demo stays live between lab sessions.** You only need
an active session to deploy changes, not to run the thing. Worth knowing before
demo day.
