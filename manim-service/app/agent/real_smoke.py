"""Long-running real Manim agent smoke runner."""

from __future__ import annotations

from collections import Counter
from typing import Any

from .smoke_suite import SMOKE_CASES, evaluate_smoke_result
from .workflow import run_agent


async def run_real_smoke_suite(
    *,
    ai_client: Any,
    model_name: str,
    render: bool = True,
    case_ids: set[str] | None = None,
) -> dict[str, Any]:
    """Run the fixed prompt matrix through the real agent pipeline."""
    cases = [case for case in SMOKE_CASES if not case_ids or case["id"] in case_ids]
    results: list[dict[str, Any]] = []

    for case in cases:
        payload = {
            "message": case["prompt"],
            "mode": "create",
            "clientId": f"smoke_{case['id']}",
        }
        result = await run_agent(payload, ai_client=ai_client, model_name=model_name, render=render)
        evaluation = evaluate_smoke_result(case, result, require_rendered=render)
        trace = result.get("agentTrace") or {}
        results.append({
            **evaluation,
            "videoUrl": result.get("videoUrl"),
            "warning": result.get("warning"),
            "failureEventId": trace.get("failureEventId"),
            "codeSource": trace.get("codeSource"),
            "repairCount": (trace.get("repairs") or {}).get("count"),
            "rulePackVersion": trace.get("rulePackVersion"),
        })

    passed = sum(1 for item in results if item["passed"])
    quality_passed = sum(1 for item in results if item.get("qualityPassed"))
    strict_quality_passed = sum(1 for item in results if item.get("strictQualityPassed"))
    scores = [int(item.get("qualityScore") or 0) for item in results]
    source_counts = Counter(str(item.get("codeSource") or "unknown") for item in results)
    return {
        "total": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "passRate": 1.0 if not results else passed / len(results),
        "qualityPassed": quality_passed,
        "qualityFailed": len(results) - quality_passed,
        "qualityPassRate": 1.0 if not results else quality_passed / len(results),
        "strictQualityPassed": strict_quality_passed,
        "strictQualityFailed": len(results) - strict_quality_passed,
        "strictQualityPassRate": 1.0 if not results else strict_quality_passed / len(results),
        "averageQualityScore": round(sum(scores) / len(scores), 2) if scores else 0,
        "minimumQualityScore": min(scores) if scores else 0,
        "codeSourceCounts": dict(sorted(source_counts.items())),
        "rescueCount": source_counts.get("rescue", 0),
        "results": results,
    }
