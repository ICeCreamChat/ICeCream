import importlib


def load_cache():
    return importlib.import_module("app.legacy_main").load_cache()


def get_cached_video(prompt, current_code=""):
    return importlib.import_module("app.legacy_main").get_cached_video(prompt, current_code)


def save_cache_entry(prompt, video_url, current_code=""):
    return importlib.import_module("app.legacy_main").save_cache_entry(prompt, video_url, current_code)
