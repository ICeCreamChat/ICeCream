import sys
import unittest
import ast
import asyncio
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from app.agent.coder import generate_code
from app.agent.critic import critique_code
from app.agent.planner import plan_animation
from app.agent.repair import repair_code
from app.agent.skill_loader import select_skills


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


if __name__ == "__main__":
    unittest.main()
