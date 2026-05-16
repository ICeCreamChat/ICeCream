"""JSON serialization helpers for Manim agent API boundaries."""

from __future__ import annotations

from pathlib import Path
from typing import Any

try:  # numpy is available in the Manim service, but keep this import optional.
    import numpy as np
except Exception:  # pragma: no cover - defensive for stripped test envs
    np = None  # type: ignore[assignment]


def to_json_safe(value: Any) -> Any:
    """Return a recursively JSON-serializable representation of ``value``.

    Visual inspection code commonly emits numpy scalar types. Python's stdlib
    ``json`` cannot serialize those values, so every public agent response and
    NDJSON event passes through this small boundary sanitizer.
    """
    if value is None or isinstance(value, (str, int, float, bool)):
        return value

    if np is not None:
        if isinstance(value, np.generic):
            return value.item()
        if isinstance(value, np.ndarray):
            return [to_json_safe(item) for item in value.tolist()]

    if isinstance(value, Path):
        return value.as_posix()

    if hasattr(value, "model_dump"):
        return to_json_safe(value.model_dump())

    if isinstance(value, dict):
        return {str(to_json_safe(key)): to_json_safe(item) for key, item in value.items()}

    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_json_safe(item) for item in value]

    return str(value)
