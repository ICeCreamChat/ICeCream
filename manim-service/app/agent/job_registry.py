"""Local job registry for Manim agent runs.

This is intentionally lightweight: one JSON file plus an in-process lock. It
gives the gateway and frontend a stable job id, status lookup, cancellation,
and recent history without adding Redis or a worker service.
"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import service_config


_LOCK = threading.RLock()
_JOBS: dict[str, dict[str, Any]] | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _path() -> Path:
    return Path(service_config.get_manim_agent_jobs_file())


def _load() -> dict[str, dict[str, Any]]:
    global _JOBS
    if _JOBS is not None:
        return _JOBS
    path = _path()
    if not path.exists():
        _JOBS = {}
        return _JOBS
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    _JOBS = data if isinstance(data, dict) else {}
    return _JOBS


def _save() -> None:
    if _JOBS is None:
        return
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    compact = dict(sorted(_JOBS.items(), key=lambda item: item[1].get("updatedAt", ""), reverse=True)[:100])
    path.write_text(json.dumps(compact, ensure_ascii=False, indent=2), encoding="utf-8")


def create_job(payload: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        jobs = _load()
        job_id = str(payload.get("jobId") or uuid.uuid4().hex[:12])
        job = jobs.get(job_id) or {
            "jobId": job_id,
            "createdAt": _now(),
            "events": [],
            "renderClientIds": [],
        }
        job.update({
            "status": "queued",
            "currentStage": "queued",
            "summary": "任务已创建",
            "message": str(payload.get("message") or "")[:500],
            "mode": str(payload.get("mode") or "create"),
            "clientId": str(payload.get("clientId") or "agent")[:80],
            "updatedAt": _now(),
            "cancelRequested": False,
        })
        jobs[job_id] = job
        _save()
        return dict(job)


def update_job(job_id: str, *, status: str | None = None, current_stage: str | None = None, summary: str | None = None, event: dict[str, Any] | None = None) -> dict[str, Any]:
    with _LOCK:
        jobs = _load()
        job = jobs.get(job_id)
        if not job:
            return {}
        if status:
            job["status"] = status
        if current_stage:
            job["currentStage"] = current_stage
        if summary:
            job["summary"] = summary
        if event:
            events = list(job.get("events") or [])
            events.append({
                "at": _now(),
                "type": event.get("type"),
                "stage": event.get("step") or event.get("stage") or current_stage,
                "summary": event.get("message") or event.get("summary") or summary,
            })
            job["events"] = events[-80:]
        job["updatedAt"] = _now()
        _save()
        return dict(job)


def register_render_client(job_id: str, client_id: str) -> None:
    if not job_id or not client_id:
        return
    with _LOCK:
        jobs = _load()
        job = jobs.get(job_id)
        if not job:
            return
        client_ids = list(job.get("renderClientIds") or [])
        if client_id not in client_ids:
            client_ids.append(client_id)
        job["renderClientIds"] = client_ids[-16:]
        job["updatedAt"] = _now()
        _save()


def get_job(job_id: str) -> dict[str, Any] | None:
    with _LOCK:
        job = _load().get(job_id)
        return dict(job) if job else None


def list_jobs(limit: int = 30) -> list[dict[str, Any]]:
    with _LOCK:
        jobs = sorted(_load().values(), key=lambda item: item.get("updatedAt", ""), reverse=True)
        return [dict(job) for job in jobs[: max(1, min(limit, 100))]]


def is_cancelled(job_id: str) -> bool:
    job = get_job(job_id)
    return bool(job and job.get("cancelRequested"))


def cancel_job(job_id: str) -> dict[str, Any]:
    with _LOCK:
        jobs = _load()
        job = jobs.get(job_id)
        if not job:
            return {"success": False, "error": "未找到 Manim 任务"}
        job["cancelRequested"] = True
        job["status"] = "cancelled"
        job["summary"] = "任务已取消"
        job["updatedAt"] = _now()
        render_client_ids = list(job.get("renderClientIds") or [])
        _save()

    killed: list[str] = []
    try:
        from .renderer import cancel_render_client

        for client_id in render_client_ids:
            if cancel_render_client(client_id):
                killed.append(client_id)
    except Exception:
        pass

    return {"success": True, "job": get_job(job_id), "cancelledRenderClients": killed}
