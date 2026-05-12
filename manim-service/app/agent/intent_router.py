"""Rule-first intent routing for Manim Agent v4."""

from __future__ import annotations

import re
from typing import Any


LOW_CONFIDENCE_PATTERNS = (
    r"^做个动画$",
    r"^画个动画$",
    r"^生成动画$",
    r"^帮我做$",
    r"^随便.*动画$",
)

DOMAIN_KEYWORDS = {
    "data": ("柱状图", "折线图", "饼图", "数据", "销量", "趋势", "bar", "chart", "data"),
    "geometry": ("三角形", "圆", "圆形", "正方形", "几何", "角", "面积", "证明", "geometry", "circle", "triangle"),
    "physics": ("速度", "加速度", "力", "牛顿", "抛物", "运动", "小球", "physics", "force", "motion"),
    "flow": ("流程", "步骤", "握手", "关系", "结构", "因果", "tcp", "flow", "process"),
    "math": ("函数", "公式", "坐标", "正弦", "余弦", "积分", "导数", "矩阵", "function", "equation"),
}


def _contains_any(message: str, keywords: tuple[str, ...]) -> bool:
    lowered = message.lower()
    return any(keyword.lower() in lowered for keyword in keywords)


def classify_domain(message: str, mode: str = "create", current_code: str = "") -> str:
    if mode == "modify" or current_code.strip():
        return "code"
    for domain in ("math", "geometry", "data", "physics", "flow"):
        if _contains_any(message, DOMAIN_KEYWORDS[domain]):
            return domain
    return "concept"


def classify_function(message: str) -> str:
    lowered = message.lower()
    if "cos" in lowered or "余弦" in message:
        return "cos"
    if "sin" in lowered or "正弦" in message:
        return "sin"
    return ""


def classify_animation_type(message: str, domain: str, function_name: str = "") -> str:
    lowered = message.lower()
    if function_name:
        return "function_graph"
    if domain == "math" and _contains_any(message, ("推导", "公式", "derive", "derivation")):
        return "formula_derivation"
    if domain == "geometry" and _contains_any(message, ("圆形", "圆", "circle")):
        return "geometry_circle"
    if domain == "geometry":
        return "geometry_proof"
    if domain == "data":
        if _contains_any(message, ("折线", "趋势线", "line")):
            return "line_chart"
        return "bar_chart"
    if domain == "physics":
        return "motion_path"
    if domain == "flow":
        return "process_flow"
    if domain == "code":
        return "code_modify"
    if "对比" in message or "compare" in lowered:
        return "comparison"
    return "concept_explanation"


def classify_intent(message: str, mode: str, current_code: str) -> str:
    if mode == "modify" or current_code.strip():
        return "MODIFY"
    if _contains_any(message, ("添加", "加入", "再来", "加上", "add")):
        return "ADD"
    if _contains_any(message, ("优化", "美化", "增强", "更流畅", "improve", "enhance")):
        return "ENHANCE"
    return "CREATE"


def confidence_for(message: str, domain: str, animation_type: str) -> float:
    normalized = message.strip()
    if not normalized:
        return 0.0
    if len(normalized) < 4:
        return 0.35
    if any(re.search(pattern, normalized, re.IGNORECASE) for pattern in LOW_CONFIDENCE_PATTERNS):
        return 0.4
    if animation_type in {
        "function_graph",
        "geometry_circle",
        "geometry_proof",
        "bar_chart",
        "line_chart",
        "motion_path",
        "process_flow",
    }:
        return 0.88
    if domain == "concept" and len(normalized) < 12:
        return 0.55
    return 0.72


def clarification_for(message: str, domain: str) -> dict[str, Any]:
    options = [
        "做一个分步骤讲解动画",
        "做一个对比变化过程动画",
        "做一个简洁概念示意动画",
    ]
    if domain == "data":
        options = ["用柱状图展示", "用折线图展示", "用重点标注解释趋势"]
    elif domain == "physics":
        options = ["展示受力分析", "展示运动轨迹", "展示公式推导"]
    elif domain == "geometry":
        options = ["展示图形构造", "展示角度关系", "展示证明步骤"]
    return {
        "question": "你想让这个动画重点展示什么？",
        "options": options,
        "originalMessage": message,
    }


def route_intent(message: str, mode: str = "create", current_code: str = "") -> dict[str, Any]:
    text = (message or "").strip()
    domain = classify_domain(text, mode=mode, current_code=current_code)
    function_name = classify_function(text)
    animation_type = classify_animation_type(text, domain, function_name)
    intent = classify_intent(text, mode, current_code)
    confidence = confidence_for(text, domain, animation_type)
    return {
        "message": text,
        "domain": domain,
        "function": function_name,
        "animation_type": animation_type,
        "intent": intent,
        "confidence": confidence,
        "clarification": clarification_for(text, domain) if confidence < 0.6 else None,
        "decision_log": [
            f"rule_router:domain={domain}",
            f"rule_router:animation_type={animation_type}",
            f"rule_router:intent={intent}",
        ],
    }
