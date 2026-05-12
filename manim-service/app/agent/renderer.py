"""Renderer adapter for the Manim runtime agent."""

from __future__ import annotations

import importlib
import json
import sys
from typing import Any


def _render_module():
    """Prefer the currently running root service, otherwise use the package app."""
    root_main = sys.modules.get("main")
    if root_main and hasattr(root_main, "RenderRequest") and hasattr(root_main, "http_render_code"):
        return root_main
    return importlib.import_module("app.legacy_main")


async def render_code_for_agent(code: str, client_id: str = "agent") -> dict[str, Any]:
    """Render code through the existing legacy HTTP render implementation."""
    legacy_main = _render_module()
    request = legacy_main.RenderRequest(code=code, client_id=client_id)
    response = await legacy_main.http_render_code(
        request,
        x_manim_service_token=legacy_main.MANIM_SERVICE_TOKEN or None,
    )

    status_code = getattr(response, "status_code", 200)
    raw_body = getattr(response, "body", b"{}")
    if isinstance(raw_body, bytes):
        body = json.loads(raw_body.decode("utf-8") or "{}")
    else:
        body = raw_body

    if status_code >= 400 or not body.get("success", status_code < 400):
        return {
            "success": False,
            "error": body.get("error") or "Manim render failed",
            "details": body.get("details") or body.get("error") or "",
        }

    return {
        "success": True,
        "videoUrl": body.get("videoUrl"),
        "videoBase64": body.get("videoBase64"),
        "warning": body.get("warning"),
    }
