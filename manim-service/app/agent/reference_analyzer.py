"""Local reference-image analysis for Manim Agent.

The analyzer intentionally produces compact, prompt-safe metadata instead of
passing file paths or raw image bytes into the agent trace. It is a local
fallback that makes hand-drawn references useful even when no VLM is enabled.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .manim_knowledge import semantic_target_from_brief


SHAPE_TARGETS = {"circle", "square", "triangle"}


def _clip01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _position_label(cx: float, cy: float) -> str:
    horizontal = "左侧" if cx < 0.38 else "右侧" if cx > 0.62 else "居中"
    vertical = "上方" if cy < 0.38 else "下方" if cy > 0.62 else "中部"
    if horizontal == "居中" and vertical == "中部":
        return "画面中心"
    return f"{vertical}{horizontal}"


def _shape_scores(mask: np.ndarray) -> dict[str, Any]:
    coords = np.argwhere(mask)
    if coords.size == 0:
        return {"available": False}

    top, left = coords.min(axis=0)
    bottom, right = coords.max(axis=0)
    box = mask[top : bottom + 1, left : right + 1]
    height, width = box.shape[:2]
    if height < 10 or width < 10:
        return {"available": False, "subjectPixels": int(mask.sum())}

    yy, xx = np.argwhere(box).T
    cx = float(xx.mean())
    cy = float(yy.mean())
    distances = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    radial_cv = float(distances.std() / max(distances.mean(), 1.0))
    aspect = float(width / max(height, 1))
    aspect_score = min(aspect, 1.0 / max(aspect, 0.01))

    # Resize profile by bands. These heuristics are deliberately simple and are
    # used as constraints, not as hard visual recognition truth.
    row_widths = box.sum(axis=1).astype(np.float32)
    col_heights = box.sum(axis=0).astype(np.float32)
    max_row = max(float(row_widths.max()), 1.0)
    max_col = max(float(col_heights.max()), 1.0)
    rows = row_widths / max_row
    cols = col_heights / max_col
    third_h = max(1, len(rows) // 3)
    third_w = max(1, len(cols) // 3)
    top_width = float(rows[:third_h].mean())
    mid_width = float(rows[third_h : third_h * 2].mean()) if len(rows) >= third_h * 2 else float(rows.mean())
    bottom_width = float(rows[-third_h:].mean())
    left_height = float(cols[:third_w].mean())
    mid_height = float(cols[third_w : third_w * 2].mean()) if len(cols) >= third_w * 2 else float(cols.mean())
    right_height = float(cols[-third_w:].mean())

    vertical_symmetry = 1.0 - float(np.mean(np.abs(rows - rows[::-1]))) if len(rows) > 1 else 0.0
    horizontal_symmetry = 1.0 - float(np.mean(np.abs(cols - cols[::-1]))) if len(cols) > 1 else 0.0
    symmetry = _clip01((vertical_symmetry + horizontal_symmetry) / 2.0)

    circle_score = _clip01(
        0.36 * aspect_score
        + 0.34 * symmetry
        + 0.30 * (1.0 - min(radial_cv, 0.85) / 0.85)
    )
    triangle_score = _clip01(
        0.42 * max(bottom_width - top_width, mid_width - top_width, 0.0)
        + 0.28 * max(mid_width - top_width, 0.0)
        + 0.30 * aspect_score
    )
    square_border_score = _clip01((top_width + bottom_width + left_height + right_height) / 4.0)
    square_score = _clip01(
        0.40 * aspect_score
        + 0.34 * square_border_score
        + 0.26 * (1.0 - min(abs(mid_width - mid_height), 1.0))
    )

    scores = {
        "circle": round(circle_score, 3),
        "square": round(square_score, 3),
        "triangle": round(triangle_score, 3),
    }
    likely_shape = max(scores, key=scores.get)
    confidence = float(scores[likely_shape])
    if confidence < 0.48:
        likely_shape = "unknown"

    return {
        "available": True,
        "subjectPixels": int(mask.sum()),
        "bbox": {
            "x": round(float(left), 3),
            "y": round(float(top), 3),
            "width": round(float(width), 3),
            "height": round(float(height), 3),
        },
        "aspect": round(aspect, 3),
        "fillRatio": round(float(box.mean()), 4),
        "radialCv": round(radial_cv, 3),
        "symmetry": round(symmetry, 3),
        "scores": scores,
        "likelyShape": likely_shape,
        "confidence": round(confidence, 3),
    }


def analyze_reference_image(record: dict[str, Any]) -> dict[str, Any]:
    """Analyze one private reference record and return public-safe metadata."""
    reference_id = str(record.get("referenceId") or "")
    filename = str(record.get("filename") or reference_id or "参考图")
    width = int(record.get("width") or 0)
    height = int(record.get("height") or 0)
    path = Path(str(record.get("path") or ""))

    base = {
        "referenceId": reference_id,
        "filename": filename,
        "width": width,
        "height": height,
        "status": "warning",
        "summary": "参考图尚未完成解析。",
        "warnings": [],
        "objects": [],
        "visualConstraints": [],
    }

    try:
        with Image.open(path) as image:
            image = image.convert("RGB")
            original_width, original_height = image.size
            if original_width <= 0 or original_height <= 0:
                raise ValueError("empty image")
            if max(original_width, original_height) > 640:
                image.thumbnail((640, 640))
            arr = np.asarray(image).astype(np.int16)
    except Exception:
        return {
            **base,
            "status": "error",
            "summary": "参考图无法读取，已跳过该素材。",
            "warnings": ["参考图文件读取失败。"],
        }

    h, w = arr.shape[:2]
    corner = np.concatenate(
        [
            arr[:12, :12].reshape(-1, 3),
            arr[:12, -12:].reshape(-1, 3),
            arr[-12:, :12].reshape(-1, 3),
            arr[-12:, -12:].reshape(-1, 3),
        ]
    )
    bg = np.median(corner, axis=0)
    diff = np.linalg.norm(arr - bg, axis=2)
    luma = np.asarray(Image.fromarray(arr.astype(np.uint8)).convert("L")).astype(np.int16)
    mask = (diff > 24) | (luma < 210)
    line_density = float(mask.mean())

    if line_density < 0.0018:
        return {
            **base,
            "status": "warning",
            "lineDensity": round(line_density, 4),
            "summary": "参考图内容过少，未检测到可用线稿。",
            "warnings": ["参考图接近空白，请补充更清晰的线条或形状。"],
        }

    shape = _shape_scores(mask)
    if not shape.get("available"):
        return {
            **base,
            "status": "warning",
            "lineDensity": round(line_density, 4),
            "summary": "参考图有笔迹，但主体轮廓不够稳定。",
            "warnings": ["未能稳定识别主体轮廓。"],
        }

    bbox = shape["bbox"]
    bbox_norm = {
        "x": round(bbox["x"] / w, 3),
        "y": round(bbox["y"] / h, 3),
        "width": round(bbox["width"] / w, 3),
        "height": round(bbox["height"] / h, 3),
    }
    center_x = bbox_norm["x"] + bbox_norm["width"] / 2
    center_y = bbox_norm["y"] + bbox_norm["height"] / 2
    position = _position_label(center_x, center_y)
    likely_shape = shape.get("likelyShape") or "unknown"
    object_label = {
        "circle": "圆形主体",
        "square": "正方形主体",
        "triangle": "三角形主体",
    }.get(likely_shape, "线稿主体")
    summary = (
        f"检测到 1 个{position}的{object_label}，建议用干净的 Manim 图形重绘。"
        if likely_shape != "unknown"
        else f"检测到 1 个{position}的线稿主体，建议保留其构图和主体位置。"
    )

    constraints = [
        f"参考图主体位于{position}，生成时保持相近的主体位置和画面重心。",
        "最终动画不要直接嵌入参考图本身，应使用 Manim 对象干净重绘。",
    ]
    if likely_shape in SHAPE_TARGETS:
        constraints.append(f"参考图主体更像{object_label}，生成时优先使用对应 Manim 几何对象。")

    return {
        **base,
        "status": "pass",
        "summary": summary,
        "lineDensity": round(line_density, 4),
        "subject": {
            "bbox": bbox_norm,
            "center": {"x": round(center_x, 3), "y": round(center_y, 3)},
            "position": position,
            "likelyShape": likely_shape,
            "confidence": shape.get("confidence"),
            "scores": shape.get("scores", {}),
            "areaRatio": round(bbox_norm["width"] * bbox_norm["height"], 4),
        },
        "objects": [likely_shape] if likely_shape in SHAPE_TARGETS else [],
        "visualConstraints": constraints,
    }


def analyze_references(records: list[dict[str, Any]], brief: dict[str, Any] | None = None) -> dict[str, Any]:
    specs = [analyze_reference_image(record) for record in records]
    usable = [spec for spec in specs if spec.get("status") == "pass"]
    reference_target = ""
    if usable:
        candidates = [
            str((spec.get("subject") or {}).get("likelyShape") or "")
            for spec in usable
            if str((spec.get("subject") or {}).get("likelyShape") or "") in SHAPE_TARGETS
        ]
        if candidates:
            reference_target = candidates[0]

    text_target = semantic_target_from_brief(brief or {})
    conflict = ""
    if text_target in SHAPE_TARGETS and reference_target in SHAPE_TARGETS and text_target != reference_target:
        conflict = f"参考图更像{_shape_name(reference_target)}，但文字请求是{_shape_name(text_target)}，已按文字优先。"

    summary = "未使用参考素材。"
    if specs:
        summary = "；".join(spec.get("summary", "") for spec in specs[:3] if spec.get("summary"))
    if conflict:
        summary = f"{summary} {conflict}"

    return {
        "status": "pass" if usable else "warning" if specs else "skipped",
        "summary": summary,
        "referenceSpecs": specs,
        "referenceSemanticTarget": "" if conflict else reference_target,
        "textSemanticTarget": text_target,
        "conflict": conflict,
        "warnings": [warning for spec in specs for warning in spec.get("warnings", [])] + ([conflict] if conflict else []),
    }


def _shape_name(shape: str) -> str:
    return {
        "circle": "圆形",
        "square": "正方形",
        "triangle": "三角形",
    }.get(shape, shape or "未知对象")
