"""Replay logged Manim failures as lightweight regression checks."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .critic import critique_code
from .failure_events import load_failure_events
from .static_guard import run_static_guard


TARGET_MESSAGES = {
    "circle": "画一个圆形",
    "square": "画一个正方形",
    "triangle": "画一个三角形",
    "function_graph": "画一个正弦函数",
    "data_chart": "画一个三个月销量柱状图",
    "motion_path": "画一个小球抛物线运动",
    "flow": "解释 TCP 三次握手流程",
}


def _brief_from_event(event: dict[str, Any]) -> dict[str, Any]:
    target = str(event.get("semanticTarget") or "")
    return {
        "intent": "CREATE",
        "message": TARGET_MESSAGES.get(target, ""),
        "target_objects": [target] if target else [],
    }


def _issue_codes(report: dict[str, Any]) -> set[str]:
    issues = report.get("issues") or report.get("findings") or []
    return {str(issue.get("code")) for issue in issues if issue.get("code")}


def replay_failure_events(*, path: str | Path | None = None, limit: int = 100) -> dict[str, Any]:
    """Replay logged code snippets through static guard and critic.

    This does not render or call an LLM; it is intentionally cheap enough for
    local regression checks. A sample is considered caught when either the
    static guard or critic reports an error/warning related to the logged rules.
    """
    events = load_failure_events(path=path, limit=limit)
    samples: list[dict[str, Any]] = []
    caught = 0

    for event in events:
        code = str(event.get("codeSnippet") or "")
        expected_rules = set(str(rule) for rule in (event.get("repairRules") or []) if rule)
        brief = _brief_from_event(event)
        guard = run_static_guard(code, brief)
        critic = {"status": "skipped", "issues": [], "summary": "Python 静态守卫未通过，跳过 critic。"}
        if guard.get("status") != "error":
            critic = critique_code(code, brief)

        observed_rules = _issue_codes(guard) | _issue_codes(critic)
        sample_caught = guard.get("status") == "error" or critic.get("status") in {"error", "warning"}
        if expected_rules:
            sample_caught = bool(expected_rules & observed_rules) or sample_caught
        if sample_caught:
            caught += 1

        samples.append({
            "id": event.get("id"),
            "semanticTarget": event.get("semanticTarget"),
            "expectedRules": sorted(expected_rules),
            "observedRules": sorted(observed_rules),
            "staticStatus": guard.get("status"),
            "criticStatus": critic.get("status"),
            "caught": sample_caught,
        })

    total = len(samples)
    return {
        "total": total,
        "caught": caught,
        "missed": total - caught,
        "passRate": 1.0 if total == 0 else caught / total,
        "samples": samples,
    }
