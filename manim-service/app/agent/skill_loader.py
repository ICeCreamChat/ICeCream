"""Runtime skill selection for Manim generation."""

from __future__ import annotations

from typing import Any


SKILLS: dict[str, dict[str, str]] = {
    "function_graph": {
        "id": "function_graph",
        "version": "v5",
        "name": "函数图像教学",
        "guidance": "使用符号刻度、分阶段绘制曲线，并标出关键点；禁止长小数坐标标签。",
    },
    "formula_derivation": {
        "id": "formula_derivation",
        "version": "v5",
        "name": "公式推导",
        "guidance": "一次只展示一个推导步骤，中文说明放在 Text 中，公式放在 MathTex 中。",
    },
    "coordinate_system": {
        "id": "coordinate_system",
        "version": "v5",
        "name": "可读坐标系",
        "guidance": "控制刻度密度，优先使用 π 等符号标签，轴线和标签颜色要清楚。",
    },
    "geometry": {
        "id": "geometry",
        "version": "v5",
        "name": "几何图形",
        "guidance": "使用清晰线条、角标和短标签；请求圆形必须使用 Circle，请求三角形必须使用 Triangle 或 Polygon。",
    },
    "data_visualization": {
        "id": "data_visualization",
        "version": "v5",
        "name": "数据图表",
        "guidance": "优先使用柱状图或折线图，按数据顺序出现，并突出趋势结论。",
    },
    "physics_motion": {
        "id": "physics_motion",
        "version": "v5",
        "name": "物理运动",
        "guidance": "展示轨迹、方向、关键对象和受力/速度标注，避免只画静态示意。",
    },
    "flow_explanation": {
        "id": "flow_explanation",
        "version": "v5",
        "name": "流程解释",
        "guidance": "使用节点和箭头，逐步呈现每个状态转移，保持节点间距稳定。",
    },
    "code_modify": {
        "id": "code_modify",
        "version": "v5",
        "name": "代码面板修改",
        "guidance": "先分析现有场景结构，再做最小可运行修改，并保持 MainScene 合约。",
    },
    "text_formula_layout": {
        "id": "text_formula_layout",
        "version": "v5",
        "name": "文字与公式布局",
        "guidance": "中文使用 Text，公式使用 MathTex；标题、步骤、主体和总结分区放置。",
    },
}

TYPE_TO_SKILLS = {
    "function_graph": ["function_graph", "coordinate_system", "text_formula_layout"],
    "formula_derivation": ["formula_derivation", "text_formula_layout", "coordinate_system"],
    "geometry_proof": ["geometry", "text_formula_layout", "formula_derivation"],
    "geometry_circle": ["geometry", "text_formula_layout", "coordinate_system"],
    "bar_chart": ["data_visualization", "coordinate_system", "text_formula_layout"],
    "line_chart": ["data_visualization", "coordinate_system", "text_formula_layout"],
    "motion_path": ["physics_motion", "coordinate_system", "text_formula_layout"],
    "process_flow": ["flow_explanation", "text_formula_layout", "geometry"],
    "code_modify": ["code_modify", "text_formula_layout", "flow_explanation"],
    "concept_explanation": ["flow_explanation", "text_formula_layout", "geometry"],
}


def select_skills(brief: dict[str, Any], limit: int = 3) -> list[dict[str, str]]:
    """Return 1-3 runtime skills relevant to the brief."""
    spec = brief.get("storyboardSpec") or brief.get("spec") or {}
    animation_type = str(brief.get("animation_type") or spec.get("animation_type") or "concept_explanation")
    selected = TYPE_TO_SKILLS.get(animation_type, TYPE_TO_SKILLS["concept_explanation"])
    if brief.get("intent") == "MODIFY":
        selected = ["code_modify", *selected]

    unique_ids = list(dict.fromkeys(selected))[: max(1, min(limit, 3))]
    return [SKILLS[skill_id] for skill_id in unique_ids]
