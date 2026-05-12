import sys
import unittest
import ast
import asyncio
import re
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from app.agent.coder import generate_code
from app.agent.critic import critique_code
from app.agent.inspector import inspect_code_quality
from app.agent.planner import plan_animation
from app.agent.repair import repair_code
from app.agent.skill_loader import select_skills
from app.agent.workflow import stream_agent_events


class ManimAgentTests(unittest.TestCase):
    def test_planner_returns_clarification_for_low_confidence_prompt(self):
        brief = plan_animation("做个动画")

        self.assertLess(brief["confidence"], 0.6)
        self.assertIsNotNone(brief["clarification"])
        self.assertIn("question", brief["clarification"])
        self.assertGreaterEqual(len(brief["clarification"]["options"]), 2)

    def test_skill_loader_selects_general_visualization_skills(self):
        brief = plan_animation("用柱状图展示三个月销量变化，并解释趋势")
        skills = select_skills(brief)
        skill_ids = [skill["id"] for skill in skills]

        self.assertLessEqual(len(skills), 3)
        self.assertIn("data_visualization", skill_ids)
        self.assertIn("text_formula_layout", skill_ids)

    def test_critic_catches_mathtex_chinese_missing_import_and_dangerous_code(self):
        code = """
import os

class MainScene(Scene):
    def construct(self):
        title = MathTex("增长趋势：你好")
        self.add(title)
"""

        report = critique_code(code, {"intent": "CREATE"})

        self.assertEqual(report["status"], "error")
        joined = "\n".join(issue["message"] for issue in report["issues"])
        self.assertIn("from manim import *", joined)
        self.assertIn("MathTex", joined)
        self.assertIn("system access", joined)

    def test_repair_stops_after_max_attempts_with_explainable_error(self):
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

    def test_template_coder_escapes_user_title_as_valid_python(self):
        brief = plan_animation('展示 "斜率" 的变化')
        result = asyncio.run(generate_code(brief, []))

        ast.parse(result["code"])
        self.assertIn('\\"斜率\\"', result["code"])

    def test_planner_builds_function_graph_spec_for_stepwise_sine(self):
        brief = plan_animation("画一个正弦函数，做分步骤讲解动画")
        spec = brief["spec"]

        self.assertEqual(spec["kind"], "function_graph")
        self.assertEqual(spec["function"], "sin")
        self.assertEqual(spec["tick_policy"], "symbolic_pi")
        self.assertGreaterEqual(len(spec["teaching_steps"]), 3)
        self.assertGreaterEqual(brief["confidence"], 0.6)

    def test_skill_loader_selects_function_graph_coordinate_and_text_skills(self):
        brief = plan_animation("画一个正弦函数，做分步骤讲解动画")
        skills = select_skills(brief)
        skill_ids = [skill["id"] for skill in skills]

        self.assertLessEqual(len(skills), 3)
        self.assertEqual(skill_ids[:3], ["function_graph", "coordinate_system", "text_formula_layout"])

    def test_sine_template_uses_symbolic_pi_ticks_without_long_decimals(self):
        brief = plan_animation("画一个正弦函数，做分步骤讲解动画")
        result = asyncio.run(generate_code(brief, select_skills(brief)))
        code = result["code"]

        ast.parse(code)
        self.assertIn("class SafeScene:", code)
        self.assertIn("class MainScene(SafeScene, Scene)", code)
        self.assertIn('self.camera.background_color = "#F7FBFF"', code)
        self.assertNotIn('self.camera.background_color = "#0B1020"', code)
        self.assertIn("def make_header", code)
        self.assertIn("def make_step_banner", code)
        self.assertIn("def place_graph_area", code)
        self.assertIn("def assert_layout_zones", code)
        self.assertIn("header, title, formula = make_header", code)
        self.assertIn("step_banner = make_step_banner", code)
        self.assertNotIn("to_corner(UL", code)
        self.assertIn("def symbolic_ticks", code)
        self.assertIn('MathTex("-\\\\pi", color="#475569")', code)
        self.assertIn('MathTex("\\\\pi", color="#475569")', code)
        self.assertNotRegex(code, r"3\.1415\d+")
        self.assertNotRegex(code, r"1\.5707\d+")

    def test_sine_template_scene_detection_renders_main_scene_not_helper(self):
        brief = plan_animation("画一个正弦函数，做分步骤讲解动画")
        result = asyncio.run(generate_code(brief, select_skills(brief)))
        tree = ast.parse(result["code"])
        direct_scene_classes = [
            node.name
            for node in ast.walk(tree)
            if isinstance(node, ast.ClassDef)
            and any(getattr(base, "id", "") == "Scene" for base in node.bases)
        ]

        self.assertEqual(direct_scene_classes, ["MainScene"])

    def test_critic_and_inspector_catch_long_decimal_ticks_and_text_density(self):
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        labels = VGroup(*[
            Text("3.141592653589793"),
            Text("1.5707963267948966"),
            Text("说明1"), Text("说明2"), Text("说明3"), Text("说明4"),
            Text("说明5"), Text("说明6"), Text("说明7"), Text("说明8"),
            Text("说明9"), Text("说明10"), Text("说明11"), Text("说明12"),
            Text("说明13"), Text("说明14"), Text("说明15"), Text("说明16"),
            Text("说明17"), Text("说明18"), Text("说明19"),
        ])
        self.add(labels)
"""
        report = critique_code(code, {"intent": "CREATE"})
        quality = inspect_code_quality(code)
        joined = "\n".join(issue["message"] for issue in report["issues"])

        self.assertIn("Long decimal coordinate labels", joined)
        self.assertIn("text objects", quality["summary"])
        self.assertNotEqual(quality["status"], "pass")

    def test_inspector_catches_function_graph_header_step_overlap_risk(self):
        brief = plan_animation("\u753b\u4e00\u4e2a\u6b63\u5f26\u51fd\u6570\uff0c\u505a\u5206\u6b65\u9aa4\u8bb2\u89e3\u52a8\u753b")
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        title = Text("画一个正弦函数，做一个分步骤讲解动画").to_edge(UP)
        formula = MathTex("y=\\sin(x)").next_to(title, DOWN)
        step_label = Text("步骤 2：绘制函数曲线").to_corner(UL)
        self.add(title, formula, step_label)
"""

        quality = inspect_code_quality(code, brief)
        joined = "\n".join(item["message"] for item in quality["findings"])

        self.assertEqual(quality["status"], "error")
        self.assertIn("header and step label overlap", joined)

    def test_repair_converts_legacy_function_graph_overlap_to_zoned_template(self):
        brief = plan_animation("\u753b\u4e00\u4e2a\u6b63\u5f26\u51fd\u6570\uff0c\u505a\u5206\u6b65\u9aa4\u8bb2\u89e3\u52a8\u753b")
        legacy_code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        title = Text("画一个正弦函数，做一个分步骤讲解动画").to_edge(UP)
        formula = MathTex("y=\\sin(x)").next_to(title, DOWN)
        step_label = Text("步骤 2：绘制函数曲线").to_corner(UL)
        self.add(title, formula, step_label)
"""
        quality = inspect_code_quality(legacy_code, brief)
        result = repair_code(
            legacy_code,
            {"status": "error", "issues": quality["findings"], "summary": quality["summary"]},
            max_attempts=2,
            brief=brief,
        )

        self.assertEqual(result["status"], "success")
        self.assertIn("make_header", result["code"])
        self.assertIn("make_step_banner", result["code"])
        self.assertNotIn("to_corner(UL", result["code"])
        self.assertEqual(inspect_code_quality(result["code"], brief)["status"], "pass")

    def test_agent_stream_emits_inspection_and_quality_report_before_result(self):
        async def collect():
            events = []
            async for event in stream_agent_events(
                {"message": "画一个正弦函数，做分步骤讲解动画", "mode": "create"},
                render=False,
            ):
                events.append(event)
            return events

        events = asyncio.run(collect())
        event_types = [event["type"] for event in events]

        self.assertIn("inspect", event_types)
        self.assertIn("quality_report", event_types)
        self.assertEqual(events[-1]["type"], "result")
        self.assertEqual(events[-1]["agentTrace"]["quality"]["status"], "pass")


if __name__ == "__main__":
    unittest.main()
