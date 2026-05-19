"""Safe local patch operations for Manim Studio object edits."""

from __future__ import annotations

import ast
import json
import re
from typing import Any, Callable


OBJECT_ID_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,79}$")
COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
STRING_LITERAL_RE = re.compile(r"(['\"])(.*?)(\1)", re.S)
MANUAL_BLOCK_BEGIN = "# Studio manual layout constraints"
MANUAL_BLOCK_END = "# End Studio manual layout constraints"

COLOR_WORDS = {
    "深蓝": "#0F4C81",
    "蓝": "#0284C7",
    "红": "#DC2626",
    "绿色": "#16A34A",
    "绿": "#16A34A",
    "橙": "#F97316",
    "紫": "#7C3AED",
    "灰": "#64748B",
    "黑": "#111827",
    "白": "#F8FAFC",
}


def _failure(message: str, code: str = "") -> dict[str, Any]:
    return {"success": False, "code": code, "warning": message, "patchSummary": message}


def _success(code: str, summary: str, edit_plan: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"success": True, "code": code, "warning": "", "patchSummary": summary}
    if edit_plan is not None:
        result["editPlan"] = edit_plan
    return result


def _base_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Subscript):
        return _base_name(node.value)
    return ""


def _name_of(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Call):
        return _name_of(node.func)
    return ""


def _root_call(value: ast.AST) -> ast.Call | None:
    if not isinstance(value, ast.Call):
        return None
    current = value
    while isinstance(current.func, ast.Attribute) and isinstance(current.func.value, ast.Call):
        current = current.func.value
    return current


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


def _target_names(target: ast.AST) -> list[str]:
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        return [item.id for item in target.elts if isinstance(item, ast.Name) and item.id != "_"]
    return []


def _assignment_anchor(code: str, object_id: str) -> dict[str, Any] | None:
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
        names = _target_names(node.targets[0])
        if object_id not in names:
            continue
        root = _root_call(node.value)
        return {
            "start": int(getattr(node, "lineno", 1) or 1),
            "end": int(getattr(node, "end_lineno", getattr(node, "lineno", 1)) or 1),
            "targetIndex": names.index(object_id),
            "factory": _name_of(root.func) if root else "",
        }
    return None


def _line_indent(line: str) -> str:
    return line[: len(line) - len(line.lstrip())]


def _replace_assignment_block(code: str, object_id: str, replacer: Callable[[str, str, dict[str, Any]], str]) -> tuple[bool, str]:
    anchor = _assignment_anchor(code, object_id)
    if not anchor:
        return False, code
    lines = code.splitlines()
    start, end = int(anchor["start"]), int(anchor["end"])
    block = "\n".join(lines[start - 1 : end])
    new_block = replacer(block, _line_indent(lines[start - 1]), anchor)
    lines[start - 1 : end] = new_block.splitlines()
    return True, "\n".join(lines) + ("\n" if code.endswith("\n") else "")


def _insert_after_assignment(code: str, object_id: str, line_builder: Callable[[str], str]) -> tuple[bool, str]:
    anchor = _assignment_anchor(code, object_id)
    if not anchor:
        return False, code
    lines = code.splitlines()
    end = int(anchor["end"])
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
    return "只能修改主场景 MainScene.construct() 中带锚点的可见对象。"


def _string_index_for_object(object_id: str, anchor: dict[str, Any]) -> int:
    oid = object_id.lower()
    if str(anchor.get("factory") or "") == "make_header":
        return 1 if "sub" in oid else 0
    return 0


def _replace_nth_string(block: str, nth: int, new_literal: str) -> str:
    index = -1

    def replace(match: re.Match[str]) -> str:
        nonlocal index
        index += 1
        if index == nth:
            return new_literal
        return match.group(0)

    return STRING_LITERAL_RE.sub(replace, block)


def _patch_replace_text(code: str, object_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    new_text = str(patch.get("text") or "")[:500]
    if not new_text:
        return _failure("替换文字不能为空。", code)
    literal = json.dumps(new_text, ensure_ascii=False)

    def replacer(block: str, _indent: str, anchor: dict[str, Any]) -> str:
        return _replace_nth_string(block, _string_index_for_object(object_id, anchor), literal)

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
    changed, next_code = _insert_after_assignment(code, object_id, lambda indent: f"{indent}{object_id}.set_opacity(0)")
    if not changed:
        return _failure(_scene_anchor_warning(), code)
    return _success(next_code, f"已在主场景中隐藏 {object_id}。")


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

    return _failure(f"不支持的交互修改操作：{operation}", code)


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
    elif operation == "manual_region":
        return []
    else:
        patches.append({"operation": operation, "objectId": object_id})

    return patches


def _extract_quoted_text(command: str) -> str:
    match = re.search(r"[“\"'](.{1,500}?)[”\"']", command)
    return match.group(1).strip() if match else ""


def _parse_color(command: str) -> str:
    hex_match = re.search(r"#[0-9A-Fa-f]{6}", command)
    if hex_match:
        return hex_match.group(0)
    for word, color in COLOR_WORDS.items():
        if word in command:
            return color
    return ""


def _movement_amount(command: str) -> float:
    if any(word in command for word in ("一点", "稍微", "轻微")):
        return 0.22
    if any(word in command for word in ("很多", "大幅", "明显")):
        return 0.58
    return 0.35


def _natural_selected_object_ids(natural: dict[str, Any]) -> list[str]:
    raw_ids = natural.get("selectedObjectIds")
    ids: list[str] = []
    if isinstance(raw_ids, list):
        ids.extend(str(item) for item in raw_ids if item)
    fallback = str(natural.get("selectedObjectId") or natural.get("objectId") or "")
    if fallback:
        ids.append(fallback)
    deduped: list[str] = []
    for object_id in ids:
        object_id = str(object_id or "").strip()
        if not object_id or object_id.startswith("manual_") or object_id in deduped:
            continue
        deduped.append(object_id)
    return deduped


def _natural_selected_snapshots(natural: dict[str, Any]) -> list[dict[str, Any]]:
    snapshots = natural.get("selectedObjectSnapshots")
    if isinstance(snapshots, list):
        return [item for item in snapshots if isinstance(item, dict)]
    snapshot = natural.get("selectedObjectSnapshot")
    return [snapshot] if isinstance(snapshot, dict) else []


def _snapshot_box(snapshot: dict[str, Any]) -> dict[str, Any]:
    box = snapshot.get("bbox") if isinstance(snapshot.get("bbox"), dict) else {}
    return {
        "x": _clamp_number(box.get("x"), 0, 1, 0.45),
        "y": _clamp_number(box.get("y"), 0, 1, 0.45),
        "width": _clamp_number(box.get("width"), 0.01, 1, 0.12),
        "height": _clamp_number(box.get("height"), 0.01, 1, 0.08),
    }


def _group_layout_patches(command: str, object_ids: list[str], snapshots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(object_ids) < 2 or not snapshots:
        return []
    if not any(word in command for word in ("排开", "分散", "不要重叠", "不重叠", "对齐")):
        return []

    snapshot_by_id = {str(item.get("id") or ""): item for item in snapshots}
    boxes = [(object_id, _snapshot_box(snapshot_by_id.get(object_id, {}))) for object_id in object_ids]
    if len(boxes) < 2:
        return []

    left = min(box["x"] for _, box in boxes)
    top = min(box["y"] for _, box in boxes)
    right = max(box["x"] + box["width"] for _, box in boxes)
    bottom = max(box["y"] + box["height"] for _, box in boxes)
    width = max(0.04, right - left)
    height = max(0.04, bottom - top)
    horizontal = width >= height
    ordered = sorted(boxes, key=lambda item: item[1]["x"] + item[1]["width"] / 2 if horizontal else item[1]["y"] + item[1]["height"] / 2)
    gap = 0.016
    safe_left, safe_top = 0.04, 0.05
    safe_right, safe_bottom = 0.96, 0.93
    patches: list[dict[str, Any]] = []

    if any(word in command for word in ("左对齐", "右对齐", "上对齐", "下对齐", "居中对齐", "居中")):
        center_x = (left + right) / 2
        center_y = (top + bottom) / 2
        for object_id, source in boxes:
            target = dict(source)
            if "左对齐" in command:
                target["x"] = left
            elif "右对齐" in command:
                target["x"] = right - source["width"]
            elif "上对齐" in command:
                target["y"] = top
            elif "下对齐" in command:
                target["y"] = bottom - source["height"]
            else:
                target["x"] = center_x - source["width"] / 2
                target["y"] = center_y - source["height"] / 2
            target["x"] = _clamp_number(target["x"], safe_left, safe_right - target["width"], source["x"])
            target["y"] = _clamp_number(target["y"], safe_top, safe_bottom - target["height"], source["y"])
            patches.append({"operation": "layout_calibrate", "objectId": object_id, "sourceBBox": source, "normalizedBBox": target})
        return patches

    if horizontal:
        total_width = sum(box["width"] for _, box in ordered)
        available_width = min(safe_right - safe_left, max(width, total_width + gap * (len(ordered) - 1)))
        start_x = _clamp_number((left + right - available_width) / 2, safe_left, safe_right - available_width, safe_left)
        cursor = start_x
        for object_id, source in ordered:
            target = dict(source)
            target["x"] = cursor
            target["y"] = _clamp_number(source["y"], safe_top, safe_bottom - source["height"], source["y"])
            cursor += source["width"] + gap
            patches.append({"operation": "layout_calibrate", "objectId": object_id, "sourceBBox": source, "normalizedBBox": target})
    else:
        total_height = sum(box["height"] for _, box in ordered)
        available_height = min(safe_bottom - safe_top, max(height, total_height + gap * (len(ordered) - 1)))
        start_y = _clamp_number((top + bottom - available_height) / 2, safe_top, safe_bottom - available_height, safe_top)
        cursor = start_y
        for object_id, source in ordered:
            target = dict(source)
            target["x"] = _clamp_number(source["x"], safe_left, safe_right - source["width"], source["x"])
            target["y"] = cursor
            cursor += source["height"] + gap
            patches.append({"operation": "layout_calibrate", "objectId": object_id, "sourceBBox": source, "normalizedBBox": target})
    return patches


def _patches_from_natural_language(natural: dict[str, Any]) -> list[dict[str, Any]]:
    command = str(natural.get("command") or "").strip()
    object_ids = _natural_selected_object_ids(natural)
    if not command or not object_ids:
        return []

    patches: list[dict[str, Any]] = []
    snapshots = _natural_selected_snapshots(natural)
    quoted = _extract_quoted_text(command)
    if quoted and any(word in command for word in ("改", "替换", "文字", "标题", "内容", "变成")):
        for object_id in object_ids:
            patches.append({"operation": "replace_text", "objectId": object_id, "text": quoted})

    color = _parse_color(command)
    if color and any(word in command for word in ("颜色", "改成", "改为", "变成", "换成")):
        for object_id in object_ids:
            patches.append({"operation": "set_color", "objectId": object_id, "color": color})

    amount = _movement_amount(command)
    dx = 0.0
    dy = 0.0
    if "上" in command:
        dy += amount
    if "下" in command:
        dy -= amount
    if "左" in command:
        dx -= amount
    if "右" in command:
        dx += amount
    if abs(dx) > 0.001 or abs(dy) > 0.001:
        for object_id in object_ids:
            patches.append({"operation": "move", "objectId": object_id, "dx": dx, "dy": dy})

    if any(word in command for word in ("缩小", "小一点", "变小", "字体小")):
        for object_id in object_ids:
            patches.append({"operation": "scale", "objectId": object_id, "factor": 0.88})
    elif any(word in command for word in ("放大", "大一点", "变大", "字体大")):
        for object_id in object_ids:
            patches.append({"operation": "scale", "objectId": object_id, "factor": 1.12})

    group_layout_patches = _group_layout_patches(command, object_ids, snapshots)
    if any(word in command for word in ("删除", "去掉", "移除", "隐藏", "不要")) and not group_layout_patches and not any(word in command for word in ("不要重叠", "不重叠", "排开", "分散", "遮住", "对齐")):
        for object_id in object_ids:
            patches.append({"operation": "delete", "objectId": object_id})

    patches.extend(group_layout_patches)
    return patches


def _remove_existing_manual_block(lines: list[str]) -> list[str]:
    cleaned: list[str] = []
    skipping = False
    for line in lines:
        if MANUAL_BLOCK_BEGIN in line:
            skipping = True
            continue
        if skipping and MANUAL_BLOCK_END in line:
            skipping = False
            continue
        if not skipping:
            cleaned.append(line)
    return cleaned


def _insert_manual_constraints(code: str, spec: dict[str, Any], regions: list[dict[str, Any]]) -> tuple[bool, str, str]:
    if not regions:
        return True, code, ""
    try:
        tree = ast.parse(code or "")
    except SyntaxError:
        return False, code, "代码暂时无法解析，不能写入手动画框约束。"
    construct = _find_construct(tree)
    if construct is None:
        return False, code, _scene_anchor_warning()

    lines = _remove_existing_manual_block(code.splitlines())
    construct_line = max(0, int(getattr(construct, "lineno", 1) or 1) - 1)
    if construct_line >= len(lines):
        return False, code, _scene_anchor_warning()
    indent = _line_indent(lines[construct_line]) + "    "
    base_frame = str(spec.get("baseFrameId") or "")
    base_time = _clamp_number(spec.get("baseTime"), 0, 10_000, 0)
    command = ""
    natural = spec.get("naturalLanguageEdit")
    if isinstance(natural, dict):
        command = str(natural.get("command") or "")[:300]
    block = [
        f"{indent}{MANUAL_BLOCK_BEGIN}: frame={base_frame}, time={base_time:.3f}",
        f"{indent}# 手动画框区域会作为整段动画重构的布局约束。",
    ]
    if command:
        block.append(f"{indent}# 用户修改要求：{command}")
    for index, region in enumerate(regions, start=1):
        if not isinstance(region, dict):
            continue
        box = region.get("normalizedBBox") if isinstance(region.get("normalizedBBox"), dict) else {}
        region_id = str(region.get("id") or f"manual_{index}")[:80]
        region_type = str(region.get("type") or region.get("label") or "手动画框")[:80]
        label = str(region.get("label") or region_type)[:120]
        x = _clamp_number(box.get("x"), 0, 1, 0)
        y = _clamp_number(box.get("y"), 0, 1, 0)
        width = _clamp_number(box.get("width"), 0, 1, 0)
        height = _clamp_number(box.get("height"), 0, 1, 0)
        block.append(
            f"{indent}# - {region_id}: type={region_type}, label={label}, "
            f"bbox=({x:.3f}, {y:.3f}, {width:.3f}, {height:.3f})"
        )
    block.append(f"{indent}{MANUAL_BLOCK_END}")
    lines[construct_line + 1 : construct_line + 1] = block
    next_code = "\n".join(lines) + ("\n" if code.endswith("\n") else "")
    return True, next_code, f"已记录 {len(regions)} 个手动画框布局约束。"


def _safe_canvas_object_id(raw: Any, index: int) -> str:
    value = re.sub(r"[^A-Za-z0-9_]", "_", str(raw or f"studio_added_{index}"))
    if not value or value[0].isdigit():
        value = f"studio_added_{index}_{value}"
    value = value[:80]
    return value if OBJECT_ID_RE.match(value) else f"studio_added_{index}"


def _canvas_point_from_bbox(box: dict[str, Any]) -> tuple[float, float]:
    center_x, center_y = _bbox_center(box)
    return (center_x - 0.5) * 14.222, (0.5 - center_y) * 8.0


def _normalize_new_canvas_objects(spec: dict[str, Any]) -> list[dict[str, Any]]:
    raw = spec.get("newObjects")
    if not isinstance(raw, list):
        return []
    objects: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        box = item.get("normalizedBBox") if isinstance(item.get("normalizedBBox"), dict) else {}
        kind = str(item.get("kind") or item.get("type") or "text").lower()
        objects.append({
            "id": str(item.get("id") or ""),
            "kind": kind,
            "label": str(item.get("label") or "新增对象")[:120],
            "text": str(item.get("text") or item.get("label") or "新增对象")[:300],
            "normalizedBBox": box,
        })
    return objects[:12]


def _insert_new_canvas_objects(code: str, objects: list[dict[str, Any]]) -> tuple[bool, str, str]:
    if not objects:
        return True, code, ""
    try:
        tree = ast.parse(code or "")
    except SyntaxError:
        return False, code, "代码暂时无法解析，不能插入新增对象。"
    construct = _find_construct(tree)
    if construct is None:
        return False, code, _scene_anchor_warning()

    lines = code.splitlines()
    construct_line = max(0, int(getattr(construct, "lineno", 1) or 1) - 1)
    if construct_line >= len(lines):
        return False, code, _scene_anchor_warning()

    indent = _line_indent(lines[construct_line]) + "    "
    block: list[str] = [f"{indent}# Studio canvas additions"]
    for index, item in enumerate(objects, start=1):
        object_id = _safe_canvas_object_id(item.get("id"), index)
        kind = str(item.get("kind") or "text").lower()
        text_literal = json.dumps(str(item.get("text") or item.get("label") or "新增对象"), ensure_ascii=False)
        x, y = _canvas_point_from_bbox(item.get("normalizedBBox") if isinstance(item.get("normalizedBBox"), dict) else {})
        if "formula" in kind or "math" in kind:
            block.append(f"{indent}{object_id} = SafeMathTex({text_literal}, font_size=34, color=\"#1D2530\")")
        elif "arrow" in kind:
            block.append(
                f"{indent}{object_id} = Arrow(LEFT * 0.45, RIGHT * 0.45, "
                "buff=0, stroke_width=4, color=\"#0284C7\")"
            )
        else:
            block.append(f"{indent}{object_id} = SafeText({text_literal}, font_size=28, color=\"#1D2530\")")
        block.append(f"{indent}{object_id}.move_to(RIGHT * {x:.3f} + UP * {y:.3f})")
        block.append(f"{indent}self.add({object_id})")

    lines[construct_line + 1 : construct_line + 1] = block
    next_code = "\n".join(lines) + ("\n" if code.endswith("\n") else "")
    return True, next_code, f"已新增 {len(objects)} 个画布对象。"


def _normalize_layout_edits(spec: dict[str, Any]) -> list[dict[str, Any]]:
    edits = spec.get("objectEdits")
    if not isinstance(edits, list):
        edits = spec.get("edits")
    if isinstance(edits, list):
        return [item for item in edits if isinstance(item, dict)]
    single = {
        key: value for key, value in spec.items()
        if key not in {
            "edits",
            "objectEdits",
            "manualReferenceRegions",
            "naturalLanguageEdit",
            "newObjects",
            "deletedObjectIds",
        }
    }
    return [single] if single.get("objectId") and single.get("operation") else []


def apply_layout_rebuild(code: str, layout_edit_spec: dict[str, Any]) -> dict[str, Any]:
    """Apply key-frame calibration edits as safe code patches."""
    code = str(code or "")
    spec = layout_edit_spec or {}
    edits = _normalize_layout_edits(spec)

    manual_regions = spec.get("manualReferenceRegions")
    if not isinstance(manual_regions, list):
        manual_regions = []
    manual_regions = [item for item in manual_regions if isinstance(item, dict)]

    deleted_ids = spec.get("deletedObjectIds")
    if isinstance(deleted_ids, list):
        for object_id in deleted_ids:
            object_id = str(object_id or "")
            if object_id:
                edits.append({"operation": "delete", "objectId": object_id})

    new_objects = _normalize_new_canvas_objects(spec)

    natural = spec.get("naturalLanguageEdit") if isinstance(spec.get("naturalLanguageEdit"), dict) else {}
    natural_patches = _patches_from_natural_language(natural) if natural else []
    edits.extend(natural_patches)

    if not edits and not manual_regions and not new_objects:
        return _failure("没有可应用的关键帧校准操作。", code)
    if natural and not natural_patches and not manual_regions and not edits and not new_objects:
        return _failure("还没有理解这条自然语言修改，请说得更具体一点，例如：改文字、上移、缩小、改成蓝色或删除。", code)

    next_code = code
    summaries: list[str] = []
    edit_plan: list[dict[str, Any]] = []
    for edit in edits:
        has_bbox_calibration = isinstance(edit.get("sourceBBox"), dict) and isinstance(edit.get("normalizedBBox"), dict)
        layout_patches = (
            _patches_from_layout_edit(edit)
            if edit.get("operation") in {"layout_calibrate", "manual_region"} or has_bbox_calibration
            else [edit]
        )
        for patch in layout_patches:
            result = apply_scene_patch(next_code, patch)
            if not result.get("success"):
                return {
                    **result,
                    "layoutEditSpec": spec,
                    "patchSummary": result.get("patchSummary") or result.get("warning") or "关键帧校准失败。",
                }
            next_code = str(result.get("code") or next_code)
            edit_plan.append(patch)
            summary = str(result.get("patchSummary") or "").strip()
            if summary:
                summaries.append(summary)

    inserted_new, next_code, new_summary = _insert_new_canvas_objects(next_code, new_objects)
    if not inserted_new:
        return {
            **_failure(new_summary, code),
            "layoutEditSpec": spec,
        }
    if new_summary:
        summaries.append(new_summary)

    inserted, next_code, manual_summary = _insert_manual_constraints(next_code, spec, manual_regions)
    if not inserted:
        return {
            **_failure(manual_summary, code),
            "layoutEditSpec": spec,
        }
    if manual_summary:
        summaries.append(manual_summary)

    summary = "；".join(summaries) or "已应用关键帧校准。"
    return {
        "success": True,
        "code": next_code,
        "warning": "",
        "layoutEditSpec": spec,
        "patchSummary": summary,
        "editPlan": edit_plan,
    }
