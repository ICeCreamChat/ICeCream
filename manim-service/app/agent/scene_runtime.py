"""Reusable Manim runtime helpers for LLM-authored scenes.

This module intentionally contains only generic safety/layout primitives. It
must not grow domain-specific full-scene templates.
"""

from __future__ import annotations


SCENE_RUNTIME_CODE = r'''
from manim import *
import math
import numpy as np


class SafeScene:
    def setup(self):
        Scene.setup(self)
        self.camera.background_color = "#F7FBFF"

    def safe_play(self, *animations, **kwargs):
        kwargs.setdefault("run_time", 1.0)
        return self.play(*animations, **kwargs)


def SafeText(content, font_size=28, color="#1D2530", **kwargs):
    text = Text(str(content), font_size=font_size, color=color, **kwargs)
    if text.width > 11.2:
        text.scale_to_fit_width(11.2)
    return text


def SafeMathTex(content, font_size=34, color="#1D2530", **kwargs):
    formula = MathTex(str(content), font_size=font_size, color=color, **kwargs)
    if formula.width > 10.8:
        formula.scale_to_fit_width(10.8)
    return formula


def fit_to_frame(mobject, max_width=12.0, max_height=6.7):
    if mobject.width > max_width:
        mobject.scale_to_fit_width(max_width)
    if mobject.height > max_height:
        mobject.scale_to_fit_height(max_height)
    return mobject


def make_panel(width=None, height=None):
    width = max(float(width or 0), float(config.frame_width) + 0.2)
    height = max(float(height or 0), float(config.frame_height) + 0.2)
    panel = Rectangle(
        width=width,
        height=height,
        stroke_width=0,
        fill_color="#F7FBFF",
        fill_opacity=1.0,
    )
    panel.move_to(ORIGIN)
    panel.set_z_index(-20)
    return panel


def make_header(title, subtitle=None):
    title_mob = SafeText(title, font_size=34, color="#0E7490")
    if subtitle:
        subtitle_mob = SafeText(subtitle, font_size=22, color="#64748B")
        group = VGroup(title_mob, subtitle_mob).arrange(DOWN, buff=0.10)
    else:
        subtitle_mob = VGroup()
        group = VGroup(title_mob)
    group.to_edge(UP, buff=0.30)
    return group, title_mob, subtitle_mob


def make_step_banner(text):
    label = SafeText(text, font_size=23, color="#334155")
    label.scale_to_fit_width(min(label.width, 4.7))
    background = RoundedRectangle(
        corner_radius=0.12,
        width=5.25,
        height=0.52,
        stroke_width=1,
        stroke_color="#BAE6FD",
        fill_color="#E0F2FE",
        fill_opacity=0.94,
    )
    label.move_to(background.get_center())
    banner = VGroup(background, label)
    banner.move_to(LEFT * 3.15 + UP * 2.05)
    return banner


def place_visual(mobject):
    fit_to_frame(mobject, max_width=9.7, max_height=4.5)
    mobject.move_to(DOWN * 0.25)
    return mobject


def make_summary(text):
    summary = SafeText(text, font_size=24, color="#1D2530")
    summary.to_edge(DOWN, buff=0.42)
    return summary
'''


def runtime_prompt() -> str:
    """Return helper code and usage constraints for the code writer prompt."""
    return (
        "Use these exact runtime helpers in the generated file before MainScene. "
        "They are generic helpers, not topic templates:\n\n"
        f"```python\n{SCENE_RUNTIME_CODE}\n```"
    )
