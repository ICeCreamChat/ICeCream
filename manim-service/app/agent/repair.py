"""Repair helpers for generated Manim code."""

from __future__ import annotations

import re
from typing import Any, Callable

from .critic import critique_code


Fixer = Callable[[str, dict[str, Any]], str]


def static_repair_once(code: str, observation: dict[str, Any]) -> str:
    """Apply small deterministic repairs for common Manim generation mistakes."""
    repaired = code or ""

    if "from manim import" not in repaired:
        repaired = "from manim import *\nimport math\nimport numpy as np\n\n" + repaired
    elif "import math" not in repaired:
        repaired = repaired.replace("from manim import *", "from manim import *\nimport math", 1)

    if "import numpy as np" not in repaired:
        repaired = repaired.replace("import math", "import math\nimport numpy as np", 1)

    repaired = re.sub(r"^\s*import\s+(os|subprocess)\b.*$", "", repaired, flags=re.MULTILINE)
    repaired = re.sub(r"(?:eval|exec|__import__)\s*\([^)]*\)", "None", repaired)

    def replace_chinese_mathtex(match: re.Match[str]) -> str:
        content = match.group(1)
        if re.search(r"[\u4e00-\u9fff]", content):
            return f'Text({content})'
        return match.group(0)

    repaired = re.sub(r"(?:MathTex|Tex)\s*\(([^)]*[\u4e00-\u9fff][^)]*)\)", replace_chinese_mathtex, repaired)
    return repaired


def repair_code(
    code: str,
    report: dict[str, Any],
    stderr: str = "",
    max_attempts: int = 2,
    fixer: Fixer | None = None,
) -> dict[str, Any]:
    """Repair code until critique passes or the maximum attempt count is reached."""
    current = code
    repair_fn = fixer or static_repair_once
    attempts = 0
    last_report = report

    while attempts < max_attempts:
        attempts += 1
        observation = {
            "critic": last_report,
            "stderr": stderr,
            "attempt": attempts,
        }
        next_code = repair_fn(current, observation)
        current = next_code
        last_report = critique_code(current, {})
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

