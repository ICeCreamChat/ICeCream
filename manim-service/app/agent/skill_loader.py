"""Runtime skill registry and selection for Manim generation."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app import service_config


SKILL_CATALOG_VERSION = "manim-v6-skills"


BUILTIN_SKILLS: dict[str, dict[str, str]] = {
    "middle_school_math": {
        "id": "middle_school_math",
        "version": "v6",
        "name": "初中数学教学",
        "guidance": "使用清晰定义、少量步骤和可读标注，避免竞赛级复杂推导。",
    },
    "function_graph": {
        "id": "function_graph",
        "version": "v6",
        "name": "函数图像教学",
        "guidance": "使用符号刻度、分阶段绘制曲线，并标出关键点；禁止长小数坐标标签。",
    },
    "formula_derivation": {
        "id": "formula_derivation",
        "version": "v6",
        "name": "公式推导",
        "guidance": "一次只展示一个推导步骤，中文讲解使用 Text，公式使用 MathTex。",
    },
    "coordinate_system": {
        "id": "coordinate_system",
        "version": "v6",
        "name": "可读坐标系",
        "guidance": "控制刻度密度，优先使用 π 等符号标签，轴线和标签颜色要清晰。",
    },
    "geometry": {
        "id": "geometry",
        "version": "v6",
        "name": "几何图形",
        "guidance": "使用清晰线条、角标和短标签；圆形必须使用 Circle，三角形必须使用 Triangle 或 Polygon。",
    },
    "data_visualization": {
        "id": "data_visualization",
        "version": "v6",
        "name": "数据图表",
        "guidance": "优先使用柱状图或折线图，按数据顺序出现，并突出趋势结论。",
    },
    "physics_motion": {
        "id": "physics_motion",
        "version": "v6",
        "name": "物理运动",
        "guidance": "展示轨迹、方向、关键对象和受力/速度标注，避免只画静态示意。",
    },
    "flow_explanation": {
        "id": "flow_explanation",
        "version": "v6",
        "name": "流程解释",
        "guidance": "使用节点和箭头逐步呈现状态转移，保持节点间距稳定。",
    },
    "short_video_style": {
        "id": "short_video_style",
        "version": "v6",
        "name": "短视频节奏",
        "guidance": "减少文字密度，使用强节奏分段和明显视觉重点，保持每屏信息单一。",
    },
    "blackboard_style": {
        "id": "blackboard_style",
        "version": "v6",
        "name": "黑板讲解风格",
        "guidance": "仅在用户明确要求时启用；默认仍使用浅色教学画布，避免黑边误检。",
    },
    "code_modify": {
        "id": "code_modify",
        "version": "v6",
        "name": "代码面板修改",
        "guidance": "先分析现有场景结构，再做最小可运行修改，并保持 MainScene 合约。",
    },
    "text_formula_layout": {
        "id": "text_formula_layout",
        "version": "v6",
        "name": "文字与公式布局",
        "guidance": "中文使用 Text，公式使用 MathTex；标题、步骤、主体和总结分区放置。",
    },
}


TYPE_TO_SKILLS = {
    "function_graph": ["function_graph", "coordinate_system", "text_formula_layout"],
    "formula_derivation": ["formula_derivation", "text_formula_layout", "middle_school_math"],
    "geometry_proof": ["geometry", "text_formula_layout", "formula_derivation"],
    "geometry_circle": ["geometry", "text_formula_layout", "middle_school_math"],
    "square": ["geometry", "text_formula_layout", "middle_school_math"],
    "triangle": ["geometry", "text_formula_layout", "middle_school_math"],
    "bar_chart": ["data_visualization", "coordinate_system", "text_formula_layout"],
    "line_chart": ["data_visualization", "coordinate_system", "text_formula_layout"],
    "motion_path": ["physics_motion", "coordinate_system", "text_formula_layout"],
    "process_flow": ["flow_explanation", "text_formula_layout", "short_video_style"],
    "code_modify": ["code_modify", "text_formula_layout", "flow_explanation"],
    "concept_explanation": ["flow_explanation", "text_formula_layout", "middle_school_math"],
}


def _project_skills_dir() -> Path:
    return Path(service_config.get_manim_project_skills_dir())


def load_project_skills() -> dict[str, dict[str, str]]:
    """Load optional project skills from `.manim/skills/*.json`.

    Files are small JSON documents with id/name/guidance. Arbitrary paths are
    not accepted; this prevents prompt loading from becoming a file-read tool.
    """
    root = _project_skills_dir()
    if not root.exists() or not root.is_dir():
        return {}

    skills: dict[str, dict[str, str]] = {}
    for path in root.glob("*.json"):
        try:
            if path.stat().st_size > 20_000:
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        skill_id = str(data.get("id") or path.stem).strip()
        name = str(data.get("name") or skill_id).strip()
        guidance = str(data.get("guidance") or "").strip()
        if not skill_id or not guidance:
            continue
        skills[skill_id] = {
            "id": skill_id[:80],
            "version": str(data.get("version") or "project")[:40],
            "name": name[:80],
            "guidance": guidance[:1200],
        }
    return skills


def skill_catalog() -> dict[str, dict[str, str]]:
    return {**BUILTIN_SKILLS, **load_project_skills()}


def _is_trig_geometry_brief(brief: dict[str, Any]) -> bool:
    """Detect trigonometry explanations that need geometry, not flow-chart skills."""
    spec = brief.get("storyboardSpec") or brief.get("spec") or {}
    chunks: list[str] = [
        str(brief.get("message") or ""),
        str(brief.get("domain") or ""),
        str(brief.get("animation_type") or ""),
        str(spec.get("domain") or ""),
        str(spec.get("topic") or ""),
        str(spec.get("teaching_goal") or ""),
        str(spec.get("animation_type") or ""),
    ]
    for key in ("storyboard", "teaching_steps", "shots", "layout_zones"):
        value = spec.get(key) or brief.get(key) or []
        if isinstance(value, list):
            chunks.extend(str(item) for item in value)
        elif value:
            chunks.append(str(value))

    text = " ".join(chunks).lower()
    explicit_tokens = (
        "三角函数",
        "直角三角",
        "正弦余弦正切",
        "对边",
        "邻边",
        "斜边",
        "trigonometric",
        "right triangle",
        "sine cosine tangent",
        "opposite side",
        "adjacent side",
        "hypotenuse",
    )
    return any(token in text for token in explicit_tokens) or all(token in text for token in ("sin", "cos", "tan"))


def select_skills(brief: dict[str, Any], limit: int = 3) -> list[dict[str, str]]:
    """Return 1-3 runtime skills relevant to the brief."""
    spec = brief.get("storyboardSpec") or brief.get("spec") or {}
    animation_type = str(brief.get("animation_type") or spec.get("animation_type") or "concept_explanation")
    catalog = skill_catalog()

    requested_ids = [
        str(item)
        for item in (brief.get("requestedSkillIds") or brief.get("skillIds") or [])
        if str(item) in catalog
    ]
    if requested_ids:
        selected = requested_ids
    elif _is_trig_geometry_brief(brief):
        selected = ["geometry", "formula_derivation", "text_formula_layout"]
    else:
        selected = TYPE_TO_SKILLS.get(animation_type, TYPE_TO_SKILLS["concept_explanation"])
    if brief.get("intent") == "MODIFY":
        selected = ["code_modify", *selected]

    unique_ids = list(dict.fromkeys(selected))[: max(1, min(limit, 3))]
    return [catalog[skill_id] for skill_id in unique_ids if skill_id in catalog]
