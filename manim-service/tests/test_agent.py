import ast
import asyncio
import base64
import json
import os
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from app import service_config
from app.agent.code_writer import build_code_writer_messages, write_scene_code
from app.agent.coder import generate_code
from app.agent.critic import critique_code
from app.agent.director import build_director_messages, design_storyboard
from app.agent.failure_events import record_failure_event
from app.agent.failure_replay import replay_failure_events
from app.agent.inspector import inspect_code_quality
from app.agent import job_registry
from app.agent.job_registry import cancel_job, create_job, get_job, update_job
from app.agent.manim_knowledge import RULE_PACK_VERSION, manim_rules_prompt, rule_ids
from app.agent.planner import plan_animation
from app.agent.prompt_loader import API_INDEX_VERSION, PROMPT_PACK_VERSION, build_generation_prompt_pack
from app.agent.reference_analyzer import analyze_references
from app.agent.reference_store import resolve_reference_records, save_reference_image
from app.agent.render_cache import get_cached_render, save_cached_render
from app.agent.repair import build_repair_observation, patch_first_repair, repair_code, repair_code_async, static_repair_once
from app.agent.renderer import sanitize_render_error
from app.agent.routes import register_agent_routes, to_json_safe
from app.agent.rescue_scene import rescue_scene_code
from app.agent.real_smoke import run_real_smoke_suite
from app.agent.scene_runtime import SCENE_RUNTIME_CODE
from app.agent.skill_loader import SKILL_CATALOG_VERSION, select_skills, skill_catalog
from app.agent.smoke_suite import SMOKE_CASES, evaluate_smoke_result
from app.agent.static_guard import run_static_guard
from app.agent.visual_judge import inspect_frame_quality, inspect_visual_quality
from app.agent.workflow import stream_agent_events
from PIL import Image, ImageDraw


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
    def test_manimcat_rule_pack_is_available_to_generation_and_tests(self):
        ids = set(rule_ids())
        prompt = manim_rules_prompt()

        self.assertEqual(RULE_PACK_VERSION, "manimcat-foundation-v6")
        for required in {
            "scene_contract",
            "scene_self_methods",
            "text_formula_split",
            "legacy_api_forbidden",
            "axis_config",
            "canvas_quality",
            "semantic_object_match",
        }:
            self.assertIn(required, ids)
            self.assertIn(required, prompt)
        self.assertIn("ManimCat", prompt)

    def test_core_manim_agent_files_do_not_contain_mojibake_literals(self):
        checked = [
            SERVICE_ROOT / "app" / "agent" / "critic.py",
            SERVICE_ROOT / "app" / "agent" / "director.py",
            SERVICE_ROOT / "app" / "agent" / "code_writer.py",
            SERVICE_ROOT / "app" / "agent" / "repair.py",
            SERVICE_ROOT / "app" / "agent" / "workflow.py",
            SERVICE_ROOT / "app" / "agent" / "inspector.py",
        ]
        forbidden = ("\u9422", "\u6d93", "\u9366", "\u8930", "\ufffd")

        for path in checked:
            text = path.read_text(encoding="utf-8")
            for marker in forbidden:
                self.assertNotIn(marker, text, f"{path} contains mojibake marker {marker!r}")

    def test_v6_prompt_pack_is_loaded_from_versioned_modules(self):
        prompt = build_generation_prompt_pack()

        self.assertIn(PROMPT_PACK_VERSION, prompt)
        self.assertIn(API_INDEX_VERSION, prompt)
        self.assertIn("Scene", prompt)
        self.assertIn("Text", prompt)
        self.assertIn("MathTex", prompt)
        self.assertIn("黑边", prompt)

    def test_job_registry_tracks_status_and_cancel_state(self):
        original = os.environ.get("MANIM_AGENT_JOBS_FILE")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["MANIM_AGENT_JOBS_FILE"] = str(Path(temp_dir) / "jobs.json")
            job_registry._JOBS = None
            job = create_job({"message": "画一个圆形", "jobId": "unit-job"})
            updated = update_job(job["jobId"], status="running", current_stage="coder", summary="正在生成代码")
            cancelled = cancel_job(job["jobId"])

            self.assertEqual(job["jobId"], "unit-job")
            self.assertEqual(updated["currentStage"], "coder")
            self.assertTrue(cancelled["success"])
            self.assertTrue(get_job(job["jobId"])["cancelRequested"])
        if original is None:
            os.environ.pop("MANIM_AGENT_JOBS_FILE", None)
        else:
            os.environ["MANIM_AGENT_JOBS_FILE"] = original
        job_registry._JOBS = None

    def test_render_cache_round_trips_successful_video_metadata(self):
        original = os.environ.get("MANIM_AGENT_RENDER_CACHE")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["MANIM_AGENT_RENDER_CACHE"] = str(Path(temp_dir) / "render-cache.json")
            code = "from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.add(Circle())\n"
            self.assertIsNone(get_cached_render(code))
            saved = save_cached_render(code, {"videoUrl": "/static/video.mp4"}, trace={"codeSource": "llm_v6"})
            cached = get_cached_render(code)

            self.assertEqual(cached["cacheKey"], saved["cacheKey"])
            self.assertEqual(cached["videoUrl"], "/static/video.mp4")
            self.assertTrue(cached["cached"])
        if original is None:
            os.environ.pop("MANIM_AGENT_RENDER_CACHE", None)
        else:
            os.environ["MANIM_AGENT_RENDER_CACHE"] = original

    def test_reference_image_store_validates_and_returns_safe_metadata(self):
        original_dir = os.environ.get("MANIM_AGENT_REFERENCE_DIR")
        buffer = BytesIO()
        Image.new("RGB", (1, 1), color=(255, 255, 255)).save(buffer, format="PNG")
        one_pixel_png = base64.b64encode(buffer.getvalue()).decode("ascii")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["MANIM_AGENT_REFERENCE_DIR"] = temp_dir
            result = save_reference_image(
                filename="../sketch.png",
                mime_type="image/png",
                data_base64=one_pixel_png,
            )
            rejected = save_reference_image(filename="bad.txt", mime_type="text/plain", data_base64=one_pixel_png)

            self.assertTrue(result["success"])
            self.assertNotIn("path", result["reference"])
            self.assertEqual(result["reference"]["width"], 1)
            self.assertEqual(result["reference"]["height"], 1)
            self.assertFalse(rejected["success"])
        if original_dir is None:
            os.environ.pop("MANIM_AGENT_REFERENCE_DIR", None)
        else:
            os.environ["MANIM_AGENT_REFERENCE_DIR"] = original_dir

    def test_reference_analyzer_detects_drawn_circle_without_leaking_path(self):
        original_dir = os.environ.get("MANIM_AGENT_REFERENCE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["MANIM_AGENT_REFERENCE_DIR"] = temp_dir
            image = Image.new("RGB", (320, 180), color=(255, 255, 255))
            draw = ImageDraw.Draw(image)
            draw.ellipse((95, 35, 225, 165), outline=(20, 20, 20), width=8)
            buffer = BytesIO()
            image.save(buffer, format="PNG")
            saved = save_reference_image(
                filename="circle.png",
                mime_type="image/png",
                data_base64=base64.b64encode(buffer.getvalue()).decode("ascii"),
            )
            records = resolve_reference_records([saved["reference"]["referenceId"]])
            bundle = analyze_references(records, plan_animation("照这个做一个简单动画"))

            self.assertEqual(bundle["referenceSemanticTarget"], "circle")
            self.assertEqual(bundle["referenceSpecs"][0]["status"], "pass")
            self.assertIn("\u5706", bundle["summary"])
            self.assertNotIn("path", json.dumps(bundle, ensure_ascii=False))
        if original_dir is None:
            os.environ.pop("MANIM_AGENT_REFERENCE_DIR", None)
        else:
            os.environ["MANIM_AGENT_REFERENCE_DIR"] = original_dir

    def test_reference_analyzer_warns_on_blank_image(self):
        original_dir = os.environ.get("MANIM_AGENT_REFERENCE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["MANIM_AGENT_REFERENCE_DIR"] = temp_dir
            buffer = BytesIO()
            Image.new("RGB", (320, 180), color=(255, 255, 255)).save(buffer, format="PNG")
            saved = save_reference_image(
                filename="blank.png",
                mime_type="image/png",
                data_base64=base64.b64encode(buffer.getvalue()).decode("ascii"),
            )
            bundle = analyze_references(resolve_reference_records([saved["reference"]["referenceId"]]), {})

            self.assertEqual(bundle["status"], "warning")
            self.assertTrue(bundle["warnings"])
            self.assertIn("\u5185\u5bb9\u8fc7\u5c11", bundle["summary"])
        if original_dir is None:
            os.environ.pop("MANIM_AGENT_REFERENCE_DIR", None)
        else:
            os.environ["MANIM_AGENT_REFERENCE_DIR"] = original_dir

    def test_planner_still_returns_clarification_for_low_confidence_prompt(self):
        brief = plan_animation("做个动画")

        self.assertLess(brief["confidence"], 0.6)
        self.assertIsNotNone(brief["clarification"])
        self.assertEqual(brief["plannerStrategy"], "rule_first_v6")

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
            "\u753b\u4e00\u4e2a\u6b63\u65b9\u5f62": ("geometry", "square"),
            "\u753b\u4e00\u4e2a\u6b63\u5f26\u51fd\u6570": ("math", "function_graph"),
            "\u753b\u4e00\u4e2a\u5c0f\u7403\u629b\u7269\u7ebf\u8fd0\u52a8": ("physics", "motion_path"),
        }
        for prompt, expected in cases.items():
            brief = plan_animation(prompt)
            self.assertEqual((brief["domain"], brief["animation_type"]), expected)

    def test_director_outputs_storyboard_spec_v6(self):
        brief = plan_animation("画一个圆形")
        ai = _FakeAI([director_json()])

        result = asyncio.run(design_storyboard(brief, ai_client=ai, model_name="fake-model"))
        spec = result["storyboardSpec"]

        self.assertEqual(result["status"], "success")
        self.assertEqual(spec["version"], "v6")
        self.assertEqual(spec["animation_type"], "geometry_circle")
        self.assertIn("Circle", spec["visual_objects"])
        self.assertGreaterEqual(len(spec["shots"]), 2)

    def test_director_uses_local_storyboard_fallback_on_malformed_json(self):
        brief = plan_animation("\u753b\u4e00\u4e2a\u6b63\u65b9\u5f62")
        ai = _FakeAI(["```json\n{\"version\":\"v6\",\"topic\":\"broken\"\n```"])

        result = asyncio.run(design_storyboard(brief, ai_client=ai, model_name="fake-model"))
        spec = result["storyboardSpec"]
        text = json.dumps(spec, ensure_ascii=False)

        self.assertEqual(result["status"], "success")
        self.assertIn("本地规则补全", result["summary"])
        self.assertEqual(spec["semantic_target"], "square")
        self.assertEqual(spec["animation_type"], "square")
        self.assertIn("Square", text)
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

    def test_director_keeps_simple_trig_graphs_focused_on_axes_and_curve(self):
        brief = plan_animation("画一个正弦函数，做分步骤讲解动画")
        noisy_spec = json.loads(english_cosine_director_json())
        noisy_spec.update({
            "topic": "画一个正弦函数",
            "teaching_goal": "讲解正弦函数图像。",
            "animation_type": "function_graph",
            "shots": [
                {
                    "id": 1,
                    "title": "单位圆与角度",
                    "narration": "先画单位圆解释角度。",
                    "visual": "单位圆和角度射线",
                    "animation": "Create unit circle",
                },
                {
                    "id": 2,
                    "title": "映射到坐标平面",
                    "narration": "把单位圆映射到函数曲线。",
                    "visual": "单位圆和坐标系",
                    "animation": "Transform",
                },
            ],
        })
        ai = _FakeAI([json.dumps(noisy_spec, ensure_ascii=False)])

        result = asyncio.run(design_storyboard(brief, ai_client=ai, model_name="fake-model"))
        spec = result["storyboardSpec"]
        text = json.dumps(spec, ensure_ascii=False)

        self.assertEqual(result["status"], "success")
        self.assertIn("绘制函数曲线", [shot["title"] for shot in spec["shots"]])
        self.assertNotIn("单位圆与角度", text)
        self.assertIn("简单正弦/余弦图像不要加入单位圆", text)

    def test_director_keeps_simple_shape_prompts_out_of_proof_mode(self):
        brief = plan_animation("画一个三角形")
        noisy_spec = json.loads(director_json())
        noisy_spec.update({
            "topic": "三角形内角和证明",
            "domain": "geometry",
            "animation_type": "triangle",
            "visual_objects": ["Triangle", "angle labels", "formula"],
            "shots": [
                {
                    "id": 1,
                    "title": "绘制三角形",
                    "narration": "画一个三角形。",
                    "visual": "Triangle",
                    "animation": "Create",
                },
                {
                    "id": 2,
                    "title": "推导内角和",
                    "narration": "展示 ∠A + ∠B + ∠C = 180°。",
                    "visual": "公式和角标",
                    "animation": "Write formula",
                },
            ],
        })
        ai = _FakeAI([json.dumps(noisy_spec, ensure_ascii=False)])

        result = asyncio.run(design_storyboard(brief, ai_client=ai, model_name="fake-model"))
        spec = result["storyboardSpec"]
        text = json.dumps(spec, ensure_ascii=False)

        self.assertEqual(result["status"], "success")
        self.assertEqual(spec["topic"], "画一个三角形")
        self.assertIn("简单图形请求只画主体和少量标签", text)
        self.assertNotIn("推导内角和", text)

    def test_director_normalizes_bar_chart_for_large_subject(self):
        brief = plan_animation("画一个三个月销量柱状图")
        noisy_spec = json.loads(director_json())
        noisy_spec.update({
            "topic": "销售数据",
            "domain": "data",
            "animation_type": "bar_chart",
            "visual_objects": ["axes", "tiny bars", "many labels"],
            "shots": [
                {"id": 1, "title": "准备数据", "narration": "整理数据。", "visual": "表格", "animation": "FadeIn"},
                {"id": 2, "title": "绘制图表", "narration": "画柱状图。", "visual": "柱状图", "animation": "Create"},
            ],
        })
        ai = _FakeAI([json.dumps(noisy_spec, ensure_ascii=False)])

        result = asyncio.run(design_storyboard(brief, ai_client=ai, model_name="fake-model"))
        spec = result["storyboardSpec"]
        text = json.dumps(spec, ensure_ascii=False)

        self.assertEqual(result["status"], "success")
        self.assertEqual(spec["topic"], "三个月销量柱状图")
        self.assertIn("三根大号柱子", spec["visual_objects"])
        self.assertIn("柱组应占视觉区宽度 65%-75%", text)

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
        self.assertEqual(generated["codeSource"], "llm_v6")
        self.assertEqual(renderable_scene_classes(generated["code"]), ["MainScene"])
        self.assertIn("Circle(", generated["code"])
        self.assertNotIn("_circle_template", generated["code"])

        payload = json.loads(ai.chat.completions.calls[0]["messages"][1]["content"])
        self.assertEqual(payload["rulePackVersion"], RULE_PACK_VERSION)
        self.assertIn("manimRules", payload)
        self.assertIn("scene_contract", payload["manimRules"])
        self.assertTrue(any("Adding" in item and "FadeIn" in item for item in payload["hardRequirements"]))

    def test_director_and_code_writer_prompts_include_reference_specs(self):
        brief = plan_animation("照这个做一个简单动画")
        brief["referenceSpecs"] = [{
            "referenceId": "ref-1",
            "status": "pass",
            "summary": "检测到 1 个画面中心的圆形主体，建议用干净的 Manim 图形重绘。",
            "subject": {"likelyShape": "circle", "position": "画面中心"},
            "visualConstraints": ["主体位于画面中心"],
        }]
        brief["referenceSummary"] = brief["referenceSpecs"][0]["summary"]
        brief["referenceSemanticTarget"] = "circle"
        director_payload = json.loads(build_director_messages(brief)[1]["content"])
        writer_payload = json.loads(build_code_writer_messages(brief, json.loads(director_json()), {}, [])[1]["content"])

        self.assertEqual(director_payload["referenceSpecs"][0]["referenceId"], "ref-1")
        self.assertIn("referencePolicy", director_payload)
        self.assertEqual(writer_payload["referenceSemanticTarget"], "circle")
        self.assertIn("referenceSpecs", writer_payload)
        self.assertTrue(any("Reference images are visual constraints" in item for item in writer_payload["hardRequirements"]))

    def test_skill_loader_selects_core_skills_without_old_versions(self):
        brief = plan_animation("画一个正弦函数，做分步骤讲解动画")
        skills = select_skills(brief)
        skill_ids = [skill["id"] for skill in skills]

        self.assertLessEqual(len(skills), 3)
        self.assertIn("function_graph", skill_ids)
        self.assertIn("text_formula_layout", skill_ids)
        self.assertTrue(all(skill["version"] == "v6" for skill in skills))

    def test_agent_skills_route_returns_safe_catalog_metadata(self):
        app = FastAPI()
        register_agent_routes(app)
        response = TestClient(app).get("/agent/skills")
        payload = response.json()
        direct_catalog = skill_catalog()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["success"])
        self.assertEqual(payload["version"], SKILL_CATALOG_VERSION)
        self.assertGreaterEqual(len(payload["skills"]), 6)
        ids = {skill["id"] for skill in payload["skills"]}
        self.assertIn("function_graph", ids)
        self.assertIn("geometry", ids)
        self.assertIn("text_formula_layout", ids)
        self.assertIn("function_graph", direct_catalog)
        for skill in payload["skills"]:
            self.assertNotIn("path", skill)
            self.assertIn(skill["source"], {"builtin", "project"})
            self.assertTrue(skill["name"])
            self.assertTrue(skill["guidance"])

    def test_scene_manifest_extracts_editable_objects_from_code(self):
        from app.agent.scene_manifest import build_scene_manifest

        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        title = Text("Square")
        square = Square(side_length=2, color=BLUE)
        label = MathTex("A=s^2")
        self.add(title, square, label)
"""
        brief = {
            "storyboardSpec": {
                "shots": [
                    {"id": "intro", "title": "Show square"},
                ],
            }
        }
        manifest = build_scene_manifest(code, brief)
        object_ids = {item["id"] for item in manifest["objects"]}

        self.assertEqual(manifest["version"], "scene-manifest-v2")
        self.assertIn("title", object_ids)
        self.assertIn("square", object_ids)
        self.assertIn("label", object_ids)
        square = next(item for item in manifest["objects"] if item["id"] == "square")
        self.assertEqual(square["type"], "Square")
        self.assertIn("move", square["editable"])
        self.assertIn("set_color", square["editable"])
        self.assertGreaterEqual(square["codeAnchor"]["startLine"], 1)

    def test_scene_manifest_ignores_helper_locals_and_chinese_labels_objects(self):
        from app.agent.scene_manifest import build_scene_manifest

        code = '''
from manim import *

def SafeText(content, font_size=28, color="#1D2530", **kwargs):
    text = Text(str(content), font_size=font_size, color=color, **kwargs)
    if text.width > 11.2:
        text.scale_to_fit_width(11.2)
    return text

class MainScene(SafeScene, Scene):
    def construct(self):
        title_mob = SafeText("余弦函数图像")
        axes = Axes(x_range=[0, 6.28, 1], y_range=[-1, 1, 1])
        curve = axes.plot(lambda x: np.cos(x), color=BLUE)
        circle = Circle(radius=0.8, color=BLUE).shift(DOWN * 0.5)
        step_banner = SafeText("步骤 1：建立坐标系")
        self.add(title_mob, axes, curve, circle, step_banner)
'''
        manifest = build_scene_manifest(code, {"storyboardSpec": {"shots": [{"id": "s1", "title": "建立坐标系"}]}})
        ids = {item["id"] for item in manifest["objects"]}
        labels = {item["id"]: item.get("displayName") or item.get("label") for item in manifest["objects"]}

        self.assertNotIn("text", ids)
        self.assertIn("title_mob", ids)
        self.assertIn("axes", ids)
        self.assertIn("curve", ids)
        self.assertIn("circle", ids)
        self.assertIn("step_banner", ids)
        self.assertEqual(labels["title_mob"], "标题")
        self.assertEqual(labels["axes"], "坐标系")
        self.assertEqual(labels["curve"], "曲线")
        self.assertEqual(labels["step_banner"], "步骤说明")
        for item in manifest["objects"]:
            self.assertEqual(item.get("sourceScope"), "MainScene.construct")
            self.assertTrue(item.get("bbox"))

    def test_runtime_manifest_instrumentation_exports_scene_objects_only(self):
        from app.agent.scene_manifest import build_scene_manifest, instrument_code_for_runtime_manifest

        code = '''
from manim import *

def SafeText(content):
    text = Text(str(content))
    return text

class MainScene(SafeScene, Scene):
    def construct(self):
        title_mob = SafeText("标题")
        axes = Axes()
        self.add(title_mob, axes)
'''
        manifest = build_scene_manifest(code, {})
        instrumented = instrument_code_for_runtime_manifest(code, manifest, "D:/tmp/studio_manifest.json")

        self.assertIn("_icecream_studio_export", instrumented)
        self.assertIn('"title_mob": locals().get("title_mob")', instrumented)
        self.assertIn('"axes": locals().get("axes")', instrumented)
        self.assertNotIn('"text": locals().get("text")', instrumented)
        ast.parse(instrumented)

    def test_studio_frame_set_recommends_dense_middle_frame_over_empty_final_frame(self):
        from app.agent.studio_frames import build_studio_frame_set_from_candidates

        manifest = {
            "objects": [
                {"id": "title_mob", "bbox": {"x": 0.3, "y": 0.04, "width": 0.4, "height": 0.08}},
                {"id": "axes", "bbox": {"x": 0.18, "y": 0.28, "width": 0.64, "height": 0.48}},
                {"id": "curve", "bbox": {"x": 0.2, "y": 0.34, "width": 0.6, "height": 0.34}},
            ]
        }
        candidates = [
            {"frameId": "frame_00", "time": 0.8, "ratio": 0.08, "imageUrl": "/static/frame_00.png", "foregroundArea": 0.02},
            {"frameId": "frame_03", "time": 5.0, "ratio": 0.50, "imageUrl": "/static/frame_03.png", "foregroundArea": 0.16},
            {"frameId": "final", "time": 10.0, "ratio": 1.0, "imageUrl": "/static/final.png", "foregroundArea": 0.0},
        ]

        frame_set = build_studio_frame_set_from_candidates(candidates, manifest)

        self.assertEqual(frame_set["recommendedFrameId"], "frame_03")
        recommended = next(item for item in frame_set["frames"] if item["frameId"] == "frame_03")
        final = next(item for item in frame_set["frames"] if item["frameId"] == "final")
        self.assertTrue(recommended["isRecommended"])
        self.assertGreater(recommended["score"], final["score"])
        self.assertGreaterEqual(recommended["objectCount"], 3)
        self.assertIn("元素最多", recommended["reason"])

    def test_layout_rebuild_applies_normalized_bbox_to_scene_patch(self):
        from app.agent.scene_patcher import apply_layout_rebuild

        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        title_mob = Text("旧标题")
        self.add(title_mob)
"""
        layout_spec = {
            "baseFrameId": "frame_03",
            "baseTime": 5.0,
            "edits": [
                {
                    "operation": "move",
                    "objectId": "title_mob",
                    "sourceBBox": {"x": 0.30, "y": 0.05, "width": 0.40, "height": 0.08},
                    "normalizedBBox": {"x": 0.42, "y": 0.10, "width": 0.40, "height": 0.08},
                },
                {"operation": "replace_text", "objectId": "title_mob", "text": "新标题"},
            ],
        }

        result = apply_layout_rebuild(code, layout_spec)

        self.assertTrue(result["success"])
        self.assertIn('Text("新标题")', result["code"])
        self.assertIn("title_mob.shift", result["code"])
        self.assertEqual(result["layoutEditSpec"]["baseFrameId"], "frame_03")

    def test_scene_patch_replaces_text_and_rejects_unknown_operations(self):
        from app.agent.scene_patcher import apply_scene_patch

        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        title = Text("Old title")
        self.add(title)
"""
        patched = apply_scene_patch(code, {"operation": "replace_text", "objectId": "title", "text": "New title"})
        self.assertTrue(patched["success"])
        self.assertIn('Text("New title")', patched["code"])

        rejected = apply_scene_patch(code, {"operation": "run_shell", "objectId": "title"})
        self.assertFalse(rejected["success"])
        self.assertIn("不支持", rejected["warning"])

    def test_scene_patch_rejects_helper_local_object_ids(self):
        from app.agent.scene_patcher import apply_scene_patch

        code = '''
from manim import *

def SafeText(content, font_size=28, color="#1D2530", **kwargs):
    text = Text(str(content), font_size=font_size, color=color, **kwargs)
    return text

class MainScene(Scene):
    def construct(self):
        title_mob = SafeText("旧标题")
        self.add(title_mob)
'''
        rejected = apply_scene_patch(code, {"operation": "delete", "objectId": "text"})
        self.assertFalse(rejected["success"])
        self.assertIn("只能修改主场景", rejected["warning"])

        patched = apply_scene_patch(code, {"operation": "replace_text", "objectId": "title_mob", "text": "新标题"})
        self.assertTrue(patched["success"])
        self.assertIn('SafeText("新标题")', patched["code"])
        self.assertIn('text = Text(str(content)', patched["code"])

    def test_agent_patch_route_applies_safe_patch(self):
        app = FastAPI()
        register_agent_routes(app)
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        title = Text("Old title")
        self.add(title)
"""
        response = TestClient(app).post(
            "/agent/patch",
            json={"code": code, "patch": {"operation": "set_color", "objectId": "title", "color": "#0284C7"}},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertIn('title.set_color("#0284C7")', data["code"])

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

    def test_critic_rejects_legacy_api_and_black_background(self):
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        self.camera.background_color = BLACK
        old = TextMobject("old api")
        self.play(ShowCreation(old))
"""
        report = critique_code(code, {"intent": "CREATE"})
        codes = {issue.get("code") for issue in report["issues"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("legacy_api_forbidden", codes)
        self.assertIn("black_background", codes)

    def test_critic_rejects_hallucinated_animation_api_names(self):
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        self.play(Adding(Circle()))
        self.play(Drawing(Text("TCP")))
"""
        report = critique_code(code, {"intent": "CREATE"})
        codes = {issue.get("code") for issue in report["issues"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("hallucinated_animation_api", codes)

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

    def test_critic_flags_invalid_manim_constructor_keywords(self):
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        shape = VMobject(points=[ORIGIN, RIGHT])
        self.add(shape)
"""
        report = critique_code(code, {"intent": "CREATE"})
        codes = {issue.get("code") for issue in report["issues"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("invalid_mobject_keyword", codes)

    def test_critic_flags_raw_values_inside_vgroup(self):
        cases = [
            'group = VGroup([Text("a"), Text("b")])',
            'group = VGroup("a")',
        ]
        for body in cases:
            code = f"""
from manim import *

class MainScene(Scene):
    def construct(self):
        {body}
        self.add(group)
"""
            report = critique_code(code, {"intent": "CREATE"})
            codes = {issue.get("code") for issue in report["issues"]}

            self.assertEqual(report["status"], "error")
            self.assertIn("invalid_vgroup_child", codes)

    def test_critic_rejects_fragile_vgroup_index_lookup(self):
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        bars = VGroup(Rectangle(), Rectangle(), Rectangle())
        values = [120, 180, 240]
        for bar in bars:
            label = Text(str(values[bars.index(bar)]))
            self.add(bar, label)
"""
        report = critique_code(code, plan_animation("画一个三个月销量柱状图"))
        codes = {issue.get("code") for issue in report["issues"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("fragile_vgroup_index", codes)

    def test_critic_rejects_angle_with_coordinate_expressions(self):
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        square = Square()
        right_angle = Angle(
            square.get_corner(UR) + LEFT * 0.3,
            square.get_corner(UR) + DOWN * 0.3,
        )
        self.add(square, right_angle)
"""
        report = critique_code(code, {"intent": "CREATE", "target_objects": ["square"]})
        codes = {issue.get("code") for issue in report["issues"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("invalid_angle_arguments", codes)

    def test_critic_allows_angle_with_line_mobjects(self):
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        side_a = Line(ORIGIN, RIGHT)
        side_b = Line(ORIGIN, UP)
        right_angle = Angle(side_a, side_b)
        self.add(side_a, side_b, right_angle)
"""
        report = critique_code(code, {"intent": "CREATE"})
        codes = {issue.get("code") for issue in report["issues"]}

        self.assertNotIn("invalid_angle_arguments", codes)

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

    def test_square_prompt_requires_square_object_before_preview(self):
        brief = plan_animation("\u753b\u4e00\u4e2a\u6b63\u65b9\u5f62")
        wrong_code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        circle = Circle()
        self.add(circle)
        self.wait(1)
"""
        critic = critique_code(wrong_code, brief)
        quality = inspect_code_quality(wrong_code, brief)
        critic_codes = {item.get("code") for item in critic["issues"]}
        quality_codes = {item.get("code") for item in quality["findings"]}

        self.assertEqual(brief["animation_type"], "square")
        self.assertEqual(critic["status"], "error")
        self.assertEqual(quality["status"], "error")
        self.assertIn("semantic_square_missing", critic_codes)
        self.assertIn("semantic_square_missing", quality_codes)

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

    def test_inspector_allows_compact_flow_text_density(self):
        brief = plan_animation("解释 TCP 三次握手流程")
        text_lines = "\n".join(
            f"        label_{index} = Text('步骤{index}')\n        self.add(label_{index})"
            for index in range(24)
        )
        flow_code = f"""
from manim import *

class MainScene(Scene):
    def construct(self):
        client = Text("客户端")
        server = Text("服务器")
        arrow = Arrow(LEFT, RIGHT)
        self.add(client, server, arrow)
{text_lines}
        self.wait(1)
"""
        report = inspect_code_quality(flow_code, brief)
        codes = {item.get("code") for item in report["findings"]}

        self.assertNotIn("text_density", codes)

    def test_critic_allows_compact_flow_text_density(self):
        brief = plan_animation("解释 TCP 三次握手流程")
        text_lines = "\n".join(
            f"        label_{index} = Text('步骤{index}')\n        self.add(label_{index})"
            for index in range(24)
        )
        flow_code = f"""
from manim import *

class MainScene(Scene):
    def construct(self):
        client = Text("客户端")
        server = Text("服务器")
        arrow = Arrow(LEFT, RIGHT)
        self.add(client, server, arrow)
{text_lines}
        self.wait(1)
"""
        report = critique_code(flow_code, brief)
        codes = {item.get("code") for item in report["issues"]}

        self.assertNotIn("text_density", codes)

    def test_rescue_scene_satisfies_core_semantic_contracts(self):
        cases = [
            ("\u753b\u4e00\u4e2a\u4e09\u89d2\u5f62", "Polygon"),
            ("\u753b\u4e00\u4e2a\u6b63\u65b9\u5f62", "Square"),
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

    def test_visual_judge_flags_clipped_connectors_and_stage_residue(self):
        try:
            from PIL import Image, ImageDraw
        except Exception:
            self.skipTest("Pillow is unavailable")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            clipped = tmp_path / "clipped.png"
            residue = tmp_path / "residue.png"

            clipped_image = Image.new("RGB", (640, 360), (247, 251, 255))
            draw = ImageDraw.Draw(clipped_image)
            draw.line((410, 180, 639, 180), fill=(14, 165, 233), width=6)
            draw.polygon([(639, 180), (612, 164), (612, 196)], fill=(14, 165, 233))
            clipped_image.save(clipped)

            residue_image = Image.new("RGB", (640, 360), (247, 251, 255))
            draw = ImageDraw.Draw(residue_image)
            draw.rectangle((45, 42, 590, 315), fill=(222, 242, 252))
            draw.rectangle((260, 130, 380, 230), fill=(14, 165, 233))
            residue_image.save(residue)

            clipped_report = inspect_frame_quality([clipped])
            residue_report = inspect_frame_quality([residue])

        clipped_codes = {item.get("code") for item in clipped_report["findings"]}
        residue_codes = {item.get("code") for item in residue_report["findings"]}
        self.assertEqual(clipped_report["status"], "error")
        self.assertTrue({"object_clipped", "connector_offscreen"} & clipped_codes)
        self.assertIn("stage_residue", residue_codes)

    def test_static_inspector_flags_layout_and_offscreen_risks(self):
        risky_code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        a = Rectangle(width=3.5, height=2)
        b = Rectangle(width=3.5, height=2).next_to(a, RIGHT)
        c = Rectangle(width=3.5, height=2).next_to(b, RIGHT)
        arrow = Arrow(LEFT, RIGHT).shift(RIGHT * 6.2)
        self.add(a)
        self.add(b)
        self.add(c)
        self.add(arrow)
        self.add(Text("定义"))
        self.add(Text("推导"))
        self.add(Text("结论"))
"""
        report = inspect_code_quality(risky_code, {"message": "给出等差数列的推导过程"})
        codes = {item.get("code") for item in report["findings"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("connector_offscreen_risk", codes)
        self.assertIn("panel_overlap_risk", codes)
        self.assertIn("unsafe_next_to_chain", codes)
        self.assertIn("stage_cleanup_missing", codes)
        self.assertIn("derivation_layout_missing", codes)

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

    def test_visual_judge_catches_square_semantic_mismatch(self):
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        self.add(Circle())
        self.wait(1)
"""
        report = inspect_visual_quality(code, plan_animation("画一个正方形"), {})
        codes = {item.get("code") for item in report["findings"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("semantic_square_missing", codes)
        self.assertIn("semantic_square_mismatch", codes)

    def test_visual_judge_catches_reference_circle_mismatch(self):
        code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        self.add(Triangle())
        self.wait(1)
"""
        brief = {
            "message": "照这个做一个简单动画",
            "referenceSemanticTarget": "circle",
            "referenceSpecs": [{
                "referenceId": "ref-1",
                "status": "pass",
                "subject": {"likelyShape": "circle"},
            }],
        }
        report = inspect_visual_quality(code, brief, {})
        codes = {item.get("code") for item in report["findings"]}

        self.assertEqual(report["status"], "error")
        self.assertIn("reference_circle_missing", codes)

    def test_runtime_helpers_avoid_black_letterbox_and_inner_panel(self):
        self.assertIn('self.camera.background_color = "#F7FBFF"', SCENE_RUNTIME_CODE)
        self.assertIn("config.frame_width", SCENE_RUNTIME_CODE)
        self.assertIn("stroke_width=0", SCENE_RUNTIME_CODE)
        self.assertIn("set_z_index(-20)", SCENE_RUNTIME_CODE)

    def test_visual_judge_reports_failed_or_tiny_preview(self):
        premature_close = inspect_visual_quality("from manim import *\nself_wait = 'self.wait(1)'", {}, {
            "success": False,
            "error": "Error: Premature close",
            "details": "Error: Premature close",
            "errorType": "preview_transport_closed",
        })
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
        keyword_failed = inspect_visual_quality("from manim import *", {}, {
            "success": False,
            "error": "TypeError: Mobject.__getattr__.<locals>.setter() got an unexpected keyword argument 'aligned_edge'",
            "details": "TypeError: Mobject.__getattr__.<locals>.setter() got an unexpected keyword argument 'aligned_edge'",
            "errorType": "manim_render_failed",
        })
        vgroup_failed = inspect_visual_quality("from manim import *", {}, {
            "success": False,
            "error": "TypeError: Only values of type VMobject can be added as submobjects of VGroup",
            "details": "TypeError: Only values of type VMobject can be added as submobjects of VGroup",
            "errorType": "manim_render_failed",
        })
        tiny = inspect_visual_quality(
            "from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.wait(1)\n",
            {},
            {"success": True, "videoUrl": "/static/video.mp4", "videoBase64": "AAAA"},
        )

        self.assertEqual(premature_close["status"], "warning")
        premature_codes = {item.get("code") for item in premature_close["findings"]}
        self.assertIn("preview_infrastructure_warning", premature_codes)
        self.assertEqual(premature_close["metrics"]["failureClass"], "preview_infrastructure")
        self.assertNotIn("Premature close", premature_close["summary"])
        self.assertEqual(failed["status"], "error")
        self.assertIn("预览渲染失败", failed["summary"])
        self.assertIn("名称未定义", failed["summary"])
        self.assertEqual(attribute_failed["status"], "error")
        self.assertIn("MainScene.get_angle()", attribute_failed["summary"])
        self.assertNotIn("object has no attribute", attribute_failed["summary"])
        self.assertIn("Manim 不支持的参数", keyword_failed["summary"])
        self.assertNotIn("Mobject.__getattr__", keyword_failed["summary"])
        self.assertIn("VGroup 中混入", vgroup_failed["summary"])
        self.assertNotIn("Only values of type VMobject", vgroup_failed["summary"])
        self.assertEqual(tiny["status"], "error")

    def test_agent_route_payloads_are_json_safe(self):
        payload = {
            "success": np.bool_(True),
            "count": np.int64(3),
            "score": np.float32(9.5),
            "items": {np.int64(2), "ok"},
            "path": Path("static/video.mp4"),
            "nested": [{"flag": np.bool_(False)}],
        }
        safe = to_json_safe(payload)
        json.dumps(safe, ensure_ascii=False)

        self.assertIs(type(safe["success"]), bool)
        self.assertIs(type(safe["count"]), int)
        self.assertIs(type(safe["score"]), float)
        self.assertIs(type(safe["nested"][0]["flag"]), bool)
        self.assertEqual(safe["path"], "static/video.mp4")

    def test_visual_layout_bbox_is_json_serializable(self):
        from app.agent.visual_judge import _largest_component_box

        mask = np.zeros((12, 12), dtype=bool)
        mask[:4, :5] = True
        bbox = _largest_component_box(mask)
        json.dumps(bbox, ensure_ascii=False)

        self.assertIs(type(bbox["touchesSafeEdge"]), bool)
        self.assertIs(type(bbox["touchesHardEdge"]), bool)

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

    def test_repair_observation_includes_rule_pack_and_rule_hints(self):
        report = {
            "status": "error",
            "summary": "静态检查失败",
            "issues": [
                {"severity": "error", "message": "MathTex/Tex 中包含中文。", "hint": "中文放进 Text/SafeText。", "code": "mathtex_chinese"},
            ],
        }
        attempts = []

        def unchanged_fixer(code, observation):
            attempts.append(observation)
            return code

        repair_code(
            "from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.add(MathTex('中文'))\n",
            report,
            stderr="",
            max_attempts=1,
            fixer=unchanged_fixer,
            brief=plan_animation("画一个正方形"),
        )

        self.assertEqual(attempts[0]["rulePackVersion"], RULE_PACK_VERSION)
        self.assertEqual(attempts[0]["semanticTarget"], "square")
        self.assertEqual(attempts[0]["repairRules"][0]["id"], "mathtex_chinese")

    def test_repair_observation_includes_api_rule_ids_and_stderr_summary(self):
        report = {
            "status": "error",
            "summary": "静态检查失败",
            "issues": [
                {
                    "severity": "error",
                    "message": "生成代码调用了 Manim 不支持的参数。",
                    "hint": "移除不支持的参数。",
                    "code": "invalid_manim_keyword",
                },
            ],
        }
        observation = build_repair_observation(
            "from manim import *",
            report,
            stderr="TypeError: Mobject.__getattr__.<locals>.setter() got an unexpected keyword argument 'aligned_edge'",
            attempt=1,
        )

        self.assertIn("invalid_manim_keyword", observation["ruleIds"])
        self.assertIn("invalid_manim_keyword", [item["id"] for item in observation["repairRules"]])
        self.assertIn("unexpected keyword", observation["stderrSummary"])
        self.assertEqual(observation["failureCategory"], "Manim API 或参数调用错误")

    def test_repair_observation_includes_reference_alignment_context(self):
        brief = {
            "message": "照这个做一个简单动画",
            "referenceSummary": "检测到圆形主体。",
            "referenceSemanticTarget": "circle",
            "referenceSpecs": [{"referenceId": "ref-1", "subject": {"likelyShape": "circle"}}],
        }
        observation = build_repair_observation(
            "from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.add(Triangle())\n",
            {"status": "error", "findings": [{"message": "参考图显示圆形主体，但没有 Circle。", "code": "reference_circle_missing"}]},
            brief=brief,
        )

        self.assertEqual(observation["referenceSemanticTarget"], "circle")
        self.assertEqual(observation["referenceSpecs"][0]["referenceId"], "ref-1")
        self.assertIn("reference_circle_missing", [item["id"] for item in observation["repairRules"]])

    def test_repair_observation_includes_layout_visual_rule_ids(self):
        observation = build_repair_observation(
            "from manim import *\n",
            {
                "status": "error",
                "summary": "视觉检查失败。",
                "findings": [
                    {
                        "severity": "error",
                        "message": "检测到长线段或箭头延伸到画面边缘。",
                        "hint": "重算箭头端点。",
                        "code": "connector_offscreen",
                    }
                ],
            },
            brief={"message": "给出等差数列的推导过程"},
        )

        self.assertIn("connector_offscreen", [item["id"] for item in observation["repairRules"]])
        self.assertIn("检测到长线段", observation["root_cause_hint"])

    def test_repair_attempt_config_defaults_to_four_and_clamps(self):
        with patch.dict(os.environ, {"MANIM_AGENT_REPAIR_ATTEMPTS": ""}, clear=False):
            self.assertEqual(service_config.get_manim_agent_repair_attempts(), 4)
        with patch.dict(os.environ, {"MANIM_AGENT_REPAIR_ATTEMPTS": "5"}, clear=False):
            self.assertEqual(service_config.get_manim_agent_repair_attempts(), 5)
        with patch.dict(os.environ, {"MANIM_AGENT_REPAIR_ATTEMPTS": "99"}, clear=False):
            self.assertEqual(service_config.get_manim_agent_repair_attempts(), 6)
        with patch.dict(os.environ, {"MANIM_AGENT_REPAIR_ATTEMPTS": "not-a-number"}, clear=False):
            self.assertEqual(service_config.get_manim_agent_repair_attempts(), 4)

    def test_static_guard_catches_python_compile_errors_without_local_paths(self):
        bad_code = "from manim import *\n\nclass MainScene(Scene):\n    def construct(self):\n        self.add(\n"
        report = run_static_guard(bad_code, plan_animation("画一个圆形"))

        self.assertEqual(report["status"], "error")
        self.assertEqual(report["issues"][0]["code"], "py_compile_error")
        self.assertIn("Python 编译失败", report["issues"][0]["message"])
        self.assertNotIn(str(SERVICE_ROOT), report["issues"][0].get("details", ""))
        self.assertEqual(report["rulePackVersion"], RULE_PACK_VERSION)

    def test_static_guard_passes_valid_scene_code(self):
        report = run_static_guard(circle_scene_code(), plan_animation("画一个圆形"))

        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["issues"], [])
        self.assertEqual(report["metrics"]["compiler"], "py_compile")

    def test_failure_event_log_records_sanitized_regression_sample(self):
        with tempfile.TemporaryDirectory() as tmp:
            log_path = Path(tmp) / "failures.jsonl"
            result = {
                "rendered": False,
                "warning": r"失败：D:\secret\project\scene.py token=sk-testsecret",
                "agentTrace": {
                    "rulePackVersion": RULE_PACK_VERSION,
                    "semanticTarget": "circle",
                    "failureReason": r"D:\secret\project\scene.py",
                    "quality": {"status": "error", "summary": "静态检查失败"},
                    "repairs": {"count": 2, "rules": ["py_compile_error"]},
                },
            }
            with patch.dict(os.environ, {"MANIM_AGENT_FAILURE_LOG": str(log_path), "MANIM_AGENT_FAILURE_LOG_ENABLED": "true"}, clear=False):
                event_id = record_failure_event(result, code="from manim import *\n")

            payload = json.loads(log_path.read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(payload["id"], event_id)
            self.assertEqual(payload["semanticTarget"], "circle")
            self.assertEqual(payload["repairRules"], ["py_compile_error"])
            self.assertNotIn("D:\\secret", json.dumps(payload, ensure_ascii=False))
            self.assertNotIn("sk-testsecret", json.dumps(payload, ensure_ascii=False))

    def test_failure_replay_evaluates_logged_samples_without_rendering(self):
        with tempfile.TemporaryDirectory() as tmp:
            log_path = Path(tmp) / "failures.jsonl"
            samples = [
                {
                    "id": "syntax",
                    "semanticTarget": "circle",
                    "repairRules": ["py_compile_error"],
                    "codeSnippet": "from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.add(\n",
                },
                {
                    "id": "circle-mismatch",
                    "semanticTarget": "circle",
                    "repairRules": ["semantic_circle_missing"],
                    "codeSnippet": "from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.add(Triangle())\n",
                },
            ]
            log_path.write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in samples), encoding="utf-8")

            report = replay_failure_events(path=log_path)

            self.assertEqual(report["total"], 2)
            self.assertEqual(report["caught"], 2)
            self.assertEqual(report["missed"], 0)
            self.assertTrue(all(sample["caught"] for sample in report["samples"]))

    def test_smoke_suite_has_six_prompts_and_checks_semantic_markers(self):
        self.assertEqual([case["id"] for case in SMOKE_CASES], [
            "circle",
            "square",
            "triangle",
            "sine",
            "bar-chart",
            "tcp-flow",
        ])
        result = {
            "rendered": True,
            "videoUrl": "/static/fake.mp4",
            "code": "from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.add(Triangle())\n",
        }

        report = evaluate_smoke_result(SMOKE_CASES[0], result)

        self.assertFalse(report["passed"])
        self.assertIn("Circle(", report["missingMarkers"])
        self.assertEqual(report["semanticTarget"], "circle")

        triangle_result = {
            "rendered": True,
            "videoUrl": "/static/fake.mp4",
            "code": "from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.add(Polygon(LEFT, RIGHT, UP))\n",
        }
        triangle_report = evaluate_smoke_result(SMOKE_CASES[2], triangle_result)
        self.assertTrue(triangle_report["passed"])
        self.assertIn("qualityScore", triangle_report)
        self.assertIn("qualityGrade", triangle_report)

    def test_smoke_quality_score_tracks_visual_metrics_and_repairs(self):
        good_result = {
            "rendered": True,
            "videoUrl": "/static/fake.mp4",
            "code": "from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.add(Circle())\n        self.wait(1)\n",
            "agentTrace": {
                "repairs": {"count": 0},
                "quality": {
                    "visual": {
                        "status": "pass",
                        "metrics": {
                            "artifactSize": 120_000,
                            "frame": {
                                "nonBackgroundRatio": 0.12,
                                "contrast": 16.0,
                                "darkEdgeRatio": 0.01,
                                "edgeContentRatio": 0.04,
                            },
                        },
                    }
                },
            },
        }

        good_report = evaluate_smoke_result(SMOKE_CASES[0], good_result)

        self.assertTrue(good_report["qualityPassed"])
        self.assertTrue(good_report["strictQualityPassed"])
        self.assertGreaterEqual(good_report["qualityScore"], 90)

        weak_result = {
            **good_result,
            "agentTrace": {
                "repairs": {"count": 5},
                "quality": {
                    "visual": {
                        "status": "warning",
                        "metrics": {
                            "artifactSize": 12_000,
                            "frame": {
                                "nonBackgroundRatio": 0.012,
                                "contrast": 6.5,
                                "darkEdgeRatio": 0.22,
                                "edgeContentRatio": 0.24,
                            },
                        },
                    }
                },
            },
        }

        weak_report = evaluate_smoke_result(SMOKE_CASES[0], weak_result)

        self.assertFalse(weak_report["qualityPassed"])
        self.assertFalse(weak_report["strictQualityPassed"])
        self.assertLess(weak_report["qualityScore"], 72)
        self.assertIn("自动修复次数偏多：5", weak_report["qualityFindings"])
        self.assertIn("质量分低于严格门槛 95", weak_report["strictQualityFindings"])

        rescue_result = {
            **good_result,
            "agentTrace": {
                **good_result["agentTrace"],
                "codeSource": "rescue",
            },
        }
        rescue_report = evaluate_smoke_result(SMOKE_CASES[0], rescue_result)

        self.assertIn("使用了质量兜底场景", rescue_report["qualityFindings"])
        self.assertFalse(rescue_report["strictQualityPassed"])
        self.assertIn("使用了质量兜底场景", rescue_report["strictQualityFindings"])
        self.assertEqual(rescue_report["qualityMetrics"]["codeSource"], "rescue")

        repair_heavy_result = {
            **good_result,
            "agentTrace": {
                **good_result["agentTrace"],
                "repairs": {"count": 2},
            },
        }
        repair_heavy_report = evaluate_smoke_result(SMOKE_CASES[0], repair_heavy_result)

        self.assertTrue(repair_heavy_report["qualityPassed"])
        self.assertFalse(repair_heavy_report["strictQualityPassed"])
        self.assertIn("自动修复次数超过严格门槛 1", repair_heavy_report["strictQualityFindings"])

    def test_real_smoke_summary_counts_code_sources(self):
        async def fake_run_agent(payload, **kwargs):
            del kwargs
            code = "Circle()" if "circle" in payload["clientId"] else "Square()"
            source = "rescue" if "square" in payload["clientId"] else "llm_v6"
            return {
                "rendered": True,
                "videoUrl": "/static/fake.mp4",
                "code": f"from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.add({code})\n        self.wait(1)\n",
                "agentTrace": {
                    "codeSource": source,
                    "repairs": {"count": 0},
                    "rulePackVersion": RULE_PACK_VERSION,
                    "quality": {
                        "visual": {
                            "status": "pass",
                            "metrics": {
                                "artifactSize": 120_000,
                                "frame": {
                                    "nonBackgroundRatio": 0.12,
                                    "contrast": 16.0,
                                    "darkEdgeRatio": 0.01,
                                    "edgeContentRatio": 0.04,
                                },
                            },
                        }
                    },
                },
            }

        async def collect():
            with patch("app.agent.real_smoke.run_agent", fake_run_agent):
                return await run_real_smoke_suite(
                    ai_client=object(),
                    model_name="fake-model",
                    render=True,
                    case_ids={"circle", "square"},
                )

        report = asyncio.run(collect())

        self.assertEqual(report["codeSourceCounts"], {"llm_v6": 1, "rescue": 1})
        self.assertEqual(report["rescueCount"], 1)
        self.assertEqual(report["strictQualityPassed"], 1)
        self.assertEqual(report["strictQualityFailed"], 1)

    def test_patch_first_repair_converts_mathtex_chinese(self):
        code = """
from manim import *

class MainScene(SafeScene, Scene):
    def construct(self):
        self.add(Square(), MathTex("面积等于边长平方"))
"""
        patched = patch_first_repair(code, critique_code(code, plan_animation("画一个正方形")))

        self.assertIn("SafeText(\"面积等于边长平方\")", patched["code"])
        self.assertIn("mathtex_chinese_to_safetext", [item["id"] for item in patched["patches"]])

    def test_async_repair_uses_patch_first_before_llm(self):
        code = """
from manim import *

class MainScene(SafeScene, Scene):
    def construct(self):
        self.add(Square(), MathTex("面积等于边长平方"))
"""
        ai = _FakeAI(["```python\nraise RuntimeError('should not be used')\n```"])

        result = asyncio.run(repair_code_async(
            code,
            critique_code(code, plan_animation("画一个正方形")),
            max_attempts=4,
            brief=plan_animation("画一个正方形"),
            ai_client=ai,
            model_name="fake-model",
        ))

        self.assertEqual(result["status"], "success")
        self.assertEqual(len(ai.chat.completions.calls), 0)
        self.assertIn("确定性补丁", result["summary"])

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

    def test_agent_stream_emits_v6_job_design_style_visual_trace_without_render(self):
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

        for event_type in ("job", "plan", "design", "storyboard", "style", "skill_activation", "skills", "code", "static_guard", "critic_report", "inspect", "quality_report", "preview", "result"):
            self.assertIn(event_type, event_types)
        self.assertIn("code_delta", event_types)
        self.assertLess(event_types.index("code_delta"), event_types.index("code"))
        self.assertLess(event_types.index("static_guard"), event_types.index("critic_report"))
        self.assertTrue(any(call.get("stream") is True for call in calls))
        self.assertEqual(final["type"], "result")
        self.assertEqual(final["agentTrace"]["template"], "none")
        self.assertEqual(final["agentTrace"]["codeSource"], "llm_v6")
        self.assertEqual(final["agentTrace"]["storyboardSpec"]["version"], "v6")
        self.assertIn("promptPackVersion", final["agentTrace"])
        self.assertEqual(final["agentTrace"]["promptPackVersion"], PROMPT_PACK_VERSION)
        self.assertEqual(final["agentTrace"]["preview"]["status"], "skipped")

    def test_agent_stream_stops_at_static_guard_when_code_cannot_compile(self):
        bad_code = "from manim import *\n\nclass MainScene(Scene):\n    def construct(self):\n        self.add(\n"

        async def fake_repair(code, brief, report, repair_attempts, **kwargs):
            return code, report, repair_attempts + 1, {
                "status": "error",
                "summary": "still broken",
                "attempts": 1,
            }

        async def fake_rescue(brief, reason):
            return "", {"status": "error", "issues": [], "summary": reason}, {"status": "error", "findings": [], "summary": reason}

        async def collect():
            events = []
            ai = _FakeAI([director_json(), f"```python\n{bad_code}\n```"])
            with patch("app.agent.workflow._repair_from_report", fake_repair), patch(
                "app.agent.workflow._emit_rescue_code",
                fake_rescue,
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
        event_types = [event["type"] for event in events]

        self.assertIn("static_guard", event_types)
        self.assertNotIn("visual_check", event_types)
        self.assertEqual(events[-1]["type"], "result")
        self.assertFalse(events[-1]["rendered"])
        self.assertIn("Python 静态守卫", events[-1]["warning"])
        self.assertEqual(events[-1]["agentTrace"]["quality"]["static"]["issues"][0]["code"], "py_compile_error")

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

        original_cache = os.environ.get("MANIM_AGENT_RENDER_CACHE")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["MANIM_AGENT_RENDER_CACHE"] = str(Path(temp_dir) / "render-cache.json")
            events = asyncio.run(collect())
        if original_cache is None:
            os.environ.pop("MANIM_AGENT_RENDER_CACHE", None)
        else:
            os.environ["MANIM_AGENT_RENDER_CACHE"] = original_cache
        final = events[-1]

        self.assertTrue(any(event["type"] == "visual_check" for event in events))
        self.assertTrue(captured_stderr)
        self.assertIn("NameError", captured_stderr[0])
        self.assertEqual(render_calls[0][1], "preview_render")
        self.assertEqual(final["agentTrace"]["codeSource"], "repair")
        self.assertEqual(render_calls[-1][1], "final_render")

    def test_agent_stream_retries_preview_transport_warning_without_repair(self):
        render_calls = []
        repair_called = False

        async def fake_render(code, client_id="agent", stage="render"):
            render_calls.append(stage)
            if stage == "preview_render":
                return {
                    "success": False,
                    "error": "Premature close",
                    "details": "Premature close",
                    "errorType": "preview_transport_closed",
                }
            return {"success": True, "videoUrl": "/static/final.mp4", "videoBase64": ""}

        def fake_visual(code, brief=None, render_result=None):
            if not (render_result or {}).get("success"):
                return {
                    "status": "warning",
                    "summary": "预览通道提前关闭，正在重试或转入最终渲染复检。",
                    "findings": [{
                        "severity": "warning",
                        "message": "预览通道提前关闭。",
                        "hint": "重试预览或改用最终渲染复检。",
                        "code": "preview_infrastructure_warning",
                    }],
                    "metrics": {"failureClass": "preview_infrastructure"},
                }
            return {"status": "pass", "summary": "视觉检查通过。", "findings": [], "metrics": {}}

        async def fake_repair(*args, **kwargs):
            nonlocal repair_called
            repair_called = True
            raise AssertionError("preview transport warnings should not trigger code repair")

        async def collect():
            events = []
            ai = _FakeAI([director_json(), f"```python\n{circle_scene_code()}\n```"])
            with patch("app.agent.workflow.render_code_for_agent", fake_render), patch(
                "app.agent.workflow.inspect_visual_quality", fake_visual
            ), patch("app.agent.workflow._repair_from_report", fake_repair):
                async for event in stream_agent_events(
                    {"message": "画一个圆形", "mode": "create"},
                    ai_client=ai,
                    model_name="fake-model",
                    render=True,
                ):
                    events.append(event)
            return events

        original_cache = os.environ.get("MANIM_AGENT_RENDER_CACHE")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["MANIM_AGENT_RENDER_CACHE"] = str(Path(temp_dir) / "render-cache.json")
            events = asyncio.run(collect())
        if original_cache is None:
            os.environ.pop("MANIM_AGENT_RENDER_CACHE", None)
        else:
            os.environ["MANIM_AGENT_RENDER_CACHE"] = original_cache

        self.assertFalse(repair_called)
        self.assertEqual(render_calls.count("preview_render"), 2)
        self.assertEqual(render_calls[-1], "final_render")
        self.assertEqual(events[-1]["type"], "result")
        self.assertTrue(events[-1]["rendered"])
        self.assertIn("preview_infrastructure_warning", [
            item.get("code")
            for event in events
            if event.get("type") == "visual_check"
            for item in event.get("visual", {}).get("findings", [])
        ])

    def test_agent_stream_emits_final_visual_check_before_failed_result(self):
        render_calls = []

        async def fake_render(code, client_id="agent", stage="render"):
            render_calls.append(stage)
            return {"success": True, "videoUrl": f"/static/{stage}.mp4", "videoBase64": ""}

        def fake_visual(code, brief=None, render_result=None):
            video_url = (render_result or {}).get("videoUrl", "")
            if "final_render" in video_url:
                return {
                    "status": "error",
                    "summary": "检测到可见对象贴到画面边缘，可能已经出框或被裁切。",
                    "findings": [{
                        "severity": "error",
                        "message": "检测到可见对象贴到画面边缘，可能已经出框或被裁切。",
                        "hint": "把对象放回安全边距内。",
                        "code": "object_clipped",
                    }],
                    "metrics": {"failureClass": "visual_quality"},
                }
            return {"status": "pass", "summary": "视觉检查通过。", "findings": [], "metrics": {}}

        async def collect():
            events = []
            ai = _FakeAI([director_json(), f"```python\n{circle_scene_code()}\n```"])
            with patch("app.agent.workflow.render_code_for_agent", fake_render), patch(
                "app.agent.workflow.inspect_visual_quality", fake_visual
            ):
                async for event in stream_agent_events(
                    {"message": "画一个圆形", "mode": "create"},
                    ai_client=ai,
                    model_name="fake-model",
                    render=True,
                ):
                    events.append(event)
            return events

        original_cache = os.environ.get("MANIM_AGENT_RENDER_CACHE")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["MANIM_AGENT_RENDER_CACHE"] = str(Path(temp_dir) / "render-cache.json")
            events = asyncio.run(collect())
        if original_cache is None:
            os.environ.pop("MANIM_AGENT_RENDER_CACHE", None)
        else:
            os.environ["MANIM_AGENT_RENDER_CACHE"] = original_cache

        final_checks = [
            event for event in events
            if event.get("type") == "visual_check" and event.get("stage") == "final_visual_check"
        ]
        self.assertTrue(final_checks)
        self.assertEqual(final_checks[-1]["visual"]["status"], "error")
        self.assertEqual(events[-1]["type"], "result")
        self.assertFalse(events[-1]["rendered"])
        self.assertIn("object_clipped", [
            item.get("code")
            for item in events[-1]["agentTrace"]["quality"]["visual"]["findings"]
        ])

    def test_agent_stream_repairs_high_risk_layout_warnings_before_preview(self):
        repair_reports = []
        risky_code = """
from manim import *

class MainScene(Scene):
    def construct(self):
        title = Text("客户端")
        formula = Text("服务端").next_to(title, RIGHT)
        self.add(title, formula)
        self.wait(1)
"""

        async def fake_repair(code, brief, report, repair_attempts, **kwargs):
            repair_reports.append(report)
            return code, {"status": "pass", "summary": "ok", "issues": []}, repair_attempts + 1, {
                "status": "success",
                "summary": "ok",
                "attempts": 1,
            }

        async def collect():
            events = []
            ai = _FakeAI([director_json(), f"```python\n{risky_code}\n```"])
            with patch("app.agent.workflow._repair_from_report", fake_repair):
                async for event in stream_agent_events(
                    {"message": "解释 TCP 三次握手流程", "mode": "create"},
                    ai_client=ai,
                    model_name="fake-model",
                    render=False,
                ):
                    events.append(event)
            return events

        events = asyncio.run(collect())

        self.assertTrue(repair_reports)
        repaired_codes = {
            item.get("code")
            for report in repair_reports
            for item in report.get("issues", [])
        }
        self.assertIn("unsafe_next_to_chain", repaired_codes)
        self.assertTrue(any(event.get("type") == "repair" for event in events))

    def test_v6_disabled_returns_warning_without_template_fallback(self):
        original = os.environ.get("MANIM_AGENT_V6_ENABLED")
        os.environ["MANIM_AGENT_V6_ENABLED"] = "false"
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
                os.environ.pop("MANIM_AGENT_V6_ENABLED", None)
            else:
                os.environ["MANIM_AGENT_V6_ENABLED"] = original

        self.assertEqual(events[-1]["type"], "result")
        self.assertFalse(events[-1]["rendered"])
        self.assertEqual(events[-1]["code"], "")
        self.assertEqual(events[-1]["agentTrace"]["template"], "none")
        self.assertIn("Manim Agent v6", events[-1]["warning"])


if __name__ == "__main__":
    unittest.main()
