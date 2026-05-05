import importlib


def validate_code_completeness(code: str):
    legacy_main = importlib.import_module("app.legacy_main")
    return legacy_main.validate_code_completeness(code)


def validate_code_security(code: str):
    legacy_main = importlib.import_module("app.legacy_main")
    return legacy_main.validate_code_security(code)
