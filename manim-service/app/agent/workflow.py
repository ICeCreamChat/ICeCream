"""Agent orchestration workflow for Manim generation."""

from __future__ import annotations

from typing import Any, AsyncIterator

from .coder import generate_code
from .critic import critique_code
from .planner import plan_animation
from .repair import repair_code
from .renderer import render_code_for_agent
from .skill_loader import select_skills


def _trace(
    brief: dict[str, Any],
    skills: list[dict[str, str]],
    retries: int = 0,
    failure_reason: str = "",
) -> dict[str, Any]:
    return {
        "brief": {
            "intent": brief.get("intent"),
            "domain": brief.get("domain"),
            "confidence": brief.get("confidence"),
            "storyboard": brief.get("storyboard", [])[:3],
        },
        "skills": [skill["id"] for skill in skills],
        "retries": retries,
        "failureReason": failure_reason,
    }


async def stream_agent_events(
    payload: dict[str, Any],
    ai_client: Any | None = None,
    model_name: str | None = None,
    render: bool = True,
) -> AsyncIterator[dict[str, Any]]:
    """Yield structured agent events for streaming routes."""
    message = str(payload.get("message") or "").strip()
    mode = str(payload.get("mode") or "create")
    current_code = str(payload.get("currentCode") or "")
    client_id = str(payload.get("clientId") or "agent")

    yield {"type": "progress", "step": "planner", "message": "Understanding animation request"}
    brief = plan_animation(message, mode=mode, current_code=current_code)
    if brief.get("clarification"):
        yield {
            "type": "clarification",
            "success": True,
            "intent": "manim",
            "rendered": False,
            "clarification": brief["clarification"],
            "agentTrace": _trace(brief, []),
        }
        return

    yield {"type": "progress", "step": "skills", "message": "Selecting Manim runtime skills"}
    skills = select_skills(brief)

    yield {"type": "progress", "step": "coder", "message": "Generating Manim code"}
    generated = await generate_code(
        brief,
        skills,
        current_code=current_code,
        ai_client=ai_client,
        model_name=model_name,
    )
    code = generated["code"]
    yield {
        "type": "code",
        "code": code,
        "source": generated.get("source", "unknown"),
        "warning": generated.get("warning"),
    }

    yield {"type": "progress", "step": "critic", "message": "Checking code quality and safety"}
    critic_report = critique_code(code, brief)
    repair_attempts = 0
    if critic_report["status"] == "error":
        yield {"type": "progress", "step": "repair", "message": "Repairing static code issues"}
        repaired = repair_code(code, critic_report, max_attempts=2)
        code = repaired["code"]
        critic_report = repaired["critic"]
        repair_attempts = repaired["attempts"]
        yield {
            "type": "code",
            "code": code,
            "source": "repair",
            "warning": None if repaired["status"] == "success" else repaired["summary"],
        }

    trace = _trace(
        brief,
        skills,
        retries=repair_attempts,
        failure_reason="" if critic_report["status"] != "error" else critic_report["summary"],
    )

    if critic_report["status"] == "error":
        yield {
            "type": "result",
            "success": True,
            "intent": "manim",
            "rendered": False,
            "code": code,
            "warning": "Manim Agent generated code but static checks still need attention.",
            "agentTrace": trace,
        }
        return

    if not render:
        yield {
            "type": "result",
            "success": True,
            "intent": "manim",
            "rendered": False,
            "code": code,
            "agentTrace": trace,
        }
        return

    yield {"type": "progress", "step": "render", "message": "Rendering Manim video"}
    render_result = await render_code_for_agent(code, client_id=client_id)
    if render_result.get("success"):
        yield {
            "type": "result",
            "success": True,
            "intent": "manim",
            "rendered": True,
            "code": code,
            "videoUrl": render_result.get("videoUrl"),
            "videoBase64": render_result.get("videoBase64"),
            "warning": render_result.get("warning"),
            "agentTrace": trace,
        }
        return

    yield {
        "type": "result",
        "success": True,
        "intent": "manim",
        "rendered": False,
        "code": code,
        "warning": render_result.get("error") or "Manim Agent render failed.",
        "agentTrace": _trace(brief, skills, retries=repair_attempts, failure_reason=render_result.get("error", "")),
    }


async def run_agent(
    payload: dict[str, Any],
    ai_client: Any | None = None,
    model_name: str | None = None,
    render: bool = True,
) -> dict[str, Any]:
    """Run the agent and return the final non-progress payload."""
    last_code_event: dict[str, Any] | None = None
    async for event in stream_agent_events(payload, ai_client=ai_client, model_name=model_name, render=render):
        if event.get("type") == "code":
            last_code_event = event
        if event.get("type") == "clarification":
            return event
        if event.get("type") == "result":
            if last_code_event and "code" not in event:
                event["code"] = last_code_event.get("code", "")
            return event
        if event.get("type") == "error":
            return event
    return {
        "type": "error",
        "success": False,
        "intent": "manim",
        "rendered": False,
        "error": "Agent stopped before producing a result.",
    }

