"""Storyboard director for Manim Agent v4."""

from __future__ import annotations

import json
import re
from typing import Any


REQUIRED_FIELDS = (
    "version",
    "topic",
    "audience",
    "teaching_goal",
    "domain",
    "animation_type",
    "visual_objects",
    "layout_zones",
    "shots",
    "risks",
)


def _extract_json(text: str) -> dict[str, Any]:
    if not text:
        raise ValueError("empty director response")
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    raw = fenced.group(1) if fenced else text
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("director response did not contain a JSON object")
    return json.loads(raw[start : end + 1])


def _coerce_spec(data: dict[str, Any], brief: dict[str, Any]) -> dict[str, Any]:
    shots = data.get("shots")
    if not isinstance(shots, list) or len(shots) < 2:
        raise ValueError("storyboard requires at least two shots")

    normalized_shots: list[dict[str, Any]] = []
    for index, shot in enumerate(shots[:5], start=1):
        if not isinstance(shot, dict):
            raise ValueError("each shot must be an object")
        normalized_shots.append({
            "id": int(shot.get("id") or index),
            "title": str(shot.get("title") or f"Step {index}")[:60],
            "narration": str(shot.get("narration") or shot.get("title") or "")[:120],
            "visual": str(shot.get("visual") or "")[:160],
            "animation": str(shot.get("animation") or "reveal")[:80],
        })

    spec = {
        "version": "v4",
        "topic": str(data.get("topic") or brief.get("message") or "Manim animation")[:80],
        "audience": str(data.get("audience") or "students"),
        "teaching_goal": str(data.get("teaching_goal") or "Explain the idea clearly with staged visuals."),
        "domain": str(data.get("domain") or brief.get("domain") or "concept"),
        "animation_type": str(data.get("animation_type") or brief.get("animation_type") or "concept_explanation"),
        "visual_objects": [str(item) for item in data.get("visual_objects", [])][:10],
        "layout_zones": [str(item) for item in data.get("layout_zones", ["header", "step", "visual", "summary"])][:6],
        "shots": normalized_shots,
        "risks": [str(item) for item in data.get("risks", [])][:8],
        "constraints": [
            "Use Text for Chinese and MathTex only for formulas.",
            "Keep title, step banner, visual area, and summary separated.",
            "Prefer simple high-contrast teaching visuals over decorative complexity.",
        ],
    }
    for field in REQUIRED_FIELDS:
        if field not in spec:
            raise ValueError(f"missing storyboard field: {field}")
    return spec


def build_director_messages(brief: dict[str, Any], current_code: str = "") -> list[dict[str, str]]:
    system = (
        "You are an expert educational animation director for Manim. "
        "Return strict JSON only. Do not return code. Design a concise premium "
        "teaching storyboard that can be rendered in a 16:9 Manim scene."
    )
    user = {
        "request": brief.get("message", ""),
        "mode": "modify" if current_code.strip() else "create",
        "intent": brief.get("intent"),
        "domain": brief.get("domain"),
        "animation_type": brief.get("animation_type"),
        "current_code_summary": brief.get("currentCodeSummary", {}),
        "required_json_shape": {
            "version": "v4",
            "topic": "short title",
            "audience": "students",
            "teaching_goal": "one sentence",
            "domain": "math|geometry|data|physics|flow|concept|code",
            "animation_type": "specific animation type",
            "visual_objects": ["objects that must appear"],
            "layout_zones": ["header", "step", "visual", "summary"],
            "shots": [
                {
                    "id": 1,
                    "title": "short step label",
                    "narration": "what the learner should understand",
                    "visual": "what appears on screen",
                    "animation": "how it appears",
                }
            ],
            "risks": ["semantic mismatch", "text overlap"],
        },
    }
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
    ]


async def design_storyboard(
    brief: dict[str, Any],
    *,
    ai_client: Any | None,
    model_name: str | None,
    current_code: str = "",
) -> dict[str, Any]:
    """Ask the model for a v4 StoryboardSpec and validate it."""
    if ai_client is None or not model_name:
        return {
            "status": "error",
            "summary": "Manim Agent v4 requires an AI client to design the storyboard.",
            "storyboardSpec": None,
            "next_actions": ["Configure DEEPSEEK_API_KEY and restart the Manim service."],
        }

    try:
        response = await ai_client.chat.completions.create(
            model=model_name,
            messages=build_director_messages(brief, current_code=current_code),
            temperature=0.25,
            stream=False,
        )
        content = response.choices[0].message.content
        spec = _coerce_spec(_extract_json(content), brief)
        return {
            "status": "success",
            "summary": "Storyboard designed.",
            "storyboardSpec": spec,
            "next_actions": ["Select style and write Manim code."],
        }
    except Exception as exc:
        return {
            "status": "error",
            "summary": f"Storyboard design failed: {exc}",
            "storyboardSpec": None,
            "next_actions": ["Retry with a clearer prompt or check the model response format."],
        }

