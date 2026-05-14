"""Style selection for Manim Agent v6."""

from __future__ import annotations

from typing import Any


TEACHING_PREMIUM = {
    "id": "teaching_premium",
    "name": "精品教学风格",
    "background": "#F7FBFF",
    "text": "#1D2530",
    "muted": "#64748B",
    "primary": "#0284C7",
    "accent": "#F59E0B",
    "success": "#16A34A",
    "danger": "#DC2626",
    "fontPolicy": "中文标签使用 Text，公式只使用 MathTex。",
    "motionPolicy": "分阶段呈现、适当停顿，避免过度镜头运动。",
    "layoutPolicy": "标题、步骤、主体图像和总结分区放置；使用整张浅色画布，不使用内嵌白卡。",
}


def select_style(storyboard_spec: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "status": "success",
        "summary": "已确定精品教学风格。",
        "stylePreset": dict(TEACHING_PREMIUM),
        "next_actions": ["按所选风格生成 Manim 场景代码。"],
    }
