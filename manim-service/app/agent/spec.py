"""Structured animation spec helpers for the Manim agent."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


DEFAULT_LAYOUT_ZONES = ["header", "step", "visual", "summary"]
DEFAULT_VISUAL_REQUIREMENTS = [
    "标题、步骤说明、主体图像和总结必须分区放置。",
    "中文使用 Text/SafeText，公式使用 MathTex/SafeMathTex。",
    "所有可见对象必须留在 16:9 安全区域内。",
    "使用浅色全画布教学背景，禁止黑边、黑底留白和内嵌展示卡片。",
]


@dataclass(frozen=True)
class AnimationSpec:
    """Decision-complete routing brief used by skills, codegen, and checks."""

    kind: str
    topic: str
    teaching_goal: str
    storyboard: list[str]
    domain: str = "concept"
    animation_type: str = "concept_explanation"
    layout_zones: list[str] = field(default_factory=lambda: list(DEFAULT_LAYOUT_ZONES))
    visual_requirements: list[str] = field(default_factory=lambda: list(DEFAULT_VISUAL_REQUIREMENTS))
    risk_flags: list[str] = field(default_factory=list)
    objects: list[str] = field(default_factory=list)
    function: str = ""
    coordinate_system: str = "none"
    tick_policy: str = "simple"
    layout: dict[str, Any] = field(default_factory=dict)
    style: dict[str, Any] = field(default_factory=dict)
    version: str = "v5"

    @property
    def learning_goal(self) -> str:
        return self.teaching_goal

    @property
    def teaching_steps(self) -> list[str]:
        return self.storyboard

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["learning_goal"] = self.learning_goal
        data["teaching_steps"] = self.teaching_steps
        return data


def _base_spec(
    *,
    kind: str,
    topic: str,
    domain: str,
    animation_type: str,
    teaching_goal: str,
    storyboard: list[str],
    objects: list[str],
    coordinate_system: str = "none",
    function: str = "",
    tick_policy: str = "simple",
    risk_flags: list[str] | None = None,
) -> AnimationSpec:
    return AnimationSpec(
        kind=kind,
        topic=topic,
        domain=domain,
        animation_type=animation_type,
        teaching_goal=teaching_goal,
        storyboard=storyboard,
        objects=objects,
        function=function,
        coordinate_system=coordinate_system,
        tick_policy=tick_policy,
        risk_flags=risk_flags or ["文字重叠", "对象越界", "语义错配"],
        layout={"frame": "16:9", "safe_margin": 0.7, "zones": list(DEFAULT_LAYOUT_ZONES)},
        style={"background": "light", "contrast": "high", "palette": "teaching"},
    )


def default_spec(topic: str) -> AnimationSpec:
    return _base_spec(
        kind="concept",
        topic=topic or "概念讲解",
        domain="concept",
        animation_type="concept_explanation",
        teaching_goal="用清晰的分步动画解释核心概念。",
        storyboard=["提出主题", "构建主要可视元素", "强调结论"],
        objects=["title", "steps", "arrows", "summary"],
    )


def function_graph_spec(topic: str, function_name: str = "sin") -> AnimationSpec:
    function_label = "余弦函数" if function_name == "cos" else "正弦函数"
    return _base_spec(
        kind="function_graph",
        topic=topic or function_label,
        domain="math",
        animation_type="function_graph",
        teaching_goal=f"分步骤讲解{function_label}的图像、关键点和周期规律。",
        storyboard=[
            "建立带符号刻度的坐标系",
            f"绘制 {function_label} 曲线",
            "标注零点、峰值和谷值",
            "总结周期、振幅和取值范围",
        ],
        objects=["title", "formula", "axes", "graph", "key_points", "summary"],
        function=function_name,
        coordinate_system="cartesian",
        tick_policy="symbolic_pi",
        risk_flags=["文字重叠", "刻度过密", "长小数标签", "主体过小"],
    )


def formula_derivation_spec(topic: str) -> AnimationSpec:
    return _base_spec(
        kind="formula_derivation",
        topic=topic or "公式推导",
        domain="math",
        animation_type="formula_derivation",
        teaching_goal="逐步展示公式从条件到结论的推导过程。",
        storyboard=["给出目标公式", "拆解关键等式", "突出最终结论"],
        objects=["title", "formula_steps", "highlight_box", "summary"],
        risk_flags=["MathTex 中文", "文字重叠", "公式过密"],
    )


def geometry_proof_spec(topic: str) -> AnimationSpec:
    return _base_spec(
        kind="geometry_proof",
        topic=topic or "几何证明",
        domain="geometry",
        animation_type="geometry_proof",
        teaching_goal="用图形、角标和公式说明几何关系。",
        storyboard=["绘制几何图形", "标注关键角和边", "展示证明结论"],
        objects=["title", "geometry_shape", "labels", "formula", "summary"],
        risk_flags=["标签重叠", "对象越界", "语义错配"],
    )


def triangle_spec(topic: str) -> AnimationSpec:
    return _base_spec(
        kind="triangle",
        topic=topic or "三角形讲解",
        domain="geometry",
        animation_type="triangle",
        teaching_goal="用清晰的三角形主体说明顶点、边和角的基本构成。",
        storyboard=["绘制三角形主体", "标注三个顶点和三条边", "强调三角形由三条线段首尾相连构成"],
        objects=["triangle", "vertices", "edges", "labels", "summary"],
        risk_flags=["语义图形错配", "标签重叠", "对象越界"],
    )


def geometry_square_spec(topic: str) -> AnimationSpec:
    return _base_spec(
        kind="square",
        topic=topic or "正方形讲解",
        domain="geometry",
        animation_type="square",
        teaching_goal="用清晰的正方形主体说明四条边相等、四个角都是直角以及面积公式。",
        storyboard=["绘制正方形主体", "标注四条相等边和四个直角", "总结边长与面积关系"],
        objects=["square", "vertices", "equal_sides", "right_angles", "area_formula", "summary"],
        risk_flags=["语义图形错配", "标签重叠", "对象越界"],
    )


def geometry_circle_spec(topic: str) -> AnimationSpec:
    return _base_spec(
        kind="geometry_circle",
        topic=topic or "圆形讲解",
        domain="geometry",
        animation_type="geometry_circle",
        teaching_goal="用清晰的圆形、圆心、半径和直径标注讲解圆的基本元素。",
        storyboard=["绘制圆形", "标注圆心和半径", "总结直径与半径关系"],
        objects=["circle", "center", "radius", "diameter", "summary"],
        risk_flags=["语义图形错配", "标签重叠", "对象越界"],
    )


def data_chart_spec(topic: str) -> AnimationSpec:
    return _base_spec(
        kind="data_chart",
        topic=topic or "数据图表",
        domain="data",
        animation_type="bar_chart",
        teaching_goal="用清晰图表展示数据变化并解释趋势。",
        storyboard=["建立图表坐标", "依次展示数据", "标出趋势结论"],
        objects=["title", "axes", "bars", "labels", "summary"],
        coordinate_system="cartesian",
        risk_flags=["标签过密", "低对比度", "主体过小"],
    )


def physics_motion_spec(topic: str) -> AnimationSpec:
    return _base_spec(
        kind="physics_motion",
        topic=topic or "物理运动",
        domain="physics",
        animation_type="motion_path",
        teaching_goal="展示运动轨迹、速度方向和受力关系。",
        storyboard=["建立运动场景", "展示轨迹", "标注速度和重力"],
        objects=["trajectory", "moving_object", "vectors", "summary"],
        coordinate_system="screen",
        risk_flags=["轨迹方向不合理", "运动过快", "向量标签重叠"],
    )


def flow_process_spec(topic: str) -> AnimationSpec:
    return _base_spec(
        kind="flow_process",
        topic=topic or "流程解释",
        domain="flow",
        animation_type="process_flow",
        teaching_goal="分步展示流程节点之间的顺序和关系。",
        storyboard=["展示参与方", "逐步连接流程", "总结关键状态"],
        objects=["nodes", "arrows", "step_labels", "summary"],
        risk_flags=["节点重叠", "箭头交叉", "步骤过密"],
    )


def code_modify_spec(topic: str) -> AnimationSpec:
    return _base_spec(
        kind="code_modify",
        topic=topic or "代码修改",
        domain="code",
        animation_type="code_modify",
        teaching_goal="在保留原场景结构的基础上执行最小可见修改。",
        storyboard=["分析当前场景", "应用用户修改", "保持可渲染输出"],
        objects=["existing_scene", "modified_objects"],
        risk_flags=["无效 Python", "Scene 检测失败", "语义偏离"],
    )
