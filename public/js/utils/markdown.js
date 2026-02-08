/**
 * ICeCream - Markdown 渲染模块
 * 处理 Markdown 和 LaTeX 数学公式渲染
 * 
 * 注意：采用 Math Protection 模式，先提取 LaTeX 避免被 Markdown 破坏
 */

/**
 * 渲染带有数学公式的 Markdown 内容
 * @param {string} content - Markdown 文本
 * @returns {string} 渲染后的 HTML
 */
export function renderMarkdownWithMath(content) {
    // Step 1: 提取数学公式，用占位符替换
    const mathMap = new Map();
    const generateId = () => "MATHBLOCK" + Math.random().toString(36).substr(2, 9) + "END";

    let protectedText = content
        // 块级公式 $$...$$ 
        .replace(/\$\$([\s\S]*?)\$\$/g, (match, code) => {
            const id = generateId();
            mathMap.set(id, `$$${code}$$`);
            return "\n\n" + id + "\n\n";
        })
        // 块级公式 \[...\]
        .replace(/\\\[([\s\S]*?)\\\]/g, (match, code) => {
            const id = generateId();
            mathMap.set(id, `$$${code}$$`);
            return "\n\n" + id + "\n\n";
        })
        // 行内公式 $...$
        .replace(/([^\\]|^)\$([^\$]*?)\$/g, (match, prefix, code) => {
            const id = generateId();
            mathMap.set(id, `$${code}$`);
            return prefix + id;
        })
        // 行内公式 \(...\)
        .replace(/\\\(([\s\S]*?)\\\)/g, (match, code) => {
            const id = generateId();
            mathMap.set(id, `$${code}$`);
            return id;
        });

    // Step 2: 渲染 Markdown
    let html;
    if (typeof marked !== 'undefined') {
        marked.setOptions({
            headerIds: false,
            mangle: false,
            breaks: true,
            gfm: true
        });
        html = marked.parse(protectedText);
    } else {
        // Fallback: 简单换行处理
        const div = document.createElement('div');
        div.textContent = protectedText;
        html = div.innerHTML.replace(/\n/g, '<br>');
    }

    // Step 3: 还原数学公式占位符
    mathMap.forEach((latex, id) => {
        html = html.split(id).join(latex);
    });

    // Step 4: 基础 XSS 防护
    html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    html = html.replace(/on\w+\s*=/gi, 'data-removed=');
    html = html.replace(/javascript:/gi, 'removed:');

    return html;
}

/**
 * 渲染 Markdown 内容 (不含数学公式保护，保留兼容)
 * @param {string} content - Markdown 文本
 * @returns {string} 渲染后的 HTML
 */
export function renderMarkdown(content) {
    // 使用带数学保护的版本
    return renderMarkdownWithMath(content);
}

/**
 * 渲染数学公式 (KaTeX)
 * @param {HTMLElement} element - 要渲染的 DOM 元素
 */
export function renderMath(element) {
    if (typeof renderMathInElement !== 'undefined') {
        console.log('[DEBUG] Rendering Math in element:', element.innerHTML.substring(0, 50) + '...');
        try {
            renderMathInElement(element, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true }
                ],
                throwOnError: false
            });
            console.log('[DEBUG] Math rendering complete');
        } catch (e) {
            console.warn('[ICeCream] Math rendering error:', e);
        }
    } else {
        console.error('[DEBUG] renderMathInElement is NOT defined! KaTeX failed to load.');
    }
}
