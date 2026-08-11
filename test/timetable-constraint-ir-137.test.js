import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseTimetableRules,
} from '../gateway/services/timetable-rule-parser.js';
import { TIMETABLE_CONSTRAINT_WORKBOOK_PATH } from './fixtures/timetable-workbook-paths.js';

const workbookPath = TIMETABLE_CONSTRAINT_WORKBOOK_PATH;

async function parseFixture() {
    return parseTimetableRules({
        file: {
            filename: '真实学校排课约束需求.xlsx',
            buffer: fs.readFileSync(workbookPath),
        },
        project: {},
        env: {},
    });
}

function sourceByRow(result, sourceRow) {
    return (result.sourceRequirements || []).find(item => item.source?.rowNumber === sourceRow);
}

function irsByRow(result, sourceRow) {
    const source = sourceByRow(result, sourceRow);
    assert.ok(source, `missing source requirement at sourceRow ${sourceRow}`);
    return (result.constraintIRs || []).filter(item => item.sourceId === source.sourceId);
}

test('137 条真实自然语言通过 ConstraintIR 分层，源需求基数和身份保持稳定', async () => {
    const first = await parseFixture();

    assert.equal(first.sourceRequirements.length, 137);
    assert.equal(first.statistics.userInputCount, 137);
    assert.equal(new Set(first.sourceRequirements.map(item => item.sourceId)).size, 137);
    assert.ok(Array.isArray(first.constraintIRs));
    assert.ok(first.constraintIRs.length >= first.sourceRequirements.length);

    const sourceIds = new Set(first.sourceRequirements.map(item => item.sourceId));
    const constraintIds = new Set();
    for (const ir of first.constraintIRs) {
        assert.ok(ir.constraintId, 'ConstraintIR must have constraintId');
        assert.ok(ir.clauseId, 'ConstraintIR must have clauseId');
        assert.ok(ir.sourceId, 'ConstraintIR must have sourceId');
        assert.ok(ir.capabilityId, 'ConstraintIR must have capabilityId');
        assert.ok(ir.understandingStatus, 'ConstraintIR must have understandingStatus');
        assert.ok(ir.executionStatus, 'ConstraintIR must have executionStatus');
        assert.ok(ir.reviewStatus, 'ConstraintIR must have reviewStatus');
        assert.ok(ir.support, 'ConstraintIR must have support');
        assert.ok(sourceIds.has(ir.sourceId), `unknown ConstraintIR sourceId: ${ir.sourceId}`);
        assert.equal(constraintIds.has(ir.constraintId), false, `duplicate ConstraintIR id: ${ir.constraintId}`);
        constraintIds.add(ir.constraintId);
        assert.doesNotMatch(`${ir.explanation || ''}${(ir.warnings || []).join('')}`, /�/);
    }

    const second = await parseFixture();
    assert.equal(second.cacheHit, true);
    assert.deepEqual(
        second.constraintIRs.map(item => item.constraintId).sort(),
        first.constraintIRs.map(item => item.constraintId).sort(),
    );
});

test('第 131 行完整保留“隔天分布”和“不要挤在周四周五”两个语义能力', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 131);
    const irs = irsByRow(result, 131);
    const capabilities = new Set(irs.map(item => item.capabilityId));

    assert.match(source.source.rawText, /地理和生物尽量隔天分布/);
    assert.ok(capabilities.has('subject.minimum_day_gap'));
    assert.ok(capabilities.has('subject.avoid_weekday_concentration'));
    assert.notEqual(source.understandingStatus, 'unrecognized');

    const weekdayConcentration = irs.find(item => item.capabilityId === 'subject.avoid_weekday_concentration');
    assert.equal(weekdayConcentration.understandingStatus, 'invalid_reference');
    assert.equal(weekdayConcentration.executionStatus, 'blocked_by_reference');
    assert.equal(weekdayConcentration.reviewStatus, 'needs_clarification');
    assert.equal(weekdayConcentration.support, 'full');
    assert.deepEqual(weekdayConcentration.parameters.days, [4, 5]);
    assert.ok((weekdayConcentration.parameters.subjectIds || []).includes('地理'));
    assert.ok((weekdayConcentration.parameters.subjectIds || []).includes('生物'));
    assert.equal(weekdayConcentration.machineRuleIds.length, 0);
});

test('第 133 行只形成跨场地边界能力，不再伪造 course_interval 规则', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 133);
    const irs = irsByRow(result, 133);
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);

    assert.equal(irs.length, 1);
    assert.equal(irs[0].capabilityId, 'schedule.cross_venue_boundary');
    assert.deepEqual(irs[0].parameters.boundaryPeriods, [4, 5]);
    assert.equal(irs[0].understandingStatus, 'parsed');
    assert.equal(irs[0].executionStatus, 'executable');
    assert.equal(irs[0].reviewStatus, 'understood');
    assert.equal(irs[0].support, 'full');
    assert.deepEqual(irs[0].landing, ['clarification', 'solver_policy']);
    assert.equal(irs[0].machineRuleIds.length, 1);
    assert.equal(rows.some(item => item.type === 'course_interval'), false);
    assert.equal(source.machineRuleIds.length, 1);
});

test('可执行教师不可用能力由 capability registry 生成兼容 draft row', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 2);
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);
    const irs = irsByRow(result, 2);

    assert.ok(irs.some(item => item.capabilityId === 'teacher.unavailable'));
    assert.ok(rows.some(item => item.type === 'teacher_unavailable'));
    assert.ok(rows.every(item => item.generatedBy === 'capability_registry'));
    assert.ok(rows.every(item => item.status !== 'effective'), '未绑定教师实体时不能伪装成可直接应用');
});

test('第 64～69 行都只生成对应教师的日课量上限，参数不得串入课程间隔天数', async () => {
    const result = await parseFixture();
    const expectedTeachers = ['何安琪', '侯安澜', '傅云舒', '姚嘉宁', '冯思源', '叶怀瑾'];

    expectedTeachers.forEach((teacherName, offset) => {
        const sourceRow = 64 + offset;
        const irs = irsByRow(result, sourceRow);
        const dailyLimits = irs.filter(item => item.capabilityId === 'teacher.daily_lesson_limit');
        const source = sourceByRow(result, sourceRow);
        const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);

        assert.equal(dailyLimits.length, 1, `row ${sourceRow} must have exactly one teacher.daily_lesson_limit`);
        assert.equal(dailyLimits[0].parameters.limit, 4);
        assert.equal(Object.hasOwn(dailyLimits[0].parameters, 'minGapDays'), false, `row ${sourceRow} must not leak limit into minGapDays`);
        assert.equal(dailyLimits[0].target.kind, 'teacher');
        assert.equal(dailyLimits[0].target.name, teacherName);
        assert.equal(dailyLimits[0].warnings.some(message => /缺少.*limit|缺少有效的节数上限/.test(message)), false);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].type, 'teacher_daily_limit');
        assert.equal(rows[0].limit, 4);
        assert.equal(rows[0].minGapDays, undefined, `row ${sourceRow} draft row must not contain minGapDays`);
    });
});

test('第 70～75 行都识别为每周最多授课 4 天，不误判周课时或课程间隔', async () => {
    const result = await parseFixture();
    const expectedTeachers = ['潘语晨', '蔡若琳', '袁星辰', '邓可欣', '刘书涵', '宋予安'];

    expectedTeachers.forEach((teacherName, offset) => {
        const sourceRow = 70 + offset;
        const irs = irsByRow(result, sourceRow);
        const maxTeachingDays = irs.filter(item => item.capabilityId === 'teacher.max_teaching_days');
        const source = sourceByRow(result, sourceRow);
        const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);

        assert.equal(maxTeachingDays.length, 1, `row ${sourceRow} must have exactly one teacher.max_teaching_days`);
        assert.equal(maxTeachingDays[0].parameters.limit, 4);
        assert.equal(Object.hasOwn(maxTeachingDays[0].parameters, 'minGapDays'), false, `row ${sourceRow} must not leak limit into minGapDays`);
        assert.equal(maxTeachingDays[0].target.kind, 'teacher');
        assert.equal(maxTeachingDays[0].target.name, teacherName);
        assert.equal(irs.some(item => item.capabilityId === 'teacher.weekly_lesson_limit'), false);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].type, 'teacher_max_days_per_week');
        assert.equal(rows[0].limit, 4);
        assert.equal(rows[0].minGapDays, undefined, `row ${sourceRow} draft row must not contain minGapDays`);
    });
});

test('第 76～83 行指定教师的少空堂偏好始终保持具体对象，绝不扩大成全体教师', async () => {
    const result = await parseFixture();
    const expectedTeachers = ['刘书涵', '宋予安', '何安琪', '侯安澜', '傅云舒', '夏知行', '卢思嘉', '曾一鸣'];

    expectedTeachers.forEach((teacherName, offset) => {
        const sourceRow = 76 + offset;
        const irs = irsByRow(result, sourceRow);
        const compactDays = irs.filter(item => item.capabilityId === 'teacher.compact_day');
        const source = sourceByRow(result, sourceRow);
        const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);

        assert.equal(compactDays.length, 1, `row ${sourceRow} must have exactly one teacher.compact_day`);
        assert.equal(compactDays[0].target.kind, 'teacher');
        assert.equal(compactDays[0].target.name, teacherName);
        assert.deepEqual(compactDays[0].target.matchedIds, []);
        assert.equal(compactDays[0].executionStatus, 'blocked_by_reference');
        assert.notEqual(compactDays[0].target.kind, 'teacher_group');
        assert.doesNotMatch(compactDays[0].target.name, /全部教师|__all_teachers/);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].type, 'advanced_constraint');
        assert.equal(rows[0].targetType, 'teacher');
        assert.equal(rows[0].targetName, teacherName);
        assert.equal(rows[0].executionStatus, 'blocked_by_reference');
        assert.doesNotMatch(`${rows[0].targetId} ${rows[0].targetName}`, /全部教师|__all_teachers/);
    });

    assert.equal(result.draftRules.softRules.teacherGapWeight, 0);
});

test('第 114 行保留指定任课教师覆盖班级范围，且不得编译成全校语数英时段规则', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 114);
    const irs = irsByRow(result, 114);
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);
    const preferredDayPartIrs = irs.filter(item => item.capabilityId === 'subject.preferred_day_part');
    const expectedTeacherNames = [
        '刘书涵', '吴子墨', '周明轩', '孙景和', '张沐言',
        '宋予安', '朱明哲', '林知远', '梁启航', '罗景行',
        '何安琪', '姚嘉宁', '潘语晨', '蔡若琳', '袁星辰',
    ];

    assert.equal(preferredDayPartIrs.length, 6);
    assert.deepEqual(
        [...new Set(preferredDayPartIrs.map(item => item.target.name))].sort(),
        ['数学', '英语', '语文'],
    );
    const independent = preferredDayPartIrs.filter(item => item.relation.kind === 'independent');
    const emphasis = preferredDayPartIrs.filter(item => item.relation.kind === 'emphasis');
    assert.equal(independent.length, 3);
    assert.equal(emphasis.length, 3);
    independent.forEach((ir) => {
        assert.equal(ir.target.kind, 'subject');
        assert.deepEqual(ir.parameters.periods, [1, 2, 3, 4]);
        assert.equal(ir.parameters.scopeQualifier, 'subject_offering_classes');
        assert.equal(ir.scope.kind, 'subject_offering_classes');
        assert.equal(ir.relation.parentClauseId, '');
        assert.equal(ir.understandingStatus, 'invalid_reference');
        assert.equal(ir.executionStatus, 'blocked_by_reference');
        assert.equal(ir.reviewStatus, 'needs_clarification');
        assert.equal(ir.support, 'full');
        assert.deepEqual(ir.machineRuleIds, []);
    });
    const independentById = new Map(independent.map(item => [item.clauseId, item]));
    emphasis.forEach((ir) => {
        assert.equal(ir.target.kind, 'subject');
        assert.deepEqual(ir.parameters.periods, [1, 2, 3, 4]);
        assert.equal(ir.parameters.scopeQualifier, 'teacher_covered_classes');
        assert.deepEqual(ir.parameters.teacherNames, expectedTeacherNames);
        assert.equal(ir.scope.qualifier, 'teacher_covered_classes');
        assert.deepEqual(ir.scope.teacherNames, expectedTeacherNames);
        const parent = independentById.get(ir.relation.parentClauseId);
        assert.ok(parent, 'emphasis clause must reference its base preference');
        assert.equal(parent.target.name, ir.target.name);
        assert.equal(ir.understandingStatus, 'invalid_reference');
        assert.equal(ir.executionStatus, 'blocked_by_reference');
        assert.equal(ir.reviewStatus, 'needs_clarification');
        assert.equal(ir.support, 'full');
        assert.deepEqual(ir.machineRuleIds, []);
    });

    assert.equal(rows.length, 6);
    assert.ok(rows.every(row => row.type === 'advanced_constraint' && row.executionStatus === 'blocked_by_reference'));
    assert.equal(source.machineRuleIds.length, 0);
});

test('第 124 行保留物理实验课条件和四名教师范围，且不得扩大成全部物理课实验室要求', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 124);
    const irs = irsByRow(result, 124).filter(item => item.capabilityId === 'room.required');
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);
    const expectedTeacherNames = ['余思齐', '程远航', '蒋博文', '薛以恒'];

    assert.equal(irs.length, 1);
    assert.equal(irs[0].target.kind, 'subject');
    assert.equal(irs[0].target.name, '物理');
    assert.deepEqual(irs[0].parameters.roomRequirement.roomIds, ['物理实验室A', '物理实验室B']);
    assert.deepEqual(irs[0].parameters.activityTypes, ['实验课']);
    assert.deepEqual(irs[0].parameters.teacherNames, expectedTeacherNames);
    assert.equal(irs[0].parameters.scopeQualifier, 'teacher_activity');
    assert.deepEqual(irs[0].scope.activityTypes, ['实验课']);
    assert.deepEqual(irs[0].scope.teacherNames, expectedTeacherNames);
    assert.equal(irs[0].scope.qualifier, 'teacher_activity');
    assert.equal(irs[0].strength, 'hard');
    assert.equal(irs[0].support, 'full');
    assert.equal(irs[0].executionStatus, 'blocked_by_reference');
    assert.deepEqual(irs[0].machineRuleIds, []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'advanced_constraint');
    assert.equal(rows[0].executionStatus, 'blocked_by_reference');
});

test('第 125、127 行的一般实验室和机房要求仍保留具体场地并生成兼容机器规则', async () => {
    const result = await parseFixture();
    const expected = new Map([
        [125, { rooms: ['化学实验室'], tags: ['lab'] }],
        [127, { rooms: ['计算机教室A', '计算机教室B'], tags: ['computer'] }],
    ]);

    for (const [sourceRow, expectation] of expected) {
        const source = sourceByRow(result, sourceRow);
        const irs = irsByRow(result, sourceRow).filter(item => item.capabilityId === 'room.required');
        const rows = result.draftRows.filter(item => item.sourceId === source.sourceId && item.type === 'room_requirement');

        assert.equal(irs.length, 1, `row ${sourceRow} must have exactly one room.required IR`);
        assert.equal(rows.length, 1, `row ${sourceRow} must have exactly one room_requirement row`);
        assert.deepEqual(irs[0].parameters.roomRequirement.roomIds, expectation.rooms);
        assert.equal(irs[0].parameters.roomRequirement.roomName, expectation.rooms[0]);
        expectation.tags.forEach(tag => assert.ok(irs[0].parameters.roomRequirement.requiredTags.includes(tag)));
        assert.equal(irs[0].warnings.some(message => /缺少教室、场地或教室标签/.test(message)), false);

        assert.deepEqual(rows[0].roomIds, expectation.rooms);
        assert.equal(rows[0].roomName, expectation.rooms[0]);
        expectation.tags.forEach(tag => assert.ok(rows[0].requiredTags.includes(tag)));
    }
});

test('第 126 行拆分生物实验室软偏好与指定教师实验课禁用普通教室两个谓词', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 126);
    const irs = irsByRow(result, 126);
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);
    const preferred = irs.filter(item => item.capabilityId === 'room.preferred');
    const forbidden = irs.filter(item => item.capabilityId === 'room.forbidden_type');
    const expectedTeacherNames = ['卢思嘉', '钟若妍', '黄子萱'];

    assert.equal(preferred.length, 1);
    assert.equal(preferred[0].target.name, '生物');
    assert.equal(preferred[0].strength, 'soft');
    assert.deepEqual(preferred[0].parameters.preferredRoomIds, ['生物实验室A', '生物实验室B']);
    assert.deepEqual(preferred[0].parameters.activityTypes, ['实验课']);
    assert.equal(preferred[0].parameters.scopeQualifier, 'activity');
    assert.equal(preferred[0].support, 'full');
    assert.equal(preferred[0].executionStatus, 'blocked_by_reference');
    assert.deepEqual(preferred[0].machineRuleIds, []);

    assert.equal(forbidden.length, 1);
    assert.equal(forbidden[0].target.name, '生物');
    assert.equal(forbidden[0].strength, 'hard');
    assert.deepEqual(forbidden[0].parameters.forbiddenRoomTypes, ['ordinary_classroom']);
    assert.deepEqual(forbidden[0].parameters.activityTypes, ['实验课']);
    assert.deepEqual(forbidden[0].parameters.teacherNames, expectedTeacherNames);
    assert.equal(forbidden[0].parameters.scopeQualifier, 'teacher_activity');
    assert.deepEqual(forbidden[0].scope.teacherNames, expectedTeacherNames);
    assert.equal(forbidden[0].scope.qualifier, 'teacher_activity');
    assert.equal(forbidden[0].support, 'full');
    assert.equal(forbidden[0].executionStatus, 'blocked_by_reference');
    assert.deepEqual(forbidden[0].machineRuleIds, []);

    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.type === 'advanced_constraint' && row.executionStatus === 'blocked_by_reference'));
    assert.equal(source.machineRuleIds.length, 0);
});

test('第 134 行保留同一备课组内部公平和两个负向边界，不得泛化为全校教师均衡', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 134);
    const irs = irsByRow(result, 134);
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);
    const fairness = irs.filter(item => item.capabilityId === 'teacher.prep_group_fairness');

    assert.equal(fairness.length, 1);
    assert.equal(fairness[0].target.kind, 'teacher_group');
    assert.equal(fairness[0].target.name, '同一备课组内教师');
    assert.equal(fairness[0].target.matchedIds.includes('__all_teachers'), false);
    assert.equal(fairness[0].parameters.comparisonScope, 'preparation_group');
    assert.equal(fairness[0].parameters.fairnessMode, 'within_group');
    assert.deepEqual(fairness[0].parameters.distributionDays, [1, 2, 3, 4, 5]);
    assert.equal(fairness[0].parameters.maxConsecutiveFullAfternoons, 1);
    assert.equal(fairness[0].parameters.avoidFullDayIdle, true);
    assert.equal(fairness[0].support, 'full');
    assert.equal(fairness[0].executionStatus, 'executable');
    assert.equal(fairness[0].machineRuleIds.length, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'advanced_constraint');
    assert.equal(source.machineRuleIds.length, 1);
});
test('第 128～129 行实验连堂每条只生成一个 subject IR，并保留年级范围和双连堂参数', async () => {
    const result = await parseFixture();
    const expected = new Map([
        [128, { subject: '物理', grades: ['八年级', '九年级'] }],
        [129, { subject: '化学', grades: ['九年级'] }],
    ]);

    for (const [sourceRow, expectation] of expected) {
        const source = sourceByRow(result, sourceRow);
        const irs = irsByRow(result, sourceRow).filter(item => item.capabilityId === 'lesson.consecutive');
        const rows = result.draftRows.filter(item => item.sourceId === source.sourceId && item.type === 'advanced_constraint');

        assert.equal(irs.length, 1, `row ${sourceRow} must not duplicate lesson.consecutive`);
        assert.equal(irs[0].target.kind, 'subject');
        assert.equal(irs[0].target.name, expectation.subject);
        assert.equal(irs[0].parameters.blockPreference, 'double');
        assert.deepEqual(irs[0].parameters.gradeNames, expectation.grades);
        assert.notEqual(irs[0].target.kind, 'global');

        assert.equal(irs[0].executionStatus, 'blocked_by_reference');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].executionStatus, 'blocked_by_reference');
    }
});

test('第 115 行按三个明确学科保留九年级、每周至少 3 次和避开下午语义', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 115);
    const irs = irsByRow(result, 115);
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);
    const preferred = irs.filter(item => item.capabilityId === 'subject.preferred_periods');
    const concentration = irs.find(item => item.capabilityId === 'subject.avoid_day_part_concentration');

    assert.equal(preferred.length, 3);
    assert.deepEqual(preferred.map(item => item.target.name).sort(), ['数学', '英语', '语文']);
    preferred.forEach((ir) => {
        assert.equal(ir.target.kind, 'subject');
        assert.deepEqual(ir.parameters.gradeNames, ['九年级']);
        assert.equal(ir.parameters.minOccurrences, 3);
        assert.deepEqual(ir.parameters.periods, [1, 2, 3]);
        assert.equal(ir.parameters.avoidDayParts, undefined);
        assert.equal(ir.understandingStatus, 'invalid_reference');
        assert.equal(ir.executionStatus, 'blocked_by_reference');
        assert.equal(ir.reviewStatus, 'needs_clarification');
        assert.equal(ir.support, 'full');
        assert.deepEqual(ir.machineRuleIds, []);
        assert.doesNotMatch(ir.target.name, /九年级主科|主科/);
    });
    assert.ok(concentration);
    assert.equal(concentration.target.kind, 'subject_group');
    assert.equal(concentration.target.name, '语文、数学、英语');
    assert.deepEqual(concentration.parameters.gradeNames, ['九年级']);
    assert.equal(concentration.parameters.dayPart, 'afternoon');
    assert.equal(concentration.executionStatus, 'unsupported_by_solver');
    assert.equal(concentration.support, 'none');
    assert.deepEqual(concentration.machineRuleIds, []);
    assert.equal(rows.length, 3);
    assert.ok(rows.every(row => row.type === 'advanced_constraint' && row.executionStatus === 'blocked_by_reference'));
});

test('第 116 行数学和英语都继承七年级范围，且最后一节按第 8 节保留', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 116);
    const irs = irsByRow(result, 116);
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);
    const avoided = irs.filter(item => item.capabilityId === 'subject.avoid_periods');

    assert.equal(avoided.length, 2);
    assert.deepEqual(avoided.map(item => item.target.name).sort(), ['数学', '英语']);
    avoided.forEach((ir) => {
        assert.equal(ir.target.kind, 'subject');
        assert.deepEqual(ir.parameters.gradeNames, ['七年级']);
        assert.deepEqual(ir.parameters.periods, [8]);
        assert.equal(ir.understandingStatus, 'invalid_reference');
        assert.equal(ir.executionStatus, 'blocked_by_reference');
        assert.equal(ir.reviewStatus, 'needs_clarification');
        assert.equal(ir.support, 'full');
        assert.deepEqual(ir.machineRuleIds, []);
        assert.doesNotMatch(ir.target.name, /七年级数学/);
    });
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.type === 'advanced_constraint' && row.executionStatus === 'blocked_by_reference'));
});

test('第 117 行的硬禁排与软避让必须拆成两个独立子句', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 117);
    const irs = irsByRow(result, 117).filter(item => item.capabilityId === 'subject.avoid_periods');
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);

    assert.equal(irs.length, 2);
    assert.ok(irs.every(item => item.target.kind === 'subject' && item.target.name === '体育'));
    const firstPeriod = irs.find(item => item.parameters.periods?.length === 1 && item.parameters.periods[0] === 1);
    const fifthPeriod = irs.find(item => item.parameters.periods?.length === 1 && item.parameters.periods[0] === 5);
    assert.ok(firstPeriod, '“每天第一节不要排”必须保留为独立子句');
    assert.ok(fifthPeriod, '“尽量不要排第5节”必须保留为独立子句');
    assert.equal(firstPeriod.strength, 'hard');
    assert.equal(fifthPeriod.strength, 'soft');
    assert.notEqual(firstPeriod.clauseId, fifthPeriod.clauseId);

    assert.equal(rows.length, 2);
    assert.equal(rows.find(item => item.periods?.length === 1 && item.periods[0] === 1)?.priority, 'hard');
    assert.equal(rows.find(item => item.periods?.length === 1 && item.periods[0] === 5)?.priority, 'soft');
});
test('第 130 行识别为历史和道法同日不连续，不得伪造成课程先后顺序', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 130);
    const irs = irsByRow(result, 130);
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);

    assert.equal(irs.length, 1);
    assert.equal(irs[0].capabilityId, 'subject.not_consecutive_with');
    assert.equal(irs[0].target.kind, 'subject_group');
    assert.deepEqual((irs[0].parameters.subjectNames || []).sort(), ['历史', '道法']);
    assert.equal(irs[0].parameters.sameDay, true);
    assert.equal(irs[0].understandingStatus, 'invalid_reference');
    assert.equal(irs[0].executionStatus, 'blocked_by_reference');
    assert.equal(irs[0].reviewStatus, 'needs_clarification');
    assert.equal(irs[0].support, 'full');
    assert.deepEqual(irs[0].machineRuleIds, []);
    assert.equal(irs.some(item => item.capabilityId === 'subject.sequence'), false);
    assert.equal(rows.some(item => item.type === 'subject_sequence'), false);
});

test('第 132 行五个考试学科都继承九年级和周五第 8 节范围', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 132);
    const irs = irsByRow(result, 132);
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);
    const avoided = irs.filter(item => item.capabilityId === 'subject.avoid_periods');

    assert.equal(avoided.length, 5);
    assert.deepEqual(avoided.map(item => item.target.name).sort(), ['化学', '数学', '物理', '英语', '语文']);
    avoided.forEach((ir) => {
        assert.equal(ir.target.kind, 'subject');
        assert.deepEqual(ir.parameters.gradeNames, ['九年级']);
        assert.deepEqual(ir.parameters.days, [5]);
        assert.deepEqual(ir.parameters.periods, [8]);
        assert.equal(ir.understandingStatus, 'invalid_reference');
        assert.equal(ir.executionStatus, 'blocked_by_reference');
        assert.equal(ir.reviewStatus, 'needs_clarification');
        assert.equal(ir.support, 'full');
        assert.deepEqual(ir.machineRuleIds, []);
        assert.doesNotMatch(ir.target.name, /九年级考试学科|考试学科/);
    });
    assert.equal(rows.length, 5);
    assert.ok(rows.every(row => row.type === 'advanced_constraint' && row.executionStatus === 'blocked_by_reference'));
});

test('第 137 行保留主科新授课与教研社团答疑活动范围，不降级为普通学科避让', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 137);
    const irs = irsByRow(result, 137);
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);

    assert.equal(irs.length, 1);
    assert.equal(irs[0].capabilityId, 'lesson.activity_scope_period_policy');
    assert.equal(irs[0].target.kind, 'subject_group');
    assert.deepEqual((irs[0].parameters.subjectNames || []).sort(), ['数学', '英语', '语文']);
    assert.deepEqual(irs[0].parameters.activityTypes, ['新授课']);
    assert.deepEqual((irs[0].parameters.preferredActivityTypes || []).sort(), ['教研', '社团', '答疑']);
    assert.deepEqual(irs[0].parameters.days, [3]);
    assert.deepEqual(irs[0].parameters.periods, [8]);
    assert.equal(irs[0].understandingStatus, 'invalid_reference');
    assert.equal(irs[0].executionStatus, 'blocked_by_reference');
    assert.equal(irs[0].reviewStatus, 'needs_clarification');
    assert.equal(irs[0].support, 'full');
    assert.deepEqual(irs[0].machineRuleIds, []);
    assert.equal(irs.some(item => item.capabilityId === 'subject.avoid_periods'), false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'advanced_constraint');
    assert.equal(rows[0].executionStatus, 'blocked_by_reference');
});

test('第 138 行识别资源属性避让，不得臆造实验课和信息课两个学科', async () => {
    const result = await parseFixture();
    const source = sourceByRow(result, 138);
    const irs = irsByRow(result, 138);
    const rows = result.draftRows.filter(item => item.sourceId === source.sourceId);

    assert.equal(irs.length, 1);
    assert.equal(irs[0].capabilityId, 'lesson.resource_attribute_avoid_periods');
    assert.deepEqual((irs[0].parameters.requiredResourceTypes || []).sort(), ['computer_room', 'lab']);
    assert.deepEqual(irs[0].parameters.days, [5]);
    assert.deepEqual(irs[0].parameters.periods, [8]);
    assert.equal(irs[0].understandingStatus, 'parsed');
    assert.equal(irs[0].executionStatus, 'blocked_by_clarification');
    assert.equal(irs[0].reviewStatus, 'needs_clarification');
    assert.equal(irs[0].support, 'full');
    assert.deepEqual(irs[0].machineRuleIds, []);
    assert.doesNotMatch(irs[0].target.name, /实验课|信息课/);
    assert.equal(rows.some(item => /实验课|信息课/.test(item.targetName || item.subjectName || '')), false);
    assert.equal(rows.length, 0);
});
