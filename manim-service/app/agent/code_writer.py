"""LLM code writer for Manim Agent v4."""

from __future__ import annotations

import json
import re
from typing import Any

from .scene_runtime import runtime_prompt


def extract_code_from_text(text: str) -> str:
    if not text:
        return ""
    match = re.search(r"```(?:python)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    return (match.group(1) if match else text).strip()


def analyze_current_code(code: str) -> dict[str, Any]:
    return {
        "has_scene": "class " in code and "Scene" in code and "def construct" in code,
        "length": len(code or ""),
        "uses_color": any(color in code for color in ("BLUE", "GREEN", "YELLOW", "WHITE", "RED")),
    }


def build_code_writer_messages(
    brief: dict[str, Any],
    storyboard_spec: dict[str, Any],
    style_preset: dict[str, Any],
    skills: list[dict[str, str]],
    current_code: str = "",
) -> list[dict[str, str]]:
    skill_guidance = "\n".join(f"- {skill['name']}: {skill['guidance']}" for skill in skills)
    system = (
        "You are a senior Manim Community engineer and educational motion designer. "
        "Return one complete Python file only, inside a python code block. "
        "Do not use file, network, subprocess, dynamic execution, or imports outside "
        "manim/math/numpy. The renderable class must be MainScene(SafeScene, Scene). "
        "Use Text/SafeText for Chinese and MathTex/SafeMathTex only for formulas."
    )
    user = {
        "request": brief.get("message", ""),
        "mode": "modify" if current_code.strip() else "create",
        "storyboardSpec": storyboard_spec,
        "stylePreset": style_preset,
        "runtimeHelpers": runtime_prompt(),
        "skills": skill_guidance,
        "currentCode": current_code,
        "hardRequirements": [
            "Include the generic runtime helper code exactly once before MainScene.",
            "Do not return a domain-specific canned template.",
            "Keep all major objects inside frame.",
            "Use at least two staged animations and a final self.wait(1).",
            "If the request asks for a circle, create a Circle object.",
            "If the request asks for sine/cosine axes, use symbolic pi tick labels, not long decimals.",
        ],
    }
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
    ]


async def write_scene_code(
    brief: dict[str, Any],
    storyboard_spec: dict[str, Any],
    style_preset: dict[str, Any],
    skills: list[dict[str, str]],
    *,
    ai_client: Any | None,
    model_name: str | None,
    current_code: str = "",
) -> dict[str, Any]:
    if ai_client is None or not model_name:
        return {
            "status": "error",
            "summary": "Manim Agent v4 requires an AI client to write scene code.",
            "code": "",
            "source": "unavailable",
            "codeSource": "none",
            "analysis": analyze_current_code(current_code) if current_code else {},
            "next_actions": ["Configure DEEPSEEK_API_KEY and restart the Manim service."],
        }

    try:
        response = await ai_client.chat.completions.create(
            model=model_name,
            messages=build_code_writer_messages(brief, storyboard_spec, style_preset, skills, current_code),
            temperature=0.18,
            stream=False,
        )
        code = extract_code_from_text(response.choices[0].message.content)
        if not code:
            raise ValueError("model returned no code")
        return {
            "status": "success",
            "summary": "Scene code written.",
            "code": code,
            "source": "llm_v4",
            "codeSource": "llm_v4",
            "analysis": analyze_current_code(current_code) if current_code else {},
            "next_actions": ["Run static critique and visual checks."],
        }
    except Exception as exc:
        return {
            "status": "error",
            "summary": f"Scene code generation failed: {exc}",
            "code": "",
            "source": "llm_v4",
            "codeSource": "llm_v4",
            "analysis": analyze_current_code(current_code) if current_code else {},
            "next_actions": ["Retry generation or simplify the prompt."],
        }

