# config.py
"""
ICeCream Core Manim 服务配置
"""

import os

# ================= 📂 路径配置 =================
APP_DIR = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.dirname(APP_DIR)
PROJECT_ROOT = os.path.dirname(SERVICE_ROOT)  # 仓库根目录
BASE_DIR = APP_DIR  # 兼容旧变量名
STATIC_DIR = os.path.join(SERVICE_ROOT, "static")
TEMPLATES_DIR = os.path.join(SERVICE_ROOT, "templates")
TEMP_DIR = os.path.join(SERVICE_ROOT, "temp_gen")
SCENE_FILE = os.path.join(TEMP_DIR, "current_scene.py")
HISTORY_FILE = os.path.join(TEMP_DIR, "context_history.txt")
CONVERSATION_FILE = os.path.join(TEMP_DIR, "conversation.json")

# ================= ⚡ 加载 .env 文件 =================
# 优先从项目根目录 .env 加载环境变量
def load_env_file():
    """手动加载 .env 文件"""
    env_paths = [
        os.path.join(PROJECT_ROOT, ".env"),            # 仓库根目录 .env (优先)
        os.path.join(SERVICE_ROOT, ".env"),            # manim-service/.env
        os.path.join(APP_DIR, ".env"),                 # manim-service/app/.env
    ]
    
    for env_path in env_paths:
        if os.path.exists(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            key, value = line.split("=", 1)
                            key = key.strip()
                            value = value.strip()
                            # 只设置尚未存在的环境变量
                            if key not in os.environ:
                                os.environ[key] = value
                print(f"[OK] 已加载配置文件: {env_path}")
                return True
            except Exception as e:
                print(f"[WARN] 加载 {env_path} 失败: {e}")
    return False

load_env_file()

# ================= ⚡ API 配置 =================
# 从环境变量读取 (统一配置)
API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
BASE_URL = os.environ.get("DEEPSEEK_API_BASE", "https://api.deepseek.com/v1")
MODEL_NAME = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

# 启动时检查 API Key
if not API_KEY or API_KEY == "your-api-key-here":
    print("=" * 60)
    print("[WARN]  警告: 未配置有效的 API Key!")
    print("=" * 60)
    print("请配置 API Key:")
    print("  1. 复制项目根目录的 .env.example 为 .env")
    print("  2. 设置 DEEPSEEK_API_KEY=您的API密钥")
    print("  3. 重启服务")
    print("=" * 60)
else:
    print("[OK] API Key 已配置")

# ================= ⚙️ 系统配置 =================
MAX_RETRIES = 2
MAX_HISTORY_ENTRIES = 15
REQUEST_TIMEOUT = 120.0
MANIM_TIMEOUT = 300
MANIM_AGENT_REPAIR_ATTEMPTS_DEFAULT = 4


def _bounded_int_env(name, default, minimum, maximum):
    try:
        value = int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, value))


def get_manim_agent_repair_attempts():
    return _bounded_int_env("MANIM_AGENT_REPAIR_ATTEMPTS", MANIM_AGENT_REPAIR_ATTEMPTS_DEFAULT, 1, 6)


MANIM_AGENT_REPAIR_ATTEMPTS = get_manim_agent_repair_attempts()

# ================= 🎯 默认值 =================
DEFAULT_SCENE_NAME = "MathScene"
DEFAULT_QUALITY = "-ql"  # 低质量，快速渲染
