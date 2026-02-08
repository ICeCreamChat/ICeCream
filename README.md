# 🍦 ICeCream - 统一智能平台

> 一个整合 AI 聊天、数学动画生成、智能解题的统一平台

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.9+-blue.svg)](https://python.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## ✨ 功能特性

| 功能 | 描述 | 状态 |
|------|------|:----:|
| 💬 **智能对话** | 基于 DeepSeek 的 AI 聊天助手 | ✅ |
| 🎬 **数学动画** | 自然语言描述生成 Manim 动画 | ✅ |
| 📐 **智能解题** | 上传题目图片，AI 自动解答 | ✅ |
| 🧠 **意图识别** | 自动识别用户意图，智能路由 | ✅ |

## 🚀 快速开始

### 环境要求

- **Node.js** 18+ ([下载](https://nodejs.org/))
- **Python** 3.9+ ([下载](https://python.org/)) - 仅动画功能需要

### 一键启动

**Windows:**
```batch
start.bat
```

**Linux/macOS:**
```bash
chmod +x start.sh
./start.sh
```

### 手动启动

1. **安装依赖**
   ```bash
   npm install
   ```

2. **配置环境变量**
   ```bash
   cp .env.example .env
   # 编辑 .env 填入您的 API Key
   ```

3. **启动 Gateway 服务**
   ```bash
   npm start
   ```

4. **启动 Manim 服务（可选）**
   ```bash
   cd manim-service
   pip install -r requirements.txt
   python main.py
   ```

5. **访问应用**
   
   打开浏览器访问：**http://localhost:3000**

## 📁 项目结构

```
ICeCream/
├── gateway/                    # 统一入口服务
│   ├── server.js              # Express 主服务
│   ├── middleware/
│   │   └── intent-router.js   # 意图路由中间件
│   ├── routes/                # API 路由
│   └── services/
│       └── intent-classifier.js  # AI 意图分类器
│
├── services/                   # 业务服务层
│   ├── chat/                  # 聊天服务
│   ├── manim/                 # 动画服务客户端
│   └── solver/                # 解题服务
│
├── public/                     # 前端静态资源
│   ├── index.html
│   ├── css/main.css           # Pro Max Glass 设计系统
│   └── js/app.js              # 前端主入口
│
├── manim-service/             # Python Manim 渲染服务
│   ├── main.py               # FastAPI 服务
│   └── requirements.txt
│
├── uploads/                    # 文件上传目录
├── .env.example                # 环境变量模板
├── package.json
└── start.bat / start.sh        # 一键启动脚本
```

## ⚙️ 配置说明

### 环境变量 (.env)

| 变量名 | 说明 | 必填 |
|--------|------|:----:|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | ✅ |
| `DEEPSEEK_API_BASE` | API 端点（支持中转） | ✅ |
| `SILICONFLOW_API_KEY` | SiliconFlow API（视觉服务）| ✅ |
| `PORT` | Gateway 服务端口 | 默认 3000 |
| `MANIM_SERVICE_PORT` | Manim 服务端口 | 默认 8001 |
| `INTENT_CLASSIFIER_ENABLED` | 启用 AI 意图分类 | 默认 true |

## 🎨 UI 设计

- **Pro Max Glass** 玻璃拟态风格
- **霓虹青强调色** (`#00f0ff`)
- **深色/浅色模式** 双主题支持
- **响应式设计** 支持移动端

## 📌 技术架构

```
┌─────────────────────────────────────────────────────────┐
│                    用户浏览器                            │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                 统一前端界面                              │
│              (Pro Max Glass UI)                          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              Gateway 意图路由器                           │
│    ┌─────────────────────────────────────────────────┐  │
│    │  显式模态  │  AI 意图分类  │  低置信度确认    │  │
│    └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
           │                │                │
           ▼                ▼                ▼
    ┌───────────┐    ┌───────────┐    ┌───────────┐
    │  Chat     │    │  Manim    │    │  Solver   │
    │  Service  │    │  Service  │    │  Service  │
    └───────────┘    └───────────┘    └───────────┘
           │                │                │
           ▼                ▼                ▼
    ┌───────────┐    ┌───────────┐    ┌───────────┐
    │ DeepSeek  │    │  Python   │    │ Qwen-VL + │
    │   API     │    │  Manim    │    │ DeepSeek  │
    └───────────┘    └───────────┘    └───────────┘
```

## 🔧 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/message` | POST | 统一消息入口（支持意图识别）|
| `/api/chat` | POST | 直接聊天 |
| `/api/manim/generate` | POST | 生成动画 |
| `/api/manim/status` | GET | Manim 服务状态 |
| `/api/solver` | POST | 智能解题 |
| `/api/health` | GET | 健康检查 |

## 🐛 常见问题

### 动画功能不可用？

确保已启动 Manim Python 服务：
```bash
cd manim-service
python main.py
```

### API 连接超时？

检查 `.env` 中的 API 地址是否可访问：
- 如果使用中转 API，确保网络可达
- 如果使用官方 API，确保 API Key 有效

### 如何切换主题？

点击右上角的太阳/月亮图标切换深色/浅色模式。

## 📄 许可证

MIT License © 2026 ICeCreamChat

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

**Made with ❤️ by ICeCreamChat**
