"""Storyboard director for Manim Agent v5."""

from __future__ import annotations

import json
import re
from typing import Any


REQUIRED_FIELDS = (
    "version",
    "topic",
    "audience",
    "teaching_goal",
    "domain",
    "animation_type",
    "visual_objects",
    "layout_zones",
    "shots",
    "risks",
)

CJK_RE = re.compile(r"[\u4e00-\u9fff]")

COMMON_TEXT_TRANSLATIONS = {
    "Setup Axes": "建立坐标系",
    "Draw Cosine Curve": "绘制余弦曲线",
    "Draw Sine Curve": "绘制正弦曲线",
    "Mark Key Points": "标记关键点",
    "Highlight Properties": "强调函数性质",
    "We start with a coordinate system for the cosine function.": "先建立余弦函数的平面直角坐标系。",
    "The cosine curve starts at (0,1) and oscillates between 1 and -1.": "余弦曲线从 (0,1) 开始，在 1 和 -1 之间周期变化。",
    "Key points: (0,1), (π/2,0), (π,-1), (3π/2,0), (2π,1).": "关键点包括 (0,1)、(π/2,0)、(π,-1)、(3π/2,0)、(2π,1)。",
    "The cosine function is even and periodic with period 2π.": "余弦函数是偶函数，周期为 2π。",
}


def _extract_json(text: str) -> dict[str, Any]:
    if not text:
        raise ValueError("empty director response")
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    raw = fenced.group(1) if fenced else text
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("director response did not contain a JSON object")
    return json.loads(raw[start : end + 1])


def _contains_cjk(text: str) -> bool:
    return bool(CJK_RE.search(text or ""))


def _localize_common_text(text: str) -> str:
    value = str(text or "").strip()
    if not value:
        return ""
    if value in COMMON_TEXT_TRANSLATIONS:
        return COMMON_TEXT_TRANSLATIONS[value]
    for english, chinese in COMMON_TEXT_TRANSLATIONS.items():
        if value.startswith(f"{english}:") or value.startswith(f"{english}："):
            suffix = value[len(english) + 1 :].strip()
            return f"{chinese}：{COMMON_TEXT_TRANSLATIONS.get(suffix, suffix)}" if suffix else chinese
    return value


def _user_visible_text(value: Any, fallback: str, limit: int, *, require_chinese: bool) -> str:
    text = _localize_common_text(str(value or ""))
    if require_chinese and text and not _contains_cjk(text) and fallback:
        text = fallback
    if not text:
        text = fallback
    return str(text or "")[:limit]


def _coerce_spec(data: dict[str, Any], brief: dict[str, Any]) -> dict[str, Any]:
    shots = data.get("shots")
    if not isinstance(shots, list) or len(shots) < 2:
        raise ValueError("storyboard requires at least two shots")

    require_chinese = _contains_cjk(str(brief.get("message") or ""))
    fallback_spec = brief.get("spec", {})
    fallback_storyboard = brief.get("storyboard") or fallback_spec.get("storyboard") or []
    fallback_topic = str(fallback_spec.get("topic") or brief.get("message") or "教学动画")
    fallback_goal = str(fallback_spec.get("teaching_goal") or "用分步骤画面清晰讲解这个概念。")

    normalized_shots: list[dict[str, Any]] = []
    for index, shot in enumerate(shots[:5], start=1):
        if not isinstance(shot, dict):
            raise ValueError("each shot must be an object")
        fallback_title = str(
            fallback_storyboard[index - 1]
            if index - 1 < len(fallback_storyboard)
            else f"步骤 {index}"
        )
        title = _user_visible_text(
            shot.get("title"),
            fallback_title,
            60,
            require_chinese=require_chinese,
        )
        normalized_shots.append({
            "id": int(shot.get("id") or index),
            "title": title,
            "narration": _user_visible_text(shot.get("narration"), title, 140, require_chinese=require_chinese),
            "visual": _user_visible_text(shot.get("visual"), title, 160, require_chinese=require_chinese),
            "animation": str(shot.get("animation") or "reveal")[:80],
        })

    spec = {
        "version": "v5",
        "kind": fallback_spec.get("kind") or brief.get("animation_type") or "concept",
        "topic": _user_visible_text(data.get("topic"), fallback_topic, 80, require_chinese=require_chinese),
        "audience": _user_visible_text(data.get("audience"), "学生", 40, require_chinese=require_chinese),
        "teaching_goal": _user_visible_text(data.get("teaching_goal"), fallback_goal, 160, require_chinese=require_chinese),
        "domain": str(data.get("domain") or brief.get("domain") or "concept"),
        "animation_type": str(data.get("animation_type") or brief.get("animation_type") or "concept_explanation"),
        "visual_objects": [str(item) for item in data.get("visual_objects", fallback_spec.get("objects", []))][:10],
        "layout_zones": [str(item) for item in data.get("layout_zones", ["header", "step", "visual", "summary"])][:6],
        "shots": normalized_shots,
        "risks": [str(item) for item in data.get("risks", fallback_spec.get("risk_flags", []))][:8],
        "constraints": [
            "中文说明必须使用 Text，MathTex 只用于公式。",
            "标题、步骤提示、主体图像和总结必须分区放置。",
            "优先生成清晰、高对比度的教学画面，不追求装饰复杂度。",
            "画面必须铺满浅色 16:9 画布，不要黑边和内嵌白色卡片。",
        ],
    }
    for field in REQUIRED_FIELDS:
        if field not in spec:
            raise ValueError(f"missing storyboard field: {field}")
    return spec


def build_director_messages(brief: dict[str, Any], current_code: str = "") -> list[dict[str, str]]:
    system = (
        "你是 Manim 精品教学动画导演。只返回严格 JSON，不要返回代码。"
        "请设计能在 16:9 Manim 场景中渲染的简洁高级教学分镜。"
        "所有用户可见字段必须使用简体中文，包括 topic、audience、teaching_goal、visual_objects、"
        "shots.title、shots.narration、shots.visual 和 risks。公式、函数名、协议名可以保留数学或英文缩写。"
        "必须明确用户请求的核心对象，避免把圆形画成三角形这类语义错配。"
    )
    user = {
        "request": brief.get("message", ""),
        "mode": "modify" if current_code.strip() else "create",
        "intent": brief.get("intent"),
        "domain": brief.get("domain"),
        "animation_type": brief.get("animation_type"),
        "required_objects": brief.get("target_objects", []),
        "current_code_summary": brief.get("currentCodeSummary", {}),
        "required_json_shape": {
            "version": "v5",
            "topic": "简短中文标题",
            "audience": "学生",
            "teaching_goal": "一句中文教学目标",
            "domain": "math|geometry|data|physics|flow|concept|code",
            "animation_type": "specific animation type",
            "visual_objects": ["必须出现的视觉对象"],
            "layout_zones": ["header", "step", "visual", "summary"],
            "shots": [
                {
                    "id": 1,
                    "title": "简短中文步骤名",
                    "narration": "这一幕要让学习者理解什么",
                    "visual": "画面中出现什么",
                    "animation": "how it appears",
                }
            ],
            "risks": ["语义错配", "文字重叠"],
        },
    }
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
    ]


async def design_storyboard(
    brief: dict[str, Any],
    *,
    ai_client: Any | None,
    model_name: str | None,
    current_code: str = "",
) -> dict[str, Any]:
    """Ask the model for a v5 StoryboardSpec and validate it."""
    if ai_client is None or not model_name:
        return {
            "status": "error",
            "summary": "Manim Agent v5 需要配置 AI 客户端后才能设计分镜。",
            "storyboardSpec": None,
            "next_actions": ["请配置 DEEPSEEK_API_KEY 并重启 Manim 服务。"],
        }

    try:
        response = await ai_client.chat.completions.create(
            model=model_name,
            messages=build_director_messages(brief, current_code=current_code),
            temperature=0.22,
            stream=False,
        )
        content = response.choices[0].message.content
        spec = _coerce_spec(_extract_json(content), brief)
        return {
            "status": "success",
            "summary": "分镜设计完成。",
            "storyboardSpec": spec,
            "next_actions": ["选择教学风格并生成 Manim 代码。"],
        }
    except Exception as exc:
        return {
            "status": "error",
            "summary": f"分镜设计失败：{exc}",
            "storyboardSpec": None,
            "next_actions": ["请用更清晰的提示重试，或检查模型返回格式。"],
        }
