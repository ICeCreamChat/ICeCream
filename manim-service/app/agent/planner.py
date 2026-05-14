"""Planner for natural-language Manim requests."""

from __future__ import annotations

from typing import Any

from .intent_router import route_intent
from .spec import (
    code_modify_spec,
    data_chart_spec,
    default_spec,
    flow_process_spec,
    formula_derivation_spec,
    geometry_circle_spec,
    geometry_square_spec,
    function_graph_spec,
    geometry_proof_spec,
    physics_motion_spec,
    triangle_spec,
)


def _spec_for_route(route: dict[str, Any], current_code: str = "") -> dict[str, Any]:
    message = route["message"]
    animation_type = route["animation_type"]
    domain = route["domain"]

    if animation_type == "function_graph":
        return function_graph_spec(message, route.get("function") or "sin").to_dict()
    if animation_type == "formula_derivation":
        return formula_derivation_spec(message).to_dict()
    if animation_type == "geometry_circle":
        return geometry_circle_spec(message).to_dict()
    if animation_type == "square":
        return geometry_square_spec(message).to_dict()
    if animation_type == "triangle":
        return triangle_spec(message).to_dict()
    if domain == "geometry":
        return geometry_proof_spec(message).to_dict()
    if domain == "data":
        return data_chart_spec(message).to_dict()
    if domain == "physics":
        return physics_motion_spec(message).to_dict()
    if domain == "flow":
        return flow_process_spec(message).to_dict()
    if domain == "code" or current_code.strip():
        return code_modify_spec(message).to_dict()
    return default_spec(message).to_dict()


def plan_animation(
    message: str,
    mode: str = "create",
    current_code: str = "",
) -> dict[str, Any]:
    """Convert a user prompt into a deterministic Manim Agent v6 routing brief."""
    route = route_intent(message, mode=mode, current_code=current_code)
    spec = _spec_for_route(route, current_code=current_code)
    storyboard = spec.get("storyboard") or spec.get("teaching_steps") or []

    return {
        "intent": route["intent"],
        "domain": route["domain"],
        "animation_type": route["animation_type"],
        "message": route["message"],
        "target_objects": spec.get("objects", []),
        "storyboard": storyboard,
        "layout": {
            "frame": "16:9",
            "safe_margin": 0.7,
            "zones": spec.get("layout_zones", []),
            "text_policy": "中文使用 Text，公式只使用 MathTex。",
        },
        "spec": spec,
        "risks": spec.get("risk_flags", []),
        "confidence": route["confidence"],
        "clarification": route["clarification"],
        "plannerStrategy": "rule_first_v6",
        "decisionLog": route["decision_log"],
        "currentCodeSummary": {
            "hasCode": bool(current_code.strip()),
            "length": len(current_code or ""),
        },
    }
