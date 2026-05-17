"""FastAPI routes for the runtime Manim agent."""

from __future__ import annotations

import json
from typing import Optional

from fastapi import Header
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .failure_events import load_failure_events
from .failure_replay import replay_failure_events
from .json_safety import to_json_safe
from .job_registry import cancel_job, get_job, list_jobs
from .reference_store import save_reference_image
from .scene_manifest import build_scene_manifest
from .scene_patcher import apply_scene_patch
from .skill_loader import SKILL_CATALOG_VERSION, skill_catalog
from .workflow import run_agent, stream_agent_events


class AgentRequest(BaseModel):
    message: str = Field(default="", max_length=8000)
    mode: str = Field(default="create")
    currentCode: str = Field(default="", max_length=60000)
    clientId: str = Field(default="agent", max_length=80)
    skillIds: list[str] = Field(default_factory=list, max_length=12)
    referenceImageIds: list[str] = Field(default_factory=list, max_length=12)
    jobId: str = Field(default="", max_length=80)


class ReferenceImageRequest(BaseModel):
    filename: str = Field(default="reference.png", max_length=180)
    mimeType: str = Field(default="image/png", max_length=80)
    dataBase64: str = Field(default="", max_length=30_000_000)


class ScenePatchRequest(BaseModel):
    code: str = Field(default="", max_length=120000)
    patch: dict = Field(default_factory=dict)
    brief: dict = Field(default_factory=dict)


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
        return JSONResponse(to_json_safe(result))

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
                yield json.dumps(to_json_safe(event), ensure_ascii=False) + "\n"

        return StreamingResponse(events(), media_type="application/x-ndjson; charset=utf-8")

    @app.post("/agent/patch")
    async def agent_patch(
        request: ScenePatchRequest,
        x_manim_service_token: Optional[str] = Header(default=None, alias="X-Manim-Service-Token"),
    ):
        if _forbidden(x_manim_service_token):
            return JSONResponse({"success": False, "error": "Forbidden"}, status_code=403)
        result = apply_scene_patch(request.code, request.patch)
        if result.get("success"):
            scene_manifest = build_scene_manifest(str(result.get("code") or ""), request.brief)
            result["sceneManifest"] = scene_manifest
            result["runtimeSceneManifest"] = scene_manifest
        return JSONResponse(to_json_safe(result), status_code=200 if result.get("success") else 400)

    @app.get("/agent/jobs")
    async def agent_jobs(
        limit: int = 30,
        x_manim_service_token: Optional[str] = Header(default=None, alias="X-Manim-Service-Token"),
    ):
        if _forbidden(x_manim_service_token):
            return JSONResponse({"success": False, "error": "Forbidden"}, status_code=403)
        return JSONResponse(to_json_safe({"success": True, "jobs": list_jobs(limit)}))

    @app.get("/agent/jobs/{job_id}")
    async def agent_job(
        job_id: str,
        x_manim_service_token: Optional[str] = Header(default=None, alias="X-Manim-Service-Token"),
    ):
        if _forbidden(x_manim_service_token):
            return JSONResponse({"success": False, "error": "Forbidden"}, status_code=403)
        job = get_job(job_id)
        if not job:
            return JSONResponse({"success": False, "error": "未找到 Manim 任务"}, status_code=404)
        return JSONResponse(to_json_safe({"success": True, "job": job}))

    @app.post("/agent/jobs/{job_id}/cancel")
    async def agent_job_cancel(
        job_id: str,
        x_manim_service_token: Optional[str] = Header(default=None, alias="X-Manim-Service-Token"),
    ):
        if _forbidden(x_manim_service_token):
            return JSONResponse({"success": False, "error": "Forbidden"}, status_code=403)
        result = cancel_job(job_id)
        status = 200 if result.get("success") else 404
        return JSONResponse(to_json_safe(result), status_code=status)

    @app.get("/agent/failures")
    async def agent_failures(
        limit: int = 50,
        x_manim_service_token: Optional[str] = Header(default=None, alias="X-Manim-Service-Token"),
    ):
        if _forbidden(x_manim_service_token):
            return JSONResponse({"success": False, "error": "Forbidden"}, status_code=403)
        return JSONResponse(to_json_safe({"success": True, "failures": load_failure_events(limit=limit)}))

    @app.post("/agent/failures/{event_id}/replay")
    async def agent_failure_replay(
        event_id: str,
        x_manim_service_token: Optional[str] = Header(default=None, alias="X-Manim-Service-Token"),
    ):
        if _forbidden(x_manim_service_token):
            return JSONResponse({"success": False, "error": "Forbidden"}, status_code=403)
        replay = replay_failure_events(limit=200)
        samples = replay.get("samples", [])
        replay["samples"] = [sample for sample in samples if sample.get("id") == event_id] or samples
        return JSONResponse(to_json_safe({"success": True, "replay": replay}))

    @app.post("/agent/reference-images")
    async def agent_reference_images(
        request: ReferenceImageRequest,
        x_manim_service_token: Optional[str] = Header(default=None, alias="X-Manim-Service-Token"),
    ):
        if _forbidden(x_manim_service_token):
            return JSONResponse({"success": False, "error": "Forbidden"}, status_code=403)
        result = save_reference_image(
            filename=request.filename,
            mime_type=request.mimeType,
            data_base64=request.dataBase64,
        )
        return JSONResponse(to_json_safe(result), status_code=200 if result.get("success") else 400)

    @app.get("/agent/skills")
    async def agent_skills(
        x_manim_service_token: Optional[str] = Header(default=None, alias="X-Manim-Service-Token"),
    ):
        if _forbidden(x_manim_service_token):
            return JSONResponse({"success": False, "error": "Forbidden"}, status_code=403)

        skills = []
        for skill in skill_catalog().values():
            version = str(skill.get("version") or "")
            skills.append(
                {
                    "id": str(skill.get("id") or "")[:80],
                    "name": str(skill.get("name") or "")[:80],
                    "guidance": str(skill.get("guidance") or "")[:1200],
                    "version": version[:40],
                    "source": "project" if version == "project" else "builtin",
                }
            )
        skills.sort(key=lambda item: item["id"])
        return JSONResponse(
            to_json_safe({
                "success": True,
                "version": SKILL_CATALOG_VERSION,
                "skills": skills,
            })
        )
