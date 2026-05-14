"""Real streaming code generation for Manim Agent v6."""

from __future__ import annotations

from typing import Any, AsyncIterator

from .code_writer import (
    analyze_current_code,
    build_code_writer_messages,
    extract_code_from_text,
    extract_partial_code_from_text,
    iter_code_deltas,
)


def _response_content(response: Any) -> str:
    choices = getattr(response, "choices", []) or []
    if not choices:
        return ""
    choice = choices[0]
    message = getattr(choice, "message", None)
    if message is None and isinstance(choice, dict):
        message = choice.get("message")
    if isinstance(message, dict):
        return str(message.get("content") or "")
    return str(getattr(message, "content", "") or "")


def _stream_delta_content(chunk: Any) -> str:
    choices = getattr(chunk, "choices", []) or []
    if not choices:
        return ""
    choice = choices[0]
    delta = getattr(choice, "delta", None)
    if delta is None and isinstance(choice, dict):
        delta = choice.get("delta")
    if isinstance(delta, dict):
        return str(delta.get("content") or "")
    return str(getattr(delta, "content", "") or "")


async def stream_scene_code_events(
    brief: dict[str, Any],
    storyboard_spec: dict[str, Any],
    style_preset: dict[str, Any],
    skills: list[dict[str, str]],
    *,
    ai_client: Any | None,
    model_name: str | None,
    current_code: str = "",
) -> AsyncIterator[dict[str, Any]]:
    """Yield real LLM code deltas, then a final generated payload.

    The workflow consumes every ``code_delta`` as it arrives from the model.
    The terminal event has type ``generated`` and mirrors write_scene_code().
    """
    if ai_client is None or not model_name:
        yield {
            "type": "generated",
            "generated": {
                "status": "error",
                "summary": "Manim Agent v6 需要 AI 客户端后才能生成场景代码。",
                "code": "",
                "source": "unavailable",
                "codeSource": "none",
                "analysis": analyze_current_code(current_code) if current_code else {},
                "next_actions": ["请配置 DEEPSEEK_API_KEY 并重启 Manim 服务。"],
            },
        }
        return

    raw_text = ""
    emitted_len = 0
    index = 0
    try:
        response = await ai_client.chat.completions.create(
            model=model_name,
            messages=build_code_writer_messages(brief, storyboard_spec, style_preset, skills, current_code),
            temperature=0.05,
            stream=True,
        )

        if not hasattr(response, "__aiter__"):
            raw_text = _response_content(response)
            code = extract_code_from_text(raw_text)
            for delta in iter_code_deltas(code):
                delta["source"] = "llm_v6"
                yield delta
            yield {
                "type": "generated",
                "generated": {
                    "status": "success" if code else "error",
                    "summary": "场景代码生成完成。" if code else "模型没有返回可执行代码。",
                    "code": code,
                    "source": "llm_v6",
                    "codeSource": "llm_v6",
                    "analysis": analyze_current_code(current_code) if current_code else {},
                    "next_actions": ["Run static, semantic, and visual checks."],
                },
            }
            return

        async for chunk in response:
            delta_text = _stream_delta_content(chunk)
            if not delta_text:
                continue
            raw_text += delta_text
            partial_code = extract_partial_code_from_text(raw_text)
            if len(partial_code) <= emitted_len:
                continue
            yield {
                "type": "code_delta",
                "delta": partial_code[emitted_len:],
                "code": partial_code,
                "index": index,
                "done": False,
                "source": "llm_v6",
            }
            emitted_len = len(partial_code)
            index += 1

        code = extract_code_from_text(raw_text)
        if not code:
            raise ValueError("模型没有返回可执行代码。")
        if len(code) > emitted_len:
            yield {
                "type": "code_delta",
                "delta": code[emitted_len:],
                "code": code,
                "index": index,
                "done": True,
                "source": "llm_v6",
            }
        yield {
            "type": "generated",
            "generated": {
                "status": "success",
                "summary": "场景代码生成完成。",
                "code": code,
                "source": "llm_v6",
                "codeSource": "llm_v6",
                "analysis": analyze_current_code(current_code) if current_code else {},
                "next_actions": ["继续执行静态、语义和视觉检查。"],
            },
        }
    except Exception as exc:
        partial = extract_partial_code_from_text(raw_text)
        yield {
            "type": "generated",
            "generated": {
                "status": "error",
                "summary": f"场景代码生成失败：{exc}",
                "code": partial,
                "source": "llm_v6",
                "codeSource": "llm_v6",
                "analysis": analyze_current_code(current_code) if current_code else {},
                "next_actions": ["请重试生成，或减少动画复杂度。"],
            },
        }
