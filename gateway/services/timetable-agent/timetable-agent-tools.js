import { auditTimetableProject, runTimetableScheduler, validateTimetableProjectForSolve } from '../timetable-scheduler.js';
import {
    continueTimetableRuleConversation,
    diagnoseTimetableRules,
    normalizeTimetableRuleDraftRows,
    parseTimetableRules,
} from '../timetable-rule-parser.js';
import { solveTimetableWithTimefold } from '../timetable-solver-bridge.js';
import { validateTimetablePublication } from '../timetable-validation.js';

function tool(name, description, risk, requiresApproval, run) {
    return {
        name,
        description,
        risk,
        requiresApproval,
        inputSchema: {},
        outputSchema: {},
        run,
    };
}

export function createTimetableAgentTools() {
    return {
        'project.validate': tool('project.validate', '检查排课项目是否可求解', 'low', false, ({ project }) => validateTimetableProjectForSolve(project)),
        'project.audit': tool('project.audit', '生成排课数据审计报告', 'low', false, ({ project }) => auditTimetableProject(project)),
        'rules.parse': tool('rules.parse', '解析自然语言或文件约束为复核草稿', 'low', false, input => parseTimetableRules(input)),
        'rules.clarify': tool('rules.clarify', '根据用户回答继续澄清约束草稿', 'low', false, input => continueTimetableRuleConversation(input)),
        'rules.normalize': tool('rules.normalize', '把已确认复核草稿转换为可保存规则', 'high', true, input => normalizeTimetableRuleDraftRows(input)),
        'rules.diagnose': tool('rules.diagnose', '诊断约束冲突与放宽建议', 'low', false, input => diagnoseTimetableRules(input)),
        'solve.precheck': tool('solve.precheck', '求解前本地校验', 'low', false, ({ project }) => validateTimetableProjectForSolve(project)),
        'solve.local': tool('solve.local', '调用本地排课算法生成候选课表', 'medium', true, ({ project }) => runTimetableScheduler(project)),
        'solve.timefold': tool('solve.timefold', '调用 Timefold Solver 生成候选课表', 'medium', true, input => solveTimetableWithTimefold(input)),
        'solve.validate': tool('solve.validate', '校验候选课表是否可发布', 'low', false, ({ project }) => validateTimetablePublication(project)),
        'publish.preview': tool('publish.preview', '生成保存前预览', 'low', false, ({ project }) => validateTimetablePublication(project)),
        'publish.save': tool('publish.save', '保存正式课表或规则', 'high', true, async ({ project, saveProject }) => saveProject(project)),
    };
}

export const timetableAgentTools = createTimetableAgentTools();
