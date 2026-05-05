import importlib


def get_context_manager():
    return importlib.import_module("app.legacy_main").context_manager
