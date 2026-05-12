"""Code generation for the Manim runtime agent."""

from __future__ import annotations

import re
import json
import os
from typing import Any


def extract_code_from_text(text: str) -> str:
    """Extract a Python code block or return raw text."""
    if not text:
        return ""
    match = re.search(r"```(?:python)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    return (match.group(1) if match else text).strip()


def build_coder_messages(
    brief: dict[str, Any],
    skills: list[dict[str, str]],
    current_code: str = "",
) -> list[dict[str, str]]:
    skill_guidance = "\n".join(f"- {skill['name']}: {skill['guidance']}" for skill in skills)
    system = (
        "You are a Manim Community code generator. Return one complete Python file only. "
        "Use from manim import *, import math, and import numpy as np. "
        "Chinese text must use Text(); MathTex is only for formulas. "
        "Keep all objects inside a 16:9 frame and use clear staged animations."
    )
    user = f"""
User request:
{brief.get('message', '')}

Brief:
intent={brief.get('intent')}
domain={brief.get('domain')}
storyboard={brief.get('storyboard')}

Runtime skills:
{skill_guidance}

Current code, if modifying:
```python
{current_code or ''}
```
"""
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _template_for_domain(brief: dict[str, Any]) -> str:
    spec = brief.get("spec") or {}
    if spec.get("kind") == "function_graph":
        return _function_graph_template(brief)

    title = brief.get("message") or "Manim Visualization"
    title_literal = json.dumps(title[:28], ensure_ascii=False)
    domain = brief.get("domain")
    if domain == "data":
        return f'''from manim import *
import math
import numpy as np

class MainScene(Scene):
    def construct(self):
        title = Text({title_literal}, font_size=34).to_edge(UP)
        axes = Axes(x_range=[0, 4, 1], y_range=[0, 6, 1], x_length=8, y_length=4)
        axes.next_to(title, DOWN, buff=0.6)
        values = [2, 4, 3]
        bars = VGroup(*[
            Rectangle(width=0.8, height=value * 0.55, color=BLUE, fill_opacity=0.75)
            for value in values
        ]).arrange(RIGHT, buff=0.55)
        bars.move_to(axes.c2p(2, 1.5))
        labels = VGroup(*[Text(label, font_size=22) for label in ["A", "B", "C"]])
        for label, bar in zip(labels, bars):
            label.next_to(bar, DOWN, buff=0.18)
        note = Text("突出变化趋势", font_size=26, color=YELLOW).next_to(axes, DOWN, buff=0.5)
        self.play(Write(title), Create(axes))
        self.play(LaggedStart(*[GrowFromEdge(bar, DOWN) for bar in bars], lag_ratio=0.18), Write(labels))
        self.play(Write(note), bars[1].animate.set_color(YELLOW))
        self.wait(1)
'''
    if domain == "physics":
        return f'''from manim import *
import math
import numpy as np

class MainScene(Scene):
    def construct(self):
        title = Text({title_literal}, font_size=34).to_edge(UP)
        ground = Line(LEFT * 5, RIGHT * 5).shift(DOWN * 2)
        ball = Dot(LEFT * 4 + DOWN * 1.4, color=BLUE).scale(1.4)
        path = ParametricFunction(lambda t: np.array([-4 + 8 * t, -1.4 + 2.2 * math.sin(math.pi * t), 0]), t_range=[0, 1], color=YELLOW)
        vector = Arrow(ball.get_center(), ball.get_center() + RIGHT * 1.4 + UP * 0.5, color=GREEN)
        formula = MathTex("F = ma").next_to(title, DOWN, buff=0.35)
        self.play(Write(title), Create(ground), FadeIn(ball))
        self.play(Create(path), MoveAlongPath(ball, path), run_time=3)
        self.play(GrowArrow(vector), Write(formula))
        self.wait(1)
'''
    if domain == "math":
        return f'''from manim import *
import math
import numpy as np

class MainScene(Scene):
    def construct(self):
        title = Text({title_literal}, font_size=34).to_edge(UP)
        axes = Axes(x_range=[-PI, PI, PI/2], y_range=[-1.5, 1.5, 0.5], x_length=9, y_length=4.5)
        axes.next_to(title, DOWN, buff=0.5)
        graph = axes.plot(lambda x: math.sin(x), color=BLUE)
        label = MathTex("y=\\sin(x)", color=YELLOW).next_to(axes, DOWN, buff=0.35)
        self.play(Write(title), Create(axes))
        self.play(Create(graph), Write(label), run_time=2)
        self.wait(1)
'''
    return f'''from manim import *
import math
import numpy as np

class MainScene(Scene):
    def construct(self):
        title = Text({title_literal}, font_size=34).to_edge(UP)
        steps = VGroup(
            Text("理解问题", font_size=28),
            Text("构建可视化", font_size=28),
            Text("突出结论", font_size=28),
        ).arrange(RIGHT, buff=1.0).move_to(ORIGIN)
        arrows = VGroup(
            Arrow(steps[0].get_right(), steps[1].get_left(), buff=0.15),
            Arrow(steps[1].get_right(), steps[2].get_left(), buff=0.15),
        )
        summary = Text("用清晰步骤解释核心概念", font_size=26, color=YELLOW).to_edge(DOWN)
        self.play(Write(title))
        self.play(LaggedStart(*[FadeIn(step, shift=UP * 0.2) for step in steps], lag_ratio=0.2))
        self.play(Create(arrows))
        self.play(Write(summary))
        self.wait(1)
'''


def _function_graph_template(brief: dict[str, Any]) -> str:
    spec = brief.get("spec") or {}
    title = spec.get("topic") or brief.get("message") or "函数图像分步讲解"
    title_literal = json.dumps(str(title)[:28], ensure_ascii=False)
    function_name = spec.get("function") or "sin"
    formula = r"y=\sin(x)" if function_name == "sin" else r"y=\cos(x)"
    formula_literal = json.dumps(formula)
    graph_expr = "math.sin(x)" if function_name == "sin" else "math.cos(x)"
    key_points = (
        "[(-PI, 0, \"-\\\\pi\"), (-PI/2, -1, \"-\\\\pi/2\"), (0, 0, \"0\"), (PI/2, 1, \"\\\\pi/2\"), (PI, 0, \"\\\\pi\")]"
        if function_name == "sin"
        else "[(-PI, -1, \"-\\\\pi\"), (-PI/2, 0, \"-\\\\pi/2\"), (0, 1, \"0\"), (PI/2, 0, \"\\\\pi/2\"), (PI, -1, \"\\\\pi\")]"
    )

    return f'''from manim import *
import math
import numpy as np


class SafeScene:
    def safe_play(self, *animations, **kwargs):
        kwargs.setdefault("run_time", 1.2)
        return self.play(*animations, **kwargs)


def SafeText(content, font_size=28, color="#1D2530", **kwargs):
    text = Text(str(content), font_size=font_size, color=color, **kwargs)
    return text


def SafeMathTex(content, font_size=34, color="#1D2530", **kwargs):
    formula = MathTex(content, font_size=font_size, color=color, **kwargs)
    return formula


def fit_to_frame(mobject, max_width=12.0, max_height=6.6):
    if mobject.width > max_width:
        mobject.scale_to_fit_width(max_width)
    if mobject.height > max_height:
        mobject.scale_to_fit_height(max_height)
    return mobject


def limit_width(mobject, max_width):
    if mobject.width > max_width:
        mobject.scale_to_fit_width(max_width)
    return mobject


def make_header(title_text, formula_text):
    title = limit_width(SafeText(title_text, font_size=32, color="#0E7490"), 8.4)
    formula = limit_width(SafeMathTex(formula_text, font_size=34, color="#C2410C"), 4.2)
    header = VGroup(title, formula).arrange(DOWN, buff=0.10)
    header.to_edge(UP, buff=0.25)
    return header, title, formula


def make_step_banner(text):
    label = limit_width(SafeText(text, font_size=23, color="#334155"), 4.6)
    background = RoundedRectangle(
        corner_radius=0.10,
        width=5.1,
        height=0.48,
        stroke_width=1,
        stroke_color="#BAE6FD",
        fill_color="#E0F2FE",
        fill_opacity=0.92,
    )
    label.move_to(background.get_center())
    banner = VGroup(background, label)
    banner.move_to(LEFT * 3.15 + UP * 2.15)
    return banner


def place_graph_area(axes, ticks, graph, dots, point_labels):
    graph_area = VGroup(axes, ticks, graph, dots, point_labels)
    fit_to_frame(graph_area, max_width=9.2, max_height=4.35)
    graph_area.move_to(DOWN * 0.35)
    return graph_area


def assert_layout_zones(header, step_banner, graph_area, summary):
    header.to_edge(UP, buff=0.25)
    step_banner.move_to(LEFT * 3.15 + UP * 2.15)
    graph_area.move_to(DOWN * 0.35)
    summary.to_edge(DOWN, buff=0.35)
    return VGroup(header, step_banner, graph_area, summary)


def symbolic_ticks(axes):
    x_labels = VGroup(
        MathTex("-\\\\pi", color="#475569").scale(0.65).next_to(axes.c2p(-PI, 0), DOWN, buff=0.18),
        MathTex("-\\\\pi/2", color="#475569").scale(0.65).next_to(axes.c2p(-PI / 2, 0), DOWN, buff=0.18),
        MathTex("0", color="#475569").scale(0.65).next_to(axes.c2p(0, 0), DOWN + LEFT, buff=0.14),
        MathTex("\\\\pi/2", color="#475569").scale(0.65).next_to(axes.c2p(PI / 2, 0), DOWN, buff=0.18),
        MathTex("\\\\pi", color="#475569").scale(0.65).next_to(axes.c2p(PI, 0), DOWN, buff=0.18),
    )
    y_labels = VGroup(
        MathTex("-1", color="#475569").scale(0.65).next_to(axes.c2p(0, -1), LEFT, buff=0.18),
        MathTex("1", color="#475569").scale(0.65).next_to(axes.c2p(0, 1), LEFT, buff=0.18),
    )
    return VGroup(x_labels, y_labels)


def make_axes():
    axes = Axes(
        x_range=[-PI, PI, PI / 2],
        y_range=[-1.3, 1.3, 1],
        x_length=8.6,
        y_length=3.9,
        axis_config={{"include_numbers": False, "include_tip": True, "color": "#475569"}},
        tips=True,
    )
    ticks = symbolic_ticks(axes)
    return axes, ticks


class MainScene(SafeScene, Scene):
    def construct(self):
        self.camera.background_color = "#F7FBFF"
        header, title, formula = make_header({title_literal}, {formula_literal})
        step_banner = make_step_banner("步骤 1：建立坐标系")

        axes, ticks = make_axes()
        graph = axes.plot(lambda x: {graph_expr}, x_range=[-PI, PI], color="#0284C7", stroke_width=5)
        points = {key_points}
        dots = VGroup(*[
            Dot(axes.c2p(x, y), radius=0.045, color="#F59E0B")
            for x, y, _ in points
        ])
        point_labels = VGroup(*[
            MathTex(label, font_size=22, color="#B45309").next_to(axes.c2p(x, y), UP if y >= 0 else DOWN, buff=0.16)
            for x, y, label in points
        ])
        summary = VGroup(
            SafeText("周期：2π", font_size=25, color="#1D2530"),
            SafeText("振幅：1", font_size=25, color="#1D2530"),
            SafeText("取值范围：[-1, 1]", font_size=25, color="#1D2530"),
        ).arrange(RIGHT, buff=0.7)
        graph_area = place_graph_area(axes, ticks, graph, dots, point_labels)
        layout = assert_layout_zones(header, step_banner, graph_area, summary)
        fit_to_frame(layout, max_width=12.0, max_height=7.2)

        self.safe_play(Write(title), Write(formula))
        self.safe_play(FadeIn(step_banner), Create(axes), FadeIn(ticks))
        self.safe_play(Transform(step_banner, make_step_banner("步骤 2：绘制函数曲线")))
        self.safe_play(Create(graph), run_time=1.8)
        self.safe_play(Transform(step_banner, make_step_banner("步骤 3：标注关键点")))
        self.safe_play(LaggedStart(FadeIn(dots), Write(point_labels), lag_ratio=0.18))
        self.safe_play(Transform(step_banner, make_step_banner("步骤 4：总结图像规律")))
        self.safe_play(FadeIn(summary, shift=UP * 0.2))
        self.wait(1)
'''


async def generate_code(
    brief: dict[str, Any],
    skills: list[dict[str, str]],
    current_code: str = "",
    ai_client: Any | None = None,
    model_name: str | None = None,
) -> dict[str, Any]:
    """Generate code with an AI client when available, otherwise use a safe template."""
    spec = brief.get("spec") or {}
    if os.environ.get("MANIM_AGENT_V2_ENABLED", "true").lower() not in {"0", "false", "off", "no"}:
        if spec.get("kind") == "function_graph":
            return {"code": _template_for_domain(brief), "source": "template_v2"}

    if ai_client is not None and model_name:
        try:
            response = await ai_client.chat.completions.create(
                model=model_name,
                messages=build_coder_messages(brief, skills, current_code),
                stream=False,
                temperature=0.25,
            )
            content = response.choices[0].message.content
            code = extract_code_from_text(content)
            if code:
                return {"code": code, "source": "ai"}
        except Exception as exc:
            return {
                "code": _template_for_domain(brief),
                "source": "template",
                "warning": f"AI generation failed, used template fallback: {exc}",
            }

    if brief.get("intent") == "MODIFY" and current_code.strip():
        return {"code": current_code, "source": "existing_code"}
    return {"code": _template_for_domain(brief), "source": "template"}
