import unittest

from pydantic import ValidationError

from app.ai_service import generate_notebook_quiz
from app.auth import AuthService
from app.config import Settings
from app.models import Citation, LobbyCreate, LobbyJoin, QuizQuestion, SourceRecord
from app.ui_api import _score_quiz_question


CITATION = {
    "label": "Page 1",
    "excerpt": "Normalization reduces data redundancy and update anomalies.",
    "source_id": "s1",
    "source_name": "notes.txt",
}


class MemoryRepository:
    ready = False

    def __init__(self):
        self.values = {}
        self.public = {}

    def save(self, owner_id, kind, record_id, value):
        self.values[(owner_id, kind, record_id)] = value

    def get(self, owner_id, kind, record_id):
        return self.values.get((owner_id, kind, record_id))

    def save_public(self, kind, key, value):
        self.public[(kind, key)] = value

    def get_public(self, kind, key):
        return self.public.get((kind, key))


class QuizContractTests(unittest.TestCase):
    def test_legacy_single_defaults_and_multi_is_canonical(self):
        single = QuizQuestion(
            topic="Databases", prompt="Which statement is correct?",
            options=["A", "B"], answer=1, explanation="B is supported.",
            citation=CITATION,
        )
        self.assertEqual(single.type, "single")
        multi = QuizQuestion(
            type="multi", topic="Databases", prompt="Choose both.",
            options=["A", "B", "C"], answer=[2, 0], explanation="A and C.",
            citation=CITATION,
        )
        self.assertEqual(multi.answer, [0, 2])
        with self.assertRaises(ValidationError):
            QuizQuestion(
                type="multi", topic="Databases", prompt="Bad.",
                options=["A", "B"], answer=[0, 0], explanation="Bad.", citation=CITATION,
            )
    def test_short_contract_and_deterministic_scoring(self):
        short = QuizQuestion(
            type="short", topic="Databases", prompt="Explain normalization.",
            modelAnswer="Normalization reduces redundancy and update anomalies.",
            keyConcepts=["reduces redundancy", "update anomalies"],
            rubric="Require both grounded effects.", explanation="Both effects matter.",
            citation=CITATION,
        )
        dumped = short.model_dump(by_alias=True)
        self.assertEqual(dumped["modelAnswer"], short.model_answer)
        question = {
            "type": "short",
            "keyConcepts": ["reduces redundancy", "update anomalies"],
        }
        correct, judgement = _score_quiz_question(
            question, "It reduces redundancy and prevents update anomalies."
        )
        self.assertTrue(correct)
        self.assertTrue(judgement["verified"])
        incorrect, _ = _score_quiz_question(question, "It reduces redundancy.")
        self.assertFalse(incorrect)

    def test_objective_scoring_rejects_duplicate_multi_submission(self):
        question = {"type": "multi", "answer": [0, 2]}
        self.assertTrue(_score_quiz_question(question, [2, 0])[0])
        self.assertFalse(_score_quiz_question(question, [0, 0, 2])[0])
        self.assertTrue(_score_quiz_question({"answer": 1}, 1)[0])
        self.assertFalse(_score_quiz_question({"answer": 1}, True)[0])

    def test_lobby_avatar_allowlist_defaults_and_rejects_unknown(self):
        create = LobbyCreate(
            name="Study room", host_name="Host", materialId="m1", quizId="q1"
        )
        join = LobbyJoin(playerName="Guest", avatarId="nova")
        legacy_join = LobbyJoin(playerName="Guest", avatarId="avatar-3")
        self.assertEqual(create.avatar_id, "default")
        self.assertEqual(join.avatar_id, "nova")
        self.assertEqual(legacy_join.avatar_id, "avatar-3")
        with self.assertRaises(ValidationError):
            LobbyJoin(playerName="Guest", avatarId="../../private")

    def test_demo_generation_supports_mixed_types_without_provider_calls(self):
        statements = [
            "Database normalization is a design process that reduces redundant data and prevents modification anomalies.",
            "First normal form requires each table cell to contain one atomic value rather than a repeating group.",
            "Second normal form removes partial dependencies when a composite key determines non-key attributes.",
            "Third normal form prevents transitive dependencies between non-key attributes in a relational table.",
            "A primary key uniquely identifies every row and therefore cannot contain duplicate or null values.",
            "Foreign keys connect related tables and ensure references point to an existing primary key.",
            "Functional dependencies describe how one attribute determines another attribute in a database relation.",
            "Decomposition splits a table into smaller relations while preserving dependencies and lossless reconstruction.",
        ]
        text = "[Page 1]\n" + "\n".join(statements)
        source = SourceRecord(
            id="s1", filename="notes.txt", content_type="text/plain",
            size=len(text), text=text, labels=["Page 1"],
        )
        settings = Settings(_env_file=None, demo_mode=True)
        pack, providers = generate_notebook_quiz(
            [source], "medium", 5, settings,
            question_types=["single", "multi", "short"],
        )
        self.assertEqual(len(pack.questions), 5)
        self.assertEqual({item.type for item in pack.questions}, {"single", "multi", "short"})
        self.assertEqual(providers[0]["name"], "Local grounded fallback")


class GoogleGuestPromotionTests(unittest.TestCase):
    def setUp(self):
        settings = Settings(
            _env_file=None,
            jwt_secret="unit-test-secret-that-is-long-and-random",
            demo_mode=True,
        )
        self.auth = AuthService(settings, MemoryRepository())

    def test_new_google_identity_promotes_guest_in_place(self):
        guest_session = self.auth.guest()
        guest = self.auth.get_user(guest_session["user"]["id"])
        result = self.auth.google({
            "sub": "google-sub-1", "email": "student@example.test",
            "name": "Student", "picture": None,
        }, guest)
        self.assertEqual(result["user"]["id"], guest_session["user"]["id"])
        self.assertFalse(result["user"]["guest"])

    def test_established_google_identity_does_not_merge_second_guest(self):
        first_guest_session = self.auth.guest()
        first_guest = self.auth.get_user(first_guest_session["user"]["id"])
        profile = {
            "sub": "google-sub-2", "email": "student@example.test",
            "name": "Student", "picture": None,
        }
        established = self.auth.google(profile, first_guest)
        second_guest_session = self.auth.guest()
        second_guest = self.auth.get_user(second_guest_session["user"]["id"])
        result = self.auth.google(profile, second_guest)
        self.assertEqual(result["user"]["id"], established["user"]["id"])
        self.assertNotEqual(result["user"]["id"], second_guest_session["user"]["id"])
        self.assertTrue(self.auth.get_user(second_guest_session["user"]["id"])["guest"])


if __name__ == "__main__":
    unittest.main()


class CitationRepairTests(unittest.TestCase):
    """A cited excerpt must end up an exact substring of the source.

    Models re-type quotes rather than copying them: whitespace collapses across
    a PDF line break, a quote character is swapped, a word is added or dropped.
    Every one of those used to fail the exact-substring check and reject the
    whole quiz. Repair may only ever move the citation onto a real span --
    never invent support for one that has none.
    """

    TEXT = (
        "[Page 1]\n"
        "A linked list is a linear data structure where each node holds a value\n"
        "and a reference to the next node in the sequence.\n"
        "To insert at the head, create the node, point its next at the current\n"
        "head, then move head to the new node.\n"
        "\n"
        "[Page 2]\n"
        "Traversal walks the list from head until next is null, visiting each\n"
        "node exactly once, which costs linear time.\n"
    )

    def _source(self):
        return SourceRecord(
            id="src_1",
            filename="Linked Lists (Solutions).pdf",
            content_type="application/pdf",
            size=len(self.TEXT),
            text=self.TEXT,
            labels=["Page 1", "Page 2"],
            warnings=[],
        )

    def _repair(self, excerpt, label="Page 9", source_name="wrong.pdf"):
        from app.ai_service import _repair_citation_list

        citation = Citation(
            source_id="src_1", source_name=source_name, label=label, excerpt=excerpt
        )
        source = self._source()
        _repair_citation_list([citation], [source])
        return citation, source

    def test_collapsed_whitespace_is_restored(self):
        citation, source = self._repair(
            "each node holds a value and a reference to the next node"
        )
        self.assertIn(citation.excerpt, source.text)

    def test_inserted_word_is_tolerated(self):
        citation, source = self._repair(
            "Traversal walks the entire list from head until next is null"
        )
        self.assertIn(citation.excerpt, source.text)

    def test_dropped_word_is_tolerated(self):
        citation, source = self._repair(
            "create the node, point its next at current head"
        )
        self.assertIn(citation.excerpt, source.text)

    def test_trailing_words_the_model_added_are_dropped(self):
        citation, source = self._repair(
            "visiting each node exactly once, which costs linear time in all cases"
        )
        self.assertIn(citation.excerpt, source.text)

    def test_wrong_metadata_is_corrected_to_the_real_owner(self):
        citation, source = self._repair(
            "Traversal walks the list from head until next is null"
        )
        self.assertEqual(citation.source_name, source.filename)
        self.assertIn(citation.label, source.labels)

    def test_fabricated_excerpt_is_not_repaired_into_the_source(self):
        citation, source = self._repair(
            "Quantum entanglement governs pointer arithmetic in Rust"
        )
        self.assertNotIn(citation.excerpt, source.text)
