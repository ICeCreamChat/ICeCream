"""Rendered-frame visual quality checks for Manim Agent v4."""

from __future__ import annotations

import base64
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageStat

from app import service_config


def _finding(severity: str, message: str, hint: str) -> dict[str, str]:
    return {"severity": severity, "message": message, "hint": hint}


def _short_reason(value: Any, fallback: str = "未知渲染错误") -> str:
    text = str(value or "").replace("\r\n", "\n").strip()
    if not text:
        return fallback
    text = " ".join(line.strip() for line in text.splitlines() if line.strip())
    return text[-360:]


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
        f"fps=1,scale=640:-1",
        "-frames:v",
        str(count),
        str(pattern),
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
    if result.returncode != 0:
        return []
    return sorted(frame_dir.glob("frame_*.png"))


def inspect_frame_quality(frame_paths: list[Path]) -> dict[str, Any]:
    findings: list[dict[str, str]] = []
    metrics: dict[str, Any] = {"frames": len(frame_paths)}

    if not frame_paths:
        return {
            "status": "warning",
            "summary": "未能抽取预览帧，已跳过像素级检查。",
            "findings": [_finding("warning", "未抽取到预览帧。", "请安装 ffmpeg，或手动检查渲染输出。")],
            "metrics": metrics,
        }

    non_background_ratios: list[float] = []
    contrasts: list[float] = []
    edge_ratios: list[float] = []

    for frame_path in frame_paths:
        with Image.open(frame_path).convert("RGB") as image:
            arr = np.asarray(image).astype(np.int16)
            h, w = arr.shape[:2]
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
            gray = image.convert("L")
            contrasts.append(float(ImageStat.Stat(gray).stddev[0]))
            border = np.zeros_like(mask)
            border[:18, :] = True
            border[-18:, :] = True
            border[:, :18] = True
            border[:, -18:] = True
            edge_ratios.append(float((mask & border).sum() / max(mask.sum(), 1)))

    metrics.update({
        "nonBackgroundRatio": round(max(non_background_ratios), 4),
        "contrast": round(max(contrasts), 2),
        "edgeContentRatio": round(max(edge_ratios), 4),
    })

    if metrics["nonBackgroundRatio"] < 0.015:
        findings.append(_finding(
            "error",
            "预览画面为空或接近空白。",
            "请确保场景中添加了可见 Manim 对象和动画。",
        ))
    elif metrics["nonBackgroundRatio"] < 0.04:
        findings.append(_finding(
            "warning",
            "主体画面占比过小。",
            "请放大中心视觉组，并减少无意义留白。",
        ))

    if metrics["contrast"] < 8:
        findings.append(_finding(
            "error",
            "预览画面对比度过低。",
            "请使用高对比度教学配色。",
        ))

    if metrics["edgeContentRatio"] > 0.18:
        findings.append(_finding(
            "warning",
            "重要内容过于靠近画面边缘。",
            "请把对象移动或缩放到安全布局区域内。",
        ))

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


def inspect_visual_quality(
    code: str,
    brief: dict[str, Any] | None = None,
    render_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    findings: list[dict[str, str]] = []
    render_result = render_result or {}

    if render_result:
        if not render_result.get("success"):
            reason = _render_failure_reason(render_result)
            findings.append(_finding(
                "error",
                f"预览渲染失败：{reason}",
                "请根据错误原因修复代码后再进行最终渲染。",
            ))
        if render_result.get("success") and not render_result.get("videoUrl"):
            findings.append(_finding(
                "error",
                "预览渲染没有返回可播放视频。",
                "渲染结果必须包含可播放的视频文件。",
            ))

    video_path = _video_path_from_url(render_result.get("videoUrl"))
    file_size = video_path.stat().st_size if video_path and video_path.exists() else 0
    artifact_size = max(file_size, _base64_size(render_result.get("videoBase64")))

    if render_result.get("success") and artifact_size and artifact_size < 4096:
        findings.append(_finding("error", "预览视频过小，可能为空。", "请重新生成包含可见对象和动画的场景。"))
    elif render_result.get("success") and artifact_size and artifact_size < 40_000:
        findings.append(_finding("warning", "预览视频文件偏小。", "请检查是否存在空白帧或动画时长过短。"))

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

    if "self.wait" not in (code or ""):
        findings.append(_finding("warning", "动画结尾缺少阅读停顿。", "请在结尾添加 self.wait(1)。"))

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
