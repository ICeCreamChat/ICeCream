"""Compatibility adapter for Manim Agent v6 code generation."""

from __future__ import annotations

from typing import Any

from .code_writer import analyze_current_code, extract_code_from_text, write_scene_code
from .style_director import select_style


async def generate_code(
    brief: dict[str, Any],
    skills: list[dict[str, str]],
    current_code: str = "",
    ai_client: Any | None = None,
    model_name: str | None = None,
    storyboard_spec: dict[str, Any] | None = None,
    style_preset: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Generate Manim code through the v6 LLM writer.

    This function intentionally does not fall back to full-scene templates.
    """
    style = style_preset or select_style(storyboard_spec).get("stylePreset", {})
    spec = storyboard_spec or brief.get("storyboardSpec") or brief.get("spec") or {}
    result = await write_scene_code(
        brief,
        spec,
        style,
        skills,
        ai_client=ai_client,
        model_name=model_name,
        current_code=current_code,
    )
    return {
        "code": result.get("code", ""),
        "source": result.get("source", "llm_v6"),
        "codeSource": result.get("codeSource", "llm_v6"),
        "template": "none",
        "status": result.get("status", "error"),
        "warning": None if result.get("status") == "success" else result.get("summary"),
        "analysis": result.get("analysis", {}),
        "summary": result.get("summary", ""),
        "next_actions": result.get("next_actions", []),
    }
