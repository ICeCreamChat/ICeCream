import importlib


async def render_code_directly(code, websocket):
    return await importlib.import_module("app.legacy_main").render_code_directly(code, websocket)


async def find_video_file(search_dir, filename_prefix):
    return await importlib.import_module("app.legacy_main").find_video_file(search_dir, filename_prefix)


async def find_image_file(search_dir, filename_prefix):
    return await importlib.import_module("app.legacy_main").find_image_file(search_dir, filename_prefix)
