import asyncio
import secrets
from datetime import datetime, timezone
from typing import Dict, List

from fastapi import HTTPException

from .models import NotebookCreate, NotebookRecord, SourceRecord, SourceSummary, StudyPack


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _summary(source: SourceRecord) -> SourceSummary:
    return SourceSummary(**source.model_dump(exclude={"text"}))


class NotebookStore:
    def __init__(self) -> None:
        self._notebooks: Dict[str, NotebookRecord] = {}
        self._sources: Dict[str, List[SourceRecord]] = {}
        self._lock = asyncio.Lock()

    async def create(self, request: NotebookCreate) -> NotebookRecord:
        async with self._lock:
            notebook_id, now = secrets.token_urlsafe(7), _now()
            notebook = NotebookRecord(id=notebook_id, title=request.title.strip(), mode=request.mode, created_at=now, updated_at=now)
            self._notebooks[notebook_id] = notebook
            self._sources[notebook_id] = []
            return notebook.model_copy(deep=True)

    async def list(self) -> List[NotebookRecord]:
        return [item.model_copy(deep=True) for item in sorted(self._notebooks.values(), key=lambda row: row.updated_at, reverse=True)]

    async def get(self, notebook_id: str) -> NotebookRecord:
        notebook = self._notebooks.get(notebook_id)
        if not notebook:
            raise HTTPException(status_code=404, detail="Notebook not found.")
        return notebook.model_copy(deep=True)

    async def source_records(self, notebook_id: str) -> List[SourceRecord]:
        await self.get(notebook_id)
        return [item.model_copy(deep=True) for item in self._sources[notebook_id]]

    async def add_sources(self, notebook_id: str, sources: List[SourceRecord]) -> NotebookRecord:
        async with self._lock:
            notebook = self._notebooks.get(notebook_id)
            if not notebook:
                raise HTTPException(status_code=404, detail="Notebook not found.")
            self._sources[notebook_id].extend(sources)
            notebook.sources = [_summary(item) for item in self._sources[notebook_id]]
            notebook.latest_recap = None
            notebook.updated_at = _now()
            return notebook.model_copy(deep=True)

    async def save_recap(self, notebook_id: str, recap: StudyPack) -> NotebookRecord:
        async with self._lock:
            notebook = self._notebooks.get(notebook_id)
            if not notebook:
                raise HTTPException(status_code=404, detail="Notebook not found.")
            notebook.latest_recap = recap
            notebook.updated_at = _now()
            return notebook.model_copy(deep=True)


notebook_store = NotebookStore()