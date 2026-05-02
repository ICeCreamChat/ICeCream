const DEFAULT_MAX_JSON_LENGTH = 220000;
const DEFAULT_MAX_TEXT_LENGTH = 5000;

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|authorization|bearer|token|jwt|secret|password|passwd|smtp[_-]?(pass|password)|auth(code)?|credential)/i;

export function isSensitiveKey(key) {
    return SENSITIVE_KEY_PATTERN.test(String(key ?? ''));
}

export function redactSensitiveText(value, maxLength = DEFAULT_MAX_TEXT_LENGTH) {
    let text = String(value ?? '');
    text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
    text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED]');
    text = text.replace(
        /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS|AUTHORIZATION|JWT|SMTP[_-]?PASS)[A-Z0-9_]*)\s*[:=]\s*['"]?[^'",\s;]+/gi,
        '$1=[REDACTED]'
    );
    text = text.replace(
        /\b((?:smtp|api|bearer|authorization|token|secret|password|pass|auth|授权码)\s*(?:key|pass|password|token|code|secret|授权码)?)\s*[:= ]+\s*['"]?[A-Za-z0-9._~+/-]{8,}/gi,
        '$1 [REDACTED]'
    );
    text = text.replace(/\b(?=[A-Za-z0-9._~+/-]*[A-Za-z])(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{24,}\b/g, '[REDACTED]');
    if (text.length > maxLength) return `${text.slice(0, maxLength)}...[truncated]`;
    return text;
}

export function sanitizeDiagnosticValue(value, options = {}) {
    const maxLength = options.maxLength ?? DEFAULT_MAX_JSON_LENGTH;
    const seen = new WeakSet();

    const visit = (item, key = '') => {
        if (item == null) return item;
        if (isSensitiveKey(key)) return '[REDACTED]';
        if (typeof item === 'string') return redactSensitiveText(item, options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH);
        if (typeof item === 'number' || typeof item === 'boolean') return item;
        if (Array.isArray(item)) return item.slice(0, options.maxArrayItems ?? 200).map(entry => visit(entry));
        if (typeof item === 'object') {
            if (seen.has(item)) return '[Circular]';
            seen.add(item);
            const result = {};
            for (const [entryKey, entryValue] of Object.entries(item).slice(0, options.maxObjectKeys ?? 200)) {
                result[entryKey] = visit(entryValue, entryKey);
            }
            return result;
        }
        return redactSensitiveText(String(item));
    };

    try {
        const sanitized = visit(value);
        const serialized = JSON.stringify(sanitized);
        if (serialized.length <= maxLength) return sanitized;
        return {
            truncated: true,
            preview: redactSensitiveText(serialized.slice(0, maxLength), maxLength),
        };
    } catch {
        return null;
    }
}

export function sanitizeLogLines(text, { maxLines = 80, maxLineLength = 500 } = {}) {
    return String(text ?? '')
        .split(/\r?\n/)
        .slice(-maxLines)
        .map(line => redactSensitiveText(line, maxLineLength))
        .filter(line => line.length > 0);
}
