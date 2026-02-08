/**
 * ICeCream - 工具函数模块
 * 提供通用工具函数
 */

/**
 * HTML 转义，防止 XSS
 * @param {string} text - 原始文本
 * @returns {string} 转义后的文本
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Base64 DataURL 转 Blob
 * @param {string} dataURL - Base64 编码的 DataURL
 * @returns {Blob} Blob 对象
 */
export function dataURLtoBlob(dataURL) {
    const arr = dataURL.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
}

/**
 * 开发日志模块 - 桥接到后端控制台
 */
export const devLog = {
    enabled: true, // 生产环境设为 false

    _send(level, message, data) {
        const prefix = `[ICeCream]`;
        console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](prefix, message, data || '');

        if (this.enabled) {
            fetch('/api/log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ level, message, data })
            }).catch(() => { });
        }
    },

    log(message, data) { this._send('log', message, data); },
    info(message, data) { this._send('info', message, data); },
    warn(message, data) { this._send('warn', message, data); },
    error(message, data) { this._send('error', message, data); }
};

/**
 * 显示 Toast 通知
 * @param {string} message - 消息内容
 * @param {string} type - 类型: info | success | error | warning
 */
export function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
}

/**
 * 显示确认对话框
 * @param {string} title - 标题
 * @param {string} message - 消息内容
 * @returns {Promise<boolean>} 用户确认结果
 */
export function showConfirm(title, message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';

        overlay.innerHTML = `
            <div class="confirm-dialog">
                <div class="confirm-header">${title}</div>
                <div class="confirm-message">${message}</div>
                <div class="confirm-buttons">
                    <button class="confirm-btn cancel">取消</button>
                    <button class="confirm-btn ok">确认</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const cleanup = () => {
            overlay.classList.add('fade-out');
            setTimeout(() => overlay.remove(), 200);
        };

        overlay.querySelector('.cancel').onclick = () => {
            cleanup();
            resolve(false);
        };

        overlay.querySelector('.ok').onclick = () => {
            cleanup();
            resolve(true);
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) {
                cleanup();
                resolve(false);
            }
        };

        requestAnimationFrame(() => overlay.classList.add('active'));
    });
}
