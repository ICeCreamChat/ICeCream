"""Run the real Manim Agent smoke matrix.

Usage:
    manim-service\\.venv\\Scripts\\python.exe manim-service\\run_agent_smoke.py
    manim-service\\.venv\\Scripts\\python.exe manim-service\\run_agent_smoke.py --case circle --no-render
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from openai import AsyncOpenAI


SERVICE_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(SERVICE_ROOT))

from app import service_config  # noqa: E402
from app.agent.real_smoke import run_real_smoke_suite  # noqa: E402
from app.agent.smoke_suite import SMOKE_CASES  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run real Manim Agent smoke prompts.")
    parser.add_argument("--case", action="append", choices=[case["id"] for case in SMOKE_CASES], help="Run one case id; can be repeated.")
    parser.add_argument("--no-render", action="store_true", help="Skip preview/final rendering and only exercise generation checks.")
    parser.add_argument("--output", default="", help="Optional JSON output path.")
    parser.add_argument("--history", default="", help="Optional JSONL history path. Defaults to logs/manim-agent-smoke-history.jsonl.")
    parser.add_argument("--no-history", action="store_true", help="Do not append the run to the smoke history JSONL.")
    parser.add_argument("--strict-quality", action="store_true", help="Exit non-zero when any case misses the release-style strict quality gate.")
    return parser.parse_args()


async def main() -> int:
    args = parse_args()
    if not service_config.API_KEY:
        print("缺少 DEEPSEEK_API_KEY，无法运行真实 smoke。", file=sys.stderr)
        return 2

    client = AsyncOpenAI(api_key=service_config.API_KEY, base_url=service_config.BASE_URL)
    report = await run_real_smoke_suite(
        ai_client=client,
        model_name=service_config.MODEL_NAME,
        render=not args.no_render,
        case_ids=set(args.case or []),
    )
    payload = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "model": service_config.MODEL_NAME,
        "render": not args.no_render,
        **report,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    print(text)

    output = Path(args.output) if args.output else Path(service_config.PROJECT_ROOT) / "logs" / "manim-agent-smoke-latest.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text + "\n", encoding="utf-8")

    if not args.no_history:
        history = Path(args.history) if args.history else Path(service_config.PROJECT_ROOT) / "logs" / "manim-agent-smoke-history.jsonl"
        history.parent.mkdir(parents=True, exist_ok=True)
        with history.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")

    if report["failed"]:
        return 1
    if args.strict_quality and report.get("strictQualityFailed"):
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
