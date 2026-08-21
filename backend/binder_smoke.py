"""End-to-end smoke test for the binder lifecycle, with no AWS and no network.

Covers the whole path a student's binder actually takes: create it, register a
source, upload the bytes, commit, wait for extraction, generate the recap, and
check the recap's chunks cite the source that produced them -- then delete both
and confirm they are gone.

Run it from anywhere:

    backend/.venv/Scripts/python.exe backend/binder_smoke.py

Why the auth setup below exists: the binder routes are served by an APIRouter
built with `route_class=AuthenticatedRoute`, so every request through them needs
a Bearer session. That router builds its own repository but does not configure
authentication -- `ui_api` is what normally calls `configure_auth` -- and this
script mounts the binder router alone. Without the two lines that follow, every
request here returns 401 "A Bearer session is required." before it reaches any
binder code, which is exactly how this script silently stopped working when the
routes were put behind auth.
"""

import sys
import time
from pathlib import Path

# Resolved from this file, not the working directory, so the script runs
# the same from backend/ or from the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import configure_auth
from app.binder_api import build_binder_router
from app.config import Settings
from app.models import SourceRecord
from app.repository import DurableRepository
from app.storage import ObjectStorage

TEXT = "[Page 1]\n" + "\n".join([
    "A geometric progression is a sequence where each term uses a constant common ratio.",
    "The common ratio is found by dividing a term by the preceding term.",
    "The nth term formula allows any term to be calculated without listing earlier terms.",
    "A finite geometric series uses the first term, ratio, and number of terms.",
    "An infinite geometric series converges when the absolute common ratio is below one.",
    "Compound growth can be represented by a geometric progression because changes multiply repeatedly.",
])


async def extract(content, filename, content_type, deep):
    """Stand in for the real extractor, so the test needs no PDF parser."""
    return SourceRecord(
        id="temporary", filename=filename, content_type=content_type,
        size=len(content), text=TEXT, labels=["Page 1"],
    )


# One Settings instance shared by the router and the auth service. configure_auth
# rebuilds its singleton when handed different settings, so passing the same
# object keeps both halves agreeing about demo mode.
settings = Settings(_env_file=None, demo_mode=True, s3_bucket="", table_name="")

# This repository is only the one AuthService persists users through; the binder
# router constructs its own internally.
auth = configure_auth(settings, DurableRepository(settings, ObjectStorage(settings)))
session = auth.guest()

app = FastAPI()
app.include_router(build_binder_router(extract, settings))

with TestClient(app) as c:
    # Set on the client rather than passed to the constructor: every request
    # below goes through AuthenticatedRoute, including the upload PUT.
    c.headers["authorization"] = "Bearer {}".format(session["token"])

    binder = c.post("/api/binders", json={"name": "Mathematics"}).json()
    assert binder.get("id"), binder

    made = c.post(
        "/api/binders/{}/sources".format(binder["id"]),
        json={"files": [{"fileName": "gp.pdf", "sizeBytes": 100}]},
    ).json()["created"][0]

    assert c.put(made["uploadUrl"], content=b"%PDF-1.4 smoke").status_code == 204
    assert c.post("/api/binders/{}/sources/{}/commit".format(binder["id"], made["id"])).status_code == 200

    for _ in range(100):
        status = c.get("/api/sources/{}/status".format(made["id"])).json()
        if status["status"] != "processing":
            break
        time.sleep(0.02)
    assert status["status"] == "ready", status

    assert c.post("/api/binders/{}/generate".format(binder["id"])).status_code == 202

    # Poll the binder through the API rather than binder_api's private _jobs
    # table. _jobs is an OwnerMap: reading it resolves the owner from the
    # request-scoped context variable, which is unset on this thread, so
    # touching it from here raises 401 before it can report anything. Watching
    # the binder for its recap tests the same thing through the door the app
    # actually uses.
    for _ in range(400):
        result = c.get("/api/binders/{}".format(binder["id"])).json()
        if result.get("chunks"):
            break
        time.sleep(0.02)

    # The point of the whole exercise: a chunk in the generated recap has to
    # point back at the source it came from, or grounding is not grounded.
    assert result.get("chunks"), result
    assert result["chunks"][0]["sourceId"] == made["id"], result["chunks"][0]

    assert c.get("/api/sources/{}/content".format(made["id"])).status_code == 200
    assert c.delete("/api/sources/{}".format(made["id"])).status_code == 204
    assert c.delete("/api/binders/{}".format(binder["id"])).status_code == 204

print("binder lifecycle smoke: passed")
