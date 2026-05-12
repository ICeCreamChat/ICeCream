"""FastAPI routes for the runtime Manim agent."""

from __future__ import annotations

import json
from typing import Optional

from fastapi import Header
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .workflow import run_agent, stream_agent_events


class AgentRequest(BaseModel):
    message: str = Field(default="", max_length=8000)
    mode: str = Field(default="create")
    currentCode: str = Field(default="", max_length=60000)
    clientId: str = Field(default="agent", max_length=80)


def register_agent_routes(app, *, ai_client=None, model_name: str | None = None, service_token: str = "") -> None:
    """Register /agent routes on the existing FastAPI app."""

    def _forbidden(token: Optional[str]) -> bool:
        return bool(service_token) and token != service_token

    @app.post("/agent/run")
    async def agent_run(
        request: AgentRequest,
        x_manim_service_token: Optional[str] = Header(default=None, alias="X-Manim-Service-Token"),
    ):
        if _forbidden(x_manim_service_token):
            return JSONResponse({"success": False, "error": "Forbidden"}, status_code=403)
        result = await run_agent(
            request.model_dump(),
            ai_client=ai_client,
            model_name=model_name,
            render=True,
        )
        return JSONResponse(result)

    @app.post("/agent/stream")
    async def agent_stream(
        request: AgentRequest,
        x_manim_service_token: Optional[str] = Header(default=None, alias="X-Manim-Service-Token"),
    ):
        if _forbidden(x_manim_service_token):
            return JSONResponse({"success": False, "error": "Forbidden"}, status_code=403)

        async def events():
            async for event in stream_agent_events(
                request.model_dump(),
                ai_client=ai_client,
                model_name=model_name,
                render=True,
            ):
                yield json.dumps(event, ensure_ascii=False) + "\n"

        return StreamingResponse(events(), media_type="application/x-ndjson; charset=utf-8")

