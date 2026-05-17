"""Agent v6 orchestration workflow for Manim generation."""

from __future__ import annotations

import os
from typing import Any, AsyncIterator

from app import service_config

from .code_streamer import stream_scene_code_events
from .code_writer import iter_code_deltas
from .critic import critique_code
from .director import design_storyboard
from .failure_events import record_failure_event
from .inspector import inspect_code_quality
from .job_registry import create_job, is_cancelled, register_render_client, update_job
from .manim_knowledge import RULE_PACK_VERSION, semantic_target_from_brief
from .planner import plan_animation
from .prompt_loader import API_INDEX_VERSION, PROMPT_PACK_VERSION
from .reference_analyzer import analyze_references
from .reference_store import resolve_reference_records, resolve_references
from .render_cache import get_cached_render, save_cached_render
from .repair import repair_code_async
from .renderer import render_code_for_agent
from .rescue_scene import rescue_scene_code
from .scene_manifest import build_scene_manifest
from .skill_loader import select_skills
from .static_guard import run_static_guard
from .studio_patch import build_patch_plan
from .style_director import select_style
from .visual_judge import inspect_visual_quality


def _preview_enabled() -> bool:
    return os.environ.get("MANIM_AGENT_PREVIEW_CHECK", "true").lower() not in {"0", "false", "off", "no"}


def _v5_enabled() -> bool:
    value = os.environ.get("MANIM_AGENT_V5_ENABLED")
    if value is None:
        value = os.environ.get("MANIM_AGENT_V4_ENABLED", "true")
    return str(value).lower() not in {"0", "false", "off", "no"}


def _v6_enabled() -> bool:
    value = os.environ.get("MANIM_AGENT_V6_ENABLED")
    if value is None:
        value = os.environ.get("MANIM_AGENT_V5_ENABLED")
    if value is None:
        value = os.environ.get("MANIM_AGENT_V4_ENABLED", "true")
    return str(value).lower() not in {"0", "false", "off", "no"}


def _should_rescue_visual_warning(brief: dict[str, Any], visual_report: dict[str, Any]) -> bool:
    if visual_report.get("status") != "warning":
        return False
    spec = brief.get("storyboardSpec") or brief.get("spec") or {}
    kind = str(spec.get("kind") or spec.get("animation_type") or brief.get("animation_type") or "")
    if kind not in {"geometry_circle", "triangle", "function_graph", "data_chart", "bar_chart", "motion_path", "physics_motion"}:
        return False
    warning_codes = {item.get("code") for item in visual_report.get("findings", [])}
    return bool(warning_codes & {"subject_too_small", "low_contrast_warning", "black_border", "edge_overflow"})


def _visual_finding_codes(visual_report: dict[str, Any]) -> set[str]:
    return {str(item.get("code") or "") for item in visual_report.get("findings", []) if item.get("code")}


def _is_preview_infrastructure_report(visual_report: dict[str, Any]) -> bool:
    if (visual_report.get("metrics") or {}).get("failureClass") == "preview_infrastructure":
        return True
    codes = _visual_finding_codes(visual_report)
    return bool(codes) and codes <= {"preview_infrastructure_warning", "frame_extract_missing"}


def _mark_visual_retry(visual_report: dict[str, Any], retry_count: int, stage: str) -> dict[str, Any]:
    metrics = dict(visual_report.get("metrics") or {})
    metrics["retryCount"] = retry_count
    metrics["gateStage"] = stage
    return {**visual_report, "metrics": metrics}


def _should_repair_layout_warning(brief: dict[str, Any], quality_report: dict[str, Any]) -> bool:
    if quality_report.get("status") != "warning":
        return False
    spec = brief.get("storyboardSpec") or brief.get("spec") or {}
    kind = str(spec.get("kind") or spec.get("animation_type") or brief.get("animation_type") or "")
    prompt = str(brief.get("message") or "").lower()
    strict_context = kind in {"formula_derivation", "geometry_proof", "process_flow", "flow_process"} or any(
        term in prompt for term in ("推导", "证明", "过程", "流程", "derive", "proof", "process")
    )
    if not strict_context:
        return False
    codes = {str(item.get("code") or "") for item in quality_report.get("findings", [])}
    return bool(codes & {
        "unsafe_next_to_chain",
        "connector_offscreen_risk",
        "panel_overlap_risk",
        "derivation_layout_missing",
        "stage_cleanup_missing",
    })


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
    code_source: str = "llm_v6",
    code: str = "",
) -> dict[str, Any]:
    quality = quality or {}
    visual = visual or {}
    spec = storyboard_spec or brief.get("storyboardSpec") or brief.get("spec", {})
    visual_status = visual.get("status")
    visual_summary = visual.get("summary")
    overall_status = visual_status if visual_status and visual_status != "skipped" else quality.get("status")
    overall_summary = visual_summary if visual_status and visual_status != "skipped" else quality.get("summary")
    scene_manifest = build_scene_manifest(code, {**brief, "storyboardSpec": spec}) if code else {}
    return {
        "brief": {
            "intent": brief.get("intent"),
            "domain": brief.get("domain"),
            "animationType": brief.get("animation_type"),
            "confidence": brief.get("confidence"),
            "message": brief.get("message"),
            "storyboard": [shot.get("title", "") for shot in spec.get("shots", [])[:5]]
            or brief.get("storyboard", [])[:4],
        },
        "spec": spec,
        "jobId": brief.get("jobId"),
        "rulePackVersion": RULE_PACK_VERSION,
        "semanticTarget": semantic_target_from_brief({**brief, "storyboardSpec": spec}),
        "referenceSummary": brief.get("referenceSummary", ""),
        "referenceSpecs": brief.get("referenceSpecs", []),
        "referenceSemanticTarget": brief.get("referenceSemanticTarget", ""),
        "referenceWarnings": brief.get("referenceWarnings", []),
        "referenceConflict": brief.get("referenceConflict", ""),
        "sceneManifest": scene_manifest,
        "runtimeSceneManifest": scene_manifest,
        "staticFindings": (quality or {}).get("issues") or (quality or {}).get("findings") or [],
        "storyboardSpec": spec,
        "stylePreset": style_preset or {},
        "skills": [skill["id"] for skill in skills],
        "template": "none",
        "codeSource": code_source,
        "promptPackVersion": PROMPT_PACK_VERSION,
        "apiIndexVersion": API_INDEX_VERSION,
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
            "rules": [
                item.get("code")
                for item in ((quality or {}).get("issues") or (quality or {}).get("findings") or [])
                if item.get("code")
            ],
        },
        "repairRules": [
            item.get("code")
            for item in ((quality or {}).get("issues") or (quality or {}).get("findings") or [])
            if item.get("code")
        ],
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
    if render_result.get("sceneManifest") or render_result.get("runtimeSceneManifest"):
        trace = dict(trace or {})
        if render_result.get("sceneManifest"):
            trace["sceneManifest"] = render_result.get("sceneManifest")
        trace["runtimeSceneManifest"] = render_result.get("runtimeSceneManifest") or render_result.get("sceneManifest")
    payload = {
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
    if warning or render_result.get("success") is False:
        event_id = record_failure_event(payload, code=code)
        if event_id:
            payload.setdefault("agentTrace", {})["failureEventId"] = event_id
    return payload


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
        max_attempts=service_config.get_manim_agent_repair_attempts(),
        brief=brief,
        storyboard_spec=storyboard_spec,
        style_preset=style_preset,
        ai_client=ai_client,
        model_name=model_name,
    )
    next_code = repaired["code"]
    next_critic = repaired["critic"]
    return next_code, next_critic, repair_attempts + repaired["attempts"], repaired


async def _emit_code_events(code: str, *, source: str, warning: str | None = None) -> AsyncIterator[dict[str, Any]]:
    for delta in iter_code_deltas(code):
        delta["source"] = source
        yield delta
    yield {"type": "code", "code": code, "source": source, "template": "none", "warning": warning}


async def _emit_rescue_code(
    brief: dict[str, Any],
    reason: str,
) -> tuple[str, dict[str, Any], dict[str, Any]]:
    code = rescue_scene_code(brief, reason)
    if not code:
        return "", {"status": "error", "issues": [], "summary": reason}, {"status": "error", "findings": [], "summary": reason}
    critic_report = critique_code(code, brief)
    quality_report = inspect_code_quality(code, brief)
    return code, critic_report, quality_report


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
    job = create_job(payload)
    job_id = job["jobId"]
    reference_ids = [str(item) for item in (payload.get("referenceImageIds") or []) if str(item).strip()]
    requested_skill_ids = [str(item) for item in (payload.get("skillIds") or []) if str(item).strip()]

    yield {"type": "job", "job": job}

    def _stop_if_cancelled() -> dict[str, Any] | None:
        if not is_cancelled(job_id):
            return None
        warning = "Manim 任务已取消。"
        update_job(job_id, status="cancelled", current_stage="cancelled", summary=warning)
        return _result(code="", trace={"jobId": job_id, "failureReason": warning}, rendered=False, warning=warning)

    yield {"type": "progress", "step": "planner", "message": "正在理解动画需求"}
    update_job(job_id, status="running", current_stage="planner", summary="正在理解动画需求", event={"type": "progress", "step": "planner", "message": "正在理解动画需求"})
    brief = plan_animation(message, mode=mode, current_code=current_code)
    brief["jobId"] = job_id
    brief["requestedSkillIds"] = requested_skill_ids
    brief["referenceImageIds"] = reference_ids
    yield {
        "type": "plan",
        "brief": {
            "domain": brief.get("domain"),
            "animationType": brief.get("animation_type"),
            "confidence": brief.get("confidence"),
            "strategy": "v6_director_pipeline",
            "jobId": job_id,
        },
    }
    if brief.get("clarification"):
        update_job(job_id, status="waiting", current_stage="clarification", summary="需要补充动画目标")
        yield {
            "type": "clarification",
            "success": True,
            "intent": "manim",
            "rendered": False,
            "clarification": brief["clarification"],
            "agentTrace": _trace(brief, []),
        }
        return

    if not _v6_enabled():
        warning = "Manim Agent v6 已被配置关闭。"
        yield {"type": "error", "success": False, "error": warning, "recoverable": True}
        update_job(job_id, status="failed", current_stage="disabled", summary=warning)
        yield _result(code="", trace=_trace(brief, [], failure_reason=warning, code_source="none"), rendered=False, warning=warning)
        return

    if ai_client is None or not model_name:
        warning = "Manim Agent v6 需要 AI 配置，不会回退到固定整段模板。"
        yield {"type": "error", "success": False, "error": warning, "recoverable": True}
        update_job(job_id, status="failed", current_stage="ai_config", summary=warning)
        yield _result(code="", trace=_trace(brief, [], failure_reason=warning, code_source="none"), rendered=False, warning=warning)
        return

    references = resolve_references(reference_ids)
    if references:
        reference_records = resolve_reference_records(reference_ids)
        reference_analysis = analyze_references(reference_records, brief)
        brief["references"] = references
        brief["referenceSpecs"] = reference_analysis.get("referenceSpecs", [])
        brief["referenceSummary"] = reference_analysis.get("summary", "")
        brief["referenceWarnings"] = reference_analysis.get("warnings", [])
        brief["referenceConflict"] = reference_analysis.get("conflict", "")
        reference_target = reference_analysis.get("referenceSemanticTarget")
        if reference_target:
            brief["referenceSemanticTarget"] = reference_target
        yield {
            "type": "reference",
            "references": references,
            "referenceSpecs": brief["referenceSpecs"],
            "status": reference_analysis.get("status", "pass"),
            "summary": brief["referenceSummary"] or "已解析参考素材",
            "warnings": brief["referenceWarnings"],
            "conflict": brief["referenceConflict"],
        }

    if mode == "modify":
        patch_plan = build_patch_plan(message, current_code)
        brief["patchPlan"] = patch_plan
        yield {"type": "patch_plan", "patchPlan": patch_plan}

    yield {"type": "progress", "step": "design", "message": "正在设计教学分镜"}
    update_job(job_id, current_stage="design", summary="正在设计教学分镜", event={"type": "progress", "step": "design"})
    design = await design_storyboard(brief, ai_client=ai_client, model_name=model_name, current_code=current_code)
    if design["status"] != "success":
        update_job(job_id, status="failed", current_stage="design", summary=design["summary"])
        yield _result(code="", trace=_trace(brief, [], failure_reason=design["summary"], code_source="none"), warning=design["summary"])
        return
    cancelled = _stop_if_cancelled()
    if cancelled:
        yield cancelled
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
    yield {"type": "skill_activation", "skills": skills, "catalogVersion": "manim-v6-skills"}
    yield {"type": "skills", "skills": skills}

    yield {"type": "progress", "step": "coder", "message": "正在生成 Manim 场景代码"}
    update_job(job_id, current_stage="coder", summary="正在生成 Manim 场景代码", event={"type": "progress", "step": "coder"})
    generated: dict[str, Any] = {
        "status": "error",
        "summary": "Manim Agent v6 未能生成代码。",
        "code": "",
        "source": "llm_v6",
        "codeSource": "llm_v6",
        "analysis": {},
    }
    async for event in stream_scene_code_events(
        brief,
        storyboard_spec,
        style_preset,
        skills,
        current_code=current_code,
        ai_client=ai_client,
        model_name=model_name,
    ):
        if event.get("type") == "generated":
            generated = event.get("generated", generated)
            break
        event.setdefault("analysis", {})
        yield event
    code = generated.get("code", "")
    code_source = generated.get("codeSource") or generated.get("source") or "llm_v6"
    if code:
        yield {
            "type": "code",
            "code": code,
            "source": generated.get("source", "llm_v6"),
            "template": "none",
            "warning": generated.get("warning"),
            "analysis": generated.get("analysis", {}),
        }
    if generated.get("status") != "success":
        yield _result(
            code=code,
            trace=_trace(brief, skills, failure_reason=generated.get("summary", ""), storyboard_spec=storyboard_spec, style_preset=style_preset, code_source=code_source, code=code),
            warning=generated.get("summary") or "Manim Agent v6 未能生成代码。",
        )
        return

    repair_attempts = 0
    yield {"type": "progress", "step": "critic", "message": "正在运行 Python 静态守卫"}
    static_guard_report = run_static_guard(code, brief)
    yield {"type": "static_guard", "guard": static_guard_report}
    if static_guard_report["status"] == "error":
        yield {"type": "repair", "step": "repair", "message": "正在修复 Python 编译问题"}
        code, _critic_after_static, repair_attempts, repaired = await _repair_from_report(
            code,
            brief,
            static_guard_report,
            repair_attempts,
            ai_client=ai_client,
            model_name=model_name,
            storyboard_spec=storyboard_spec,
            style_preset=style_preset,
            stderr="; ".join(issue.get("details") or issue.get("message", "") for issue in static_guard_report.get("issues", [])),
        )
        code_source = "repair"
        async for event in _emit_code_events(code, source="repair", warning=None if repaired["status"] == "success" else repaired["summary"]):
            yield event
        static_guard_report = run_static_guard(code, brief)
        yield {"type": "static_guard", "guard": static_guard_report}

    if static_guard_report["status"] == "error":
        rescue_code, rescue_critic, rescue_quality = await _emit_rescue_code(brief, static_guard_report.get("summary", "Python 静态守卫失败"))
        rescue_guard = run_static_guard(rescue_code, brief) if rescue_code else static_guard_report
        if rescue_code and rescue_guard["status"] != "error" and rescue_critic["status"] != "error" and rescue_quality["status"] != "error":
            code = rescue_code
            code_source = "rescue"
            static_guard_report = rescue_guard
            critic_report = rescue_critic
            quality_report = rescue_quality
            repair_attempts += 1
            async for event in _emit_code_events(code, source="rescue", warning="已切换到质量兜底场景。"):
                yield event
            yield {"type": "static_guard", "guard": static_guard_report}
            yield {"type": "critic_report", "critic": critic_report}
            yield {"type": "quality_report", "quality": quality_report}

    if static_guard_report["status"] == "error":
        trace = _trace(
            brief,
            skills,
            retries=repair_attempts,
            failure_reason=static_guard_report["summary"],
            quality=static_guard_report,
            storyboard_spec=storyboard_spec,
            style_preset=style_preset,
            code_source=code_source,
            code=code,
        )
        yield _result(code=code, trace=trace, warning="Manim Agent v6 已生成代码，但 Python 静态守卫仍需处理。")
        return

    yield {"type": "progress", "step": "critic", "message": "正在检查代码质量和安全性"}
    critic_report = critique_code(code, brief)
    yield {"type": "critic_report", "critic": critic_report}
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
        code_source = "repair"
        async for event in _emit_code_events(code, source="repair", warning=None if repaired["status"] == "success" else repaired["summary"]):
            yield event
        yield {"type": "critic_report", "critic": critic_report}

    if critic_report["status"] == "error":
        rescue_code, rescue_critic, rescue_quality = await _emit_rescue_code(brief, critic_report.get("summary", "静态检查失败"))
        if rescue_code and rescue_critic["status"] != "error" and rescue_quality["status"] != "error":
            code = rescue_code
            code_source = "rescue"
            critic_report = rescue_critic
            quality_report = rescue_quality
            repair_attempts += 1
            async for event in _emit_code_events(code, source="rescue", warning="已切换到质量兜底场景。"):
                yield event
            yield {"type": "critic_report", "critic": critic_report}
            yield {"type": "quality_report", "quality": quality_report}

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
            code=code,
        )
        yield _result(code=code, trace=trace, warning="Manim Agent v6 已生成代码，但静态检查仍需处理。")
        return

    yield {"type": "inspect", "step": "inspect", "message": "正在检查布局、可读性和语义一致性"}
    quality_report = inspect_code_quality(code, brief)
    yield {"type": "quality_report", "quality": quality_report}

    repair_layout_warning = _should_repair_layout_warning(brief, quality_report)
    if quality_report["status"] == "error" or repair_layout_warning:
        repair_message = "正在修复高风险布局问题" if repair_layout_warning else "正在修复布局或语义问题"
        yield {"type": "repair", "step": "repair", "message": repair_message}
        code, critic_report, repair_attempts, repaired = await _repair_from_report(
            code,
            brief,
            {"status": "error", "issues": quality_report.get("findings", []), "summary": quality_report.get("summary", "")},
            repair_attempts,
            ai_client=ai_client,
            model_name=model_name,
            storyboard_spec=storyboard_spec,
            style_preset=style_preset,
        )
        code_source = "repair"
        async for event in _emit_code_events(code, source="repair", warning=None if repaired["status"] == "success" else repaired["summary"]):
            yield event
        quality_report = inspect_code_quality(code, brief)
        yield {"type": "quality_report", "quality": quality_report}
        if critic_report["status"] == "error" or quality_report["status"] == "error":
            rescue_code, rescue_critic, rescue_quality = await _emit_rescue_code(brief, quality_report.get("summary", critic_report.get("summary", "")))
            if rescue_code and rescue_critic["status"] != "error" and rescue_quality["status"] != "error":
                code = rescue_code
                code_source = "rescue"
                critic_report = rescue_critic
                quality_report = rescue_quality
                repair_attempts += 1
                async for event in _emit_code_events(code, source="rescue", warning="已切换到质量兜底场景。"):
                    yield event
                yield {"type": "critic_report", "critic": critic_report}
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
                code=code,
            )
            yield _result(code=code, trace=trace, warning="Manim Agent v6 已尝试修复代码，但质量检查仍需处理。")
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
            code=code,
        )
        yield _result(code=code, trace=trace)
        return

    if _preview_enabled():
        preview_render: dict[str, Any] | None = None
        for attempt in range(2):
            yield {"type": "progress", "step": "preview", "message": "正在渲染预览并抽帧检查视觉质量"}
            preview_client_id = f"{client_id}_{job_id}_preview"
            register_render_client(job_id, preview_client_id)
            preview_render = await render_code_for_agent(code, client_id=preview_client_id, stage="preview_render")
            visual_report = inspect_visual_quality(code, brief, preview_render)
            visual_report = _mark_visual_retry(visual_report, attempt, "preview_visual_check")
            yield {"type": "visual_check", "visual": visual_report, "videoUrl": preview_render.get("videoUrl")}
            yield {"type": "preview", "preview": visual_report, "videoUrl": preview_render.get("videoUrl")}
            if _is_preview_infrastructure_report(visual_report):
                if attempt == 0:
                    yield {
                        "type": "diagnostic",
                        "step": "visual_check",
                        "status": "warning",
                        "summary": "预览通道提前关闭，正在重试预览。",
                        "details": ["这通常是预览流提前断开，不一定代表动画代码错误。"],
                    }
                    continue
                if service_config.get_manim_visual_gate_policy() != "strict":
                    yield {
                        "type": "diagnostic",
                        "step": "visual_check",
                        "status": "warning",
                        "summary": "预览通道仍不稳定，将转入最终渲染后复检。",
                        "details": ["最终渲染完成后会再次做视觉检查，发现出框或遮挡仍会拦截。"],
                    }
                    break
                visual_report = {
                    **visual_report,
                    "status": "error",
                    "summary": "严格模式下，预览通道异常需要先修复或重新生成。",
                }
                yield {"type": "visual_check", "stage": "preview_visual_check", "visual": visual_report, "videoUrl": preview_render.get("videoUrl")}
            if _should_rescue_visual_warning(brief, visual_report):
                rescue_code, rescue_critic, rescue_quality = await _emit_rescue_code(brief, visual_report.get("summary", "视觉质量警告"))
                if rescue_code and rescue_critic["status"] != "error" and rescue_quality["status"] != "error":
                    code = rescue_code
                    code_source = "rescue"
                    critic_report = rescue_critic
                    quality_report = rescue_quality
                    repair_attempts += 1
                    async for event in _emit_code_events(code, source="rescue", warning="已切换到质量兜底场景。"):
                        yield event
                    yield {"type": "critic_report", "critic": critic_report}
                    yield {"type": "quality_report", "quality": quality_report}
                    preview_client_id = f"{client_id}_{job_id}_preview_rescue"
                    register_render_client(job_id, preview_client_id)
                    preview_render = await render_code_for_agent(code, client_id=preview_client_id, stage="preview_render")
                    visual_report = inspect_visual_quality(code, brief, preview_render)
                    visual_report = _mark_visual_retry(visual_report, attempt, "preview_visual_check")
                    yield {"type": "visual_check", "visual": visual_report, "videoUrl": preview_render.get("videoUrl")}
                    yield {"type": "preview", "preview": visual_report, "videoUrl": preview_render.get("videoUrl")}
            if visual_report["status"] != "error":
                break
            if attempt == 1:
                rescue_code, rescue_critic, rescue_quality = await _emit_rescue_code(brief, visual_report.get("summary", "视觉检查失败"))
                if rescue_code and rescue_critic["status"] != "error" and rescue_quality["status"] != "error":
                    code = rescue_code
                    code_source = "rescue"
                    critic_report = rescue_critic
                    quality_report = rescue_quality
                    repair_attempts += 1
                    async for event in _emit_code_events(code, source="rescue", warning="已切换到质量兜底场景。"):
                        yield event
                    yield {"type": "critic_report", "critic": critic_report}
                    yield {"type": "quality_report", "quality": quality_report}
                    preview_client_id = f"{client_id}_{job_id}_preview_rescue"
                    register_render_client(job_id, preview_client_id)
                    preview_render = await render_code_for_agent(code, client_id=preview_client_id, stage="preview_render")
                    visual_report = inspect_visual_quality(code, brief, preview_render)
                    visual_report = _mark_visual_retry(visual_report, attempt, "preview_visual_check")
                    yield {"type": "visual_check", "visual": visual_report, "videoUrl": preview_render.get("videoUrl")}
                    yield {"type": "preview", "preview": visual_report, "videoUrl": preview_render.get("videoUrl")}
                    if visual_report["status"] != "error":
                        break
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
                    code=code,
                )
                yield _result(code=code, trace=trace, warning="视觉检查未通过，已保留可编辑代码。", render_result=preview_render or {})
                return
            yield {"type": "repair", "step": "repair", "message": "正在修复视觉质量或预览渲染问题"}
            code, critic_report, repair_attempts, repaired = await _repair_from_report(
                code,
                brief,
                {"status": "error", "issues": visual_report.get("findings", []), "summary": visual_report.get("summary", "")},
                repair_attempts,
                ai_client=ai_client,
                model_name=model_name,
                storyboard_spec=storyboard_spec,
                style_preset=style_preset,
                stderr=(preview_render or {}).get("stderr") or (preview_render or {}).get("details") or (preview_render or {}).get("error") or "",
            )
            code_source = "repair"
            async for event in _emit_code_events(code, source="repair", warning=None if repaired["status"] == "success" else repaired["summary"]):
                yield event
            quality_report = inspect_code_quality(code, brief)
            yield {"type": "quality_report", "quality": quality_report}

    cancelled = _stop_if_cancelled()
    if cancelled:
        yield cancelled
        return

    yield {"type": "progress", "step": "render", "message": "正在渲染最终 Manim 视频"}
    update_job(job_id, current_stage="render", summary="正在渲染最终 Manim 视频", event={"type": "progress", "step": "render"})
    cached_render = get_cached_render(code)
    if cached_render:
        yield {"type": "cache", "status": "hit", "cacheKey": cached_render.get("cacheKey"), "videoUrl": cached_render.get("videoUrl"), "summary": "命中渲染缓存，已复用视频"}
        render_result = {"success": True, **cached_render}
    else:
        yield {"type": "cache", "status": "miss", "summary": "未命中渲染缓存，开始正式渲染"}
        final_client_id = f"{client_id}_{job_id}_final"
        register_render_client(job_id, final_client_id)
        render_result = await render_code_for_agent(code, client_id=final_client_id, stage="final_render")
    final_visual = inspect_visual_quality(code, brief, render_result)
    final_visual = _mark_visual_retry(final_visual, 0, "final_visual_check")
    yield {"type": "visual_check", "stage": "final_visual_check", "visual": final_visual, "videoUrl": render_result.get("videoUrl")}
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
        code=code,
    )
    rendered = bool(render_result.get("success")) and final_visual["status"] != "error"
    if rendered and not cached_render:
        save_cached_render(code, render_result, trace=trace)
    update_job(
        job_id,
        status="completed" if rendered else "failed",
        current_stage="render",
        summary="最终动画已生成" if rendered else (render_result.get("error") or final_visual.get("summary") or "渲染失败"),
        event={"type": "result", "stage": "render", "summary": "最终动画已生成" if rendered else "渲染失败"},
    )
    yield _result(
        code=code,
        trace=trace,
        rendered=rendered,
        warning=None if rendered else render_result.get("error") or final_visual.get("summary") or "Manim Agent v6 渲染失败。",
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
        if event.get("type") in {"code", "code_delta"}:
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
