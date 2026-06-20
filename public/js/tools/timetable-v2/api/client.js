/**
 * timetable-v2 / api / client.js
 *
 * 统一通信层：HTTP/`success:false` 判定 + 错误码→中文文案 + USE_MOCK 开关。
 * Phase 6 后端 V2 路由就绪前，USE_MOCK=true 走 mock 桩；接线时只关开关，不改 view/state。
 */

// Phase 6 真实路由就绪后置 false（或由构建注入）。
export const USE_MOCK = true;

const REASON_MESSAGES = {
    version_conflict: '项目已被其他窗口修改，请刷新后重试。',
    missing_classes: '请先添加班级信息。',
    missing_teachers: '请先添加教师信息。',
    missing_subjects: '请先添加课程信息。',
    missing_activity_plans: '请先导入任课关系。',
    invalid_reference: '任课数据引用了不存在的班级、课程或教师。',
    duplicate_id: '存在重复的数据 ID。',
    hard_conflicts_exist: '存在硬冲突，无法发布课表。',
    unplaced_lessons: '有课节未排入课表，无法发布。',
    teacher_no_capacity: '教师可用时段不足以容纳其课时。',
    class_no_capacity: '班级可用时段不足以容纳其课时。',
    publication_blocked: '课表未通过发布前校验，暂不能导出。',
    validation_failed: '数据未通过后端校验。',
    ai_not_configured: '智能约束解析未配置，请先配置 API Key。',
    ai_failed: '智能约束解析失败，请稍后重试。',
};

export function messageForReason(reason, fallback = '请求失败') {
    return REASON_MESSAGES[reason] || fallback;
}

/**
 * 统一请求。约定后端返回 { success, data, error?, reason? }。
 * @returns {Promise<any>} data
 */
export async function requestV2(path, options = {}) {
    const response = await fetch(`/api/timetable-v2${path}`, {
        ...options,
        headers: {
            ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
            ...(options.headers || {}),
        },
    });
    const payload = await response.json().catch(() => ({ success: false, reason: 'bad_response' }));
    if (!response.ok || payload.success === false) {
        const reason = payload.reason || payload?.data?.reason;
        const error = new Error(messageForReason(reason, payload.error || '请求失败'));
        error.reason = reason;
        error.status = response.status;
        error.payload = payload;
        throw error;
    }
    return payload.data;
}
