"""Static quality and semantic inspector for generated Manim code."""

from __future__ import annotations

import re
from typing import Any


LONG_DECIMAL_RE = re.compile(r"\b-?\d+\.\d{6,}\b")
MOJIBAKE_RE = re.compile(r"(?:\u934b|\u9422|\u951b|\u7efe|\u20ac|\ufffd|鐢|涓|鍦|褰)")
BLACK_BACKGROUND_RE = re.compile(
    r"(background_color\s*=\s*(?:BLACK|['\"]#000|['\"]#000000)|fill_color\s*=\s*(?:BLACK|['\"]#000|['\"]#000000))"
)
INNER_CARD_RE = re.compile(
    r"(RoundedRectangle|Rectangle)\s*\([^)]*(?:width\s*=\s*[3-9](?:\.\d+)?|height\s*=\s*[2-5](?:\.\d+)?)",
    re.DOTALL,
)


def _finding(severity: str, message: str, hint: str, code: str = "") -> dict[str, str]:
    payload = {"severity": severity, "message": message, "hint": hint}
    if code:
        payload["code"] = code
    return payload


def _spec_kind(brief: dict[str, Any] | None) -> str:
    spec = (brief or {}).get("storyboardSpec") or (brief or {}).get("spec") or {}
    return str(spec.get("kind") or spec.get("animation_type") or (brief or {}).get("animation_type") or "")


def _message(brief: dict[str, Any] | None) -> str:
    return str((brief or {}).get("message") or "").lower()


def _contains_triangle_object(source: str) -> bool:
    return bool(re.search(r"\b(?:Triangle|Polygon)\s*\(", source)) or bool(
        re.search(r"\bRegularPolygon\s*\(\s*(?:n\s*=\s*)?3\b", source)
    )


def _contains_circle_object(source: str) -> bool:
    return bool(re.search(r"\bCircle\s*\(", source))


def _contains_function_curve(source: str) -> bool:
    return any(marker in source for marker in ("axes.plot", ".plot(", "ParametricFunction", "FunctionGraph", "plot_parametric_curve"))


def inspect_code_quality(code: str, brief: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return a lightweight quality report before rendering."""
    source = code or ""
    findings: list[dict[str, str]] = []
    text_count = len(re.findall(r"(?<![A-Za-z_])(?:Text|SafeText|MathTex|SafeMathTex)\s*\(", source))
    mathtex_count = len(re.findall(r"(?<![A-Za-z_])(?:MathTex|SafeMathTex)\s*\(", source))
    kind = _spec_kind(brief)
    prompt = _message(brief)

    if LONG_DECIMAL_RE.search(source):
        findings.append(_finding("error", "坐标标签出现长小数。", "使用符号刻度或短标签。", "long_decimal_ticks"))

    if MOJIBAKE_RE.search(source):
        findings.append(_finding("error", "代码中出现乱码中文。", "使用有效 UTF-8 中文字符串。", "mojibake"))

    if text_count > 22:
        findings.append(_finding("warning", f"文字对象数量较多（{text_count} 个）。", "合并文字组，并分阶段显示，避免重叠。", "text_density"))

    if "include_numbers': True" in source or '"include_numbers": True' in source:
        findings.append(_finding("warning", "自动坐标数字可能过密。", "关闭 include_numbers，手动添加精选标签。", "dense_axis_numbers"))

    if BLACK_BACKGROUND_RE.search(source):
        findings.append(_finding("error", "代码设置了黑色背景或黑色外框。", "使用整张浅色教学画布，不要留下黑边。", "black_background"))

    if INNER_CARD_RE.search(source) and "make_panel" not in source:
        findings.append(_finding("warning", "代码疑似把内容放进内嵌卡片或小画框。", "用全画布布局，不要在视频内再套展示卡。", "inner_card"))

    wants_circle = kind == "geometry_circle" or ("圆" in prompt and kind != "function_graph")
    wants_triangle = kind in {"geometry_proof", "triangle"} or "三角" in prompt
    has_circle = _contains_circle_object(source)
    has_triangle = _contains_triangle_object(source)

    if wants_circle:
        if not has_circle:
            findings.append(_finding("error", "圆形请求没有生成 Circle 对象。", "保留用户语义，使用 Circle() 绘制圆形。", "semantic_circle_missing"))
        if has_triangle and not has_circle:
            findings.append(_finding("error", "圆形请求生成了三角形几何。", "不要用三角形满足圆形提示。", "semantic_circle_triangle_mismatch"))

    if wants_triangle:
        if not has_triangle:
            findings.append(_finding("error", "三角形请求没有生成三角形对象。", "使用 Triangle()、Polygon() 或 RegularPolygon(n=3) 绘制三角形主体。", "semantic_triangle_missing"))
        if has_circle and not has_triangle:
            findings.append(_finding("error", "三角形请求生成了圆形主体。", "不要用圆形满足三角形提示。", "semantic_triangle_circle_mismatch"))

    if kind == "function_graph":
        if "Axes(" not in source and "NumberPlane(" not in source:
            findings.append(_finding("error", "函数图像缺少坐标系。", "使用 Axes 或 NumberPlane，并手动添加可读刻度。", "function_axes_missing"))
        if not _contains_function_curve(source):
            findings.append(_finding("error", "函数图像缺少可见函数曲线。", "使用 axes.plot(...)、ParametricFunction 或 FunctionGraph 绘制主曲线。", "function_curve_missing"))
        trig_prompt = any(term in prompt for term in ("sin", "cos", "正弦", "余弦"))
        if trig_prompt and "\\pi" not in source and "PI" not in source and "π" not in source:
            findings.append(_finding("warning", "三角函数图像没有明显的 π 符号刻度。", "使用 -π、-π/2、0、π/2、π 等符号标签。", "pi_ticks_missing"))
        if trig_prompt and "Circle(" in source and "单位圆" not in prompt:
            findings.append(_finding("error", "函数图像主体被单位圆或圆形元素分散。", "简单正弦/余弦请求优先放大坐标系和曲线，不要加入单位圆。", "function_graph_circle_distractor"))
        if mathtex_count > 2:
            findings.append(_finding("error", "函数图像不应依赖额外 MathTex 标签。", "公式、π 刻度和说明使用 Text/SafeText 显示，避免 LaTeX 渲染失败。", "function_graph_mathtex"))

    if kind == "data_chart" or kind in {"bar_chart", "line_chart"} or any(term in prompt for term in ("柱状图", "销量", "数据")):
        if mathtex_count > 2:
            findings.append(_finding("error", "数据图表不应使用额外 MathTex 标签。", "月份、数字、标题和说明全部使用 Text/SafeText，避免 LaTeX 渲染失败。", "data_chart_mathtex"))

    projectile_prompt = any(term in prompt for term in ("抛物", "小球", "projectile", "parabola"))
    if kind in {"motion_path", "physics_motion"} or projectile_prompt:
        motion_markers = ("ParametricFunction", "TracedPath", "DashedVMobject", "Arrow", "Vector", "trajectory", "轨迹", "速度", "重力", "gravity")
        if not any(marker in source for marker in motion_markers):
            findings.append(_finding("warning", "物理运动缺少轨迹或方向提示。", "添加轨迹线、方向箭头或速度/重力标注。", "motion_cue_missing"))
        if projectile_prompt:
            trajectory_markers = ("ParametricFunction", "TracedPath", "Axes.plot", "plot_parametric_curve", "parabola", "抛物线", "轨迹")
            force_markers = ("gravity", "g =", "DOWN", "重力", "加速度")
            velocity_markers = ("Arrow", "Vector", "速度", "方向")
            missing_motion_parts = []
            if not any(marker in source for marker in trajectory_markers):
                missing_motion_parts.append("轨迹")
            if not any(marker in source for marker in force_markers):
                missing_motion_parts.append("重力/加速度")
            if not any(marker in source for marker in velocity_markers):
                missing_motion_parts.append("速度或方向")
            if missing_motion_parts:
                findings.append(_finding(
                    "warning",
                    "物理运动推理不完整：缺少" + "、".join(missing_motion_parts) + "表达。",
                    "按轨迹-速度-重力三层结构表达运动，避免只画一个静态小球。",
                    "motion_reasoning_incomplete",
                ))

    if any(item["severity"] == "error" for item in findings):
        status = "error"
    elif findings:
        status = "warning"
    else:
        status = "pass"

    summary = "质量检查通过。" if not findings else "；".join(item["message"] for item in findings[:2])
    return {
        "status": status,
        "summary": summary,
        "findings": findings,
        "metrics": {
            "textObjects": text_count,
            "mathTexObjects": mathtex_count,
            "longDecimalLabels": len(LONG_DECIMAL_RE.findall(source)),
            "semanticKind": kind,
        },
    }
