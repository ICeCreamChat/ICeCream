"""Small file-backed render cache for successful Manim agent videos."""

from __future__ import annotations

import hashlib
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import service_config


_LOCK = threading.RLock()


def cache_key_for_code(code: str) -> str:
    return hashlib.sha256((code or "").encode("utf-8")).hexdigest()[:24]


def _path() -> Path:
    return Path(service_config.get_manim_agent_render_cache_path())


def _load() -> dict[str, Any]:
    path = _path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _save(data: dict[str, Any]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get_cached_render(code: str) -> dict[str, Any] | None:
    key = cache_key_for_code(code)
    with _LOCK:
        item = _load().get(key)
    if not isinstance(item, dict):
        return None
    video_url = item.get("videoUrl")
    if not video_url:
        return None
    return {**item, "cacheKey": key, "cached": True}


def save_cached_render(code: str, render_result: dict[str, Any], *, trace: dict[str, Any] | None = None) -> dict[str, Any]:
    key = cache_key_for_code(code)
    item = {
        "cacheKey": key,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "videoUrl": render_result.get("videoUrl"),
        "videoBase64": render_result.get("videoBase64"),
        "sceneName": render_result.get("sceneName"),
        "requestId": render_result.get("requestId"),
        "traceSummary": {
            "semanticTarget": (trace or {}).get("semanticTarget"),
            "codeSource": (trace or {}).get("codeSource"),
            "repairCount": ((trace or {}).get("repairs") or {}).get("count"),
        },
    }
    with _LOCK:
        data = _load()
        data[key] = item
        if len(data) > 200:
            data = dict(sorted(data.items(), key=lambda pair: pair[1].get("createdAt", ""), reverse=True)[:200])
        _save(data)
    return item
