# Running the backend in Docker

For deploying the FastAPI backend to EC2. The alternative — `infra/setup-ec2.sh`
building a virtualenv on the instance — still works; this is the same process in
a container, which matters mostly because the dependency install is the slow,
fragile part and an image only has to get it right once.

---

## Build and run

From the **repository root**, not from `backend/`:

```bash
docker compose -f backend/docker-compose.yml up -d --build
```

Or by hand:

```bash
docker build -f backend/Dockerfile -t smartrecap-api .
docker run -d --name smartrecap-api \
  -p 127.0.0.1:8000:8000 \
  --env-file backend/.env \
  -v ocr-cache:/var/lib/smartrecap/cache \
  smartrecap-api
```

Then check it:

```bash
curl -fsS http://127.0.0.1:8000/api/health
```

nginx already proxies `127.0.0.1:8000` — see `backend/infra/nginx.conf` — so
nothing about the public path changes.

---

## Know this before you build

**The first build takes a long time and needs disk.** torch, torchvision,
paddlepaddle, paddleocr and pix2text are the bulk of it. Budget **20–40 minutes**
and **at least 15 GB free**. Build on the instance you will run on, or on a
machine with the same architecture — an image built on an Apple Silicon Mac will
not run on an x86 EC2 instance without `--platform linux/amd64`, and building
this stack under emulation is slower than you will tolerate.

**Do not build this on a t3.small.** `infra/ec2-fastapi.yaml` allows
`t3.large` and `t3.xlarge`; the pip resolver alone will exhaust a 2 GB box.

**torch is installed from the CPU index on purpose.** `backend/Dockerfile`
installs `torch`/`torchvision` from `download.pytorch.org/whl/cpu` *before*
`requirements.txt`, so the later install sees them already satisfied. Reorder
those two steps and pip pulls the CUDA build instead — roughly 2.5 GB of GPU
runtime on an instance with no GPU. If the image is suddenly enormous, this is
why.

**OCR weights download on first use.** They are written to
`/var/lib/smartrecap/cache`, which the compose file keeps in a named volume. Drop
the volume and every fresh container re-downloads them, which looks like the
first upload hanging rather than a download. After a deploy, upload one small
file yourself before anyone demos it.

---

## Environment

`backend/.env` is read at start-up and is **gitignored — never commit it**. Copy
`backend/.env.example` and fill it in. `.dockerignore` excludes `.env` from the
build context deliberately: a secret copied into an image layer stays
recoverable from that image even if a later step deletes the file.

One entry is easy to miss and breaks a feature silently:

| Variable | Why it matters |
|---|---|
| `GOOGLE_CLIENT_ID` | Must be **byte-identical** to `VITE_GOOGLE_CLIENT_ID` on the frontend. The ID token's `aud` claim is checked against it, so a mismatch rejects every Google sign-in with "could not be verified" — while email sign-in keeps working, which makes it look like a Google problem rather than a config one. Leave blank to disable Google sign-in. |

---

## When it does not work

| Symptom | Cause |
|---|---|
| Build dies without a message | Out of memory or disk. Check `df -h` and the instance size |
| `no space left on device` | `docker system prune -af` then rebuild; old layers of this image are large |
| Container restarts in a loop | `docker logs smartrecap-api`. Usually a missing var in `.env` |
| Healthcheck stuck `starting` for minutes | Expected on a cold start — importing torch and paddle is slow. `start-period` is 180s |
| Still unhealthy after 3 minutes | `docker exec -it smartrecap-api curl -v localhost:8000/api/health` |
| First upload hangs, later ones are fine | OCR weights downloading. Confirm the cache volume is mounted |
| `exec format error` | Image built for a different architecture. Rebuild with `--platform linux/amd64` |
| Google sign-in fails, email works | `GOOGLE_CLIENT_ID` missing or not matching the frontend's |
| Every OCR request fails with a libGL error | The runtime stage lost `libgl1`. It is required even by headless opencv |

Logs:

```bash
docker logs -f smartrecap-api
docker compose -f backend/docker-compose.yml ps
```
