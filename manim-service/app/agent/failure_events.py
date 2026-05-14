"""Local JSONL failure-event logging for Manim agent regressions."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import service_config


PATH_RE = re.compile(r"[A-Za-z]:\\[^\s\n]+|/(?:[^/\s]+/)+[^/\s]+")
SECRET_RE = re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+|sk-[A-Za-z0-9_-]{8,}")


def _enabled() -> bool:
    return service_config.is_manim_agent_failure_log_enabled()


def _log_path() -> Path:
    return Path(service_config.get_manim_agent_failure_log_path())


def _clean_text(value: Any, *, max_length: int = 1600) -> str:
    text = str(value or "")
    text = PATH_RE.sub("<本地路径>", text)
    text = SECRET_RE.sub("<已隐藏>", text)
    return text[-max_length:]


def record_failure_event(
    result: dict[str, Any],
    *,
    code: str = "",
    stage: str = "agent_result",
) -> str:
    """Append a compact failure sample and return its event id.

    The log intentionally stores a short code snippet and sanitized summaries,
    enough for regression analysis without leaking local paths or secrets.
    """
    if not _enabled():
        return ""

    event_id = uuid.uuid4().hex[:12]
    trace = result.get("agentTrace") or {}
    quality = trace.get("quality") or {}
    repairs = trace.get("repairs") or {}
    event = {
        "id": event_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "stage": stage,
        "jobId": trace.get("jobId"),
        "rendered": bool(result.get("rendered")),
        "warning": _clean_text(result.get("warning") or result.get("error")),
        "rulePackVersion": trace.get("rulePackVersion"),
        "promptPackVersion": trace.get("promptPackVersion"),
        "apiIndexVersion": trace.get("apiIndexVersion"),
        "semanticTarget": trace.get("semanticTarget"),
        "message": _clean_text((trace.get("brief") or {}).get("message")),
        "failureReason": _clean_text(trace.get("failureReason")),
        "qualityStatus": quality.get("status"),
        "qualitySummary": _clean_text(quality.get("summary")),
        "visualStatus": (quality.get("visual") or {}).get("status") if isinstance(quality, dict) else None,
        "visualMetrics": (quality.get("visual") or {}).get("metrics") if isinstance(quality, dict) else None,
        "repairCount": repairs.get("count"),
        "repairRules": repairs.get("rules") or trace.get("repairRules") or [],
        "codeLength": len(code or ""),
        "codeSnippet": _clean_text((code or "")[:4000], max_length=4000),
    }

    try:
        path = _log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")
    except OSError:
        return ""
    return event_id


def load_failure_events(*, path: str | Path | None = None, limit: int = 100) -> list[dict[str, Any]]:
    """Load recent failure events for offline regression replay."""
    source = Path(path) if path else _log_path()
    if not source.exists():
        return []

    events: list[dict[str, Any]] = []
    for line in source.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    if limit <= 0:
        return events
    return events[-limit:]
