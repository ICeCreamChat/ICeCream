const REASON_MESSAGES = {
    not_configured: 'Timefold 未启动，旧课表已保留。',
    endpoint_missing: 'Timefold 排课接口不存在，请重启 dev.bat 让 solver 重新构建；旧课表已保留。',
    timeout: 'Timefold 求解超时，旧课表已保留。',
    hard_score_violation: 'Timefold 返回硬约束冲突，旧课表已保留。',
    incomplete_solution: '仍有课时未排入课表，旧课表已保留。',
    validation_failed: '求解结果未通过二次校验，旧课表已保留。',
    missing_lesson_plans: '请先导入任课数据。',
    missing_teachers: '任课数据里没有教师。',
    missing_classes: '任课数据里没有班级。',
    missing_subjects: '任课数据里没有课程。',
    invalid_lesson_plan_refs: '任课数据引用了不存在的班级、课程或教师。',
    insufficient_slots: '总课时超过当前作息容量。',
    publication_blocked: '课表未通过发布前校验，暂不能导出。',
    publication_draft_changed: '当前课表已改动，请重新发布后再导出正式课表。',
    publication_required: '请先发布课表后导出正式课表。',
    publication_fingerprint_mismatch: '发布快照校验失败，请重新发布后再导出或恢复。',
    published_history_not_found: '没有找到可导出的发布历史版本。',
    published_snapshot_missing: '没有可导出的已发布课表快照。',
    adjustment_failed: '调整失败，旧课表已保留。',
    ai_not_configured: '智能约束解析未配置，请先配置 API Key。',
    empty_prompt: '请先输入要解析的约束。',
    ai_invalid_json: '智能解析结果格式异常，请调整描述后重试。',
    ai_failed: '智能约束解析失败，请稍后重试。',
};

export async function requestTimetable(path, options = {}) {
    const response = await fetch(`/api/tools/timetable${path}`, {
        ...options,
        headers: {
            ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
            ...(options.headers || {}),
        },
    });
    if (options.raw) return response;

    const payload = await response.json();
    if (!response.ok || payload.success === false) {
        const error = new Error(payload.error || '请求失败');
        error.payload = payload;
        error.status = response.status;
        throw error;
    }
    return payload.data;
}

export function requestTimetableAgent(path, options = {}) {
    return requestTimetable(`/agent${path}`, options);
}

export function normalizeApiError(error) {
    const payload = error?.payload || {};
    const reason = payload?.data?.reason;
    const mapped = REASON_MESSAGES[reason];
    return {
        status: error?.status || 0,
        reason: reason || 'request_failed',
        message: mapped || error?.message || '请求失败，请稍后重试。',
        project: payload?.data?.project || null,
        schedule: payload?.data?.schedule || null,
        audit: payload?.data?.audit || null,
        publication: payload?.data?.publication || null,
        solverStats: payload?.data?.solverStats || null,
    };
}
