"""Runtime skill selection for Manim generation."""

from __future__ import annotations

from typing import Any


SKILLS: dict[str, dict[str, str]] = {
    "function_graph": {
        "id": "function_graph",
        "version": "v4",
        "name": "Function graph teaching animation",
        "guidance": "Require symbolic ticks, staged curve drawing, key points, and separated header/step/visual/summary zones.",
    },
    "formula_derivation": {
        "id": "formula_derivation",
        "version": "v4",
        "name": "Formula derivation",
        "guidance": "Reveal one equation step at a time and keep explanatory Chinese outside MathTex.",
    },
    "coordinate_system": {
        "id": "coordinate_system",
        "version": "v4",
        "name": "Readable coordinate systems",
        "guidance": "Use sparse labels, symbolic ticks for pi ranges, and explicit axis colors.",
    },
    "geometry": {
        "id": "geometry",
        "version": "v4",
        "name": "Geometry diagrams",
        "guidance": "Use clear primitives, angle arcs, short labels, and avoid label overlap.",
    },
    "data_visualization": {
        "id": "data_visualization",
        "version": "v4",
        "name": "Data visualization",
        "guidance": "Prefer simple bars or lines, animate values sequentially, and call out the trend.",
    },
    "physics_motion": {
        "id": "physics_motion",
        "version": "v4",
        "name": "Physics and motion",
        "guidance": "Use readable trajectories, vectors, labels, and slow motion timing.",
    },
    "flow_explanation": {
        "id": "flow_explanation",
        "version": "v4",
        "name": "Flow and process explanation",
        "guidance": "Use nodes and arrows, reveal one transition at a time, and keep node spacing stable.",
    },
    "code_modify": {
        "id": "code_modify",
        "version": "v4",
        "name": "CodePanel AI modification",
        "guidance": "Analyze the existing scene and apply a minimal runnable change that preserves scene structure.",
    },
    "text_formula_layout": {
        "id": "text_formula_layout",
        "version": "v4",
        "name": "Text and formula layout",
        "guidance": "Chinese must use Text(). MathTex/Tex must contain formulas only. Keep all text in layout zones.",
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
    spec = brief.get("spec") or {}
    animation_type = str(brief.get("animation_type") or spec.get("animation_type") or "concept_explanation")
    selected = TYPE_TO_SKILLS.get(animation_type, TYPE_TO_SKILLS["concept_explanation"])
    if brief.get("intent") == "MODIFY":
        selected = ["code_modify", *selected]

    unique_ids = list(dict.fromkeys(selected))[: max(1, min(limit, 3))]
    return [SKILLS[skill_id] for skill_id in unique_ids]
