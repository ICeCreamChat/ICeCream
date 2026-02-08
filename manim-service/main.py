import os
import sys
import subprocess
import shutil
import asyncio
import uuid
import json
import logging
import threading
import re
import ast
import hashlib
import time

import contextlib
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from openai import AsyncOpenAI 
from dotenv import load_dotenv

# 加载环境变量
load_dotenv(dotenv_path="../.env")

# ================= 📦 导入配置和提示词 =================
# ================= 📦 导入配置和提示词 =================
import service_config as config

# Map config variables to globals to avoid changing all usages
API_KEY = config.API_KEY
BASE_URL = config.BASE_URL
MODEL_NAME = config.MODEL_NAME
STATIC_DIR = config.STATIC_DIR
TEMPLATES_DIR = config.TEMPLATES_DIR
TEMP_DIR = config.TEMP_DIR
SCENE_FILE = config.SCENE_FILE
HISTORY_FILE = config.HISTORY_FILE
CONVERSATION_FILE = config.CONVERSATION_FILE
MAX_RETRIES = config.MAX_RETRIES
MAX_HISTORY_ENTRIES = config.MAX_HISTORY_ENTRIES
REQUEST_TIMEOUT = config.REQUEST_TIMEOUT
MANIM_TIMEOUT = config.MANIM_TIMEOUT
DEFAULT_SCENE_NAME = config.DEFAULT_SCENE_NAME
DEFAULT_QUALITY = config.DEFAULT_QUALITY


from prompts import (
    PROMPT_GENERATOR,
    PROMPT_ANALYZER,
    PROMPT_IMPROVER,
    PROMPT_INTENT_ANALYZER,
    PROMPT_EMERGENCY_FIXER,
    PROMPT_CODE_MODIFIER,
    SYSTEM_PROMPTS,
    RESPONSE_TEMPLATES,
    MONITOR_HTML
)

# ================= 📝 缓存系统 (MD5指纹) =================
CACHE_FILE = os.path.join(TEMP_DIR, "cache.json")

def load_cache():
    """加载缓存文件"""
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except:
            return {}
    return {}

def get_current_code_content():
    """安全获取当前场景代码的完整内容"""
    if os.path.exists(SCENE_FILE):
        try:
            with open(SCENE_FILE, "r", encoding="utf-8") as f:
                return f.read()
        except:
            return ""
    return ""

def save_cache_entry(prompt, video_url, current_code=""):
    """保存缓存条目，使用 Prompt + 当前代码内容的 MD5 作为键"""
    cache = load_cache()
    # 核心修改：Key 包含了 prompt 和 current_code，确保上下文一致才命中
    content = f"{prompt.strip()}_{current_code.strip()}"
    key = hashlib.md5(content.encode('utf-8')).hexdigest()
    
    cache[key] = video_url
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️ 缓存保存失败: {e}")

def get_cached_video(prompt, current_code=""):
    """尝试获取缓存的视频链接，必须匹配当前代码上下文"""
    cache = load_cache()
    content = f"{prompt.strip()}_{current_code.strip()}"
    key = hashlib.md5(content.encode('utf-8')).hexdigest()
    return cache.get(key)

# ================= 🔍 代码分析器 (静态AST) =================
def analyze_code_structure(code: str):
    """分析代码结构，提取重要信息（类名、方法、变量等）"""
    try:
        tree = ast.parse(code)
        analysis = {
            "scene_class": None,
            "methods": [],
            "variables": [],
            "animations": [],
            "has_axes": False,
            "objects": []
        }
        
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                # 智能识别继承自 Scene 的类
                base_ids = [base.id for base in node.bases if hasattr(base, 'id')]
                # 只要继承链里有 Scene 相关的都算
                if any(b in ['Scene', 'ThreeDScene', 'MovingCameraScene', 'ZoomedScene', 'LinearTransformationScene'] for b in base_ids):
                    analysis["scene_class"] = node.name
            elif isinstance(node, ast.FunctionDef):
                analysis["methods"].append(node.name)
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        analysis["variables"].append(target.id)
            elif isinstance(node, ast.Call):
                if hasattr(node.func, 'attr'):
                    if node.func.attr in ['Create', 'Play', 'Transform', 'FadeIn', 'FadeOut', 'Rotate', 'Write']:
                        analysis["animations"].append(node.func.attr)
                if hasattr(node.func, 'id'):
                    if node.func.id in ['Axes', 'ThreeDAxes', 'NumberPlane']:
                        analysis["has_axes"] = True
        return analysis
    except:
        return {"error": "代码解析失败"}

def extract_objects_from_code(code: str):
    """静态提取已定义的图形对象（作为动态侦探的备份方案）"""
    objects = []
    # 匹配常见的Manim对象创建模式
    patterns = [
        r'(\w+)\s*=\s*(Circle|Square|Triangle|Rectangle|Line|Dot|Text|MathTex|VGroup|Axes|NumberPlane|Sphere|Cube)',
        r'self\.add\((\w+)\)',
        r'self\.play\([^)]*(\w+)[^)]*\)',
        r'def construct\(self\):[\s\S]*?(\w+)\s*='
    ]
    
    for pattern in patterns:
        matches = re.findall(pattern, code)
        for match in matches:
            if isinstance(match, tuple):
                obj_name = match[0] if match[0] else match[1]
            else:
                obj_name = match
            if obj_name and obj_name not in ['self', 'Scene', 'run_time', 'PI'] and obj_name not in objects:
                objects.append(obj_name)
    
    return objects

# ================= 🧹 自清洁启动逻辑 (持久化版) =================
def cleanup_workspace_startup():
    """系统启动时的清理：一次性移除过期的视频资源"""
    print("-" * 50)
    print("🧹 [系统] 正在执行启动净化...")
    
    # 1. 临时文件夹 (temp_gen) - 这些是渲染中间产物，直接全删
    if os.path.exists(TEMP_DIR):
        try: 
            shutil.rmtree(TEMP_DIR)
            print("   - 已清空临时渲染目录")
        except Exception as e: 
            print(f"   - 临时目录清理失败: {e}")
            
    # 2. 静态资源区 (static) - 清理超过24小时的旧视频
    if os.path.exists(STATIC_DIR):
        now = time.time()
        expiration_seconds = 24 * 3600 # 24小时
        deleted_count = 0
        
        try:
            for filename in os.listdir(STATIC_DIR):
                file_path = os.path.join(STATIC_DIR, filename)
                
                # 只清理媒体文件，保留 .gitkeep
                if not (filename.endswith(".mp4") or filename.endswith(".png")):
                    continue
                    
                if os.path.isfile(file_path):
                    # 检查最后修改时间
                    if now - os.path.getmtime(file_path) > expiration_seconds:
                        try:
                            os.remove(file_path)
                            deleted_count += 1
                        except:
                            pass
        except Exception as e:
            print(f"   - 静态扫描出错: {e}")
        
        if deleted_count > 0:
            print(f"   - 已清除 {deleted_count} 个过期视频/图片")
        else:
            print("   - 静态区无过期文件")
    
    # 3. 确保目录结构完整
    os.makedirs(STATIC_DIR, exist_ok=True)
    os.makedirs(TEMP_DIR, exist_ok=True)
    os.makedirs(TEMPLATES_DIR, exist_ok=True)
    
    print("✨ [系统] 净化完成，服务就绪。")
    print("-" * 50)

def hard_reset_system():
    """彻底重置：清理所有文件，包括视频和历史记录（核按钮）"""
    print("⚠️ [系统] 执行彻底重置...")
    
    # 1. 清理临时目录
    if os.path.exists(TEMP_DIR):
        try: shutil.rmtree(TEMP_DIR)
        except: pass
        
    # 2. 清理所有视频文件
    if os.path.exists(STATIC_DIR):
        for filename in os.listdir(STATIC_DIR):
            if filename.endswith(".mp4"):
                try: 
                    os.remove(os.path.join(STATIC_DIR, filename))
                except: 
                    pass
    
    # 3. 清理记忆文件
    for f in [HISTORY_FILE, CONVERSATION_FILE, SCENE_FILE]:
        if os.path.exists(f):
            try: os.remove(f)
            except: pass
            
    # 4. 重建目录
    os.makedirs(STATIC_DIR, exist_ok=True)
    os.makedirs(TEMP_DIR, exist_ok=True)

@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时只执行轻量清理，保护视频
    cleanup_workspace_startup()
    yield

app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")
templates = Jinja2Templates(directory=config.TEMPLATES_DIR)

client = AsyncOpenAI(
    api_key=API_KEY, 
    base_url=BASE_URL, 
    timeout=REQUEST_TIMEOUT
)

# ================= 📝 智能上下文管理器 =================
class SmartContextManager:
    """智能上下文管理器，深度理解代码结构"""
    
    def __init__(self):
        self.conversation_path = CONVERSATION_FILE
        self.history_path = HISTORY_FILE
        self.scene_path = SCENE_FILE
        self.max_history_entries = MAX_HISTORY_ENTRIES
        
    def save_conversation(self, user_prompt: str, response_data: dict, code_analysis: dict = None):
        """保存对话记录，包含代码分析"""
        entry = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "user": user_prompt,
            "generator_draft": response_data.get("generator_draft", ""),
            "analyzer_critique": response_data.get("analyzer_critique", ""),
            "final_code": response_data.get("final_code", ""),
            "success": response_data.get("success", False),
            "video_url": response_data.get("video_url", ""),
            "code_analysis": code_analysis or {},
            "intent_analysis": response_data.get("intent_analysis", "")
        }
        
        conversation = self.load_conversation()
        conversation.append(entry)
        
        if len(conversation) > self.max_history_entries:
            conversation = conversation[-self.max_history_entries:]
            
        with open(self.conversation_path, "w", encoding="utf-8") as f:
            json.dump(conversation, f, ensure_ascii=False, indent=2)
    
    def load_conversation(self):
        if not os.path.exists(self.conversation_path):
            return []
        try:
            with open(self.conversation_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except:
            return []
    
    def get_context_summary(self):
        """生成智能上下文摘要"""
        conversation = self.load_conversation()
        if not conversation:
            return {"text": "无历史对话", "objects": [], "current_style": "无"}
        
        recent = conversation[-3:] if len(conversation) >= 3 else conversation
        
        objects_desc = [] # 用来存描述字符串，给 AI 看
        raw_objects = []  # 用来存原始数据
        styles = []
        intents = []
        
        for entry in recent:
            if entry.get("code_analysis"):
                objs = entry.get("code_analysis", {}).get("objects", [])
                
                # ✨ 新增：处理复杂对象格式
                for obj in objs:
                    if isinstance(obj, dict):
                        # 如果是侦探抓回来的详细数据
                        desc = f"{obj.get('type', '未知对象')}"
                        if 'pos' in obj:
                            desc += f"(位置:{obj['pos']})"
                        if 'color' in obj:
                            desc += f"(颜色:{obj['color']})"
                        if 'content' in obj:
                            desc += f"(内容:'{obj['content']}')"
                        objects_desc.append(desc)
                        raw_objects.append(obj.get('type', 'Unknown')) # 简略版用于前端标签
                    elif isinstance(obj, str):
                        # 兼容旧数据的字符串格式
                        objects_desc.append(obj)
                        raw_objects.append(obj)
            
            
            if entry.get("user"):
                user_text = entry["user"].lower()
                if "添加" in user_text or "再加" in user_text:
                    intents.append("添加")
                elif "修改" in user_text or "改变" in user_text:
                    intents.append("修改")
                elif "新建" in user_text or "创建" in user_text:
                    intents.append("新建")
            
            if entry.get("code_analysis", {}).get("has_axes"):
                styles.append("使用坐标轴")
        
        # 去重
        objects_desc = list(set(objects_desc))
        styles = list(set(styles))
        intents = list(set(intents))
        
        summary = f"最近{len(recent)}次交互中："
        if objects_desc:
            # 把详细的描述给 AI
            summary += f"\n- 屏幕上的对象状态：{'; '.join(objects_desc[:10])}"
        if styles:
            summary += f"\n- 当前风格：{', '.join(styles)}"
        
        return {
            "text": summary,
            "objects": list(set(raw_objects)), # 给前端显示的简单标签
            "current_style": styles[0] if styles else "无特定风格"
        }
    
    def analyze_current_code(self):
        """分析当前代码状态"""
        if not os.path.exists(self.scene_path):
            return {"status": "no_code", "objects": [], "has_axes": False}
        
        try:
            with open(self.scene_path, "r", encoding="utf-8") as f:
                code = f.read()
            
            analysis = analyze_code_structure(code)
            objects = extract_objects_from_code(code)
            
            return {
                "status": "has_code",
                "code_preview": code[:500] + "..." if len(code) > 500 else code,
                "analysis": analysis,
                "objects": objects,
                "object_count": len(objects),
                "has_axes": analysis.get("has_axes", False)
            }
        except Exception as e:
            return {"status": "error", "message": str(e)}

context_manager = SmartContextManager()

def validate_code_completeness(code: str):
    """
    🛡️ 代码完整性“安检门”
    检查 AI 是否偷懒使用了省略号或占位符
    """
    # AI 偷懒的常见嫌疑特征
    suspicious_patterns = [
        r"#\s*\.\.\.",             # 匹配 # ...
        r"^\s*\.\.\.\s*$",         # 匹配单行的 ...
        r"#\s*rest of code",       # 匹配 # rest of code
        r"#\s*code unchanged",     # 匹配 # code unchanged
        r"#\s*previous code",      # 匹配 # previous code
        r"class .*\(.*\):\s*pass", # 匹配 class X: pass (虽然可能是合法的，但在Manim里通常意味着偷懒)
    ]
    
    # 1. 检查特征词
    for pattern in suspicious_patterns:
        if re.search(pattern, code, re.MULTILINE | re.IGNORECASE):
            return False, f"检测到省略占位符 (匹配: {pattern})，代码不完整。"
            
    # 2. 检查长度 (Manim 代码通常不会只有几行)
    if len(code.strip().split('\n')) < 5:
        return False, "代码行数过少，可能不完整。"
        
    # 3. 检查关键结构
    if "class " not in code or "def construct" not in code:
        return False, "缺失类定义或 construct 方法。"
        
    return True, "完整"

def extract_code_from_markdown(text):
    """从文本中提取代码块"""
    patterns = [
        r"```python(.*?)```",
        r"```(.*?)```",
        r"<code>(.*?)</code>"
    ]
    
    for pattern in patterns:
        match = re.search(pattern, text, re.DOTALL)
        if match:
            code = match.group(1).strip()
            code = re.sub(r'^python\s*', '', code, flags=re.IGNORECASE)
            return code
    
    return text.strip().replace("```", "")

def extract_json_from_response(text):
    """从响应中提取JSON"""
    try:
        json_pattern = r'\{[\s\S]*\}'
        match = re.search(json_pattern, text)
        if match:
            return json.loads(match.group())
    except:
        pass
    return None

# ================= 🛡️ 并发风暴防御系统 =================
# ================= 🛡️ 并发风暴防御系统 =================
class RenderProcessManager:
    """Manim 渲染进程管理器 (支持多用户隔离)"""
    def __init__(self):
        # 字典结构: { "client_123": <subprocess.Popen object>, ... }
        self._active_processes = {} 
        self._lock = threading.Lock()
        
    def kill_process_for_client(self, client_id):
        """精准狙击：只杀掉指定用户的旧进程"""
        with self._lock:
            if client_id in self._active_processes:
                proc = self._active_processes[client_id]
                if proc.poll() is None: # 如果还在跑
                    try:
                        print(f"⚡ [多用户] 用户 {client_id} 发起新请求，终止其旧进程 PID: {proc.pid}")
                        if sys.platform == "win32":
                            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], 
                                         capture_output=True)
                        else:
                            proc.kill()
                    except Exception as e:
                        print(f"⚠️ 终止进程失败: {e}")
                # 从花名册移除
                del self._active_processes[client_id]

    def run_command(self, cmd, timeout, client_id):
        """运行命令，并绑定到指定用户"""
        # 1. 先清理该用户自己的旧门户
        self.kill_process_for_client(client_id)
        
        # 简单的并发控制 (防止服务器过载)
        if len(self._active_processes) > 8:
             return -1, "", "服务器繁忙(Too Many Requests)，请稍后再试"

        proc = None
        # 2. 启动新进程
        with self._lock:
            try:
                # Windows下需要 creationflags 才能被 taskkill /T 杀干净
                kwargs = {}
                if sys.platform == "win32":
                    kwargs['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP
                else:
                    kwargs['preexec_fn'] = os.setsid
                    
                proc = subprocess.Popen(
                    cmd, 
                    stdout=subprocess.PIPE, 
                    stderr=subprocess.PIPE, 
                    text=True, 
                    encoding='utf-8', 
                    errors='ignore',
                    **kwargs
                )
                
                # 登记造册
                self._active_processes[client_id] = proc
                
            except Exception as e:
                return -1, "", str(e)

        # 3. 等待结果
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
            
            # 运行完后，主动从名单里移除（防止字典无限膨胀）
            with self._lock:
                if client_id in self._active_processes and self._active_processes[client_id] == proc:
                    del self._active_processes[client_id]
                    
            return proc.returncode, stdout, stderr
            
        except subprocess.TimeoutExpired:
            self.kill_process_for_client(client_id) # 超时也得杀
            return -1, "", "渲染超时 (Timeout)"
        except Exception as e:
            self.kill_process_for_client(client_id)
            return -1, "", str(e)

# 全局单例
render_manager = RenderProcessManager()

def run_manim_safe(cmd, client_id, timeout=MANIM_TIMEOUT):
    """安全运行Manim命令 (支持多用户隔离)"""
    return render_manager.run_command(cmd, timeout, client_id)

async def find_video_file(search_dir, filename_prefix):
    """查找视频文件"""
    for root, dirs, files in os.walk(search_dir):
        for file in files:
            if file.endswith(".mp4") and filename_prefix in file:
                return os.path.join(root, file)
    return None

async def find_image_file(search_dir, filename_prefix):
    """查找图片文件"""
    for root, dirs, files in os.walk(search_dir):
        for file in files:
            if file.endswith(".png") and filename_prefix in file:
                return os.path.join(root, file)
    return None

# ================= 🚀 核心工作流逻辑 (完整4步 + WebSocket + 侦探) =================
async def process_chat_workflow(prompt: str, websocket: WebSocket):
    """处理核心业务逻辑，通过 WebSocket 发送实时进度"""
    request_id = str(uuid.uuid4())[:8]
    output_filename = f"video_{request_id}"
    
    # ✨ 新增：在开始任何处理前，先记录当前的“代码快照”
    # 这是为了确保缓存 Key 对应的是“执行指令前”的状态
    current_code_snapshot = get_current_code_content()
    
    # 辅助函数：发送进度
    async def send_status(step, message):
        print(f"[{request_id}] {message}")
        if websocket:
            await websocket.send_json({
                "type": "progress",
                "step": step,
                "message": message
            })

    await send_status("init", f"收到指令: {prompt}")
    
    try:
        # =======================================================
        # 🔍 第0步：分析当前状态和用户意图
        # =======================================================
        current_state = context_manager.analyze_current_code()
        context_summary = context_manager.get_context_summary()
        
        await send_status("intent", "正在分析您的意图...")
        intent_analysis = None
        try:
            intent_response = await client.chat.completions.create(
                model=MODEL_NAME,
                messages=[
                    {"role": "system", "content": PROMPT_INTENT_ANALYZER},
                    {"role": "user", "content": f"""
用户指令: {prompt}
当前状态: {json.dumps(current_state, ensure_ascii=False)}
上下文摘要: {context_summary['text']}

请分析用户的真实意图。
"""}
                ],
                stream=False,
                temperature=0.1
            )
            intent_analysis = extract_json_from_response(intent_response.choices[0].message.content)
            print(f"[{request_id}] 🎯 意图分析: {intent_analysis}")
        except Exception as e:
            print(f"[{request_id}] ⚠️ 意图分析失败: {e}")
        
        # =======================================================
        # 🎨 第一步：生成器 - 上下文感知初稿
        # =======================================================
        await send_status("generator", "正在构思动画代码...")
        start_time = time.time()
        
        generator_input = f"""
【用户指令】:
{prompt}

【意图分析】:
{json.dumps(intent_analysis, ensure_ascii=False) if intent_analysis else "未分析"}

【当前代码状态】:
{current_state.get('code_preview', '无现有代码')}

【已存在的对象】:
{', '.join(current_state.get('objects', [])) if current_state.get('objects') else '无'}

【上下文摘要】:
{context_summary['text']}

【具体要求】:
1. 保持代码清晰，**必须在文件开头包含 import math 和 import numpy as np**
2. **严禁在 MathTex 中使用中文**，中文必须用 Text() 类
3. 如果是修改或添加，请基于当前代码进行；如果是新建，可以完全重写
4. 确保所有内容都在屏幕内
"""
        
        gen_response = await client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": PROMPT_GENERATOR},
                {"role": "user", "content": generator_input}
            ],
            stream=False,
            temperature=0.7
        )
        
        draft_code = extract_code_from_markdown(gen_response.choices[0].message.content)
        gen_time = time.time() - start_time
        
        # 🛡️ 安检 1：检查生成器初稿
        is_valid, reason = validate_code_completeness(draft_code)
        if not is_valid:
            print(f"[{request_id}] ⚠️ 生成器偷懒了: {reason}")
            # 如果初稿就不完整，我们让分析器知道这一点，迫使它在下一步修复
            draft_code += f"\n\n# SYSTEM WARNING: The code above is TRUNCATED/INCOMPLETE ({reason}). You MUST fix this in the next step by rewriting the FULL code."
        
        # =======================================================
        # ⚖️ 第二步：分析器 - 上下文感知质检
        # =======================================================
        await send_status("analyzer", "正在检查代码质量...")
        ana_start = time.time()
        
        analyzer_input = f"""
【用户指令】: {prompt}
【生成器初稿】: {draft_code}
请检查布局、遮挡和 MathTex 中文问题。
"""
        
        ana_response = await client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": PROMPT_ANALYZER},
                {"role": "user", "content": analyzer_input}
            ],
            stream=False,
            temperature=0.1
        )
        
        critique = ana_response.choices[0].message.content
        ana_time = time.time() - ana_start
        
        # =======================================================
        # 🔧 第三步：改进器 - 智能优化
        # =======================================================
        await send_status("improver", "正在优化代码细节...")
        imp_start = time.time()
        
        improver_input = f"""
【用户指令】: {prompt}
【初稿】: {draft_code}
【质检报告】: {critique}
请修复所有问题，特别是 MathTex 中文和 import math。
"""
        
        imp_response = await client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": PROMPT_IMPROVER},
                {"role": "user", "content": improver_input}
            ],
            stream=False,
            temperature=0.3
        )
        
        final_code = extract_code_from_markdown(imp_response.choices[0].message.content)
        imp_time = time.time() - imp_start
        
        # 🛡️ 安检 2：检查改进器终稿
        is_valid_final, reason_final = validate_code_completeness(final_code)
        if not is_valid_final:
            print(f"[{request_id}] ❌ 改进器依然偷懒: {reason_final}")
            # 这是一个严重错误，触发紧急修复机制
            # 我们通过抛出异常或覆盖 final_code 来强制进入 Step 4 的修复流程
            # 这里我们构造一个假的报错，让下面的 Emergency Fixer 去处理
            final_code = f"# INCOMPLETE CODE GENERATED\n# Error: {reason_final}\n# Please regenerate the FULL code.\n" + final_code
        
        # 🔍 提前分析代码结构 (为了获取类名)
        code_analysis = analyze_code_structure(final_code)
        scene_name = code_analysis.get("scene_class") or DEFAULT_SCENE_NAME

        # ================= ⚡ STEP 3.5: 极速静态预览 (Flash Preview) =================
        # 既然你性子急，我们先花 2 秒生成一张静态图给你看，不用干等视频
        try:
            await send_status("preview", "🚀 正在生成静态预览...")
            
            # 创建预览专用的临时环境
            preview_dir = os.path.join(TEMP_DIR, f"preview_{request_id}")
            os.makedirs(preview_dir, exist_ok=True)
            preview_file = os.path.join(preview_dir, "preview_scene.py")
            
            with open(preview_file, "w", encoding="utf-8") as f:
                f.write(final_code)
            
            # 关键参数解释:
            # -s: save_last_frame (只渲染最后一帧，不做视频)
            # -ql: quality_low (480p，速度最快)
            # --format=png: 输出图片格式
            cmd_preview = [
                sys.executable, "-m", "manim",
                "-ql", "-s", "--format=png",
                "--media_dir", preview_dir,
                "-o", "preview_image",
                preview_file,
                scene_name
            ]
            
            # 设定 20秒 超时，避免预览卡太久喧宾夺主
            p_code, _, _ = await asyncio.to_thread(run_manim_safe, cmd_preview, f"preview_{request_id}", timeout=20)
            
            if p_code == 0:
                # 寻找生成的 png 文件
                preview_image_path = None
                for root, _, files in os.walk(preview_dir):
                    for f in files:
                        if f.endswith(".png"):
                            preview_image_path = os.path.join(root, f)
                            break
                
                if preview_image_path:
                    # 移动到静态资源目录
                    target_preview = f"preview_{request_id}.png"
                    shutil.move(preview_image_path, os.path.join(STATIC_DIR, target_preview))
                    
                    # ⚡ 立即推送图片给前端
                    if websocket:
                        await websocket.send_json({
                            "type": "preview",
                            "url": f"/static/{target_preview}",
                            "message": "静态预览已就绪 (高清视频渲染中...)"
                        })
                        print(f"[{request_id}] 🖼️ 预览图已发送")
        except Exception as e:
            # 预览失败不要紧，不要打断主流程
            print(f"[{request_id}] ⚠️ 预览生成跳过: {e}")
        finally:
            # 清理预览临时文件
            try: shutil.rmtree(preview_dir, ignore_errors=True)
            except: pass

        # =======================================================
        # 🎬 第四步：渲染执行 (并发隔离 + 动态侦探)
        # =======================================================
        await send_status("render", "正在渲染视频 (可能需要几分钟)...")
        
        # 3.1 动态代码分析 (Scene Name Detection)
        code_analysis = analyze_code_structure(final_code)
        scene_name = code_analysis.get("scene_class") or DEFAULT_SCENE_NAME
        
        video_url = None
        error_details = None
        final_objects = []
        
        # 1. 创建本次请求的专属临时目录 (并发隔离)
        request_dir = os.path.join(TEMP_DIR, f"req_{request_id}")
        os.makedirs(request_dir, exist_ok=True)
        
        # 2. 专属场景文件路径
        local_scene_file = os.path.join(request_dir, "current_scene.py")
        dump_file = os.path.join(request_dir, "objects_dump.json").replace("\\", "/")
        
        # 🔥【关键】注入 Inspector 代码 (侦探升级版) 🔥
        # 这是一个继承自用户 Scene 的子类，专门用于在 tear_down 时窃取对象详细信息
        inspector_class_name = f"Inspector_{request_id}"
        inspector_code = f"""
import json
from manim import Mobject, Text, Tex, MathTex, VMobject

class {inspector_class_name}({scene_name}):
    def tear_down(self):
        try:
            detected_objects = []
            
            # 扫描屏幕上的对象 (self.mobjects)
            for mobj in self.mobjects:
                # 1. 基础信息：类型
                info = {{
                    "type": mobj.__class__.__name__,
                    "id": str(id(mobj))
                }}
                
                # 2. 位置信息 (保留2位小数)
                try:
                    center = mobj.get_center()
                    info["pos"] = [round(x, 2) for x in center.tolist()[:3]]
                except:
                    info["pos"] = [0, 0, 0]
                    
                # 3. 颜色信息
                try:
                    if hasattr(mobj, "get_color"):
                        c = mobj.get_color()
                        info["color"] = c.name if hasattr(c, "name") else str(c)
                    elif hasattr(mobj, "color"):
                        info["color"] = str(mobj.color)
                except:
                    info["color"] = "unknown"
                
                # 4. 文本内容 (如果是文字类)
                if isinstance(mobj, (Text, Tex, MathTex)):
                    # 尝试各种可能的属性名
                    for attr in ["original_text", "text", "tex_string"]:
                        if hasattr(mobj, attr):
                            info["content"] = getattr(mobj, attr)
                            break
                            
                detected_objects.append(info)
            
            # 将检测到的详细对象列表写入临时文件
            with open(r"{dump_file}", "w", encoding="utf-8") as f:
                json.dump(detected_objects, f, ensure_ascii=False)
        except Exception as e:
            print(f"Inspector Error: {{e}}")
        finally:
            super().tear_down()
"""

        for attempt in range(MAX_RETRIES + 1):
            if attempt > 0:
                await send_status("render", f"渲染出错，正在第 {attempt} 次自动修复...")
            
            # 写入带侦探的代码 (源代码 + 侦探代码)
            with open(local_scene_file, "w", encoding="utf-8") as f:
                f.write(final_code + "\n" + inspector_code)
            
            # 运行 Manim (运行的是 Inspector 类，而不是原类)
            cmd = [
                sys.executable, "-m", "manim",
                DEFAULT_QUALITY,
                "--media_dir", request_dir,
                "-o", output_filename,
                local_scene_file,
                inspector_class_name # <--- 运行侦探
            ]
            
            returncode, stdout, stderr = await asyncio.to_thread(run_manim_safe, cmd)
            
            if returncode == 0:
                # 5. 查找视频
                video_path = await find_video_file(request_dir, output_filename)
                
                if video_path:
                    target_name = f"{output_filename}.mp4"
                    target_path = os.path.join(STATIC_DIR, target_name)
                    
                    shutil.move(video_path, target_path)
                    video_url = f"/static/{target_name}"
                    
                    # 🔥 读取侦探的报告 (100% 准确的运行时数据)
                    try:
                        if os.path.exists(dump_file):
                            with open(dump_file, "r", encoding="utf-8") as f:
                                final_objects = json.load(f)
                            print(f"[{request_id}] 🕵️ 侦探报告: {final_objects}")
                        else:
                            # 如果侦探失败，降级为静态正则分析
                            print(f"[{request_id}] ⚠️ 侦探未生成报告，降级为静态分析")
                            final_objects = extract_objects_from_code(final_code)
                    except:
                        final_objects = extract_objects_from_code(final_code)

                    print(f"[{request_id}] 🎉 渲染成功!")
                    
                    # 成功后更新全局状态
                    try:
                        with open(SCENE_FILE, "w", encoding="utf-8") as f:
                            f.write(final_code)
                    except Exception as e:
                        print(f"[{request_id}] ⚠️ 全局状态更新警告: {e}")
                        
                    break
            else:
                error_details = stderr[-500:] if stderr else "未知错误"
                print(f"[{request_id}] ❌ 渲染失败: {error_details[:100]}...")
                
                if attempt < MAX_RETRIES:
                    fixer_prompt = PROMPT_EMERGENCY_FIXER.format(
                        error_details=error_details,
                        final_code=final_code
                    )
                    
                    fix_response = await client.chat.completions.create(
                        model=MODEL_NAME,
                        messages=[
                            {"role": "system", "content": SYSTEM_PROMPTS["code_fixer"]},
                            {"role": "user", "content": fixer_prompt}
                        ],
                        stream=False
                    )
                    
                    final_code = extract_code_from_markdown(fix_response.choices[0].message.content)

        # 任务结束，清理临时目录
        try:
            shutil.rmtree(request_dir, ignore_errors=True)
            print(f"[{request_id}] 🧹 临时工作区已清理")
        except:
            pass
        
        # =======================================================
        # 💾 第五步：保存结果与缓存
        # =======================================================
        total_time = time.time() - start_time
        
        response_data = {
            "generator_draft": draft_code[:500] + "..." if len(draft_code) > 500 else draft_code,
            "analyzer_critique": critique,
            "final_code": final_code,
            "success": bool(video_url),
            "video_url": video_url,
            "intent_analysis": intent_analysis,
            "timing": {
                "generator": gen_time,
                "analyzer": ana_time,
                "improver": imp_time,
                "total": total_time
            }
        }
        
        # 这里保存的是侦探抓取到的真实对象列表
        context_manager.save_conversation(prompt, response_data, {
            **code_analysis,
            "objects": final_objects # <--- 真实数据
        })
        
        if video_url:
            # 存入缓存
            save_cache_entry(prompt, video_url, current_code_snapshot)
            
            if websocket:
                await websocket.send_json({
                    "type": "result",
                    "status": "success",
                    "video": video_url,
                    "code": final_code,
                    "timing": response_data["timing"]
                })
        else:
            if websocket:
                await websocket.send_json({
                    "type": "error",
                    "message": "渲染失败",
                    "details": error_details
                })
            
    except Exception as e:
        print(f"[{request_id}] 💥 系统异常: {str(e)}")
        if websocket:
            await websocket.send_json({
                "type": "error",
                "message": f"系统异常: {str(e)}"
            })

# ================= 🎬 Direct Code Rendering (No AI) =================
async def render_code_directly(code: str, websocket: WebSocket):
    """Render user-provided Manim code directly without AI processing"""
    request_id = str(uuid.uuid4())[:8]
    output_filename = f"video_{request_id}"
    
    async def send_status(step, message):
        print(f"[{request_id}] {message}")
        if websocket:
            await websocket.send_json({
                "type": "progress",
                "step": step,
                "message": message
            })
    
    await send_status("render", "正在渲染您的代码...")
    
    try:
        # 1. Analyze code to find scene class
        code_analysis = analyze_code_structure(code)
        scene_name = code_analysis.get("scene_class") or DEFAULT_SCENE_NAME
        
        # 2. Create isolated temp directory
        request_dir = os.path.join(TEMP_DIR, f"req_{request_id}")
        os.makedirs(request_dir, exist_ok=True)
        
        local_scene_file = os.path.join(request_dir, "current_scene.py")
        
        # 3. Write code to file
        with open(local_scene_file, "w", encoding="utf-8") as f:
            f.write(code)
        
        # 4. Run Manim
        cmd = [
            sys.executable, "-m", "manim",
            DEFAULT_QUALITY,
            "--media_dir", request_dir,
            "-o", output_filename,
            local_scene_file,
            scene_name
        ]
        
        await send_status("render", "Manim 正在渲染视频...")
        # WebSocket 直接渲染暂无 client_id，使用 request_id 隔离
        returncode, stdout, stderr = await asyncio.to_thread(run_manim_safe, cmd, f"ws_{request_id}")
        
        if returncode == 0:
            # Find video file
            video_path = await find_video_file(request_dir, output_filename)
            
            if video_path:
                target_name = f"{output_filename}.mp4"
                target_path = os.path.join(STATIC_DIR, target_name)
                shutil.move(video_path, target_path)
                video_url = f"/static/{target_name}"
                
                print(f"[{request_id}] 🎉 直接渲染成功!")
                
                await websocket.send_json({
                    "type": "result",
                    "status": "success",
                    "video": video_url,
                    "code": code
                })
            else:
                await websocket.send_json({
                    "type": "error",
                    "message": "渲染完成但未找到视频文件",
                    "details": stderr[-500:] if stderr else ""
                })
        else:
            error_details = stderr[-500:] if stderr else "未知错误"
            print(f"[{request_id}] ❌ 渲染失败: {error_details[:100]}...")
            await websocket.send_json({
                "type": "error",
                "message": "代码渲染失败",
                "details": error_details
            })
        
        # Cleanup
        try:
            shutil.rmtree(request_dir, ignore_errors=True)
        except:
            pass
            
    except Exception as e:
        print(f"[{request_id}] 💥 直接渲染异常: {str(e)}")
        await websocket.send_json({
            "type": "error",
            "message": f"渲染异常: {str(e)}"
        })

# ================= 🤖 AI Code Modification =================
async def modify_code_with_ai(code: str, instruction: str, websocket: WebSocket):
    """Use AI to modify Manim code based on user instruction"""
    request_id = str(uuid.uuid4())[:8]
    
    async def send_status(message):
        print(f"[{request_id}] 🤖 {message}")
        if websocket:
            await websocket.send_json({
                "type": "progress",
                "step": "ai",
                "message": message
            })
    
    await send_status("正在分析修改需求...")
    
    try:
        # Call AI to modify code
        modifier_input = f"""
【现有代码】:
```python
{code}
```

【用户修改指令】:
{instruction}

请根据用户指令修改代码，保持原有结构，只修改必要部分。
"""
        
        await send_status("AI 正在修改代码...")
        
        response = await client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": PROMPT_CODE_MODIFIER},
                {"role": "user", "content": modifier_input}
            ],
            stream=False,
            temperature=0.3
        )
        
        modified_code = extract_code_from_markdown(response.choices[0].message.content)
        
        # 🛡️ 安检
        is_valid, reason = validate_code_completeness(modified_code)
        if not is_valid:
             raise Exception(f"AI 生成了不完整的代码: {reason}")
             
        print(f"[{request_id}] ✅ AI 修改完成")
        
        await websocket.send_json({
            "type": "result",
            "status": "success",
            "code": modified_code
        })
        
    except Exception as e:
        print(f"[{request_id}] ❌ AI 修改失败: {str(e)}")
        await websocket.send_json({
            "type": "error",
            "message": f"AI 修改失败: {str(e)}"
        })

# ================= 🔌 WebSocket 接口 =================
@app.websocket("/ws/chat")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🔌 新的 WebSocket 连接建立")
    
    try:
        while True:
            data = await websocket.receive_json()
            
            # === NEW: Handle direct code rendering ===
            if data.get("type") == "render_code":
                code = data.get("code")
                if code:
                    await render_code_directly(code, websocket)
                continue
            
            # === NEW: Handle AI code modification ===
            if data.get("type") == "modify_code":
                code = data.get("code")
                instruction = data.get("instruction")
                if code and instruction:
                    await modify_code_with_ai(code, instruction, websocket)
                continue
            
            prompt = data.get("prompt")
            
            if not prompt:
                continue

            print(f"\n{'='*60}")
            print(f"⚡ WS 收到指令: {prompt}")
            print(f"{'='*60}")

            # 1. 检查缓存
            # 0. 获取当前代码上下文 (用于缓存指纹)
            current_code_snapshot = get_current_code_content()

            # 1. 检查缓存 (传入当前代码)
            cached_video = get_cached_video(prompt, current_code_snapshot)
            if cached_video:
                print(f"✨ 命中缓存: {prompt}")
                await websocket.send_json({
                    "type": "progress",
                    "step": "cache",
                    "message": "发现相同灵感，正在调取记忆..."
                })
                # 稍微停顿展示一下缓存命中效果
                await asyncio.sleep(0.5)
                
                await websocket.send_json({
                    "type": "result",
                    "status": "success",
                    "video": cached_video,
                    "code": "（缓存内容）",
                    "cached": True
                })
                continue

            # 2. 无缓存，开始完整工作流
            await process_chat_workflow(prompt, websocket)
            
    except WebSocketDisconnect:
        print("🔌 客户端断开连接")
    except Exception as e:
        print(f"❌ WS异常: {e}")

# ================= 🌐 静态页面路由 =================
@app.get("/")
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/context")
async def get_context():
    """获取完整上下文信息"""
    conversation = context_manager.load_conversation()
    current_state = context_manager.analyze_current_code()
    context_summary = context_manager.get_context_summary()
    
    return {
        "conversation_summary": context_summary,
        "current_state": current_state,
        "recent_conversations": conversation[-5:] if len(conversation) > 5 else conversation
    }

@app.get("/api/debug")
async def debug_info():
    """调试信息接口"""
    return {
        "system": {
            "python_version": sys.version,
            "platform": sys.platform,
            "temp_dir_exists": os.path.exists(TEMP_DIR),
            "scene_file_exists": os.path.exists(SCENE_FILE)
        },
        "context": context_manager.get_context_summary()
    }

@app.post("/api/reset")
async def reset_system():
    """重置系统：这是'核按钮'，彻底删除所有数据"""
    hard_reset_system()
    return {"message": "系统已彻底重置"}

@app.get("/api/code/current")
async def get_current_code():
    """获取当前代码"""
    if os.path.exists(SCENE_FILE):
        try:
            with open(SCENE_FILE, "r", encoding="utf-8") as f:
                return {"code": f.read()}
        except Exception as e:
            return {"code": "", "error": str(e)}
    return {"code": "无当前代码"}

class SuggestionRequest(BaseModel):
    code: str
    count: int = 5

@app.post("/api/suggestions")
async def generate_suggestions(request: SuggestionRequest):
    """AI 动态生成修改建议"""
    try:
        prompt = f"""你是一个 Manim 动画助手。根据以下代码，生成 {request.count} 条简短的修改建议。

代码:
```python
{request.code[:1500]}
```

要求:
1. 每条建议不超过15个字
2. 建议要具体、可执行（如"把圆形改成蓝色"而非"修改颜色"）
3. 结合代码中的实际元素（如检测到圆形就建议圆形相关修改）
4. 包含一些创意性建议（如添加动画效果、添加标题等）
5. 直接返回 JSON 数组格式: ["建议1", "建议2", ...]

只返回 JSON 数组，不要其他内容。"""

        response = await client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": "你是一个 Manim 动画代码助手，只返回 JSON 格式的建议数组。"},
                {"role": "user", "content": prompt}
            ],
            temperature=0.8,
            max_tokens=200
        )
        
        result = response.choices[0].message.content.strip()
        
        # 尝试解析 JSON
        try:
            # 提取 JSON 数组
            json_match = re.search(r'\[.*\]', result, re.DOTALL)
            if json_match:
                suggestions = json.loads(json_match.group())
                return {"suggestions": suggestions}
        except:
            pass
        
        # 如果解析失败，返回默认建议
        return {"suggestions": [
            "添加动画效果",
            "改变图形颜色",
            "添加标题文字",
            "调整图形大小",
            "增加更多元素"
        ]}
        
    except Exception as e:
        print(f"⚠️ 生成建议失败: {e}")
        return {"suggestions": [
            "添加蓝色填充",
            "让图形旋转",
            "添加说明文字"
        ]}

# ================= 🔌 HTTP REST API for Gateway Integration =================

class RenderRequest(BaseModel):
    code: str
    client_id: str = "anonymous" # ✨ 新增：身份标识

@app.post("/render")
async def http_render_code(request: RenderRequest):
    """HTTP REST 端点：直接渲染 Manim 代码
    
    用于 Gateway 调用，无需 WebSocket 连接。
    返回视频的 URL 或 Base64 编码。
    """
    request_id = str(uuid.uuid4())[:8]
    output_filename = f"video_{request_id}"
    
    print(f"[{request_id}] 📡 收到 HTTP 渲染请求")
    
    try:
        code = request.code
        
        # 1. 分析代码结构
        code_analysis = analyze_code_structure(code)
        scene_name = code_analysis.get("scene_class") or DEFAULT_SCENE_NAME
        
        # 2. 创建隔离的临时目录
        request_dir = os.path.join(TEMP_DIR, f"req_{request_id}")
        os.makedirs(request_dir, exist_ok=True)
        
        local_scene_file = os.path.join(request_dir, "current_scene.py")
        
        # 3. 写入代码
        with open(local_scene_file, "w", encoding="utf-8") as f:
            f.write(code)
        
        # 4. 运行 Manim
        cmd = [
            sys.executable, "-m", "manim",
            DEFAULT_QUALITY,
            "--media_dir", request_dir,
            "-o", output_filename,
            local_scene_file,
            scene_name
        ]
        
        print(f"[{request_id}] 🎬 正在渲染 (Client: {request.client_id})...")
        returncode, stdout, stderr = await asyncio.to_thread(run_manim_safe, cmd, request.client_id)
        
        if returncode == 0:
            # 查找视频文件
            video_path = await find_video_file(request_dir, output_filename)
            
            if video_path:
                target_name = f"{output_filename}.mp4"
                target_path = os.path.join(STATIC_DIR, target_name)
                shutil.move(video_path, target_path)
                video_url = f"/static/{target_name}"
                
                # 同时提供 Base64（供前端直接使用）
                import base64
                with open(target_path, "rb") as vf:
                    video_base64 = base64.b64encode(vf.read()).decode('utf-8')
                
                print(f"[{request_id}] ✅ 渲染成功!")
                
                # 清理临时目录
                try:
                    shutil.rmtree(request_dir, ignore_errors=True)
                except:
                    pass
                
                return JSONResponse({
                    "success": True,
                    "videoUrl": video_url,
                    "videoBase64": video_base64
                })
            else:
                # 尝试查找图片 (如果 Manim 因为是静态场景只生成了图片)
                image_path = await find_image_file(request_dir, output_filename)
                
                if image_path:
                    print(f"[{request_id}] ⚠️ 未找到视频，但在 {image_path} 找到了图片。正在转换为 1s 视频...")
                    target_name = f"{output_filename}.mp4"
                    target_path = os.path.join(STATIC_DIR, target_name)
                    
                    # 使用 ffmpeg 将图片转为 1s 视频
                    ffmpeg_cmd = [
                        "ffmpeg", "-y",
                        "-loop", "1", "-i", image_path,
                        "-c:v", "libx264", "-t", "1", "-pix_fmt", "yuv420p",
                        target_path
                    ]
                    
                    bg_proc = await asyncio.create_subprocess_exec(
                        *ffmpeg_cmd,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE
                    )
                    _, _ = await bg_proc.communicate()
                    
                    if bg_proc.returncode == 0 and os.path.exists(target_path):
                        video_url = f"/static/{target_name}"
                        
                        import base64
                        with open(target_path, "rb") as vf:
                            video_base64 = base64.b64encode(vf.read()).decode('utf-8')
                            
                        print(f"[{request_id}] ✅ 图片转视频成功!")
                        
                        # 清理临时目录
                        try:
                            shutil.rmtree(request_dir, ignore_errors=True)
                        except:
                            pass
                        
                        return JSONResponse({
                            "success": True,
                            "videoUrl": video_url,
                            "videoBase64": video_base64,
                            "warning": "这是一个静态场景"
                        })
                
                # Debug logging if still failing
                print(f"[{request_id}] ❌ 渲染完成但未找到视频或图片文件")
                print(f"[{request_id}] Stdout: {stdout[-200:]}")
                print(f"[{request_id}] Stderr: {stderr[-200:]}")
                print(f"[{request_id}] Files in {request_dir}:")
                for root, dirs, files in os.walk(request_dir):
                    print(f"  {root}: {files}")
                
                return JSONResponse({
                    "success": False,
                    "error": "渲染完成但未找到任何输出文件"
                }, status_code=500)
        else:
            error_details = stderr[-500:] if stderr else "未知错误"
            print(f"[{request_id}] ❌ 渲染失败: {error_details[:100]}...")
            
            # 清理
            try:
                shutil.rmtree(request_dir, ignore_errors=True)
            except:
                pass
                
            return JSONResponse({
                "success": False,
                "error": error_details
            }, status_code=500)
            
    except Exception as e:
        print(f"[{request_id}] 💥 HTTP 渲染异常: {str(e)}")
        return JSONResponse({
            "success": False,
            "error": str(e)
        }, status_code=500)

@app.get("/health")
async def health_check():
    """健康检查端点，用于 Gateway 检测服务状态"""
    return {
        "status": "ok",
        "service": "ICeCream Manim Service",
        "version": "1.0.0"
    }

# ================= 📊 智能监控面板 =================
@app.get("/monitor", response_class=HTMLResponse)
async def smart_monitor():
    """智能监控面板"""
    return HTMLResponse(content=MONITOR_HTML)

if __name__ == "__main__":
    import uvicorn
    import sys
    # Fix for Windows console Unicode encoding
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    
    def free_port(port):
        """
        Windows-specific: Check if a port is in use and kill the process.
        """
        import subprocess
        try:
            # Check if port is in use
            result = subprocess.run(
                ["netstat", "-ano"], 
                capture_output=True, 
                text=True, 
                encoding='utf-8', # Ensure parsing works on non-English systems maybe
                errors='ignore'
            )
            
            pid = None
            for line in result.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    parts = line.strip().split()
                    if len(parts) >= 5:
                        pid = parts[-1]
                        break
            
            if pid:
                print(f"⚠️ 端口 {port} 被占用 (PID: {pid})，正在强制释放...")
                subprocess.run(
                    ["taskkill", "/F", "/PID", pid], 
                    capture_output=True, 
                    check=False
                )
                print(f"✅ 端口 {port} 已释放")
                time.sleep(1) # Wait for OS to release
        except Exception as e:
            print(f"⚠️ 尝试释放端口失败: {e}")

    free_port(8001)

    print("="*60)
    print("✨ ICeCream Manim 服务已启动")
    print("🌐 API 地址: http://localhost:8001")
    print("🔌 WebSocket: ws://localhost:8001/ws/chat")
    print("📊 智能监控: http://localhost:8001/monitor")
    print("="*60)
    
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=False)