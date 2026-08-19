import asyncio
import json
import logging
import re
import secrets
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from .ai_service import generate_notebook_pack, generate_notebook_quiz
from .auth import AuthenticatedRoute, OwnerMap, current_owner_id, register_owner_hydrator
from .config import Settings
from .models import Citation, SourceRecord
from .repository import DurableRepository
from .storage import ObjectStorage
from .ui_api import _citation_id, _jobs, _source_chunks

logger = logging.getLogger("smartrecap.binders")
ExtractSource = Callable[[bytes, str, str, bool], Awaitable[SourceRecord]]

_binders: OwnerMap = OwnerMap()
_sources: OwnerMap = OwnerMap()
_uploads: OwnerMap = OwnerMap()
_binder_cards: OwnerMap = OwnerMap()
_tasks: set[asyncio.Task] = set()
_MAX_SELECTED_SOURCES = 50
_MAX_SOURCE_ID_LENGTH = 128
_MAX_NOTE_CHARACTERS = 100_000
_MAX_NOTE_BODY_BYTES = 500_000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _id(prefix: str) -> str:
    return "{}_{}".format(prefix, secrets.token_urlsafe(9))


def _require_binder(binder_id: str) -> Dict[str, Any]:
    binder = _binders.get(binder_id)
    if not binder:
        raise HTTPException(status_code=404, detail="That binder is not in your library.")
    return binder


def _require_source(source_id: str, binder_id: Optional[str] = None) -> Dict[str, Any]:
    source = _sources.get(source_id)
    if not source or (binder_id and source.get("binderId") != binder_id):
        raise HTTPException(status_code=404, detail="That source is not in this binder.")
    return source


def _public_source(source: Dict[str, Any]) -> Dict[str, Any]:
    value = deepcopy(source)
    value.pop("_record", None)
    return value


def _public_binder(binder: Dict[str, Any], list_view: bool = False) -> Dict[str, Any]:
    value = deepcopy(binder)
    if list_view:
        for key in ("recap", "quiz", "chunks", "sourcesSummary"):
            value.pop(key, None)
    return value


def _source_rows(binder_id: str) -> List[Dict[str, Any]]:
    return sorted(
        (source for source in _sources.values() if source.get("binderId") == binder_id),
        key=lambda source: source.get("uploadedAt", ""),
    )


def _selection(rows: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    return [
        {"sourceId": row["id"], "displayName": row["displayName"]}
        for row in rows
    ]


def _parse_generation_source_ids(raw_body: bytes) -> Optional[List[str]]:
    if not raw_body.strip():
        return None
    try:
        body = json.loads(raw_body)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="The generation body must be valid JSON.") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="The generation body must be a JSON object.")
    if "sourceIds" not in body:
        return None
    source_ids = body["sourceIds"]
    if not isinstance(source_ids, list) or not 1 <= len(source_ids) <= _MAX_SELECTED_SOURCES:
        raise HTTPException(
            status_code=422,
            detail="sourceIds must contain between 1 and {} source IDs.".format(_MAX_SELECTED_SOURCES),
        )
    if any(
        not isinstance(source_id, str)
        or not source_id.strip()
        or len(source_id) > _MAX_SOURCE_ID_LENGTH
        for source_id in source_ids
    ):
        raise HTTPException(status_code=422, detail="Every source ID must be a non-empty bounded string.")
    if len(source_ids) != len(set(source_ids)):
        raise HTTPException(status_code=422, detail="sourceIds must not contain duplicates.")
    return source_ids


def _rename_source_references(value: Any, source_id: str, display_name: str) -> None:
    if isinstance(value, dict):
        if value.get("sourceId") == source_id:
            if "displayName" in value:
                value["displayName"] = display_name
            if "sourceName" in value:
                value["sourceName"] = display_name
        for nested in value.values():
            _rename_source_references(nested, source_id, display_name)
    elif isinstance(value, list):
        for nested in value:
            _rename_source_references(nested, source_id, display_name)


def _resolved(citation: Citation, chunks: List[Dict[str, Any]], names: Dict[str, str]) -> Tuple[str, Dict[str, Any]]:
    chunk_id = _citation_id(citation, chunks)
    chunk = next((item for item in chunks if item["id"] == chunk_id), chunks[0])
    return chunk_id, {
        "sourceId": chunk["sourceId"],
        "displayName": names.get(chunk["sourceId"], chunk.get("sourceName", "Source")),
        "page": chunk.get("page", 1),
    }


def _binder_result(
    binder: Dict[str, Any],
    records: List[SourceRecord],
    selected_sources: List[Dict[str, str]],
    pack,
    quiz_pack,
    providers,
) -> Dict[str, Any]:
    chunks = [chunk for record in records for chunk in _source_chunks(record)]
    names = {item["sourceId"]: item["displayName"] for item in selected_sources}
    citation_counts = {source_id: 0 for source_id in names}
    point_number = 0

    def point(text: str, citation: Citation) -> Dict[str, Any]:
        nonlocal point_number
        point_number += 1
        chunk_id, resolved = _resolved(citation, chunks, names)
        citation_counts[resolved["sourceId"]] = citation_counts.get(resolved["sourceId"], 0) + 1
        return {
            "id": "p{}".format(point_number),
            "text": text,
            "citations": [chunk_id],
            "resolvedCitations": [resolved],
            "confidence": "grounded",
            "unverified": False,
        }

    sections = [{
        "id": "takeaways",
        "heading": "Key takeaways",
        "points": [point(item.text, item.citation) for item in pack.takeaways],
    }]
    for index, topic in enumerate(pack.topics):
        points = [point(topic.explanation, topic.citation)]
        points.extend(point(bullet, topic.citation) for bullet in topic.bullets)
        sections.append({"id": "topic-{}".format(index + 1), "heading": topic.title, "points": points})

    terms = []
    for item in pack.definitions:
        chunk_id, resolved = _resolved(item.citation, chunks, names)
        citation_counts[resolved["sourceId"]] = citation_counts.get(resolved["sourceId"], 0) + 1
        terms.append({
            "term": item.term,
            "definition": item.meaning,
            "citations": [chunk_id],
            "resolvedCitations": [resolved],
            "unverified": False,
        })

    questions = []
    if quiz_pack:
        for index, item in enumerate(quiz_pack.questions):
            chunk_id, resolved = _resolved(item.citation, chunks, names)
            citation_counts[resolved["sourceId"]] = citation_counts.get(resolved["sourceId"], 0) + 1
            questions.append({
                "id": "q{}".format(index + 1),
                "topic": item.topic,
                "difficulty": 2,
                "prompt": item.prompt,
                "options": item.options,
                "answer": item.answer,
                "explanation": item.explanation,
                "citations": [chunk_id],
                "resolvedCitations": [resolved],
                "verified": True,
                "unverified": False,
            })

    summaries = []
    for record in records:
        summaries.append({
            "sourceId": record.id,
            "displayName": names.get(record.id, record.filename),
            "pageCount": max(1, len(record.labels)),
            "citationCount": citation_counts.get(record.id, 0),
        })
    return {
        "recap": {
            "summary": pack.overview,
            "readMinutes": pack.read_minutes,
            "sections": sections,
            "keyTerms": terms,
            "examTips": pack.warnings,
            "ungrounded": [],
        },
        "quiz": {
            "status": "ready" if questions else "not_generated",
            "questions": questions,
            "providers": providers,
        },
        "chunks": chunks,
        "sourcesSummary": summaries,
        "sourceIds": [item["sourceId"] for item in selected_sources],
        "sourceSelection": deepcopy(selected_sources),
        "providers": deepcopy(getattr(pack, "providers", [])),
    }


def build_binder_router(extract_source: ExtractSource, settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/api", route_class=AuthenticatedRoute)
    storage = ObjectStorage(settings)
    repository = DurableRepository(settings, storage)
    max_bytes = settings.max_file_mb * 1024 * 1024
    loaded_owners: set[str] = set()

    async def hydrate_owner(owner_id: str) -> None:
        if owner_id in loaded_owners:
            return
        if repository.ready:
            for kind, target in (("binder", _binders), ("binder_source", _sources)):
                for item in await run_in_threadpool(repository.load_kind, owner_id, kind):
                    if isinstance(item.get("value"), dict):
                        target.owner_data(owner_id)[item["id"]] = item["value"]
            for item in await run_in_threadpool(repository.load_kind, owner_id, "binder_cards"):
                if isinstance(item.get("value"), list):
                    _binder_cards.owner_data(owner_id)[item["id"]] = item["value"]
        loaded_owners.add(owner_id)

    register_owner_hydrator(hydrate_owner)

    async def persist(kind: str, record_id: str, value: Any) -> None:
        owner_id = current_owner_id()
        if isinstance(value, dict):
            value["ownerId"] = owner_id
        if repository.ready:
            await run_in_threadpool(repository.save, owner_id, kind, record_id, deepcopy(value))

    async def remove(kind: str, record_id: str) -> None:
        if repository.ready:
            await run_in_threadpool(repository.delete, current_owner_id(), kind, record_id)

    async def save_binder(binder: Dict[str, Any]) -> None:
        binder["updatedAt"] = _now()
        binder["sourceCount"] = len(_source_rows(binder["id"]))
        await persist("binder", binder["id"], binder)

    async def invalidate(binder_id: str, source_id: Optional[str] = None) -> None:
        binder = _require_binder(binder_id)
        generated_source_ids = binder.get("sourceIds")
        if source_id is not None and isinstance(generated_source_ids, list) and source_id not in generated_source_ids:
            await save_binder(binder)
            return
        for key, default in (
            ("recap", None),
            ("quiz", None),
            ("chunks", []),
            ("sourcesSummary", []),
            ("sourceIds", []),
            ("sourceSelection", []),
            ("generatedAt", None),
        ):
            binder[key] = default
        await save_binder(binder)

    async def source_bytes(source: Dict[str, Any]) -> bytes:
        if storage.ready:
            return await run_in_threadpool(storage.get_bytes, storage.upload_key(source["id"]), max_bytes, source["id"])
        content = _uploads.get(source["id"])
        if content is None:
            raise HTTPException(status_code=409, detail="Upload the PDF before committing this source.")
        return content

    async def run_extraction(source_id: str) -> None:
        source = _sources.get(source_id)
        if not source:
            return
        try:
            content = await source_bytes(source)
            record = await extract_source(content, source["originalFilename"], "application/pdf", True)
            record = record.model_copy(update={"id": source_id, "filename": source["originalFilename"]})
            other_pages = sum(
                int(row.get("pageCount") or 0)
                for row in _source_rows(source["binderId"])
                if row["id"] != source_id and row.get("status") == "ready"
            )
            if other_pages + max(1, len(record.labels)) > 300:
                raise ValueError("This source would put the binder over the 300-page limit.")
            source.update(
                status="ready",
                pageCount=max(1, len(record.labels)),
                extractionMethod="Local OCR" if record.warnings else "Native PDF text",
                errorMessage=None,
                _record=record.model_dump(),
            )
            await persist("binder_source", source_id, source)
            await invalidate(source["binderId"], source_id)
        except Exception as exc:
            logger.warning("Binder source extraction failed source=%s error=%s", source_id, exc)
            source.update(status="failed", errorMessage=str(exc)[:500])
            await persist("binder_source", source_id, source)

    def dispatch_extraction(source_id: str) -> None:
        task = asyncio.create_task(run_extraction(source_id))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)

    async def run_generation(job_id: str, binder_id: str, source_ids: List[str]) -> None:
        job = _jobs[job_id]
        try:
            binder = _require_binder(binder_id)
            rows = [_require_source(source_id, binder_id) for source_id in source_ids]
            unavailable = next(
                (row for row in rows if row.get("status") != "ready" or not row.get("_record")),
                None,
            )
            if unavailable:
                raise ValueError("A selected source is no longer ready; choose ready sources and try again.")
            records = [SourceRecord.model_validate(row["_record"]) for row in rows]
            selected_sources = _selection(rows)
            job["sourceSelection"] = deepcopy(selected_sources)
            job.update(stage="read", progress=10, stageLabel="Reading your sources")
            pack = await run_in_threadpool(generate_notebook_pack, records, binder["name"], "deep", settings)
            job.update(stage="ground", progress=72, stageLabel="Checking every claim against its source")
            quiz_pack, providers = None, []
            try:
                quiz_pack, providers = await run_in_threadpool(
                    generate_notebook_quiz, records, "medium", 10, settings, [], []
                )
            except Exception as exc:
                logger.info("Binder quiz skipped; recap remains available: %s", exc)
            result = _binder_result(binder, records, selected_sources, pack, quiz_pack, providers)
            binder.update(result, generatedAt=_now())
            await save_binder(binder)
            job.update(status="ready", stage="done", progress=100, stageLabel="Binder recap ready")
        except Exception as exc:
            logger.warning("Binder generation failed binder=%s error=%s", binder_id, exc)
            job.update(status="failed", stage="failed", error=str(exc)[:500], stageLabel="Binder generation failed")

    def dispatch_generation(job_id: str, binder_id: str, source_ids: List[str]) -> None:
        task = asyncio.create_task(run_generation(job_id, binder_id, source_ids))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)

    @router.get("/binders")
    async def list_binders() -> List[Dict[str, Any]]:
        return [
            _public_binder(item, list_view=True)
            for item in sorted(
                _binders.values(),
                key=lambda row: (row.get("isFavourite", False), row.get("updatedAt", "")),
                reverse=True,
            )
        ]


    @router.post("/binders", status_code=201)
    async def create_binder(request: Request) -> Dict[str, Any]:
        name = str((await request.json()).get("name", "")).strip()
        if not 1 <= len(name) <= 100:
            raise HTTPException(status_code=422, detail="A binder name between 1 and 100 characters is required.")
        binder_id, now = _id("binder"), _now()
        binder = {
            "id": binder_id,
            "ownerId": current_owner_id(),
            "name": name,
            "isFavourite": False,
            "sourceCount": 0,
            "recap": None,
            "quiz": None,
            "chunks": [],
            "sourcesSummary": [],
            "sourceIds": [],
            "sourceSelection": [],
            "generatedAt": None,
            "createdAt": now,
            "updatedAt": now,
        }
        _binders[binder_id] = binder
        await persist("binder", binder_id, binder)
        return _public_binder(binder)

    @router.get("/binders/{binder_id}")
    async def get_binder(binder_id: str) -> Dict[str, Any]:
        return _public_binder(_require_binder(binder_id))

    @router.get("/binders/{binder_id}/flashcards")
    async def get_binder_flashcards(binder_id: str) -> Optional[List[Dict[str, Any]]]:
        _require_binder(binder_id)
        return _binder_cards.get(binder_id)

    @router.put("/binders/{binder_id}/flashcards")
    async def save_binder_flashcards(binder_id: str, request: Request) -> List[Dict[str, Any]]:
        _require_binder(binder_id)
        cards = (await request.json()).get("cards")
        if not isinstance(cards, list):
            raise HTTPException(status_code=422, detail='"cards" must be an array.')
        _binder_cards[binder_id] = cards
        await persist("binder_cards", binder_id, cards)
        return cards

    @router.patch("/binders/{binder_id}")
    async def update_binder(binder_id: str, request: Request) -> Dict[str, Any]:
        binder = _require_binder(binder_id)
        body = await request.json()
        changed = False
        if "name" in body:
            name = str(body["name"]).strip()
            if not 1 <= len(name) <= 100:
                raise HTTPException(status_code=422, detail="Binder names must be between 1 and 100 characters.")
            binder["name"], changed = name, True
        if "isFavourite" in body:
            if not isinstance(body["isFavourite"], bool):
                raise HTTPException(status_code=422, detail="isFavourite must be a boolean.")
            binder["isFavourite"], changed = body["isFavourite"], True
        if not changed:
            raise HTTPException(status_code=422, detail="Provide a name and/or isFavourite.")
        await save_binder(binder)
        return _public_binder(binder)

    @router.delete("/binders/{binder_id}", status_code=204)
    async def delete_binder(binder_id: str) -> Response:
        _require_binder(binder_id)
        rows = list(_source_rows(binder_id))
        if any(source.get("status") == "processing" for source in rows) or any(
            job.get("kind") == "binder" and job.get("binderId") == binder_id and job.get("status") == "running"
            for job in _jobs.values()
        ):
            raise HTTPException(status_code=409, detail="Wait for active Binder processing to finish before deleting it.")
        try:
            for source in rows:
                if storage.ready and source.get("sourceType") != "text":
                    await run_in_threadpool(storage.delete_key, storage.upload_key(source["id"]))
                await remove("binder_source", source["id"])
            await remove("binder", binder_id)
            await remove("binder_cards", binder_id)
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Binder cleanup failed; retry shortly.") from exc
        for source in rows:
            _sources.pop(source["id"], None)
            _uploads.pop(source["id"], None)
        _binders.pop(binder_id, None)
        _binder_cards.pop(binder_id, None)
        return Response(status_code=204)

    @router.get("/binders/{binder_id}/sources")
    async def list_sources(binder_id: str) -> List[Dict[str, Any]]:
        _require_binder(binder_id)
        return [_public_source(source) for source in _source_rows(binder_id)]


    @router.post("/binders/{binder_id}/sources/text", status_code=201)
    async def create_text_source(binder_id: str, request: Request) -> Dict[str, Any]:
        binder = _require_binder(binder_id)
        if len(_source_rows(binder_id)) >= 50:
            raise HTTPException(status_code=422, detail="A binder can contain at most 50 sources.")
        raw_body = await request.body()
        if len(raw_body) > _MAX_NOTE_BODY_BYTES:
            raise HTTPException(status_code=413, detail="The text source body is too large.")
        try:
            body = json.loads(raw_body)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="The text source body must be valid JSON.") from exc
        if not isinstance(body, dict):
            raise HTTPException(status_code=422, detail="The text source body must be a JSON object.")
        title = body.get("title")
        text = body.get("text")
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 200:
            raise HTTPException(status_code=422, detail="A note title between 1 and 200 characters is required.")
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= _MAX_NOTE_CHARACTERS:
            raise HTTPException(
                status_code=422,
                detail="Note text must contain between 1 and {} characters.".format(_MAX_NOTE_CHARACTERS),
            )
        title, text = title.strip(), text.strip()
        source_id = _id("src")
        filename = "{}.txt".format(re.sub(r"[^A-Za-z0-9._ -]", "_", title)[:200])
        encoded = text.encode("utf-8")
        record = SourceRecord(
            id=source_id,
            filename=filename,
            content_type="text/plain",
            size=len(encoded),
            text=text,
            labels=["Note"],
            status="ready",
        )
        source = {
            "id": source_id,
            "ownerId": current_owner_id(),
            "binderId": binder_id,
            "displayName": title,
            "originalFilename": filename,
            "contentType": "text/plain",
            "sourceType": "text",
            "pageCount": 1,
            "sizeBytes": len(encoded),
            "status": "ready",
            "extractionMethod": "Plain text",
            "errorMessage": None,
            "uploadedAt": _now(),
            "_record": record.model_dump(),
        }
        _sources[source_id] = source
        await persist("binder_source", source_id, source)
        await invalidate(binder["id"], source_id)
        return _public_source(source)

    @router.post("/binders/{binder_id}/sources", status_code=201)
    async def create_sources(binder_id: str, request: Request) -> Dict[str, Any]:
        binder = _require_binder(binder_id)
        files = (await request.json()).get("files")
        if not isinstance(files, list) or not 1 <= len(files) <= 20:
            raise HTTPException(status_code=422, detail="Provide between 1 and 20 PDF files.")
        if len(_source_rows(binder_id)) + len(files) > 50:
            raise HTTPException(status_code=422, detail="A binder can contain at most 50 sources.")
        created, rejected = [], []
        for item in files:
            filename = str(item.get("fileName", "") if isinstance(item, dict) else "").strip()
            try:
                size = int(item.get("sizeBytes", 0) if isinstance(item, dict) else 0)
            except (TypeError, ValueError):
                size = 0
            reason = None
            if not filename:
                reason = "A file name is required."
            elif not filename.casefold().endswith(".pdf"):
                reason = "Only PDF files are accepted."
            elif size <= 0:
                reason = "That file is empty."
            elif size > max_bytes:
                reason = "That file is over the {} MB limit.".format(settings.max_file_mb)
            if reason:
                rejected.append({"fileName": filename or "(unnamed)", "reason": reason})
                continue
            source_id = _id("src")
            source = {
                "id": source_id,
                "ownerId": current_owner_id(),
                "binderId": binder_id,
                "displayName": re.sub(r"\.pdf$", "", filename, flags=re.IGNORECASE),
                "originalFilename": Path(filename).name,
                "contentType": "application/pdf",
                "sourceType": "pdf",
                "pageCount": 0,
                "sizeBytes": size,
                "status": "pending",
                "extractionMethod": None,
                "errorMessage": None,
                "uploadedAt": _now(),
            }
            _sources[source_id] = source
            await persist("binder_source", source_id, source)
            upload_url = (
                storage.presign_upload(source_id, "application/pdf")[1]
                if storage.ready
                else "/api/binder-uploads/{}".format(source_id)
            )
            created.append({**_public_source(source), "uploadUrl": upload_url})
        if created:
            await save_binder(binder)
        return {"created": created, "rejected": rejected}

    @router.put("/binder-uploads/{source_id}", status_code=204)
    async def upload_source(source_id: str, request: Request) -> Response:
        if storage.ready:
            raise HTTPException(status_code=404, detail="Use the signed S3 upload URL.")
        source = _require_source(source_id)
        content = await request.body()
        if not content or len(content) > max_bytes:
            raise HTTPException(status_code=413, detail="The PDF is empty or exceeds the upload limit.")
        if not content.startswith(b"%PDF-"):
            raise HTTPException(status_code=415, detail="The uploaded bytes are not a PDF.")
        _uploads[source_id] = content
        source["sizeBytes"] = len(content)
        await persist("binder_source", source_id, source)
        return Response(status_code=204)

    @router.post("/binders/{binder_id}/sources/{source_id}/commit")
    async def commit_source(binder_id: str, source_id: str) -> Dict[str, Any]:
        source = _require_source(source_id, binder_id)
        if source["status"] in {"processing", "ready"}:
            return _public_source(source)
        content = await source_bytes(source)
        if not content.startswith(b"%PDF-"):
            raise HTTPException(status_code=415, detail="The uploaded bytes are not a PDF.")
        source.update(status="processing", errorMessage=None)
        await persist("binder_source", source_id, source)
        dispatch_extraction(source_id)
        return _public_source(source)

    @router.post("/binders/{binder_id}/sources/{source_id}/retry")
    async def retry_source(binder_id: str, source_id: str) -> Dict[str, Any]:
        source = _require_source(source_id, binder_id)
        if source["status"] != "failed":
            raise HTTPException(status_code=409, detail="Only a failed source can be retried.")
        await source_bytes(source)
        source.update(status="processing", errorMessage=None)
        await persist("binder_source", source_id, source)
        dispatch_extraction(source_id)
        return _public_source(source)


    @router.get("/sources/{source_id}/status")
    async def source_status(source_id: str) -> Dict[str, Any]:
        source = _require_source(source_id)
        return {
            key: source.get(key)
            for key in ("id", "status", "pageCount", "extractionMethod", "errorMessage")
        }

    @router.patch("/sources/{source_id}")
    async def rename_source(source_id: str, request: Request) -> Dict[str, Any]:
        source = _require_source(source_id)
        display_name = str((await request.json()).get("displayName", "")).strip()
        if not 1 <= len(display_name) <= 200:
            raise HTTPException(status_code=422, detail="A source name between 1 and 200 characters is required.")
        if any(
            job.get("kind") == "binder"
            and job.get("binderId") == source["binderId"]
            and job.get("status") == "running"
            and (not isinstance(job.get("sourceIds"), list) or source_id in job["sourceIds"])
            for job in _jobs.values()
        ):
            raise HTTPException(status_code=409, detail="Wait for generation using this source to finish before renaming it.")
        source["displayName"] = display_name
        await persist("binder_source", source_id, source)
        binder = _require_binder(source["binderId"])
        _rename_source_references(binder, source_id, display_name)
        await save_binder(binder)
        return _public_source(source)

    @router.delete("/sources/{source_id}", status_code=204)
    async def delete_source(source_id: str) -> Response:
        source = _require_source(source_id)
        if source.get("status") == "processing":
            raise HTTPException(status_code=409, detail="Wait for source processing to finish before deleting it.")
        if any(
            job.get("kind") == "binder"
            and job.get("binderId") == source["binderId"]
            and job.get("status") == "running"
            and (not isinstance(job.get("sourceIds"), list) or source_id in job["sourceIds"])
            for job in _jobs.values()
        ):
            raise HTTPException(status_code=409, detail="Wait for generation using this source to finish before deleting it.")
        if storage.ready and source.get("sourceType") != "text":
            try:
                await run_in_threadpool(storage.delete_key, storage.upload_key(source_id))
            except Exception as exc:
                raise HTTPException(status_code=503, detail="Source cleanup failed; retry shortly.") from exc
        await remove("binder_source", source_id)
        _sources.pop(source_id, None)
        _uploads.pop(source_id, None)
        await invalidate(source["binderId"], source_id)
        return Response(status_code=204)

    @router.get("/sources/{source_id}/download")
    async def source_download(source_id: str) -> Dict[str, str]:
        source = _require_source(source_id)
        if source["status"] != "ready":
            raise HTTPException(status_code=409, detail="That source is not ready yet.")
        return {"url": "/api/sources/{}/content".format(source_id)}

    @router.get("/sources/{source_id}/content")
    async def source_content(source_id: str) -> Response:
        source = _require_source(source_id)
        safe_name = re.sub(r"[^A-Za-z0-9._ -]", "_", source["originalFilename"])
        if source.get("sourceType") == "text":
            record = SourceRecord.model_validate(source.get("_record", {}))
            return Response(
                content=record.text.encode("utf-8"),
                media_type="text/plain; charset=utf-8",
                headers={
                    "Content-Disposition": 'inline; filename="{}"'.format(safe_name),
                    "X-Content-Type-Options": "nosniff",
                    "Cache-Control": "private, no-store",
                },
            )
        content = await source_bytes(source)
        return Response(
            content=content,
            media_type="application/pdf",
            headers={
                "Content-Disposition": 'inline; filename="{}"'.format(safe_name),
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, no-store",
            },
        )

    @router.post("/binders/{binder_id}/generate", status_code=202)
    async def generate_binder(binder_id: str, request: Request) -> Dict[str, Any]:
        _require_binder(binder_id)
        raw_body = await request.body()
        if len(raw_body) > 16_384:
            raise HTTPException(status_code=413, detail="The generation request body is too large.")
        requested_source_ids = _parse_generation_source_ids(raw_body)
        if requested_source_ids is None:
            rows = [source for source in _source_rows(binder_id) if source.get("status") == "ready"]
        else:
            rows = [_require_source(source_id, binder_id) for source_id in requested_source_ids]
            if any(source.get("status") != "ready" for source in rows):
                raise HTTPException(status_code=409, detail="Every selected source must be ready before generation.")
        if not rows:
            raise HTTPException(status_code=422, detail="Add at least one processed source before generating a recap.")
        if any(not source.get("_record") for source in rows):
            raise HTTPException(status_code=409, detail="A selected source is not available for generation yet.")
        if any(
            job.get("kind") == "binder" and job.get("binderId") == binder_id and job.get("status") == "running"
            for job in _jobs.values()
        ):
            raise HTTPException(status_code=409, detail="A recap is already being generated for this binder.")
        source_ids = [source["id"] for source in rows]
        selected_sources = _selection(rows)
        job_id = _id("job")
        _jobs[job_id] = {
            "id": job_id,
            "ownerId": current_owner_id(),
            "kind": "binder",
            "binderId": binder_id,
            "sourceIds": list(source_ids),
            "sourceSelection": deepcopy(selected_sources),
            "status": "running",
            "stage": "queued",
            "stageLabel": "Starting binder recap",
            "progress": 0,
            "log": [],
        }
        dispatch_generation(job_id, binder_id, source_ids)
        return {
            "jobId": job_id,
            "binderId": binder_id,
            "sourceIds": source_ids,
            "sourceSelection": selected_sources,
        }

    return router