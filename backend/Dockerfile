# SmartRecap FastAPI backend.
#
# Build from the REPOSITORY ROOT so the build context can see nothing it does
# not need:
#
#   docker build -f backend/Dockerfile -t smartrecap-api .
#
# The dependency set is the thing that shapes this file. torch, torchvision,
# paddlepaddle, paddleocr and pix2text together are the overwhelming majority
# of the image, and installed naively they arrive as CUDA builds — several GB of
# GPU runtime that a t3 instance has no GPU to use. So torch is installed first
# from PyPI's CPU-only index, and everything else afterwards from the normal
# index, which then sees torch already satisfied and leaves it alone. That one
# ordering decision is worth roughly 2.5 GB.
#
# Python 3.11 rather than 3.13: the pinned ML stack (paddlepaddle 3.3.1,
# pix2text 1.1.6) does not publish wheels for every newer interpreter, and a
# missing wheel here means a source build that will not finish on a small box.

# ---------------------------------------------------------------- builder ---
FROM python:3.11-slim AS builder

# Build-only toolchain. Kept out of the runtime image entirely.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        g++ \
    && rm -rf /var/lib/apt/lists/*

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copied on its own so the (very slow) dependency layer is cached and only
# reinstalls when the pins actually change — not on every source edit.
COPY backend/requirements.txt /tmp/requirements.txt

# CPU-only torch, before anything else can pull the CUDA build in as a
# transitive dependency.
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
        torch==2.7.1 \
        torchvision==0.22.1

RUN pip install -r /tmp/requirements.txt

# ---------------------------------------------------------------- runtime ---
FROM python:3.11-slim AS runtime

# opencv needs libGL and glib even in its headless build; libgomp is OpenMP,
# which torch and paddle both link against. Everything else the wheels bundle.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv

# HOME and XDG_CACHE_HOME both point at a writable path the app user owns:
# RapidOCR and PaddleOCR download model weights on first use and write them
# under the cache directory, which has to work as a non-root process. Mirrors
# what infra/smartrecap.service already does on a bare instance.
#
# Note: no comments inside this continuation — a `#` line between `\`-joined
# lines is not reliably stripped by every Dockerfile parser.
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/var/lib/smartrecap \
    XDG_CACHE_HOME=/var/lib/smartrecap/cache

# Runs unprivileged. Nothing here needs root, and this process parses untrusted
# uploaded documents, which is exactly the code you least want running as root.
RUN useradd --create-home --home-dir /var/lib/smartrecap --shell /usr/sbin/nologin smartrecap \
    && install -d -o smartrecap -g smartrecap -m 0750 /var/lib/smartrecap/cache

WORKDIR /app
COPY --chown=smartrecap:smartrecap backend/app ./app

USER smartrecap
EXPOSE 8000

# The model caches survive a container replacement only if this is a volume.
# Without it every new container re-downloads OCR weights on its first request,
# which reads as a hung upload.
VOLUME ["/var/lib/smartrecap/cache"]

# `start-period` is generous because importing torch and paddle takes a while
# on a cold start, and a container killed during import never recovers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

# One worker on purpose. The OCR path already uses a ProcessPoolExecutor of its
# own, and a second uvicorn worker would multiply the resident torch/paddle
# footprint rather than the throughput. Scale with instance size, not workers.
CMD ["python", "-m", "uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
