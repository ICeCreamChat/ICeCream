"""Renderer adapter for the Manim runtime agent."""

from __future__ import annotations

import importlib
import json
import re
import sys
from typing import Any


def _render_module():
    """Prefer the currently running root service, otherwise use the package app."""
    root_main = sys.modules.get("main")
    if root_main and hasattr(root_main, "RenderRequest") and hasattr(root_main, "http_render_code"):
        return root_main
    return importlib.import_module("app.legacy_main")


def sanitize_render_error(text: Any, max_length: int = 1200) -> str:
    """Return a short user-safe render error while preserving the root cause."""
    value = str(text or "").replace("\r\n", "\n").strip()
    if not value:
        return ""
    value = re.sub(r"[A-Za-z]:\\[^\s\n]+", "<本地路径>", value)
    value = re.sub(r"/(?:[^/\s]+/)+[^/\s]+", "<本地路径>", value)
    value = re.sub(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+", r"\1=<已隐藏>", value)
    value = re.sub(r"sk-[A-Za-z0-9_-]{8,}", "<已隐藏密钥>", value)

    lines = [line.strip() for line in value.splitlines() if line.strip()]
    important_re = re.compile(
        r"(Traceback|Error|Exception|AttributeError|TypeError|ValueError|NameError|SyntaxError|LaTeX|TeX|File\s+)",
        re.IGNORECASE,
    )
    important = [line for line in lines if important_re.search(line)]
    if important:
        value = "\n".join(important[-24:])
    return value[-max_length:]


async def render_code_for_agent(code: str, client_id: str = "agent", stage: str = "render") -> dict[str, Any]:
    """Render code through the existing legacy HTTP render implementation."""
    legacy_main = _render_module()
    request = legacy_main.RenderRequest(code=code, client_id=client_id)
    response = await legacy_main.http_render_code(
        request,
        x_manim_service_token=legacy_main.MANIM_SERVICE_TOKEN or None,
    )

    status_code = getattr(response, "status_code", 200)
    raw_body = getattr(response, "body", b"{}")
    try:
        if isinstance(raw_body, bytes):
            body = json.loads(raw_body.decode("utf-8") or "{}")
        else:
            body = raw_body
    except Exception as exc:
        body = {
            "success": False,
            "error": f"渲染服务返回了无法解析的响应：{exc}",
            "errorType": "invalid_render_response",
        }

    if status_code >= 400 or not body.get("success", status_code < 400):
        details = sanitize_render_error(
            body.get("details") or body.get("stderr") or body.get("error") or "Manim 渲染失败"
        )
        return {
            "success": False,
            "error": details or "Manim 渲染失败",
            "details": details,
            "stderr": details,
            "errorType": body.get("errorType") or "manim_render_failed",
            "requestId": body.get("requestId"),
            "sceneName": body.get("sceneName"),
            "clientId": client_id,
            "stage": stage,
        }

    return {
        "success": True,
        "videoUrl": body.get("videoUrl"),
        "videoBase64": body.get("videoBase64"),
        "warning": body.get("warning"),
        "requestId": body.get("requestId"),
        "sceneName": body.get("sceneName"),
        "clientId": client_id,
        "stage": stage,
    }
