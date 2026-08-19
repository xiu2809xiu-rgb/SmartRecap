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
    """Task-safe notebook storage explicitly partitioned by authenticated owner."""

    def __init__(self) -> None:
        self._notebooks: Dict[str, Dict[str, NotebookRecord]] = {}
        self._sources: Dict[str, Dict[str, List[SourceRecord]]] = {}
        self._lock = asyncio.Lock()

    def _owner_notebooks(self, owner_id: str) -> Dict[str, NotebookRecord]:
        return self._notebooks.setdefault(owner_id, {})

    def _owner_sources(self, owner_id: str) -> Dict[str, List[SourceRecord]]:
        return self._sources.setdefault(owner_id, {})

    async def create(self, owner_id: str, request: NotebookCreate) -> NotebookRecord:
        async with self._lock:
            notebook_id, now = secrets.token_urlsafe(12), _now()
            notebook = NotebookRecord(id=notebook_id, title=request.title.strip(), mode=request.mode, created_at=now, updated_at=now)
            self._owner_notebooks(owner_id)[notebook_id] = notebook
            self._owner_sources(owner_id)[notebook_id] = []
            return notebook.model_copy(deep=True)

    async def list(self, owner_id: str) -> List[NotebookRecord]:
        values = self._owner_notebooks(owner_id).values()
        return [item.model_copy(deep=True) for item in sorted(values, key=lambda row: row.updated_at, reverse=True)]

    async def get(self, owner_id: str, notebook_id: str) -> NotebookRecord:
        notebook = self._owner_notebooks(owner_id).get(notebook_id)
        if not notebook:
            raise HTTPException(status_code=404, detail="Notebook not found.")
        return notebook.model_copy(deep=True)

    async def source_records(self, owner_id: str, notebook_id: str) -> List[SourceRecord]:
        await self.get(owner_id, notebook_id)
        return [item.model_copy(deep=True) for item in self._owner_sources(owner_id)[notebook_id]]

    async def add_sources(self, owner_id: str, notebook_id: str, sources: List[SourceRecord]) -> NotebookRecord:
        async with self._lock:
            notebook = self._owner_notebooks(owner_id).get(notebook_id)
            if not notebook:
                raise HTTPException(status_code=404, detail="Notebook not found.")
            records = self._owner_sources(owner_id).setdefault(notebook_id, [])
            records.extend(sources)
            notebook.sources = [_summary(item) for item in records]
            notebook.latest_recap = None
            notebook.updated_at = _now()
            return notebook.model_copy(deep=True)

    async def save_recap(self, owner_id: str, notebook_id: str, recap: StudyPack) -> NotebookRecord:
        async with self._lock:
            notebook = self._owner_notebooks(owner_id).get(notebook_id)
            if not notebook:
                raise HTTPException(status_code=404, detail="Notebook not found.")
            notebook.latest_recap = recap
            notebook.updated_at = _now()
            return notebook.model_copy(deep=True)


notebook_store = NotebookStore()
