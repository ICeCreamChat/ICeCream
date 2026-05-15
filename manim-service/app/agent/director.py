"""Storyboard director for Manim Agent v6."""

from __future__ import annotations

import json
import re
from typing import Any

from .manim_knowledge import RULE_PACK_VERSION, semantic_target_from_brief


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


def _is_simple_trig_graph_request(brief: dict[str, Any]) -> bool:
    message = str(brief.get("message") or "").lower()
    if "单位圆" in message:
        return False
    animation_type = str(brief.get("animation_type") or "")
    return animation_type == "function_graph" and any(
        token in message for token in ("正弦", "余弦", "sin", "cos")
    )


def _is_simple_shape_request(brief: dict[str, Any]) -> bool:
    message = str(brief.get("message") or "").lower()
    if any(token in message for token in ("证明", "推导", "内角", "面积", "对角线", "讲解", "性质", "公式")):
        return False
    return str(brief.get("animation_type") or "") in {"geometry_circle", "square", "triangle"}


def _normalize_simple_shape_storyboard(spec: dict[str, Any], brief: dict[str, Any]) -> dict[str, Any]:
    if not _is_simple_shape_request(brief):
        return spec

    animation_type = str(brief.get("animation_type") or "")
    shape_label = {
        "geometry_circle": "圆形",
        "square": "正方形",
        "triangle": "三角形",
    }.get(animation_type, "几何图形")
    object_label = {
        "geometry_circle": "Circle",
        "square": "Square",
        "triangle": "Triangle 或 Polygon",
    }.get(animation_type, "Mobject")
    spec["topic"] = f"画一个{shape_label}"
    spec["teaching_goal"] = f"清晰展示一个标准{shape_label}，让主体图形足够大、轮廓明确。"
    spec["visual_objects"] = [object_label, "简短标签", "主体轮廓"]
    spec["layout_zones"] = ["header", "step", "visual", "summary"]
    spec["shots"] = [
        {
            "id": 1,
            "title": f"绘制{shape_label}",
            "narration": f"先在画面中央绘制一个清晰的{shape_label}。",
            "visual": f"居中的大号{shape_label}主体，线条高对比。",
            "animation": "Create main shape",
        },
        {
            "id": 2,
            "title": "标出关键结构",
            "narration": "只添加少量标签，帮助识别图形结构，不挤占主体。",
            "visual": "少量点、边或半径标签。",
            "animation": "Fade in labels",
        },
        {
            "id": 3,
            "title": "总结图形特征",
            "narration": f"用一句话总结这个{shape_label}的基本特征。",
            "visual": "底部简短中文总结。",
            "animation": "Write summary",
        },
    ]
    spec["risks"] = [
        "避免把简单图形扩写成复杂证明",
        "避免文字和公式过多",
        "避免主体图形过小",
    ]
    spec.setdefault("constraints", [])
    spec["constraints"].extend([
        "简单图形请求只画主体和少量标签，不做几何证明或公式推导。",
        "主体图形必须占据视觉区域，不要添加复杂角标、辅助线和长篇说明。",
    ])
    return spec


def _normalize_simple_trig_storyboard(spec: dict[str, Any], brief: dict[str, Any]) -> dict[str, Any]:
    """Keep simple sine/cosine requests focused on axes and curve.

    The model often tries to enrich simple trig requests with unit-circle
    derivations. That is useful for a different prompt, but it makes the scene
    fragile and frequently triggers rescue. For plain "draw sine/cosine graph"
    requests, stabilize the storyboard before code generation.
    """
    if not _is_simple_trig_graph_request(brief):
        return spec

    message = str(brief.get("message") or "").lower()
    function_name = "余弦" if ("余弦" in message or "cos" in message) else "正弦"
    formula = "y = cos(x)" if function_name == "余弦" else "y = sin(x)"
    spec["visual_objects"] = ["Axes", f"{function_name}函数曲线", "π 符号刻度", "关键点"]
    spec["layout_zones"] = ["header", "step", "visual", "summary"]
    spec["shots"] = [
        {
            "id": 1,
            "title": "建立坐标系",
            "narration": f"先建立 {function_name}函数的坐标系，横轴用 π 的符号刻度表示角度。",
            "visual": "浅色背景上的坐标轴、稀疏 π 刻度和坐标标签。",
            "animation": "Create axes and labels",
        },
        {
            "id": 2,
            "title": "绘制函数曲线",
            "narration": f"逐步绘制 {formula} 的曲线，让曲线成为画面主体。",
            "visual": f"高对比度 {function_name} 曲线从左到右出现。",
            "animation": "Create graph",
        },
        {
            "id": 3,
            "title": "标记关键点",
            "narration": "标出零点、最高点和最低点，帮助理解一个周期内的变化。",
            "visual": "少量橙色关键点和简短中文标签。",
            "animation": "Fade in key points",
        },
        {
            "id": 4,
            "title": "总结周期性质",
            "narration": f"总结 {function_name} 函数的周期为 2π，振幅为 1。",
            "visual": "底部总结文字和函数表达式。",
            "animation": "Write summary",
        },
    ]
    spec["risks"] = [
        "避免单位圆分散主体",
        "避免 MathTex 中文或 LaTeX 失败",
        "避免坐标刻度过密",
        "避免曲线主体过小",
    ]
    spec.setdefault("constraints", [])
    spec["constraints"].extend([
        "简单正弦/余弦图像不要加入单位圆，除非用户明确要求。",
        "公式、π 刻度和步骤说明优先使用 Text/SafeText 显示。",
        "坐标系和函数曲线必须占据主体视觉区域。",
    ])
    return spec


def _normalize_bar_chart_storyboard(spec: dict[str, Any], brief: dict[str, Any]) -> dict[str, Any]:
    message = str(brief.get("message") or "").lower()
    animation_type = str(brief.get("animation_type") or spec.get("animation_type") or "")
    if animation_type not in {"data_chart", "bar_chart", "line_chart"} and not any(
        token in message for token in ("柱状图", "销量", "数据", "bar chart")
    ):
        return spec

    spec["topic"] = "三个月销量柱状图"
    spec["teaching_goal"] = "用清晰的大号柱状图对比三个月销量变化，让柱子成为画面主体。"
    spec["visual_objects"] = ["三根大号柱子", "月份标签", "数值标签", "趋势总结"]
    spec["layout_zones"] = ["header", "step", "visual", "summary"]
    spec["shots"] = [
        {
            "id": 1,
            "title": "建立对比坐标",
            "narration": "先保留简洁基线和月份标签，为三根柱子留出足够空间。",
            "visual": "浅色画布、简洁基线、1 月、2 月、3 月标签。",
            "animation": "Create baseline and month labels",
        },
        {
            "id": 2,
            "title": "绘制三根柱子",
            "narration": "依次绘制三根高对比大柱子，让高度差一眼可见。",
            "visual": "三根大号蓝色柱子占据主体视觉区域，最高柱高度不低于 3.1 场景单位。",
            "animation": "Grow bars from baseline",
        },
        {
            "id": 3,
            "title": "标注数值",
            "narration": "在每根柱子上方加入简短数值标签，避免文字挤占柱体。",
            "visual": "少量数值标签和强调色最高值标记。",
            "animation": "Fade in value labels",
        },
        {
            "id": 4,
            "title": "总结趋势",
            "narration": "用一句话总结销量变化趋势。",
            "visual": "底部简短趋势总结，不遮挡柱状图。",
            "animation": "Write summary",
        },
    ]
    spec["risks"] = ["主体柱子过小", "坐标网格过空", "文字标签过密"]
    spec.setdefault("constraints", [])
    spec["constraints"].extend([
        "柱状图必须只用三根大号 Rectangle 柱子作为主体，不要画成小图标或稀疏网格。",
        "柱组应占视觉区宽度 65%-75%、高度 40%-55%，避免大面积留白。",
        "月份、数值、标题和总结全部使用 Text/SafeText，不使用 MathTex。",
    ])
    return spec


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
        "version": "v6",
        "kind": fallback_spec.get("kind") or brief.get("animation_type") or "concept",
        "semantic_target": semantic_target_from_brief(brief),
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
        "reference_usage": _user_visible_text(
            data.get("reference_usage"),
            str(brief.get("referenceSummary") or ""),
            180,
            require_chinese=False,
        ),
        "rulePackVersion": RULE_PACK_VERSION,
    }
    spec = _normalize_simple_shape_storyboard(spec, brief)
    spec = _normalize_simple_trig_storyboard(spec, brief)
    spec = _normalize_bar_chart_storyboard(spec, brief)
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
        "semantic_target": semantic_target_from_brief(brief),
        "referenceSpecs": brief.get("referenceSpecs", []),
        "referenceSummary": brief.get("referenceSummary", ""),
        "referenceSemanticTarget": brief.get("referenceSemanticTarget", ""),
        "referenceConflict": brief.get("referenceConflict", ""),
        "referencePolicy": [
            "参考图用于约束主体形状、布局位置、线稿方向和风格，不直接嵌入最终视频。",
            "如果文字请求与参考图冲突，必须以文字请求为准，并在分镜里说明参考图只作为次要构图参考。",
            "如果文字较笼统且参考图检测到明确主体，请把 referenceSemanticTarget 作为主要视觉对象。",
        ],
        "domain_constraints": [
            "如果是简单正弦/余弦函数图像，默认只设计坐标系、函数曲线、关键点和周期总结；不要加入单位圆，除非用户明确要求单位圆。",
            "简单函数图像必须让坐标系和曲线成为主体，不要把解释分散到多个复杂图形。",
            "如果用户只说画一个圆形/正方形/三角形，默认设计为简单主体图形展示，不要自动扩写成证明、推导或长篇性质讲解。",
        ],
        "current_code_summary": brief.get("currentCodeSummary", {}),
        "required_json_shape": {
            "version": "v6",
            "topic": "简短中文标题",
            "audience": "学生",
            "teaching_goal": "一句中文教学目标",
            "domain": "math|geometry|data|physics|flow|concept|code",
            "animation_type": "specific animation type",
            "visual_objects": ["必须出现的视觉对象"],
            "semantic_target": "circle|square|triangle|function_graph|data_chart|motion_path|flow|concept",
            "reference_usage": "如果有参考图，用一句中文说明参考图影响了哪些对象或布局；没有参考图则留空",
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
    """Ask the model for a v6 StoryboardSpec and validate it."""
    if ai_client is None or not model_name:
        return {
            "status": "error",
            "summary": "Manim Agent v6 需要配置 AI 客户端后才能设计分镜。",
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
