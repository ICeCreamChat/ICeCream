export const SEATING_CHAT_INTENTS = Object.freeze({
    DIRECT_EDIT: 'direct_edit',
    BATCH_TUNE: 'batch_tune',
    REGENERATE: 'regenerate',
    EXPLAIN: 'explain',
    CLARIFY: 'clarify',
});

export const SEATING_CHAT_CONFIRMATION_TEXT = Object.freeze({
    batch_tune: '这会批量调整当前座位，但不改变布局，确认执行吗？',
    regenerate: '这会重新生成座位表并可能大幅改变当前安排，确认继续吗？',
});

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

        if (op.type === 'set_guardian' || op.type === 'guardian' || op.type === 'setGuardian') {
            const s = normalizeStudentRef(op.studentId ?? op.student_id ?? op.id ?? op.student ?? op.name, students);
            const rawSide = String(op.side ?? op.slot ?? op.position ?? '').trim().toLowerCase();
            const side = rawSide === 'left' || rawSide === '0' || rawSide === '左' || rawSide === '左护法'
                ? 'left'
                : rawSide === 'right' || rawSide === '1' || rawSide === '右' || rawSide === '右护法'
                    ? 'right'
                    : '';
            if (!s) {
                rejected.push({ index, operation: op, reason: '护法操作中的学生未匹配到名单' });
                return;
            }
            if (!side) {
                rejected.push({ index, operation: op, reason: '护法操作缺少 left/right 位置' });
                return;
            }
            normalized.push({
                type: 'set_guardian',
                studentId: s.id,
                student: s.name,
                side
            });
            return;
        }

        rejected.push({ index, operation: op, reason: `不支持的操作类型: ${op.type || '未知'}` });
    });

    return { operations: normalized, rejected };
}

export function detectSeatingMutationIntent(message = '') {
    return /(换|交换|调换|互换|移到|移动到|挪到|调到|安排到|坐到|往前|往后|往左|往右|向前|向后|向左|向右|前排|后排|分开|分散|靠近|同桌|优化|调整|护法)/.test(message);
}

function normalizeMessage(message = '') {
    return String(message || '').replace(/\s+/g, '');
}

function hasNegationBeforePattern(message = '', pattern) {
    const text = normalizeMessage(message);
    if (!text) return false;
    const match = text.match(pattern);
    if (!match) return false;
    const prefix = text.slice(0, match.index);
    return /(不要|别|不是|取消|关闭|去掉|移除|删除)(.{0,6})$/.test(prefix);
}

function mentionsKnownStudent(message = '', students = []) {
    const text = normalizeMessage(message);
    return students.some(student => {
        const name = normalizeMessage(student?.name);
        const id = normalizeMessage(student?.id);
        return Boolean((name && text.includes(name)) || (id && text.includes(id)));
    });
}

export function detectSeatingRegenerateIntent(message = '') {
    const text = normalizeMessage(message);
    if (!text) return false;

    const patterns = [
        /(重新排|重新安排|重新生成|重排|大改|整班|全班|生成座位表)/,
        /(改布局|换布局|改规则|改过道|新增过道|增加过道|添加过道|留过道|留出过道)/,
        /(启用|开启|新增|增加|添加|关闭|取消).{0,8}(左右护法|护法位|护法座位)/,
        /(改成|变成|排成|设置成|切换成).{0,12}(考试|单人|单座|单人单座|小组(?!长)|护法规则|护法布局|布局|[0-9一二两三四五六七八九十]+(?:个)?人一组)/,
        /(考试模式|单人单座|护法规则|排数|列数|几排|几列|[0-9一二两三四五六七八九十]+(?:个)?人一组)/,
        /(按|根据).{0,8}(身高|成绩|分数).{0,12}(安排|排序|排座|重排|重新排|整体|全班|从前到后|从后到前|从高到低|从低到高)/,
    ];

    for (const pattern of patterns) {
        if (pattern.test(text) && !hasNegationBeforePattern(message, pattern)) {
            return true;
        }
    }
    return false;
}

export function detectSeatingBatchTuneIntent(message = '') {
    const text = normalizeMessage(message);
    if (!text) return false;
    return /(分散|分开).{0,10}(成绩|分数|弱|差|低|爱讲话|讲话|同学)/
        .test(text)
        || /(成绩|分数).{0,8}(弱|差|低).{0,10}(分散|分开|调整)/
            .test(text)
        || /(同桌|搭配).{0,10}(均衡|互补|平均|合理)/
            .test(text)
        || /(爱讲话|讲话).{0,10}(分开|分散|远一点)/
            .test(text)
        || /(小组长|班干部).{0,10}(均匀|分布|分散)/
            .test(text)
        || /(批量|整体|全局).{0,8}(微调|调整|优化)/
            .test(text)
        || /(左右护法|护法).{0,12}(成绩|分数|优秀|较好|比较好|好|高|强|差|弱|低|两个|两名)/
            .test(text)
        || /(安排|设置|挑|选).{0,12}(左右护法|护法)/
            .test(text)
        || /调整得更均衡|更均衡/.test(text);
}

export function detectSeatingDirectEditIntent(message = '') {
    const text = normalizeMessage(message);
    if (!text) return false;
    return /(换|交换|调换|互换|移到|移动到|挪到|调到|安排到|坐到|往前|往后|往左|往右|向前|向后|向左|向右|前排|后排|第一排|最后一排|靠过道|过道旁|过道边|靠窗|中间|同桌|相邻|分开|靠近|左护法|右护法|护法)/.test(text);
}

export function classifySeatingChatIntent(message = '', students = [], explicitMode = '') {
    // If frontend explicitly chose a mode, use it directly
    if (explicitMode === 'regenerate') {
        return {
            intent: SEATING_CHAT_INTENTS.REGENERATE,
            requiresConfirmation: true,
            confirmationText: SEATING_CHAT_CONFIRMATION_TEXT.regenerate,
            arrangementPrompt: String(message || '').trim(),
            mutationIntent: false,
        };
    }
    if (explicitMode === 'micro') {
        // When explicit micro mode, skip regenerate detection and fall through to direct/batch
        const text = normalizeMessage(message);
        const hasStudent = mentionsKnownStudent(text, students);
        const directEditIntent = detectSeatingDirectEditIntent(text);

        if (hasStudent && directEditIntent) {
            return {
                intent: SEATING_CHAT_INTENTS.DIRECT_EDIT,
                requiresConfirmation: false,
                confirmationText: '',
                arrangementPrompt: '',
                mutationIntent: true,
            };
        }
        if (detectSeatingBatchTuneIntent(text)) {
            return {
                intent: SEATING_CHAT_INTENTS.BATCH_TUNE,
                requiresConfirmation: true,
                confirmationText: SEATING_CHAT_CONFIRMATION_TEXT.batch_tune,
                arrangementPrompt: '',
                mutationIntent: true,
            };
        }
        if (detectSeatingMutationIntent(text)) {
            return {
                intent: SEATING_CHAT_INTENTS.CLARIFY,
                requiresConfirmation: false,
                confirmationText: '',
                arrangementPrompt: '',
                mutationIntent: true,
            };
        }
        return {
            intent: SEATING_CHAT_INTENTS.EXPLAIN,
            requiresConfirmation: false,
            confirmationText: '',
            arrangementPrompt: '',
            mutationIntent: false,
        };
    }

    // Auto-detect: regenerate (大改) checked first so it takes priority over direct_edit
    const text = normalizeMessage(message);
    const isRegenerate = detectSeatingRegenerateIntent(text);

    if (isRegenerate) {
        return {
            intent: SEATING_CHAT_INTENTS.REGENERATE,
            requiresConfirmation: true,
            confirmationText: SEATING_CHAT_CONFIRMATION_TEXT.regenerate,
            arrangementPrompt: String(message || '').trim(),
            mutationIntent: false,
        };
    }

    const hasStudent = mentionsKnownStudent(text, students);
    const directEditIntent = detectSeatingDirectEditIntent(text);

    if (hasStudent && directEditIntent) {
        return {
            intent: SEATING_CHAT_INTENTS.DIRECT_EDIT,
            requiresConfirmation: false,
            confirmationText: '',
            arrangementPrompt: '',
            mutationIntent: true,
        };
    }

    if (detectSeatingBatchTuneIntent(text)) {
        return {
            intent: SEATING_CHAT_INTENTS.BATCH_TUNE,
            requiresConfirmation: true,
            confirmationText: SEATING_CHAT_CONFIRMATION_TEXT.batch_tune,
            arrangementPrompt: '',
            mutationIntent: true,
        };
    }

    const mutationIntent = detectSeatingMutationIntent(text);
    if (mutationIntent) {
        return {
            intent: SEATING_CHAT_INTENTS.CLARIFY,
            requiresConfirmation: false,
            confirmationText: '',
            arrangementPrompt: '',
            mutationIntent: true,
        };
    }

    return {
        intent: SEATING_CHAT_INTENTS.EXPLAIN,
        requiresConfirmation: false,
        confirmationText: '',
        arrangementPrompt: '',
        mutationIntent: false,
    };
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

export function buildSeatingChatSnapshot({ layout = [], students = [], guardians = [] }) {
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
    const guardianSides = ['left', 'right'];
    for (let col = 0; col < Math.min(2, guardians.length); col++) {
        const id = guardians[col];
        if (!id) continue;
        const student = byId.get(id);
        occupied.push({
            id,
            name: student?.name || id,
            row: -1,
            col,
            role: 'guardian',
            side: guardianSides[col],
        });
    }
    return { occupied };
}
