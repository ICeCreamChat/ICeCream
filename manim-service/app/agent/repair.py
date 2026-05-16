"""Repair helpers for Manim Agent v6."""

from __future__ import annotations

import json
import re
from typing import Any, Callable

from .code_writer import extract_code_from_text
from .critic import critique_code
from .manim_knowledge import RULE_PACK_VERSION, manim_rules_prompt, rule_hint, semantic_target_from_brief
from .prompt_loader import build_repair_prompt_pack


Fixer = Callable[[str, dict[str, Any]], str]


def _failure_category(report: dict[str, Any], stderr: str = "") -> str:
    codes = {str(item.get("code", "")) for item in report.get("issues", []) + report.get("findings", [])}
    text = f"{report.get('summary', '')} {stderr}".lower()
    if any(code.startswith("semantic_") or code.startswith("visual_") for code in codes):
        return "语义或视觉错配"
    if "latex" in text or "tex" in text:
        return "LaTeX/公式渲染问题"
    if (
        "unexpected keyword" in text
        or "mobject.__getattr__" in text
        or "invalid_manim_keyword" in codes
        or "unsafe_mobject_setter_keyword" in codes
        or "invalid_vgroup_child" in codes
    ):
        return "Manim API 或参数调用错误"
    if "attributeerror" in text or "syntax" in text or "nameerror" in text or "unknown_scene_method" in codes:
        return "Manim API 或代码错误"
    if "black" in text or "contrast" in text or "视觉" in text or "预览" in text:
        return "视觉质量问题"
    if "安全" in text or "system" in text or "security" in codes:
        return "安全规则问题"
    return "静态质量问题"


def build_repair_observation(
    code: str,
    report: dict[str, Any],
    *,
    stderr: str = "",
    attempt: int = 1,
    brief: dict[str, Any] | None = None,
    storyboard_spec: dict[str, Any] | None = None,
    style_preset: dict[str, Any] | None = None,
) -> dict[str, Any]:
    issues = report.get("issues") or report.get("findings") or []
    root = "; ".join(str(item.get("message", "")) for item in issues[:5]) or stderr[-500:] or report.get("summary", "")
    rule_codes = [str(item.get("code", "")) for item in issues if item.get("code")]
    repair_rules = [
        {"id": code, "hint": rule_hint(code, str(item.get("hint", "")))}
        for code, item in zip(rule_codes, [item for item in issues if item.get("code")])
    ]
    return {
        "status": report.get("status", "error"),
        "summary": report.get("summary", ""),
        "failureCategory": _failure_category(report, stderr),
        "issues": issues,
        "stderr": stderr[-1600:] if stderr else "",
        "stderrSummary": stderr[-500:] if stderr else "",
        "attempt": attempt,
        "root_cause_hint": root,
        "ruleIds": rule_codes,
        "safe_retry": "返回一个完整、更安全的 Manim 文件，保持同一个 MainScene 合约。",
        "rulePackVersion": RULE_PACK_VERSION,
        "repairRules": repair_rules,
        "semanticTarget": semantic_target_from_brief(brief),
        "referenceSpecs": (brief or {}).get("referenceSpecs", []),
        "referenceSummary": (brief or {}).get("referenceSummary", ""),
        "referenceSemanticTarget": (brief or {}).get("referenceSemanticTarget", ""),
        "referenceConflict": (brief or {}).get("referenceConflict", ""),
        "brief": brief or {},
        "storyboardSpec": storyboard_spec or {},
        "stylePreset": style_preset or {},
        "currentCodeLength": len(code or ""),
    }


def static_repair_once(code: str, observation: dict[str, Any]) -> str:
    """Small non-template repairs for common safety/import issues."""
    repaired = code or ""
    if "from manim import" not in repaired:
        repaired = "from manim import *\nimport math\nimport numpy as np\n\n" + repaired
    if "import math" not in repaired:
        repaired = repaired.replace("from manim import *", "from manim import *\nimport math", 1)
    if "import numpy as np" not in repaired:
        repaired = repaired.replace("import math", "import math\nimport numpy as np", 1)

    repaired = re.sub(
        r"^\s*(?:import|from)\s+(os|sys|subprocess|socket|pathlib|shutil|ctypes|signal|multiprocessing|threading|asyncio|requests|urllib|http|ftplib|paramiko)\b.*$",
        "",
        repaired,
        flags=re.MULTILINE,
    )
    repaired = re.sub(r"(?:eval|exec|compile|__import__|open|globals|locals|vars|dir|getattr|setattr|delattr)\s*\([^)]*\)", "None", repaired)
    repaired = re.sub(r"3\.141592653589793\d*", "PI", repaired)
    repaired = re.sub(r"1\.5707963267948966\d*", "PI / 2", repaired)
    repaired = re.sub(r"-3\.141592653589793\d*", "-PI", repaired)
    repaired = re.sub(r"-1\.5707963267948966\d*", "-PI / 2", repaired)
    repaired = re.sub(r"background_color\s*=\s*BLACK", "background_color = '#F7FBFF'", repaired)
    repaired = re.sub(r"fill_color\s*=\s*BLACK", "fill_color = '#F7FBFF'", repaired)

    repaired = re.sub(
        r"class\s+SafeScene\s*\(\s*(?:Scene|SafeScene\s*,\s*Scene|Scene\s*,\s*SafeScene)\s*\)\s*:",
        "class SafeScene:",
        repaired,
    )
    repaired = re.sub(
        r"class\s+MainScene\s*\(\s*SafeScene\s*\)\s*:",
        "class MainScene(SafeScene, Scene):",
        repaired,
    )
    repaired = re.sub(
        r"class\s+MainScene\s*\(\s*Scene\s*\)\s*:",
        "class MainScene(SafeScene, Scene):",
        repaired,
    )
    if "class MainScene" not in repaired:
        match = re.search(r"class\s+([A-Za-z_]\w*)\s*\(\s*(?:SafeScene\s*,\s*)?Scene\s*\)\s*:", repaired)
        if match:
            repaired = repaired[: match.start()] + "class MainScene(SafeScene, Scene):" + repaired[match.end():]
    return repaired


def _replace_chinese_mathtex(match: re.Match[str]) -> str:
    func = match.group("func")
    quote = match.group("quote")
    text = match.group("text")
    if not re.search(r"[\u4e00-\u9fff]", text):
        return match.group(0)
    return f"SafeText({quote}{text}{quote}"


def patch_first_repair(code: str, report: dict[str, Any]) -> dict[str, Any]:
    """Apply deterministic small patches before asking the LLM.

    These patches are deliberately narrow: they only address errors that are
    clear from static analysis and should not change the requested animation.
    """
    repaired = static_repair_once(code, {})
    patches: list[dict[str, str]] = []

    before = repaired
    repaired = re.sub(
        r"\b(?P<func>MathTex|Tex|SafeMathTex)\(\s*(?P<quote>['\"])(?P<text>[^'\"]*[\u4e00-\u9fff][^'\"]*)(?P=quote)",
        _replace_chinese_mathtex,
        repaired,
    )
    if repaired != before:
        patches.append({
            "id": "mathtex_chinese_to_safetext",
            "summary": "已把包含中文的 MathTex/Tex 调用改为 SafeText。",
        })

    before = repaired
    repaired = re.sub(r"\bShowCreation\s*\(", "Create(", repaired)
    repaired = re.sub(r"\bTextMobject\s*\(", "Text(", repaired)
    repaired = re.sub(r"\bTexMobject\s*\(", "MathTex(", repaired)
    if repaired != before:
        patches.append({
            "id": "legacy_api_to_community_api",
            "summary": "已把旧版 Manim API 改为 Community API。",
        })

    before = repaired
    repaired = re.sub(r",\s*aligned_edge\s*=\s*[^,)]+", "", repaired)
    if repaired != before:
        patches.append({
            "id": "remove_invalid_aligned_edge",
            "summary": "已移除 set_x/set_y/set_z 不支持的 aligned_edge 参数。",
        })

    return {"code": repaired, "patches": patches}


async def llm_repair_once(
    code: str,
    observation: dict[str, Any],
    *,
    ai_client: Any | None,
    model_name: str | None,
) -> str:
    if ai_client is None or not model_name:
        return static_repair_once(code, observation)

    system = (
        "你负责修复 Manim Community Python 文件。"
        "只返回一个完整 Python 文件，并放在 python 代码块里。"
        "不要引入文件、网络、子进程、动态执行，也不要引入额外可渲染 Scene 类。"
        "修复必须保持用户语义：圆形就是圆形，三角形就是三角形，函数图像必须有清晰坐标系和曲线。"
        "如果是视觉质量问题，要放大主体、加粗线条、提高对比度，并移除黑边或内嵌白卡。"
        "如果是 LaTeX/公式渲染失败，优先把简单可见公式改为 Text/SafeText，例如 y = sin(x)。"
    )
    user = {
        "observation": observation,
        "currentCode": code,
        "manimRules": manim_rules_prompt(),
        "promptPack": build_repair_prompt_pack(),
        "rulePackVersion": RULE_PACK_VERSION,
        "requirements": [
            "Keep MainScene(SafeScene, Scene) as the only renderable Scene.",
            "Use Text/SafeText for Chinese and MathTex only for formulas.",
            "Keep the storyboard semantics unchanged.",
            "Fix the reported static, visual, semantic, or render issue.",
            "If the issue is connector_offscreen/object_clipped/unsafe_edge_contact, recompute connector endpoints from visible mobjects and keep every object inside safe margins.",
            "If the issue is panel_overlap/text_overlap/derivation_layout_missing, restructure the scene into separate layout zones instead of moving one object slightly.",
            "If the issue is stage_residue/stage_cleanup_missing, group each stage with VGroup and FadeOut or ReplacementTransform old stage groups before showing the next stage.",
            "If the observation contains AttributeError for self.<method>(), remove that call.",
            "Use legal Manim object methods such as line.get_angle(), dot.get_center(), mobject.next_to(...), Angle(line1, line2), or explicit vector math.",
            "Remove black borders, default black backgrounds, and inner white presentation cards.",
            "For triangle requests, keep a large three-vertex Triangle/Polygon as the central subject and avoid circular primary shapes.",
            "For function graph requests, make the graph dominate the visual area; use stroke_width >= 5, sparse symbolic pi labels, remove unit-circle distractors unless explicitly requested, and replace visible MathTex/SafeMathTex labels with SafeText/Text using Unicode π.",
            "For data charts, remove MathTex/SafeMathTex from visible labels; months, numbers, titles, and summaries must use SafeText/Text.",
            "If code uses set_x/set_y/set_z with aligned_edge, remove that keyword and reposition with move_to, next_to, align_to, or explicit center coordinates.",
            "If a Manim call fails with unexpected keyword, remove the unsupported keyword and replace it with legal positioning, sizing, or set_points_as_corners code.",
            "If VGroup contains a list, tuple, string, number, or other non-Mobject value, convert each visible item to Text/SafeText/MathTex/SafeMathTex and use VGroup(*items).",
            "Do not pass guessed keyword arguments into Mobject setter methods; use positional arguments or documented Manim Community parameters only.",
            "For projectile motion, include a visible trajectory, moving ball, velocity/direction arrow, and gravity/acceleration cue; prefer ParametricFunction plus MoveAlongPath over custom VMobject internals or fragile updaters.",
        ],
    }
    response = await ai_client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
        temperature=0.05,
        stream=False,
    )
    fixed = extract_code_from_text(response.choices[0].message.content)
    return fixed or static_repair_once(code, observation)


async def repair_code_async(
    code: str,
    report: dict[str, Any],
    *,
    stderr: str = "",
    max_attempts: int = 4,
    brief: dict[str, Any] | None = None,
    storyboard_spec: dict[str, Any] | None = None,
    style_preset: dict[str, Any] | None = None,
    ai_client: Any | None = None,
    model_name: str | None = None,
) -> dict[str, Any]:
    current = code
    last_report = report
    observations: list[dict[str, Any]] = []

    for attempt in range(1, max_attempts + 1):
        observation = build_repair_observation(
            current,
            last_report,
            stderr=stderr,
            attempt=attempt,
            brief=brief,
            storyboard_spec=storyboard_spec,
            style_preset=style_preset,
        )
        patched = patch_first_repair(current, last_report)
        if patched["patches"]:
            current = patched["code"]
            observation["patches"] = patched["patches"]
            patched_report = critique_code(current, brief or {})
            if patched_report["status"] != "error":
                observations.append(observation)
                return {
                    "status": "success",
                    "summary": "代码已通过确定性补丁完成自动修复。",
                    "attempts": attempt,
                    "code": current,
                    "critic": patched_report,
                    "observations": observations,
                }
            last_report = patched_report
            observation["postPatchReport"] = patched_report
        observations.append(observation)
        current = await llm_repair_once(current, observation, ai_client=ai_client, model_name=model_name)
        last_report = critique_code(current, brief or {})
        if last_report["status"] != "error":
            return {
                "status": "success",
                "summary": "代码已完成自动修复。",
                "attempts": attempt,
                "code": current,
                "critic": last_report,
                "observations": observations,
            }

    return {
        "status": "error",
        "summary": f"已达到最大自动修复次数 {max_attempts} 次。",
        "attempts": max_attempts,
        "code": current,
        "critic": last_report,
        "observations": observations,
        "root_cause_hint": observations[-1].get("root_cause_hint", "") if observations else "",
        "safe_retry": "请尝试更简单的动画，或提供更具体的对象和分镜要求。",
    }


def repair_code(
    code: str,
    report: dict[str, Any],
    stderr: str = "",
    max_attempts: int = 4,
    fixer: Fixer | None = None,
    brief: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Synchronous compatibility helper used by tests."""
    current = code
    repair_fn = fixer or static_repair_once
    attempts = 0
    last_report = report

    while attempts < max_attempts:
        attempts += 1
        observation = build_repair_observation(current, last_report, stderr=stderr, attempt=attempts, brief=brief)
        patched = patch_first_repair(current, last_report)
        if patched["patches"]:
            current = patched["code"]
            patched_report = critique_code(current, brief or {})
            if patched_report["status"] != "error":
                return {
                    "status": "success",
                    "summary": "代码已通过确定性补丁完成自动修复。",
                    "attempts": attempts,
                    "code": current,
                    "critic": patched_report,
                }
            last_report = patched_report
            observation["patches"] = patched["patches"]
            observation["postPatchReport"] = patched_report
        current = repair_fn(current, observation)
        last_report = critique_code(current, brief or {})
        if last_report["status"] != "error":
            return {
                "status": "success",
                "summary": "代码已完成自动修复。",
                "attempts": attempts,
                "code": current,
                "critic": last_report,
            }

    return {
        "status": "error",
        "summary": f"已达到最大自动修复次数 {attempts} 次。",
        "attempts": attempts,
        "code": current,
        "critic": last_report,
        "root_cause_hint": stderr or "; ".join(issue["message"] for issue in last_report.get("issues", [])),
        "safe_retry": "请尝试更简单的动画，或提供更具体的对象和分镜要求。",
    }
