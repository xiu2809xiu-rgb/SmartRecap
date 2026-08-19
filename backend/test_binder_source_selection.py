import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import AuthenticatedRoute
from app.binder_api import build_binder_router
from app.config import Settings
from app.models import Citation
from app.ui_api import build_ui_router


async def _unused_extract(*_args, **_kwargs):
    raise RuntimeError("PDF extraction is not used by these tests")


class BinderSourceSelectionTests(unittest.TestCase):
    def setUp(self):
        settings = Settings(
            _env_file=None,
            jwt_secret="test-secret-that-is-long-and-random-enough",
            table_name="",
            s3_bucket="",
            demo_mode=True,
        )
        app = FastAPI()
        app.router.route_class = AuthenticatedRoute
        app.include_router(build_ui_router(_unused_extract, settings))
        app.include_router(build_binder_router(_unused_extract, settings))
        self.client = TestClient(app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        guest = self.client.post("/api/auth/guest").json()
        self.headers = {"Authorization": f"Bearer {guest['token']}"}

    def create_binder(self, name="Selection test"):
        response = self.client.post("/api/binders", headers=self.headers, json={"name": name})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()["id"]

    def create_note(self, binder_id, title, text):
        response = self.client.post(
            f"/api/binders/{binder_id}/sources/text",
            headers=self.headers,
            json={"title": title, "text": text},
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()["id"]

    def wait_for_job(self, job_id):
        for _ in range(100):
            response = self.client.get(f"/api/jobs/{job_id}", headers=self.headers)
            self.assertEqual(response.status_code, 200, response.text)
            job = response.json()
            if job["status"] != "running":
                return job
            time.sleep(0.01)
        self.fail("Binder generation did not finish")

    def generate(self, binder_id, source_ids=None):
        captured = []

        def fake_pack(records, *_args, **_kwargs):
            captured.extend(record.id for record in records)
            record = records[0]
            citation = Citation(
                label="Note",
                excerpt=record.text[:40],
                source_id=record.id,
                source_name=record.filename,
            )
            return SimpleNamespace(
                overview="Scoped overview",
                read_minutes=1,
                takeaways=[SimpleNamespace(text="Scoped takeaway", citation=citation)],
                topics=[],
                definitions=[],
                warnings=[],
            )

        body = None if source_ids is None else {"sourceIds": source_ids}
        with patch("app.binder_api.generate_notebook_pack", side_effect=fake_pack), patch(
            "app.binder_api.generate_notebook_quiz",
            return_value=(SimpleNamespace(questions=[]), ["test"]),
        ):
            response = self.client.post(
                f"/api/binders/{binder_id}/generate",
                headers=self.headers,
                json=body,
            ) if body is not None else self.client.post(
                f"/api/binders/{binder_id}/generate", headers=self.headers
            )
            self.assertEqual(response.status_code, 202, response.text)
            job = self.wait_for_job(response.json()["jobId"])
        self.assertEqual(job["status"], "ready", job)
        return response.json(), job, captured

    def test_selection_validation_and_owner_isolation(self):
        binder_id = self.create_binder()
        too_long = self.client.post(
            f"/api/binders/{binder_id}/sources/text",
            headers=self.headers,
            json={"title": "Too long", "text": "x" * 100_001},
        )
        self.assertEqual(too_long.status_code, 422)
        ready_id = self.create_note(binder_id, "Ready", "Selected note text")
        pending = self.client.post(
            f"/api/binders/{binder_id}/sources",
            headers=self.headers,
            json={"files": [{"fileName": "pending.pdf", "sizeBytes": 10}]},
        ).json()["created"][0]["id"]

        duplicate = self.client.post(
            f"/api/binders/{binder_id}/generate",
            headers=self.headers,
            json={"sourceIds": [ready_id, ready_id]},
        )
        self.assertEqual(duplicate.status_code, 422)
        not_ready = self.client.post(
            f"/api/binders/{binder_id}/generate",
            headers=self.headers,
            json={"sourceIds": [pending]},
        )
        self.assertEqual(not_ready.status_code, 409)
        missing = self.client.post(
            f"/api/binders/{binder_id}/generate",
            headers=self.headers,
            json={"sourceIds": ["src_missing"]},
        )
        self.assertEqual(missing.status_code, 404)

        other_guest = self.client.post("/api/auth/guest").json()
        other_headers = {"Authorization": f"Bearer {other_guest['token']}"}
        other_binder = self.client.post(
            "/api/binders", headers=other_headers, json={"name": "Other owner"}
        ).json()["id"]
        foreign_id = self.client.post(
            f"/api/binders/{other_binder}/sources/text",
            headers=other_headers,
            json={"title": "Private", "text": "Other owner's note"},
        ).json()["id"]
        foreign = self.client.post(
            f"/api/binders/{binder_id}/generate",
            headers=self.headers,
            json={"sourceIds": [foreign_id]},
        )
        self.assertEqual(foreign.status_code, 404)

    def test_subset_generation_provenance_and_rename(self):
        binder_id = self.create_binder()
        selected_id = self.create_note(binder_id, "Selected", "Only this note supports the recap")
        unselected_id = self.create_note(binder_id, "Unselected", "This must not be used")

        response, job, captured = self.generate(binder_id, [selected_id])
        self.assertEqual(response["sourceIds"], [selected_id])
        self.assertEqual(job["sourceIds"], [selected_id])
        self.assertEqual(captured, [selected_id])

        binder = self.client.get(f"/api/binders/{binder_id}", headers=self.headers).json()
        self.assertEqual(binder["sourceIds"], [selected_id])
        self.assertEqual([item["sourceId"] for item in binder["sourceSelection"]], [selected_id])
        self.assertEqual([item["sourceId"] for item in binder["sourcesSummary"]], [selected_id])
        self.assertEqual({item["sourceId"] for item in binder["chunks"]}, {selected_id})
        resolved = binder["recap"]["sections"][0]["points"][0]["resolvedCitations"]
        self.assertEqual([item["sourceId"] for item in resolved], [selected_id])
        source_ids = {
            item["id"]
            for item in self.client.get(
                f"/api/binders/{binder_id}/sources", headers=self.headers
            ).json()
        }
        self.assertEqual(source_ids, {selected_id, unselected_id})

        renamed = self.client.patch(
            f"/api/sources/{selected_id}",
            headers=self.headers,
            json={"displayName": "Renamed selection"},
        )
        self.assertEqual(renamed.status_code, 200, renamed.text)
        binder = self.client.get(f"/api/binders/{binder_id}", headers=self.headers).json()
        self.assertEqual(binder["sourceSelection"][0]["displayName"], "Renamed selection")
        self.assertEqual(binder["sourcesSummary"][0]["displayName"], "Renamed selection")
        resolved = binder["recap"]["sections"][0]["points"][0]["resolvedCitations"]
        self.assertEqual(resolved[0]["displayName"], "Renamed selection")

    def test_no_body_uses_all_ready_and_delete_invalidation_is_scoped(self):
        binder_id = self.create_binder()
        first_id = self.create_note(binder_id, "First", "First ready note")
        second_id = self.create_note(binder_id, "Second", "Second ready note")
        response, _job, captured = self.generate(binder_id)
        self.assertEqual(response["sourceIds"], [first_id, second_id])
        self.assertEqual(captured, [first_id, second_id])

        # Regenerate from only the first source, then deleting the unselected
        # source must neither delete the first nor invalidate its valid recap.
        self.generate(binder_id, [first_id])
        deleted = self.client.delete(f"/api/sources/{second_id}", headers=self.headers)
        self.assertEqual(deleted.status_code, 204, deleted.text)
        binder = self.client.get(f"/api/binders/{binder_id}", headers=self.headers).json()
        self.assertIsNotNone(binder["recap"])
        self.assertEqual(binder["sourceIds"], [first_id])
        self.assertEqual(binder["sourceCount"], 1)

        deleted = self.client.delete(f"/api/sources/{first_id}", headers=self.headers)
        self.assertEqual(deleted.status_code, 204, deleted.text)
        binder = self.client.get(f"/api/binders/{binder_id}", headers=self.headers).json()
        self.assertIsNone(binder["recap"])
        self.assertEqual(binder["sourceIds"], [])
        self.assertEqual(binder["sourceSelection"], [])


if __name__ == "__main__":
    unittest.main()
