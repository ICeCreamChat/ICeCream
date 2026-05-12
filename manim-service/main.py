"""Compatibility entrypoint for the Manim service.

The runnable ASGI app lives in ``app.main``. Keeping this thin wrapper lets
existing dev scripts continue to call ``python main.py`` without maintaining a
second copy of the service.
"""

from app.main import app, run


if __name__ == "__main__":
    run()
