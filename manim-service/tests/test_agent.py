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

from app.agent.code_writer import write_scene_code
from app.agent.coder import generate_code
from app.agent.critic import critique_code
from app.agent.director import design_storyboard
from app.agent.inspector import inspect_code_quality
from app.agent.planner import plan_animation
from app.agent.repair import repair_code, repair_code_async
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


class _FakeCompletions:
    def __init__(self, responses: list[str]):
        self.responses = list(responses)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if not self.responses:
            raise AssertionError("fake AI response queue exhausted")
        return _FakeResponse(self.responses.pop(0))


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
        self.assertEqual(brief["plannerStrategy"], "rule_first_v4")

    def test_planner_recognizes_clear_circle_prompt_without_clarification(self):
        brief = plan_animation("画一个圆形")

        self.assertEqual(brief["domain"], "geometry")
        self.assertEqual(brief["animation_type"], "geometry_circle")
        self.assertGreaterEqual(brief["confidence"], 0.8)
        self.assertIsNone(brief["clarification"])
        self.assertEqual(brief["spec"]["kind"], "geometry_circle")

    def test_director_outputs_storyboard_spec_v4(self):
        brief = plan_animation("画一个圆形")
        ai = _FakeAI([director_json()])

        result = asyncio.run(design_storyboard(brief, ai_client=ai, model_name="fake-model"))
        spec = result["storyboardSpec"]

        self.assertEqual(result["status"], "success")
        self.assertEqual(spec["version"], "v4")
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
        self.assertEqual(generated["codeSource"], "llm_v4")
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
        self.assertTrue(all(skill["version"] == "v4" for skill in skills))

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
        self.assertIn("system or network module access", joined)
        self.assertIn("dynamic execution or introspection", joined)
        self.assertIn("double-underscore", joined)

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
        self.assertIn("MainScene must inherit Scene directly", joined)

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
        self.assertIn("Circle request did not generate a Circle object", messages)
        self.assertIn("Circle request generated triangle geometry", messages)

    def test_generated_circle_code_passes_static_and_semantic_checks(self):
        brief = plan_animation("画一个圆形")
        brief["storyboardSpec"] = json.loads(director_json())
        code = circle_scene_code()

        ast.parse(code)
        self.assertEqual(renderable_scene_classes(code), ["MainScene"])
        self.assertNotEqual(critique_code(code, brief)["status"], "error")
        self.assertEqual(inspect_code_quality(code, brief)["status"], "pass")

    def test_visual_judge_flags_black_frames_and_accepts_visible_frames(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest("Pillow is unavailable")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            black = tmp_path / "black.png"
            visible = tmp_path / "visible.png"
            Image.new("RGB", (640, 360), (0, 0, 0)).save(black)
            image = Image.new("RGB", (640, 360), (247, 251, 255))
            for x in range(220, 420):
                for y in range(110, 250):
                    image.putpixel((x, y), (14, 165, 233))
            image.save(visible)

            black_report = inspect_frame_quality([black])
            visible_report = inspect_frame_quality([visible])

        self.assertEqual(black_report["status"], "error")
        self.assertIn(visible_report["status"], {"pass", "warning"})
        self.assertGreater(visible_report["metrics"]["nonBackgroundRatio"], 0.04)

    def test_visual_judge_reports_failed_or_tiny_preview(self):
        failed = inspect_visual_quality("from manim import *", {}, {
            "success": False,
            "error": "NameError: name 'Axes' is not defined",
            "details": "NameError: name 'Axes' is not defined",
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
        self.assertIn("maximum repair attempts", result["summary"])
        self.assertEqual(len(attempts), 2)
        self.assertIn("root_cause_hint", result)

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

    def test_agent_stream_emits_v4_design_style_visual_trace_without_render(self):
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
            return events

        events = asyncio.run(collect())
        event_types = [event["type"] for event in events]
        final = events[-1]

        for event_type in ("plan", "design", "storyboard", "style", "skills", "code", "inspect", "quality_report", "preview", "result"):
            self.assertIn(event_type, event_types)
        self.assertEqual(final["type"], "result")
        self.assertEqual(final["agentTrace"]["template"], "none")
        self.assertEqual(final["agentTrace"]["codeSource"], "llm_v4")
        self.assertEqual(final["agentTrace"]["storyboardSpec"]["version"], "v4")
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
        self.assertIn("MANIM_AGENT_V4_ENABLED=false", events[-1]["warning"])


if __name__ == "__main__":
    unittest.main()
