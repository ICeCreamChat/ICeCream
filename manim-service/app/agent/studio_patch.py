"""Studio-style patch planning for CodePanel modification requests."""

from __future__ import annotations

import ast
from typing import Any


def build_patch_plan(message: str, current_code: str) -> dict[str, Any]:
    """Return a lightweight patch plan before LLM code modification.

    The actual code writer still produces the revised file, but this event makes
    the process explainable and gives future implementations a stable hook for
    diff-first editing.
    """
    steps: list[str] = []
    scene_classes: list[str] = []
    parse_status = "pass"
    try:
        tree = ast.parse(current_code or "")
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                if any(getattr(base, "id", "") == "Scene" or getattr(base, "attr", "") == "Scene" for base in node.bases):
                    scene_classes.append(node.name)
    except SyntaxError:
        parse_status = "warning"

    if current_code.strip():
        steps.append("分析当前 MainScene 结构和已有对象")
    if "颜色" in message or "红" in message or "蓝" in message:
        steps.append("定位需要调整颜色的主要图形对象")
    if "标签" in message or "文字" in message or "半径" in message:
        steps.append("新增或更新可读文字标签")
    steps.append("生成最小可运行修改，并重新执行静态与视觉检查")

    return {
        "status": parse_status,
        "summary": "已生成代码修改计划",
        "intent": message,
        "sceneClasses": scene_classes,
        "steps": steps,
    }
