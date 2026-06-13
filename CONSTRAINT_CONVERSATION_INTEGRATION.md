# 智能约束对话优化 - 集成指南

## 🎯 功能概述

**新增功能**: AI对话式约束优化

**解决的问题**:
- ❌ 用户看不懂技术约束（如"teacher_daily_limit"）
- ❌ 无法自然语言与AI交流
- ❌ 手动编辑门槛高

**现在用户可以**:
- ✅ 用自然语言说"张老师的课太多了"
- ✅ AI自动理解并调整约束
- ✅ 多轮对话直到满意

---

## 📦 新增文件

### 后端 (3个文件)

1. **gateway/services/timetable-constraint-conversation.js** (350行)
   - `TimetableConstraintConversation` 类
   - `explainConstraintToUser()` 约束解释器
   - AI对话管理

2. **gateway/routes/timetable-constraint-chat.js** (150行)
   - `POST /constraints/chat/init` - 初始化对话
   - `POST /constraints/chat/message` - 发送消息
   - `POST /constraints/chat/:id/finalize` - 完成对话

### 前端 (3个文件)

3. **public/css/timetable-chat.css** (300行)
   - 聊天UI样式
   - 消息气泡动画
   - 响应式设计

4. **public/js/tools/timetable/controller-chat-extension.js** (120行)
   - `startConstraintConversation()` - 开启对话
   - `sendConstraintChatMessage()` - 发送消息
   - `closeConstraintChat()` - 关闭对话

5. **public/js/tools/timetable/view-chat.js** (150行)
   - `renderConstraintChatDialog()` - 对话窗口
   - `renderChatMessage()` - 消息渲染
   - `renderConstraintOptimizeButton()` - 按钮

### 文档 (1个文件)

6. **CONSTRAINT_CONVERSATION_DESIGN.md** - 设计方案

---

## 🔧 集成步骤

### 1. 注册路由 (gateway/index.js)

```javascript
import timetableConstraintChatRouter from './routes/timetable-constraint-chat.js';

// ... 其他路由
app.use('/timetable', timetableConstraintChatRouter);
```

### 2. 引入CSS (public/timetable.html 或布局文件)

```html
<link rel="stylesheet" href="/css/timetable-chat.css">
```

### 3. 集成到controller (public/js/tools/timetable/controller.js)

```javascript
// 在文件开头导入
import {
    startConstraintConversation,
    sendConstraintChatMessage,
    closeConstraintChat,
    updateConstraintChatInput
} from './controller-chat-extension.js';

// 在TimetableController类中添加方法
class TimetableController {
    // ... 现有方法

    // 添加对话方法
    startConstraintConversation = startConstraintConversation.bind(this);
    sendConstraintChatMessage = sendConstraintChatMessage.bind(this);
    closeConstraintChat = closeConstraintChat.bind(this);
    updateConstraintChatInput = updateConstraintChatInput.bind(this);
}
```

### 4. 集成到view (public/js/tools/timetable/view.js)

```javascript
// 在文件开头导入
import {
    renderConstraintChatDialog,
    renderConstraintOptimizeButton
} from './view-chat.js';

// 在约束复核区域添加"与AI讨论"按钮
function renderRuleReview() {
    return `
        <div class="tt-rule-review">
            <!-- 现有内容 -->
            
            <div class="tt-action-bar">
                ${renderConstraintOptimizeButton()}
                <!-- 其他按钮 -->
            </div>
        </div>

        <!-- 在页面底部添加对话窗口 -->
        ${renderConstraintChatDialog(state)}
    `;
}
```

### 5. 配置AI API Key

在 `.env` 文件中添加：

```env
AI_API_KEY=your_anthropic_api_key
AI_BASE_URL=https://api.anthropic.com
```

---

## 🎨 用户交互流程

### 场景1: 调整教师课时

```
1. 用户点击"💬 与AI讨论优化"
2. AI欢迎: "我已经为您解析出5条排课约束..."
3. 用户输入: "张老师的课太多了"
4. AI回复: "张老师目前每天最多6节课。建议改为4节。确认吗？"
5. 用户: "确认"
6. AI: "✅ 已调整！张老师每天最多4节课。"
7. 用户: "可以了"
8. AI: "好的！约束优化完成。"
9. 用户点击"确认导入"完成
```

### 场景2: 询问约束含义

```
用户: "为什么王老师不能上第一节？"
AI: "因为您设置了'王老师不可用时间：周一第1节、周三第1节'。
     这意味着王老师在这些时段有其他安排。
     需要调整吗？"
```

### 场景3: 删除约束

```
用户: "去掉数学课必须上午的限制"
AI: "我找到了'数学优先安排在上午'这条约束。
     删除后，数学课可以安排到下午。确认删除吗？"
用户: "确认"
AI: "✅ 已删除约束。"
```

---

## 🧪 测试清单

### 后端测试

```javascript
// 测试初始化对话
POST /timetable/constraints/chat/init
{
  "constraints": [
    {
      "type": "teacher_daily_limit",
      "targetName": "张老师",
      "value": 6
    }
  ],
  "project": { /* project data */ }
}

// 预期返回
{
  "success": true,
  "data": {
    "conversationId": "conv_xxx",
    "welcomeMessage": "我已经为您解析出1条排课约束...",
    "constraints": [...]
  }
}

// 测试发送消息
POST /timetable/constraints/chat/message
{
  "conversationId": "conv_xxx",
  "message": "张老师的课太多了"
}

// 预期返回
{
  "success": true,
  "data": {
    "message": "张老师目前每天最多6节课...",
    "constraints": [...],  // 可能已修改
    "completed": false
  }
}
```

### 前端测试

1. **打开对话窗口**
   - 点击"与AI讨论优化"按钮
   - 应显示对话窗口
   - 应显示AI欢迎消息

2. **发送消息**
   - 输入"张老师的课太多了"
   - 按Enter或点击发送
   - 应显示用户消息和AI回复

3. **关闭对话**
   - 点击X按钮或遮罩层
   - 对话窗口应关闭

4. **响应式布局**
   - 在手机屏幕上测试
   - 对话窗口应全屏显示

---

## 🚀 性能优化

### 1. 对话会话管理

**当前**: 内存Map (开发环境OK)
**生产环境**: 使用Redis

```javascript
// gateway/services/timetable-constraint-conversation.js
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

// 保存对话
await redis.setex(
    `conversation:${conversationId}`,
    600, // 10分钟过期
    JSON.stringify(conversation)
);

// 读取对话
const data = await redis.get(`conversation:${conversationId}`);
const conversation = JSON.parse(data);
```

### 2. AI响应缓存

对常见问题缓存响应：

```javascript
const cache = new Map();
const cacheKey = `${message}_${constraintsHash}`;

if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
}

const response = await callAI(...);
cache.set(cacheKey, response);
```

### 3. 流式响应

使用SSE实现打字机效果：

```javascript
// 后端
res.setHeader('Content-Type', 'text/event-stream');
const stream = await openai.chat.completions.create({
    stream: true,
    ...
});

for await (const chunk of stream) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

// 前端
const eventSource = new EventSource('/constraints/chat/stream');
eventSource.onmessage = (event) => {
    const chunk = JSON.parse(event.data);
    appendToMessage(chunk.content);
};
```

---

## 📊 监控指标

### 关键指标

1. **对话完成率**: 开始对话 → 点击"可以了" 的比例
   - 目标: >80%

2. **平均对话轮数**: 用户满意前的消息数
   - 目标: 3-5轮

3. **AI理解准确率**: 用户是否重复相同请求
   - 目标: >85%

4. **响应时间**: AI回复延迟
   - 目标: <3秒

### 日志记录

```javascript
// 记录对话数据用于优化
logger.info('constraint_conversation', {
    conversationId,
    userMessage,
    aiResponse,
    constraintsModified: true/false,
    roundNumber: 3,
    responseTime: 1234,
    completed: false
});
```

---

## 🐛 常见问题

### Q1: AI响应"智能对话功能未配置API Key"

**解决**: 
```bash
# .env
AI_API_KEY=sk-ant-xxx
```

### Q2: 对话会话过期

**原因**: 默认10分钟过期
**解决**: 提示用户重新开始或延长过期时间

### Q3: AI理解不准确

**优化**: 
- 改进系统提示词
- 添加Few-shot示例
- 增加上下文信息

### Q4: 响应太慢

**优化**:
- 使用更快的模型（haiku）
- 减少max_tokens
- 实现流式响应

---

## 🎯 后续增强

### Phase 2 功能

1. **语音输入**
   - Web Speech API
   - 语音转文字

2. **多语言支持**
   - 英文、中文切换
   - 自动检测语言

3. **约束模板库**
   - 常用约束快速应用
   - 学校案例分享

4. **智能推荐**
   - 主动发现问题
   - 提出优化建议

5. **对话历史**
   - 保存历史对话
   - 回溯修改记录

---

## ✅ 验收标准

- [ ] 后端API正常响应
- [ ] 前端UI显示正常
- [ ] 能成功发送和接收消息
- [ ] AI能理解基本意图
- [ ] 约束修改能生效
- [ ] 对话能正常完成
- [ ] 响应时间<5秒
- [ ] 移动端布局正常
- [ ] 错误处理完善

---

## 📝 更新记录

- 2026-06-13: 初始版本完成
  - 核心对话功能
  - 约束解释器
  - 意图识别
  - 前端UI组件

---

**开发者**: Claude Opus 4.8  
**状态**: ✅ 核心功能已实现，待集成测试
