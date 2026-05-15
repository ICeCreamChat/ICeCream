"""Reference-image storage for Manim generation requests."""

from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image

from app import service_config


ALLOWED_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
}


def _root() -> Path:
    path = Path(service_config.get_manim_reference_dir())
    path.mkdir(parents=True, exist_ok=True)
    return path


def _index_path() -> Path:
    return _root() / "index.json"


def _load_index() -> dict[str, Any]:
    path = _index_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_index(data: dict[str, Any]) -> None:
    _index_path().write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _safe_filename(name: str) -> str:
    value = "".join(ch if ch.isalnum() or ch in ".-_" else "_" for ch in (name or "reference"))
    return value[:80] or "reference"


def save_reference_image(*, filename: str, mime_type: str, data_base64: str) -> dict[str, Any]:
    mime = (mime_type or "").lower()
    if mime not in ALLOWED_MIME:
        return {"success": False, "error": "只支持 PNG、JPG 或 WEBP 图片"}
    try:
        raw = base64.b64decode(data_base64, validate=True)
    except Exception:
        return {"success": False, "error": "图片数据无法解析"}
    max_bytes = service_config.get_manim_reference_max_bytes()
    if len(raw) > max_bytes:
        return {"success": False, "error": f"图片过大，最大允许 {max_bytes // (1024 * 1024)} MB"}

    reference_id = uuid.uuid4().hex[:16]
    ext = ALLOWED_MIME[mime]
    safe_name = _safe_filename(filename)
    path = _root() / f"{reference_id}_{safe_name}{ext if not safe_name.lower().endswith(ext) else ''}"
    path.write_bytes(raw)

    try:
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            width, height = image.size
    except Exception:
        path.unlink(missing_ok=True)
        return {"success": False, "error": "图片格式校验失败"}

    item = {
        "referenceId": reference_id,
        "filename": safe_name,
        "mimeType": mime,
        "size": len(raw),
        "width": width,
        "height": height,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "path": str(path),
    }
    index = _load_index()
    index[reference_id] = item
    _save_index(index)
    public_item = {key: value for key, value in item.items() if key != "path"}
    return {"success": True, "reference": public_item}


def get_reference(reference_id: str) -> dict[str, Any] | None:
    item = _load_index().get(reference_id)
    if not isinstance(item, dict):
        return None
    public_item = {key: value for key, value in item.items() if key != "path"}
    return public_item


def get_reference_record(reference_id: str) -> dict[str, Any] | None:
    """Return a private reference record for internal agent use only."""
    item = _load_index().get(reference_id)
    if not isinstance(item, dict):
        return None

    root = _root().resolve()
    try:
        path = Path(str(item.get("path") or "")).resolve()
    except OSError:
        return None
    if root not in path.parents and path != root:
        return None
    if not path.is_file():
        return None
    return {**item, "path": str(path)}


def resolve_references(reference_ids: list[str] | None) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for reference_id in reference_ids or []:
        item = get_reference(str(reference_id))
        if item:
            result.append(item)
    return result


def resolve_reference_records(reference_ids: list[str] | None) -> list[dict[str, Any]]:
    """Resolve references with private paths for trusted local analysis."""
    result: list[dict[str, Any]] = []
    for reference_id in reference_ids or []:
        item = get_reference_record(str(reference_id))
        if item:
            result.append(item)
    return result
