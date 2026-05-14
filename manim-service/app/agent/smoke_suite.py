"""Reusable six-prompt Manim smoke matrix."""

from __future__ import annotations

from typing import Any

from .critic import critique_code
from .static_guard import run_static_guard


SMOKE_CASES: list[dict[str, Any]] = [
    {"id": "circle", "prompt": "画一个圆形", "semanticTarget": "circle", "requiredMarkers": ["Circle("]},
    {"id": "square", "prompt": "画一个正方形", "semanticTarget": "square", "requiredMarkers": ["Square("]},
    {
        "id": "triangle",
        "prompt": "画一个三角形",
        "semanticTarget": "triangle",
        "requiredAnyMarkers": [["Triangle(", "Polygon(", "RegularPolygon("]],
    },
    {
        "id": "sine",
        "prompt": "画一个正弦函数，做分步骤讲解动画",
        "semanticTarget": "function_graph",
        "requiredAnyMarkers": [["Axes(", "NumberPlane("], [".plot(", "ParametricFunction(", "FunctionGraph("]],
    },
    {
        "id": "bar-chart",
        "prompt": "画一个三个月销量柱状图",
        "semanticTarget": "data_chart",
        "requiredAnyMarkers": [["Rectangle(", "BarChart("]],
    },
    {"id": "tcp-flow", "prompt": "解释 TCP 三次握手流程", "semanticTarget": "flow", "requiredAnyMarkers": [["Arrow(", "Line("]]},
]


SMOKE_QUALITY_FLOOR = 72
SMOKE_STRICT_QUALITY_FLOOR = 95
SMOKE_STRICT_MAX_REPAIR_COUNT = 1


def brief_for_smoke_case(case: dict[str, Any]) -> dict[str, Any]:
    return {
        "intent": "CREATE",
        "message": case.get("prompt", ""),
        "target_objects": [case.get("semanticTarget", "")],
    }


def _trace_quality(result: dict[str, Any]) -> dict[str, Any]:
    trace = result.get("agentTrace") or {}
    return trace.get("quality") or {}


def _visual_metrics(result: dict[str, Any]) -> dict[str, Any]:
    visual = (_trace_quality(result).get("visual") or result.get("preview") or {})
    return visual.get("metrics") or {}


def _frame_metrics(result: dict[str, Any]) -> dict[str, Any]:
    frame = _visual_metrics(result).get("frame") or {}
    return frame if isinstance(frame, dict) else {}


def _repair_count(result: dict[str, Any]) -> int:
    repairs = (result.get("agentTrace") or {}).get("repairs") or {}
    try:
        return int(repairs.get("count") or 0)
    except (TypeError, ValueError):
        return 0


def _quality_grade(score: int) -> str:
    if score >= 92:
        return "A"
    if score >= 84:
        return "B"
    if score >= SMOKE_QUALITY_FLOOR:
        return "C"
    if score >= 55:
        return "D"
    return "F"


def _strict_quality_result(evaluation: dict[str, Any], quality: dict[str, Any]) -> dict[str, Any]:
    """Apply the high-confidence smoke gate used for release-style checks."""
    findings: list[str] = []
    score = int(quality.get("qualityScore") or 0)
    metrics = quality.get("qualityMetrics") or {}
    repair_count = int(metrics.get("repairCount") or 0)
    code_source = str(metrics.get("codeSource") or "")

    if not evaluation.get("passed"):
        findings.append("基础 smoke 未通过")
    if not quality.get("qualityPassed"):
        findings.append("基础质量门槛未通过")
    if score < SMOKE_STRICT_QUALITY_FLOOR:
        findings.append(f"质量分低于严格门槛 {SMOKE_STRICT_QUALITY_FLOOR}")
    if quality.get("qualityFindings"):
        findings.append("存在质量检查提示")
    if code_source == "rescue":
        findings.append("使用了质量兜底场景")
    if repair_count > SMOKE_STRICT_MAX_REPAIR_COUNT:
        findings.append(f"自动修复次数超过严格门槛 {SMOKE_STRICT_MAX_REPAIR_COUNT}")

    return {
        "strictQualityPassed": not findings,
        "strictQualityFindings": findings,
        "strictQualityFloor": SMOKE_STRICT_QUALITY_FLOOR,
        "strictMaxRepairCount": SMOKE_STRICT_MAX_REPAIR_COUNT,
    }


def score_smoke_quality(
    case: dict[str, Any],
    result: dict[str, Any],
    evaluation: dict[str, Any],
) -> dict[str, Any]:
    """Score generated animation quality from trace and visual metrics.

    This intentionally remains deterministic and cheap. It catches quality drift
    in the recurring six-prompt suite without launching additional renders.
    """
    del case
    score = 100
    findings: list[str] = []

    if not evaluation.get("renderOk"):
        score -= 40
        findings.append("未生成可播放视频")
    if evaluation.get("staticStatus") == "error":
        score -= 50
        findings.append("Python 静态守卫失败")
    if evaluation.get("criticStatus") == "error":
        score -= 45
        findings.append("静态语义检查失败")
    if evaluation.get("missingMarkers"):
        score -= 40
        findings.append("缺少必需对象标记")
    if evaluation.get("missingAnyMarkerGroups"):
        score -= 28
        findings.append("缺少领域核心绘图对象")

    trace_quality = _trace_quality(result)
    code_source = str((result.get("agentTrace") or {}).get("codeSource") or "")
    static_status = (trace_quality.get("static") or {}).get("status")
    visual_status = (trace_quality.get("visual") or {}).get("status")
    if static_status == "warning":
        score -= 8
        findings.append("静态检查存在注意项")
    if visual_status == "warning":
        score -= 10
        findings.append("视觉检查存在注意项")
    elif visual_status == "error":
        score -= 45
        findings.append("视觉检查失败")

    repair_count = _repair_count(result)
    if repair_count:
        score -= min(24, repair_count * 4)
        if repair_count >= 4:
            findings.append(f"自动修复次数偏多：{repair_count}")
    if code_source == "rescue":
        score -= 12
        findings.append("使用了质量兜底场景")

    metrics = _visual_metrics(result)
    frame = _frame_metrics(result)
    artifact_size = int(metrics.get("artifactSize") or 0)
    if artifact_size and artifact_size < 40_000:
        score -= 14
        findings.append("视频文件偏小")

    non_background = float(frame.get("nonBackgroundRatio") or 0)
    if non_background:
        if non_background < 0.02:
            score -= 22
            findings.append("主体画面占比过小")
        elif non_background < 0.035:
            score -= 10
            findings.append("主体画面占比偏小")
        elif non_background > 0.78:
            score -= 8
            findings.append("画面元素可能过满")

    contrast = float(frame.get("contrast") or 0)
    if contrast:
        if contrast < 6:
            score -= 24
            findings.append("画面对比度过低")
        elif contrast < 10:
            score -= 8
            findings.append("画面对比度偏低")

    dark_edge = float(frame.get("darkEdgeRatio") or 0)
    if dark_edge > 0.18:
        score -= 18
        findings.append("存在黑边或黑色留白风险")
    elif dark_edge > 0.06:
        score -= 8
        findings.append("边缘暗色占比偏高")

    edge_content = float(frame.get("edgeContentRatio") or 0)
    if edge_content > 0.22:
        score -= 10
        findings.append("重要内容靠近边缘")

    score = max(0, min(100, int(round(score))))
    quality = {
        "qualityScore": score,
        "qualityGrade": _quality_grade(score),
        "qualityPassed": score >= SMOKE_QUALITY_FLOOR and bool(evaluation.get("passed")),
        "qualityFindings": findings,
        "qualityMetrics": {
            "codeSource": code_source,
            "repairCount": repair_count,
            "artifactSize": artifact_size,
            "nonBackgroundRatio": frame.get("nonBackgroundRatio"),
            "contrast": frame.get("contrast"),
            "darkEdgeRatio": frame.get("darkEdgeRatio"),
            "edgeContentRatio": frame.get("edgeContentRatio"),
        },
    }
    return {
        **quality,
        **_strict_quality_result(evaluation, quality),
    }


def evaluate_smoke_result(case: dict[str, Any], result: dict[str, Any], *, require_rendered: bool = True) -> dict[str, Any]:
    """Evaluate a result payload without launching additional rendering."""
    code = str(result.get("code") or "")
    brief = brief_for_smoke_case(case)
    guard = run_static_guard(code, brief)
    critic = {"status": "skipped", "issues": [], "summary": "Python 静态守卫未通过，跳过 critic。"}
    if guard.get("status") != "error":
        critic = critique_code(code, brief)

    missing_markers = [marker for marker in case.get("requiredMarkers", []) if marker not in code]
    missing_any_marker_groups = [
        group for group in case.get("requiredAnyMarkers", [])
        if not any(marker in code for marker in group)
    ]
    render_ok = bool(result.get("rendered")) and bool(result.get("videoUrl") or result.get("videoBase64"))
    passed = (
        guard.get("status") != "error"
        and critic.get("status") != "error"
        and not missing_markers
        and not missing_any_marker_groups
        and (render_ok or not require_rendered)
    )

    evaluation = {
        "id": case.get("id"),
        "prompt": case.get("prompt"),
        "semanticTarget": case.get("semanticTarget"),
        "passed": passed,
        "renderOk": render_ok,
        "staticStatus": guard.get("status"),
        "criticStatus": critic.get("status"),
        "missingMarkers": missing_markers,
        "missingAnyMarkerGroups": missing_any_marker_groups,
        "warning": result.get("warning"),
    }
    return {
        **evaluation,
        **score_smoke_quality(case, result, evaluation),
    }
