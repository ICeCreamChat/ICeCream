/**
 * ICeCream - 消息处理模块
 * 处理消息发送、渲染和 API 通信
 */

import { escapeHtml, dataURLtoBlob, devLog, showToast } from '../utils/helpers.js';
import { renderMarkdown, renderMath } from '../utils/markdown.js';
import { modeSwitcher } from './mode-switcher.js';
import { intentConfirm } from './intent-confirm.js';
import { geogebraWorkbench } from './geogebra-workbench.js';
import { getAnimationEngine, setAnimationEngine } from './animation-engine-state.js';
import { sessionManager } from './session-manager.js';

/**
 * 消息处理器类
 */
class MessageHandler {
    constructor() {
        this.elements = {
            messages: null,
            welcomeScreen: null,
            loading: null,
            loadingText: null,
            chatInput: null,
            sendBtn: null
        };
        this.isLoading = false;
        this.pendingImage = null;
        this.onMessageAdded = null;
        this.manimWorkbench = null;
        this.geogebraStudioShell = null;
        this.manimProcess = null;
        this.manimAutoScrollLockedUntil = 0;
        this.taskSwitchPrompt = null;
        this.pendingTaskSwitch = null;
        this.lastSubmittedMessage = '';
    }

    /**
     * 初始化消息处理器
     * @param {Object} options - 配置选项
     * @param {Function} options.onMessageAdded - 消息添加回调
     */
    /**
     * 初始化消息处理器
     * @param {Object} options - 配置选项
     * @param {Function} options.onMessageAdded - 消息添加回调
     * @param {Object} options.codePanel - 代码面板实例
     */
    init(options = {}) {
        this.elements.messages = document.getElementById('messages');
        this.elements.welcomeScreen = document.getElementById('welcome-screen');
        this.elements.loading = document.getElementById('loading');
        this.elements.loadingText = document.getElementById('loading-text');
        this.elements.chatInput = document.getElementById('chat-input');
        this.elements.sendBtn = document.getElementById('send-btn');

        this.onMessageAdded = options.onMessageAdded || null;
        this.codePanel = options.codePanel || null;
        this.manimWorkbench = options.manimWorkbench || null;
        this.geogebraStudioShell = options.geogebraStudioShell || null;

        this._bindEvents();
    }



    /**
     * 处理 Manim 动画响应
     * @private
     */
    _handleManimResponse(data, mount = null) {
        if (mount?.contentDiv && mount?.messageDiv) {
            this.renderManimResultContent(data, mount.contentDiv, mount.messageDiv);
            mount.messageDiv.classList.add('has-result');
            if (!mount.preserveScroll) {
                this.scrollMessagesToBottom({ force: Boolean(mount.forceScroll) });
            }
            return;
        }

        // 创建消息容器
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message bot';

        // Avatar (Direct Img like MathSpace)
        const avatarDiv = document.createElement('div');
        avatarDiv.className = 'message-avatar';
        avatarDiv.innerHTML = '<img src="/images/bot-avatar.jpg" alt="AI">';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        this.renderManimResultContent(data, contentDiv, messageDiv);

        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(contentDiv);
        this.elements.messages?.appendChild(messageDiv);

        this.scrollMessagesToBottom({ force: true });
    }

    renderManimResultContent(data, contentDiv, messageDiv) {
        const ensureMessageId = () => {
            if (!messageDiv.id) {
                messageDiv.id = 'msg-' + Date.now();
            }
            return messageDiv.id;
        };

        // 添加视频或错误提示
        if (data.rendered && (data.videoUrl || data.videoBase64)) {
            const videoId = 'vid_' + Date.now();
            const videoUrl = data.videoUrl || `data:video/mp4;base64,${data.videoBase64}`;

            // 注册到 CodePanel
            if (this.codePanel) {
                const manifestBundle = {
                    sceneManifest: data.sceneManifest || data.agentTrace?.sceneManifest || null,
                    runtimeSceneManifest: data.runtimeSceneManifest || data.agentTrace?.runtimeSceneManifest || data.agentTrace?.sceneManifest || null,
                    studioFrameSet: data.studioFrameSet || data.agentTrace?.studioFrameSet || null,
                    recommendedFrameId: data.recommendedFrameId || data.agentTrace?.recommendedFrameId || null,
                };
                this.codePanel.registerVideo(videoId, data.code || '', videoUrl, manifestBundle);
            }

            const videoLabel = document.createElement('div');
            videoLabel.className = 'manim-result-heading';
            videoLabel.innerHTML = '<strong>作品预览</strong><span>渲染完成，可查看代码继续打磨</span>';
            contentDiv.appendChild(videoLabel);

            // 使用 video-container 包装视频 (匹配 MathSpace_Version 样式)
            const msgId = ensureMessageId();

            const videoContainer = document.createElement('div');
            videoContainer.className = 'video-container manim-result-video';
            videoContainer.dataset.videoId = videoId;

            const video = document.createElement('video');
            video.src = videoUrl;
            video.controls = true;
            video.autoplay = true;
            video.loop = true;
            video.muted = true;
            videoContainer.appendChild(video);

            const videoInfo = document.createElement('div');
            videoInfo.className = 'video-info';
            videoInfo.innerHTML = '<span>DeepSeek V3</span><span>ManimGL</span>';
            videoContainer.appendChild(videoInfo);

            const videoActions = document.createElement('div');
            videoActions.className = 'video-actions';
            videoActions.innerHTML = `<button class="video-action-btn view-code-btn" data-video-id="${videoId}">查看代码</button>`;
            videoContainer.appendChild(videoActions);

            contentDiv.appendChild(videoContainer);

            // Bind Event
            setTimeout(() => {
                const btn = videoContainer.querySelector('.view-code-btn');
                if (btn && this.codePanel) {
                    btn.addEventListener('click', () => this.codePanel.open(videoId, msgId));
                }
            }, 0);

        } else if (data.error) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'manim-result-error';
            errorDiv.innerHTML = renderMarkdown(`**渲染提示：** ${this.localizeManimError(data.error)}`);
            contentDiv.appendChild(errorDiv);
        } else if (data.code) {
            // Case: Code generated but not rendered; show the real agent warning if available.
            const warning = this.localizeManimText(data.warning || data.agentTrace?.failureReason || '代码已生成，但尚未生成视频。');
            const trace = data.agentTrace || {};
            const staticQuality = trace.quality?.static || {};
            const issueLines = Array.isArray(staticQuality.issues)
                ? staticQuality.issues.slice(0, 3).map(item => {
                    const message = this.localizeManimText(item.message || '');
                    const hint = this.localizeManimText(item.hint || '');
                    return message ? `- ${message}${hint ? `（建议：${hint}）` : ''}` : '';
                }).filter(Boolean)
                : [];
            const repairCount = trace.repairs && typeof trace.repairs.count === 'number'
                ? `\n\n修复次数：${trace.repairs.count}`
                : '';
            const issueBlock = issueLines.length
                ? `\n\n静态检查发现：\n${issueLines.join('\n')}`
                : '';
            const codeDiv = document.createElement('div');
            codeDiv.className = 'manim-result-code';
            codeDiv.innerHTML = renderMarkdown(`**已生成代码**\n\n${warning}${issueBlock}${repairCount}\n\n\`\`\`python\n${data.code.substring(0, 500)}${data.code.length > 500 ? '...' : ''}\n\`\`\`\n\n> 可以点击“查看代码”或在代码面板里继续修改后重新渲染。`);
            contentDiv.appendChild(codeDiv);
            console.log('[Manim] Code generated without render:', data);
        } else {
            // Fallback: Unknown response structure
            const fallbackDiv = document.createElement('div');
            fallbackDiv.className = 'manim-result-error';
            fallbackDiv.innerHTML = renderMarkdown(`⚠️ 收到响应但格式异常，请检查控制台日志。`);
            contentDiv.appendChild(fallbackDiv);
            console.error('[Manim] Unexpected response structure:', data);
        }

        // 渲染数学公式
        setTimeout(() => renderMath(contentDiv), 0);

        // 刷新图标
        if (window.lucide) {
            setTimeout(() => window.lucide.createIcons(), 0);
        }
    }

    /**
     * 绑定事件
     * @private
     */
    _bindEvents() {
        // 发送按钮点击
        this.elements.sendBtn?.addEventListener('click', () => this.handleSend());

        // 回车发送
        this.elements.chatInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSend();
            }
        });

        this.bindMessagesUserScrollGuard();
    }

    bindMessagesUserScrollGuard() {
        const messages = this.elements.messages;
        if (!messages) return;

        const lock = () => this.lockManimAutoScroll();
        messages.addEventListener('wheel', lock, { passive: true });
        messages.addEventListener('touchmove', lock, { passive: true });
        messages.addEventListener('pointerdown', lock, { passive: true });
        messages.addEventListener('scroll', () => {
            if (this.isMessagesNearBottom(24)) {
                this.manimAutoScrollLockedUntil = 0;
            }
        }, { passive: true });
    }

    getTaskLabel(mode = '') {
        const map = {
            auto: '问答',
            chat: '问答',
            manim: '动画',
            solver: '解题',
        };
        return map[mode] || mode || '问答';
    }

    looksLikeSolverRequest(message = '', hasImage = false) {
        const text = String(message || '').trim();
        if (hasImage && /(解|答案|题|作业|证明|求|算|步骤|怎么做|帮我看)/.test(text)) {
            return true;
        }
        return /(解这|解题|这道题|求解|求答案|答案|证明一下|证明题|计算题|选择题|填空题|作业|怎么做|怎么算|化简|方程|应用题|题目)/.test(text);
    }

    looksLikeManimRequest(message = '') {
        const text = String(message || '').trim().toLowerCase();
        return /(动画|manim|可视化|演示|生成.*图|画一个|画个|绘制|展示.*过程|做一个.*动画|分步骤讲解动画|流程图|函数图像|曲线|运动轨迹)/i.test(text);
    }

    looksLikeGeoGebraRequest(message = '') {
        return geogebraWorkbench.looksLikeGeoGebraRequest(message);
    }

    getCrossTaskTarget(currentMode, message, hasImage = false) {
        if (currentMode === 'manim' && this.looksLikeSolverRequest(message, hasImage)) {
            return 'solver';
        }
        if (currentMode === 'manim' && hasImage) {
            return 'solver';
        }
        if (currentMode === 'solver' && this.looksLikeManimRequest(message) && !this.looksLikeSolverRequest(message, hasImage)) {
            return 'manim';
        }
        return null;
    }

    ensureTaskSwitchPrompt() {
        if (this.taskSwitchPrompt) return this.taskSwitchPrompt;

        const inputArea = document.querySelector('.input-area');
        if (!inputArea) return null;

        const prompt = document.createElement('div');
        prompt.className = 'task-switch-prompt hidden';
        prompt.setAttribute('role', 'status');
        inputArea.insertBefore(prompt, inputArea.firstChild);
        this.taskSwitchPrompt = prompt;
        return prompt;
    }

    showTaskSwitchPrompt(data = {}) {
        const prompt = this.ensureTaskSwitchPrompt();
        if (!prompt) return;

        this.pendingTaskSwitch = data;
        const targetLabel = this.getTaskLabel(data.targetMode);
        const currentLabel = this.getTaskLabel(data.currentMode);

        prompt.classList.remove('hidden');
        prompt.innerHTML = `
                <div class="task-switch-copy">
                    <strong>看起来这是${targetLabel}请求，要切到${targetLabel}吗？</strong>
                    <span>当前选择的是${currentLabel}，切换后会在同一个对话里继续处理。</span>
                </div>
                <div class="task-switch-actions">
                    <button type="button" class="task-switch-btn primary" data-action="switch">切到${targetLabel}</button>
                    <button type="button" class="task-switch-btn" data-action="stay">仍按${currentLabel}处理</button>
                    <button type="button" class="task-switch-btn ghost" data-action="cancel">取消</button>
                </div>
            `;

        prompt.querySelectorAll('[data-action]').forEach(button => {
            button.addEventListener('click', () => this.handleTaskSwitchAction(button.dataset.action));
        });

        if (window.lucide) {
            setTimeout(() => window.lucide.createIcons(), 0);
        }
    }

    clearTaskPrompts() {
        if (this.taskSwitchPrompt) {
            this.taskSwitchPrompt.classList.add('hidden');
            this.taskSwitchPrompt.innerHTML = '';
        }
        this.pendingTaskSwitch = null;
    }

    handleTaskSwitchAction(action) {
        const pending = this.pendingTaskSwitch;
        if (!pending) return;

        if (action === 'cancel') {
            this.clearTaskPrompts();
            return;
        }

        if (action === 'switch') {
            modeSwitcher.setMode(pending.targetMode, true);
            this.clearTaskPrompts();
            this.handleSend({
                routeMode: pending.targetMode,
                skipRouteGuard: true,
                messageOverride: pending.message || '',
            });
            return;
        }

        if (action === 'stay') {
            this.clearTaskPrompts();
            this.handleSend({
                routeMode: pending.currentMode,
                skipRouteGuard: true,
                messageOverride: pending.message || '',
            });
            return;
        }
    }

    /**
     * 处理发送消息
     */
    async handleSend(options = {}) {
        const messageOverride = typeof options.messageOverride === 'string' ? options.messageOverride : '';
        const message = (messageOverride || this.elements.chatInput?.value || '').trim();

        if (!message && !this.pendingImage) {
            return;
        }
        if (message) {
            this.lastSubmittedMessage = message;
        }

        const selectedMode = options.routeMode || modeSwitcher.getMode();
        const hasImage = Boolean(this.pendingImage);
        const chatContext = this.getChatContextForSend(selectedMode, message, hasImage);

        if (!options.skipRouteGuard) {
            const targetMode = this.getCrossTaskTarget(selectedMode, message, hasImage);
            if (targetMode) {
                this.showTaskSwitchPrompt({
                    targetMode,
                    currentMode: selectedMode,
                    message,
                    type: 'task-switch',
                });
                return;
            }
        }

        this.clearTaskPrompts();
        const originalImage = this.pendingImage;
        let imageForServer = originalImage;

        // 清空输入框
        if (this.elements.chatInput) {
            this.elements.chatInput.value = '';
        }

        // 隐藏欢迎屏幕
        this.hideWelcomeScreen();

        // 添加用户消息
        this.addMessage('user', message, originalImage);

        // 显示加载状态
        this.setLoading(true);

        try {
            const mode = selectedMode;
            const animationEngine = getAnimationEngine();
            const shouldUseGeoGebra = !imageForServer && (
                (mode === 'manim' && animationEngine === 'geogebra') ||
                (mode === 'auto' && this.looksLikeGeoGebraRequest(message))
            );

            if (shouldUseGeoGebra) {
                if (mode === 'auto') {
                    modeSwitcher.setMode('manim', false);
                    this.manimWorkbench?.setMode?.('manim');
                }
                setAnimationEngine('geogebra');
                this.geogebraStudioShell?.open?.();
                await this.runGeoGebraPlan(message);
                return;
            }

            const shouldUseAgent = !imageForServer && (
                mode === 'manim' || (mode === 'auto' && await this.shouldUseManimAgent(message))
            );

            if (shouldUseAgent) {
                if (mode === 'auto') {
                    modeSwitcher.setMode('manim', false);
                    this.manimWorkbench?.setMode?.('manim');
                }
                const workbenchOptions = this.manimWorkbench?.getAgentOptions?.() || {};
                const referenceImageIds = Array.from(new Set([
                    ...(workbenchOptions.referenceImageIds || []),
                ].filter(Boolean)));
                await this.sendManimAgentStream({
                    message,
                    mode: 'create',
                    ...workbenchOptions,
                    referenceImageIds,
                });
                return;
            }

            const response = await this.sendToServer(message, imageForServer, mode, chatContext);

            if (response.needConfirmation) {
                // Attach the pending image to the data passed to intentConfirm so it can be re-sent
                response.originalMessage = message;
                response.originalImage = imageForServer;
                intentConfirm.show(response);
            } else {
                this.handleResponse(response, imageForServer);
            }
        } catch (error) {
            console.error('Send error:', error);
            if (!error.manimProcessHandled) {
                this.addMessage('bot', `抱歉，发生了错误：${error.message}`);
            }
            showToast(error.message, 'error');
        } finally {
            this.setLoading(false);
            this.pendingImage = null;
        }
    }

    async runGeoGebraPlan(message) {
        const outcome = await geogebraWorkbench.runGeoGebraPlan(message);
        geogebraWorkbench.refreshVisiblePanel();
        this.addMessage('bot', geogebraWorkbench.formatChatReply(outcome));
    }

    getChatContextForSend(mode, message = '', hasImage = false) {
        if (hasImage) return [];
        if (!(mode === 'chat' || mode === 'auto')) return [];
        if (mode === 'auto' && (
            this.looksLikeSolverRequest(message, false) ||
            this.looksLikeManimRequest(message) ||
            this.looksLikeGeoGebraRequest(message)
        )) {
            return [];
        }
        return sessionManager.getChatContext();
    }

    /**
     * 发送消息到服务器
     * @param {string} message - 消息内容
     * @param {string|null} imageBase64 - 图片 Base64 数据
     * @param {string|null} modeOverride - 本次发送使用的任务模式
     * @returns {Promise<Object>} 服务器响应
     */
    async sendToServer(message, imageBase64 = null, modeOverride = null, chatContext = []) {
        const mode = modeOverride || modeSwitcher.getMode();
        devLog.info('发送消息', { mode, msgLen: message.length, hasImage: !!imageBase64 });

        const formData = new FormData();
        formData.append('message', message);

        if (mode !== 'auto') {
            formData.append('mode', mode);
        }

        if (
            !imageBase64 &&
            (mode === 'chat' || mode === 'auto') &&
            Array.isArray(chatContext) &&
            chatContext.length > 0
        ) {
            formData.append('messages', JSON.stringify(chatContext));
        }

        if (imageBase64) {
            const blob = dataURLtoBlob(imageBase64);
            formData.append('image', blob, 'image.png');
            devLog.log('图片已附加');
        }

        const response = await fetch('/api/message', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Request failed');
        }

        return response.json();
    }

    getLastSubmittedMessage() {
        return this.lastSubmittedMessage || '';
    }

    /**
     * Auto 模式下的轻量 Manim 意图识别。
     * @param {string} message
     * @returns {Promise<boolean>}
     */
    async shouldUseManimAgent(message) {
        try {
            const response = await fetch('/api/manim/intent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message })
            });

            if (!response.ok) return false;
            const data = await response.json();
            return data.success && data.intent === 'manim' && (data.confidence >= 0.6 || !!data.clarification);
        } catch (error) {
            console.warn('[Manim Agent] intent check failed:', error);
            return false;
        }
    }

    /**
     * 调用 Manim Agent 流式接口。
     * @param {Object} payload
     */
    async sendManimAgentStream(payload, options = {}) {
        const clientId = localStorage.getItem('icecream_client_id') || 'main_chat';
        if (options.reuseProcess && this.manimProcess) {
            this.restartManimProcessInPlace(payload.message || this.manimProcess.prompt || '', {
                selectedOption: options.selectedOption || this.manimProcess.clarification?.selectedOption || '',
            });
        } else {
            this.createManimProcessBubble(payload.message || '');
        }
        this.setManimBottomLoadingVisible(false);

        let response;
        try {
            response = await fetch('/api/manim/agent/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: payload.message,
                    mode: payload.mode || 'create',
                    currentCode: payload.currentCode || '',
                    clientId,
                    skillIds: payload.skillIds || [],
                    referenceImageIds: payload.referenceImageIds || [],
                    jobId: payload.jobId || ''
                })
            });
        } catch (error) {
            const message = this.localizeManimError(error);
            this.updateManimProcessFromEvent({
                type: 'error',
                error: message,
            });
            const connectionError = new Error(message);
            connectionError.manimProcessHandled = true;
            throw connectionError;
        }

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            this.updateManimProcessFromEvent({
                type: 'error',
                error: this.localizeManimError(error.error || 'Manim Agent 请求失败'),
            });
            const requestError = new Error(this.localizeManimError(error.error || 'Manim Agent 请求失败'));
            requestError.manimProcessHandled = true;
            throw requestError;
        }

        let finalResult = null;
        try {
            await this.readNdjsonStream(response, (event) => {
                if (event.type === 'clarification') {
                    this.updateManimProcessFromEvent({ type: 'clarification', clarification: event.clarification });
                } else {
                    this.updateManimProcessFromEvent(event);
                }
                this.manimWorkbench?.handleAgentEvent?.(event);

                if (event.type === 'job') {
                    this.latestManimJob = event.job;
                } else if (event.type === 'progress') {
                    return;
                } else if (event.type === 'plan') {
                    this.latestManimPlan = event.brief;
                } else if (event.type === 'reference') {
                    this.latestManimReferences = event.references || [];
                } else if (event.type === 'patch_plan') {
                    this.latestManimPatchPlan = event.patchPlan;
                } else if (event.type === 'design') {
                    this.latestManimDesign = event.design;
                } else if (event.type === 'storyboard') {
                    this.latestManimStoryboard = event.storyboard || [];
                } else if (event.type === 'style') {
                    this.latestManimStyle = event.style;
                } else if (event.type === 'skill_activation') {
                    this.latestManimSkills = event.skills || [];
                } else if (event.type === 'skills') {
                    this.latestManimSkills = event.skills || [];
                } else if (event.type === 'cache') {
                    this.latestManimCache = event;
                } else if (event.type === 'inspect') {
                    return;
                } else if (event.type === 'static_guard') {
                    this.latestManimStaticGuard = event.guard;
                } else if (event.type === 'critic_report') {
                    this.latestManimCriticReport = event.critic;
                } else if (event.type === 'quality_report') {
                    this.latestManimQualityReport = event.quality;
                } else if (event.type === 'preview') {
                    this.latestManimPreviewReport = event.preview;
                } else if (event.type === 'visual_check') {
                    this.latestManimVisualReport = event.visual;
                } else if (event.type === 'repair') {
                    return;
                } else if (event.type === 'clarification') {
                    return;
                } else if (event.type === 'code_delta') {
                    this.latestManimAgentCode = event.code || `${this.latestManimAgentCode || ''}${event.delta || ''}`;
                } else if (event.type === 'code') {
                    this.latestManimAgentCode = event.code || this.latestManimAgentCode;
                } else if (event.type === 'result') {
                    finalResult = event;
                } else if (event.type === 'error') {
                    if (!event.recoverable) {
                        const streamError = new Error(this.localizeManimError(event.error || 'Manim Agent 处理失败'));
                        streamError.manimProcessHandled = true;
                        throw streamError;
                    }
                }
            });
        } catch (error) {
            const message = this.localizeManimError(error);
            this.updateManimProcessFromEvent({
                type: 'error',
                error: message,
            });
            const streamError = new Error(message);
            streamError.manimProcessHandled = true;
            throw streamError;
        }

        if (finalResult) {
            this.manimWorkbench?.handleAgentResult?.(finalResult);
            this.attachManimResultToProcess(finalResult);
        }
    }

    attachManimResultToProcess(result) {
        const process = this.manimProcess;
        if (!process?.resultEl || !process.messageDiv) {
            this._handleManimResponse(result);
            return;
        }
        const shouldStickToBottom = this.isMessagesNearBottom();

        process.resultEl.innerHTML = '';
        process.resultEl.classList.remove('hidden');
        process.messageDiv.classList.add('has-result');
        process.contentDiv?.classList.add('has-result');

        this._handleManimResponse(result, {
            contentDiv: process.resultEl,
            messageDiv: process.messageDiv,
            preserveScroll: true,
        });

        const hasProblem = result.success === false || !result.rendered || Boolean(result.warning) || Boolean(result.error);
        this.toggleManimProcessBubble(!hasProblem, process);
        this.scrollMessagesToBottom({ force: shouldStickToBottom, respectUserScroll: true });
    }

    getManimProcessSteps() {
        return [
            { id: 'planner', label: '理解需求' },
            { id: 'reference', label: '参考素材' },
            { id: 'storyboard', label: '设计分镜' },
            { id: 'style', label: '教学风格' },
            { id: 'skills', label: '选择技能' },
            { id: 'coder', label: '生成代码' },
            { id: 'critic', label: '静态检查' },
            { id: 'inspect', label: '布局检查' },
            { id: 'visual_check', label: '视觉检查' },
            { id: 'repair', label: '自动修复' },
            { id: 'render', label: '最终渲染' },
        ].map(step => ({
            ...step,
            status: 'pending',
            summary: '暂未开始，等待前序步骤完成',
            details: [],
            updatedAt: null,
        }));
    }

    createManimProcessBubble(prompt = '') {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message bot manim-process-message-row';

        const avatarDiv = document.createElement('div');
        avatarDiv.className = 'message-avatar';
        avatarDiv.innerHTML = '<img src="/images/bot-avatar.jpg" alt="AI">';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content manim-process-message';

        const card = document.createElement('div');
        card.className = 'manim-process-card manim-studio-card';
        card.innerHTML = `
            <button type="button" class="manim-process-header manim-studio-header" aria-expanded="true">
                <span class="manim-process-status">制作中</span>
                <span class="manim-process-current">正在理解动画需求...</span>
                <span class="manim-process-toggle">收起</span>
            </button>
            <div class="manim-process-body">
                <div class="manim-process-timeline manim-studio-track" aria-label="Manim 制作过程"></div>
                <div class="manim-process-details manim-studio-details"></div>
            </div>
        `;

        const resultEl = document.createElement('div');
        resultEl.className = 'manim-process-result manim-studio-result hidden';

        contentDiv.appendChild(card);
        contentDiv.appendChild(resultEl);
        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(contentDiv);
        this.elements.messages?.appendChild(messageDiv);

        const process = {
            prompt,
            messageDiv,
            contentDiv,
            card,
            resultEl,
            header: card.querySelector('.manim-process-header'),
            body: card.querySelector('.manim-process-body'),
            statusEl: card.querySelector('.manim-process-status'),
            currentEl: card.querySelector('.manim-process-current'),
            toggleEl: card.querySelector('.manim-process-toggle'),
            timelineEl: card.querySelector('.manim-process-timeline'),
            detailsEl: card.querySelector('.manim-process-details'),
            steps: this.getManimProcessSteps(),
            currentStep: 'planner',
            collapsed: false,
            terminalStatus: null,
            detailsScrollTop: 0,
            clarification: null,
        };

        process.header?.addEventListener('click', () => {
            this.toggleManimProcessBubble(null, process);
        });
        process.detailsEl?.addEventListener('scroll', () => {
            process.detailsScrollTop = process.detailsEl.scrollTop;
            this.lockManimAutoScroll();
        }, { passive: true });
        process.detailsEl?.addEventListener('wheel', () => this.lockManimAutoScroll(), { passive: true });
        process.detailsEl?.addEventListener('touchmove', () => this.lockManimAutoScroll(), { passive: true });

        this.manimProcess = process;
        this.setManimProcessStep('planner', 'active', '正在理解你的动画需求', prompt ? [`用户需求：${prompt}`] : []);
        this.renderManimProcessBubble(process);
        this.scrollMessagesToBottom({ force: true });
    }

    restartManimProcessInPlace(prompt = '', options = {}) {
        const process = this.manimProcess;
        if (!process) {
            this.createManimProcessBubble(prompt);
            return;
        }

        process.prompt = prompt;
        process.steps = this.getManimProcessSteps();
        process.currentStep = 'planner';
        process.collapsed = false;
        process.terminalStatus = null;
        process.detailsScrollTop = 0;
        process.messageDiv?.classList.remove('has-result');
        process.contentDiv?.classList.remove('has-result');
        process.resultEl?.classList.add('hidden');
        if (process.resultEl) {
            process.resultEl.innerHTML = '';
        }

        const selectedOption = options.selectedOption || process.clarification?.selectedOption || '';
        process.clarification = process.clarification
            ? { ...process.clarification, selectedOption }
            : null;

        const details = [
            selectedOption ? `已选择：${selectedOption}` : '',
            prompt ? `当前需求：${prompt}` : '',
        ].filter(Boolean);
        this.setManimProcessStep('planner', 'active', '已选择动画重点，正在继续制作', details);
        this.renderManimProcessBubble(process);
    }

    toggleManimProcessBubble(forceCollapsed = null, process = this.manimProcess) {
        if (!process) return;
        process.collapsed = forceCollapsed === null
            ? !process.collapsed
            : Boolean(forceCollapsed);
        this.renderManimProcessBubble(process);
    }

    setManimProcessStep(stepId, status, summary = '', details = []) {
        if (!this.manimProcess) return;
        const step = this.manimProcess.steps.find(item => item.id === stepId);
        if (!step) return;

        if (status === 'active') {
            this.manimProcess.steps.forEach(item => {
                if (item.id !== stepId && item.status === 'active') {
                    item.status = 'pass';
                }
            });
        }
        step.status = status;
        if (summary) step.summary = this.localizeManimText(summary);
        if (details.length) {
            step.details = details
                .filter(Boolean)
                .map(item => this.localizeManimText(item));
        }
        step.updatedAt = new Date();
        this.manimProcess.currentStep = stepId;
    }

    completePreviousActiveManimStep(nextStepId) {
        if (!this.manimProcess) return;
        this.manimProcess.steps.forEach(step => {
            if (step.id !== nextStepId && step.status === 'active') {
                step.status = 'pass';
            }
        });
    }

    mapManimProgressStep(step = '') {
        const map = {
            plan: 'planner',
            reference: 'reference',
            design: 'storyboard',
            storyboard: 'storyboard',
            skills: 'skills',
            coder: 'coder',
            critic: 'critic',
            inspect: 'inspect',
            preview: 'visual_check',
            visual_check: 'visual_check',
            repair: 'repair',
            render: 'render',
            cache: 'render',
        };
        return map[step] || step || 'planner';
    }

    mapManimReportStatus(status = '') {
        if (status === 'pass' || status === 'success' || status === 'skipped') return 'pass';
        if (status === 'warning') return 'warning';
        if (status === 'error' || status === 'failed') return 'error';
        return 'active';
    }

    updateManimProcessFromEvent(event = {}) {
        if (!this.manimProcess) {
            if (event.type === 'clarification') {
                this.createManimProcessBubble(event.clarification?.originalMessage || '');
            } else {
                return;
            }
        }
        const shouldStickToBottom = this.isMessagesNearBottom();

        if (event.type === 'job') {
            const job = event.job || {};
            this.setManimProcessStep('planner', 'active', '任务已创建，正在准备制作流程', [
                job.jobId ? `任务编号：${job.jobId}` : '',
                job.status ? `任务状态：${this.localizeManimText(job.status)}` : '',
            ].filter(Boolean));
        } else if (event.type === 'progress') {
            const stepId = this.mapManimProgressStep(event.step);
            this.completePreviousActiveManimStep(stepId);
            this.setManimProcessStep(stepId, 'active', this.manimProcessLabelForStep(stepId), []);
        } else if (event.type === 'plan') {
            const brief = event.brief || {};
            this.setManimProcessStep('planner', 'pass', '已识别动画需求', this.formatManimPlanDetails(brief));
        } else if (event.type === 'reference') {
            const refs = event.references || [];
            const specs = event.referenceSpecs || [];
            const warnings = event.warnings || [];
            const details = [
                ...specs.map(spec => spec.summary || spec.warning || '').filter(Boolean),
                ...refs.map(item => `参考图：${item.filename || item.referenceId}（${item.width || '?'}×${item.height || '?'}）`),
                ...warnings.map(item => `注意：${this.localizeManimText(item)}`),
                event.conflict ? `冲突提示：${this.localizeManimText(event.conflict)}` : '',
            ].filter(Boolean);
            const status = event.status === 'warning' ? 'warning' : (event.status === 'error' ? 'error' : 'pass');
            this.setManimProcessStep('reference', status, event.summary || '已解析参考素材', details.length ? details : ['未使用参考素材']);
        } else if (event.type === 'patch_plan') {
            const plan = event.patchPlan || {};
            this.setManimProcessStep('coder', 'active', plan.summary || '已生成代码修改计划', [
                ...(plan.sceneClasses?.length ? [`场景类：${plan.sceneClasses.join('、')}`] : []),
                ...(plan.steps || []),
            ]);
        } else if (event.type === 'design') {
            const design = event.design || {};
            this.setManimProcessStep('storyboard', 'active', design.summary || '正在设计教学分镜', this.formatManimDesignDetails(design));
        } else if (event.type === 'storyboard') {
            this.setManimProcessStep('storyboard', 'pass', '分镜设计完成', this.formatManimStoryboardDetails(event.storyboard || []));
        } else if (event.type === 'style') {
            this.setManimProcessStep('style', 'pass', '已确定教学风格', this.formatManimStyleDetails(event.style || {}));
        } else if (event.type === 'skill_activation') {
            this.setManimProcessStep('skills', 'pass', '已激活运行时技能', this.formatManimSkillsDetails(event.skills || []));
        } else if (event.type === 'skills') {
            this.setManimProcessStep('skills', 'pass', '已选择运行时技能', this.formatManimSkillsDetails(event.skills || []));
        } else if (event.type === 'code_delta') {
            const received = event.code ? event.code.length : (event.delta || '').length;
            this.setManimProcessStep('coder', 'active', '正在接收场景代码', [`已接收 ${received} 个字符`, event.done ? '代码增量接收完成' : '代码仍在生成中']);
        } else if (event.type === 'code') {
            if (event.source === 'repair') {
                this.setManimProcessStep('repair', event.warning ? 'warning' : 'active', event.warning || '已生成修复版代码，正在重新检查', [event.warning].filter(Boolean));
            } else {
                this.setManimProcessStep('coder', 'pass', '场景代码生成完成', this.formatManimCodeDetails(event));
            }
        } else if (event.type === 'static_guard') {
            const guard = event.guard || {};
            this.setManimProcessStep('critic', this.mapManimReportStatus(guard.status), guard.summary || 'Python 静态守卫完成', this.formatManimCriticDetails(guard));
        } else if (event.type === 'critic_report') {
            const report = event.critic || {};
            this.setManimProcessStep('critic', this.mapManimReportStatus(report.status), report.summary || '静态检查完成', this.formatManimCriticDetails(report));
        } else if (event.type === 'inspect') {
            this.setManimProcessStep('inspect', 'active', '正在检查布局和语义', [event.message].filter(Boolean));
        } else if (event.type === 'quality_report') {
            const report = event.quality || {};
            this.setManimProcessStep('inspect', this.mapManimReportStatus(report.status), report.summary || '布局检查完成', this.formatManimQualityDetails(report));
        } else if (event.type === 'preview') {
            const preview = event.preview || {};
            const status = preview.status === 'skipped' ? 'pass' : this.mapManimReportStatus(preview.status);
            this.setManimProcessStep('visual_check', status, preview.summary || '预览检查完成', this.formatManimVisualDetails(preview));
        } else if (event.type === 'visual_check') {
            const visual = event.visual || {};
            this.setManimProcessStep('visual_check', this.mapManimReportStatus(visual.status), visual.summary || '视觉检查完成', this.formatManimVisualDetails(visual));
        } else if (event.type === 'repair') {
            this.setManimProcessStep('repair', 'active', event.message || '正在自动修复问题', [event.message].filter(Boolean));
        } else if (event.type === 'cache') {
            const status = event.status === 'hit' ? 'pass' : 'active';
            this.setManimProcessStep('render', status, event.summary || '正在检查渲染缓存', [
                event.cacheKey ? `缓存编号：${event.cacheKey}` : '',
                event.videoUrl ? `缓存视频：${event.videoUrl}` : '',
            ].filter(Boolean));
        } else if (event.type === 'diagnostic') {
            const stepId = this.mapManimProgressStep(event.step || event.stage || this.manimProcess.currentStep);
            this.setManimProcessStep(stepId, this.mapManimReportStatus(event.status || 'warning'), event.summary || '诊断信息', event.details || []);
        } else if (event.type === 'result') {
            const repairs = event.agentTrace?.repairs;
            if (event.rendered && repairs && typeof repairs.count === 'number' && repairs.count > 0) {
                const repairStep = this.manimProcess.steps.find(step => step.id === 'repair');
                if (repairStep && repairStep.status === 'active') {
                    repairStep.status = 'repaired';
                    repairStep.summary = '自动修复已通过最终渲染验证';
                }
            }
            const hasProblem = event.success === false || !event.rendered || Boolean(event.warning);
            this.setManimProcessStep('render', hasProblem ? 'warning' : 'pass', hasProblem ? (event.warning || '生成完成，但需要注意') : '最终动画已生成', this.formatManimResultDetails(event));
            this.manimProcess.terminalStatus = hasProblem ? 'warning' : 'pass';
            this.toggleManimProcessBubble(!hasProblem);
        } else if (event.type === 'clarification') {
            this.manimProcess.clarification = {
                ...(event.clarification || {}),
                selectedOption: this.manimProcess.clarification?.selectedOption || '',
            };
            this.setManimProcessStep('planner', 'warning', '需要补充动画目标', this.formatManimClarificationDetails(event.clarification || {}));
            this.manimProcess.terminalStatus = 'warning';
            this.manimProcess.collapsed = false;
        } else if (event.type === 'error') {
            const stepId = this.manimProcess.currentStep || 'planner';
            this.setManimProcessStep(stepId, 'error', this.localizeManimError(event.error || 'Manim Agent 处理失败'), [event.error].filter(Boolean));
            this.manimProcess.terminalStatus = 'error';
        }

        this.renderManimProcessBubble();
        this.scrollMessagesToBottom({ force: shouldStickToBottom, respectUserScroll: true });
    }

    manimProcessLabelForStep(stepId) {
        const labels = {
            planner: '正在理解动画需求',
            reference: '正在读取参考素材',
            storyboard: '正在设计教学分镜',
            style: '正在确定教学风格',
            skills: '正在选择 Manim 技能',
            coder: '正在生成场景代码',
            critic: '正在做静态安全检查',
            inspect: '正在检查布局和语义',
            visual_check: '正在抽帧检查视觉质量',
            repair: '正在自动修复问题',
            render: '正在渲染最终动画',
        };
        return labels[stepId] || '正在处理动画';
    }

    renderManimProcessBubble(process = this.manimProcess) {
        if (!process) return;
        const activeStep = process.steps.find(step => step.id === process.currentStep) || process.steps[0];
        const terminalStatus = process.terminalStatus;

        process.card.classList.toggle('collapsed', process.collapsed);
        process.card.dataset.status = terminalStatus || activeStep.status || 'active';
        process.header?.setAttribute('aria-expanded', String(!process.collapsed));
        if (process.statusEl) {
            process.statusEl.textContent = terminalStatus === 'pass'
                ? '已完成'
                : terminalStatus === 'error'
                    ? '失败'
                    : terminalStatus === 'warning'
                        ? '需注意'
                        : '制作中';
        }
        if (process.currentEl) {
            process.currentEl.textContent = terminalStatus === 'pass'
                ? '制作过程已完成，点击展开详情'
                : this.localizeManimText(activeStep.summary || this.manimProcessLabelForStep(activeStep.id));
        }
        if (process.toggleEl) {
            process.toggleEl.textContent = process.collapsed ? '展开' : '收起';
        }
        if (process.timelineEl) {
            process.timelineEl.innerHTML = process.steps.map(step => `
                <div class="manim-process-step ${escapeHtml(step.status)} ${step.id === process.currentStep && step.status === 'active' ? 'is-current' : ''}" ${step.id === process.currentStep ? 'aria-current="step"' : ''} title="${escapeHtml(this.localizeManimText(step.summary))}">
                    <span class="manim-process-dot"></span>
                    <span class="manim-process-step-label">${escapeHtml(this.localizeManimText(step.label))}</span>
                </div>
            `).join('');
        }
        if (process.detailsEl) {
            const previousScrollTop = process.detailsEl.scrollTop || process.detailsScrollTop || 0;
            const visibleSteps = this.getVisibleManimDetailSteps(process, activeStep);
            process.detailsEl.innerHTML = visibleSteps.map(step => this.renderManimProcessDetail(step, process)).join('');
            this.bindManimClarificationActions(process);
            if (previousScrollTop > 0) {
                process.detailsEl.scrollTop = Math.min(previousScrollTop, process.detailsEl.scrollHeight);
                process.detailsScrollTop = process.detailsEl.scrollTop;
            }
        }
    }

    getVisibleManimDetailSteps(process) {
        return process.steps;
    }

    renderManimProcessDetail(step, process = this.manimProcess) {
        const detailItems = (step.details || []).filter(Boolean).slice(0, 6);
        const detailsHtml = detailItems.length
            ? `<ul>${detailItems.map(item => `<li>${escapeHtml(this.localizeManimText(item))}</li>`).join('')}</ul>`
            : '';
        const clarificationHtml = step.id === 'planner' && process?.clarification
            ? this.renderManimClarificationPanel(process.clarification)
            : '';
        const focusClass = process && step.id === process.currentStep ? 'is-focus' : 'is-history';
        return `
            <section class="manim-process-detail ${escapeHtml(step.status)} ${focusClass}">
                <div class="manim-process-detail-title">
                    <span>${escapeHtml(this.localizeManimText(step.label))}</span>
                    <strong>${escapeHtml(this.formatManimStepStatus(step.status))}</strong>
                </div>
                <p>${escapeHtml(this.localizeManimText(step.summary || '等待处理'))}</p>
                ${detailsHtml}
                ${clarificationHtml}
            </section>
        `;
    }

    renderManimClarificationPanel(clarification = {}) {
        const question = this.localizeManimText(clarification.question || '你想让这个动画重点展示什么？');
        const options = Array.isArray(clarification.options) ? clarification.options.filter(Boolean) : [];
        const selectedOption = clarification.selectedOption || '';
        const optionsHtml = options.length
            ? `<div class="manim-clarification-options">
                ${options.map(option => {
                    const label = this.localizeManimText(option);
                    const selectedClass = selectedOption === option || selectedOption === label ? ' is-selected' : '';
                    return `<button type="button" class="manim-clarification-option${selectedClass}" data-manim-clarification-option="${escapeHtml(option)}" aria-pressed="${selectedClass ? 'true' : 'false'}">
                        <span>${escapeHtml(label)}</span>
                    </button>`;
                }).join('')}
            </div>`
            : '';

        return `
            <div class="manim-clarification-panel">
                <div class="manim-clarification-question">${escapeHtml(question)}</div>
                ${optionsHtml}
            </div>
        `;
    }

    bindManimClarificationActions(process = this.manimProcess) {
        if (!process?.detailsEl) return;
        process.detailsEl.querySelectorAll('.manim-clarification-option').forEach(button => {
            button.addEventListener('click', () => {
                this.handleManimClarificationChoice(button.dataset.manimClarificationOption || button.textContent || '');
            });
        });
    }

    async handleManimClarificationChoice(option = '') {
        const process = this.manimProcess;
        const clarification = process?.clarification || {};
        const selectedOption = String(option || '').trim();
        if (!selectedOption) return;

        if (process) {
            process.clarification = {
                ...clarification,
                selectedOption,
            };
            this.setManimProcessStep('planner', 'active', '已选择动画重点，正在继续制作', [`已选择：${selectedOption}`]);
            this.renderManimProcessBubble(process);
        }

        const base = clarification.originalMessage || process?.prompt || '';
        const nextMessage = [base, selectedOption].filter(Boolean).join('，');
        const workbenchOptions = this.manimWorkbench?.getAgentOptions?.() || {};
        const referenceImageIds = Array.from(new Set([
            ...(workbenchOptions.referenceImageIds || []),
        ].filter(Boolean)));

        this.setLoading(true);
        try {
            await this.sendManimAgentStream({
                message: nextMessage,
                mode: 'create',
                ...workbenchOptions,
                referenceImageIds,
            }, {
                reuseProcess: true,
                selectedOption,
            });
        } catch (error) {
            console.error('[Manim Agent] clarification continuation failed:', error);
            if (!error.manimProcessHandled) {
                this.updateManimProcessFromEvent({
                    type: 'error',
                    error: this.localizeManimError(error.message || error),
                });
            }
            showToast(this.localizeManimError(error.message || error), 'error');
        } finally {
            this.setLoading(false);
        }
    }

    formatManimStepStatus(status) {
        const map = {
            pending: '暂未开始',
            active: '进行中',
            pass: '完成',
            warning: '注意',
            error: '失败',
            repaired: '已修复',
        };
        return map[status] || status;
    }

    localizeManimStatus(status = '') {
        const map = {
            pass: '通过',
            success: '成功',
            skipped: '已跳过',
            warning: '注意',
            error: '失败',
            failed: '失败',
            info: '提示',
            active: '进行中',
            repaired: '已修复',
        };
        return map[String(status || '').toLowerCase()] || status;
    }

    localizeManimDomain(domain = '') {
        const map = {
            math: '数学',
            geometry: '几何',
            data: '数据可视化',
            physics: '物理运动',
            flow: '流程解释',
            concept: '概念讲解',
            code: '代码修改',
        };
        return map[String(domain || '').toLowerCase()] || domain;
    }

    localizeManimAnimationType(type = '') {
        const map = {
            function_graph: '函数图像',
            formula_derivation: '公式推导',
            geometry_proof: '几何证明',
            geometry_circle: '圆形几何',
            bar_chart: '柱状图',
            line_chart: '折线图',
            motion_path: '运动轨迹',
            process_flow: '流程图',
            code_modify: '代码修改',
            concept_explanation: '概念讲解',
        };
        return map[String(type || '').toLowerCase()] || type;
    }

    localizeManimStrategy(strategy = '') {
        const map = {
            v4_director_pipeline: 'V4 智能导演流程',
            llm_v4: 'V4 智能生成',
            v6_director_pipeline: 'V6 智能导演流程',
            v5_director_pipeline: 'V5 智能导演流程',
            llm_v6: 'V6 智能生成',
            llm_v5: 'V5 智能生成',
        };
        return map[String(strategy || '').toLowerCase()] || strategy;
    }

    localizeManimSkill(skill = {}) {
        const id = String(skill.id || '').toLowerCase();
        const name = String(skill.name || '').toLowerCase();
        const key = id || name;
        const map = {
            function_graph: '函数图像教学：使用符号刻度、分阶段绘制曲线，并标出关键点。',
            'function graph teaching animation': '函数图像教学：使用符号刻度、分阶段绘制曲线，并标出关键点。',
            formula_derivation: '公式推导：逐步展示等式变化，中文讲解与公式分开排版。',
            'formula derivation': '公式推导：逐步展示等式变化，中文讲解与公式分开排版。',
            coordinate_system: '可读坐标系：控制刻度密度，优先使用 π 等符号标签。',
            'readable coordinate systems': '可读坐标系：控制刻度密度，优先使用 π 等符号标签。',
            geometry: '几何图形：使用清晰线条、角标和标签，避免文字重叠。',
            'geometry diagrams': '几何图形：使用清晰线条、角标和标签，避免文字重叠。',
            data_visualization: '数据可视化：按顺序展示数值和趋势，标签保持简洁。',
            'data visualization': '数据可视化：按顺序展示数值和趋势，标签保持简洁。',
            physics_motion: '物理运动：突出轨迹、向量和关键受力说明。',
            'physics and motion': '物理运动：突出轨迹、向量和关键受力说明。',
            flow_explanation: '流程解释：节点和箭头分步出现，保持间距稳定。',
            'flow and process explanation': '流程解释：节点和箭头分步出现，保持间距稳定。',
            code_modify: '代码修改：在保留原场景结构的基础上做最小可运行修改。',
            'codepanel ai modification': '代码修改：在保留原场景结构的基础上做最小可运行修改。',
            text_formula_layout: '文字与公式布局：中文使用 Text，公式使用 MathTex，并分区放置。',
            'text and formula layout': '文字与公式布局：中文使用 Text，公式使用 MathTex，并分区放置。',
        };
        return map[key] || map[name] || this.localizeManimText(skill.name || skill.id || '运行时技能');
    }

    localizeManimError(error) {
        const raw = typeof error === 'string'
            ? error
            : (error?.message || String(error || ''));
        if (error?.name === 'AbortError' || /abort|aborted|timeout|timed out/i.test(raw)) {
            return '生成时间过长，连接已中断。可以重试，或减少动画复杂度。';
        }
        if (/premature close|stream closed|connection closed|socket hang up|econnreset/i.test(raw)) {
            return '预览通道提前关闭，系统会重试预览或转入最终渲染复检。';
        }
        return this.localizeManimText(raw || 'Manim Agent 处理失败');
    }

    localizeManimText(value = '') {
        const text = String(value || '').trim();
        if (!text) return '';

        const exact = {
            'Quality inspection passed.': '质量检查通过。',
            'Visual inspection passed.': '视觉检查通过。',
            'Visual frame inspection passed.': '预览帧检查通过。',
            'Frame extraction skipped.': '未执行抽帧检查。',
            'No preview frames extracted.': '未抽取到预览帧。',
            'Preview render failed.': '预览渲染失败。',
            'Premature close': '预览通道提前关闭，系统会重试预览或转入最终渲染复检。',
            'Preview render did not return a video URL.': '预览渲染没有返回可播放视频。',
            'Preview video is too small.': '预览视频过小，可能画面为空或内容过少。',
            'Preview video artifact is unusually small.': '预览视频文件偏小，请确认画面内容是否完整。',
            'Animation has no final reading pause.': '动画结尾缺少阅读停顿。',
            'Selected premium teaching style.': '已选择精品教学风格。',
            'Generate code using the selected teaching style.': '将按精品教学风格生成场景代码。',
            'Repairing visual quality issues': '正在修复视觉质量问题。',
            'Rendering preview for visual inspection': '正在渲染低清预览并抽帧检查。',
            'Rendering final Manim video': '正在渲染最终视频。',
            'Manim Agent v4 visual checks failed.': '视觉检查未通过，已保留可编辑代码。',
            'Manim Agent v4 render failed.': '最终渲染失败，已保留可编辑代码。',
            'The operation was aborted.': '生成时间过长，连接已中断。可以重试，或减少动画复杂度。',
            'This operation was aborted.': '生成时间过长，连接已中断。可以重试，或减少动画复杂度。',
            'Repair code before final render.': '请先修复代码后再进行最终渲染。',
            'Render output must include a playable video artifact.': '渲染结果必须包含可播放的视频文件。',
            'Regenerate with visible objects and animations.': '请重新生成包含可见对象和动画的场景。',
            'Check for blank frames or too-short animation.': '请检查是否存在空白帧或动画时长过短。',
            'Add self.wait(1) at the end.': '请在结尾添加至少 1 秒停顿，方便观看。',
            'Install ffmpeg or inspect render output manually.': '请安装 ffmpeg，或手动检查渲染输出。',
            'Storyboard designed.': '分镜设计完成。',
            'Scene code written.': '场景代码生成完成。',
            'Static critique completed.': '静态检查完成。',
            'Code repaired.': '代码已自动修复。',
            'Stopped after maximum repair attempts.': '已达到最大自动修复次数。',
            'Static critique completed.': '静态检查完成。',
            'Missing from manim import * import.': '缺少 Manim 导入。',
            'Missing Scene class or construct method.': '缺少 Scene 类或 construct 方法。',
            'Generated code must expose exactly one renderable Scene class.': '代码必须只有一个可渲染 Scene 类。',
            'Renderable Scene class must be named MainScene.': '可渲染场景类必须命名为 MainScene。',
            'MainScene must inherit Scene directly.': 'MainScene 必须直接继承 Scene。',
            'Scene construct method appears empty.': 'Scene 的 construct 方法看起来是空的。',
            'MathTex/Tex contains Chinese characters.': 'MathTex/Tex 中包含中文。',
            'Generated code contains mojibake Chinese text.': '生成代码里包含乱码中文。',
            'Long decimal coordinate labels make axes unreadable.': '坐标标签里有过长小数，会影响可读性。',
            'Generated code is very long.': '生成代码过长。',
            'Many text objects may overlap.': '文字对象过多，可能发生重叠。',
            'Simplify the animation or split it into fewer steps.': '简化动画，或减少分镜步骤。',
            'Use VGroup(...).arrange() and scale the group to fit the frame.': '使用 VGroup(...).arrange() 排版，并缩放到安全画幅内。',
            'Use Text/SafeText for Chinese and MathTex only for formulas.': '中文使用 Text/SafeText，公式才使用 MathTex。',
            'Use symbolic ticks or short labels.': '使用符号刻度或短标签。',
            'Setup Axes': '建立坐标系',
            'Draw Cosine Curve': '绘制余弦曲线',
            'Draw Sine Curve': '绘制正弦曲线',
            'Mark Key Points': '标记关键点',
            'Highlight Properties': '强调函数性质',
            'We start with a coordinate system for the cosine function.': '先建立余弦函数的平面直角坐标系。',
            'The cosine curve starts at (0,1) and oscillates between 1 and -1.': '余弦曲线从 (0,1) 开始，在 1 和 -1 之间周期变化。',
            'Key points: (0,1), (π/2,0), (π,-1), (3π/2,0), (2π,1).': '关键点包括 (0,1)、(π/2,0)、(π,-1)、(3π/2,0)、(2π,1)。',
            'The cosine function is even and periodic with period 2π.': '余弦函数是偶函数，周期为 2π。',
        };
        if (exact[text]) return exact[text];

        const previewFailure = text.match(/^Preview render failed\.?\s*[:：]?\s*(.*)$/i);
        if (previewFailure) {
            const reason = previewFailure[1]?.trim();
            if (reason && /premature close|stream closed|connection closed|socket hang up|econnreset/i.test(reason)) {
                return '预览通道提前关闭，系统会重试预览或转入最终渲染复检。';
            }
            return reason ? `预览渲染失败：${reason}` : '预览渲染失败。';
        }

        const includes = [
            [/Quality inspection passed/i, '质量检查通过。'],
            [/Visual inspection passed/i, '视觉检查通过。'],
            [/premature close|stream closed|connection closed|socket hang up|econnreset/i, '预览通道提前关闭，系统会重试预览或转入最终渲染复检。'],
            [/Preview render failed/i, '预览渲染失败。'],
            [/Mobject\.__getattr__.*unexpected keyword|unexpected keyword/i, '代码调用了 Manim 不支持的参数，请移除未知参数并重新生成。'],
            [/Only values of type VMobject can be added as submobjects of VGroup/i, 'VGroup 中混入了非 Manim 可绘制对象，请把文字或公式先包装成可绘制对象。'],
            [/operation was aborted|aborterror|aborted/i, '生成时间过长，连接已中断。可以重试，或减少动画复杂度。'],
            [/Repairing visual quality issues/i, '正在修复视觉质量问题。'],
            [/visual checks failed/i, '视觉检查未通过，已保留可编辑代码。'],
            [/render failed/i, '渲染失败，已保留可编辑代码。'],
            [/no final reading pause/i, '动画结尾缺少阅读停顿。'],
            [/video artifact is unusually small/i, '预览视频文件偏小，请确认画面内容是否完整。'],
            [/Simplify the animation or split it into fewer steps/i, '简化动画，或减少分镜步骤。'],
            [/Use VGroup\(\.\.\.\)\.arrange\(\) and scale the group to fit the frame/i, '使用 VGroup(...).arrange() 排版，并缩放到安全画幅内。'],
            [/system or network module access is not allowed/i, '不允许访问系统或网络模块。'],
            [/dynamic execution or introspection is not allowed/i, '不允许动态执行或反射调用。'],
            [/double-underscore attribute access is not allowed/i, '不允许访问双下划线内部属性。'],
            [/Keep helper classes from inheriting Scene and render only MainScene/i, '辅助类不要继承 Scene，只保留 MainScene 作为可渲染场景。'],
            [/Use class MainScene\(SafeScene, Scene\)/i, '请使用 class MainScene(SafeScene, Scene):。'],
        ];
        const matched = includes.find(([pattern]) => pattern.test(text));
        return matched ? matched[1] : text;
    }

    formatManimPlanDetails(brief = {}) {
        const details = [];
        if (brief.domain) details.push(`领域：${this.localizeManimDomain(brief.domain)}`);
        if (brief.animationType) details.push(`动画类型：${this.localizeManimAnimationType(brief.animationType)}`);
        if (typeof brief.confidence === 'number') details.push(`置信度：${Math.round(brief.confidence * 100)}%`);
        if (brief.strategy) details.push(`策略：${this.localizeManimStrategy(brief.strategy)}`);
        return details;
    }

    formatManimDesignDetails(design = {}) {
        const details = [];
        if (design.summary) details.push(this.localizeManimText(design.summary));
        const spec = design.storyboardSpec || {};
        if (spec.teaching_goal) details.push(`教学目标：${this.localizeManimText(spec.teaching_goal)}`);
        if (Array.isArray(spec.visual_objects) && spec.visual_objects.length) {
            details.push(`视觉对象：${spec.visual_objects.slice(0, 5).map(item => this.localizeManimText(item)).join('、')}`);
        }
        return details;
    }

    formatManimStoryboardDetails(storyboard = []) {
        return storyboard.slice(0, 5).map((shot, index) => {
            const title = this.localizeManimText(shot.title || `步骤 ${index + 1}`);
            const narration = shot.narration ? `：${this.localizeManimText(shot.narration)}` : '';
            return `${index + 1}. ${title}${narration}`;
        });
    }

    formatManimStyleDetails(style = {}) {
        const details = [];
        if (style.id || style.name) {
            const styleName = String(style.id || style.name) === 'teaching_premium'
                ? '精品教学风格'
                : this.localizeManimText(style.id || style.name);
            details.push(`风格：${styleName}`);
        }
        if (style.background) details.push(`背景：浅色教学背景（${style.background}）`);
        if (style.primary) details.push(`强调色：教学蓝（${style.primary}）`);
        if (style.motionPolicy) details.push('动效：分阶段呈现、适当停顿，避免过度镜头运动。');
        if (style.layoutPolicy) details.push('布局：标题、步骤、主体图像和总结分区放置。');
        return details;
    }

    formatManimSkillsDetails(skills = []) {
        return skills.slice(0, 4).map(skill => this.localizeManimSkill(skill));
    }

    formatManimCodeDetails(event = {}) {
        const details = [];
        const sourceMap = {
            llm_v4: 'V4 智能生成',
            llm_v6: 'V6 智能生成',
            llm_v5: 'V5 智能生成',
            repair: '自动修复生成',
        };
        if (event.source) details.push(`来源：${sourceMap[event.source] || this.localizeManimText(event.source)}`);
        if (event.template) details.push(`模板：${event.template === 'none' ? '未使用固定整段模板' : this.localizeManimText(event.template)}`);
        if (event.warning) details.push(`警告：${this.localizeManimText(event.warning)}`);
        return details;
    }

    formatManimCriticDetails(report = {}) {
        const details = [];
        if (report.status) details.push(`状态：${this.localizeManimStatus(report.status)}`);
        if (report.summary) details.push(this.localizeManimText(report.summary));
        if (Array.isArray(report.issues)) {
            report.issues.slice(0, 5).forEach(item => {
                const severity = this.localizeManimStatus(item.severity || 'info');
                const message = this.localizeManimText(item.message || '');
                const hint = this.localizeManimText(item.hint || '');
                if (message && hint) {
                    details.push(`${severity}：${message} 建议：${hint}`);
                } else if (message) {
                    details.push(`${severity}：${message}`);
                }
            });
        }
        return details;
    }

    formatManimQualityDetails(report = {}) {
        const details = [];
        if (report.status) details.push(`状态：${this.localizeManimStatus(report.status)}`);
        if (report.summary) details.push(this.localizeManimText(report.summary));
        if (report.error) details.push(`错误：${this.localizeManimError(report.error)}`);
        if (Array.isArray(report.findings)) {
            report.findings.slice(0, 3).forEach(item => {
                const severity = this.localizeManimStatus(item.severity || 'info');
                const message = this.localizeManimText(item.message || item.hint || '');
                if (message) details.push(`${severity}：${message}`);
            });
        }
        return details;
    }

    formatManimVisualDetails(report = {}) {
        const details = this.formatManimQualityDetails(report);
        const metrics = report.metrics || {};
        if (metrics.artifactSize) details.push(`视频大小：${Math.round(metrics.artifactSize / 1024)} KB`);
        const frame = metrics.frame || {};
        if (frame.nonBackgroundRatio) details.push(`主体面积：${Math.round(frame.nonBackgroundRatio * 100)}%`);
        if (frame.contrast) details.push(`对比度：${frame.contrast}`);
        return details;
    }

    formatManimResultDetails(result = {}) {
        const details = [];
        details.push(result.rendered ? '渲染结果：已生成视频' : '渲染结果：未生成视频');
        if (result.videoUrl) details.push(`视频地址：${result.videoUrl}`);
        if (result.warning) details.push(`提示：${this.localizeManimText(result.warning)}`);
        const trace = result.agentTrace || {};
        const staticQuality = trace.quality?.static || {};
        if (Array.isArray(staticQuality.issues) && staticQuality.issues.length) {
            const firstIssue = staticQuality.issues[0];
            details.push(`静态检查：${this.localizeManimText(firstIssue.message || '')}`);
            if (firstIssue.hint) details.push(`修复建议：${this.localizeManimText(firstIssue.hint)}`);
        }
        if (trace.codeSource) details.push(`代码来源：${this.localizeManimStrategy(trace.codeSource)}`);
        if (trace.repairs && typeof trace.repairs.count === 'number') details.push(`修复次数：${trace.repairs.count}`);
        return details;
    }

    formatManimClarificationDetails(clarification = {}) {
        const details = [];
        if (clarification.question) details.push('请在下方选择动画重点，或直接补充描述。');
        return details;
    }

    setManimBottomLoadingVisible(visible) {
        this.elements.loading?.classList.toggle('hidden', !visible);
    }

    isMessagesNearBottom(threshold = 96) {
        const messages = this.elements.messages;
        if (!messages) return true;
        const distance = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
        return distance <= threshold;
    }

    lockManimAutoScroll(durationMs = 5000) {
        this.manimAutoScrollLockedUntil = Date.now() + durationMs;
    }

    isManimAutoScrollLocked() {
        return Date.now() < this.manimAutoScrollLockedUntil;
    }

    scrollMessagesToBottom(options = {}) {
        const messages = this.elements.messages;
        if (!messages) return;
        const force = Boolean(options.force);
        if (options.respectUserScroll && this.isManimAutoScrollLocked()) {
            return;
        }
        if (force || this.isMessagesNearBottom()) {
            messages.scrollTop = messages.scrollHeight;
        }
    }

    /**
     * 读取 NDJSON 流。
     */
    async readNdjsonStream(response, onEvent) {
        if (!response.body || !response.body.getReader) {
            const text = await response.text();
            text.split('\n').map(line => line.trim()).filter(Boolean).forEach(line => {
                onEvent(JSON.parse(line));
            });
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) {
                    onEvent(JSON.parse(trimmed));
                }
            }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
            onEvent(JSON.parse(buffer.trim()));
        }
    }

    updateManimAgentProgress(event) {
        if (this.manimProcess) {
            this.updateManimProcessFromEvent({ type: 'progress', ...event });
            return;
        }
        const labels = {
            planner: '正在理解动画需求...',
            plan: '正在制定动画分镜...',
            design: '正在设计教学表达...',
            storyboard: '正在细化镜头顺序...',
            style: '正在确定教学风格...',
            skills: '正在选择 Manim 技能...',
            coder: '正在生成 Manim 场景代码...',
            critic: '正在检查代码安全和结构...',
            inspect: '正在检查布局和可读性...',
            preview: '正在检查预览画面...',
            visual_check: '正在抽帧检查视觉质量...',
            repair: '正在自动修复问题...',
            render: '正在渲染最终动画...'
        };
        if (this.elements.loadingText) {
            this.elements.loadingText.textContent = labels[event.step] || event.message || '正在处理动画...';
        }
    }

    showManimClarification(clarification = {}) {
        this.updateManimProcessFromEvent({ type: 'clarification', clarification });
    }

    /**
     * 处理服务器响应
     * @param {Object} response - 服务器响应
     * @param {string|null} originalImage - 原始上传的图片 (用于 fallback)
     */
    handleResponse(response, originalImage = null) {
        if (!response.success) {
            devLog.error('响应失败', response.error);
            this.addMessage('bot', `抱歉，处理失败：${response.error}`);
            return;
        }

        const { intent } = response;
        const data = response.data; // May be undefined for Manim

        devLog.info('收到响应', { intent, hasData: !!data, isFlat: !data });

        // 自动模式下，根据检测到的意图切换模式标签
        if (intent && modeSwitcher.getMode() === 'auto') {
            modeSwitcher.setMode(intent, false); // false = 不触发回调
            devLog.info('自动切换模式', { newMode: intent });
        }

        switch (intent) {
            case 'chat':
                this.addMessage('bot', data.reply);
                break;

            case 'manim':
                // Manim Response is now FLAT (no data wrapper)
                this._handleManimResponse(response);
                break;

            case 'solver':
                const solutionText = data.solution || '解题完成';
                // Construct context data for the panel
                // Priority: MinerU extracted diagram ONLY.
                // If MinerU fails (no diagram found), we prefer NO image in the panel over the original clutter.
                let panelImage = data.diagramBase64 || null;
                let panelText = data.extractedText || "（题目内容识别中...）";

                // Fallback: Only use original image if OCR seems to have failed AND no diagram
                const isOCRFailed = panelText.includes('OCR 失败') || panelText.includes('无法识别') || panelText.trim().length < 5;
                if (isOCRFailed && !panelImage && originalImage) {
                    console.warn("[Solver] OCR 似乎失败，启用原图兜底模式");
                    panelImage = originalImage;
                    panelText += "\n\n> ⚠️ **自动回退模式**：由于文字识别遇到问题，已为您显示原始图片。";
                }

                const contextData = {
                    text: panelText,
                    image: panelImage
                };

                this.addMessage('bot', solutionText, null, contextData);
                break;

            default:
                const reply = data ? data.reply : (response.reply || JSON.stringify(response));
                this.addMessage('bot', reply);
        }
    }



    /**
     * 添加消息到 UI
     * @param {string} role - 角色: user | bot
     * @param {string} content - 消息内容
     * @param {string|null} imageBase64 - 图片 Base64
     * @param {Object|null} contextData - 悬浮窗上下文数据 {text, image}
     */
    addMessage(role, content, imageBase64 = null, contextData = null) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;

        const avatarDiv = document.createElement('div');
        avatarDiv.className = 'message-avatar';
        avatarDiv.innerHTML = role === 'bot'
            ? '<img src="/images/bot-avatar.jpg" alt="AI">'
            : '<img src="/images/user-avatar.jpg" alt="User">';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        // 错误消息样式 - 只在消息开头包含错误关键词时触发
        const errorPrefixes = ['抱歉，', '错误：', '失败：', '⚠️', '❌'];
        const isErrorMessage = errorPrefixes.some(prefix => content.trim().startsWith(prefix));
        if (isErrorMessage) {
            contentDiv.classList.add('error');
        }

        // 添加图片
        if (imageBase64) {
            const img = document.createElement('img');
            img.src = imageBase64;
            img.style.cssText = 'max-width:200px;border-radius:8px;margin-bottom:10px;display:block';
            contentDiv.appendChild(img);
        }

        // 渲染内容
        if (role === 'bot') {
            // Use MathRenderer's unified pipeline for proper LaTeX handling
            if (window.MathRenderer) {
                window.MathRenderer.renderMarkdown(content, contentDiv);
            } else {
                // Fallback to basic rendering if MathRenderer unavailable
                contentDiv.innerHTML += renderMarkdown(content);
                setTimeout(() => renderMath(contentDiv), 0);
            }
        } else {
            contentDiv.innerHTML += escapeHtml(content);
        }

        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(contentDiv);
        this.elements.messages?.appendChild(messageDiv);

        // 滚动到底部
        this.scrollMessagesToBottom({ force: true });

        // 刷新图标
        if (window.lucide) {
            window.lucide.createIcons();
        }

        // 触发回调
        if (this.onMessageAdded) {
            this.onMessageAdded({ role, content, image: imageBase64 });
        }

        // Integration with ContextPanel (MathSolver Port)
        if (contextData && window.ContextPanel) {
            window.ContextPanel.observeMessageIntersection(messageDiv, contextData);

            // If it's a new bot message with context, verify auto-update if at bottom
            if (role === 'bot') {
                window.UiManager && window.UiManager.updateContextPanel(contextData.image, contextData.text);
            }
        }
    }

    /**
     * 添加视频消息
 * @param {string} videoSrc - 视频源 URL 或 Base64
 */
    addVideoMessage(videoSrc) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message bot';

        const avatarDiv = document.createElement('div');
        avatarDiv.className = 'message-avatar';
        avatarDiv.innerHTML = '<img src="/images/bot-avatar.jpg" alt="AI">';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        const video = document.createElement('video');
        video.src = videoSrc;
        video.controls = true;
        video.autoplay = true;
        video.loop = true;
        video.muted = true;
        video.style.cssText = 'max-width:100%;border-radius:12px;margin-top:8px';

        contentDiv.appendChild(video);
        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(contentDiv);
        this.elements.messages?.appendChild(messageDiv);

        this.scrollMessagesToBottom({ force: true });

        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    /**
     * 设置加载状态
     * @param {boolean} isLoading - 是否加载中
     */
    setLoading(isLoading) {
        this.isLoading = isLoading;
        this.elements.loading?.classList.toggle('hidden', !isLoading);

        if (this.elements.sendBtn) {
            this.elements.sendBtn.disabled = isLoading;
        }

        if (this.elements.loadingText) {
            this.elements.loadingText.textContent = modeSwitcher.getLoadingText();
        }
    }

    /**
     * 隐藏欢迎屏幕
     */
    hideWelcomeScreen() {
        if (this.elements.welcomeScreen) {
            this.elements.welcomeScreen.style.display = 'none';
        }
    }

    /**
     * 显示欢迎屏幕
     */
    showWelcomeScreen() {
        if (this.elements.welcomeScreen) {
            this.elements.welcomeScreen.style.display = 'flex';
        }
    }

    /**
     * 清空消息列表 (保留欢迎屏幕)
     */
    clearMessages() {
        if (this.elements.messages) {
            // 只删除消息元素，保留欢迎屏幕
            const messageElements = this.elements.messages.querySelectorAll('.message');
            messageElements.forEach(el => el.remove());
        }
        this.lastSubmittedMessage = '';
        this.showWelcomeScreen();
    }

    /**
     * 设置待上传的图片
     * @param {string} imageBase64 - 图片 Base64 数据
     */
    setPendingImage(imageBase64) {
        this.pendingImage = imageBase64;
    }

    /**
     * 获取待上传的图片
     * @returns {string|null} 图片 Base64 数据
     */
    getPendingImage() {
        return this.pendingImage;
    }
}

// 导出单例
export const messageHandler = new MessageHandler();
