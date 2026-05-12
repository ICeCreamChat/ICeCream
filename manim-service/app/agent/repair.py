"""Repair helpers for Manim Agent v4."""

from __future__ import annotations

import json
import re
from typing import Any, Callable

from .code_writer import extract_code_from_text
from .critic import critique_code


Fixer = Callable[[str, dict[str, Any]], str]


def build_repair_observation(
    code: str,
    report: dict[str, Any],
    *,
    stderr: str = "",
    attempt: int = 1,
    brief: dict[str, Any] | None = None,
    storyboard_spec: dict[str, Any] | None = None,
    style_preset: dict[str, Any] | None = None,
) -> dict[str, Any]:
    issues = report.get("issues") or report.get("findings") or []
    return {
        "status": report.get("status", "error"),
        "summary": report.get("summary", ""),
        "issues": issues,
        "stderr": stderr[-1200:] if stderr else "",
        "attempt": attempt,
        "root_cause_hint": "; ".join(str(item.get("message", "")) for item in issues[:5]) or stderr[-300:],
        "safe_retry": "Return a complete safer Manim file with the same MainScene contract.",
        "brief": brief or {},
        "storyboardSpec": storyboard_spec or {},
        "stylePreset": style_preset or {},
    }

def static_repair_once(code: str, observation: dict[str, Any]) -> str:
    """Small non-template repairs for common safety/import issues."""
    repaired = code or ""
    if "from manim import" not in repaired:
        repaired = "from manim import *\nimport math\nimport numpy as np\n\n" + repaired
    if "import math" not in repaired:
        repaired = repaired.replace("from manim import *", "from manim import *\nimport math", 1)
    if "import numpy as np" not in repaired:
        repaired = repaired.replace("import math", "import math\nimport numpy as np", 1)

    repaired = re.sub(
        r"^\s*(?:import|from)\s+(os|sys|subprocess|socket|pathlib|shutil|ctypes|signal|multiprocessing|threading|asyncio|requests|urllib|http|ftplib|paramiko)\b.*$",
        "",
        repaired,
        flags=re.MULTILINE,
    )
    repaired = re.sub(r"(?:eval|exec|compile|__import__|open|globals|locals|vars|dir|getattr|setattr|delattr)\s*\([^)]*\)", "None", repaired)
    repaired = re.sub(r"3\.141592653589793\d*", "PI", repaired)
    repaired = re.sub(r"1\.5707963267948966\d*", "PI / 2", repaired)
    repaired = re.sub(r"-3\.141592653589793\d*", "-PI", repaired)
    repaired = re.sub(r"-1\.5707963267948966\d*", "-PI / 2", repaired)

    # Common LLM contract drift: helper classes must not be renderable scenes,
    # and the only renderable class must be MainScene(SafeScene, Scene).
    repaired = re.sub(
        r"class\s+SafeScene\s*\(\s*(?:Scene|SafeScene\s*,\s*Scene|Scene\s*,\s*SafeScene)\s*\)\s*:",
        "class SafeScene:",
        repaired,
    )
    repaired = re.sub(
        r"class\s+MainScene\s*\(\s*SafeScene\s*\)\s*:",
        "class MainScene(SafeScene, Scene):",
        repaired,
    )
    repaired = re.sub(
        r"class\s+MainScene\s*\(\s*Scene\s*\)\s*:",
        "class MainScene(SafeScene, Scene):",
        repaired,
    )
    if "class MainScene" not in repaired:
        match = re.search(
            r"class\s+([A-Za-z_]\w*)\s*\(\s*(?:SafeScene\s*,\s*)?Scene\s*\)\s*:",
            repaired,
        )
        if match:
            repaired = (
                repaired[: match.start()]
                + "class MainScene(SafeScene, Scene):"
                + repaired[match.end() :]
            )
    return repaired


async def llm_repair_once(
    code: str,
    observation: dict[str, Any],
    *,
    ai_client: Any | None,
    model_name: str | None,
) -> str:
    if ai_client is None or not model_name:
        return static_repair_once(code, observation)

    system = (
        "你负责修复 Manim Community Python 文件。只返回一个完整 Python 文件，"
        "并放在 python 代码块里。不要引入文件、网络、子进程、动态执行，"
        "也不要引入额外可渲染 Scene 类。"
    )
    user = {
        "observation": observation,
        "currentCode": code,
        "requirements": [
            "Keep MainScene(SafeScene, Scene) as the only renderable Scene.",
            "Use Text/SafeText for Chinese and MathTex only for formulas.",
            "Keep the storyboard semantics unchanged.",
            "Fix the reported static, visual, or render issue.",
        ],
    }
    response = await ai_client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
        temperature=0.12,
        stream=False,
    )
    fixed = extract_code_from_text(response.choices[0].message.content)
    return fixed or static_repair_once(code, observation)


async def repair_code_async(
    code: str,
    report: dict[str, Any],
    *,
    stderr: str = "",
    max_attempts: int = 2,
    brief: dict[str, Any] | None = None,
    storyboard_spec: dict[str, Any] | None = None,
    style_preset: dict[str, Any] | None = None,
    ai_client: Any | None = None,
    model_name: str | None = None,
) -> dict[str, Any]:
    current = code
    last_report = report
    observations: list[dict[str, Any]] = []

    for attempt in range(1, max_attempts + 1):
        observation = build_repair_observation(
            current,
            last_report,
            stderr=stderr,
            attempt=attempt,
            brief=brief,
            storyboard_spec=storyboard_spec,
            style_preset=style_preset,
        )
        observations.append(observation)
        current = await llm_repair_once(current, observation, ai_client=ai_client, model_name=model_name)
        last_report = critique_code(current, brief or {})
        if last_report["status"] != "error":
            return {
                "status": "success",
                "summary": "Code repaired.",
                "attempts": attempt,
                "code": current,
                "critic": last_report,
                "observations": observations,
            }

    return {
        "status": "error",
        "summary": "Stopped after maximum repair attempts.",
        "attempts": max_attempts,
        "code": current,
        "critic": last_report,
        "observations": observations,
        "root_cause_hint": observations[-1].get("root_cause_hint", "") if observations else "",
        "safe_retry": "Ask for a simpler animation or provide a more specific prompt.",
    }


def repair_code(
    code: str,
    report: dict[str, Any],
    stderr: str = "",
    max_attempts: int = 2,
    fixer: Fixer | None = None,
    brief: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Synchronous compatibility helper used by older tests."""
    current = code
    repair_fn = fixer or static_repair_once
    attempts = 0
    last_report = report

    while attempts < max_attempts:
        attempts += 1
        observation = build_repair_observation(current, last_report, stderr=stderr, attempt=attempts, brief=brief)
        current = repair_fn(current, observation)
        last_report = critique_code(current, brief or {})
        if last_report["status"] != "error":
            return {
                "status": "success",
                "summary": "Code repaired.",
                "attempts": attempts,
                "code": current,
                "critic": last_report,
            }

    return {
        "status": "error",
        "summary": "Stopped after maximum repair attempts.",
        "attempts": attempts,
        "code": current,
        "critic": last_report,
        "root_cause_hint": stderr or "; ".join(issue["message"] for issue in last_report.get("issues", [])),
        "safe_retry": "Ask for a simpler animation or provide a more specific prompt.",
    }
