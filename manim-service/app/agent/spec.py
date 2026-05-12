"""Structured animation spec helpers for the Manim agent."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class AnimationSpec:
    """Decision-complete brief used by skills, codegen, and quality checks."""

    kind: str
    topic: str
    learning_goal: str
    teaching_steps: list[str]
    objects: list[str] = field(default_factory=list)
    function: str = ""
    coordinate_system: str = "none"
    tick_policy: str = "simple"
    layout: dict[str, Any] = field(default_factory=dict)
    style: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def default_spec(topic: str) -> AnimationSpec:
    return AnimationSpec(
        kind="concept",
        topic=topic or "概念讲解",
        learning_goal="用清晰分步动画解释核心概念。",
        teaching_steps=["提出主题", "构建主要可视元素", "强调结论"],
        objects=["title", "steps", "summary"],
        layout={"frame": "16:9", "safe_margin": 0.7, "max_text_lines": 5},
        style={"background": "dark", "contrast": "high"},
    )


def function_graph_spec(topic: str, function_name: str = "sin") -> AnimationSpec:
    function_label = "正弦函数" if function_name == "sin" else "余弦函数"
    return AnimationSpec(
        kind="function_graph",
        topic=topic or function_label,
        learning_goal=f"分步骤讲解{function_label}的图像、关键点和周期规律。",
        teaching_steps=[
            "建立带符号刻度的坐标系",
            f"绘制 {function_label} 曲线",
            "标注零点、峰值和谷值",
            "总结周期、振幅和取值范围",
        ],
        objects=["title", "axes", "graph", "key_points", "formula", "summary"],
        function=function_name,
        coordinate_system="cartesian",
        tick_policy="symbolic_pi",
        layout={"frame": "16:9", "safe_margin": 0.75, "axes_width": 8.6, "axes_height": 4.2},
        style={"background": "dark", "contrast": "high", "accent": "cyan"},
    )
