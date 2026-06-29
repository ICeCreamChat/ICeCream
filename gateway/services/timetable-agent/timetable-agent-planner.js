import { createTimetableAgentTools } from './timetable-agent-tools.js';

const INTENT_TOOL = Object.freeze({
    data_prep: 'project.validate',
    constraint: 'rules.parse',
    solve: 'solve.precheck',
    diagnose: 'rules.diagnose',
    save: 'publish.preview',
});

const TOOL_REASON = Object.freeze({
    'project.validate': '先检查班级、教师、课程、任课和课时数据是否足够继续。',
    'rules.parse': '先把用户描述转换为可复核草稿，不直接写入项目规则。',
    'rules.diagnose': '先定位冲突、缺失对象和无法执行的规则，再给出调整建议。',
    'solve.precheck': '生成课表前先校验容量、不可排时间和无效引用，避免无效求解。',
    'publish.preview': '保存前先检查完整性、冲突和与当前正式课表的差异。',
});

export function classifyTimetableIntent(message = '') {
    const text = String(message || '').trim();
    if (/保存|发布|导出/.test(text)) return 'save';
    if (/诊断|失败|原因|为什么|排不出/.test(text)) return 'diagnose';
    if (/检查|数据|导入|任课|缺少|完整/.test(text)) return 'data_prep';
    if (/开始排课|生成课表|求解|排课/.test(text) && !/约束|要求|规则/.test(text)) return 'solve';
    if (/约束|规则|要求|没空|不可排|不排|尽量|优先|上午|下午|第\s*\d+\s*节|老师|教师/.test(text)) return 'constraint';
    return 'data_prep';
}

function nextActionsForIntent(intent) {
    return {
        data_prep: ['查看缺少的数据', '补充任课数据后重新检查'],
        constraint: ['查看系统理解', '处理不确定对象', '预览规则变化'],
        solve: ['查看求解计划', '确认后生成课表'],
        diagnose: ['查看失败原因', '预览可执行调整'],
        save: ['核对保存差异', '确认后保存正式课表'],
    }[intent] || ['继续当前流程'];
}

export function planTimetableAgentAction({
    message = '',
    proposedTool = '',
} = {}) {
    const tools = createTimetableAgentTools();
    const whitelist = new Set(Object.keys(tools));
    const intent = classifyTimetableIntent(message);
    const fallbackTool = INTENT_TOOL[intent] || 'project.validate';
    const proposedAllowed = Boolean(proposedTool && whitelist.has(proposedTool));
    const nextTool = proposedAllowed ? proposedTool : fallbackTool;
    const selected = tools[nextTool];
    return {
        intent,
        nextTool,
        reason: TOOL_REASON[nextTool] || selected?.description || '按当前步骤调用确定性排课能力。',
        risk: selected?.risk || 'low',
        requiresApproval: Boolean(selected?.requiresApproval),
        whitelistRejected: Boolean(proposedTool && !proposedAllowed),
        nextActions: nextActionsForIntent(intent),
    };
}

export function plannerForStage(stage = 'data_prep') {
    const message = {
        data_prep: '检查排课数据',
        constraint_review: '复核约束规则',
        solve_planning: '开始生成课表',
        solving: '开始生成课表',
        solution_review: '诊断当前方案',
        diagnosis: '诊断排课失败原因',
        finalize: '保存正式课表',
    }[stage] || '检查排课数据';
    return planTimetableAgentAction({ message });
}
