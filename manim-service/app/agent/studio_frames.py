"""Studio key-frame selection for interactive Manim editing."""

from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path
from typing import Any


DEFAULT_FRAME_RATIOS = [0.08, 0.20, 0.35, 0.50, 0.65, 0.80, 0.92]


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:
        return default
    return number


def _manifest_objects(manifest: dict[str, Any] | None) -> list[dict[str, Any]]:
    objects = (manifest or {}).get("objects")
    if not isinstance(objects, list):
        return []
    return [item for item in objects if isinstance(item, dict)]


def _object_visible_in_frame(obj: dict[str, Any], frame: dict[str, Any]) -> bool:
    frame_id = str(frame.get("frameId") or "")
    ratio = _safe_float(frame.get("ratio"), _safe_float(frame.get("timeRatio"), 0.0))
    bboxes = obj.get("bboxes")
    if isinstance(bboxes, list) and bboxes:
        for entry in bboxes:
            if not isinstance(entry, dict):
                continue
            if str(entry.get("frameId") or "") == frame_id:
                return True
            time_range = entry.get("timeRange")
            if isinstance(time_range, list) and len(time_range) == 2:
                start = _safe_float(time_range[0], 0.0)
                end = _safe_float(time_range[1], 1.0)
                if start <= ratio <= end:
                    return True
        return False
    return bool(obj.get("bbox") or obj.get("id"))


def _frame_object_ids(frame: dict[str, Any], objects: list[dict[str, Any]]) -> list[str]:
    if _safe_float(frame.get("foregroundArea"), 0.0) <= 0.003:
        return []
    ids: list[str] = []
    for obj in objects:
        object_id = str(obj.get("id") or "")
        if object_id and _object_visible_in_frame(obj, frame):
            ids.append(object_id)
    return ids


def _score_frame(frame: dict[str, Any], object_ids: list[str]) -> tuple[float, str]:
    foreground_area = _safe_float(frame.get("foregroundArea"), 0.0)
    clarity = _safe_float(frame.get("clarity"), 0.75)
    edge_risk = _safe_float(frame.get("edgeRisk"), 0.0)
    overlap_risk = _safe_float(frame.get("overlapRisk"), 0.0)
    score = len(object_ids) * 100.0 + min(foreground_area, 0.30) * 140.0 + clarity * 15.0
    score -= edge_risk * 80.0 + overlap_risk * 60.0
    if not object_ids:
        score -= 160.0
    if foreground_area <= 0.003:
        return score, "画面内容较少，不适合作为默认校准帧"
    if len(object_ids) >= 3:
        return score, "元素最多且画面清晰，适合进行位置校准"
    return score, "画面可用于校准，但可编辑对象较少"


def build_studio_frame_set_from_candidates(
    candidates: list[dict[str, Any]],
    manifest: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build a normalized frame set and choose the best calibration frame."""
    objects = _manifest_objects(manifest)
    frames: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates or []):
        frame = dict(candidate)
        frame.setdefault("frameId", f"frame_{index:02d}")
        frame.setdefault("label", "结尾帧" if _safe_float(frame.get("ratio"), 0.0) >= 0.995 else f"阶段 {index + 1}")
        object_ids = _frame_object_ids(frame, objects)
        score, reason = _score_frame(frame, object_ids)
        frame["objectIds"] = object_ids
        frame["objectCount"] = len(object_ids)
        frame["score"] = round(score, 2)
        frame["reason"] = reason
        frames.append(frame)

    recommended = max(frames, key=lambda item: _safe_float(item.get("score"), -9999.0), default=None)
    recommended_id = str(recommended.get("frameId")) if recommended else ""
    for frame in frames:
        frame["isRecommended"] = str(frame.get("frameId")) == recommended_id
        if frame["isRecommended"]:
            frame["label"] = "推荐帧"

    return {
        "version": "studio-frame-set-v1",
        "recommendedFrameId": recommended_id,
        "frames": frames,
        "objectCount": len(objects),
    }


def _probe_duration(video_path: str) -> float:
    try:
        completed = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                video_path,
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return max(0.1, float((completed.stdout or "").strip()))
    except Exception:
        return 1.0


def _foreground_area(image_path: str) -> float:
    try:
        from PIL import Image, ImageChops, ImageStat

        image = Image.open(image_path).convert("RGB")
        width, height = image.size
        sample = image.crop((0, 0, max(1, width // 12), max(1, height // 12)))
        mean = tuple(int(value) for value in ImageStat.Stat(sample).mean)
        background = Image.new("RGB", image.size, mean)
        diff = ImageChops.difference(image, background).convert("L")
        histogram = diff.histogram()
        changed = sum(count for value, count in enumerate(histogram) if value > 18)
        return round(changed / max(1, width * height), 4)
    except Exception:
        return 0.0


def build_studio_frame_set_for_video(
    video_path: str,
    static_dir: str,
    static_prefix: str,
    request_id: str,
    manifest: dict[str, Any] | None,
    ratios: list[float] | None = None,
) -> dict[str, Any]:
    """Extract candidate frames for Studio calibration.

    Extraction is best-effort. If ffmpeg is unavailable, return an empty frame set
    rather than failing the render.
    """
    ratios = ratios or DEFAULT_FRAME_RATIOS
    duration = _probe_duration(video_path)
    Path(static_dir).mkdir(parents=True, exist_ok=True)
    candidates: list[dict[str, Any]] = []
    unique = uuid.uuid4().hex[:6]

    for index, ratio in enumerate([*ratios, 1.0]):
        ratio = max(0.0, min(1.0, float(ratio)))
        timestamp = max(0.0, min(duration, duration * ratio))
        frame_id = "final" if ratio >= 0.999 else f"frame_{index:02d}"
        filename = f"studio_{request_id}_{unique}_{frame_id}.png"
        output_path = os.path.join(static_dir, filename)
        try:
            completed = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    f"{timestamp:.3f}",
                    "-i",
                    video_path,
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=960:-1",
                    output_path,
                ],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            if completed.returncode != 0 or not os.path.exists(output_path):
                continue
        except Exception:
            continue

        candidates.append(
            {
                "frameId": frame_id,
                "time": round(timestamp, 3),
                "ratio": round(ratio, 4),
                "imageUrl": f"{static_prefix.rstrip('/')}/{filename}",
                "foregroundArea": _foreground_area(output_path),
                "label": "结尾帧" if frame_id == "final" else f"阶段 {index + 1}",
            }
        )

    frame_set = build_studio_frame_set_from_candidates(candidates, manifest)
    if not frame_set.get("frames"):
        frame_set["warning"] = "未能抽取可用于校准的关键帧"
    return frame_set
