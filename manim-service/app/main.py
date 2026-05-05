"""FastAPI entrypoint for the package-based Manim service."""

import os

import uvicorn

from .legacy_main import app


def run() -> None:
    service_host = os.environ.get("MANIM_SERVICE_HOST", "127.0.0.1")
    service_port = int(os.environ.get("MANIM_SERVICE_PORT", "8001"))
    uvicorn.run("app.main:app", host=service_host, port=service_port, reload=False)


if __name__ == "__main__":
    run()
