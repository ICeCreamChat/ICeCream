const JSON_HEADERS = { 'Content-Type': 'application/json' };

function postJson(path, payload, options = {}) {
    return fetch(path, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
        ...options,
    });
}

export function fetchSuggestions(payload, { signal } = {}) {
    return postJson('/api/tools/seating/suggestions', payload, { signal });
}

export function fetchLayoutPreview(payload) {
    return postJson('/api/tools/seating/layout-preview', payload);
}

export function fetchLayoutSpec(payload) {
    return postJson('/api/tools/seating/layout-spec', payload);
}

export function fetchArrangement(payload) {
    return postJson('/api/tools/seating/arrange', payload);
}

export function fetchRosterFileParse(formData) {
    return fetch('/api/tools/seating/parse-students-file', {
        method: 'POST',
        body: formData,
    });
}

export function fetchRosterImageParse(formData) {
    return fetch('/api/tools/seating/parse-image', {
        method: 'POST',
        body: formData,
    });
}

export function fetchStudentsParse(text) {
    return postJson('/api/tools/seating/parse-students', { text });
}

export function fetchConstraintParse({ text, students }) {
    return postJson('/api/tools/seating/parse', { text, students });
}

export function fetchChat(payload) {
    return postJson('/api/tools/seating/chat', payload);
}

export function fetchDiagnostics() {
    return fetch('/api/tools/seating/diagnostics', { method: 'GET' });
}

export function fetchFeedback(payload) {
    return postJson('/api/tools/seating/feedback', payload);
}

export function fetchExportXlsx(snapshot) {
    return postJson('/api/tools/seating/export-xlsx', snapshot);
}
