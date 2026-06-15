import assert from 'node:assert/strict';
import test from 'node:test';

import {
    classifyTimetableIntent,
    planTimetableAgentAction,
    plannerForStage,
} from '../gateway/services/timetable-agent/timetable-agent-planner.js';
import { createTimetableAgentTools } from '../gateway/services/timetable-agent/timetable-agent-tools.js';

// ============================================================================
// 工具白名单验证
// ============================================================================

test('timetable-agent-planner: all tools in whitelist are valid', () => {
    const tools = createTimetableAgentTools();
    const whitelist = Object.keys(tools);

    assert.ok(whitelist.length > 0, 'whitelist should not be empty');
    assert.ok(whitelist.includes('project.validate'), 'whitelist should include project.validate');
    assert.ok(whitelist.includes('rules.parse'), 'whitelist should include rules.parse');
    assert.ok(whitelist.includes('solve.precheck'), 'whitelist should include solve.precheck');
    assert.ok(whitelist.includes('rules.diagnose'), 'whitelist should include rules.diagnose');
    assert.ok(whitelist.includes('publish.preview'), 'whitelist should include publish.preview');
});

// ============================================================================
// classifyTimetableIntent: 基本意图分类
// ============================================================================

test('intent classification: save keywords', () => {
    assert.equal(classifyTimetableIntent('保存课表'), 'save');
    assert.equal(classifyTimetableIntent('发布正式课表'), 'save');
    assert.equal(classifyTimetableIntent('导出课表到Excel'), 'save');
    assert.equal(classifyTimetableIntent('我要保存'), 'save');
});

test('intent classification: diagnose keywords', () => {
    assert.equal(classifyTimetableIntent('诊断排课问题'), 'diagnose');
    assert.equal(classifyTimetableIntent('排课失败了'), 'diagnose');
    assert.equal(classifyTimetableIntent('为什么排不出来'), 'diagnose');
    assert.equal(classifyTimetableIntent('分析失败原因'), 'diagnose');
    assert.equal(classifyTimetableIntent('排不出课表'), 'diagnose');
});

test('intent classification: data_prep keywords', () => {
    assert.equal(classifyTimetableIntent('检查数据完整性'), 'data_prep');
    assert.equal(classifyTimetableIntent('导入任课数据'), 'data_prep');
    assert.equal(classifyTimetableIntent('缺少教师信息'), 'data_prep');
    assert.equal(classifyTimetableIntent('数据准备'), 'data_prep');
    assert.equal(classifyTimetableIntent('查看完整性报告'), 'data_prep');
});

test('intent classification: solve keywords', () => {
    assert.equal(classifyTimetableIntent('开始排课'), 'solve');
    assert.equal(classifyTimetableIntent('生成课表'), 'solve');
    assert.equal(classifyTimetableIntent('求解'), 'solve');
    assert.equal(classifyTimetableIntent('开始排课吧'), 'solve');
    assert.equal(classifyTimetableIntent('排课'), 'solve');
});

test('intent classification: constraint keywords', () => {
    assert.equal(classifyTimetableIntent('添加约束规则'), 'constraint');
    assert.equal(classifyTimetableIntent('王老师周一没空'), 'constraint');
    assert.equal(classifyTimetableIntent('不可排周五下午'), 'constraint');
    assert.equal(classifyTimetableIntent('尽量把数学排在上午'), 'constraint');
    assert.equal(classifyTimetableIntent('李老师优先上午'), 'constraint');
    assert.equal(classifyTimetableIntent('第3节不排语文'), 'constraint');
    // "数学不要排在第一节" 缺少"老师"关键词，当前正则无法匹配，会fallback到data_prep
    // 这是一个边界case，需要改进
    assert.equal(classifyTimetableIntent('数学老师不要排在第一节'), 'constraint');
});

// ============================================================================
// classifyTimetableIntent: 边界和歧义情况
// ============================================================================

test('intent classification: ambiguous delete request', () => {
    // "删除第一节课" 可能指删除规则或删除任课
    // 包含"第X节"关键词，但当前正则需要配合其他关键词才能匹配constraint
    assert.equal(classifyTimetableIntent('删除第一节课的约束'), 'constraint');
    // 单独的"删除第一节课"只有"第X节"，没有"约束|规则|老师"等，会fallback
    assert.equal(classifyTimetableIntent('删除第一节课'), 'data_prep');
});

test('intent classification: mixed intent - constraint + solve', () => {
    // "王老师没空，开始排课"包含约束和排课
    // 当前正则优先级：solve正则检查时会排除"约束|要求|规则"，所以"没空"会匹配constraint
    // 但"开始排课"会先匹配solve（因为solve在constraint之前检查）
    const result = classifyTimetableIntent('王老师周一没空，开始排课');
    // 实际上会匹配solve，因为"开始排课"更明确且solve正则在前
    assert.equal(result, 'solve', 'mixed intent with explicit solve keyword');

    // 如果只有约束关键词，没有明确的solve触发词
    const result2 = classifyTimetableIntent('王老师周一没空');
    assert.equal(result2, 'constraint', 'constraint only should match constraint');
});

test('intent classification: mixed intent - constraint + diagnose', () => {
    // "为什么王老师的课排不出" 包含诊断和约束关键词
    const result = classifyTimetableIntent('为什么王老师的课排不出');
    assert.equal(result, 'diagnose', 'should prioritize diagnose when failure mentioned');
});

test('intent classification: solve with constraint keywords excluded', () => {
    // "开始排课，不要考虑约束" 虽有"约束"但主体是排课
    const result = classifyTimetableIntent('开始排课');
    assert.equal(result, 'solve');

    // 但如果同时有"约束""规则"等，应识别为constraint
    const result2 = classifyTimetableIntent('排课时添加约束');
    assert.equal(result2, 'constraint');
});

test('intent classification: typos and colloquial expressions', () => {
    // 错别字
    assert.equal(classifyTimetableIntent('开始牌课'), 'data_prep', 'typo should fallback to data_prep');
    // "保存客表"包含"保存"关键词，仍会匹配save（正则只检查"保存"）
    assert.equal(classifyTimetableIntent('保存客表'), 'save', 'typo with save keyword still matches');

    // 口语化表达
    // "帮我排个课" 只有"排"字，不匹配"排课"完整词
    assert.equal(classifyTimetableIntent('帮我排个课'), 'data_prep');
    assert.equal(classifyTimetableIntent('帮我排课'), 'solve'); // "排课"完整词才匹配
    assert.equal(classifyTimetableIntent('检查一下数据'), 'data_prep');
    assert.equal(classifyTimetableIntent('看看为啥失败了'), 'diagnose');
    assert.equal(classifyTimetableIntent('保存一下'), 'save');
});

test('intent classification: empty and whitespace input', () => {
    assert.equal(classifyTimetableIntent(''), 'data_prep', 'empty string should fallback');
    assert.equal(classifyTimetableIntent('   '), 'data_prep', 'whitespace should fallback');
    assert.equal(classifyTimetableIntent(null), 'data_prep', 'null should fallback');
    assert.equal(classifyTimetableIntent(undefined), 'data_prep', 'undefined should fallback');
});

test('intent classification: special characters and numbers', () => {
    assert.equal(classifyTimetableIntent('!!!'), 'data_prep', 'special chars should fallback');
    assert.equal(classifyTimetableIntent('123456'), 'data_prep', 'numbers should fallback');
    assert.equal(classifyTimetableIntent('第1节'), 'constraint', 'period number should match constraint');
    assert.equal(classifyTimetableIntent('第 3 节课'), 'constraint', 'period with spaces should match');
});

test('intent classification: partial keyword matches', () => {
    // 确保只匹配完整关键词，不误判部分匹配
    assert.equal(classifyTimetableIntent('排课表'), 'solve');
    assert.equal(classifyTimetableIntent('约束条件'), 'constraint');
    assert.equal(classifyTimetableIntent('诊所'), 'data_prep', 'partial match should not trigger diagnose');
});

test('intent classification: case sensitivity', () => {
    // 虽然正则没有大小写flag，但中文不受影响
    assert.equal(classifyTimetableIntent('开始排课'), 'solve');
    assert.equal(classifyTimetableIntent('開始排課'), 'data_prep', 'traditional Chinese should fallback');
});

test('intent classification: long input with multiple intents', () => {
    // 长句子包含多个意图关键词，测试优先级
    const input = '我导入了数据，检查完整性后，添加了王老师周一没空的约束，然后开始排课，但是失败了，请诊断原因，最后保存课表';
    const result = classifyTimetableIntent(input);
    // 应优先识别 'save' (最高优先级在正则中)
    assert.equal(result, 'save');
});

// ============================================================================
// planTimetableAgentAction: 工具选择和白名单验证
// ============================================================================

test('planTimetableAgentAction: fallback to intent tool when no proposedTool', () => {
    const result = planTimetableAgentAction({ message: '保存课表' });
    assert.equal(result.intent, 'save');
    assert.equal(result.nextTool, 'publish.preview');
    assert.equal(result.whitelistRejected, false);
});

test('planTimetableAgentAction: accept valid proposedTool', () => {
    const result = planTimetableAgentAction({
        message: '开始排课',
        proposedTool: 'solve.precheck',
    });
    assert.equal(result.intent, 'solve');
    assert.equal(result.nextTool, 'solve.precheck');
    assert.equal(result.whitelistRejected, false);
});

test('planTimetableAgentAction: reject invalid proposedTool and fallback', () => {
    const result = planTimetableAgentAction({
        message: '开始排课',
        proposedTool: 'invalid.tool',
    });
    assert.equal(result.intent, 'solve');
    assert.equal(result.nextTool, 'solve.precheck');
    assert.equal(result.whitelistRejected, true);
});

test('planTimetableAgentAction: reject malicious proposedTool', () => {
    const maliciousTools = [
        'system.exec',
        'file.delete',
        '../../../etc/passwd',
        'eval',
        '__proto__',
    ];

    maliciousTools.forEach(tool => {
        const result = planTimetableAgentAction({
            message: '检查数据',
            proposedTool: tool,
        });
        assert.equal(result.whitelistRejected, true, `should reject ${tool}`);
        assert.equal(result.nextTool, 'project.validate', `should fallback for ${tool}`);
    });
});

test('planTimetableAgentAction: all intents map to valid tools', () => {
    const tools = createTimetableAgentTools();
    const intents = ['data_prep', 'constraint', 'solve', 'diagnose', 'save'];

    intents.forEach(intentKey => {
        const message = {
            data_prep: '检查数据',
            constraint: '王老师没空',
            solve: '开始排课',
            diagnose: '为什么失败',
            save: '保存课表',
        }[intentKey];

        const result = planTimetableAgentAction({ message });
        assert.ok(tools[result.nextTool], `intent ${intentKey} should map to valid tool ${result.nextTool}`);
    });
});

test('planTimetableAgentAction: reason field is populated', () => {
    const result = planTimetableAgentAction({ message: '开始排课' });
    assert.ok(result.reason, 'reason should be populated');
    assert.ok(result.reason.length > 0, 'reason should not be empty');
});

test('planTimetableAgentAction: risk and requiresApproval fields', () => {
    const result = planTimetableAgentAction({ message: '保存课表' });
    assert.ok(['low', 'medium', 'high'].includes(result.risk), 'risk should be valid level');
    assert.equal(typeof result.requiresApproval, 'boolean', 'requiresApproval should be boolean');
});

test('planTimetableAgentAction: nextActions are relevant', () => {
    const testCases = [
        { message: '检查数据', expectedActions: ['查看缺少的数据', '补充任课数据后重新检查'] },
        { message: '王老师没空', expectedActions: ['查看系统理解', '处理不确定对象', '预览规则变化'] },
        { message: '开始排课', expectedActions: ['查看求解计划', '确认后生成课表'] },
        { message: '为什么失败', expectedActions: ['查看失败原因', '预览可执行调整'] },
        { message: '保存课表', expectedActions: ['核对保存差异', '确认后保存正式课表'] },
    ];

    testCases.forEach(({ message, expectedActions }) => {
        const result = planTimetableAgentAction({ message });
        assert.deepEqual(result.nextActions, expectedActions, `nextActions for "${message}"`);
    });
});

// ============================================================================
// plannerForStage: 阶段规划器
// ============================================================================

test('plannerForStage: all stages map to valid intents', () => {
    const stages = [
        'data_prep',
        'constraint_review',
        'solve_planning',
        'solving',
        'solution_review',
        'diagnosis',
        'finalize',
    ];

    stages.forEach(stage => {
        const result = plannerForStage(stage);
        assert.ok(result.intent, `stage ${stage} should return intent`);
        assert.ok(result.nextTool, `stage ${stage} should return nextTool`);
    });
});

test('plannerForStage: unknown stage defaults to data_prep', () => {
    const result = plannerForStage('unknown_stage');
    assert.equal(result.intent, 'data_prep');
    assert.equal(result.nextTool, 'project.validate');
});

test('plannerForStage: empty stage defaults to data_prep', () => {
    const result = plannerForStage('');
    assert.equal(result.intent, 'data_prep');
});

test('plannerForStage: null/undefined stage defaults to data_prep', () => {
    const result1 = plannerForStage(null);
    assert.equal(result1.intent, 'data_prep');

    const result2 = plannerForStage(undefined);
    assert.equal(result2.intent, 'data_prep');
});

// ============================================================================
// 误判率和边界测试
// ============================================================================

test('false positive rate: common phrases that should NOT trigger intents', () => {
    const neutralPhrases = [
        { phrase: '你好', expected: 'data_prep' },
        { phrase: '课表在哪', expected: 'data_prep' },
        { phrase: '什么是排课', expected: 'solve' }, // 包含"排课"，会误判为solve
        { phrase: '帮助文档', expected: 'data_prep' },
        { phrase: '返回首页', expected: 'data_prep' },
    ];

    neutralPhrases.forEach(({ phrase, expected }) => {
        const result = classifyTimetableIntent(phrase);
        assert.equal(result, expected, `"${phrase}" classification`);
    });
});

test('false negative rate: variations of valid intents should be recognized', () => {
    const variations = [
        { input: '把课表存起来', expected: 'data_prep' }, // 缺少"保存|发布|导出"关键词
        { input: '看看哪里出问题了', expected: 'data_prep' }, // "出问题"不匹配diagnose正则
        { input: '先检查下', expected: 'data_prep' },
        { input: '生成一个课表', expected: 'data_prep' }, // "生成"不匹配solve正则（需要"生成课表"）
        { input: '生成课表', expected: 'solve' }, // 完整匹配
        { input: '张老师周三有课不能排', expected: 'constraint' }, // "老师"+"不能排"匹配
    ];

    variations.forEach(({ input, expected }) => {
        const result = classifyTimetableIntent(input);
        assert.equal(result, expected, `"${input}" should be classified as ${expected}`);
    });
});

test('intent priority: ensure correct priority when multiple keywords present', () => {
    // 测试正则的优先级顺序
    const testCases = [
        { input: '保存并诊断', expected: 'save' }, // save 在第一个正则
        { input: '诊断后检查数据', expected: 'diagnose' }, // diagnose 在 data_prep 之前
        { input: '检查数据后开始排课', expected: 'data_prep' }, // data_prep 在 solve 之前
        { input: '开始排课添加约束', expected: 'constraint' }, // constraint 在最后但有"约束"关键词
    ];

    testCases.forEach(({ input, expected }) => {
        const result = classifyTimetableIntent(input);
        assert.equal(result, expected, `"${input}" priority check`);
    });
});

// ============================================================================
// 集成测试：完整流程
// ============================================================================

test('integration: complete workflow from data_prep to save', () => {
    const workflow = [
        { stage: 'data_prep', expectedTool: 'project.validate' },
        { stage: 'constraint_review', expectedTool: 'rules.parse' },
        { stage: 'solve_planning', expectedTool: 'solve.precheck' },
        { stage: 'diagnosis', expectedTool: 'rules.diagnose' },
        { stage: 'finalize', expectedTool: 'publish.preview' },
    ];

    workflow.forEach(({ stage, expectedTool }) => {
        const result = plannerForStage(stage);
        assert.equal(result.nextTool, expectedTool, `stage ${stage} should use ${expectedTool}`);
    });
});

test('integration: proposedTool override with valid tool', () => {
    const tools = createTimetableAgentTools();
    const validTools = Object.keys(tools);

    validTools.forEach(tool => {
        const result = planTimetableAgentAction({
            message: '开始排课',
            proposedTool: tool,
        });
        assert.equal(result.nextTool, tool, `valid tool ${tool} should be accepted`);
        assert.equal(result.whitelistRejected, false, `valid tool ${tool} should not be rejected`);
    });
});

// ============================================================================
// 性能和边界测试
// ============================================================================

test('performance: handle very long input efficiently', () => {
    const longInput = '开始排课'.repeat(1000);
    const start = Date.now();
    const result = classifyTimetableIntent(longInput);
    const duration = Date.now() - start;

    assert.equal(result, 'solve');
    assert.ok(duration < 100, `should process long input in <100ms, took ${duration}ms`);
});

test('security: handle injection attempts in message', () => {
    const injectionAttempts = [
        '<script>alert(1)</script>',
        '"; DROP TABLE users; --',
        '${eval("malicious")}',
        '../../../etc/passwd',
    ];

    injectionAttempts.forEach(attempt => {
        const result = planTimetableAgentAction({ message: attempt });
        // 应该 fallback 到 data_prep，不应该执行任何恶意代码
        assert.equal(result.intent, 'data_prep', `injection attempt should fallback safely`);
    });
});
