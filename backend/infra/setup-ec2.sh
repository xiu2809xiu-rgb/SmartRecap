#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Provision a fresh Amazon Linux 2023 instance to run the SmartRecap API.
#
# Run it ON the instance, after SSHing in:
#
#   ssh -i labsuser.pem ec2-user@<public-ip>
#   git clone https://gitlab.com/LEBRONISGOAT23/smartrecap.git
#   cd smartrecap/backend
#   bash infra/setup-ec2.sh
#
# It installs Node 20, nginx and dependencies, then writes the systemd unit and
# the nginx config. It does NOT write your secrets — it creates
# /etc/smartrecap.env as a template for you to fill in, because a script that
# takes API keys as arguments puts them in your shell history.
#
# Idempotent: safe to re-run after a `git pull`.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/etc/smartrecap.env

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }

# --- Node 20 --------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  say "Installing Node 20"
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
  sudo dnf install -y nodejs
else
  say "Node $(node -v) already present"
fi

# --- nginx ----------------------------------------------------------------
if ! command -v nginx >/dev/null 2>&1; then
  say "Installing nginx"
  sudo dnf install -y nginx
fi

# --- dependencies ---------------------------------------------------------
say "Installing backend dependencies"
cd "$REPO_DIR"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# --- environment file -----------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  say "Creating $ENV_FILE — you must fill this in"
  sudo tee "$ENV_FILE" >/dev/null <<'ENVEOF'
# SmartRecap API environment. Read by systemd; never commit this file.
#
# Fill in the four values from the CloudFormation stack outputs:
#   aws cloudformation describe-stacks --stack-name smartrecap-data \
#     --query 'Stacks[0].Outputs' --output table

AWS_REGION=us-east-1
TABLE_NAME=
BUCKET_NAME=
USER_POOL_ID=
USER_POOL_CLIENT_ID=

# openssl rand -base64 32
JWT_SECRET=

# https://openrouter.ai/keys  — primary provider
OPENROUTER_API_KEY=
OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct:free

# https://build.nvidia.com  — used when OpenRouter rate-limits or times out
NVIDIA_API_KEY=
NVIDIA_MODEL=meta/llama-3.3-70b-instruct

# Google sign-in. Must be the SAME client id the frontend uses as
# VITE_GOOGLE_CLIENT_ID — the server verifies the token's audience against it,
# so a mismatch fails every Google login. Leave blank to disable it.
GOOGLE_CLIENT_ID=

# Your frontend URL once you have one. '*' is fine while developing.
ALLOWED_ORIGIN=*
PUBLIC_WEB_ORIGIN=

PORT=3000
ENVEOF
  sudo chmod 600 "$ENV_FILE"
else
  say "$ENV_FILE already exists — leaving it alone"
fi

# --- systemd --------------------------------------------------------------
say "Installing the systemd unit"
sudo cp "$REPO_DIR/infra/smartrecap.service" /etc/systemd/system/smartrecap.service
sudo systemctl daemon-reload
sudo systemctl enable smartrecap

# --- nginx config ---------------------------------------------------------
say "Installing the nginx config"
sudo cp "$REPO_DIR/infra/nginx.conf" /etc/nginx/conf.d/smartrecap.conf
sudo rm -f /etc/nginx/conf.d/default.conf
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

# --- done -----------------------------------------------------------------
cat <<'DONE'

Setup complete. Two things left, in this order:

  1. Fill in the secrets:
       sudo nano /etc/smartrecap.env

  2. Start the API:
       sudo systemctl start smartrecap
       sudo systemctl status smartrecap
       curl localhost/health

Then, from your laptop, confirm it is reachable:
       curl http://<public-ip>/health

If that hangs, the security group is not allowing port 80 inbound. If it is
refused, nginx is not running. If it returns 502, the Node process is not —
check `sudo journalctl -u smartrecap -n 50`.

Reminders for Learner Lab:
  - The instance STOPS when your lab session ends. `systemctl enable` means the
    API restarts by itself when the instance boots again, but you still have to
    start the instance.
  - Allocate an Elastic IP and associate it, or the public IP changes on every
    restart and the frontend's VITE_API_BASE_URL breaks each time.
  - The instance needs LabInstanceProfile attached for DynamoDB, S3, Textract,
    Polly and Cognito access. Set it at launch under Advanced Details, or add
    it afterwards with Actions > Security > Modify IAM role.

DONE
