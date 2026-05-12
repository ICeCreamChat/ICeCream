"""Code generation for the Manim runtime agent."""

from __future__ import annotations

import re
import json
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


async def generate_code(
    brief: dict[str, Any],
    skills: list[dict[str, str]],
    current_code: str = "",
    ai_client: Any | None = None,
    model_name: str | None = None,
) -> dict[str, Any]:
    """Generate code with an AI client when available, otherwise use a safe template."""
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
