#!/usr/bin/env bash
# Provision the active Python/FastAPI backend on Amazon Linux 2023.
# Run from the cloned repository: bash backend/infra/setup-ec2.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
ENV_FILE=/etc/smartrecap.env
STATE_DIR=/var/lib/smartrecap

say() { printf '\n==> %s\n' "$1"; }

say "Installing Python, nginx, and OCR runtime libraries"
sudo dnf install -y python3.11 python3.11-pip nginx git gcc-c++ libgomp mesa-libGL

say "Creating the isolated Python environment"
if [ ! -x "$BACKEND_DIR/.venv/bin/python" ]; then
  python3.11 -m venv "$BACKEND_DIR/.venv"
fi
"$BACKEND_DIR/.venv/bin/python" -m pip install --upgrade pip
# Force CPU-only PyTorch wheels before Pix2Text resolves its dependencies; do not install CUDA or diffusers on t3.xlarge.
"$BACKEND_DIR/.venv/bin/python" -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.7.1 torchvision==0.22.1
"$BACKEND_DIR/.venv/bin/python" -m pip install -r "$BACKEND_DIR/requirements.txt"

say "Preparing writable OCR model caches"
sudo install -d -o ec2-user -g ec2-user -m 0750 "$STATE_DIR" "$STATE_DIR/cache"

if [ ! -f "$ENV_FILE" ]; then
  say "Creating $ENV_FILE; add provider keys before starting"
  sudo tee "$ENV_FILE" >/dev/null <<'ENVEOF'
# Never commit this file. Keep ownership root:root and mode 600.
DEMO_MODE=false
CORS_ORIGINS=https://main.YOUR_AMPLIFY_APP_ID.amplifyapp.com
MAX_FILE_MB=25
ENABLE_PADDLE_OCR=true
ENABLE_MATH_OCR=true
MATH_OCR_MAX_PAGES=8
OCR_MAX_IMAGES=24
OCR_TIME_BUDGET_SECONDS=120
AI_TIMEOUT_SECONDS=300
AWS_REGION=us-east-1
S3_BUCKET=
S3_PREFIX=smartrecap

# openssl rand -base64 32
JWT_SECRET=

# Optional provider configuration. Keep credentials in /etc/smartrecap.env only.
OPENROUTER_API_KEY=
OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct:free
NVIDIA_API_KEY=
NVIDIA_MODEL=meta/llama-3.3-70b-instruct
GOOGLE_CLIENT_ID=
ALLOWED_ORIGIN=*
PUBLIC_WEB_ORIGIN=

GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
AZURE_AI_ENDPOINT=
AZURE_AI_API_KEY=
AZURE_OPENAI_DEPLOYMENT=gpt-5.6-sol
AZURE_FAST_DEPLOYMENT=gpt-5.6-sol
OPENAI_API_KEY=
OPENAI_CHAT_MODEL=gpt-4.1-mini
POLLINATIONS_API_KEY=
POLLINATIONS_MODEL=zimage
TABLE_NAME=
PORT=8000
ENVEOF
  sudo chmod 600 "$ENV_FILE"
fi

say "Installing the systemd unit"
sudo sed "s|__REPO_ROOT__|$REPO_ROOT|g" \
  "$BACKEND_DIR/infra/smartrecap.service" \
  | sudo tee /etc/systemd/system/smartrecap.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable smartrecap

say "Installing nginx with API and WebSocket proxying"
sudo cp "$BACKEND_DIR/infra/nginx.conf" /etc/nginx/conf.d/smartrecap.conf
sudo rm -f /etc/nginx/conf.d/default.conf
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

say "Validating the Python application imports"
"$BACKEND_DIR/.venv/bin/python" -m compileall -q "$BACKEND_DIR/app"
PYTHONPATH="$BACKEND_DIR" "$BACKEND_DIR/.venv/bin/python" -c "from app.main import app; print(app.title)" \
  2>/dev/null || {
    echo "Import failed. Review the Python dependency output above." >&2
    exit 1
  }

cat <<'DONE'

FastAPI host setup is complete.

1. Add the three AI provider credentials and exact Amplify origin:
     sudo vi /etc/smartrecap.env
2. Start and inspect the service:
     sudo systemctl restart smartrecap
     sudo systemctl status smartrecap --no-pager
     curl http://127.0.0.1:8000/api/health
     curl http://127.0.0.1/api/health
3. View logs without exposing /etc/smartrecap.env:
     sudo journalctl -u smartrecap -n 100 --no-pager

One Uvicorn worker is intentional: current quiz, material, and lobby state is
in-memory. Multiple workers would split that state until durable storage is
introduced.
DONE
