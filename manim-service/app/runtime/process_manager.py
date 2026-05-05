import importlib


def get_render_process_manager_class():
    return importlib.import_module("app.legacy_main").RenderProcessManager


def run_manim_safe(cmd, client_id, timeout=None):
    legacy_main = importlib.import_module("app.legacy_main")
    if timeout is None:
        return legacy_main.run_manim_safe(cmd, client_id)
    return legacy_main.run_manim_safe(cmd, client_id, timeout)
