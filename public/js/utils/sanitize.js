const ALLOWED_TAGS = new Set([
    'A', 'B', 'BR', 'BLOCKQUOTE', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3',
    'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'LI', 'OL', 'P', 'PRE', 'S', 'SPAN',
    'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U',
    'UL'
]);

const DROP_WITH_CONTENT = new Set([
    'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM'
]);

const GLOBAL_ATTRS = new Set(['class', 'title']);
const TAG_ATTRS = {
    A: new Set(['href', 'target', 'rel']),
    IMG: new Set(['src', 'alt', 'title', 'width', 'height']),
    TH: new Set(['colspan', 'rowspan']),
    TD: new Set(['colspan', 'rowspan']),
};

function isSafeUrl(value, allowImages = false) {
    const url = String(value || '').trim().replace(/[\u0000-\u001F\u007F\s]+/g, '');
    if (!url) return false;
    if (/^(https?:|mailto:|\/|#)/i.test(url)) return true;
    if (allowImages && /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(url)) return true;
    return false;
}

function sanitizeWithDom(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');

    const cleanNode = (node) => {
        if (node.nodeType === Node.COMMENT_NODE) {
            node.remove();
            return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
        }

        const tagName = node.tagName;
        if (DROP_WITH_CONTENT.has(tagName)) {
            node.remove();
            return;
        }

        if (!ALLOWED_TAGS.has(tagName)) {
            walk(node);
            node.replaceWith(...Array.from(node.childNodes));
            return;
        }

        for (const attr of Array.from(node.attributes)) {
            const name = attr.name.toLowerCase();
            const value = attr.value;
            const allowedForTag = TAG_ATTRS[tagName]?.has(name) || GLOBAL_ATTRS.has(name);

            if (!allowedForTag || name.startsWith('on') || name === 'style') {
                node.removeAttribute(attr.name);
                continue;
            }

            if (name === 'href' && !isSafeUrl(value)) {
                node.removeAttribute(attr.name);
                continue;
            }

            if (name === 'src' && !isSafeUrl(value, tagName === 'IMG')) {
                node.removeAttribute(attr.name);
                continue;
            }

            if (tagName === 'A' && name === 'target' && value === '_blank') {
                node.setAttribute('rel', 'noopener noreferrer');
            }
        }
    };

    const walk = (root) => {
        for (const child of Array.from(root.childNodes)) {
            cleanNode(child);
            if (child.isConnected && child.childNodes?.length) {
                walk(child);
            }
        }
    };

    walk(template.content);
    return template.innerHTML;
}

function fallbackSanitize(html) {
    return String(html || '')
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<\/?(?:iframe|object|embed|link|meta|form)\b[^>]*>/gi, '')
        .replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/\s+style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/javascript:/gi, 'removed:');
}

export function sanitizeHtml(html) {
    if (typeof window !== 'undefined' && window.DOMPurify) {
        return window.DOMPurify.sanitize(String(html || ''));
    }

    if (typeof document !== 'undefined' && typeof Node !== 'undefined') {
        return sanitizeWithDom(html);
    }

    return fallbackSanitize(html);
}

if (typeof window !== 'undefined') {
    window.IceSanitizer = { sanitizeHtml };
}
