"""Rendered-frame visual quality checks for Manim Agent v6."""

from __future__ import annotations

import base64
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageStat

from app import service_config


def _finding(severity: str, message: str, hint: str, code: str = "") -> dict[str, str]:
    payload = {"severity": severity, "message": message, "hint": hint}
    if code:
        payload["code"] = code
    return payload


def _short_reason(value: Any, fallback: str = "未知渲染错误") -> str:
    text = str(value or "").replace("\r\n", "\n").strip()
    if not text:
        return fallback
    text = " ".join(line.strip() for line in text.splitlines() if line.strip())
    return text[-420:]


def _render_failure_reason(render_result: dict[str, Any]) -> str:
    reason = _short_reason(
        render_result.get("details")
        or render_result.get("stderr")
        or render_result.get("error")
        or render_result.get("errorType")
    )
    lower = reason.lower()
    if render_result.get("errorType") == "scene_class_missing":
        return "未找到可渲染 Scene 类。请使用 class MainScene(SafeScene, Scene):"
    attr_match = re.search(
        r"AttributeError:\s*'([^']+)'\s*object has no attribute\s*'([^']+)'",
        reason,
    )
    if attr_match:
        owner, method = attr_match.groups()
        return f"代码调用了不存在的 {owner} 方法：{owner}.{method}()。请改用合法 Manim 对象方法或显式向量计算。"
    if "latex" in lower or "tex" in lower:
        return f"LaTeX/公式渲染失败：{reason}"
    if "nameerror" in lower:
        return f"名称未定义：{reason}"
    if "syntaxerror" in lower:
        return f"Python 语法错误：{reason}"
    if "module named manim" in lower:
        return "当前 Python 环境没有安装 Manim，请使用 py3.12 创建的 manim-service\\.venv。"
    return reason


def _video_path_from_url(video_url: str | None) -> Path | None:
    if not video_url or not video_url.startswith("/static/"):
        return None
    filename = video_url.removeprefix("/static/").split("?", 1)[0]
    return Path(service_config.STATIC_DIR) / filename


def _base64_size(video_base64: str | None) -> int:
    if not video_base64:
        return 0
    try:
        return len(base64.b64decode(video_base64, validate=False))
    except Exception:
        return len(video_base64)


def _extract_frames(video_path: Path, frame_dir: Path, count: int = 3) -> list[Path]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return []
    pattern = frame_dir / "frame_%02d.png"
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(video_path),
        "-vf",
        "fps=1,scale=640:-1",
        "-frames:v",
        str(count),
        str(pattern),
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
    if result.returncode != 0:
        return []
    return sorted(frame_dir.glob("frame_*.png"))


def _clip01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _wants_circle(brief: dict[str, Any] | None) -> bool:
    spec = (brief or {}).get("storyboardSpec") or (brief or {}).get("spec") or {}
    kind = str(spec.get("kind") or spec.get("animation_type") or (brief or {}).get("animation_type") or "")
    message = str((brief or {}).get("message") or "").lower()
    return kind == "geometry_circle" or "\u5706" in message or "circle" in message


def _wants_triangle(brief: dict[str, Any] | None) -> bool:
    spec = (brief or {}).get("storyboardSpec") or (brief or {}).get("spec") or {}
    kind = str(spec.get("kind") or spec.get("animation_type") or (brief or {}).get("animation_type") or "")
    message = str((brief or {}).get("message") or "").lower()
    return kind in {"geometry_proof", "triangle"} or "\u4e09\u89d2" in message or "triangle" in message


def _wants_square(brief: dict[str, Any] | None) -> bool:
    spec = (brief or {}).get("storyboardSpec") or (brief or {}).get("spec") or {}
    kind = str(spec.get("kind") or spec.get("animation_type") or (brief or {}).get("animation_type") or "")
    message = str((brief or {}).get("message") or "").lower()
    return kind == "square" or "\u6b63\u65b9\u5f62" in message or "square" in message


def _shape_metrics_from_image(image: Image.Image) -> dict[str, Any]:
    """Estimate whether the dominant central subject looks circular/triangular.

    This is deliberately lightweight: it is not a CV model, but it catches the
    common semantic failure where a circle request produces a triangle.
    """
    arr = np.asarray(image.convert("RGB")).astype(np.int16)
    h, w = arr.shape[:2]
    y0, y1 = int(h * 0.16), int(h * 0.92)
    x0, x1 = int(w * 0.08), int(w * 0.92)
    crop = arr[y0:y1, x0:x1]
    if crop.size == 0:
        return {"available": False}
    corner = np.concatenate([
        crop[:12, :12].reshape(-1, 3),
        crop[:12, -12:].reshape(-1, 3),
        crop[-12:, :12].reshape(-1, 3),
        crop[-12:, -12:].reshape(-1, 3),
    ])
    bg = np.median(corner, axis=0)
    mask = np.linalg.norm(crop - bg, axis=2) > 24
    if mask.mean() < 0.002:
        return {"available": False, "subjectPixels": int(mask.sum())}

    coords = np.argwhere(mask)
    top, left = coords.min(axis=0)
    bottom, right = coords.max(axis=0)
    box = mask[top:bottom + 1, left:right + 1]
    bh, bw = box.shape[:2]
    if bh < 12 or bw < 12:
        return {"available": False, "subjectPixels": int(mask.sum())}

    row_widths = box.sum(axis=1).astype(np.float32)
    row_widths = row_widths[row_widths > 0]
    max_width = float(row_widths.max()) if len(row_widths) else 1.0
    normalized = row_widths / max(max_width, 1.0)
    third = max(1, len(normalized) // 3)
    top_width = float(normalized[:third].mean())
    mid_width = float(normalized[third:third * 2].mean()) if len(normalized) >= third * 2 else float(normalized.mean())
    bottom_width = float(normalized[-third:].mean())

    yy, xx = np.argwhere(box).T
    cx, cy = float(xx.mean()), float(yy.mean())
    distances = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    radial_cv = float(distances.std() / max(distances.mean(), 1.0))
    aspect = float(bw / max(bh, 1))
    fill_ratio = float(box.mean())
    symmetry = 1.0 - float(np.mean(np.abs(normalized - normalized[::-1]))) if len(normalized) > 1 else 0.0
    aspect_score = min(aspect, 1.0 / max(aspect, 0.01))

    circle_score = _clip01(0.35 * aspect_score + 0.35 * symmetry + 0.30 * (1.0 - min(radial_cv, 0.9) / 0.9))
    triangle_slope = max(abs(bottom_width - top_width), abs(mid_width - top_width), abs(bottom_width - mid_width))
    triangle_score = _clip01(0.45 * triangle_slope + 0.25 * (1.0 - symmetry) + 0.30 * (1.0 - abs(fill_ratio - 0.50) / 0.50))

    return {
        "available": True,
        "subjectPixels": int(mask.sum()),
        "shapeAspect": round(aspect, 3),
        "shapeFillRatio": round(fill_ratio, 3),
        "shapeSymmetry": round(symmetry, 3),
        "shapeRadialCv": round(radial_cv, 3),
        "circleScore": round(circle_score, 3),
        "triangleScore": round(triangle_score, 3),
    }


def inspect_frame_quality(frame_paths: list[Path]) -> dict[str, Any]:
    findings: list[dict[str, str]] = []
    metrics: dict[str, Any] = {"frames": len(frame_paths)}

    if not frame_paths:
        return {
            "status": "warning",
            "summary": "未能抽取预览帧，已跳过像素级检查。",
            "findings": [_finding("warning", "未抽取到预览帧。", "请安装 ffmpeg，或手动检查渲染输出。", "frame_extract_missing")],
            "metrics": metrics,
        }

    non_background_ratios: list[float] = []
    contrasts: list[float] = []
    edge_ratios: list[float] = []
    dark_edge_ratios: list[float] = []
    center_light_ratios: list[float] = []
    shape_reports: list[dict[str, Any]] = []

    for frame_path in frame_paths:
        with Image.open(frame_path).convert("RGB") as image:
            shape_reports.append(_shape_metrics_from_image(image))
            arr = np.asarray(image).astype(np.int16)
            h, w = arr.shape[:2]
            gray = image.convert("L")
            luma = np.asarray(gray).astype(np.float32)
            corner_samples = np.concatenate([
                arr[:20, :20].reshape(-1, 3),
                arr[:20, -20:].reshape(-1, 3),
                arr[-20:, :20].reshape(-1, 3),
                arr[-20:, -20:].reshape(-1, 3),
            ])
            bg = np.median(corner_samples, axis=0)
            diff = np.linalg.norm(arr - bg, axis=2)
            mask = diff > 18
            non_background_ratios.append(float(mask.mean()))
            contrasts.append(float(ImageStat.Stat(gray).stddev[0]))
            border = np.zeros_like(mask)
            border[:18, :] = True
            border[-18:, :] = True
            border[:, :18] = True
            border[:, -18:] = True
            edge_ratios.append(float((mask & border).sum() / max(mask.sum(), 1)))
            dark_edge_ratios.append(float((luma[border] < 32).mean()))
            center = luma[h // 5:h - h // 5, w // 5:w - w // 5]
            center_light_ratios.append(float((center > 180).mean()))

    available_shapes = [item for item in shape_reports if item.get("available")]
    shape_metrics = max(available_shapes, key=lambda item: item.get("subjectPixels", 0), default={"available": False})

    metrics.update({
        "nonBackgroundRatio": round(max(non_background_ratios), 4),
        "contrast": round(max(contrasts), 2),
        "edgeContentRatio": round(max(edge_ratios), 4),
        "darkEdgeRatio": round(max(dark_edge_ratios), 4),
        "centerLightRatio": round(max(center_light_ratios), 4),
        "shape": shape_metrics,
    })

    if metrics["nonBackgroundRatio"] < 0.008:
        findings.append(_finding("error", "预览画面为空或接近空白。", "确保场景中添加了可见 Manim 对象和动画。", "blank_frame"))
    elif metrics["nonBackgroundRatio"] < 0.035:
        findings.append(_finding("warning", "主体画面占比过小。", "放大中心视觉组，并减少无意义留白。", "subject_too_small"))

    if metrics["contrast"] < 5:
        findings.append(_finding("error", "预览画面对比度过低。", "使用高对比度教学配色。", "low_contrast"))

    if 5 <= metrics["contrast"] < 9:
        findings.append(_finding("warning", "预览画面对比度偏低。", "加粗主体线条并使用更深的教学主色。", "low_contrast_warning"))

    if metrics["darkEdgeRatio"] > 0.45 and metrics["centerLightRatio"] > 0.20:
        findings.append(_finding(
            "error",
            "画面存在明显黑色边框或黑色留白。",
            "使用浅色相机背景铺满 16:9 画布，不要把内容放进小于画布的白色内框。",
            "black_border",
        ))

    if metrics["edgeContentRatio"] > 0.18:
        findings.append(_finding("warning", "重要内容过于靠近画面边缘。", "把对象移动或缩放到安全布局区域内。", "edge_overflow"))

    if any(item["severity"] == "error" for item in findings):
        status = "error"
    elif findings:
        status = "warning"
    else:
        status = "pass"

    return {
        "status": status,
        "summary": "预览帧检查通过。" if not findings else "；".join(item["message"] for item in findings[:2]),
        "findings": findings,
        "metrics": metrics,
    }


def _semantic_findings(code: str, brief: dict[str, Any] | None) -> list[dict[str, str]]:
    source = code or ""
    spec = (brief or {}).get("storyboardSpec") or (brief or {}).get("spec") or {}
    kind = str(spec.get("kind") or spec.get("animation_type") or (brief or {}).get("animation_type") or "")
    message = str((brief or {}).get("message") or "").lower()
    findings: list[dict[str, str]] = []
    has_circle = bool(re.search(r"\bCircle\s*\(", source))
    has_square = bool(re.search(r"\bSquare\s*\(", source))
    has_triangle = bool(re.search(r"\b(Triangle|Polygon)\s*\(", source))

    if _wants_circle(brief):
        if not has_circle:
            findings.append(_finding("error", "语义检查失败：圆形请求没有生成圆形主体。", "使用 Circle() 作为主体对象。", "semantic_circle_missing"))
        if has_triangle and not has_circle:
            findings.append(_finding("error", "语义检查失败：圆形请求被三角形替代。", "不要把圆形提示改成三角形动画。", "semantic_circle_triangle"))

    if _wants_triangle(brief):
        if not has_triangle:
            findings.append(_finding("error", "语义检查失败：三角形请求没有生成三角形主体。", "使用 Triangle() 或 Polygon() 绘制三角形。", "semantic_triangle_missing"))

    if _wants_square(brief):
        if not has_square:
            findings.append(_finding("error", "语义检查失败：正方形请求没有生成正方形主体。", "使用 Square() 作为主体对象。", "semantic_square_missing"))
        if (has_circle or has_triangle) and not has_square:
            findings.append(_finding("error", "语义检查失败：正方形请求被其他几何图形替代。", "不要把正方形提示改成圆形或三角形动画。", "semantic_square_mismatch"))

    return findings


def _reference_alignment_findings(code: str, brief: dict[str, Any] | None) -> list[dict[str, str]]:
    data = brief or {}
    if data.get("referenceConflict"):
        return []
    target = str(data.get("referenceSemanticTarget") or "").lower()
    if not target:
        for spec in data.get("referenceSpecs") or []:
            subject = spec.get("subject") if isinstance(spec, dict) else {}
            target = str((subject or {}).get("likelyShape") or "").lower()
            if target:
                break
    if target not in {"circle", "square", "triangle"}:
        return []

    source = code or ""
    has_circle = bool(re.search(r"\bCircle\s*\(", source))
    has_square = bool(re.search(r"\bSquare\s*\(", source))
    has_triangle = bool(re.search(r"\b(Triangle|Polygon)\s*\(", source))
    if target == "circle" and not has_circle:
        return [_finding("error", "参考图显示圆形主体，但生成代码没有 Circle 对象。", "用 Circle() 重绘参考图中的圆形主体。", "reference_circle_missing")]
    if target == "square" and not has_square:
        return [_finding("error", "参考图显示正方形主体，但生成代码没有 Square 对象。", "用 Square() 重绘参考图中的正方形主体。", "reference_square_missing")]
    if target == "triangle" and not has_triangle:
        return [_finding("error", "参考图显示三角形主体，但生成代码没有 Triangle 或 Polygon 对象。", "用 Triangle() 或 Polygon() 重绘参考图中的三角形主体。", "reference_triangle_missing")]
    return []


def inspect_visual_quality(
    code: str,
    brief: dict[str, Any] | None = None,
    render_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    findings: list[dict[str, str]] = []
    render_result = render_result or {}
    findings.extend(_semantic_findings(code, brief))
    findings.extend(_reference_alignment_findings(code, brief))
    source = code or ""
    code_has_circle = bool(re.search(r"\bCircle\s*\(", source))
    code_has_square = bool(re.search(r"\bSquare\s*\(", source))
    code_has_triangle = bool(re.search(r"\b(Triangle|Polygon)\s*\(", source))

    if render_result:
        if not render_result.get("success"):
            reason = _render_failure_reason(render_result)
            findings.append(_finding("error", f"预览渲染失败：{reason}", "根据错误原因修复代码后再渲染。", "preview_render_failed"))
        if render_result.get("success") and not render_result.get("videoUrl"):
            findings.append(_finding("error", "预览渲染没有返回可播放视频。", "渲染结果必须包含可播放的视频文件。", "preview_video_missing"))

    video_path = _video_path_from_url(render_result.get("videoUrl"))
    file_size = video_path.stat().st_size if video_path and video_path.exists() else 0
    artifact_size = max(file_size, _base64_size(render_result.get("videoBase64")))

    if render_result.get("success") and artifact_size and artifact_size < 4096:
        findings.append(_finding("error", "预览视频过小，可能为空。", "重新生成包含可见对象和动画的场景。", "tiny_video"))
    elif render_result.get("success") and artifact_size and artifact_size < 40_000:
        findings.append(_finding("warning", "预览视频文件偏小。", "检查是否存在空白帧或动画时长过短。", "small_video"))

    frame_report: dict[str, Any] = {
        "status": "skipped",
        "summary": "未执行抽帧检查。",
        "findings": [],
        "metrics": {},
    }
    if video_path and video_path.exists():
        with tempfile.TemporaryDirectory(prefix="manim_frames_") as tmp:
            frame_paths = _extract_frames(video_path, Path(tmp))
            frame_report = inspect_frame_quality(frame_paths)
            findings.extend(frame_report.get("findings", []))
            shape = (frame_report.get("metrics") or {}).get("shape") or {}
            if shape.get("available"):
                circle_score = float(shape.get("circleScore") or 0)
                triangle_score = float(shape.get("triangleScore") or 0)
                if (
                    _wants_circle(brief)
                    and triangle_score > max(0.45, circle_score + 0.18)
                    and (not code_has_circle or code_has_triangle)
                ):
                    findings.append(_finding(
                        "error",
                        "视觉语义检查失败：主体画面更像三角形，不像圆形。",
                        "重新生成时必须让 Circle 成为主要可见对象，并避免三角形主体。",
                        "visual_circle_mismatch",
                    ))
                if (
                    _wants_triangle(brief)
                    and circle_score > max(0.48, triangle_score + 0.20)
                    and (not code_has_triangle or code_has_circle)
                ):
                    findings.append(_finding(
                        "error",
                        "视觉语义检查失败：主体画面更像圆形，不像三角形。",
                        "重新生成时必须让 Triangle 或 Polygon 三角形成为主要可见对象。",
                        "visual_triangle_mismatch",
                    ))
                if (
                    _wants_square(brief)
                    and not code_has_square
                    and (code_has_circle or code_has_triangle)
                ):
                    findings.append(_finding(
                        "error",
                        "视觉语义检查失败：正方形请求没有以正方形为主体。",
                        "重新生成时必须让 Square 成为主要可见对象。",
                        "visual_square_mismatch",
                    ))

    if "self.wait" not in (code or ""):
        findings.append(_finding("warning", "动画结尾缺少阅读停顿。", "在结尾添加 self.wait(1)。", "missing_final_wait"))

    if any(item["severity"] == "error" for item in findings):
        status = "error"
    elif findings:
        status = "warning"
    else:
        status = "pass"

    return {
        "status": status,
        "summary": "视觉检查通过。" if not findings else "；".join(item["message"] for item in findings[:2]),
        "findings": findings,
        "metrics": {
            "artifactSize": artifact_size,
            "hasVideoUrl": bool(render_result.get("videoUrl")),
            "previewCheckEnabled": os.environ.get("MANIM_AGENT_PREVIEW_CHECK", "true").lower()
            not in {"0", "false", "off", "no"},
            "frame": frame_report.get("metrics", {}),
        },
    }
