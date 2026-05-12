"""Agent v4 orchestration workflow for Manim generation."""

from __future__ import annotations

import os
from typing import Any, AsyncIterator

from .coder import generate_code
from .critic import critique_code
from .director import design_storyboard
from .inspector import inspect_code_quality
from .planner import plan_animation
from .repair import repair_code_async
from .renderer import render_code_for_agent
from .skill_loader import select_skills
from .style_director import select_style
from .visual_judge import inspect_visual_quality


def _preview_enabled() -> bool:
    return os.environ.get("MANIM_AGENT_PREVIEW_CHECK", "true").lower() not in {"0", "false", "off", "no"}


def _v4_enabled() -> bool:
    return os.environ.get("MANIM_AGENT_V4_ENABLED", "true").lower() not in {"0", "false", "off", "no"}


def _trace(
    brief: dict[str, Any],
    skills: list[dict[str, str]],
    *,
    retries: int = 0,
    failure_reason: str = "",
    quality: dict[str, Any] | None = None,
    visual: dict[str, Any] | None = None,
    storyboard_spec: dict[str, Any] | None = None,
    style_preset: dict[str, Any] | None = None,
    code_source: str = "llm_v4",
) -> dict[str, Any]:
    quality = quality or {}
    visual = visual or {}
    spec = storyboard_spec or brief.get("storyboardSpec") or brief.get("spec", {})
    visual_status = visual.get("status")
    visual_summary = visual.get("summary")
    overall_status = visual_status if visual_status and visual_status != "skipped" else quality.get("status")
    overall_summary = visual_summary if visual_status and visual_status != "skipped" else quality.get("summary")
    return {
        "brief": {
            "intent": brief.get("intent"),
            "domain": brief.get("domain"),
            "animationType": brief.get("animation_type"),
            "confidence": brief.get("confidence"),
            "storyboard": [shot.get("title", "") for shot in spec.get("shots", [])[:5]]
            or brief.get("storyboard", [])[:4],
        },
        "spec": spec,
        "storyboardSpec": spec,
        "stylePreset": style_preset or {},
        "skills": [skill["id"] for skill in skills],
        "template": "none",
        "codeSource": code_source,
        "quality": {
            "static": quality,
            "visual": visual,
            "status": overall_status,
            "summary": overall_summary,
        },
        "preview": visual,
        "repairs": {
            "count": retries,
            "reason": failure_reason,
        },
        "decisionLog": brief.get("decisionLog", []),
        "retries": retries,
        "failureReason": failure_reason,
    }


def _result(
    *,
    code: str,
    trace: dict[str, Any],
    rendered: bool = False,
    warning: str | None = None,
    render_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    render_result = render_result or {}
    return {
        "type": "result",
        "success": True,
        "intent": "manim",
        "rendered": rendered,
        "code": code,
        "videoUrl": render_result.get("videoUrl"),
        "videoBase64": render_result.get("videoBase64"),
        "warning": warning or render_result.get("warning"),
        "agentTrace": trace,
    }


async def _repair_from_report(
    code: str,
    brief: dict[str, Any],
    report: dict[str, Any],
    repair_attempts: int,
    *,
    ai_client: Any | None,
    model_name: str | None,
    storyboard_spec: dict[str, Any],
    style_preset: dict[str, Any],
    stderr: str = "",
) -> tuple[str, dict[str, Any], int, dict[str, Any]]:
    repaired = await repair_code_async(
        code,
        report,
        stderr=stderr,
        max_attempts=2,
        brief=brief,
        storyboard_spec=storyboard_spec,
        style_preset=style_preset,
        ai_client=ai_client,
        model_name=model_name,
    )
    next_code = repaired["code"]
    next_critic = repaired["critic"]
    return next_code, next_critic, repair_attempts + repaired["attempts"], repaired


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

    yield {"type": "progress", "step": "planner", "message": "正在理解动画需求"}
    brief = plan_animation(message, mode=mode, current_code=current_code)
    yield {
        "type": "plan",
        "brief": {
            "domain": brief.get("domain"),
            "animationType": brief.get("animation_type"),
            "confidence": brief.get("confidence"),
            "strategy": "v4_director_pipeline",
        },
    }
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

    if not _v4_enabled():
        warning = "Manim Agent v4 已被 MANIM_AGENT_V4_ENABLED=false 关闭。"
        yield {"type": "error", "success": False, "error": warning, "recoverable": True}
        yield _result(
            code="",
            trace=_trace(brief, [], failure_reason=warning, code_source="none"),
            rendered=False,
            warning=warning,
        )
        return

    if ai_client is None or not model_name:
        warning = "Manim Agent v4 需要 AI 配置，不会回退到固定模板。"
        yield {"type": "error", "success": False, "error": warning, "recoverable": True}
        yield _result(
            code="",
            trace=_trace(brief, [], failure_reason=warning, code_source="none"),
            rendered=False,
            warning=warning,
        )
        return

    yield {"type": "progress", "step": "design", "message": "正在设计教学分镜"}
    design = await design_storyboard(brief, ai_client=ai_client, model_name=model_name, current_code=current_code)
    if design["status"] != "success":
        yield _result(
            code="",
            trace=_trace(brief, [], failure_reason=design["summary"], code_source="none"),
            warning=design["summary"],
        )
        return
    storyboard_spec = design["storyboardSpec"]
    brief["storyboardSpec"] = storyboard_spec
    yield {"type": "design", "design": design}
    yield {"type": "storyboard", "storyboard": storyboard_spec.get("shots", [])}

    style_result = select_style(storyboard_spec)
    style_preset = style_result["stylePreset"]
    yield {"type": "style", "style": style_preset}

    yield {"type": "progress", "step": "skills", "message": "正在选择 Manim 运行时技能"}
    skills = select_skills(brief)
    yield {"type": "skills", "skills": skills}

    yield {"type": "progress", "step": "coder", "message": "正在生成 Manim 场景代码"}
    generated = await generate_code(
        brief,
        skills,
        current_code=current_code,
        ai_client=ai_client,
        model_name=model_name,
        storyboard_spec=storyboard_spec,
        style_preset=style_preset,
    )
    code = generated.get("code", "")
    code_source = generated.get("codeSource") or generated.get("source") or "llm_v4"
    yield {
        "type": "code",
        "code": code,
        "source": generated.get("source", "llm_v4"),
        "template": "none",
        "analysis": generated.get("analysis", {}),
        "warning": generated.get("warning"),
    }
    if generated.get("status") != "success":
        yield _result(
            code=code,
            trace=_trace(
                brief,
                skills,
                failure_reason=generated.get("summary", ""),
                storyboard_spec=storyboard_spec,
                style_preset=style_preset,
                code_source=code_source,
            ),
            warning=generated.get("summary") or "Manim Agent v4 未能生成代码。",
        )
        return

    yield {"type": "progress", "step": "critic", "message": "正在检查代码质量和安全性"}
    critic_report = critique_code(code, brief)
    yield {"type": "critic_report", "critic": critic_report}
    repair_attempts = 0
    if critic_report["status"] == "error":
        yield {"type": "repair", "step": "repair", "message": "正在修复静态代码问题"}
        code, critic_report, repair_attempts, repaired = await _repair_from_report(
            code,
            brief,
            critic_report,
            repair_attempts,
            ai_client=ai_client,
            model_name=model_name,
            storyboard_spec=storyboard_spec,
            style_preset=style_preset,
        )
        yield {"type": "code", "code": code, "source": "repair", "warning": None if repaired["status"] == "success" else repaired["summary"]}
        yield {"type": "critic_report", "critic": critic_report}

    if critic_report["status"] == "error":
        trace = _trace(
            brief,
            skills,
            retries=repair_attempts,
            failure_reason=critic_report["summary"],
            quality=critic_report,
            storyboard_spec=storyboard_spec,
            style_preset=style_preset,
            code_source=code_source,
        )
        yield _result(code=code, trace=trace, warning="Manim Agent v4 已生成代码，但静态检查仍需处理。")
        return

    yield {"type": "inspect", "step": "inspect", "message": "正在检查布局、可读性和语义一致性"}
    quality_report = inspect_code_quality(code, brief)
    yield {"type": "quality_report", "quality": quality_report}

    if quality_report["status"] == "error":
        yield {"type": "repair", "step": "repair", "message": "正在修复布局和语义问题"}
        code, critic_report, repair_attempts, repaired = await _repair_from_report(
            code,
            brief,
            {
                "status": "error",
                "issues": quality_report.get("findings", []),
                "summary": quality_report.get("summary", ""),
            },
            repair_attempts,
            ai_client=ai_client,
            model_name=model_name,
            storyboard_spec=storyboard_spec,
            style_preset=style_preset,
        )
        yield {"type": "code", "code": code, "source": "repair", "warning": None if repaired["status"] == "success" else repaired["summary"]}
        quality_report = inspect_code_quality(code, brief)
        yield {"type": "quality_report", "quality": quality_report}
        if critic_report["status"] == "error" or quality_report["status"] == "error":
            trace = _trace(
                brief,
                skills,
                retries=repair_attempts,
                failure_reason=quality_report.get("summary", critic_report["summary"]),
                quality=quality_report,
                storyboard_spec=storyboard_spec,
                style_preset=style_preset,
                code_source=code_source,
            )
            yield _result(code=code, trace=trace, warning="Manim Agent v4 已尝试修复代码，但质量检查仍需处理。")
            return

    visual_report: dict[str, Any] = {
        "status": "skipped",
        "summary": "render=false，已跳过视觉检查。",
        "findings": [],
        "metrics": {"previewCheckEnabled": _preview_enabled()},
    }

    if not render:
        yield {"type": "preview", "preview": visual_report}
        trace = _trace(
            brief,
            skills,
            retries=repair_attempts,
            quality=quality_report,
            visual=visual_report,
            storyboard_spec=storyboard_spec,
            style_preset=style_preset,
            code_source=code_source,
        )
        yield _result(code=code, trace=trace)
        return

    if _preview_enabled():
        preview_render: dict[str, Any] | None = None
        for attempt in range(2):
            yield {"type": "progress", "step": "preview", "message": "正在渲染预览并抽帧检查视觉质量"}
            preview_render = await render_code_for_agent(code, client_id=f"{client_id}_preview", stage="preview_render")
            visual_report = inspect_visual_quality(code, brief, preview_render)
            yield {"type": "visual_check", "visual": visual_report, "videoUrl": preview_render.get("videoUrl")}
            yield {"type": "preview", "preview": visual_report, "videoUrl": preview_render.get("videoUrl")}
            if visual_report["status"] != "error":
                break
            if attempt == 1:
                trace = _trace(
                    brief,
                    skills,
                    retries=repair_attempts,
                    failure_reason=visual_report.get("summary", ""),
                    quality=quality_report,
                    visual=visual_report,
                    storyboard_spec=storyboard_spec,
                    style_preset=style_preset,
                    code_source=code_source,
                )
                yield _result(code=code, trace=trace, warning="视觉检查未通过，已保留可编辑代码。", render_result=preview_render or {})
                return
            yield {"type": "repair", "step": "repair", "message": "正在修复视觉质量或预览渲染问题"}
            code, critic_report, repair_attempts, repaired = await _repair_from_report(
                code,
                brief,
                {
                    "status": "error",
                    "issues": visual_report.get("findings", []),
                    "summary": visual_report.get("summary", ""),
                },
                repair_attempts,
                ai_client=ai_client,
                model_name=model_name,
                storyboard_spec=storyboard_spec,
                style_preset=style_preset,
                stderr=(preview_render or {}).get("stderr") or (preview_render or {}).get("details") or (preview_render or {}).get("error") or "",
            )
            yield {"type": "code", "code": code, "source": "repair", "warning": None if repaired["status"] == "success" else repaired["summary"]}
            quality_report = inspect_code_quality(code, brief)
            yield {"type": "quality_report", "quality": quality_report}

    yield {"type": "progress", "step": "render", "message": "正在渲染最终 Manim 视频"}
    render_result = await render_code_for_agent(code, client_id=client_id, stage="final_render")
    final_visual = inspect_visual_quality(code, brief, render_result)
    trace = _trace(
        brief,
        skills,
        retries=repair_attempts,
        failure_reason="" if render_result.get("success") else render_result.get("error", ""),
        quality=quality_report,
        visual=final_visual,
        storyboard_spec=storyboard_spec,
        style_preset=style_preset,
        code_source=code_source,
    )
    yield _result(
        code=code,
        trace=trace,
        rendered=bool(render_result.get("success")) and final_visual["status"] != "error",
        warning=None if render_result.get("success") and final_visual["status"] != "error" else render_result.get("error") or final_visual.get("summary") or "Manim Agent v4 渲染失败。",
        render_result=render_result,
    )


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
            continue
    return {
        "type": "error",
        "success": False,
        "intent": "manim",
        "rendered": False,
        "error": "Agent stopped before producing a result.",
    }
