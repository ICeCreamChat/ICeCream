"""Planner for natural-language Manim requests."""

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
    "geometry": ("三角形", "圆", "正方形", "几何", "角", "面积", "geometry", "circle"),
    "physics": ("速度", "加速度", "力", "牛顿", "抛物", "运动", "physics", "force"),
    "flow": ("流程", "步骤", "关系", "架构", "因果", "flow", "process"),
    "math": ("函数", "公式", "坐标", "正弦", "积分", "导数", "矩阵", "function", "equation"),
}


def _classify_domain(message: str) -> str:
    lowered = message.lower()
    for domain, keywords in DOMAIN_KEYWORDS.items():
        if any(keyword in lowered or keyword in message for keyword in keywords):
            return domain
    return "concept"


def _classify_intent(message: str, mode: str, current_code: str) -> str:
    if mode == "modify" or current_code.strip():
        return "MODIFY"
    if any(word in message for word in ("添加", "加入", "再来", "加上")):
        return "ADD"
    if any(word in message for word in ("优化", "美化", "增强", "更流畅")):
        return "ENHANCE"
    return "CREATE"


def _confidence_for(message: str, domain: str) -> float:
    normalized = message.strip()
    if not normalized:
        return 0.0
    if len(normalized) < 8:
        return 0.35
    if any(re.search(pattern, normalized, re.IGNORECASE) for pattern in LOW_CONFIDENCE_PATTERNS):
        return 0.4
    if domain == "concept" and len(normalized) < 16:
        return 0.55
    return 0.82 if domain != "concept" else 0.68


def _clarification_for(message: str, domain: str) -> dict[str, Any]:
    options = [
        "做一个分步骤讲解动画",
        "做一个对比/变化过程动画",
        "做一个简洁概念示意动画",
    ]
    if domain == "data":
        options = ["用柱状图展示", "用折线图展示", "用重点标注解释趋势"]
    elif domain == "physics":
        options = ["展示受力分析", "展示运动轨迹", "展示公式推导"]
    return {
        "question": "你想让这个动画重点展示什么？",
        "options": options,
        "originalMessage": message,
    }


def plan_animation(
    message: str,
    mode: str = "create",
    current_code: str = "",
) -> dict[str, Any]:
    """Convert a user prompt into a deterministic animation brief."""
    text = (message or "").strip()
    domain = _classify_domain(text)
    confidence = _confidence_for(text, domain)
    intent = _classify_intent(text, mode, current_code)
    storyboard = [
        "Introduce the topic with a concise title.",
        "Build the main visual object step by step.",
        "Highlight the key relationship or conclusion.",
    ]
    if domain == "data":
        storyboard = [
            "Introduce the dataset and axes.",
            "Animate bars or trend lines in sequence.",
            "Highlight the largest change and summarize the trend.",
        ]
    elif domain == "physics":
        storyboard = [
            "Show the object and coordinate frame.",
            "Animate motion or force vectors.",
            "Reveal the governing equation and conclusion.",
        ]
    elif domain == "flow":
        storyboard = [
            "Lay out the process nodes.",
            "Animate arrows between each step.",
            "Emphasize the final outcome.",
        ]

    return {
        "intent": intent,
        "domain": domain,
        "message": text,
        "target_objects": [],
        "storyboard": storyboard,
        "layout": {
            "frame": "16:9",
            "safe_margin": 0.7,
            "text_policy": "Use Text for Chinese and MathTex only for formulas.",
        },
        "risks": [
            "Text overlap",
            "MathTex Chinese characters",
            "Objects outside frame",
        ],
        "confidence": confidence,
        "clarification": _clarification_for(text, domain) if confidence < 0.6 else None,
    }

