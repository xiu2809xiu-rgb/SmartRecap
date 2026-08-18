import asyncio
import logging
import secrets
import time
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from pathlib import Path
from typing import List

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from .ai_service import answer_notebook_question, generate_notebook_pack, generate_study_pack
from .binder_api import build_binder_router
from .config import get_settings
from .extractors import ExtractionError, extract_locally, extract_with_azure, extract_with_local_ocr, extract_with_math_ocr, local_ocr_available, math_ocr_available, merge_extracted_text, paddle_ocr_available, validate_file
from .lobbies import store
from .models import HealthResponse, Lobby, LobbyAction, LobbyAnswerAction, LobbyCreate, LobbyJoin, LobbyScoreAction, LobbySession, NotebookChatRequest, NotebookChatResponse, NotebookCreate, NotebookRecord, SourceBatchResponse, SourceRecord, StudyPack
from .notebooks import notebook_store
from .ui_api import build_ui_router

settings = get_settings()
logger = logging.getLogger("smartrecap")
_ocr_process_pool = ProcessPoolExecutor(max_workers=2, mp_context=get_context("spawn"))
app = FastAPI(title="SmartRecap API", version="1.0.0", docs_url="/api/docs", redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins, allow_credentials=False, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["Content-Type", "Authorization"])


@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    extractors = ["PDF", "PPTX", "DOCX", "TXT", "Markdown"]
    if local_ocr_available():
        extractors.append("RapidOCR")
    if paddle_ocr_available() and settings.enable_paddle_ocr:
        extractors.append("PaddleOCR fallback")
    if math_ocr_available() and settings.enable_math_ocr:
        extractors.append("Pix2Text formula/layout OCR")
    if settings.content_understanding_ready:
        extractors.append("Azure Content Understanding")
    if settings.gemini_ready:
        extractors.append("Gemini recap synthesis")
    if settings.azure_ready:
        extractors.append("Azure OpenAI chat")
    if settings.openai_ready:
        extractors.append("OpenAI chat fallback")
    if settings.s3_bucket.strip():
        extractors.append("Amazon S3 object storage")
    if settings.table_name.strip():
        extractors.append("Amazon DynamoDB shared state")
    return HealthResponse(
        status="ok",
        ai_configured=settings.gemini_ready,
        demo_mode=settings.demo_mode or not settings.gemini_ready,
        extractors=extractors,
    )


def _extract_source(content: bytes, filename: str, content_type: str, deep_ocr: bool = False) -> SourceRecord:
    started = time.monotonic()
    suffix = validate_file(content, filename, settings.max_file_mb * 1024 * 1024)
    warnings, text, labels = [], "", []
    native_warning = ""
    try:
        text, labels = extract_locally(content, suffix)
    except ExtractionError as exc:
        native_warning = str(exc)
    try:
        ocr_text, ocr_labels = extract_with_local_ocr(
            content,
            suffix,
            native_text=text,
            deep_scan=deep_ocr,
            max_images=settings.ocr_max_images,
            time_budget_seconds=settings.ocr_time_budget_seconds,
            use_paddle=settings.enable_paddle_ocr,
        )
    except ExtractionError as exc:
        ocr_text, ocr_labels = "", []
        warnings.append(str(exc))
        logger.warning("local OCR failed source=%s error=%s", filename, exc)
    if ocr_text:
        text = merge_extracted_text(text, ocr_text)
        labels = list(dict.fromkeys(labels + ocr_labels))
        warnings.append("Deep local OCR scanned image-based content.")
    elif native_warning and not text.strip():
        warnings.append(native_warning)
    if settings.enable_math_ocr and suffix == ".pdf":
        try:
            math_text, math_labels = extract_with_math_ocr(
                content,
                suffix,
                max_pages=settings.math_ocr_max_pages,
                time_budget_seconds=max(20, settings.ocr_time_budget_seconds // 2),
            )
            if math_text:
                text = merge_extracted_text(text, math_text, math=True)
                labels = list(dict.fromkeys(labels + math_labels))
                warnings.append("Pix2Text recovered Markdown and LaTeX from selected math-heavy pages.")
        except ExtractionError as exc:
            warnings.append(str(exc))
            logger.warning("math OCR failed source=%s error=%s", filename, exc)
    if len(text.strip()) < 100 and not settings.demo_mode and settings.content_understanding_ready:
        try:
            content_key = settings.azure_content_api_key.get_secret_value() or settings.azure_ai_api_key.get_secret_value()
            azure_text, azure_labels = extract_with_azure(
                content,
                content_type,
                settings.azure_content_endpoint,
                content_key,
                settings.azure_content_analyzer_id,
            )
            text, labels = azure_text, azure_labels
            warnings.append("Azure Content Understanding recovered low-text content.")
        except ExtractionError as exc:
            warnings.append(str(exc))
            logger.warning("Azure OCR fallback failed source=%s error=%s", filename, exc)
    if len(text.strip()) < 50:
        detail = " ".join(warnings)
        raise ExtractionError("No reliable text could be extracted from {}. {}".format(filename, detail).strip())
    logger.info("extracted source=%s suffix=%s chars=%s labels=%s seconds=%.2f", filename, suffix, len(text), len(labels), time.monotonic() - started)
    return SourceRecord(id=secrets.token_urlsafe(8), filename=filename, content_type=content_type, size=len(content), text=text, labels=labels or ["Section 1"], warnings=list(dict.fromkeys(warnings)))


async def _extract_source_async(content: bytes, filename: str, content_type: str, deep_ocr: bool) -> SourceRecord:
    loop = asyncio.get_running_loop()
    future = loop.run_in_executor(
        _ocr_process_pool,
        _extract_source,
        content,
        filename or "upload",
        content_type or "application/octet-stream",
        deep_ocr,
    )
    timeout = settings.ocr_time_budget_seconds + 30
    if settings.enable_math_ocr:
        timeout += max(20, settings.ocr_time_budget_seconds // 2)
    return await asyncio.wait_for(future, timeout=timeout)


app.include_router(build_ui_router(_extract_source_async, settings))
app.include_router(build_binder_router(_extract_source_async, settings))


@app.post("/api/recaps", response_model=StudyPack)
async def create_recap(file: UploadFile = File(...), mode: str = Form("cram")) -> StudyPack:
    if mode not in {"cram", "deep"}:
        raise HTTPException(status_code=422, detail="Mode must be cram or deep.")
    content = await file.read(settings.max_file_mb * 1024 * 1024 + 1)
    try:
        source = await _extract_source_async(
            content,
            file.filename or "upload",
            file.content_type or "application/octet-stream",
            mode == "deep",
        )
        pack = await asyncio.wait_for(run_in_threadpool(generate_notebook_pack, [source], Path(file.filename or "Uploaded material").stem, mode, settings), timeout=settings.ai_timeout_seconds + 30)
        pack.warnings = list(dict.fromkeys(pack.warnings + source.warnings))
        return pack
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Document processing exceeded its safety time limit. Try fewer scanned pages.") from exc
    except ExtractionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail="The study pack could not be generated. Check the backend logs and AI configuration.") from exc
    finally:
        await file.close()


@app.get("/api/lobbies", response_model=List[Lobby])
async def list_lobbies() -> List[Lobby]:
    return await store.list_open()


@app.get("/api/lobbies/{lobby_id}", response_model=Lobby)
async def get_lobby(lobby_id: str) -> Lobby:
    return await store.get(lobby_id)


@app.post("/api/lobbies", response_model=LobbySession, status_code=201)
async def create_lobby(request: LobbyCreate) -> LobbySession:
    return await store.create(request)


@app.post("/api/lobbies/{lobby_id}/join", response_model=LobbySession)
async def join_lobby(lobby_id: str, request: LobbyJoin) -> LobbySession:
    return await store.join(lobby_id, request)


@app.post("/api/lobbies/{lobby_id}/ready", response_model=Lobby)
async def ready_lobby(lobby_id: str, request: LobbyAction) -> Lobby:
    return await store.set_ready(lobby_id, request.player_id, request.reconnect_token, request.ready)


@app.post("/api/lobbies/{lobby_id}/start", response_model=Lobby)
async def start_lobby(lobby_id: str, request: LobbyAction) -> Lobby:
    return await store.start(lobby_id, request.player_id, request.reconnect_token)


@app.post("/api/lobbies/{lobby_id}/answer", response_model=Lobby)
async def submit_lobby_answer(lobby_id: str, request: LobbyAnswerAction) -> Lobby:
    return await store.submit_answer(lobby_id, request)


@app.post("/api/lobbies/{lobby_id}/score", response_model=Lobby)
async def submit_lobby_score(lobby_id: str, request: LobbyScoreAction) -> Lobby:
    return await store.submit_score(lobby_id, request)


@app.websocket("/ws/lobbies/{lobby_id}")
async def lobby_socket(websocket: WebSocket, lobby_id: str, player_id: str, token: str) -> None:
    if not await store.connect(lobby_id, player_id, token, websocket):
        return
    try:
        while True:
            await websocket.receive_text()
    except (WebSocketDisconnect, RuntimeError):
        store.disconnect(lobby_id, websocket)


@app.post("/api/notebooks", response_model=NotebookRecord, status_code=201)
async def create_notebook(request: NotebookCreate) -> NotebookRecord:
    return await notebook_store.create(request)


@app.get("/api/notebooks", response_model=List[NotebookRecord])
async def list_notebooks() -> List[NotebookRecord]:
    return await notebook_store.list()


@app.get("/api/notebooks/{notebook_id}", response_model=NotebookRecord)
async def get_notebook(notebook_id: str) -> NotebookRecord:
    return await notebook_store.get(notebook_id)


@app.post("/api/notebooks/{notebook_id}/sources", response_model=SourceBatchResponse)
async def add_notebook_sources(notebook_id: str, files: List[UploadFile] = File(...)) -> SourceBatchResponse:
    if not files or len(files) > 20:
        raise HTTPException(status_code=422, detail="Upload between 1 and 20 files at a time.")
    notebook = await notebook_store.get(notebook_id)
    existing = await notebook_store.source_records(notebook_id)
    if len(existing) + len(files) > 20:
        raise HTTPException(status_code=422, detail="A notebook can contain up to 20 sources.")
    sources, errors = [], []
    total = sum(source.size for source in existing)
    try:
        for upload in files:
            content = await upload.read(settings.max_file_mb * 1024 * 1024 + 1)
            total += len(content)
            if total > settings.max_file_mb * 3 * 1024 * 1024:
                errors.append("Notebook storage limit exceeded; remaining files were skipped.")
                break
            try:
                source = await _extract_source_async(
                    content,
                    upload.filename or "upload",
                    upload.content_type or "application/octet-stream",
                    notebook.mode == "deep",
                )
                sources.append(source)
            except asyncio.TimeoutError:
                errors.append("{}: OCR exceeded the per-file safety time limit.".format(upload.filename or "file"))
            except ExtractionError as exc:
                errors.append("{}: {}".format(upload.filename or "file", exc))
    finally:
        for upload in files:
            await upload.close()
    if not sources:
        raise HTTPException(status_code=422, detail=" ".join(errors) or "No sources could be processed.")
    updated_notebook = await notebook_store.add_sources(notebook_id, sources)
    added_ids = {source.id for source in sources}
    return SourceBatchResponse(notebook=updated_notebook, added=[source for source in updated_notebook.sources if source.id in added_ids], errors=errors)


@app.post("/api/notebooks/{notebook_id}/recap", response_model=StudyPack)
async def generate_notebook_recap(notebook_id: str) -> StudyPack:
    notebook = await notebook_store.get(notebook_id)
    sources = await notebook_store.source_records(notebook_id)
    if not sources:
        raise HTTPException(status_code=422, detail="Add at least one readable source first.")
    try:
        pack = await asyncio.wait_for(run_in_threadpool(generate_notebook_pack, sources, notebook.title, notebook.mode, settings), timeout=settings.ai_timeout_seconds + 30)
        await notebook_store.save_recap(notebook_id, pack)
        return pack
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Study-pack synthesis exceeded its safety time limit. Your extracted sources are preserved; retry generation.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Notebook synthesis failed. Check AI configuration and backend logs.") from exc


@app.post("/api/notebooks/{notebook_id}/chat", response_model=NotebookChatResponse)
async def chat_with_notebook(notebook_id: str, request: NotebookChatRequest) -> NotebookChatResponse:
    sources = await notebook_store.source_records(notebook_id)
    if not sources:
        raise HTTPException(status_code=422, detail="This notebook has no readable sources.")
    try:
        return await asyncio.wait_for(run_in_threadpool(answer_notebook_question, sources, request.question, settings), timeout=settings.ai_timeout_seconds + 30)
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="The notebook answer exceeded its safety time limit.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail="The notebook question could not be answered.") from exc