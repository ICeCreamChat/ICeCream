"""Runtime skill selection for Manim generation."""

from __future__ import annotations

from typing import Any


SKILLS: dict[str, dict[str, str]] = {
    "math_function": {
        "id": "math_function",
        "name": "Mathematical functions and formulas",
        "guidance": "Use Axes for functions, MathTex for formulas, and keep labels outside plotted curves.",
    },
    "geometry": {
        "id": "geometry",
        "name": "Geometry diagrams",
        "guidance": "Use geometric primitives, labels with Text, and avoid overlapping annotations.",
    },
    "data_visualization": {
        "id": "data_visualization",
        "name": "Data visualization",
        "guidance": "Prefer simple bars or lines, animate values sequentially, and call out the trend.",
    },
    "physics_motion": {
        "id": "physics_motion",
        "name": "Physics and motion",
        "guidance": "Use vectors, paths, and equations; keep motion slow enough to read.",
    },
    "flow_explanation": {
        "id": "flow_explanation",
        "name": "Flow and process explanation",
        "guidance": "Use nodes and arrows, reveal one step at a time, and end with a summary.",
    },
    "text_formula_layout": {
        "id": "text_formula_layout",
        "name": "Text and formula layout",
        "guidance": "Chinese must use Text(). MathTex/Tex must contain formulas only. Use VGroup spacing.",
    },
}

DOMAIN_TO_SKILL = {
    "data": "data_visualization",
    "geometry": "geometry",
    "physics": "physics_motion",
    "flow": "flow_explanation",
    "math": "math_function",
    "concept": "flow_explanation",
}


def select_skills(brief: dict[str, Any], limit: int = 3) -> list[dict[str, str]]:
    """Return 1-3 runtime skills relevant to the brief."""
    selected: list[str] = []
    domain_skill = DOMAIN_TO_SKILL.get(str(brief.get("domain") or "concept"), "flow_explanation")
    selected.append(domain_skill)
    selected.append("text_formula_layout")

    if brief.get("intent") in {"ADD", "ENHANCE", "MODIFY"} and domain_skill != "flow_explanation":
        selected.append("flow_explanation")

    unique_ids = list(dict.fromkeys(selected))[: max(1, min(limit, 3))]
    return [SKILLS[skill_id] for skill_id in unique_ids]

