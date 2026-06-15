const TYPE_LABELS = Object.freeze({
    teacher_unavailable: '教师不可排',
    class_unavailable: '班级不可排',
    locked_slot: '固定课节',
    subject_morning: '课程上午优先',
    subject_preferred_periods: '课程偏好时间',
    subject_avoid_periods: '课程避开时间',
    teacher_daily_limit: '教师每日上限',
    teacher_consecutive_limit: '教师连续课上限',
    subject_spread: '同科分散',
});

function unique(items = []) {
    return [...new Set(items.filter(Boolean))];
}

function stableRuleKey(item = {}) {
    return item.id || [
        item.type || '',
        item.targetId || item.target?.id || item.targetName || '',
        ...(item.slots || item.time?.slots || []),
    ].join(':');
}

function sameRule(left = {}, right = {}) {
    return JSON.stringify({
        type: left.type || '',
        targetId: left.targetId || left.target?.id || '',
        targetName: left.targetName || left.target?.name || '',
        slots: [...(left.slots || left.time?.slots || [])].sort(),
        priority: left.priority || left.strength || '',
        weight: Number(left.weight || 0),
    }) === JSON.stringify({
        type: right.type || '',
        targetId: right.targetId || right.target?.id || '',
        targetName: right.targetName || right.target?.name || '',
        slots: [...(right.slots || right.time?.slots || [])].sort(),
        priority: right.priority || right.strength || '',
        weight: Number(right.weight || 0),
    });
}

function confidenceMeta(value) {
    const confidence = Number(value);
    if (Number.isFinite(confidence) && confidence >= 0.85) return { label: '高', tone: 'success' };
    if (Number.isFinite(confidence) && confidence >= 0.65) return { label: '中', tone: 'warning' };
    return { label: '低', tone: 'muted' };
}

function targetLabel(row = {}) {
    return row.targetName
        || row.teacherName
        || row.className
        || row.subjectName
        || row.targetId
        || '未识别对象';
}

function timeLabel(row = {}) {
    const slots = row.slots || [];
    if (slots.length) return slots.map(slot => {
        const [day, period] = String(slot).split('-');
        return `周${day}第${period}节`;
    }).join('、');
    if (row.type === 'subject_morning') return '上午时段';
    if (row.limit) return `最多 ${row.limit} 节`;
    return '未限定时间';
}

function understanding(row = {}) {
    const target = targetLabel(row);
    const time = timeLabel(row);
    const type = TYPE_LABELS[row.type] || '排课建议';
    if (row.type === 'teacher_daily_limit') return `${target}每天最多安排 ${row.limit || '待确认'} 节课`;
    if (row.type === 'teacher_consecutive_limit') return `${target}连续授课不超过 ${row.limit || '待确认'} 节`;
    if (row.type === 'subject_morning') return `${target}尽量安排在上午`;
    if (row.type === 'subject_spread') return `${target}尽量分散到不同日期`;
    return `${target}：${type}，${time}`;
}

export function adaptDraftRowsForWorkbench(rows = [], context = {}) {
    const conflictByRule = new Map();
    (context.conflicts || []).forEach(conflict => {
        (conflict.relatedRuleIds || conflict.rules || []).forEach(id => {
            if (!conflictByRule.has(id)) conflictByRule.set(id, []);
            conflictByRule.get(id).push(conflict);
        });
    });
    return (rows || []).map(row => {
        const confidence = confidenceMeta(row.confidence);
        const conflicts = conflictByRule.get(row.id) || [];
        return {
            ...row,
            sourceText: row.rawText || row.description || '',
            typeLabel: TYPE_LABELS[row.type] || row.type || '排课建议',
            target: {
                type: row.targetType || '',
                id: row.targetId || '',
                name: targetLabel(row),
            },
            time: {
                slots: [...(row.slots || [])],
                label: timeLabel(row),
            },
            strength: row.priority === 'hard' ? 'hard' : 'soft',
            strengthLabel: row.priority === 'hard' ? '必须满足' : '尽量满足',
            confidenceLabel: confidence.label,
            confidenceTone: confidence.tone,
            understanding: understanding(row),
            conflicts,
            warnings: unique(row.warnings || []),
        };
    });
}

export function groupWorkbenchConstraints(rows = []) {
    return rows.reduce((groups, row) => {
        if ((row.conflicts || []).some(item => item.level === 'blocking' || item.severity === 'blocking')) {
            groups.conflict.push(row);
        } else if (['suggestion', 'unsupported'].includes(row.status)) {
            groups.unsupported.push(row);
        } else if (['needs_review', 'invalid'].includes(row.status)) {
            groups.review.push(row);
        } else {
            groups.ready.push(row);
        }
        return groups;
    }, { ready: [], review: [], conflict: [], unsupported: [] });
}

export function buildRuleChangePreview({
    currentItems = [],
    nextItems = [],
    draftRows = [],
} = {}) {
    const current = new Map(currentItems.map(item => [stableRuleKey(item), item]));
    const next = new Map(nextItems.map(item => [stableRuleKey(item), item]));
    const added = [];
    const updated = [];
    const removed = [];

    next.forEach((item, key) => {
        if (!current.has(key)) {
            added.push(item);
        } else if (!sameRule(current.get(key), item)) {
            updated.push({ before: current.get(key), after: item });
        }
    });
    current.forEach((item, key) => {
        if (!next.has(key)) removed.push(item);
    });
    return {
        added,
        updated,
        removed,
        ignored: (draftRows || []).filter(row => row.status !== 'effective'),
        effectiveCount: (draftRows || []).filter(row => row.status === 'effective').length,
    };
}

export function ruleTypeLabel(type = '') {
    return TYPE_LABELS[type] || type || '排课建议';
}

