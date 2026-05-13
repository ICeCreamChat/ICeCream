import ast
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from app import service_config
from app.agent.code_writer import write_scene_code
from app.agent.coder import generate_code
from app.agent.critic import critique_code
from app.agent.director import design_storyboard
from app.agent.inspector import inspect_code_quality
from app.agent.planner import plan_animation
from app.agent.repair import repair_code, repair_code_async, static_repair_once
from app.agent.renderer import sanitize_render_error
from app.agent.rescue_scene import rescue_scene_code
from app.agent.scene_runtime import SCENE_RUNTIME_CODE
from app.agent.skill_loader import select_skills
from app.agent.visual_judge import inspect_frame_quality, inspect_visual_quality
from app.agent.workflow import stream_agent_events


def renderable_scene_classes(code: str) -> list[str]:
    tree = ast.parse(code)
    return [
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ClassDef)
        and any(getattr(base, "id", "") == "Scene" for base in node.bases)
    ]


def circle_scene_code() -> str:
    return (
        SCENE_RUNTIME_CODE
        + """

class MainScene(SafeScene, Scene):
    def construct(self):
        self.camera.background_color = "#F7FBFF"
        panel = make_panel()
        header, title, subtitle = make_header("画一个圆形", "半径与直径")
        step_banner = make_step_banner("步骤 1：观察圆的结构")
        circle = Circle(radius=1.55, color="#0EA5E9", stroke_width=8)
        center = Dot(ORIGIN, color="#F97316")
        radius = Line(ORIGIN, RIGHT * 1.55, color="#F97316")
        radius_label = SafeText("半径 r", font_size=24, color="#B45309").next_to(radius, DOWN, buff=0.18)
        diameter = Line(LEFT * 1.55, RIGHT * 1.55, color="#14B8A6", stroke_width=4)
        diameter_label = SafeText("直径 d = 2r", font_size=24, color="#0F766E").next_to(diameter, UP, buff=0.20)
        visual = place_visual(VGroup(circle, center, radius, radius_label, diameter, diameter_label))
        summary = make_summary("圆上所有点到圆心的距离都等于半径。")
        self.add(panel)
        self.safe_play(Write(title), FadeIn(subtitle), FadeIn(step_banner))
        self.safe_play(Create(circle), FadeIn(center), Create(radius), Write(radius_label))
        self.safe_play(Create(diameter), Write(diameter_label), Write(summary))
        self.wait(1)
"""
    )


def director_json() -> str:
    return json.dumps(
        {
            "version": "v4",
            "topic": "画一个圆形",
            "audience": "students",
            "teaching_goal": "Explain radius, diameter, and center clearly.",
            "domain": "geometry",
            "animation_type": "geometry_circle",
            "visual_objects": ["Circle", "center dot", "radius line", "diameter line"],
            "layout_zones": ["header", "step", "visual", "summary"],
            "shots": [
                {
                    "id": 1,
                    "title": "建立圆形",
                    "narration": "先看到圆和圆心。",
                    "visual": "Circle with center dot",
                    "animation": "Create circle, FadeIn center",
                },
                {
                    "id": 2,
                    "title": "标注半径",
                    "narration": "从圆心到圆上一点的线段是半径。",
                    "visual": "radius line and label",
                    "animation": "Create radius",
                },
                {
                    "id": 3,
                    "title": "连接直径",
                    "narration": "穿过圆心的最长弦是直径。",
                    "visual": "diameter line and label",
                    "animation": "Create diameter",
                },
            ],
            "risks": ["semantic mismatch", "text overlap"],
        },
        ensure_ascii=False,
    )


def english_cosine_director_json() -> str:
    return json.dumps(
        {
            "version": "v4",
            "topic": "Draw a cosine function",
            "audience": "students",
            "teaching_goal": "Explain the cosine function graph.",
            "domain": "math",
            "animation_type": "function_graph",
            "visual_objects": ["axes", "cosine curve", "key points"],
            "layout_zones": ["header", "step", "visual", "summary"],
            "shots": [
                {
                    "id": 1,
                    "title": "Setup Axes",
                    "narration": "We start with a coordinate system for the cosine function.",
                    "visual": "Coordinate axes",
                    "animation": "Create axes",
                },
                {
                    "id": 2,
                    "title": "Draw Cosine Curve",
                    "narration": "The cosine curve starts at (0,1) and oscillates between 1 and -1.",
                    "visual": "Cosine curve",
                    "animation": "Create graph",
                },
                {
                    "id": 3,
                    "title": "Mark Key Points",
                    "narration": "Key points: (0,1), (π/2,0), (π,-1), (3π/2,0), (2π,1).",
                    "visual": "Five key points",
                    "animation": "Fade in dots",
                },
                {
                    "id": 4,
                    "title": "Highlight Properties",
                    "narration": "The cosine function is even and periodic with period 2π.",
                    "visual": "Property summary",
                    "animation": "Write summary",
                },
            ],
            "risks": ["semantic mismatch", "text overlap"],
        },
        ensure_ascii=False,
    )


class _FakeMessage:
    def __init__(self, content: str):
        self.content = content


class _FakeChoice:
    def __init__(self, content: str):
        self.message = _FakeMessage(content)


class _FakeResponse:
    def __init__(self, content: str):
        self.choices = [_FakeChoice(content)]


class _FakeStreamDelta:
    def __init__(self, content: str):
        self.content = content


class _FakeStreamChoice:
    def __init__(self, content: str):
        self.delta = _FakeStreamDelta(content)


class _FakeStreamChunk:
    def __init__(self, content: str):
        self.choices = [_FakeStreamChoice(content)]


class _FakeStream:
    def __init__(self, content: str, chunk_size: int = 120):
        self.parts = [content[index:index + chunk_size] for index in range(0, len(content), chunk_size)]
        self.index = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.index >= len(self.parts):
            raise StopAsyncIteration
        part = self.parts[self.index]
        self.index += 1
        return _FakeStreamChunk(part)


class _FakeCompletions:
    def __init__(self, responses: list[str]):
        self.responses = list(responses)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if not self.responses:
            raise AssertionError("fake AI response queue exhausted")
        content = self.responses.pop(0)
        if kwargs.get("stream"):
            return _FakeStream(content)
        return _FakeResponse(content)


class _FakeChat:
    def __init__(self, responses: list[str]):
        self.completions = _FakeCompletions(responses)


class _FakeAI:
    def __init__(self, responses: list[str]):
        self.chat = _FakeChat(responses)


class ManimAgentV4Tests(unittest.TestCase):
    def test_planner_still_returns_clarification_for_low_confidence_prompt(self):
        brief = plan_animation("做个动画")

        self.assertLess(brief["confidence"], 0.6)
        self.assertIsNotNone(brief["clarification"])
        self.assertEqual(brief["plannerStrategy"], "rule_first_v5")

    def test_planner_recognizes_clear_circle_prompt_without_clarification(self):
        brief = plan_animation("画一个圆形")

        self.assertEqual(brief["domain"], "geometry")
        self.assertEqual(brief["animation_type"], "geometry_circle")
        self.assertGreaterEqual(brief["confidence"], 0.8)
        self.assertIsNone(brief["clarification"])
        self.assertEqual(brief["spec"]["kind"], "geometry_circle")

    def test_planner_routes_real_chinese_core_prompts(self):
        cases = {
            "\u753b\u4e00\u4e2a\u4e09\u89d2\u5f62": ("geometry", "triangle"),
            "\u753b\u4e00\u4e2a\u5706\u5f62": ("geometry", "geometry_circle"),
            "\u753b\u4e00\u4e2a\u6b63\u5f26\u51fd\u6570": ("math", "function_graph"),
            "\u753b\u4e00\u4e2a\u5c0f\u7403\u629b\u7269\u7ebf\u8fd0\u52a8": ("physics", "motion_path"),
        }
        for prompt, expected in cases.items():
            brief = plan_animation(prompt)
            self.assertEqual((brief["domain"], brief["animation_type"]), expected)

    def test_director_outputs_storyboard_spec_v5(self):
        brief = plan_animation("画一个圆形")
        ai = _FakeAI([director_json()])

        result = asyncio.run(design_storyboard(brief, ai_client=ai, model_name="fake-model"))
        spec = result["storyboardSpec"]

        self.assertEqual(result["status"], "success")
        self.assertEqual(spec["version"], "v5")
        self.assertEqual(spec["animation_type"], "geometry_circle")
        self.assertIn("Circle", spec["visual_objects"])
        self.assertGreaterEqual(len(spec["shots"]), 2)

    def test_director_prompt_and_fallback_keep_user_visible_storyboard_chinese(self):
        brief = plan_animation("画一个余弦函数")
        ai = _FakeAI([english_cosine_director_json()])

        result = asyncio.run(design_storyboard(brief, ai_client=ai, model_name="fake-model"))
        spec = result["storyboardSpec"]
        sent_messages = ai.chat.completions.calls[0]["messages"]

        self.assertIn("所有用户可见字段必须使用简体中文", sent_messages[0]["content"])
        self.assertEqual(result["status"], "success")
        self.assertIn("余弦函数", spec["topic"])
        self.assertIn("余弦函数", spec["teaching_goal"])
        self.assertEqual(spec["audience"], "学生")
        self.assertEqual(spec["shots"][0]["title"], "建立坐标系")
        self.assertIn("余弦函数", spec["shots"][0]["narration"])
        self.assertNotIn("Setup Axes", json.dumps(spec["shots"], ensure_ascii=False))

    def test_code_writer_requires_ai_and_does_not_fallback_to_templates(self):
        brief = plan_animation("画一个圆形")
        spec = json.loads(director_json())
        skills = select_skills(brief)

        unavailable = asyncio.run(generate_code(
            brief,
            skills,
            storyboard_spec=spec,
            ai_client=None,
            model_name=None,
        ))
        self.assertEqual(unavailable["status"], "error")
        self.assertEqual(unavailable["code"], "")
        self.assertEqual(unavailable["template"], "none")

        ai = _FakeAI([f"```python\n{circle_scene_code()}\n```"])
        generated = asyncio.run(write_scene_code(
            brief,
            spec,
            {},
            skills,
            ai_client=ai,
            model_name="fake-model",
        ))

        self.assertEqual(generated["status"], "success")
        self.assertEqual(generated["codeSource"], "llm_v5")
        self.assertEqual(renderable_scene_classes(generated["code"]), ["MainScene"])
        self.assertIn("Circle(", generated["code"])
        self.assertNotIn("_circle_template", generated["code"])

    def test_skill_loader_selects_core_skills_without_old_versions(self):
        brief = plan_animation("画一个正弦函数，做分步骤讲解动画")
        skills = select_skills(brief)
        skill_ids = [skill["id"] for skill in skills]

        self.assertLessEqual(len(skills), 3)
        self.assertIn("function_graph", skill_ids)
        self.assertIn("text_formula_layout", skill_ids)
        self.assertTrue(all(skill["version"] == "v5" for skill in skills))

    def test_critic_blocks_gateway_aligned_security_risks(self):
        code = """
from manim import *
import os

class MainScene(Scene):
    def construct(self):
        value = compile("1+1", "<x>", "eval")
        data = getattr(self, "__dict__")
        self.add(Text(str(value)), Text(str(data)))
"""
        report = critique_code(code, {"intent": "CREATE"})
        joined = "\n".join(issue["message"] for issue in report["issues"])

        self.assertEqual(report["status"], "error")
        self.assertIn("禁止导入系统", joined)
        self.assertIn("禁止动态执行", joined)
        self.assertIn("禁止访问双下划线", joined)

    def test_critic_rejects_hallucinated_scene_self_methods(self):
        code = """
from manim import *

class SafeScene:
    def safe_play(self, *animations, **kwargs):
        return self.play(*animations, **kwargs)

class MainScene(SafeScene, Scene):
    def construct(self):
        dot = Dot()
        self.add(dot)
        self.get_angle()
        self.get_center()
        self.next_to(dot, LEFT)
"""
        report = critique_code(code, {"intent": "CREATE"})
        joined = "\n".join(issue["message"] for issue in report["issues"])

        self.assertEqual(report["status"], "error")
        self.assertIn("self.get_angle()", joined)
        self.assertIn("self.get_center()", joined)
        self.assertIn("self.next_to()", joined)

    def test_critic_flags_invalid_mobject_method_keywords(self):
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        bar = Rectangle()
        bar.set_y(1, aligned_edge=DOWN)
        self.add(bar)
"""
        report = critique_code(code, {"intent": "CREATE"})
        codes = {issue.get("code") for issue in report["issues"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("invalid_mobject_keyword", codes)

    def test_critic_allows_scene_control_self_methods(self):
        code = """
from manim import *

class SafeScene:
    def safe_play(self, *animations, **kwargs):
        return self.play(*animations, **kwargs)

class MainScene(SafeScene, Scene):
    def construct(self):
        circle = Circle()
        self.add(circle)
        self.play(Create(circle))
        self.safe_play(FadeIn(circle))
        self.bring_to_front(circle)
        self.wait(1)
"""
        report = critique_code(code, {"intent": "CREATE"})
        joined = "\n".join(issue["message"] for issue in report["issues"])

        self.assertNotEqual(report["status"], "error")
        self.assertNotIn("self.", joined)

    def test_critic_rejects_mainscene_without_direct_scene_base(self):
        code = """
from manim import *

class SafeScene:
    pass

class MainScene(SafeScene):
    def construct(self):
        self.add(Circle())
"""
        report = critique_code(code, {"intent": "CREATE"})
        joined = "\n".join(issue["message"] for issue in report["issues"])

        self.assertEqual(report["status"], "error")
        self.assertIn("MainScene 必须直接继承 Scene", joined)

    def test_static_repair_fixes_common_scene_contract_drift(self):
        main_missing_scene = """
from manim import *

class SafeScene:
    pass

class MainScene(SafeScene):
    def construct(self):
        self.add(Circle())
"""
        helper_inherits_scene = """
from manim import *

class SafeScene(Scene):
    def safe_play(self, *animations, **kwargs):
        return self.play(*animations, **kwargs)

class CosineScene(SafeScene, Scene):
    def construct(self):
        self.add(Circle())
"""

        repaired_main = static_repair_once(main_missing_scene, {})
        repaired_helper = static_repair_once(helper_inherits_scene, {})

        self.assertIn("class MainScene(SafeScene, Scene):", repaired_main)
        self.assertNotIn("class SafeScene(Scene):", repaired_helper)
        self.assertIn("class MainScene(SafeScene, Scene):", repaired_helper)
        self.assertNotEqual(critique_code(repaired_main, {})["status"], "error")
        self.assertNotEqual(critique_code(repaired_helper, {})["status"], "error")

    def test_inspector_catches_circle_prompt_with_triangle_geometry(self):
        brief = plan_animation("画一个圆形")
        brief["storyboardSpec"] = json.loads(director_json())
        wrong_code = """
from manim import *

def make_header(title, subtitle=None): return VGroup(Text(title))
def make_step_banner(text): return Text(text)

class MainScene(Scene):
    def construct(self):
        triangle = Polygon(LEFT, RIGHT, UP)
        self.add(triangle)
"""
        report = inspect_code_quality(wrong_code, brief)
        messages = "\n".join(item["message"] for item in report["findings"])

        self.assertEqual(report["status"], "error")
        self.assertIn("圆形请求没有生成 Circle 对象", messages)
        self.assertIn("圆形请求生成了三角形几何", messages)

    def test_generated_circle_code_passes_static_and_semantic_checks(self):
        brief = plan_animation("画一个圆形")
        brief["storyboardSpec"] = json.loads(director_json())
        code = circle_scene_code()

        ast.parse(code)
        self.assertEqual(renderable_scene_classes(code), ["MainScene"])
        self.assertNotEqual(critique_code(code, brief)["status"], "error")
        self.assertEqual(inspect_code_quality(code, brief)["status"], "pass")

    def test_inspector_requires_real_triangle_object_not_text_only(self):
        brief = plan_animation("\u753b\u4e00\u4e2a\u4e09\u89d2\u5f62")
        text_only_code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        label = Text("三角形")
        self.add(label)
        self.wait(1)
"""
        report = inspect_code_quality(text_only_code, brief)
        codes = {item.get("code") for item in report["findings"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("semantic_triangle_missing", codes)

    def test_inspector_blocks_unit_circle_distractor_for_simple_function_graph(self):
        brief = plan_animation("\u753b\u4e00\u4e2a\u6b63\u5f26\u51fd\u6570")
        distracting_code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        axes = Axes(x_range=[-PI, PI, PI/2], y_range=[-1, 1, 1])
        graph = axes.plot(lambda x: np.sin(x), color=BLUE, stroke_width=6)
        unit_circle = Circle(radius=1)
        self.add(axes, graph, unit_circle)
        self.wait(1)
"""
        report = inspect_code_quality(distracting_code, brief)
        codes = {item.get("code") for item in report["findings"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("function_graph_circle_distractor", codes)

    def test_inspector_blocks_mathtex_labels_for_function_graphs(self):
        brief = plan_animation("\u753b\u4e00\u4e2a\u6b63\u5f26\u51fd\u6570")
        mathtex_code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        axes = Axes(x_range=[-PI, PI, PI/2], y_range=[-1, 1, 1])
        graph = axes.plot(lambda x: np.sin(x), color=BLUE, stroke_width=6)
        label1 = MathTex("\\\\pi/2")
        label2 = MathTex("\\\\pi")
        label3 = MathTex("y=\\\\sin(x)")
        self.add(axes, graph, label1, label2, label3)
        self.wait(1)
"""
        report = inspect_code_quality(mathtex_code, brief)
        codes = {item.get("code") for item in report["findings"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("function_graph_mathtex", codes)

    def test_inspector_blocks_mathtex_labels_for_data_charts(self):
        brief = plan_animation("\u753b\u4e00\u4e2a\u4e09\u4e2a\u6708\u9500\u91cf\u67f1\u72b6\u56fe")
        chart_code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        title = Text("三个月销量")
        jan = MathTex("1")
        feb = MathTex("2")
        mar = MathTex("3")
        self.add(title, jan, feb, mar)
        self.wait(1)
"""
        report = inspect_code_quality(chart_code, brief)
        codes = {item.get("code") for item in report["findings"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("data_chart_mathtex", codes)

    def test_rescue_scene_satisfies_core_semantic_contracts(self):
        cases = [
            ("\u753b\u4e00\u4e2a\u4e09\u89d2\u5f62", "Polygon"),
            ("\u753b\u4e00\u4e2a\u6b63\u5f26\u51fd\u6570", "Axes"),
            ("\u753b\u4e00\u4e2a\u4e09\u4e2a\u6708\u9500\u91cf\u67f1\u72b6\u56fe", "Rectangle"),
        ]
        for prompt, marker in cases:
            brief = plan_animation(prompt)
            code = rescue_scene_code(brief, "test")
            self.assertIn(marker, code)
            self.assertNotEqual(critique_code(code, brief)["status"], "error")
            self.assertNotEqual(inspect_code_quality(code, brief)["status"], "error")

    def test_sanitize_render_error_keeps_root_exception_without_paths(self):
        raw = "\n".join([
            "noise line",
            "File \"D:\\\\607document\\\\ICeCream\\\\temp.py\", line 12, in construct",
            "TypeError: VMobject.__init__() got an unexpected keyword argument 'points'",
        ])
        sanitized = sanitize_render_error(raw)

        self.assertIn("TypeError", sanitized)
        self.assertIn("unexpected keyword argument", sanitized)
        self.assertNotIn("D:\\", sanitized)

    def test_visual_judge_flags_black_frames_and_accepts_visible_frames(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest("Pillow is unavailable")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            black = tmp_path / "black.png"
            visible = tmp_path / "visible.png"
            letterbox = tmp_path / "letterbox.png"
            Image.new("RGB", (640, 360), (0, 0, 0)).save(black)
            image = Image.new("RGB", (640, 360), (247, 251, 255))
            for x in range(220, 420):
                for y in range(110, 250):
                    image.putpixel((x, y), (14, 165, 233))
            image.save(visible)
            boxed = Image.new("RGB", (640, 360), (0, 0, 0))
            for x in range(110, 530):
                for y in range(42, 318):
                    boxed.putpixel((x, y), (247, 251, 255))
            boxed.save(letterbox)

            black_report = inspect_frame_quality([black])
            visible_report = inspect_frame_quality([visible])
            letterbox_report = inspect_frame_quality([letterbox])

        self.assertEqual(black_report["status"], "error")
        self.assertIn(visible_report["status"], {"pass", "warning"})
        self.assertGreater(visible_report["metrics"]["nonBackgroundRatio"], 0.04)
        self.assertEqual(letterbox_report["status"], "error")
        self.assertGreater(letterbox_report["metrics"]["darkEdgeRatio"], 0.45)
        self.assertIn("黑色边框", letterbox_report["summary"])

    def test_visual_judge_estimates_circle_and_triangle_subject_shape(self):
        try:
            from PIL import Image, ImageDraw
        except Exception:
            self.skipTest("Pillow is unavailable")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            circle = tmp_path / "circle.png"
            triangle = tmp_path / "triangle.png"
            circle_image = Image.new("RGB", (640, 360), (247, 251, 255))
            triangle_image = Image.new("RGB", (640, 360), (247, 251, 255))
            ImageDraw.Draw(circle_image).ellipse((245, 80, 395, 230), fill=(14, 165, 233))
            ImageDraw.Draw(triangle_image).polygon([(320, 70), (220, 250), (420, 250)], fill=(14, 165, 233))
            circle_image.save(circle)
            triangle_image.save(triangle)

            circle_report = inspect_frame_quality([circle])
            triangle_report = inspect_frame_quality([triangle])

        circle_shape = circle_report["metrics"]["shape"]
        triangle_shape = triangle_report["metrics"]["shape"]
        self.assertGreater(circle_shape["circleScore"], circle_shape["triangleScore"])
        self.assertGreater(triangle_shape["triangleScore"], triangle_shape["circleScore"])

    def test_motion_inspector_requires_projectile_reasoning_cues(self):
        brief = plan_animation("画一个小球抛物线运动")
        weak_code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        ball = Dot()
        self.add(ball)
        self.wait(1)
"""
        report = inspect_code_quality(weak_code, brief)
        codes = {item.get("code") for item in report["findings"]}

        self.assertEqual(report["status"], "warning")
        self.assertIn("motion_reasoning_incomplete", codes)

    def test_visual_judge_does_not_fail_triangle_when_code_semantics_are_correct(self):
        try:
            from PIL import Image, ImageDraw
        except Exception:
            self.skipTest("Pillow is unavailable")

        brief = plan_animation("画一个三角形")
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        triangle = Polygon(LEFT, RIGHT, UP)
        self.add(triangle)
        self.wait(1)
"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            frame = tmp_path / "triangle.png"
            fake_video = tmp_path / "fake.mp4"
            fake_video.write_bytes(b"0" * 50000)
            image = Image.new("RGB", (640, 360), (247, 251, 255))
            ImageDraw.Draw(image).polygon([(320, 70), (220, 250), (420, 250)], fill=(14, 165, 233))
            image.save(frame)
            with patch("app.agent.visual_judge._video_path_from_url", return_value=fake_video), patch(
                "app.agent.visual_judge._extract_frames", return_value=[frame]
            ):
                report = inspect_visual_quality(code, brief, {"success": True, "videoUrl": "/static/fake.mp4"})

        messages = "\n".join(item["message"] for item in report["findings"])
        self.assertNotEqual(report["status"], "error")
        self.assertNotIn("不像三角形", messages)

    def test_runtime_helpers_avoid_black_letterbox_and_inner_panel(self):
        self.assertIn('self.camera.background_color = "#F7FBFF"', SCENE_RUNTIME_CODE)
        self.assertIn("config.frame_width", SCENE_RUNTIME_CODE)
        self.assertIn("stroke_width=0", SCENE_RUNTIME_CODE)
        self.assertIn("set_z_index(-20)", SCENE_RUNTIME_CODE)

    def test_visual_judge_reports_failed_or_tiny_preview(self):
        failed = inspect_visual_quality("from manim import *", {}, {
            "success": False,
            "error": "NameError: name 'Axes' is not defined",
            "details": "NameError: name 'Axes' is not defined",
            "errorType": "manim_render_failed",
        })
        attribute_failed = inspect_visual_quality("from manim import *", {}, {
            "success": False,
            "error": "AttributeError: 'MainScene' object has no attribute 'get_angle'",
            "details": "AttributeError: 'MainScene' object has no attribute 'get_angle'",
            "errorType": "manim_render_failed",
        })
        tiny = inspect_visual_quality(
            "from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.wait(1)\n",
            {},
            {"success": True, "videoUrl": "/static/video.mp4", "videoBase64": "AAAA"},
        )

        self.assertEqual(failed["status"], "error")
        self.assertIn("预览渲染失败", failed["summary"])
        self.assertIn("名称未定义", failed["summary"])
        self.assertEqual(attribute_failed["status"], "error")
        self.assertIn("MainScene.get_angle()", attribute_failed["summary"])
        self.assertNotIn("object has no attribute", attribute_failed["summary"])
        self.assertEqual(tiny["status"], "error")

    def test_repair_stops_after_max_attempts_with_observations(self):
        attempts = []

        def unchanged_fixer(code, observation):
            attempts.append(observation)
            return code

        result = repair_code(
            "bad code",
            {"status": "error", "issues": [{"message": "still broken"}]},
            stderr="NameError: Scene is not defined",
            max_attempts=2,
            fixer=unchanged_fixer,
        )

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["attempts"], 2)
        self.assertIn("最大自动修复次数", result["summary"])
        self.assertEqual(len(attempts), 2)
        self.assertIn("root_cause_hint", result)

    def test_repair_attempt_config_defaults_to_four_and_clamps(self):
        with patch.dict(os.environ, {"MANIM_AGENT_REPAIR_ATTEMPTS": ""}, clear=False):
            self.assertEqual(service_config.get_manim_agent_repair_attempts(), 4)
        with patch.dict(os.environ, {"MANIM_AGENT_REPAIR_ATTEMPTS": "5"}, clear=False):
            self.assertEqual(service_config.get_manim_agent_repair_attempts(), 5)
        with patch.dict(os.environ, {"MANIM_AGENT_REPAIR_ATTEMPTS": "99"}, clear=False):
            self.assertEqual(service_config.get_manim_agent_repair_attempts(), 6)
        with patch.dict(os.environ, {"MANIM_AGENT_REPAIR_ATTEMPTS": "not-a-number"}, clear=False):
            self.assertEqual(service_config.get_manim_agent_repair_attempts(), 4)

    def test_workflow_uses_configured_repair_attempt_limit(self):
        captured_attempt_limits = []
        bad_code = """
from manim import *

class MainScene(SafeScene, Scene):
    def construct(self):
        self.add(MathTex("中文"))
"""

        async def fake_repair_code_async(code, report, **kwargs):
            captured_attempt_limits.append(kwargs["max_attempts"])
            return {
                "status": "error",
                "summary": "still broken",
                "attempts": kwargs["max_attempts"],
                "code": code,
                "critic": report,
                "observations": [],
            }

        async def collect():
            events = []
            ai = _FakeAI([director_json(), f"```python\n{bad_code}\n```"])
            with patch.dict(os.environ, {"MANIM_AGENT_REPAIR_ATTEMPTS": "5"}, clear=False), patch(
                "app.agent.workflow.repair_code_async",
                fake_repair_code_async,
            ):
                async for event in stream_agent_events(
                    {"message": "画一个圆形", "mode": "create"},
                    ai_client=ai,
                    model_name="fake-model",
                    render=False,
                ):
                    events.append(event)
            return events

        asyncio.run(collect())

        self.assertEqual(captured_attempt_limits, [5])

    def test_repair_observation_preserves_attribute_error_details(self):
        attempts = []
        stderr = "AttributeError: 'MainScene' object has no attribute 'get_angle'"

        def unchanged_fixer(code, observation):
            attempts.append(observation)
            return code

        repair_code(
            "from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.get_angle()\n",
            {"status": "error", "issues": [{"message": "preview failed"}]},
            stderr=stderr,
            max_attempts=1,
            fixer=unchanged_fixer,
        )

        self.assertEqual(len(attempts), 1)
        self.assertIn("AttributeError", attempts[0]["stderr"])
        self.assertIn("get_angle", attempts[0]["stderr"])

    def test_async_repair_sends_observation_to_llm(self):
        bad_code = """
class MainScene(Scene):
    def construct(self):
        self.add(Text("missing import"))
"""
        fixed_code = "```python\nfrom manim import *\n\nclass MainScene(Scene):\n    def construct(self):\n        self.add(Text(\"fixed\"))\n```"
        ai = _FakeAI([fixed_code])

        result = asyncio.run(repair_code_async(
            bad_code,
            critique_code(bad_code, {}),
            max_attempts=2,
            ai_client=ai,
            model_name="fake-model",
        ))

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["attempts"], 1)
        payload = json.loads(ai.chat.completions.calls[0]["messages"][1]["content"])
        self.assertIn("observation", payload)
        self.assertIn("root_cause_hint", payload["observation"])

    def test_agent_stream_emits_v5_design_style_visual_trace_without_render(self):
        async def collect():
            events = []
            ai = _FakeAI([director_json(), f"```python\n{circle_scene_code()}\n```"])
            async for event in stream_agent_events(
                {"message": "画一个圆形", "mode": "create"},
                ai_client=ai,
                model_name="fake-model",
                render=False,
            ):
                events.append(event)
            return events, ai.chat.completions.calls

        events, calls = asyncio.run(collect())
        event_types = [event["type"] for event in events]
        final = events[-1]

        for event_type in ("plan", "design", "storyboard", "style", "skills", "code", "critic_report", "inspect", "quality_report", "preview", "result"):
            self.assertIn(event_type, event_types)
        self.assertIn("code_delta", event_types)
        self.assertLess(event_types.index("code_delta"), event_types.index("code"))
        self.assertTrue(any(call.get("stream") is True for call in calls))
        self.assertEqual(final["type"], "result")
        self.assertEqual(final["agentTrace"]["template"], "none")
        self.assertEqual(final["agentTrace"]["codeSource"], "llm_v5")
        self.assertEqual(final["agentTrace"]["storyboardSpec"]["version"], "v5")
        self.assertEqual(final["agentTrace"]["preview"]["status"], "skipped")

    def test_agent_stream_passes_preview_render_stderr_to_repair(self):
        captured_stderr = []
        render_calls = []

        async def fake_render(code, client_id="agent", stage="render"):
            render_calls.append((client_id, stage))
            if len(render_calls) == 1:
                return {
                    "success": False,
                    "error": "NameError: name 'Axes' is not defined",
                    "details": "NameError: name 'Axes' is not defined",
                    "stderr": "NameError: name 'Axes' is not defined",
                    "errorType": "manim_render_failed",
                }
            return {"success": True, "videoUrl": "/static/fake.mp4", "videoBase64": ""}

        async def fake_repair(code, brief, report, repair_attempts, **kwargs):
            captured_stderr.append(kwargs.get("stderr", ""))
            return code, {"status": "pass", "summary": "ok", "issues": []}, repair_attempts + 1, {
                "status": "success",
                "summary": "ok",
                "attempts": 1,
            }

        async def collect():
            events = []
            ai = _FakeAI([director_json(), f"```python\n{circle_scene_code()}\n```"])
            with patch("app.agent.workflow.render_code_for_agent", fake_render), patch(
                "app.agent.workflow._repair_from_report", fake_repair
            ):
                async for event in stream_agent_events(
                    {"message": "画一个圆形", "mode": "create"},
                    ai_client=ai,
                    model_name="fake-model",
                    render=True,
                ):
                    events.append(event)
            return events

        events = asyncio.run(collect())

        self.assertTrue(any(event["type"] == "visual_check" for event in events))
        self.assertTrue(captured_stderr)
        self.assertIn("NameError", captured_stderr[0])
        self.assertEqual(render_calls[0][1], "preview_render")
        self.assertEqual(render_calls[-1][1], "final_render")

    def test_v4_disabled_returns_warning_without_template_fallback(self):
        original = os.environ.get("MANIM_AGENT_V4_ENABLED")
        os.environ["MANIM_AGENT_V4_ENABLED"] = "false"
        try:
            async def collect():
                events = []
                async for event in stream_agent_events(
                    {"message": "画一个圆形", "mode": "create"},
                    ai_client=_FakeAI([director_json(), f"```python\n{circle_scene_code()}\n```"]),
                    model_name="fake-model",
                    render=False,
                ):
                    events.append(event)
                return events

            events = asyncio.run(collect())
        finally:
            if original is None:
                os.environ.pop("MANIM_AGENT_V4_ENABLED", None)
            else:
                os.environ["MANIM_AGENT_V4_ENABLED"] = original

        self.assertEqual(events[-1]["type"], "result")
        self.assertFalse(events[-1]["rendered"])
        self.assertEqual(events[-1]["code"], "")
        self.assertEqual(events[-1]["agentTrace"]["template"], "none")
        self.assertIn("Manim Agent v5", events[-1]["warning"])


if __name__ == "__main__":
    unittest.main()
