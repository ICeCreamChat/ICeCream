/**
 * ICeCream - 消息处理模块
 * 处理消息发送、渲染和 API 通信
 */

import { escapeHtml, dataURLtoBlob, devLog, showToast } from '../utils/helpers.js';
import { renderMarkdown, renderMath } from '../utils/markdown.js';
import { modeSwitcher } from './mode-switcher.js';
import { intentConfirm } from './intent-confirm.js';

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

        this._bindEvents();
    }



    /**
     * 处理 Manim 动画响应
     * @private
     */
    _handleManimResponse(data) {
        // 创建消息容器
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message bot';

        // Avatar (Direct Img like MathSpace)
        const avatarDiv = document.createElement('div');
        avatarDiv.className = 'message-avatar';
        avatarDiv.innerHTML = '<img src="/images/bot-avatar.jpg" alt="AI">';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        // 添加视频或错误提示
        if (data.rendered && (data.videoUrl || data.videoBase64)) {
            const videoId = 'vid_' + Date.now();
            const videoUrl = data.videoUrl || `data:video/mp4;base64,${data.videoBase64}`;

            // 注册到 CodePanel
            if (this.codePanel) {
                this.codePanel.registerVideo(videoId, data.code, videoUrl);
            }

            const videoLabel = document.createElement('p');
            videoLabel.innerHTML = '<strong>渲染结果：</strong>';
            videoLabel.style.marginTop = '12px';
            contentDiv.appendChild(videoLabel);

            // 使用 video-container 包装视频 (匹配 MathSpace_Version 样式)
            const msgId = 'msg-' + Date.now();
            messageDiv.id = msgId;

            const videoContainer = document.createElement('div');
            videoContainer.className = 'video-container';
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
            videoActions.innerHTML = `<button class="video-action-btn view-code-btn" data-video-id="${videoId}">📝 查看代码</button>`;
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
            errorDiv.innerHTML = renderMarkdown(`\n⚠️ **渲染提示：** ${data.error}\n\n> 💡 动画功能需要启动 Manim Python 服务。\n> 运行命令：\`cd manim-service && python main.py\``);
            contentDiv.appendChild(errorDiv);
        } else if (data.code) {
            // Case: Code generated but not rendered (Manim service may be down)
            const codeDiv = document.createElement('div');
            codeDiv.innerHTML = renderMarkdown(`✨ **已生成代码**\n\n代码已生成，但动画渲染服务未响应。\n\n\`\`\`python\n${data.code.substring(0, 500)}${data.code.length > 500 ? '...' : ''}\n\`\`\`\n\n> 💡 请确保 Manim 服务正在运行。`);
            contentDiv.appendChild(codeDiv);
            console.log('[Manim] Code generated without render:', data);
        } else {
            // Fallback: Unknown response structure
            const fallbackDiv = document.createElement('div');
            fallbackDiv.innerHTML = renderMarkdown(`⚠️ 收到响应但格式异常，请检查控制台日志。`);
            contentDiv.appendChild(fallbackDiv);
            console.error('[Manim] Unexpected response structure:', data);
        }

        // 渲染数学公式
        setTimeout(() => renderMath(contentDiv), 0);

        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(contentDiv);
        this.elements.messages?.appendChild(messageDiv);

        // 滚动到底部
        if (this.elements.messages) {
            this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
        }

        // 刷新图标
        if (window.lucide) {
            window.lucide.createIcons();
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
    }

    /**
     * 处理发送消息
     */
    async handleSend() {
        const message = this.elements.chatInput?.value.trim() || '';

        if (!message && !this.pendingImage) {
            return;
        }

        // 清空输入框
        if (this.elements.chatInput) {
            this.elements.chatInput.value = '';
        }

        // 隐藏欢迎屏幕
        this.hideWelcomeScreen();

        // 添加用户消息
        this.addMessage('user', message, this.pendingImage);

        // 显示加载状态
        this.setLoading(true);

        try {
            const response = await this.sendToServer(message, this.pendingImage);

            if (response.needConfirmation) {
                // Attach the pending image to the data passed to intentConfirm so it can be re-sent
                response.originalImage = this.pendingImage;
                intentConfirm.show(response);
            } else {
                this.handleResponse(response, this.pendingImage);
            }
        } catch (error) {
            console.error('Send error:', error);
            this.addMessage('bot', `抱歉，发生了错误：${error.message}`);
            showToast(error.message, 'error');
        } finally {
            this.setLoading(false);
            this.pendingImage = null;
        }
    }

    /**
     * 发送消息到服务器
     * @param {string} message - 消息内容
     * @param {string|null} imageBase64 - 图片 Base64 数据
     * @returns {Promise<Object>} 服务器响应
     */
    async sendToServer(message, imageBase64 = null) {
        const mode = modeSwitcher.getMode();
        devLog.info('发送消息', { mode, msgLen: message.length, hasImage: !!imageBase64 });

        const formData = new FormData();
        formData.append('message', message);

        if (mode !== 'auto') {
            formData.append('mode', mode);
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
                // Priority: MinerU extracted diagram > original uploaded image
                // MinerU provides clean, processed diagrams which are better for display
                let panelImage = data.diagramBase64 || originalImage || null;
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
        if (this.elements.messages) {
            this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
        }

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

        if (this.elements.messages) {
            this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
        }

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
