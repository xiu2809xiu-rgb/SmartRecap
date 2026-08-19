import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import AuthenticatedRoute
from app.binder_api import build_binder_router
from app.config import Settings
from app.social_api import build_social_router
from app.ui_api import build_ui_router


async def _unused_extract(*_args, **_kwargs):
    raise RuntimeError("not used by security tests")


class FastApiSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
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
        app.include_router(build_social_router(settings))
        cls.client = TestClient(app)

    def auth(self, token):
        return {"Authorization": f"Bearer {token}"}

    def guest(self):
        response = self.client.post("/api/auth/guest")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def signup(self, email, name):
        guest = self.guest()
        response = self.client.post(
            "/api/auth/signup",
            headers=self.auth(guest["token"]),
            json={"email": email, "name": name, "password": "correct horse battery staple"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["user"]["id"], guest["user"]["id"])
        return response.json()

    def create_material(self, token, filename):
        headers = self.auth(token)
        upload = self.client.post(
            "/api/uploads", headers=headers,
            json={"fileName": filename, "sizeBytes": 1, "contentType": "text/plain"},
        )
        self.assertEqual(upload.status_code, 201, upload.text)
        material_id = upload.json()["materialId"]
        job = self.client.post(
            "/api/jobs", headers=headers,
            json={"materialId": material_id, "fileName": filename, "mode": "deep"},
        )
        self.assertEqual(job.status_code, 202, job.text)
        return material_id

    def test_token_material_binder_and_quiz_isolation(self):
        first = self.guest()
        second = self.guest()
        first_headers = self.auth(first["token"])
        second_headers = self.auth(second["token"])

        self.assertNotEqual(first["user"]["id"], second["user"]["id"])
        me = self.client.get("/api/auth/me", headers=first_headers)
        self.assertEqual(me.json()["id"], first["user"]["id"])
        tampered = first["token"][:-1] + ("A" if first["token"][-1] != "A" else "B")
        self.assertEqual(self.client.get("/api/auth/me", headers=self.auth(tampered)).status_code, 401)

        material_id = self.create_material(first["token"], "private.txt")
        self.assertEqual(self.client.get(f"/api/materials/{material_id}", headers=first_headers).status_code, 200)
        self.assertEqual(self.client.get(f"/api/materials/{material_id}", headers=second_headers).status_code, 404)
        shared = self.client.post(f"/api/materials/{material_id}/share", headers=first_headers)
        self.assertEqual(shared.status_code, 201, shared.text)
        public_copy = self.client.get(f"/api/shared/{shared.json()['token']}")
        self.assertEqual(public_copy.status_code, 200, public_copy.text)
        self.assertNotIn("ownerId", public_copy.json())

        binder = self.client.post("/api/binders", headers=first_headers, json={"name": "Private binder"})
        self.assertEqual(binder.status_code, 201, binder.text)
        binder_id = binder.json()["id"]
        self.assertEqual(self.client.get(f"/api/binders/{binder_id}", headers=second_headers).status_code, 404)

        quiz = self.client.put(
            f"/api/materials/{material_id}/quiz", headers=first_headers,
            json={"title": "Version one", "questions": [{
                "topic": "Isolation", "prompt": "Who owns this?",
                "options": ["First", "Second"], "answer": 0,
                "explanation": "The first account created it.",
            }]},
        )
        self.assertEqual(quiz.status_code, 200, quiz.text)
        quiz_id = quiz.json()["id"]
        self.assertEqual(self.client.get(f"/api/quizzes/{quiz_id}", headers=first_headers).status_code, 200)
        self.assertEqual(self.client.get(f"/api/quizzes/{quiz_id}", headers=second_headers).status_code, 404)
        unsupported = self.client.post(
            f"/api/materials/{material_id}/quiz", headers=first_headers,
            json={"difficulty": "easy", "questionCount": 5, "questionTypes": ["short"]},
        )
        self.assertEqual(unsupported.status_code, 422)
        second_version = self.client.put(
            f"/api/materials/{material_id}/quiz", headers=first_headers,
            json={"title": "Version two", "questions": [{
                "topic": "Versions", "prompt": "Was version one preserved?",
                "options": ["Yes", "No"], "answer": 0, "explanation": "Versions append.",
            }]},
        )
        self.assertEqual(second_version.status_code, 200, second_version.text)
        versions = self.client.get("/api/quizzes", headers=first_headers).json()
        self.assertIn(quiz_id, {item["id"] for item in versions})
        self.assertIn(second_version.json()["id"], {item["id"] for item in versions})
        self.assertEqual(self.client.get("/api/quizzes", headers=second_headers).json(), [])

    def test_friendship_conversation_membership_and_plan_authorization(self):
        alice = self.signup("alice-security@example.test", "Alice")
        bob = self.signup("bob-security@example.test", "Bob")
        mallory = self.signup("mallory-security@example.test", "Mallory")
        alice_h, bob_h, mallory_h = map(
            self.auth, (alice["token"], bob["token"], mallory["token"])
        )
        bob_id = bob["user"]["id"]

        request = self.client.post(
            "/api/friends/requests", headers=alice_h, json={"userId": bob_id}
        )
        self.assertEqual(request.status_code, 201, request.text)
        accepted = self.client.post(
            f"/api/friends/requests/{request.json()['id']}/accept", headers=bob_h
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        search = self.client.get("/api/social/users?q=Alice", headers=bob_h)
        self.assertEqual(search.status_code, 200, search.text)
        self.assertIn(alice["user"]["id"], {item["id"] for item in search.json()})

        conversation = self.client.post(
            "/api/conversations", headers=alice_h,
            json={"kind": "direct", "memberIds": [bob_id]},
        )
        self.assertEqual(conversation.status_code, 201, conversation.text)
        conversation_id = conversation.json()["id"]
        forbidden_group = self.client.post(
            "/api/conversations", headers=alice_h,
            json={"kind": "group", "name": "Not friends", "memberIds": [mallory["user"]["id"]]},
        )
        self.assertEqual(forbidden_group.status_code, 403)
        self.assertEqual(
            self.client.get(f"/api/conversations/{conversation_id}/messages", headers=mallory_h).status_code,
            404,
        )

        message = self.client.post(
            f"/api/conversations/{conversation_id}/messages",
            headers=bob_h, json={"text": "Review chapter three"},
        )
        self.assertEqual(message.status_code, 201, message.text)
        plan = {
            "title": "Exam week",
            "sessions": [{
                "id": "session-1", "title": "Chapter three", "date": "2030-05-10",
                "startTime": "18:30", "durationMinutes": 45,
                "assigneeId": bob_id, "completed": False,
            }],
        }
        saved = self.client.put(
            f"/api/conversations/{conversation_id}/plan", headers=alice_h, json=plan
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(
            self.client.get(f"/api/conversations/{conversation_id}/plan", headers=bob_h).json()["title"],
            "Exam week",
        )
        self.assertEqual(
            self.client.get(f"/api/conversations/{conversation_id}/plan", headers=mallory_h).status_code,
            404,
        )

        guest = self.guest()
        self.assertEqual(self.client.get("/api/friends", headers=self.auth(guest["token"])).status_code, 403)


if __name__ == "__main__":
    unittest.main()
