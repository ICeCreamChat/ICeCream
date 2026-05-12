"""Runtime skill selection for Manim generation."""

from __future__ import annotations

from typing import Any


SKILLS: dict[str, dict[str, str]] = {
    "function_graph": {
        "id": "function_graph",
        "version": "v2",
        "name": "Function graph teaching animation",
        "guidance": "Use a dedicated graph template with staged axes, curve, key points, and a final rule summary.",
    },
    "coordinate_system": {
        "id": "coordinate_system",
        "version": "v2",
        "name": "Readable coordinate systems",
        "guidance": "Use symbolic tick labels for pi-based ranges and keep tick labels short and sparse.",
    },
    "math_function": {
        "id": "math_function",
        "version": "v1",
        "name": "Mathematical functions and formulas",
        "guidance": "Use Axes for functions, MathTex for formulas, and keep labels outside plotted curves.",
    },
    "geometry": {
        "id": "geometry",
        "version": "v1",
        "name": "Geometry diagrams",
        "guidance": "Use geometric primitives, labels with Text, and avoid overlapping annotations.",
    },
    "data_visualization": {
        "id": "data_visualization",
        "version": "v1",
        "name": "Data visualization",
        "guidance": "Prefer simple bars or lines, animate values sequentially, and call out the trend.",
    },
    "physics_motion": {
        "id": "physics_motion",
        "version": "v1",
        "name": "Physics and motion",
        "guidance": "Use vectors, paths, and equations; keep motion slow enough to read.",
    },
    "flow_explanation": {
        "id": "flow_explanation",
        "version": "v1",
        "name": "Flow and process explanation",
        "guidance": "Use nodes and arrows, reveal one step at a time, and end with a summary.",
    },
    "text_formula_layout": {
        "id": "text_formula_layout",
        "version": "v2",
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
    spec = brief.get("spec") or {}
    if spec.get("kind") == "function_graph":
        return [SKILLS[skill_id] for skill_id in ["function_graph", "coordinate_system", "text_formula_layout"][:limit]]

    domain_skill = DOMAIN_TO_SKILL.get(str(brief.get("domain") or "concept"), "flow_explanation")
    selected.append(domain_skill)
    selected.append("text_formula_layout")

    if brief.get("intent") in {"ADD", "ENHANCE", "MODIFY"} and domain_skill != "flow_explanation":
        selected.append("flow_explanation")

    unique_ids = list(dict.fromkeys(selected))[: max(1, min(limit, 3))]
    return [SKILLS[skill_id] for skill_id in unique_ids]
