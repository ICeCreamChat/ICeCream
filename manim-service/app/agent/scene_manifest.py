"""Build a lightweight editable-object manifest from generated Manim code.

The video remains the preview artifact, while Python code remains the source of
truth.  This manifest gives the frontend stable object IDs and safe edit
affordances without trying to reverse-engineer pixels from the rendered MP4.
"""

from __future__ import annotations

import ast
from typing import Any


MANIFEST_VERSION = "scene-manifest-v1"

EDITABLE_TYPES: dict[str, list[str]] = {
    "Text": ["replace_text", "move", "set_color", "scale", "delete"],
    "SafeText": ["replace_text", "move", "set_color", "scale", "delete"],
    "Tex": ["replace_text", "move", "set_color", "scale", "delete"],
    "MathTex": ["replace_text", "move", "set_color", "scale", "delete"],
    "SafeMathTex": ["replace_text", "move", "set_color", "scale", "delete"],
    "Circle": ["move", "set_color", "scale", "delete"],
    "Square": ["move", "set_color", "scale", "delete"],
    "Triangle": ["move", "set_color", "scale", "delete"],
    "Rectangle": ["move", "set_color", "scale", "delete"],
    "Polygon": ["move", "set_color", "scale", "delete"],
    "Line": ["move", "set_color", "scale", "delete"],
    "Arrow": ["move", "set_color", "scale", "delete"],
    "Dot": ["move", "set_color", "scale", "delete"],
    "VGroup": ["move", "scale", "delete"],
    "Axes": ["move", "scale", "delete"],
}


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def _first_literal_string(call: ast.Call) -> str:
    for arg in call.args:
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            return arg.value
    return ""


def _stage_list(brief: dict[str, Any] | None) -> list[dict[str, str]]:
    brief = brief or {}
    spec = brief.get("storyboardSpec") or brief.get("spec") or {}
    stages = []
    for index, shot in enumerate(spec.get("shots") or [], start=1):
        stage_id = str(shot.get("id") or f"stage_{index}")
        stages.append({"id": stage_id, "title": str(shot.get("title") or f"阶段 {index}")})
    return stages or [{"id": "stage_1", "title": "主场景"}]


def _object_from_assignment(node: ast.Assign, stage_id: str) -> dict[str, Any] | None:
    if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
        return None
    if not isinstance(node.value, ast.Call):
        return None

    object_id = node.targets[0].id
    object_type = _call_name(node.value.func)
    editable = EDITABLE_TYPES.get(object_type)
    if not editable:
        return None

    text = _first_literal_string(node.value)
    return {
        "id": object_id,
        "label": text or object_id,
        "type": object_type,
        "stageId": stage_id,
        "text": text,
        "bbox": None,
        "layoutHint": "code",
        "editable": editable,
        "codeAnchor": {
            "startLine": int(getattr(node, "lineno", 1) or 1),
            "endLine": int(getattr(node, "end_lineno", getattr(node, "lineno", 1)) or 1),
        },
    }


def build_scene_manifest(code: str, brief: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return an editable object manifest for Studio.

    Invalid or partial code should never break generation; the frontend simply
    receives an empty object list in that case.
    """
    stages = _stage_list(brief)
    try:
        tree = ast.parse(code or "")
    except SyntaxError:
        return {"version": MANIFEST_VERSION, "stages": stages, "objects": [], "warnings": ["代码暂时无法解析对象清单。"]}

    objects: list[dict[str, Any]] = []
    stage_id = stages[0]["id"]
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            item = _object_from_assignment(node, stage_id)
            if item and item["id"] not in {existing["id"] for existing in objects}:
                objects.append(item)

    objects.sort(key=lambda item: (item["codeAnchor"]["startLine"], item["id"]))
    return {
        "version": MANIFEST_VERSION,
        "stages": stages,
        "objects": objects[:80],
        "warnings": [],
    }
