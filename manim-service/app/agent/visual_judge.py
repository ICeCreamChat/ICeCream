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
            "summary": "No preview frames were available for pixel inspection.",
            "findings": [_finding("warning", "No preview frames extracted.", "Install ffmpeg or inspect render output manually.")],
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
            "Preview frames appear blank or nearly blank.",
            "Ensure visible Manim objects are added and animated.",
        ))
    elif metrics["nonBackgroundRatio"] < 0.04:
        findings.append(_finding(
            "warning",
            "Main visual content is very small.",
            "Scale the central visual group larger and reduce empty space.",
        ))

    if metrics["contrast"] < 8:
        findings.append(_finding(
            "error",
            "Preview contrast is too low.",
            "Use a high-contrast teaching palette.",
        ))

    if metrics["edgeContentRatio"] > 0.18:
        findings.append(_finding(
            "warning",
            "Significant content is close to the frame edge.",
            "Move or scale objects into the safe layout area.",
        ))

    if any(item["severity"] == "error" for item in findings):
        status = "error"
    elif findings:
        status = "warning"
    else:
        status = "pass"

    return {
        "status": status,
        "summary": "Visual frame inspection passed." if not findings else "; ".join(item["message"] for item in findings[:2]),
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
            findings.append(_finding(
                "error",
                "Preview render failed.",
                render_result.get("error") or render_result.get("details") or "Repair code before final render.",
            ))
        if render_result.get("success") and not render_result.get("videoUrl"):
            findings.append(_finding(
                "error",
                "Preview render did not return a video URL.",
                "Render output must include a playable video artifact.",
            ))

    video_path = _video_path_from_url(render_result.get("videoUrl"))
    file_size = video_path.stat().st_size if video_path and video_path.exists() else 0
    artifact_size = max(file_size, _base64_size(render_result.get("videoBase64")))

    if render_result.get("success") and artifact_size and artifact_size < 4096:
        findings.append(_finding("error", "Preview video is too small.", "Regenerate with visible objects and animations."))
    elif render_result.get("success") and artifact_size and artifact_size < 40_000:
        findings.append(_finding("warning", "Preview video artifact is unusually small.", "Check for blank frames or too-short animation."))

    frame_report: dict[str, Any] = {
        "status": "skipped",
        "summary": "Frame extraction skipped.",
        "findings": [],
        "metrics": {},
    }
    if video_path and video_path.exists():
        with tempfile.TemporaryDirectory(prefix="manim_frames_") as tmp:
            frame_paths = _extract_frames(video_path, Path(tmp))
            frame_report = inspect_frame_quality(frame_paths)
            findings.extend(frame_report.get("findings", []))

    if "self.wait" not in (code or ""):
        findings.append(_finding("warning", "Animation has no final reading pause.", "Add self.wait(1) at the end."))

    if any(item["severity"] == "error" for item in findings):
        status = "error"
    elif findings:
        status = "warning"
    else:
        status = "pass"

    return {
        "status": status,
        "summary": "Visual inspection passed." if not findings else "; ".join(item["message"] for item in findings[:2]),
        "findings": findings,
        "metrics": {
            "artifactSize": artifact_size,
            "hasVideoUrl": bool(render_result.get("videoUrl")),
            "previewCheckEnabled": os.environ.get("MANIM_AGENT_PREVIEW_CHECK", "true").lower()
            not in {"0", "false", "off", "no"},
            "frame": frame_report.get("metrics", {}),
        },
    }

