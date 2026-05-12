"""Style selection for Manim Agent v4."""

from __future__ import annotations

from typing import Any


TEACHING_PREMIUM = {
    "id": "teaching_premium",
    "background": "#F7FBFF",
    "text": "#1D2530",
    "muted": "#64748B",
    "primary": "#0284C7",
    "accent": "#F59E0B",
    "success": "#16A34A",
    "danger": "#DC2626",
    "fontPolicy": "Use Text for Chinese labels and MathTex only for formulas.",
    "motionPolicy": "Use staged reveals, transforms, and short pauses; avoid excessive camera motion.",
    "layoutPolicy": "Reserve top for title, upper-left for step banner, center for visual, bottom for summary.",
}


def select_style(storyboard_spec: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "status": "success",
        "summary": "Selected premium teaching style.",
        "stylePreset": dict(TEACHING_PREMIUM),
        "next_actions": ["Generate code using the selected teaching style."],
    }

