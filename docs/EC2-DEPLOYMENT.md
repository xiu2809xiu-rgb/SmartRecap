# Running the API on EC2

> **Active backend:** use [`AWS-HACKATHON.md`](AWS-HACKATHON.md), `backend/infra/ec2-fastapi.yaml`, and `backend/infra/setup-ec2.sh`. The older Express details below describe the inactive Node/AWS implementation retained for reference.

The SmartRecap API runs on EC2 behind Express, or on Lambda behind API Gateway.
Both call the same `core/` functions, so behaviour is identical and you can
switch later without rewriting anything.

This is the EC2 path. For the serverless path see `AWS-DEPLOYMENT.md`.

---

## What you are building

```
Browser ──► nginx :80 ──► node :3000 ──┬─► DynamoDB   (recaps, attempts, jobs)
   │                                    ├─► S3         (uploaded files)
   │                                    ├─► Cognito    (identity)
   └── PUT file ────────────────────────┤   Textract   (OCR for scans)
       straight to S3                   └─► Polly      (read-aloud)
                                            OpenRouter / NVIDIA NIM
```

Only the API runs on the instance. Everything stateful stays in managed
services, which matters: **the instance stops when your lab session ends, and a
box with your only copy of the data on it is a bad place for the data to live.**

---

## Read this before you start

**The instance stops when the four-hour lab session ends.** When you start it
again the public IP has changed, so anything pointing at the old one breaks.

Two things make that survivable, and both take five minutes:

1. **Allocate an Elastic IP and associate it with the instance.** It survives
   stop/start, so the address in your frontend config stays correct forever.
   Do this before you tell anyone the URL.
2. **Run the API under systemd with `enable`,** so it starts on boot without
   anyone SSHing in. `node src/server.js` in a terminal dies with your
   connection and does not come back.

Details and the rest of the Learner Lab constraints: `LEARNER-LAB-LIMITS.md`.

---

## Step 1 — create the stateful resources

From your laptop, with lab credentials in `~/.aws/credentials`:

```bash
cd backend
aws cloudformation deploy \
  --template-file infra/ec2-resources.yaml \
  --stack-name smartrecap-data \
  --region us-east-1
```

No `--capabilities` flag: nothing in that template creates an IAM role, which
Learner Lab would refuse anyway.

Get the values you will need on the instance:

```bash
aws cloudformation describe-stacks --stack-name smartrecap-data \
  --query 'Stacks[0].Outputs' --output table
```

---

## Step 2 — launch the instance

In the EC2 console, **Launch instance**:

| Setting | Value |
|---|---|
| AMI | Amazon Linux 2023 |
| Instance type | `t3.small` — `t2.micro` has 1 GB and PDF extraction will OOM |
| Key pair | `vockey` (the one the Learner Lab gives you) |
| Network → Auto-assign public IP | Enable |
| Security group | Allow SSH (22) **from your IP only**, and HTTP (80) from anywhere |
| **Advanced → IAM instance profile** | **`LabInstanceProfile`** |

That last row is the one people miss. Without it the instance has no AWS
credentials and every DynamoDB call fails with `AccessDenied`. You can add it
afterwards with **Actions → Security → Modify IAM role**, then reboot.

Then allocate an Elastic IP (**Network & Security → Elastic IPs → Allocate**)
and associate it with the instance.

---

## Step 3 — provision it

```bash
chmod 400 labsuser.pem
ssh -i labsuser.pem ec2-user@<elastic-ip>

sudo dnf install -y git
git clone https://gitlab.com/LEBRONISGOAT23/smartrecap.git
cd smartrecap/backend
bash infra/setup-ec2.sh
```

That installs Node 20, nginx and dependencies, then writes the systemd unit and
the nginx config. It deliberately does **not** take your API keys as arguments —
a script that does puts them in your shell history.

---

## Step 4 — fill in the secrets

```bash
sudo nano /etc/smartrecap.env
```

| Variable | Where from |
|---|---|
| `TABLE_NAME`, `BUCKET_NAME`, `USER_POOL_ID`, `USER_POOL_CLIENT_ID` | Stack outputs, step 1 |
| `JWT_SECRET` | `openssl rand -base64 32` |
| `OPENROUTER_API_KEY` | <https://openrouter.ai/keys> |
| `NVIDIA_API_KEY` | <https://build.nvidia.com> |
| `ALLOWED_ORIGIN` | Your frontend URL, or `*` while developing |

Configure **both** model providers. OpenRouter caps free models at 20 requests
per minute; NVIDIA NIM is the fallback when that trips mid-demo.

The file is `chmod 600` and owned by root. Do not move these into the systemd
unit — unit files are world-readable and `systemctl cat` prints them.

---

## Step 5 — start it

```bash
sudo systemctl start smartrecap
sudo systemctl status smartrecap
curl localhost/health
```

`/health` reports which providers are configured, which region and table the
process picked up, and how long it has been running. From your laptop:

```bash
curl http://<elastic-ip>/health
```

### Prove it actually works

`/health` says the process is alive. It does not say the process can reach
DynamoDB. `?deep=1` probes every AWS service the pipeline depends on with a
read-only call, so a missing instance profile or a bucket in the wrong region
shows up now rather than mid-demo:

```bash
curl "http://<elastic-ip>/health?deep=1"
```

Or run the whole check — services, guest sign-in, a presigned upload, and that
an unauthenticated read is actually rejected:

```bash
./scripts/verify-deployment.sh http://<elastic-ip>
```

It exits non-zero if anything fails, and each failure maps to a row in
[When it does not work](#when-it-does-not-work) below. The same probes back the
status panel on `/architecture`, so what a judge sees on that page is a live
reading rather than a diagram.

---

## Step 6 — point the frontend at it

In the repository root on your laptop:

```bash
echo "VITE_API_BASE_URL=http://<elastic-ip>" > .env.local
npm run dev
```

The amber "Demo mode" banner disappears once the frontend can reach the API.

### If you host the built frontend somewhere

`npm run build` emits `dist/`, which includes **`dist/pyodide/` — about 13 MB**
of WebAssembly for the practice panel. Copy the whole directory; the practice
page degrades to JavaScript-only if those files are missing, but Python
exercises will not run.

Whatever serves it must send `.wasm` as `application/wasm`, or the browser
falls back to a slower non-streaming compile and may refuse it outright. nginx
on Amazon Linux 2023 already has this in `/etc/nginx/mime.types`; check with:

```bash
curl -sI http://<your-host>/pyodide/pyodide.asm.wasm | grep -i content-type
# want: content-type: application/wasm
```

> **Mixed content:** if you later host the frontend over HTTPS, the browser will
> block calls to a plain-HTTP API. Either keep both on HTTP for the demo, or put
> a certificate on the instance. Do not discover this an hour before judging.

---

## Deploying a change

```bash
ssh -i labsuser.pem ec2-user@<elastic-ip>
cd smartrecap/backend
git pull
npm install --omit=dev
sudo systemctl restart smartrecap
sudo journalctl -u smartrecap -n 30
```

---

## After a lab session ends

1. Start the lab.
2. Start the instance (EC2 console → Instances → Start).
3. Wait about a minute. The API comes back on its own because the unit is
   `enable`d.
4. `curl http://<elastic-ip>/health` to confirm.

With an Elastic IP the address does not change, so nothing else needs touching.

---

## When it does not work

| Symptom | Cause |
|---|---|
| `curl` hangs | Security group is not allowing port 80 inbound |
| `Connection refused` | nginx is not running — `sudo systemctl status nginx` |
| `502 Bad Gateway` | nginx is up, Node is not — `sudo journalctl -u smartrecap -n 50` |
| `AccessDeniedException` on DynamoDB or S3 | LabInstanceProfile is not attached. Attach it, then **reboot** — the instance caches credentials |
| `ExpiredToken` | Only affects your laptop's CLI, not the instance. Copy fresh credentials from the lab |
| `503` on recap generation | No provider key set, or both are rate limited |
| PDF upload kills the process | Out of memory on `t2.micro`. Use `t3.small` |
| CORS errors in the browser | `ALLOWED_ORIGIN` does not match the frontend's origin exactly — scheme, host and port all count |
| `?deep=1` shows `ResourceNotFoundException` on DynamoDB | `TABLE_NAME` is wrong, or the table is in another region |
| `?deep=1` shows `NotFound` on S3 | `BUCKET_NAME` is wrong. A bucket in a different region reports `PermanentRedirect` instead |
| `?deep=1` shows `CredentialsError` on Textract | No instance profile. Everything AWS will fail the same way — fix this one first |
| A recap comes back in English after asking for another language | The translation call failed. The recap is still fully grounded; the reader says so. Check the provider keys |

Logs:

```bash
sudo journalctl -u smartrecap -f      # the API
sudo tail -f /var/log/nginx/error.log # the proxy
```

---

## Costs

A `t3.small` is roughly $0.02/hour, so about $0.50 a day if you leave it
running. It stops with your lab session, which caps the damage.

The one thing to never create is a **NAT Gateway** — around $32/month, and it
does *not* stop with the session. The default VPC needs no NAT for any of this.

An Elastic IP is free while attached to a running instance and charged while
idle, so release it when the project is over.
