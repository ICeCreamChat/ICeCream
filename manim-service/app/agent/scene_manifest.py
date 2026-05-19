"""Scene manifest extraction and runtime instrumentation for Manim Studio.

The source manifest is conservative: it exposes only objects created inside
``MainScene.construct`` (or the single renderable scene's ``construct`` method),
never helper-function locals. During rendering we inject a tiny recorder at the
end of ``construct`` so Manim can export measured object bounding boxes.
"""

from __future__ import annotations

import ast
import json
from typing import Any


MANIFEST_VERSION = "scene-manifest-v2"

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
    "Graph": ["move", "set_color", "scale", "delete"],
    "VGroup": ["move", "scale", "delete"],
    "Axes": ["move", "scale", "delete"],
}

TEXT_OBJECT_TYPES = {"Text", "SafeText", "Tex", "MathTex", "SafeMathTex"}
VISIBLE_HELPER_FACTORIES = {"make_header", "make_step_banner", "make_summary"}

RENDERABLE_SCENE_BASES = {"Scene", "ThreeDScene", "MovingCameraScene", "ZoomedScene"}
INTERNAL_ID_PARTS = {
    "bg",
    "background",
    "panel",
    "card",
    "frame",
    "helper",
    "internal",
    "shadow",
    "container",
}

DISPLAY_BY_ROLE = {
    "title": "标题",
    "subtitle": "副标题",
    "step": "步骤说明",
    "summary": "总结",
    "formula": "公式",
    "axes": "坐标系",
    "graph": "曲线",
    "point": "关键点",
    "connector": "箭头/线段",
    "shape": "图形",
    "group": "组合",
    "text": "文字",
    "object": "对象",
}

PUBLIC_TYPE_BY_TYPE = {
    "Text": "文字",
    "SafeText": "文字",
    "Tex": "公式",
    "MathTex": "公式",
    "SafeMathTex": "公式",
    "Circle": "圆形",
    "Square": "正方形",
    "Triangle": "三角形",
    "Rectangle": "矩形",
    "Polygon": "多边形",
    "Line": "线段",
    "Arrow": "箭头",
    "Dot": "点",
    "Graph": "曲线",
    "VGroup": "组合",
    "Axes": "坐标系",
}


DISPLAY_BY_ROLE = {
    "title": "标题",
    "subtitle": "副标题",
    "step": "步骤说明",
    "summary": "总结",
    "formula": "公式",
    "axes": "坐标系",
    "graph": "曲线",
    "point": "关键点",
    "connector": "箭头/线段",
    "shape": "图形",
    "group": "组合",
    "text": "文字",
    "object": "对象",
}

PUBLIC_TYPE_BY_TYPE = {
    "Text": "文字",
    "SafeText": "文字",
    "Tex": "公式",
    "MathTex": "公式",
    "SafeMathTex": "公式",
    "Circle": "圆形",
    "Square": "正方形",
    "Triangle": "三角形",
    "Rectangle": "矩形",
    "Polygon": "多边形",
    "Line": "线段",
    "Arrow": "箭头",
    "Dot": "点",
    "Graph": "曲线",
    "VGroup": "组合",
    "Axes": "坐标系",
}


def _name_of(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Call):
        return _name_of(node.func)
    return ""


def _base_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Subscript):
        return _base_name(node.value)
    return ""


def _first_literal_string(call: ast.Call) -> str:
    root_call = _root_call(call)
    if root_call is not call:
        return _first_literal_string(root_call)
    for arg in call.args:
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            return arg.value
    return ""


def _literal_strings(call: ast.Call) -> list[str]:
    root_call = _root_call(call)
    if root_call is not call:
        return _literal_strings(root_call)
    return [arg.value for arg in root_call.args if isinstance(arg, ast.Constant) and isinstance(arg.value, str)]


def _stage_list(brief: dict[str, Any] | None) -> list[dict[str, str]]:
    brief = brief or {}
    spec = brief.get("storyboardSpec") or brief.get("spec") or {}
    stages: list[dict[str, str]] = []
    shots = spec.get("shots") if isinstance(spec, dict) else []
    for index, shot in enumerate(shots or [], start=1):
        if isinstance(shot, dict):
            stage_id = str(shot.get("id") or f"stage_{index}")
            title = str(shot.get("title") or f"阶段 {index}")
        else:
            stage_id = f"stage_{index}"
            title = str(shot or f"阶段 {index}")
        stages.append({"id": stage_id, "title": title})
    return stages or [{"id": "stage_1", "title": "主场景"}]


def _find_scene_class(tree: ast.Module) -> ast.ClassDef | None:
    scene_classes: list[ast.ClassDef] = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        base_names = {_base_name(base) for base in node.bases}
        if node.name == "MainScene" or base_names & RENDERABLE_SCENE_BASES:
            scene_classes.append(node)

    scene = next((item for item in scene_classes if item.name == "MainScene"), None)
    if scene is None and len(scene_classes) == 1:
        scene = scene_classes[0]
    return scene


def _find_scene_construct(tree: ast.Module) -> ast.FunctionDef | None:
    scene = _find_scene_class(tree)
    if scene is None:
        return None
    return next((item for item in scene.body if isinstance(item, ast.FunctionDef) and item.name == "construct"), None)


def _assigned_names(node: ast.Assign) -> list[str]:
    if len(node.targets) != 1:
        return []
    target = node.targets[0]
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        return [item.id for item in target.elts if isinstance(item, ast.Name) and item.id != "_"]
    return []


def _is_internal_id(object_id: str, object_type: str, role: str, text: str = "") -> bool:
    oid = object_id.lower()
    if oid in {"text", "mob", "mobject", "item", "obj"}:
        return True
    if oid in {"formula", "label"} and role != "formula" and not (object_type in TEXT_OBJECT_TYPES and text):
        return True
    if any(part in oid for part in INTERNAL_ID_PARTS) and role not in {"step", "title", "subtitle", "summary"}:
        return True
    if object_type == "VGroup" and any(part in oid for part in {"group", "container", "all_", "scene"}):
        return True
    return False


def _infer_role(object_id: str, object_type: str, text: str) -> str:
    oid = object_id.lower()
    if "title" in oid and "sub" not in oid:
        return "title"
    if "subtitle" in oid or "sub_title" in oid:
        return "subtitle"
    if "step" in oid or "banner" in oid:
        return "step"
    if "summary" in oid or "conclusion" in oid:
        return "summary"
    if "formula" in oid or object_type in {"Tex", "MathTex", "SafeMathTex"}:
        return "formula"
    if "axes" in oid or "axis" in oid or object_type == "Axes":
        return "axes"
    if "graph" in oid or "curve" in oid or "plot" in oid:
        return "graph"
    if "point" in oid or "dot" in oid or object_type == "Dot":
        return "point"
    if object_type in {"Circle", "Square", "Triangle", "Polygon", "Rectangle"}:
        return "shape"
    if object_type in {"Arrow", "Line"}:
        return "connector"
    if object_type == "VGroup":
        return "group"
    if text:
        return "text"
    return "object"


def _estimated_bbox(role: str, index: int, total: int) -> dict[str, float]:
    by_role: dict[str, dict[str, float]] = {
        "title": {"x": 0.32, "y": 0.04, "width": 0.36, "height": 0.075},
        "subtitle": {"x": 0.36, "y": 0.11, "width": 0.28, "height": 0.055},
        "step": {"x": 0.13, "y": 0.22, "width": 0.38, "height": 0.075},
        "axes": {"x": 0.18, "y": 0.31, "width": 0.64, "height": 0.44},
        "graph": {"x": 0.20, "y": 0.32, "width": 0.60, "height": 0.40},
        "shape": {"x": 0.30, "y": 0.30, "width": 0.40, "height": 0.42},
        "formula": {"x": 0.28, "y": 0.75, "width": 0.44, "height": 0.09},
        "summary": {"x": 0.22, "y": 0.84, "width": 0.56, "height": 0.08},
        "connector": {"x": 0.22, "y": 0.48, "width": 0.56, "height": 0.10},
    }
    if role in by_role:
        return by_role[role]
    if role == "point":
        slot = index % 5
        return {"x": 0.22 + slot * 0.14, "y": 0.58, "width": 0.08, "height": 0.08}
    row = index // 3
    col = index % 3
    return {"x": 0.16 + col * 0.23, "y": min(0.82, 0.25 + row * 0.12), "width": 0.18, "height": 0.08}


def _root_call(value: ast.Call) -> ast.Call:
    """Return the constructor/source call under common Manim method chains.

    Manim code often creates objects as ``Circle(...).shift(...)`` or
    ``axes.plot(...).set_color(...)``. The editable object type is the root
    constructor/plot call, not the last layout method.
    """
    current = value
    while isinstance(current.func, ast.Attribute) and isinstance(current.func.value, ast.Call):
        current = current.func.value
    return current


def _call_type(value: ast.Call) -> str:
    root = _root_call(value)
    object_type = _name_of(root.func)
    if object_type in {"plot", "plot_parametric_curve", "plot_line_graph"}:
        return "Graph"
    return object_type


def _helper_object_type(factory: str, object_id: str, index: int) -> str:
    if factory == "make_header":
        return "SafeText" if index in {1, 2} or "title" in object_id.lower() else "VGroup"
    if factory in {"make_step_banner", "make_summary"}:
        return "SafeText"
    return "VGroup"


def _helper_text(factory: str, object_id: str, index: int, strings: list[str]) -> str:
    if factory == "make_header":
        oid = object_id.lower()
        if "sub" in oid and len(strings) > 1:
            return strings[1]
        if ("title" in oid or index == 1) and strings:
            return strings[0]
        return ""
    if factory in {"make_step_banner", "make_summary"} and strings:
        return strings[0]
    return ""


def _assignment_to_objects(node: ast.Assign, stage_id: str) -> list[dict[str, Any]]:
    object_ids = _assigned_names(node)
    if not object_ids or not isinstance(node.value, ast.Call):
        return []
    root_call = _root_call(node.value)
    factory = _name_of(root_call.func)
    strings = _literal_strings(node.value)
    results: list[dict[str, Any]] = []

    for index, object_id in enumerate(object_ids):
        object_type = _helper_object_type(factory, object_id, index) if factory in VISIBLE_HELPER_FACTORIES else _call_type(node.value)
        editable = EDITABLE_TYPES.get(object_type)
        if not editable:
            continue
        text = _helper_text(factory, object_id, index, strings) if factory in VISIBLE_HELPER_FACTORIES else _first_literal_string(node.value)
        role = _infer_role(object_id, object_type, text)
        if _is_internal_id(object_id, object_type, role, text):
            continue
        results.append(
            {
                "id": object_id,
                "label": text or DISPLAY_BY_ROLE.get(role, object_id),
                "displayName": DISPLAY_BY_ROLE.get(role, "对象"),
                "type": object_type,
                "publicType": PUBLIC_TYPE_BY_TYPE.get(object_type, "对象"),
                "stageId": stage_id,
                "text": text,
                "role": role,
                "bbox": None,
                "layoutHint": "manifest",
                "sourceScope": "MainScene.construct",
                "editable": editable,
                "codeAnchor": {
                    "startLine": int(getattr(node, "lineno", 1) or 1),
                    "endLine": int(getattr(node, "end_lineno", getattr(node, "lineno", 1)) or 1),
                },
            }
        )
    return results


def _assignment_to_object(node: ast.Assign, stage_id: str) -> dict[str, Any] | None:
    objects = _assignment_to_objects(node, stage_id)
    return objects[0] if objects else None


def _legacy_assignment_to_object(node: ast.Assign, stage_id: str) -> dict[str, Any] | None:
    object_ids = _assigned_names(node)
    object_id = object_ids[0] if object_ids else ""
    if not object_id or not isinstance(node.value, ast.Call):
        return None
    object_type = _call_type(node.value)
    editable = EDITABLE_TYPES.get(object_type)
    if not editable:
        return None
    text = _first_literal_string(node.value)
    role = _infer_role(object_id, object_type, text)
    if _is_internal_id(object_id, object_type, role, text):
        return None
    return {
        "id": object_id,
        "label": text or DISPLAY_BY_ROLE.get(role, object_id),
        "displayName": DISPLAY_BY_ROLE.get(role, "对象"),
        "type": object_type,
        "publicType": PUBLIC_TYPE_BY_TYPE.get(object_type, "对象"),
        "stageId": stage_id,
        "text": text,
        "role": role,
        "bbox": None,
        "layoutHint": "manifest",
        "sourceScope": "MainScene.construct",
        "editable": editable,
        "codeAnchor": {
            "startLine": int(getattr(node, "lineno", 1) or 1),
            "endLine": int(getattr(node, "end_lineno", getattr(node, "lineno", 1)) or 1),
        },
    }


def build_scene_manifest(code: str, brief: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return safe editable objects for Manim Studio."""
    stages = _stage_list(brief)
    try:
        tree = ast.parse(code or "")
    except SyntaxError:
        return {"version": MANIFEST_VERSION, "stages": stages, "objects": [], "warnings": ["代码暂时无法解析对象清单。"]}

    construct = _find_scene_construct(tree)
    if construct is None:
        return {"version": MANIFEST_VERSION, "stages": stages, "objects": [], "warnings": ["未找到可分析的 MainScene.construct。"]}

    objects: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    stage_id = stages[0]["id"]
    for node in ast.walk(construct):
        if not isinstance(node, ast.Assign):
            continue
        for item in _assignment_to_objects(node, stage_id):
            if item and item["id"] not in seen_ids:
                objects.append(item)
                seen_ids.add(item["id"])

    objects.sort(key=lambda item: (item["codeAnchor"]["startLine"], item["id"]))
    for index, item in enumerate(objects):
        item["bbox"] = _estimated_bbox(str(item.get("role") or "object"), index, len(objects))
        item["bboxes"] = [{"stageId": item["stageId"], "timeRange": None, "bbox": item["bbox"]}]

    return {
        "version": MANIFEST_VERSION,
        "stages": stages,
        "objects": objects[:80],
        "warnings": [] if objects else ["没有识别到可编辑场景对象。"],
    }


def merge_runtime_bboxes(
    scene_manifest: dict[str, Any],
    runtime_objects: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Merge renderer-measured boxes into the source manifest."""
    manifest = dict(scene_manifest or {})
    objects = [dict(item) for item in manifest.get("objects", []) if isinstance(item, dict)]
    runtime_by_id = {
        str(item.get("id") or item.get("objectId") or ""): item
        for item in (runtime_objects or [])
        if isinstance(item, dict)
    }
    for item in objects:
        runtime = runtime_by_id.get(str(item.get("id") or ""))
        bbox = runtime.get("bbox") if runtime else None
        if isinstance(bbox, dict):
            item["bbox"] = bbox
            item["bboxes"] = [{"stageId": item.get("stageId") or "stage_1", "timeRange": runtime.get("timeRange"), "bbox": bbox}]
            item["layoutHint"] = "runtime"
    manifest["objects"] = objects
    manifest["runtime"] = bool(runtime_by_id)
    return manifest


def _body_indent(lines: list[str], construct: ast.FunctionDef) -> str:
    for node in construct.body:
        lineno = int(getattr(node, "lineno", 0) or 0)
        if 1 <= lineno <= len(lines):
            line = lines[lineno - 1]
            stripped = line.lstrip(" ")
            if stripped:
                return line[: len(line) - len(stripped)]
    return " " * 8


def _runtime_recorder_source() -> str:
    return r'''

# ---- ICeCream Studio runtime manifest recorder ----
def _icecream_studio_clamp(value, low=0.0, high=1.0):
    try:
        value = float(value)
    except Exception:
        return low
    return max(low, min(high, value))


def _icecream_studio_bbox(mob):
    try:
        left = float(mob.get_left()[0])
        right = float(mob.get_right()[0])
        top = float(mob.get_top()[1])
        bottom = float(mob.get_bottom()[1])
        frame_width = float(config.frame_width)
        frame_height = float(config.frame_height)
        width = max(0.0, right - left)
        height = max(0.0, top - bottom)
        if width <= 1e-6 or height <= 1e-6:
            return None
        return {
            "x": _icecream_studio_clamp((left + frame_width / 2) / frame_width),
            "y": _icecream_studio_clamp((frame_height / 2 - top) / frame_height),
            "width": _icecream_studio_clamp(width / frame_width),
            "height": _icecream_studio_clamp(height / frame_height),
        }
    except Exception:
        return None


def _icecream_studio_export(scene, objects, manifest_path):
    try:
        import json as _json
        import os as _os
        exported = []
        for object_id, mob in objects.items():
            bbox = _icecream_studio_bbox(mob)
            if bbox:
                exported.append({"id": object_id, "bbox": bbox, "timeRange": None})
        _os.makedirs(_os.path.dirname(manifest_path), exist_ok=True)
        with open(manifest_path, "w", encoding="utf-8") as handle:
            _json.dump({"version": "runtime-scene-manifest-v1", "objects": exported}, handle, ensure_ascii=False)
    except Exception:
        pass
'''


def instrument_code_for_runtime_manifest(code: str, manifest: dict[str, Any], manifest_path: str) -> str:
    """Inject a render-time bbox exporter into MainScene.construct.

    The injected code is best-effort and intentionally non-fatal: render success
    must not depend on Studio metadata generation.
    """
    object_ids = [
        str(item.get("id") or "")
        for item in (manifest or {}).get("objects", [])
        if isinstance(item, dict) and item.get("id")
    ]
    if not object_ids:
        return code

    try:
        tree = ast.parse(code or "")
    except SyntaxError:
        return code
    construct = _find_scene_construct(tree)
    if construct is None or not getattr(construct, "end_lineno", None):
        return code

    lines = (code or "").splitlines()
    insert_at = int(construct.end_lineno or len(lines))
    indent = _body_indent(lines, construct)
    object_map = "{\n" + "".join(
        f'{indent}    {json.dumps(object_id)}: locals().get({json.dumps(object_id)}),\n'
        for object_id in object_ids
    ) + indent + "}"
    call_lines = [
        f"{indent}try:",
        f"{indent}    _icecream_studio_export(self, {object_map}, {json.dumps(manifest_path)})",
        f"{indent}except Exception:",
        f"{indent}    pass",
    ]
    patched_lines = lines[:insert_at] + call_lines + lines[insert_at:]
    return "\n".join(patched_lines) + "\n" + _runtime_recorder_source()
