export function normalizeStudentRef(value, students = []) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const match = students.find(s => s.id === raw || s.name === raw);
    return match ? { id: match.id, name: match.name } : null;
}

export function normalizeChatOperations(operations = [], students = []) {
    const normalized = [];
    const rejected = [];

    operations.forEach((op, index) => {
        if (!op || typeof op !== 'object') {
            rejected.push({ index, reason: '操作格式无效' });
            return;
        }

        if (op.type === 'swap') {
            const s1 = normalizeStudentRef(op.student1Id ?? op.student1_id ?? op.id1 ?? op.student1, students);
            const s2 = normalizeStudentRef(op.student2Id ?? op.student2_id ?? op.id2 ?? op.student2, students);
            if (!s1 || !s2) {
                rejected.push({ index, operation: op, reason: '交换操作中有学生未匹配到名单' });
                return;
            }
            normalized.push({
                type: 'swap',
                student1Id: s1.id,
                student1: s1.name,
                student2Id: s2.id,
                student2: s2.name
            });
            return;
        }

        if (op.type === 'move') {
            const s = normalizeStudentRef(op.studentId ?? op.student_id ?? op.id ?? op.student ?? op.name, students);
            const row = Number(op.row);
            const col = Number(op.col);
            if (!s) {
                rejected.push({ index, operation: op, reason: '移动操作中的学生未匹配到名单' });
                return;
            }
            if (!Number.isInteger(row) || !Number.isInteger(col)) {
                rejected.push({ index, operation: op, reason: '移动操作缺少有效行列坐标' });
                return;
            }
            normalized.push({
                type: 'move',
                studentId: s.id,
                student: s.name,
                row,
                col
            });
            return;
        }

        rejected.push({ index, operation: op, reason: `不支持的操作类型: ${op.type || '未知'}` });
    });

    return { operations: normalized, rejected };
}

export function detectSeatingMutationIntent(message = '') {
    return /(换|交换|调换|互换|移到|移动到|挪到|调到|安排到|坐到|往前|往后|往左|往右|向前|向后|向左|向右|前排|后排|分开|靠近|同桌)/.test(message);
}

export function resolveEmptyMutationResponse({ message = '', operations = [], rejected = [] }) {
    const mutationIntent = detectSeatingMutationIntent(message);
    const nextRejected = [...rejected];
    const needsAction = mutationIntent && operations.length === 0;
    if (needsAction && nextRejected.length === 0) {
        nextRejected.push({
            reason: 'AI 识别到座位调整意图，但没有返回可执行的座位操作'
        });
    }
    return {
        mutationIntent,
        needsAction,
        rejected: nextRejected,
        warnings: needsAction ? ['请补充学生姓名或目标位置，或换一种更明确的说法。'] : []
    };
}

export function buildSeatingChatSnapshot({ layout = [], students = [] }) {
    const byId = new Map(students.map(student => [student.id, student]));
    const occupied = [];
    for (let row = 0; row < layout.length; row++) {
        for (let col = 0; col < (layout[row]?.length || 0); col++) {
            const id = layout[row][col];
            if (!id || id === '_aisle_') continue;
            const student = byId.get(id);
            occupied.push({
                id,
                name: student?.name || id,
                row,
                col
            });
        }
    }
    return { occupied };
}
