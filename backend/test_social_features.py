import itertools
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import AuthenticatedRoute
from app.config import Settings
from app.social_api import build_social_router
from app.ui_api import build_ui_router


async def _unused_extract(*_args, **_kwargs):
    raise RuntimeError("not used by social feature tests")


class SocialFeatureTests(unittest.TestCase):
    counter = itertools.count()

    @classmethod
    def setUpClass(cls):
        settings = Settings(
            _env_file=None,
            jwt_secret="social-feature-tests-secret-with-sufficient-length",
            table_name="",
            s3_bucket="",
            demo_mode=True,
        )
        app = FastAPI()
        app.router.route_class = AuthenticatedRoute
        app.include_router(build_ui_router(_unused_extract, settings))
        app.include_router(build_social_router(settings))
        cls.client = TestClient(app)

    @staticmethod
    def auth(session):
        return {"Authorization": f"Bearer {session['token']}"}

    def signup(self, label):
        suffix = next(self.counter)
        guest = self.client.post("/api/auth/guest").json()
        response = self.client.post(
            "/api/auth/signup",
            headers=self.auth(guest),
            json={
                "email": f"{label}-{suffix}@social.test",
                "name": label.title(),
                "password": "correct horse battery staple",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def make_group(self):
        alice = self.signup("alice")
        bob = self.signup("bob")
        request = self.client.post(
            "/api/friends/requests",
            headers=self.auth(alice),
            json={"userId": bob["user"]["id"]},
        )
        self.assertEqual(request.status_code, 201, request.text)
        accepted = self.client.post(
            f"/api/friends/requests/{request.json()['id']}/accept",
            headers=self.auth(bob),
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        group = self.client.post(
            "/api/conversations",
            headers=self.auth(alice),
            json={"kind": "group", "name": "Study group", "memberIds": [bob["user"]["id"]]},
        )
        self.assertEqual(group.status_code, 201, group.text)
        return alice, bob, group.json()

    def test_invite_authorization_redemption_limits_and_revocation(self):
        alice, bob, group = self.make_group()
        charlie = self.signup("charlie")
        dave = self.signup("dave")
        path = f"/api/conversations/{group['id']}/invites"

        forbidden = self.client.post(path, headers=self.auth(bob), json={})
        self.assertEqual(forbidden.status_code, 403, forbidden.text)
        created = self.client.post(
            path,
            headers=self.auth(alice),
            json={"expiresInSeconds": 3600, "maxUses": 1},
        )
        self.assertEqual(created.status_code, 201, created.text)
        invite = created.json()
        self.assertGreaterEqual(len(invite["token"]), 40)
        self.assertEqual(len(invite["code"]), 8)

        listed = self.client.get(path, headers=self.auth(alice))
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertNotIn("token", listed.json()[0])
        self.assertNotIn("tokenHash", listed.json()[0])
        for reference in (invite["token"], invite["id"], invite["code"].lower()):
            resolved = self.client.post(
                "/api/conversation-invites/resolve",
                headers=self.auth(charlie),
                json={"invite": reference},
            )
            self.assertEqual(resolved.status_code, 200, resolved.text)
            self.assertFalse(resolved.json()["isMember"])
            self.assertNotIn("memberIds", resolved.json()["conversation"])

        redeemed = self.client.post(
            "/api/conversation-invites/redeem",
            headers=self.auth(charlie),
            json={"invite": invite["token"]},
        )
        self.assertEqual(redeemed.status_code, 200, redeemed.text)
        self.assertIn(charlie["user"]["id"], redeemed.json()["memberIds"])
        exhausted = self.client.post(
            "/api/conversation-invites/redeem",
            headers=self.auth(dave),
            json={"invite": invite["code"]},
        )
        self.assertEqual(exhausted.status_code, 410, exhausted.text)

        second = self.client.post(path, headers=self.auth(alice), json={}).json()
        revoked = self.client.delete(
            f"{path}/{second['id']}", headers=self.auth(alice)
        )
        self.assertEqual(revoked.status_code, 200, revoked.text)
        rejected = self.client.post(
            "/api/conversation-invites/resolve",
            headers=self.auth(dave),
            json={"invite": second["token"]},
        )
        self.assertEqual(rejected.status_code, 410, rejected.text)

        guest = self.client.post("/api/auth/guest").json()
        guest_attempt = self.client.post(
            "/api/conversation-invites/resolve",
            headers=self.auth(guest),
            json={"invite": invite["token"]},
        )
        self.assertEqual(guest_attempt.status_code, 403, guest_attempt.text)

    def test_plan_revision_rejects_stale_writes(self):
        alice, bob, group = self.make_group()
        path = f"/api/conversations/{group['id']}/plan"
        initial = self.client.get(path, headers=self.auth(alice))
        self.assertEqual(initial.status_code, 200, initial.text)
        self.assertEqual(initial.json()["revision"], 0)
        body = {"title": "Shared plan", "sessions": [], "expectedRevision": 0}
        saved = self.client.put(path, headers=self.auth(alice), json=body)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["revision"], 1)
        stale = self.client.put(path, headers=self.auth(bob), json=body)
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(stale.json()["detail"]["currentRevision"], 1)
        missing = self.client.put(
            path,
            headers=self.auth(bob),
            json={"title": "Missing revision", "sessions": []},
        )
        self.assertEqual(missing.status_code, 422, missing.text)

    def test_study_session_transitions_elapsed_time_and_scoped_stats(self):
        alice, bob, group = self.make_group()
        outsider = self.signup("outsider")
        base = f"/api/conversations/{group['id']}/study-sessions"
        clock = {"now": datetime(2032, 1, 5, 12, 0, tzinfo=timezone.utc)}
        with patch("app.social_api._utcnow", side_effect=lambda: clock["now"]):
            started = self.client.post(
                f"{base}/start", headers=self.auth(alice), json={"title": "Focus"}
            )
            self.assertEqual(started.status_code, 201, started.text)
            session_id = started.json()["id"]
            duplicate = self.client.post(f"{base}/start", headers=self.auth(alice), json={})
            self.assertEqual(duplicate.status_code, 409, duplicate.text)

            clock["now"] += timedelta(seconds=10)
            paused = self.client.post(
                f"{base}/{session_id}/pause", headers=self.auth(alice)
            )
            self.assertEqual(paused.status_code, 200, paused.text)
            self.assertEqual(paused.json()["elapsedSeconds"], 10)
            self.assertEqual(
                self.client.post(f"{base}/{session_id}/pause", headers=self.auth(alice)).status_code,
                409,
            )

            clock["now"] += timedelta(seconds=30)
            listed = self.client.get(base, headers=self.auth(alice))
            self.assertEqual(listed.json()[0]["elapsedSeconds"], 10)
            resumed = self.client.post(
                f"{base}/{session_id}/resume", headers=self.auth(alice)
            )
            self.assertEqual(resumed.status_code, 200, resumed.text)
            clock["now"] += timedelta(seconds=5)
            stopped = self.client.post(
                f"{base}/{session_id}/stop", headers=self.auth(alice)
            )
            self.assertEqual(stopped.status_code, 200, stopped.text)
            self.assertEqual(stopped.json()["elapsedSeconds"], 15)
            self.assertEqual(
                self.client.post(f"{base}/{session_id}/resume", headers=self.auth(alice)).status_code,
                409,
            )

            stats = self.client.get(f"{base}/stats", headers=self.auth(bob))
            self.assertEqual(stats.status_code, 200, stats.text)
            self.assertEqual(stats.json()["groupTotalSeconds"], 15)
            totals = {item["userId"]: item["totalSeconds"] for item in stats.json()["memberTotals"]}
            self.assertEqual(totals[alice["user"]["id"]], 15)
            self.assertEqual(stats.json()["dailyTotals"][0]["totalSeconds"], 15)
            self.assertEqual(stats.json()["weeklyTotals"][0]["totalSeconds"], 15)

        hidden = self.client.get(f"{base}/stats", headers=self.auth(outsider))
        self.assertEqual(hidden.status_code, 404, hidden.text)


if __name__ == "__main__":
    unittest.main()
