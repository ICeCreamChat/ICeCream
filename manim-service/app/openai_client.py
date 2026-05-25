"""OpenAI client construction for the Manim service.

The service is started from local developer shells, so it can inherit proxy
environment variables that were configured for browsers or other tooling. Some
Windows setups put raw IPv6 loopback entries such as ``::1`` in ``NO_PROXY``;
httpx treats that as an invalid port during client construction. Keep ambient
proxy state out of the default Manim client and allow an explicit proxy opt-in.
"""

from __future__ import annotations

import os
from typing import Optional

import httpx
from openai import AsyncOpenAI


def _env_truthy(name: str) -> bool:
    value = os.environ.get(name, "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def create_openai_http_client(timeout: float, *, proxy: Optional[str] = None) -> httpx.AsyncClient:
    """Create the httpx client used by AsyncOpenAI.

    By default this client uses ``trust_env=False`` so malformed system proxy
    variables cannot prevent the Manim FastAPI service from booting. Developers
    who really need a proxy can set ``MANIM_OPENAI_PROXY`` to a full URL, or set
    ``MANIM_OPENAI_TRUST_ENV=true`` to opt back into httpx environment parsing.
    """

    explicit_proxy = (proxy if proxy is not None else os.environ.get("MANIM_OPENAI_PROXY", "")).strip()
    trust_env = _env_truthy("MANIM_OPENAI_TRUST_ENV")
    options = {
        "timeout": timeout,
        "trust_env": trust_env,
    }
    if explicit_proxy:
        options["proxy"] = explicit_proxy
    return httpx.AsyncClient(**options)


def create_async_openai_client(*, api_key: str, base_url: str, timeout: float) -> AsyncOpenAI:
    """Create the OpenAI-compatible async client for DeepSeek requests."""

    return AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=timeout,
        http_client=create_openai_http_client(timeout),
    )
