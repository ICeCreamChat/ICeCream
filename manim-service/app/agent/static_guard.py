"""Fast Python-level guard for generated Manim code."""

from __future__ import annotations

import py_compile
import tempfile
from pathlib import Path
from typing import Any

from .manim_knowledge import RULE_PACK_VERSION
from .renderer import sanitize_render_error


def _issue(severity: str, message: str, hint: str, code: str = "", details: str = "") -> dict[str, str]:
    issue = {"severity": severity, "message": message, "hint": hint}
    if code:
        issue["code"] = code
    if details:
        issue["details"] = details
    return issue


def _redact_temp_paths(text: str, tmp_dir: Path, file_path: Path) -> str:
    value = text.replace(str(file_path), "<生成代码>")
    value = value.replace(str(tmp_dir), "<临时目录>")
    return sanitize_render_error(value)


def run_static_guard(code: str, brief: dict[str, Any] | None = None) -> dict[str, Any]:
    """Compile generated code without importing or executing it.

    This catches syntax/indentation problems before critic, preview render, or
    Manim subprocess work. It intentionally avoids importing the scene module.
    """
    source = code or ""
    issues: list[dict[str, str]] = []

    if not source.strip():
        issues.append(_issue(
            "error",
            "生成代码为空。",
            "请重新生成完整 Manim Python 文件。",
            "empty_generated_code",
        ))
    else:
        with tempfile.TemporaryDirectory(prefix="manim_static_guard_") as tmp:
            tmp_dir = Path(tmp)
            scene_file = tmp_dir / "generated_scene.py"
            scene_file.write_text(source, encoding="utf-8")
            try:
                py_compile.compile(str(scene_file), doraise=True)
            except py_compile.PyCompileError as exc:
                details = _redact_temp_paths(exc.msg or str(exc), tmp_dir, scene_file)
                issues.append(_issue(
                    "error",
                    "Python 编译失败。",
                    f"先修复语法或缩进问题：{details}",
                    "py_compile_error",
                    details,
                ))

    status = "error" if any(issue["severity"] == "error" for issue in issues) else "pass"
    return {
        "status": status,
        "summary": "Python 静态守卫发现错误。" if status == "error" else "Python 静态守卫通过。",
        "issues": issues,
        "next_actions": [issue["hint"] for issue in issues],
        "briefIntent": (brief or {}).get("intent"),
        "rulePackVersion": RULE_PACK_VERSION,
        "metrics": {
            "compiler": "py_compile",
            "codeLength": len(source),
        },
    }
