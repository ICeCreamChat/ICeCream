"""Versioned prompt modules for the Manim agent.

The agent keeps large, stable guidance in prompt modules instead of scattering
hard requirements across every generation stage. This mirrors the ManimCat
pattern while staying local to the FastAPI service.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from app import service_config


PROMPT_PACK_VERSION = "manim-v6-prompt-pack"
API_INDEX_VERSION = "manim-community-0.20-curated-v1"

PROMPT_MODULES = {
    "shared_specification": "shared_specification.md",
    "api_index": "manim_api_index.md",
    "chinese_output": "chinese_output.md",
    "visual_quality": "visual_quality.md",
    "repair_rules": "repair_rules.md",
}


def _prompt_dir() -> Path:
    return Path(service_config.get_manim_prompt_dir())


@lru_cache(maxsize=16)
def load_prompt_module(name: str) -> str:
    """Load a named prompt module.

    Unknown modules return an empty string so callers can safely compose prompt
    packs in tests and in partially installed local environments.
    """
    filename = PROMPT_MODULES.get(name)
    if not filename:
        return ""
    path = _prompt_dir() / filename
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def prompt_pack_summary() -> dict[str, object]:
    """Return metadata used by traces and diagnostics."""
    modules = {
        name: bool(load_prompt_module(name))
        for name in PROMPT_MODULES
    }
    return {
        "promptPackVersion": PROMPT_PACK_VERSION,
        "apiIndexVersion": API_INDEX_VERSION,
        "modules": modules,
    }


def build_generation_prompt_pack() -> str:
    """Build the shared prompt section injected into code-writing stages."""
    sections = [
        f"Prompt pack: {PROMPT_PACK_VERSION}",
        f"Manim API index: {API_INDEX_VERSION}",
    ]
    for name in ("shared_specification", "api_index", "chinese_output", "visual_quality"):
        content = load_prompt_module(name)
        if content:
            sections.append(f"\n## {name}\n{content}")
    return "\n".join(sections).strip()


def build_repair_prompt_pack() -> str:
    """Build guidance for repair stages."""
    sections = [build_generation_prompt_pack()]
    repair = load_prompt_module("repair_rules")
    if repair:
        sections.append(f"\n## repair_rules\n{repair}")
    return "\n".join(section for section in sections if section).strip()
