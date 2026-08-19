import asyncio
import hashlib
import hmac
import logging
import re
import secrets
import time
import unicodedata
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from .auth import (
    AuthenticatedRoute, OwnerList, OwnerMap, OwnerSet, auth_service, configure_auth,
    current_owner_id, current_user, optional_user, public_user, register_owner_hydrator,
)
from .ai_service import (
    answer_notebook_question,
    normalise_language,
    translate_strings,
    create_study_image_prompt,
    generate_notebook_pack,
    generate_notebook_quiz,
    generate_practice,
    hard_quiz_provider_error,
)
from .config import Settings
from .code_service import coding_help_available, explain_failure
from .google_auth import verify_google_id_token
from .image_service import generate_image, verify_raster_image
from .models import ChatIllustrationRequest, Citation, IllustrationGenerationRequest, MaterialAskRequest, QuizGenerationRequest, SourceRecord, StudyPack
from .repository import DurableRepository
from .storage import ObjectStorage

ExtractSource = Callable[[bytes, str, str, bool], Awaitable[SourceRecord]]
logger = logging.getLogger("smartrecap.ui")

_uploads: OwnerMap = OwnerMap()
_jobs: OwnerMap = OwnerMap()
_materials: OwnerMap = OwnerMap()
_sources: OwnerMap = OwnerMap()
_quizzes: OwnerMap = OwnerMap()
_attempts: OwnerList = OwnerList()
_cards: OwnerMap = OwnerMap()
# Shares and community posts are explicit public/capability records.
_shares: Dict[str, Dict[str, str]] = {}
_forum_posts: List[Dict[str, Any]] = []
_illustration_bytes: OwnerMap = OwnerMap()
_illustrations_inflight: OwnerSet = OwnerSet()
_illustration_last_generated: OwnerMap = OwnerMap()
_chat_illustration_last_generated: OwnerMap = OwnerMap()
_chat_answers: OwnerMap = OwnerMap()
_tasks: set[asyncio.Task] = set()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _id(prefix: str) -> str:
    return "{}_{}".format(prefix, secrets.token_urlsafe(7))


def _question_type(question: Dict[str, Any]) -> str:
    return str(question.get("type") or "single")


def _normalized_answer(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s-]", " ", text, flags=re.UNICODE)).strip()


def _score_quiz_question(question: Dict[str, Any], submitted: Any) -> tuple[bool, Dict[str, Any]]:
    """Score one stored question without trusting or contacting a provider."""
    kind = _question_type(question)
    if kind == "multi":
        expected = question.get("answer")
        valid = (
            isinstance(submitted, list)
            and isinstance(expected, list)
            and all(isinstance(item, int) and not isinstance(item, bool) for item in submitted)
            and len(submitted) == len(set(submitted))
        )
        correct = valid and set(submitted) == set(expected) and len(submitted) == len(expected)
        return correct, {
            "correct": correct,
            "feedback": "All correct options were selected." if correct else "Select every correct option and no incorrect options.",
            "gradedBy": "exact-set-match",
            "verified": True,
        }
    if kind == "short":
        answer = _normalized_answer(submitted)
        answer_tokens = set(answer.split())
        concepts = [
            _normalized_answer(item)
            for item in question.get("keyConcepts", [])
            if _normalized_answer(item)
        ]

        def includes(concept: str) -> bool:
            if concept in answer:
                return True
            tokens = {token for token in concept.split() if len(token) > 2}
            return bool(tokens) and tokens.issubset(answer_tokens)

        matched = [concept for concept in concepts if includes(concept)]
        correct = bool(answer and concepts) and len(matched) == len(concepts)
        missing = [concept for concept in concepts if concept not in matched]
        feedback = (
            "Your answer includes every required key concept."
            if correct
            else "Your answer is missing required key concepts: {}.".format(", ".join(missing))
            if answer and missing
            else "Write a substantive answer that includes the required key concepts."
        )
        return correct, {
            "correct": correct,
            "feedback": feedback,
            "gradedBy": "deterministic-key-concept-match",
            "verified": True,
            "matchedConcepts": len(matched),
            "requiredConcepts": len(concepts),
        }
    expected = question.get("answer")
    correct = isinstance(submitted, int) and not isinstance(submitted, bool) and submitted == expected
    return correct, {
        "correct": correct,
        "feedback": "Correct option selected." if correct else "The selected option does not match the stored answer.",
        "gradedBy": "exact-index-match",
        "verified": True,
    }


def _require_material(material_id: str) -> Dict[str, Any]:
    material = _materials.get(material_id)
    if not material:
        raise HTTPException(status_code=404, detail="That material is not in your library.")
    return material


def owned_quiz_snapshot(material_id: str, quiz_id: str) -> Dict[str, Any]:
    """Return only the selected owner-scoped quiz for lobby snapshotting."""
    material = _require_material(material_id)
    quiz = _quizzes.get(quiz_id)
    if not quiz or quiz.get("materialId") != material.get("id"):
        raise HTTPException(status_code=404, detail="That quiz version is not in your library.")
    snapshot = deepcopy(quiz)
    unsupported = [
        str(question.get("type") or "single")
        for question in snapshot.get("questions", [])
        if str(question.get("type") or "single") not in {"single", "multi"}
    ]
    if unsupported:
        raise HTTPException(
            status_code=422,
            detail="Multiplayer lobbies support only objectively scored single- and multi-select questions; remove short-answer questions from this quiz snapshot.",
        )
    snapshot.pop("ownerId", None)
    return snapshot


def _public_material(material: Dict[str, Any]) -> Dict[str, Any]:
    value = deepcopy(material)
    value.pop("ownerId", None)
    for collection in ("illustrations", "chatIllustrations"):
        for illustration in value.get(collection, []):
            illustration.pop("_storageKey", None)
    return value

def _source_chunks(source: SourceRecord) -> List[Dict[str, Any]]:
    labels = sorted(set(source.labels or ["Section 1"]), key=len, reverse=True)
    pattern = r"(?m)^\[(%s)\]\s*$" % "|".join(re.escape(label) for label in labels)
    parts = re.split(pattern, source.text)
    sections = []
    if len(parts) > 2:
        for index in range(1, len(parts), 2):
            label = parts[index].strip()
            text = parts[index + 1].strip() if index + 1 < len(parts) else ""
            if text:
                sections.append((label, text))
    if not sections:
        sections = [(labels[0], source.text.strip())]

    chunks = []
    used_ids: set[str] = set()
    for index, (label, text) in enumerate(sections):
        page_match = re.fullmatch(r"Page\s+(\d+)", label, flags=re.IGNORECASE)
        page = int(page_match.group(1)) if page_match else index + 1
        locator = "p{}".format(page) if page_match else "c{}".format(index + 1)
        chunk_id = "{}-{}".format(source.id, locator)
        if chunk_id in used_ids:
            chunk_id = "{}-{}".format(chunk_id, index + 1)
        used_ids.add(chunk_id)
        chunks.append({
            "id": chunk_id,
            "sourceId": source.id,
            "sourceName": source.filename,
            "label": label,
            "page": page,
            "text": text[:12000],
        })
    return chunks


def _citation_id(citation: Citation, chunks: List[Dict[str, Any]]) -> str:
    candidates = [
        chunk for chunk in chunks
        if chunk["sourceId"] == citation.source_id and chunk["label"] == citation.label
    ]
    if not candidates:
        candidates = [chunk for chunk in chunks if chunk["sourceId"] == citation.source_id]
    return candidates[0]["id"] if candidates else chunks[0]["id"]


def _material_from_pack(
    material_id: str,
    source: SourceRecord,
    pack: StudyPack,
    mode: str,
    module: str,
    settings: Settings,
    started_at: float,
) -> Dict[str, Any]:
    chunks = _source_chunks(source)
    point_number = 0

    def point(text: str, citation: Citation) -> Dict[str, Any]:
        nonlocal point_number
        point_number += 1
        return {
            "id": "p{}".format(point_number),
            "text": text,
            "citations": [_citation_id(citation, chunks)],
            "confidence": "grounded",
        }

    sections = [{
        "id": "takeaways",
        "heading": "Key takeaways",
        "points": [point(item.text, item.citation) for item in pack.takeaways],
    }]
    for index, topic in enumerate(pack.topics):
        topic_points = [point(topic.explanation, topic.citation)]
        topic_points.extend(point(item, topic.citation) for item in topic.bullets)
        sections.append({"id": "topic-{}".format(index + 1), "heading": topic.title, "points": topic_points})

    return {
        "id": material_id,
        "title": pack.title,
        "fileName": source.filename,
        "fileType": Path(source.filename).suffix.lower().lstrip(".") or "txt",
        "sizeBytes": source.size,
        "module": module or "Unfiled",
        "mode": mode,
        "status": "ready",
        "pageCount": max(1, len(source.labels)),
        "ocr": any("OCR" in warning for warning in source.warnings),
        "createdAt": _materials.get(material_id, {}).get("createdAt", _now()),
        "chunks": chunks,
        "recap": {
            "summary": pack.overview,
            "readMinutes": pack.read_minutes,
            "sections": sections,
            "keyTerms": [
                {
                    "term": item.term,
                    "definition": item.meaning,
                    "citations": [_citation_id(item.citation, chunks)],
                }
                for item in pack.definitions
            ],
            "examTips": pack.warnings,
            "ungrounded": [],
        },
        "quiz": {"status": "not_generated", "questions": []},
        "provider": {
            "name": (
                " + ".join(item.get("name", "AI provider") for item in pack.providers)
                if pack.providers
                else "Google Gemini"
            ),
            "model": (
                " + ".join(item.get("model", "unknown model") for item in pack.providers)
                if pack.providers
                else settings.gemini_model
            ),
            "latencyMs": round((time.monotonic() - started_at) * 1000),
            "tokensIn": 0,
            "tokensOut": 0,
            "costUsd": 0.0,
        },
        "providers": deepcopy(pack.providers),
    }


def _translate_material(material: Dict[str, Any], language: str, settings: Settings) -> Dict[str, Any]:
    """Translate a finished recap's prose, leaving its structure alone.

    Collects every translatable string with a setter that puts the result back
    where it came from, so citations, chunk ids and section ids cannot be
    touched — they are structure, and translating structure is how you break a
    recap. Key term NAMES stay in the original language on purpose: that is the
    word the exam paper will use.
    """
    recap = material.get("recap") or {}
    setters: List[Any] = []
    values: List[str] = []

    def take(text: Any, set_fn) -> None:
        if isinstance(text, str) and text.strip():
            values.append(text)
            setters.append(set_fn)

    def set_summary(v):
        recap["summary"] = v

    take(recap.get("summary"), set_summary)

    for section in recap.get("sections", []):
        take(section.get("heading"), lambda v, s=section: s.__setitem__("heading", v))
        for pt in section.get("points", []):
            take(pt.get("text"), lambda v, p=pt: p.__setitem__("text", v))

    for term in recap.get("keyTerms", []):
        take(term.get("definition"), lambda v, t=term: t.__setitem__("definition", v))

    tips = recap.get("examTips", [])
    for i, tip in enumerate(tips):
        take(tip, lambda v, idx=i: tips.__setitem__(idx, v))

    if not values:
        return material

    translated = translate_strings(values, language, settings)
    for set_fn, value in zip(setters, translated):
        set_fn(value)

    material["recap"] = recap
    material["translated"] = translated != values
    return material


def build_ui_router(extract_source: ExtractSource, settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/api", route_class=AuthenticatedRoute)
    storage = ObjectStorage(settings)
    repository = DurableRepository(settings, storage)
    configure_auth(settings, repository)
    loaded_owners: set[str] = set()
    public_loaded = False

    async def hydrate_owner(owner_id: str) -> None:
        if owner_id in loaded_owners:
            return
        if repository.ready:
            for kind, target in (("material", _materials), ("quiz", _quizzes), ("cards", _cards)):
                for item in await run_in_threadpool(repository.load_kind, owner_id, kind):
                    if isinstance(item.get("value"), (dict, list)):
                        target.owner_data(owner_id)[item["id"]] = item["value"]
            for item in await run_in_threadpool(repository.load_kind, owner_id, "attempt"):
                if isinstance(item.get("value"), dict):
                    _attempts.owner_data(owner_id).append(item["value"])
            for item in await run_in_threadpool(repository.load_kind, owner_id, "source"):
                values = item.get("value")
                if isinstance(values, list):
                    try:
                        _sources.owner_data(owner_id)[item["id"]] = [SourceRecord.model_validate(value) for value in values]
                    except Exception as exc:
                        logger.warning("Skipping invalid owner source record %s: %s", item.get("id"), exc)
            _attempts.owner_data(owner_id).sort(key=lambda item: item.get("at", ""), reverse=True)
        loaded_owners.add(owner_id)

    async def hydrate_public() -> None:
        nonlocal public_loaded
        if public_loaded or not repository.ready:
            public_loaded = True
            return
        for item in await run_in_threadpool(repository.load_public_kind, "share"):
            if isinstance(item.get("value"), dict):
                _shares[item["id"]] = item["value"]
        for item in await run_in_threadpool(repository.load_public_kind, "forum"):
            if isinstance(item.get("value"), dict):
                _forum_posts.append(item["value"])
        _forum_posts.sort(key=lambda item: item.get("createdAt", ""), reverse=True)
        public_loaded = True

    register_owner_hydrator(hydrate_owner)

    async def persist(kind: str, record_id: str, value: Any) -> None:
        owner_id = current_owner_id()
        stored = deepcopy(value)
        if isinstance(stored, dict):
            stored["ownerId"] = owner_id
            if isinstance(value, dict):
                value["ownerId"] = owner_id
        if repository.ready:
            await run_in_threadpool(repository.save, owner_id, kind, record_id, stored)

    async def persist_public(kind: str, record_id: str, value: Any) -> None:
        if repository.ready:
            await run_in_threadpool(repository.save_public, kind, record_id, deepcopy(value))

    async def remove_persisted(kind: str, record_id: str) -> None:
        if repository.ready:
            await run_in_threadpool(repository.delete, current_owner_id(), kind, record_id)

    async def remove_public(kind: str, record_id: str) -> None:
        if repository.ready:
            await run_in_threadpool(repository.delete_public, kind, record_id)

    async def run_job(job_id: str, payload: Dict[str, Any]) -> None:
        job = _jobs[job_id]
        material_id = payload["materialId"]
        upload = _uploads.get(material_id)
        started_at = time.monotonic()
        try:
            if not upload:
                raise ValueError("The uploaded file content is missing.")
            content = upload.get("content") or b""
            if not content and upload.get("objectKey") and storage.ready:
                content = await run_in_threadpool(
                    storage.get_bytes,
                    upload["objectKey"],
                    settings.max_file_mb * 1024 * 1024,
                    material_id,
                )
            if not content:
                raise ValueError("The uploaded file content is missing.")
            job.update(stage="extract", progress=10, stageLabel="Extracting text; OCR is limited to scanned pages")
            source = await extract_source(
                content,
                payload["fileName"],
                upload.get("contentType") or "application/octet-stream",
                payload.get("mode") == "deep",
            )
            _sources[material_id] = [source]
            job.update(stage="chunk", progress=42, stageLabel="Building citable source sections")
            job.update(stage="recap", progress=50, stageLabel="Generating grounded notes")
            pack = await asyncio.wait_for(
                run_in_threadpool(
                    generate_notebook_pack,
                    [source],
                    Path(payload["fileName"]).stem,
                    payload.get("mode", "deep"),
                    settings,
                ),
                timeout=settings.ai_timeout_seconds + 30,
            )
            job.update(stage="ground", progress=92, stageLabel="Verifying every citation")
            material = _material_from_pack(
                material_id,
                source,
                pack,
                payload.get("mode", "deep"),
                payload.get("module", "Unfiled"),
                settings,
                started_at,
            )

            # Translation runs AFTER citations are verified, never instead of
            # it. The recap is written and checked against the slides in their
            # own language first, and only what survived is translated — so a
            # translated point still points at the original slide and the
            # source panel still quotes it in the original words.
            language = normalise_language(payload.get("language"))
            material["language"] = language
            if language != "en":
                job.update(stage="translate", progress=95, stageLabel="Translating what passed the check")
                material = await run_in_threadpool(_translate_material, material, language, settings)

            _materials[material_id] = material
            if storage.ready:
                await run_in_threadpool(
                    storage.put_json,
                    "materials/{}/result.json".format(material_id),
                    _materials[material_id],
                )
            await persist("source", material_id, [item.model_dump() for item in _sources[material_id]])
            await persist("material", material_id, _materials[material_id])
            job.update(status="ready", stage="done", progress=100, stageLabel="Recap ready")
            _uploads.pop(material_id, None)
        except Exception as exc:
            message = str(exc) or "Processing failed unexpectedly."
            job.update(status="failed", stage="failed", error=message)
            if material_id in _materials:
                _materials[material_id].update(status="failed", error=message)

    async def run_quiz_job(job_id: str, payload: Dict[str, Any]) -> None:
        job = _jobs[job_id]
        material_id = payload["materialId"]
        material = _materials.get(material_id)
        previous = deepcopy(material.get("quiz", {})) if material else {}
        try:
            if not material:
                raise ValueError("That material is not in your library.")
            sources = _sources.get(material_id, [])
            if not sources:
                raise ValueError("That material has no readable source text.")
            if previous.get("status") == "ready":
                material["quiz"] = deepcopy(previous)
                material["quiz"]["generationStatus"] = "generating"
                material["quiz"].pop("generationError", None)
            else:
                material["quiz"] = {
                    "status": "generating",
                    "generationStatus": "generating",
                    "questions": [],
                }
            difficulty = payload["difficulty"]
            question_count = payload["questionCount"]
            topics = payload.get("topics", [])
            excluded_prompts = payload.get("excludedPrompts", [])
            label = (
                "Creating new questions for weak areas: {}".format(", ".join(topics))
                if topics
                else "Gemini 2.5 Flash drafting; Azure OpenAI refining; public OpenAI auditing citations and conceptual quality"
                if difficulty == "hard"
                else "Creating a fresh conceptual quiz with provider fallback"
            )
            job.update(stage="generate", progress=15, stageLabel=label)
            timeout = settings.ai_timeout_seconds * (3 if difficulty == "hard" else 1) + (90 if difficulty == "hard" else 30)
            pack, providers = await asyncio.wait_for(
                run_in_threadpool(
                    generate_notebook_quiz,
                    sources,
                    difficulty,
                    question_count,
                    settings,
                    topics,
                    excluded_prompts,
                    payload.get("questionTypes", ["single"]),
                ),
                timeout=timeout,
            )
            job.update(stage="ground", progress=88, stageLabel="Validating exact quiz citations")
            chunks = material.get("chunks", [])
            numeric_difficulty = {"easy": 1, "medium": 2, "hard": 3}[difficulty]

            def generated_question(item, index: int) -> Dict[str, Any]:
                kind = item.type or "single"
                question = {
                    "id": "q{}".format(index + 1),
                    "type": kind,
                    "topic": item.topic,
                    "difficulty": numeric_difficulty,
                    "prompt": item.prompt,
                    "explanation": item.explanation,
                    "citations": [_citation_id(item.citation, chunks)],
                    "verified": True,
                }
                if kind == "short":
                    question.update(
                        modelAnswer=item.model_answer,
                        keyConcepts=list(item.key_concepts),
                        rubric=item.rubric,
                    )
                else:
                    question.update(options=list(item.options), answer=deepcopy(item.answer))
                return question

            questions = [generated_question(item, index) for index, item in enumerate(pack.questions)]
            quiz_id = _id("quiz")
            quiz_version = {
                "id": quiz_id,
                "ownerId": current_owner_id(),
                "materialId": material_id,
                "status": "ready",
                "generationStatus": "ready",
                "difficulty": difficulty,
                "questionCount": question_count,
                "questionTypes": list(payload.get("questionTypes", ["single"])),
                "generatedAt": _now(),
                "providers": providers,
                "questions": questions,
            }
            _quizzes[quiz_id] = deepcopy(quiz_version)
            material["quiz"] = deepcopy(quiz_version)
            await persist("quiz", quiz_id, quiz_version)
            await persist("material", material_id, material)
            job.update(status="ready", stage="done", progress=100, stageLabel="Quiz ready", quizId=quiz_id)
        except Exception as exc:
            message = str(exc) or "Quiz generation failed unexpectedly."
            job.update(
                status="failed",
                stage="failed",
                stageLabel="Quiz generation failed",
                error=message,
            )
            if material:
                if previous.get("status") == "ready":
                    material["quiz"] = deepcopy(previous)
                    material["quiz"]["generationStatus"] = "failed"
                    material["quiz"]["generationError"] = message
                else:
                    material["quiz"] = {
                        "status": "failed",
                        "generationStatus": "failed",
                        "questions": [],
                        "generationError": message,
                    }

    def dispatch(job_id: str, payload: Dict[str, Any]) -> None:
        task = asyncio.create_task(run_job(job_id, payload))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)

    def dispatch_quiz(job_id: str, payload: Dict[str, Any]) -> None:
        task = asyncio.create_task(run_quiz_job(job_id, payload))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)

    @router.post("/auth/guest")
    async def authenticate_guest() -> Dict[str, Any]:
        return auth_service().guest()

    @router.post("/auth/signup")
    async def authenticate_signup(request: Request) -> Dict[str, Any]:
        body = await request.json()
        guest = optional_user(request)
        return auth_service().signup(body.get("email"), body.get("password"), body.get("name"), guest)

    @router.post("/auth/login")
    async def authenticate_login(request: Request) -> Dict[str, Any]:
        body = await request.json()
        return auth_service().login(body.get("email"), body.get("password"))

    @router.post("/auth/google")
    async def authenticate_with_google(request: Request) -> Dict[str, Any]:
        body = await request.json()
        credential = body.get("credential")
        if not credential:
            raise HTTPException(status_code=422, detail="A Google credential is required.")
        profile = await run_in_threadpool(verify_google_id_token, credential, settings)
        guest = optional_user(request)
        return auth_service().google(profile, guest if guest and guest.get("guest") else None)

    @router.get("/auth/me")
    async def auth_me() -> Dict[str, Any]:
        return public_user(current_user())

    # Face sign-in is designed and built on the client but has no
    # implementation on this backend. It previously had no routes at all, so
    # every call 404'd — and a 404 is indistinguishable from a bug. The client
    # already treats 501 as "not available yet" and hides the feature
    # (components/auth/FaceEnrolment.jsx), so answering honestly is what makes
    # it disappear from the UI instead of failing in someone's face.
    _FACE_UNAVAILABLE = "Face sign-in is not available on this deployment."

    @router.get("/auth/face/status")
    async def face_status() -> Dict[str, Any]:
        # Deliberately 200 rather than 501: this endpoint's whole job is to
        # report capability, and it is answering that question correctly.
        return {"enrolled": False, "available": False, "reason": _FACE_UNAVAILABLE}

    @router.post("/auth/face")
    async def face_sign_in() -> None:
        raise HTTPException(status_code=501, detail=_FACE_UNAVAILABLE)

    @router.post("/auth/face/enrol")
    async def face_enrol() -> None:
        raise HTTPException(status_code=501, detail=_FACE_UNAVAILABLE)

    @router.delete("/auth/face")
    async def face_remove() -> None:
        raise HTTPException(status_code=501, detail=_FACE_UNAVAILABLE)

    @router.get("/materials")
    async def list_materials() -> List[Dict[str, Any]]:
        return sorted((_public_material(item) for item in _materials.values()), key=lambda item: item.get("createdAt", ""), reverse=True)

    @router.get("/materials/{material_id}")
    async def get_material(material_id: str) -> Dict[str, Any]:
        return _public_material(_require_material(material_id))

    @router.patch("/materials/{material_id}")
    async def rename_material(material_id: str, request: Request) -> Dict[str, Any]:
        material = _require_material(material_id)
        title = str((await request.json()).get("title", "")).strip()
        if not title:
            raise HTTPException(status_code=422, detail="A title is required.")
        material["title"] = title[:200]
        await persist("material", material_id, material)
        return material

    @router.delete("/materials/{material_id}", status_code=204)
    async def delete_material(material_id: str) -> Response:
        await hydrate_public()
        material = _require_material(material_id)
        if material_id in _illustrations_inflight or any(
            job.get("materialId") == material_id and job.get("status") == "running"
            for job in _jobs.values()
        ):
            raise HTTPException(status_code=409, detail="Wait for active generation to finish before deleting this material.")

        quiz_ids = [
            quiz_id
            for quiz_id, quiz in _quizzes.items()
            if quiz.get("materialId") == material_id
        ]
        attempt_ids = [
            str(attempt.get("id"))
            for attempt in _attempts
            if attempt.get("materialId") == material_id and attempt.get("id")
        ]
        share_tokens = [
            token for token, index in _shares.items()
            if index.get("ownerId") == current_owner_id() and index.get("materialId") == material_id
        ]
        all_illustrations = material.get("illustrations", []) + material.get("chatIllustrations", [])
        illustration_ids = [
            str(item.get("id")) for item in all_illustrations if item.get("id")
        ]

        try:
            if storage.ready:
                storage_keys = {
                    storage.upload_key(material_id),
                    storage.object_key("materials/{}/result.json".format(material_id)),
                    *(
                        str(item["_storageKey"])
                        for item in all_illustrations
                        if item.get("_storageKey")
                    ),
                }
                for key in storage_keys:
                    await run_in_threadpool(storage.delete_key, key)
            for quiz_id in quiz_ids:
                await remove_persisted("quiz", quiz_id)
            for attempt_id in attempt_ids:
                await remove_persisted("attempt", attempt_id)
            for token in share_tokens:
                await remove_public("share", token)
            await remove_persisted("material", material_id)
            await remove_persisted("source", material_id)
            await remove_persisted("cards", material_id)
        except Exception as exc:
            logger.warning("Material cleanup failed material=%s error=%s", material_id, exc)
            raise HTTPException(status_code=503, detail="Material cleanup could not be completed. Nothing was removed from this browser; retry shortly.") from exc

        _materials.pop(material_id, None)
        _sources.pop(material_id, None)
        _cards.pop(material_id, None)
        _uploads.pop(material_id, None)
        _illustration_last_generated.pop(material_id, None)
        _chat_illustration_last_generated.pop(material_id, None)
        for quiz_id in quiz_ids:
            _quizzes.pop(quiz_id, None)
        _attempts[:] = [item for item in _attempts if item.get("materialId") != material_id]
        for token in share_tokens:
            _shares.pop(token, None)
        referenced_elsewhere = {
            str(item.get("id"))
            for other in _materials.values()
            for collection in ("illustrations", "chatIllustrations")
            for item in other.get(collection, [])
            if item.get("id")
        }
        for illustration_id in illustration_ids:
            if illustration_id not in referenced_elsewhere:
                _illustration_bytes.pop(illustration_id, None)
        for answer_id, answer in list(_chat_answers.items()):
            if answer.get("materialId") == material_id:
                _chat_answers.pop(answer_id, None)
        return Response(status_code=204)

    @router.post("/uploads", status_code=201)
    async def create_upload(request: Request) -> Dict[str, str]:
        body = await request.json()
        if int(body.get("sizeBytes", 0)) > settings.max_file_mb * 1024 * 1024:
            raise HTTPException(status_code=413, detail="That file exceeds the configured upload limit.")
        material_id = _id("m")
        content_type = str(body.get("contentType") or "application/octet-stream")
        upload = {**body, "ownerId": current_owner_id(), "content": b"", "contentType": content_type}
        if storage.ready:
            try:
                object_key, upload_url = await run_in_threadpool(
                    storage.presign_upload, material_id, content_type
                )
            except Exception as exc:
                raise HTTPException(status_code=503, detail="S3 upload storage is configured but unavailable.") from exc
            upload["objectKey"] = object_key
        else:
            upload_url = "/api/uploads/{}/content".format(material_id)
        _uploads[material_id] = upload
        return {"materialId": material_id, "uploadUrl": upload_url}

    @router.put("/uploads/{material_id}/content", status_code=204)
    async def put_upload(material_id: str, request: Request) -> Response:
        upload = _uploads.get(material_id)
        if not upload:
            raise HTTPException(status_code=404, detail="Upload session not found.")
        content = await request.body()
        if len(content) > settings.max_file_mb * 1024 * 1024:
            raise HTTPException(status_code=413, detail="That file exceeds the configured upload limit.")
        upload["content"] = content
        upload["contentType"] = request.headers.get("content-type", "application/octet-stream")
        return Response(status_code=204)

    @router.post("/jobs", status_code=202)
    async def start_job(request: Request) -> Dict[str, str]:
        payload = await request.json()
        material_id = payload.get("materialId")
        if material_id not in _uploads:
            raise HTTPException(status_code=404, detail="Upload session not found.")
        job_id = _id("job")
        _jobs[job_id] = {
            "id": job_id,
            "ownerId": current_owner_id(),
            "materialId": material_id,
            "kind": "recap",
            "status": "running",
            "stage": "upload",
            "stageLabel": "Reading uploaded file",
            "progress": 2,
            "log": [],
        }
        _materials[material_id] = {
            "id": material_id,
            "ownerId": current_owner_id(),
            "title": Path(payload.get("fileName", "Upload")).stem,
            "fileName": payload.get("fileName", "upload"),
            "fileType": Path(payload.get("fileName", "upload")).suffix.lstrip("."),
            "sizeBytes": int(_uploads[material_id].get("sizeBytes") or len(_uploads[material_id].get("content", b""))),
            "module": payload.get("module", "Unfiled"),
            "mode": payload.get("mode", "deep"),
            "status": "processing",
            "pageCount": 0,
            "createdAt": _now(),
            "quiz": {"status": "not_generated", "questions": []},
        }
        dispatch(job_id, payload)
        return {"jobId": job_id, "materialId": material_id}

    @router.get("/jobs/{job_id}")
    async def get_job(job_id: str) -> Dict[str, Any]:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="That job has expired or never existed.")
        return job

    @router.get("/quizzes")
    async def list_quizzes() -> List[Dict[str, Any]]:
        return sorted(
            (deepcopy(quiz) for quiz in _quizzes.values()),
            key=lambda quiz: str(quiz.get("generatedAt") or ""),
            reverse=True,
        )

    @router.get("/quizzes/{quiz_id}")
    async def get_quiz(quiz_id: str) -> Dict[str, Any]:
        quiz = _quizzes.get(quiz_id)
        if not quiz:
            raise HTTPException(status_code=404, detail="That quiz version does not exist.")
        return deepcopy(quiz)

    @router.post("/materials/{material_id}/quiz", status_code=202)
    async def generate_material_quiz(
        material_id: str, quiz_request: QuizGenerationRequest
    ) -> Dict[str, str]:
        _require_material(material_id)
        if not _sources.get(material_id):
            raise HTTPException(status_code=422, detail="That material has no readable source text.")
        if quiz_request.difficulty == "hard":
            provider_error = hard_quiz_provider_error(settings)
            if provider_error:
                raise HTTPException(status_code=503, detail=provider_error)
        if any(
            job.get("kind") == "quiz"
            and job.get("materialId") == material_id
            and job.get("status") == "running"
            for job in _jobs.values()
        ):
            raise HTTPException(status_code=409, detail="A quiz is already being generated for this material.")
        job_id = _id("job")
        excluded_prompts = [
            str(question.get("prompt") or "")
            for quiz in _quizzes.values()
            if quiz.get("materialId") == material_id
            for question in quiz.get("questions", [])
            if question.get("prompt")
        ]
        payload = {
            "materialId": material_id,
            "difficulty": quiz_request.difficulty,
            "questionCount": quiz_request.question_count,
            "topics": quiz_request.topics,
            "questionTypes": quiz_request.question_types,
            "fresh": quiz_request.fresh,
            "excludedPrompts": list(dict.fromkeys(excluded_prompts))[-60:],
        }
        _jobs[job_id] = {
            "id": job_id,
            "ownerId": current_owner_id(),
            "materialId": material_id,
            "kind": "quiz",
            "status": "running",
            "stage": "queued",
            "stageLabel": "Quiz generation queued",
            "progress": 0,
            "log": [],
        }
        dispatch_quiz(job_id, payload)
        return {"jobId": job_id, "materialId": material_id, "kind": "quiz"}

    @router.put("/materials/{material_id}/quiz")
    async def save_material_quiz(material_id: str, request: Request) -> Dict[str, Any]:
        material = _require_material(material_id)
        body = await request.json()
        title = str(body.get("title") or "").strip()
        questions = body.get("questions")
        if not title or len(title) > 100:
            raise HTTPException(status_code=422, detail="Quiz title must be between 1 and 100 characters.")
        if not isinstance(questions, list) or not 1 <= len(questions) <= 50:
            raise HTTPException(status_code=422, detail="A manual quiz must contain between 1 and 50 questions.")

        saved_questions, prompts = [], set()
        for index, raw in enumerate(questions, start=1):
            if not isinstance(raw, dict):
                raise HTTPException(status_code=422, detail="Question {} must be an object.".format(index))
            kind = str(raw.get("type") or "single").strip().casefold()
            topic = str(raw.get("topic") or "").strip()
            prompt = str(raw.get("prompt") or "").strip()
            explanation = str(raw.get("explanation") or "").strip()
            if kind not in {"single", "multi", "short"}:
                raise HTTPException(status_code=422, detail="Question {} has an unsupported type.".format(index))
            if not topic or len(topic) > 80 or not prompt or len(prompt) > 1000 or not explanation or len(explanation) > 2000:
                raise HTTPException(status_code=422, detail="Question {} has incomplete or oversized text.".format(index))
            normalized_prompt = " ".join(prompt.casefold().split())
            if normalized_prompt in prompts:
                raise HTTPException(status_code=422, detail="Manual quiz questions must be unique.")
            prompts.add(normalized_prompt)
            saved = {
                "id": "q{}".format(index),
                "type": kind,
                "topic": topic,
                "difficulty": 2,
                "prompt": prompt,
                "explanation": explanation,
                "citations": [],
                "verified": True,
                "authoring": "manual",
            }
            if kind == "short":
                model_answer = str(raw.get("modelAnswer") or "").strip()
                rubric = str(raw.get("rubric") or "").strip()
                concepts = raw.get("keyConcepts")
                if not model_answer or len(model_answer) > 2000 or not rubric or len(rubric) > 1000:
                    raise HTTPException(status_code=422, detail="Short-answer question {} requires bounded modelAnswer and rubric text.".format(index))
                if not isinstance(concepts, list):
                    raise HTTPException(status_code=422, detail="Short-answer question {} requires 1 to 8 keyConcepts.".format(index))
                clean_concepts = [" ".join(str(item).strip().split()) for item in concepts]
                normalized_concepts = [item.casefold() for item in clean_concepts]
                if (
                    not 1 <= len(clean_concepts) <= 8
                    or any(not item or len(item) > 120 for item in clean_concepts)
                    or len(set(normalized_concepts)) != len(normalized_concepts)
                ):
                    raise HTTPException(status_code=422, detail="Short-answer question {} has invalid or duplicate keyConcepts.".format(index))
                saved.update(modelAnswer=model_answer, keyConcepts=clean_concepts, rubric=rubric)
            else:
                options = raw.get("options")
                answer = raw.get("answer")
                if not isinstance(options, list) or not 2 <= len(options) <= 6:
                    raise HTTPException(status_code=422, detail="Question {} must have 2 to 6 options.".format(index))
                clean_options = [str(option).strip() for option in options]
                if (
                    any(not option or len(option) > 500 for option in clean_options)
                    or len({" ".join(option.casefold().split()) for option in clean_options}) != len(clean_options)
                ):
                    raise HTTPException(status_code=422, detail="Question {} contains an empty, oversized, or duplicate option.".format(index))
                if kind == "single":
                    if isinstance(answer, bool) or not isinstance(answer, int) or not 0 <= answer < len(clean_options):
                        raise HTTPException(status_code=422, detail="Question {} has an invalid answer index.".format(index))
                else:
                    if (
                        not isinstance(answer, list)
                        or len(answer) < 2
                        or any(isinstance(item, bool) or not isinstance(item, int) or not 0 <= item < len(clean_options) for item in answer)
                        or len(set(answer)) != len(answer)
                    ):
                        raise HTTPException(status_code=422, detail="Multi-select question {} requires unique valid answer indexes.".format(index))
                    answer = sorted(answer)
                saved.update(options=clean_options, answer=answer)
            saved_questions.append(saved)

        quiz_id = _id("quiz")
        quiz_version = {
            "id": quiz_id,
            "ownerId": current_owner_id(),
            "materialId": material_id,
            "title": title,
            "status": "ready",
            "generationStatus": "ready",
            "difficulty": "manual",
            "questionCount": len(saved_questions),
            "questionTypes": list(dict.fromkeys(item["type"] for item in saved_questions)),
            "generatedAt": _now(),
            "authoring": "manual",
            "providers": [{"name": "Student authored", "model": "manual editor", "role": "author"}],
            "questions": saved_questions,
        }
        _quizzes[quiz_id] = deepcopy(quiz_version)
        material["quiz"] = deepcopy(quiz_version)
        await persist("quiz", quiz_id, quiz_version)
        await persist("material", material_id, material)
        return quiz_version

    def forum_like_key(post_id: str, user_id: str) -> str:
        secret = settings.jwt_secret.get_secret_value().encode("utf-8")
        return hmac.new(secret, "{}:{}".format(post_id, user_id).encode("utf-8"), hashlib.sha256).hexdigest()

    def public_forum_post(post: Dict[str, Any], user: Any = None) -> Dict[str, Any]:
        value = deepcopy(post)
        liked_keys = value.pop("_likedOwnerKeys", [])
        value["likedByMe"] = bool(
            user and forum_like_key(str(post.get("id") or ""), str(user["id"])) in liked_keys
        )
        return value

    @router.get("/forum/posts")
    async def list_forum_posts(request: Request) -> List[Dict[str, Any]]:
        await hydrate_public()
        user = optional_user(request)
        return [public_forum_post(post, user) for post in _forum_posts]

    @router.post("/forum/posts", status_code=201)
    async def create_forum_post(request: Request) -> Dict[str, Any]:
        await hydrate_public()
        body = await request.json()
        post_type = str(body.get("type") or "").strip().casefold()
        title = str(body.get("title") or "").strip()
        content = str(body.get("body") or "").strip()
        material_id = str(body.get("materialId") or "").strip()
        if post_type not in {"notes", "quiz", "question"}:
            raise HTTPException(status_code=422, detail="Post type must be notes, quiz, or question.")
        if not 1 <= len(title) <= 120 or not 1 <= len(content) <= 4000:
            raise HTTPException(status_code=422, detail="Post title and body are required and must fit the published limits.")
        material = _require_material(material_id) if material_id else None
        user = current_user()
        post = {
            "id": _id("post"),
            "type": post_type,
            "title": title,
            "body": content,
            "author": {"id": user["id"], "name": user["name"]},
            "materialId": material_id or None,
            "materialTitle": material.get("title") if material else None,
            "createdAt": _now(),
            "likeCount": 0,
            "_likedOwnerKeys": [],
            "comments": [],
            "commentCount": 0,
        }
        _forum_posts.insert(0, post)
        await persist_public("forum", post["id"], post)
        return public_forum_post(post, user)

    def require_forum_post(post_id: str) -> Dict[str, Any]:
        post = next((item for item in _forum_posts if item["id"] == post_id), None)
        if not post:
            raise HTTPException(status_code=404, detail="That community post does not exist.")
        return post

    @router.post("/forum/posts/{post_id}/like")
    async def toggle_forum_like(post_id: str) -> Dict[str, Any]:
        await hydrate_public()
        post = require_forum_post(post_id)
        user = current_user()
        key = forum_like_key(post_id, str(user["id"]))
        liked_keys = set(post.get("_likedOwnerKeys") or [])
        if key in liked_keys:
            liked_keys.remove(key)
        else:
            liked_keys.add(key)
        post.pop("likedByMe", None)  # discard the legacy global per-post flag
        post["_likedOwnerKeys"] = sorted(liked_keys)
        post["likeCount"] = len(liked_keys)
        await persist_public("forum", post_id, post)
        return public_forum_post(post, user)

    @router.post("/forum/posts/{post_id}/comments", status_code=201)
    async def add_forum_comment(post_id: str, request: Request) -> Dict[str, Any]:
        await hydrate_public()
        post = require_forum_post(post_id)
        content = str((await request.json()).get("body") or "").strip()
        if not 1 <= len(content) <= 1000:
            raise HTTPException(status_code=422, detail="Comment body must be between 1 and 1,000 characters.")
        user = current_user()
        post["comments"].append({
            "id": _id("comment"),
            "body": content,
            "author": {"id": user["id"], "name": user["name"]},
            "createdAt": _now(),
        })
        post["commentCount"] = len(post["comments"])
        await persist_public("forum", post_id, post)
        return deepcopy(post)

    @router.post("/materials/{material_id}/illustrations", status_code=201)
    async def create_illustrations(
        material_id: str,
        illustration_request: IllustrationGenerationRequest,
    ) -> List[Dict[str, Any]]:
        if not settings.enable_study_images:
            raise HTTPException(status_code=503, detail="Study illustrations are disabled. Set ENABLE_STUDY_IMAGES=true to opt in.")
        material = _require_material(material_id)
        existing = material.get("illustrations", [])
        if existing and not illustration_request.regenerate:
            return [
                {key: value for key, value in item.items() if not key.startswith("_")}
                for item in existing[:illustration_request.count]
            ]
        if material_id in _illustrations_inflight:
            raise HTTPException(status_code=409, detail="Study visuals are already being generated for this material.")
        elapsed = time.monotonic() - _illustration_last_generated.get(material_id, 0.0)
        if illustration_request.regenerate and elapsed < 60:
            retry_after = max(1, int(60 - elapsed))
            raise HTTPException(
                status_code=429,
                detail="Study visuals were just generated. Wait briefly before regenerating them.",
                headers={"Retry-After": str(retry_after)},
            )

        topic_sections = [
            section
            for section in material.get("recap", {}).get("sections", [])
            if section.get("id") != "takeaways"
        ][:illustration_request.count]
        if not topic_sections:
            raise HTTPException(status_code=422, detail="This recap has no grounded topic sections to illustrate.")

        previous = deepcopy(existing)
        created: List[Dict[str, Any]] = []
        _illustrations_inflight.add(material_id)
        try:
            for section in topic_sections:
                explanation = " ".join(str(point.get("text") or "") for point in section.get("points", [])[:3])
                prompt = await run_in_threadpool(
                    create_study_image_prompt,
                    str(section.get("heading") or "Study concept"),
                    explanation,
                    settings,
                )
                content, content_type, digest = await run_in_threadpool(generate_image, prompt, settings)
                illustration_id = "img_{}".format(digest)
                item = {
                    "id": illustration_id,
                    "topic": str(section.get("heading") or "Study concept"),
                    "provider": "Pollinations.ai",
                    "model": settings.pollinations_model,
                    "path": "/api/materials/{}/illustrations/{}".format(material_id, illustration_id),
                    "createdAt": _now(),
                }
                if storage.ready:
                    extension = {"image/png": "png", "image/webp": "webp"}.get(content_type, "jpg")
                    item["_storageKey"] = await run_in_threadpool(
                        storage.put_image,
                        "generated/{}/{}.{}".format(material_id, illustration_id, extension),
                        content,
                        content_type,
                    )
                else:
                    _illustration_bytes[illustration_id] = (content, content_type)
                created.append(item)
            material["illustrations"] = created
            await persist("material", material_id, material)
        except Exception as exc:
            material["illustrations"] = previous
            for item in created:
                _illustration_bytes.pop(str(item.get("id") or ""), None)
                if storage.ready and item.get("_storageKey"):
                    try:
                        await run_in_threadpool(storage.delete_key, str(item["_storageKey"]))
                    except Exception as cleanup_exc:
                        logger.warning("Could not remove failed illustration %s: %s", item.get("id"), cleanup_exc)
            raise HTTPException(status_code=502, detail="Study images could not be generated; your text notes are unchanged.") from exc
        finally:
            _illustrations_inflight.discard(material_id)

        _illustration_last_generated[material_id] = time.monotonic()
        created_keys = {item.get("_storageKey") for item in created if item.get("_storageKey")}
        created_ids = {str(item.get("id")) for item in created if item.get("id")}
        for item in previous:
            if item.get("_storageKey") and item.get("_storageKey") not in created_keys and storage.ready:
                try:
                    await run_in_threadpool(storage.delete_key, str(item["_storageKey"]))
                except Exception as exc:
                    logger.warning("Could not remove replaced illustration %s: %s", item.get("id"), exc)
            if item.get("id") and str(item["id"]) not in created_ids:
                _illustration_bytes.pop(str(item["id"]), None)
        return [{key: value for key, value in item.items() if not key.startswith("_")} for item in created]

    @router.get("/materials/{material_id}/illustrations/{illustration_id}")
    async def get_illustration(material_id: str, illustration_id: str) -> Response:
        material = _require_material(material_id)
        all_illustrations = material.get("illustrations", []) + material.get("chatIllustrations", [])
        item = next((value for value in all_illustrations if value.get("id") == illustration_id), None)
        if not item:
            raise HTTPException(status_code=404, detail="That study illustration does not exist.")
        if item.get("_storageKey") and storage.ready:
            content, _ = await run_in_threadpool(storage.get_image, item["_storageKey"])
        else:
            cached = _illustration_bytes.get(illustration_id)
            if not cached:
                raise HTTPException(status_code=404, detail="That local study illustration has expired.")
            content, _ = cached
        try:
            content_type = await run_in_threadpool(verify_raster_image, content)
        except ValueError as exc:
            raise HTTPException(status_code=415, detail="That stored illustration is not a safe raster image.") from exc
        return Response(
            content=content,
            media_type=content_type,
            headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"},
        )

    @router.post("/ask")
    async def ask_material(ask_request: MaterialAskRequest) -> Dict[str, Any]:
        material_id = ask_request.material_id
        sources = _sources.get(material_id, [])
        if not sources:
            raise HTTPException(status_code=422, detail="That material has no readable source text.")
        try:
            answer = await asyncio.wait_for(
                run_in_threadpool(answer_notebook_question, sources, ask_request.question, settings),
                timeout=settings.ai_timeout_seconds + 30,
            )
        except asyncio.TimeoutError as exc:
            raise HTTPException(status_code=504, detail="The notebook answer took too long.") from exc
        chunks = _require_material(material_id).get("chunks", [])
        citation_ids = list(dict.fromkeys(_citation_id(citation, chunks) for citation in answer.citations))
        answer_id = None
        if answer.grounded and citation_ids:
            now = time.monotonic()
            for cached_id, cached in list(_chat_answers.items()):
                if float(cached.get("expiresAt", 0)) <= now:
                    _chat_answers.pop(cached_id, None)
            answer_id = _id("answer")
            _chat_answers[answer_id] = {
                "materialId": material_id,
                "question": ask_request.question,
                "answer": answer.answer,
                "citations": citation_ids,
                "expiresAt": now + 900,
            }
        return {
            "answer": answer.answer,
            "citations": citation_ids,
            "grounded": answer.grounded,
            "answerId": answer_id,
        }

    @router.post("/materials/{material_id}/chat-illustrations", status_code=201)
    async def create_chat_illustration(
        material_id: str,
        chat_request: ChatIllustrationRequest,
    ) -> Dict[str, Any]:
        if not settings.enable_study_images:
            raise HTTPException(status_code=503, detail="Study illustrations are disabled. Set ENABLE_STUDY_IMAGES=true to opt in.")
        material = _require_material(material_id)
        cached_answer = _chat_answers.get(chat_request.answer_id)
        if not cached_answer or float(cached_answer.get("expiresAt", 0)) <= time.monotonic():
            _chat_answers.pop(chat_request.answer_id, None)
            raise HTTPException(status_code=410, detail="That grounded answer expired. Ask the question again to create a visual.")
        if cached_answer.get("materialId") != material_id:
            raise HTTPException(status_code=403, detail="That answer does not belong to this material.")
        if not cached_answer.get("citations"):
            raise HTTPException(status_code=422, detail="Only source-grounded answers can become study visuals.")

        existing_id = cached_answer.get("illustrationId")
        existing = next(
            (item for item in material.get("chatIllustrations", []) if item.get("id") == existing_id),
            None,
        )
        if existing:
            return {key: value for key, value in existing.items() if not key.startswith("_")}
        if material_id in _illustrations_inflight:
            raise HTTPException(status_code=409, detail="A study visual is already being generated for this material.")
        elapsed = time.monotonic() - _chat_illustration_last_generated.get(material_id, 0.0)
        if elapsed < 60:
            retry_after = max(1, int(60 - elapsed))
            raise HTTPException(
                status_code=429,
                detail="A chat visual was just generated. Wait briefly before creating another.",
                headers={"Retry-After": str(retry_after)},
            )

        item: Dict[str, Any] = {}
        previous = list(material.get("chatIllustrations", []))
        _illustrations_inflight.add(material_id)
        try:
            prompt = await run_in_threadpool(
                create_study_image_prompt,
                str(cached_answer["question"])[:120],
                str(cached_answer["answer"])[:1200],
                settings,
            )
            content, content_type, digest = await run_in_threadpool(generate_image, prompt, settings)
            illustration_id = "chat_{}".format(digest)
            item = {
                "id": illustration_id,
                "topic": str(cached_answer["question"])[:120],
                "provider": "Pollinations.ai",
                "model": settings.pollinations_model,
                "kind": "chat",
                "path": "/api/materials/{}/illustrations/{}".format(material_id, illustration_id),
                "createdAt": _now(),
            }
            if storage.ready:
                extension = {"image/png": "png", "image/webp": "webp"}.get(content_type, "jpg")
                item["_storageKey"] = await run_in_threadpool(
                    storage.put_image,
                    "generated/{}/chat/{}.{}".format(material_id, illustration_id, extension),
                    content,
                    content_type,
                )
            else:
                _illustration_bytes[illustration_id] = (content, content_type)
            material["chatIllustrations"] = (previous + [item])[-12:]
            await persist("material", material_id, material)
            cached_answer["illustrationId"] = illustration_id
            _chat_illustration_last_generated[material_id] = time.monotonic()
        except Exception as exc:
            material["chatIllustrations"] = previous
            if item.get("id"):
                _illustration_bytes.pop(str(item["id"]), None)
            if storage.ready and item.get("_storageKey"):
                try:
                    await run_in_threadpool(storage.delete_key, str(item["_storageKey"]))
                except Exception as cleanup_exc:
                    logger.warning("Could not remove failed chat illustration %s: %s", item.get("id"), cleanup_exc)
            raise HTTPException(status_code=502, detail="A source-grounded visual could not be generated for that answer.") from exc
        finally:
            _illustrations_inflight.discard(material_id)
        return {key: value for key, value in item.items() if not key.startswith("_")}

    @router.post("/quiz/attempts", status_code=201)
    async def submit_attempt(request: Request) -> Dict[str, Any]:
        body = await request.json()
        quiz_id = str(body.get("quizId") or "").strip()
        if not quiz_id:
            raise HTTPException(status_code=422, detail="quizId is required.")
        quiz = _quizzes.get(quiz_id)
        if not quiz:
            raise HTTPException(status_code=404, detail="That quiz version does not exist.")
        material = _require_material(str(body.get("materialId") or ""))
        if quiz.get("materialId") != material["id"]:
            raise HTTPException(status_code=409, detail="That quizId does not belong to this material.")
        answers = body.get("answers", {})
        if not isinstance(answers, dict):
            raise HTTPException(status_code=422, detail='"answers" must be an object.')

        available = {
            item["id"]: item for item in quiz.get("questions", []) if item.get("verified")
        }
        requested_ids = body.get("questionIds")
        if requested_ids is None:
            question_ids = list(available)
        elif not isinstance(requested_ids, list) or not all(isinstance(item, str) for item in requested_ids):
            raise HTTPException(status_code=422, detail='"questionIds" must be an array of question IDs.')
        else:
            question_ids = list(dict.fromkeys(requested_ids))
        if not question_ids or any(question_id not in available for question_id in question_ids):
            raise HTTPException(status_code=422, detail="The attempt contains an invalid or empty question scope.")
        questions = [available[question_id] for question_id in question_ids]

        judgements: Dict[str, Dict[str, Any]] = {}
        correctness: Dict[str, bool] = {}
        for item in questions:
            is_correct, judgement = _score_quiz_question(item, answers.get(item["id"]))
            correctness[item["id"]] = is_correct
            judgements[item["id"]] = judgement

        correct = sum(correctness.values())
        topic_totals: Dict[str, Dict[str, int]] = {}
        for item in questions:
            row = topic_totals.setdefault(item["topic"], {"correct": 0, "total": 0})
            row["total"] += 1
            row["correct"] += int(correctness[item["id"]])
        attempt = {
            "id": _id("a"),
            "ownerId": current_owner_id(),
            "materialId": material["id"],
            "quizId": quiz_id,
            "at": _now(),
            "durationMs": int(body.get("durationMs", 0)),
            "correct": correct,
            "total": len(questions),
            "score": round(correct / len(questions) * 100),
            "byTopic": [{"topic": topic, **scores} for topic, scores in topic_totals.items()],
            "answers": deepcopy(answers),
            "judgements": judgements,
            "questions": deepcopy(questions),
            "difficulty": quiz.get("difficulty"),
            "questionCount": len(questions),
            "providers": deepcopy(quiz.get("providers", [])),
        }
        _attempts.insert(0, attempt)
        await persist("attempt", attempt["id"], attempt)
        return attempt

    @router.get("/quiz/attempts")
    async def list_attempts(materialId: str = "") -> List[Dict[str, Any]]:
        return [item for item in _attempts if not materialId or item["materialId"] == materialId]

    @router.get("/materials/{material_id}/flashcards")
    async def get_flashcards(material_id: str):
        _require_material(material_id)
        return _cards.get(material_id)

    @router.put("/materials/{material_id}/flashcards")
    async def save_flashcards(material_id: str, request: Request):
        _require_material(material_id)
        cards = (await request.json()).get("cards")
        if not isinstance(cards, list):
            raise HTTPException(status_code=422, detail='"cards" must be an array.')
        _cards[material_id] = cards
        await persist("cards", material_id, cards)
        return cards

    @router.post("/materials/{material_id}/share", status_code=201)
    async def create_share(material_id: str, request: Request) -> Dict[str, str]:
        _require_material(material_id)
        token = _id("s")
        index = {"ownerId": current_owner_id(), "materialId": material_id}
        _shares[token] = index
        await persist_public("share", token, index)
        return {"token": token, "url": "{}s/{}".format(str(request.base_url), token)}

    @router.get("/shared/{token}")
    async def get_share(token: str) -> Dict[str, Any]:
        await hydrate_public()
        index = _shares.get(token)
        if not index:
            raise HTTPException(status_code=404, detail="This share link is no longer valid.")
        owner_id, material_id = index.get("ownerId", ""), index.get("materialId", "")
        material = _materials.owner_data(owner_id).get(material_id)
        if not material and repository.ready:
            material = await run_in_threadpool(repository.get, owner_id, "material", material_id)
            if isinstance(material, dict):
                _materials.owner_data(owner_id)[material_id] = material
        if not isinstance(material, dict):
            raise HTTPException(status_code=404, detail="This share link is no longer valid.")
        return _public_material(material)

    @router.post("/tts")
    async def tts_unavailable() -> None:
        raise HTTPException(status_code=501, detail="Read-aloud is not configured on the Python backend.")

    @router.post("/practice/explain")
    async def explain_practice_failure(request: Request) -> Dict[str, Any]:
        """Why did this attempt fail?

        Deliberately not "fix my code": the service is prompted to withhold a
        solution and its output is stripped of code blocks, because a student
        handed working code has learned nothing. See `code_service.py`.
        """
        body = await request.json()
        code = str(body.get("code") or "").strip()
        if not code:
            raise HTTPException(status_code=422, detail="There is no code to look at yet.")
        if not coding_help_available(settings):
            raise HTTPException(
                status_code=501,
                detail="Coding help is not configured on this deployment.",
            )

        result = await run_in_threadpool(
            explain_failure,
            language=str(body.get("language") or "python"),
            brief=str(body.get("brief") or ""),
            code=code,
            failures=[f for f in (body.get("failures") or []) if isinstance(f, dict)],
            settings=settings,
        )
        if not result:
            raise HTTPException(status_code=502, detail="Could not reach the coding model just now.")
        return {"explanation": result["text"], "model": result["model"]}

    @router.get("/practice/help-available")
    async def practice_help_available() -> Dict[str, Any]:
        return {"available": coding_help_available(settings)}

    @router.get("/materials/{material_id}/practice")
    async def get_practice(material_id: str, refresh: str = "") -> Dict[str, Any]:
        """Coding exercises drawn from this material, or an honest refusal.

        Generated on demand rather than during the pipeline: most uploads are
        not programming material, and spending a request on exercises for a
        marketing deck every time — only to throw them away — is a bad trade.
        The answer is cached on the material either way, because "no" is a
        result and re-deciding it on every visit costs a request to reach the
        same conclusion.
        """
        material = _require_material(material_id)
        if refresh != "1" and material.get("practice"):
            return {**material["practice"], "cached": True}

        sources = _sources.get(material_id, [])
        if not sources:
            raise HTTPException(status_code=422, detail="That material has no readable source text.")

        pack = await run_in_threadpool(generate_practice, sources, settings)
        chunks = material.get("chunks", [])
        exercises = []
        for exercise in pack.exercises:
            citation_ids = list(dict.fromkeys(_citation_id(c, chunks) for c in exercise.citations)) if chunks else []
            exercises.append({
                "id": exercise.id,
                "title": exercise.title,
                "concept": exercise.concept,
                "language": exercise.language,
                "entry": exercise.entry,
                "brief": exercise.brief,
                "starter": exercise.starter,
                "tests": [{"call": t.call, "expect": t.expect} for t in exercise.tests],
                "hint": exercise.hint,
                "citations": citation_ids,
            })

        payload = {
            "applicable": bool(exercises),
            "reason": pack.reason,
            "exercises": exercises,
        }
        material["practice"] = payload
        await persist("material", material_id, material)
        return {**payload, "cached": False}

    return router
