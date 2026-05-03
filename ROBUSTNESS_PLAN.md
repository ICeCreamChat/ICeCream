# ICeCream 代码健壮性审计与加固计划

> 审计时间：2026-05-03
> 审计范围：gateway / services / public / test 共 60+ 文件
> 测试现状：153 个测试，**151 通过，2 失败**

---

## 目录

1. [审计发现总结](#审计发现总结)
2. [Phase 1：P0 阻断修复](#phase-1p0-阻断修复)
3. [Phase 2：P1 错误处理加固](#phase-2p1-错误处理加固)
4. [Phase 3：P2 防御性编码](#phase-3p2-防御性编码)
5. [可选改进](#可选改进)
6. [验证清单](#验证清单)

---

## 审计发现总结

| 类别 | 数量 | 优先级 |
|------|------|--------|
| 测试失败 | 2 | P0 |
| 安全性问题 | 5 | P0 |
| 错误处理缺陷 | 5 | P1 |
| 资源管理问题 | 2 | P1 |
| process.env 缺失保护 | 1 | P1 |
| 代码质量 / 防御编码 | 4 | P2 |
| 前端健壮性 | 2 | P2 |
| **合计** | **21** | |

---

## Phase 1：P0 阻断修复

### 1.1 修复失败的测试

**文件**：`test/mobile-responsive.test.js`

**现象**：
- 第 19 行：期望 `public/js/app.js` 包含 `_syncMobileViewportState`，但该方法已在重构中移除
- 第 40 行：期望 `public/js/tools/seating-planner.js` 包含 `selectedSeatForTouch`，但该属性已在重构中移除

**原因**：测试用 `fs.readFileSync` 读取源码后做 regex 匹配，硬编码了已过时的标识符。

**修复方案**：
```diff
# test/mobile-responsive.test.js

# 第一个测试：将 _syncMobileViewportState 替换为当前 app.js 中实际存在的移动端相关标识
# 查看 app.js 确认当前的移动端入口方法名，更新 regex

# 第二个测试：将 selectedSeatForTouch 替换为当前 seating-planner.js 中实际存在的触摸相关标识
# 查看 seating-planner.js 确认当前的触摸交互属性名，更新 regex
```

**验证**：`node --test test/mobile-responsive.test.js`

---

### 1.2 流式聊天接口缺少校验和超时

**文件**：`services/chat/chat-handler.js`，`handleChatStream` 函数（第 108-167 行）

**问题**：
1. 无消息长度校验 — 攻击者可发送超大 payload
2. 无 `AbortController` 超时 — 请求可无限挂起
3. 无客户端断连检测 — 客户端断开后后端仍在消费 API tokens

**修复方案**：
```javascript
// services/chat/chat-handler.js — handleChatStream

export async function handleChatStream(req, res) {
    try {
        const { message, messages = [] } = req.body;

        // ===== 新增：输入校验 =====
        const maxMessageLength = 10000;
        if (message && message.length > maxMessageLength) {
            return res.status(400).json({
                success: false,
                error: `消息过长，请限制在 ${maxMessageLength} 字符以内`
            });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // ===== 新增：过滤 messages 角色 =====
        const safeMessages = (messages || [])
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-20);

        const chatMessages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...safeMessages,
        ];

        if (message) {
            chatMessages.push({ role: 'user', content: message });
        }

        // ===== 新增：超时控制 =====
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

        // ===== 新增：客户端断连检测 =====
        let clientClosed = false;
        req.on('close', () => {
            clientClosed = true;
            controller.abort();
        });

        try {
            const response = await fetch(`${process.env.DEEPSEEK_API_BASE}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
                },
                body: JSON.stringify({
                    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
                    messages: chatMessages,
                    temperature: 0.7,
                    max_tokens: 2048,
                    stream: true
                }),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                res.write(`data: ${JSON.stringify({ error: 'API Error' })}\n\n`);
                res.end();
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                if (clientClosed) break; // ← 提前退出
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                res.write(chunk);
            }

            res.write('data: [DONE]\n\n');
            res.end();
        } catch (fetchError) {
            clearTimeout(timeout);
            if (fetchError.name === 'AbortError' && clientClosed) {
                // 客户端主动断开，静默处理
                return;
            }
            throw fetchError;
        }

    } catch (error) {
        console.error('[Chat Handler] Stream Error:', error);
        if (!res.headersSent) {
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        }
        res.end();
    }
}
```

---

### 1.3 handleChat 的 messages 透传注入

**文件**：`services/chat/chat-handler.js`，`handleChat` 函数（第 40-43 行）

**问题**：客户端可发送 `role: 'system'` 的消息覆盖系统 prompt。

**修复方案**：
```diff
  // services/chat/chat-handler.js — handleChat 第 40-47 行

- const chatMessages = [
-     { role: 'system', content: SYSTEM_PROMPT },
-     ...messages,
- ];
+ // 过滤客户端消息：只允许 user/assistant，防止 system prompt 注入
+ const safeMessages = messages
+     .filter(m => m.role === 'user' || m.role === 'assistant')
+     .slice(-20); // 限制历史长度
+
+ const chatMessages = [
+     { role: 'system', content: SYSTEM_PROMPT },
+     ...safeMessages,
+ ];
```

---

### 1.4 意图路由泄露内部错误信息

**文件**：`gateway/middleware/intent-router.js`，`routeToService` 函数（第 89-93 行）

**问题**：`error.message` 直接返回客户端，可能暴露内部路径、堆栈、凭据信息。

**修复方案**：
```diff
  // gateway/middleware/intent-router.js — routeToService catch 块

  } catch (error) {
      console.error(`[Intent Router] Service error (${intent}):`, error);
      res.status(500).json({
          success: false,
-         error: `服务调用失败: ${error.message}`
+         error: '服务暂时不可用，请稍后重试'
      });
  }
```

---

### 1.5 solver base64 写入无大小验证

**文件**：`services/solver/solver-handler.js`（第 39-47 行）

**问题**：直接 `Buffer.from(base64Data, 'base64')` 写磁盘，无大小限制。

**修复方案**：
```diff
  // services/solver/solver-handler.js — handleSolve

  if (imageBase64) {
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
+
+     // 限制 base64 decoded 大小（约 20MB）
+     if (base64Data.length > 28 * 1024 * 1024) {
+         return res.status(400).json({
+             success: false,
+             error: '图片过大，请压缩后重试（最大 20MB）'
+         });
+     }
+
      const buffer = Buffer.from(base64Data, 'base64');
+
+     // 验证确实是合法图片
+     try {
+         const sharp = (await import('sharp')).default;
+         await sharp(buffer).metadata();
+     } catch {
+         return res.status(400).json({
+             success: false,
+             error: '无法识别的图片格式'
+         });
+     }
+
      const uploadDir = path.join(__dirname, '../../uploads');
```

---

## Phase 2：P1 错误处理加固

### 2.1 seating/chat 和 seating/plan 缺少 response.ok 检查

**文件**：`gateway/routes/tools.js`

**位置 1**：第 598-606 行（seating/chat）
```diff
+ if (!response.ok) {
+     const errBody = await response.json().catch(() => ({}));
+     throw new Error(errBody.error?.message || `AI API 返回 ${response.status}`);
+ }
+
  const data = await response.json();
  if (!data.choices?.[0]?.message?.content) {
      throw new Error('AI 返回为空');
  }
```

**位置 2**：第 296-300 行（seating/plan）
```diff
+ if (!response.ok) {
+     const errBody = await response.json().catch(() => ({}));
+     throw new Error(errBody.error?.message || `AI API 返回 ${response.status}`);
+ }
+
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 无响应');
```

---

### 2.2 siliconflow.js JSON.parse 无保护

**文件**：`services/solver/siliconflow.js`

**位置 1**：第 98 行（`detectWithQwenGrounding`）
```diff
- const parsed = JSON.parse(match[0]);
+ let parsed;
+ try {
+     parsed = JSON.parse(match[0]);
+ } catch {
+     return null;
+ }
```

**位置 2**：第 148 行（`detectWithFallbackAPI`）
```diff
- const parsed = JSON.parse(match[0]);
+ let parsed;
+ try {
+     parsed = JSON.parse(match[0]);
+ } catch {
+     return null;
+ }
```

---

### 2.3 solver-handler Vision & OCR 注释修正

**文件**：`services/solver/solver-handler.js`（第 68-71 行）

**问题**：注释说 "并行执行" 但实际是顺序 `await`。

```diff
- // Step 1: Vision Description & OCR (并行执行)
+ // Step 1: Vision Description → OCR (顺序执行，OCR 依赖视觉描述)
  console.log('-> Vision & OCR');
  visionResult = await describeImageWithVision(imagePath);
  ocrResult = await extractTextWithVisionOCR(imagePath, visionResult.description || '');
```

---

### 2.4 environment.js 添加 DEEPSEEK_API_BASE 缺失警告

**文件**：`gateway/config/environment.js`，`validateGatewayEnv` 函数（第 30-48 行）

**问题**：`DEEPSEEK_API_BASE` 未配置时，多处代码会拼出 `undefined/chat/completions` 的 URL。

```diff
  export function validateGatewayEnv(env = process.env, logger = console) {
      const warnings = [];

+     if (!env.DEEPSEEK_API_BASE) {
+         warnings.push('DEEPSEEK_API_BASE is missing. Chat, Manim, and Solver features will not work.');
+     }
+
      if (!env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY.includes('your_')) {
          warnings.push('DEEPSEEK_API_KEY is missing or still uses a placeholder value.');
      }
```

---

## Phase 3：P2 防御性编码

### 3.1 security.js — 限流器与 CORS 注释补充

**文件**：`gateway/security.js`

**限流器**（第 97-101 行）：
```diff
+ // 惰性清理：仅当 Map 超过 10k 条时才扫描过期条目。
+ // 对于中小流量场景足够；高并发部署建议替换为 redis 限流。
  if (hits.size > 10000) {
      for (const [hitKey, value] of hits) {
          if (value.resetAt <= now) hits.delete(hitKey);
      }
  }
```

**CORS**（第 129-131 行）：
```diff
  origin(origin, callback) {
+     // 无 origin = 同源请求、服务端调用、curl 等，允许通过。
+     // 生产环境如需严格限制，可改为 callback(new Error('Origin required'))。
      if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
      }
```

---

### 3.2 ocr.js — JSON.parse 保护

**文件**：`gateway/services/ocr.js`

**位置 1**：第 90 行（`extractStudentsDirectVLM`）
```diff
- const students = JSON.parse(content);
+ let students;
+ try {
+     students = JSON.parse(content);
+ } catch {
+     throw new Error('VLM 返回了无法解析的 JSON');
+ }
```

**位置 2**：第 330-338 行（`extractStudentsWithAI`）— 此处已有 try-catch，无需修改。

---

### 3.3 chat-handler.js — 逻辑表达式优先级

**文件**：`services/chat/chat-handler.js`（第 23 行）

```diff
- if (!message && messages.length === 0) {
+ if (!message && (!messages || messages.length === 0)) {
```

---

### 3.4 前端 localStorage 异常保护（可选）

**文件**：`public/js/app.js`

**位置**：`_initTheme` 和 `_toggleTheme` 方法中的 `localStorage` 调用

```diff
  _initTheme() {
-     const savedTheme = localStorage.getItem('theme');
+     let savedTheme;
+     try { savedTheme = localStorage.getItem('theme'); } catch { /* 隐私模式 */ }
      if (savedTheme === 'light') {
          document.body.classList.add('light-mode');
      }
  }

  _toggleTheme() {
      document.body.classList.toggle('light-mode');
      const isLight = document.body.classList.contains('light-mode');
-     localStorage.setItem('theme', isLight ? 'light' : 'dark');
+     try { localStorage.setItem('theme', isLight ? 'light' : 'dark'); } catch { /* 存储满或隐私模式 */ }
  }
```

---

## 可选改进（不在本次范围内，记录 TODO）

| 编号 | 改进项 | 位置 | 说明 |
|------|--------|------|------|
| OPT-1 | 拆分 `tools.js` | `gateway/routes/tools.js` (680行) | 将 seating 相关路由独立为 `routes/seating.js` |
| OPT-2 | 收拢散落的 `dotenv` | `gateway/services/ocr.js:7`、`services/solver/config.js:8` | 统一到 `gateway/config/environment.js` |
| OPT-3 | 提取内联 prompt | `gateway/routes/tools.js:530-579` | seating/chat 的 50 行系统 prompt 提取到 `seating-chat.js` |
| OPT-4 | 前端统一 fetch 封装 | `public/js/app.js` | 通过 `api_client.js` 添加默认超时 |
| OPT-5 | MinerU 轮询可取消 | `gateway/services/ocr.js:225-283` | 接受 `AbortSignal` 参数 |

---

## 验证清单

### 修复后执行

```bash
# 1. 运行全部测试，预期 153/153 通过
npm test

# 2. 启动开发服务器
dev.bat

# 3. 手动验证核心功能
# - 聊天模式：发送消息，收到回复
# - 解题模式：上传图片解题
# - Manim 模式：描述动画并生成
# - 座位规划器：导入学生、生成排座、AI 微调对话
# - 流式聊天：验证超时和断连不会崩溃

# 4. 安全回归
# - 发送超长消息（>10000字符），预期被拒绝
# - 发送含 system 角色的 messages 数组，预期被过滤
# - 发送超大 base64 图片，预期被拒绝
```

### 各文件修改摘要

| 文件 | 修改类型 | Phase |
|------|----------|-------|
| `test/mobile-responsive.test.js` | 更新过时 regex 断言 | P0 |
| `services/chat/chat-handler.js` | 校验、超时、角色过滤、逻辑修正 | P0+P2 |
| `gateway/middleware/intent-router.js` | 错误信息脱敏 | P0 |
| `services/solver/solver-handler.js` | base64 限制、注释修正 | P0+P1 |
| `gateway/routes/tools.js` | response.ok 检查 | P1 |
| `services/solver/siliconflow.js` | JSON.parse 保护 | P1 |
| `gateway/config/environment.js` | 环境变量警告 | P1 |
| `gateway/security.js` | 注释补充 | P2 |
| `gateway/services/ocr.js` | JSON.parse 保护 | P2 |
| `public/js/app.js` | localStorage 保护 | P2 |
