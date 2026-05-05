import importlib


async def process_chat_workflow(prompt, websocket):
    return await importlib.import_module("app.legacy_main").process_chat_workflow(prompt, websocket)


async def modify_code_with_ai(code, instruction, websocket):
    return await importlib.import_module("app.legacy_main").modify_code_with_ai(code, instruction, websocket)
