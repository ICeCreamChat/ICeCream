"""Route ownership map for the package-based Manim service.

The live FastAPI routes are currently mounted by the legacy app object imported
in ``app.main``. New route implementations should be added here first, then
registered from a future ``create_app`` factory.
"""

ROUTES = {
    "render": "/render",
    "suggestions": "/api/suggestions",
    "health": "/health",
    "websocket_chat": "/ws/chat",
    "agent_run": "/agent/run",
    "agent_stream": "/agent/stream",
}
