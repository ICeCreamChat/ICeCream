"""Backward-compatible wrapper around the v5 visual judge."""

from __future__ import annotations

from typing import Any

from .visual_judge import inspect_visual_quality


def inspect_preview_quality(
    code: str,
    brief: dict[str, Any] | None = None,
    render_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return inspect_visual_quality(code, brief, render_result)
