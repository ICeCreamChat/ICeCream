"""Safe local patch operations for Manim Studio object edits."""

from __future__ import annotations

import ast
import json
import re
from typing import Any, Callable


OBJECT_ID_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,79}$")
COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
TEXT_CALL_RE = re.compile(r"(Text|SafeText|Tex|MathTex|SafeMathTex)\(\s*(['\"])(.*?)(\2)", re.S)


def _failure(message: str, code: str = "") -> dict[str, Any]:
    return {"success": False, "code": code, "warning": message, "patchSummary": message}


def _success(code: str, summary: str) -> dict[str, Any]:
    return {"success": True, "code": code, "warning": "", "patchSummary": summary}


def _base_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Subscript):
        return _base_name(node.value)
    return ""


def _find_construct(tree: ast.Module) -> ast.FunctionDef | None:
    candidates: list[ast.ClassDef] = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        bases = {_base_name(base) for base in node.bases}
        if node.name == "MainScene" or "Scene" in bases:
            candidates.append(node)
    scene = next((item for item in candidates if item.name == "MainScene"), None)
    if scene is None and len(candidates) == 1:
        scene = candidates[0]
    if scene is None:
        return None
    return next((item for item in scene.body if isinstance(item, ast.FunctionDef) and item.name == "construct"), None)


def _assignment_anchor(code: str, object_id: str) -> tuple[int, int] | None:
    try:
        tree = ast.parse(code or "")
    except SyntaxError:
        return None
    construct = _find_construct(tree)
    if construct is None:
        return None
    for node in ast.walk(construct):
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if isinstance(target, ast.Name) and target.id == object_id:
            start = int(getattr(node, "lineno", 1) or 1)
            end = int(getattr(node, "end_lineno", start) or start)
            return start, end
    return None


def _line_indent(line: str) -> str:
    return line[: len(line) - len(line.lstrip())]


def _replace_assignment_block(code: str, object_id: str, replacer: Callable[[str, str], str]) -> tuple[bool, str]:
    anchor = _assignment_anchor(code, object_id)
    if not anchor:
        return False, code
    lines = code.splitlines()
    start, end = anchor
    block = "\n".join(lines[start - 1 : end])
    new_block = replacer(block, _line_indent(lines[start - 1]))
    lines[start - 1 : end] = new_block.splitlines()
    return True, "\n".join(lines) + ("\n" if code.endswith("\n") else "")


def _insert_after_assignment(code: str, object_id: str, line_builder: Callable[[str], str]) -> tuple[bool, str]:
    anchor = _assignment_anchor(code, object_id)
    if not anchor:
        return False, code
    lines = code.splitlines()
    _start, end = anchor
    indent = _line_indent(lines[end - 1])
    lines.insert(end, line_builder(indent))
    return True, "\n".join(lines) + ("\n" if code.endswith("\n") else "")


def _clamp_number(value: Any, minimum: float, maximum: float, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = fallback
    return max(minimum, min(maximum, number))


def _scene_anchor_warning() -> str:
    return "只能修改主场景 MainScene.construct() 中带锚点的对象。"


def _patch_replace_text(code: str, object_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    new_text = str(patch.get("text") or "")[:500]
    if not new_text:
        return _failure("替换文字不能为空。", code)
    literal = json.dumps(new_text, ensure_ascii=False)

    def replacer(block: str, _indent: str) -> str:
        return TEXT_CALL_RE.sub(lambda match: f"{match.group(1)}({literal}", block, count=1)

    changed, next_code = _replace_assignment_block(code, object_id, replacer)
    if not changed:
        return _failure(_scene_anchor_warning(), code)
    if next_code == code:
        return _failure("未找到可替换文字的场景对象。", code)
    return _success(next_code, f"已替换 {object_id} 的文字。")


def _patch_set_color(code: str, object_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    color = str(patch.get("color") or "#0284C7")
    if not COLOR_RE.match(color):
        return _failure("颜色必须是 #RRGGBB 格式。", code)
    changed, next_code = _insert_after_assignment(code, object_id, lambda indent: f'{indent}{object_id}.set_color("{color}")')
    if not changed:
        return _failure(_scene_anchor_warning(), code)
    return _success(next_code, f"已修改 {object_id} 的颜色。")


def _patch_move(code: str, object_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    dx = _clamp_number(patch.get("dx"), -4, 4, 0)
    dy = _clamp_number(patch.get("dy"), -3, 3, 0)
    if abs(dx) < 0.001 and abs(dy) < 0.001:
        return _success(code, f"{object_id} 的位置无需调整。")
    changed, next_code = _insert_after_assignment(
        code,
        object_id,
        lambda indent: f"{indent}{object_id}.shift(RIGHT * {dx:.3f} + UP * {dy:.3f})",
    )
    if not changed:
        return _failure(_scene_anchor_warning(), code)
    return _success(next_code, f"已移动 {object_id}。")


def _patch_scale(code: str, object_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    factor = _clamp_number(patch.get("factor"), 0.1, 4, 1)
    if abs(factor - 1) < 0.005:
        return _success(code, f"{object_id} 的大小无需调整。")
    changed, next_code = _insert_after_assignment(code, object_id, lambda indent: f"{indent}{object_id}.scale({factor:.3f})")
    if not changed:
        return _failure(_scene_anchor_warning(), code)
    return _success(next_code, f"已缩放 {object_id}。")


def _patch_delete(code: str, object_id: str) -> dict[str, Any]:
    anchor = _assignment_anchor(code, object_id)
    if not anchor:
        return _failure(_scene_anchor_warning(), code)
    lines = code.splitlines()
    start, end = anchor
    for index in range(start - 1, end):
        lines[index] = f"# Studio removed: {lines[index]}"
    usage = re.compile(rf"\b{re.escape(object_id)}\b\s*,?\s*")
    for index, line in enumerate(lines):
        if ".add(" in line or ".play(" in line or "VGroup(" in line:
            lines[index] = usage.sub("", line)
    next_code = "\n".join(lines) + ("\n" if code.endswith("\n") else "")
    return _success(next_code, f"已从主场景中隐藏 {object_id}。")


def apply_scene_patch(code: str, patch: dict[str, Any]) -> dict[str, Any]:
    """Apply a constrained Studio edit to Manim code."""
    code = str(code or "")
    patch = patch or {}
    object_id = str(patch.get("objectId") or "")
    operation = str(patch.get("operation") or "")

    if not OBJECT_ID_RE.match(object_id):
        return _failure("对象 ID 不合法，无法应用修改。", code)

    if operation == "replace_text":
        return _patch_replace_text(code, object_id, patch)
    if operation == "set_color":
        return _patch_set_color(code, object_id, patch)
    if operation == "move":
        return _patch_move(code, object_id, patch)
    if operation == "scale":
        return _patch_scale(code, object_id, patch)
    if operation == "delete":
        return _patch_delete(code, object_id)

    return _failure(f"不支持的交互修复操作：{operation}", code)


def _bbox_center(box: dict[str, Any], fallback_x: float = 0.5, fallback_y: float = 0.5) -> tuple[float, float]:
    x = _clamp_number(box.get("x"), 0, 1, fallback_x)
    y = _clamp_number(box.get("y"), 0, 1, fallback_y)
    width = _clamp_number(box.get("width"), 0, 1, 0)
    height = _clamp_number(box.get("height"), 0, 1, 0)
    return x + width / 2, y + height / 2


def _patches_from_layout_edit(edit: dict[str, Any]) -> list[dict[str, Any]]:
    operation = str(edit.get("operation") or "")
    object_id = str(edit.get("objectId") or "")
    patches: list[dict[str, Any]] = []

    if operation in {"move", "scale", "layout_calibrate"}:
        source = edit.get("sourceBBox") if isinstance(edit.get("sourceBBox"), dict) else {}
        target = edit.get("normalizedBBox") if isinstance(edit.get("normalizedBBox"), dict) else {}
        source_center_x, source_center_y = _bbox_center(source)
        target_center_x, target_center_y = _bbox_center(target, source_center_x, source_center_y)
        dx = (target_center_x - source_center_x) * 14.222
        dy = (source_center_y - target_center_y) * 8.0
        if abs(dx) >= 0.001 or abs(dy) >= 0.001:
            patches.append({"operation": "move", "objectId": object_id, "dx": dx, "dy": dy})

        source_width = max(0.01, _clamp_number(source.get("width"), 0.01, 1, 0.2))
        target_width = max(0.01, _clamp_number(target.get("width"), 0.01, 1, source_width))
        factor = target_width / source_width
        if operation in {"scale", "layout_calibrate"} and abs(factor - 1) >= 0.01:
            patches.append({"operation": "scale", "objectId": object_id, "factor": factor})
        if not patches:
            patches.append({"operation": "move", "objectId": object_id, "dx": 0, "dy": 0})
    elif operation == "replace_text":
        patches.append({"operation": "replace_text", "objectId": object_id, "text": str(edit.get("targetText") or edit.get("text") or "")})
    elif operation == "set_color":
        style = edit.get("targetStyle") if isinstance(edit.get("targetStyle"), dict) else {}
        patches.append({"operation": "set_color", "objectId": object_id, "color": str(edit.get("color") or style.get("color") or "#0284C7")})
    elif operation == "delete":
        patches.append({"operation": "delete", "objectId": object_id})
    else:
        patches.append({"operation": operation, "objectId": object_id})

    return patches


def apply_layout_rebuild(code: str, layout_edit_spec: dict[str, Any]) -> dict[str, Any]:
    """Apply key-frame calibration edits as safe code patches."""
    code = str(code or "")
    spec = layout_edit_spec or {}
    edits = spec.get("edits")
    if not isinstance(edits, list):
        single = {key: value for key, value in spec.items() if key not in {"edits"}}
        edits = [single] if single.get("objectId") and single.get("operation") else []
    if not edits:
        return _failure("没有可应用的关键帧校准操作。", code)

    next_code = code
    summaries: list[str] = []
    for edit in edits:
        if not isinstance(edit, dict):
            continue
        for patch in _patches_from_layout_edit(edit):
            result = apply_scene_patch(next_code, patch)
            if not result.get("success"):
                return {
                    **result,
                    "layoutEditSpec": spec,
                    "patchSummary": result.get("patchSummary") or result.get("warning") or "关键帧校准失败。",
                }
            next_code = str(result.get("code") or next_code)
            summary = str(result.get("patchSummary") or "").strip()
            if summary:
                summaries.append(summary)

    return {
        "success": True,
        "code": next_code,
        "warning": "",
        "layoutEditSpec": spec,
        "patchSummary": "；".join(summaries) or "已应用关键帧校准。",
    }
