import fs from 'node:fs';
import path from 'node:path';

import { parseTimetableRules } from '../gateway/services/timetable-rule-parser.js';
import { createCompleteNaturalLanguage137Project } from '../test/fixtures/timetable-natural-language-137-project.js';
import { TIMETABLE_CONSTRAINT_WORKBOOK_PATH } from '../test/fixtures/timetable-workbook-paths.js';
import {
    buildSourceId,
    buildTextHash,
} from '../gateway/services/timetable-constraints/source-identity.js';
import { buildRequirementStatistics } from '../gateway/services/timetable-constraints/statistics.js';

const EXPECTED_SOURCE_COUNT = 137;
const EXPECTED_CONSTRAINT_IR_COUNT = 154;
const COMPLEX_SEMANTIC_BASELINE = new Map([
    [114, { clauseCount: 6, machineRuleCount: 6, explanation: '3 条课程上午偏好 + 3 条教师覆盖 emphasis 子句。' }],
    [115, { clauseCount: 4, machineRuleCount: 3, unresolvedCount: 1, explanation: '3 条每周至少 3 次的课程偏好 + 1 条暂未落地的下午集中度语义。' }],
    [116, { clauseCount: 2, machineRuleCount: 2, rationaleCount: 1, explanation: '七年级数学、英语分别形成动态末节避让，学习压力说明保留为 rationale。' }],
    [117, { clauseCount: 2, machineRuleCount: 2, explanation: '体育第 1 节硬避让和第 5 节软避让分开编译。' }],
    [118, { clauseCount: 1, machineRuleCount: 1, rationaleCount: 1, explanation: '音乐第 6-8 节下午偏好，黄金时段说明保留为 rationale。' }],
    [120, { clauseCount: 1, machineRuleCount: 1, rationaleCount: 1, explanation: '劳动第 6、7 节偏好，材料领取与整理说明保留为 rationale。' }],
    [132, { clauseCount: 5, machineRuleCount: 5, explanation: '九年级五门考试学科分别继承周五第 8 节硬避让。' }],
]);
const EXPECTED_SHEET = '自然语言约束';
const root = process.cwd();
const workbookPath = TIMETABLE_CONSTRAINT_WORKBOOK_PATH;
const fixturePath = path.join(root, 'test', 'fixtures', 'timetable-natural-language-137.json');
const reportPath = path.join(root, '.tmp-audit-137.json');

const failures = [];
let passedCheckCount = 0;

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function identity(value = {}) {
    return value.machineRuleId || value.constraintId || value.clauseId || value.id || '';
}

function recordCheck(condition, code, message, details = undefined) {
    if (condition) {
        passedCheckCount += 1;
        return;
    }
    failures.push({ code, message, ...(details === undefined ? {} : { details }) });
}

function duplicateValues(values = []) {
    const seen = new Set();
    const duplicates = new Set();
    for (const value of values) {
        if (!value) continue;
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
    }
    return [...duplicates];
}

function compactConstraintIR(ir = {}) {
    return {
        constraintId: ir.constraintId || '',
        clauseId: ir.clauseId || '',
        capabilityId: ir.capabilityId || '',
        intent: ir.intent || '',
        target: ir.target || {},
        scope: ir.scope || {},
        time: ir.time || {},
        relation: ir.relation || {},
        parameters: ir.parameters || {},
        strength: ir.strength || '',
        understandingStatus: ir.understandingStatus || '',
        executionStatus: ir.executionStatus || '',
        reviewStatus: ir.reviewStatus || '',
        support: ir.support || '',
        landing: asArray(ir.landing),
        machineRuleIds: asArray(ir.machineRuleIds),
        warnings: asArray(ir.warnings),
        clarifications: asArray(ir.clarifications),
    };
}

function compactClause(clause = {}) {
    return {
        clauseId: clause.clauseId || clause.constraintId || clause.id || '',
        capabilityId: clause.capabilityId || '',
        intent: clause.intent || '',
        object: clause.object || {},
        condition: clause.condition || {},
        parameters: clause.parameters || {},
        strength: clause.strength || '',
        understandingStatus: clause.understandingStatus || '',
        executionStatus: clause.executionStatus || '',
        reviewStatus: clause.reviewStatus || '',
        support: clause.support || '',
        machineRuleIds: asArray(clause.machineRuleIds),
        warnings: asArray(clause.warnings),
        clarifications: asArray(clause.clarifications),
    };
}

function compactDraftRow(row = {}) {
    return {
        rowId: row.id || '',
        machineRuleId: row.machineRuleId || '',
        clauseId: row.clauseId || '',
        capabilityId: row.capabilityId || '',
        type: row.type || '',
        targetType: row.targetType || '',
        targetId: row.targetId || '',
        targetName: row.targetName || '',
        priority: row.priority || '',
        status: row.status || '',
        understandingStatus: row.understandingStatus || '',
        executionStatus: row.executionStatus || '',
        reviewStatus: row.reviewStatus || '',
        support: row.support || '',
        warnings: asArray(row.warnings),
        clarifications: asArray(row.clarifications),
    };
}

function writeReport(report) {
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main() {
    recordCheck(fs.existsSync(workbookPath), 'missing_workbook', '缺少真实 Excel 文件。', { workbookPath });
    recordCheck(fs.existsSync(fixturePath), 'missing_fixture', '缺少 137 条正式 fixture。', { fixturePath });
    if (failures.length) {
        writeReport({ generatedAt: new Date().toISOString(), failures, items: [] });
        return;
    }

    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const parseResult = await parseTimetableRules({
        file: {
            filename: path.basename(workbookPath),
            buffer: fs.readFileSync(workbookPath),
        },
        project: createCompleteNaturalLanguage137Project(),
        env: {
            TIMETABLE_RULE_AI_MODE: 'off',
            TIMETABLE_RULE_AI_REVIEW_DISABLED: 'true',
        },
    });

    const sources = asArray(parseResult.sourceRequirements);
    const constraintIRs = asArray(parseResult.constraintIRs);
    const draftRows = asArray(parseResult.draftRows);
    const requirementItems = asArray(parseResult.requirementItems);
    const systemSupplements = asArray(parseResult.systemSupplements);
    const fixtureRows = fixture.map(item => item.sourceRow);
    const sourceRows = sources.map(item => item.source?.rowNumber);
    const sourceIds = sources.map(item => item.sourceId);
    const fixtureByRow = new Map(fixture.map(item => [item.sourceRow, item]));
    const sourceByRow = new Map(sources.map(item => [item.source?.rowNumber, item]));
    const sourceById = new Map(sources.map(item => [item.sourceId, item]));

    recordCheck(Array.isArray(fixture), 'fixture_not_array', 'fixture 顶层必须是数组。');
    recordCheck(fixture.length === EXPECTED_SOURCE_COUNT, 'fixture_count_mismatch', 'fixture 条数必须为 137。', { actual: fixture.length });
    recordCheck(duplicateValues(fixtureRows).length === 0, 'fixture_duplicate_rows', 'fixture sourceRow 必须唯一。', { duplicates: duplicateValues(fixtureRows) });
    recordCheck(
        fixture.every(item => item.sourceSheet === EXPECTED_SHEET && typeof item.rawText === 'string' && item.rawText.trim()),
        'fixture_invalid_source',
        'fixture 每项必须保留工作表、行号和非空原文。',
    );
    recordCheck(sources.length === EXPECTED_SOURCE_COUNT, 'excel_source_count_mismatch', 'Excel 解析出的顶层 sourceRequirements 必须为 137。', { actual: sources.length });
    recordCheck(duplicateValues(sourceRows).length === 0, 'excel_duplicate_rows', 'Excel sourceRow 必须唯一。', { duplicates: duplicateValues(sourceRows) });
    recordCheck(duplicateValues(sourceIds).length === 0, 'duplicate_source_ids', 'sourceId 必须唯一。', { duplicates: duplicateValues(sourceIds) });
    recordCheck(sourceIds.every(Boolean), 'missing_source_id', '每个顶层来源都必须有 sourceId。');
    recordCheck(parseResult.statistics?.sourceRequirementCount === EXPECTED_SOURCE_COUNT, 'statistics_source_count_mismatch', 'statistics.sourceRequirementCount 必须为 137.', { actual: parseResult.statistics?.sourceRequirementCount });
    recordCheck(parseResult.statistics?.userInputCount === EXPECTED_SOURCE_COUNT, 'statistics_user_count_mismatch', 'statistics.userInputCount 必须为 137。', { actual: parseResult.statistics?.userInputCount });
    recordCheck(constraintIRs.length === EXPECTED_CONSTRAINT_IR_COUNT, 'constraint_ir_count_mismatch', `137 条基线必须稳定拆分为 ${EXPECTED_CONSTRAINT_IR_COUNT} 个 ConstraintIR。`, { actual: constraintIRs.length });

    for (const fixtureItem of fixture) {
        const source = sourceByRow.get(fixtureItem.sourceRow);
        recordCheck(Boolean(source), 'missing_excel_source_row', `Excel 解析结果缺少第 ${fixtureItem.sourceRow} 行。`, fixtureItem);
        if (!source) continue;
        recordCheck(source.source?.sheetName === fixtureItem.sourceSheet, 'source_sheet_mismatch', `第 ${fixtureItem.sourceRow} 行工作表不一致。`, { fixture: fixtureItem.sourceSheet, actual: source.source?.sheetName });
        recordCheck(source.source?.rawText === fixtureItem.rawText, 'raw_text_mismatch', `第 ${fixtureItem.sourceRow} 行原文与 fixture 不一致。`, { fixture: fixtureItem.rawText, actual: source.source?.rawText });
        recordCheck(source.textHash === buildTextHash(fixtureItem.rawText), 'text_hash_mismatch', `第 ${fixtureItem.sourceRow} 行 textHash 不正确。`, { sourceId: source.sourceId, textHash: source.textHash });
        recordCheck(
            source.sourceId === buildSourceId(source.source, {
                inputType: source.source?.inputType,
                fileName: source.source?.fileName,
                origin: source.origin,
            }),
            'source_id_not_deterministic',
            `第 ${fixtureItem.sourceRow} 行 sourceId 不是由当前稳定算法生成。`,
            { sourceId: source.sourceId },
        );
    }

    const sourceClauseCount = sources.reduce((total, source) => total + asArray(source.clauses).length, 0);
    const constraintIds = constraintIRs.map(ir => ir.constraintId || ir.clauseId);
    const clauseIdSet = new Set(constraintIds.filter(Boolean));
    recordCheck(constraintIds.every(Boolean), 'missing_constraint_id', '每个 ConstraintIR 都必须有稳定 constraintId/clauseId。');
    recordCheck(duplicateValues(constraintIds).length === 0, 'duplicate_constraint_ids', 'ConstraintIR ID 必须唯一。', { duplicates: duplicateValues(constraintIds) });
    recordCheck(sourceClauseCount === constraintIRs.length, 'source_clause_projection_mismatch', 'sourceRequirements.clauses 与 constraintIRs 数量必须一致。', { sourceClauseCount, constraintIrCount: constraintIRs.length });
    recordCheck(requirementItems.length === constraintIRs.length, 'legacy_projection_count_mismatch', '兼容 requirementItems 必须逐 clause 投影，不能改变顶层输入数。', { requirementItemCount: requirementItems.length, constraintIrCount: constraintIRs.length });
    recordCheck(parseResult.statistics?.clauseCount === constraintIRs.length, 'statistics_clause_count_mismatch', 'statistics.clauseCount 必须等于唯一 ConstraintIR 数量。', { statistics: parseResult.statistics?.clauseCount, actual: constraintIRs.length });

    for (const ir of constraintIRs) {
        const source = sourceById.get(ir.sourceId);
        recordCheck(Boolean(source), 'constraint_unknown_source', `ConstraintIR ${identity(ir)} 无法追溯到 sourceRequirement。`, { sourceId: ir.sourceId });
        if (!source) continue;
        recordCheck(ir.textHash === source.textHash, 'constraint_text_hash_mismatch', `ConstraintIR ${identity(ir)} 的 textHash 与来源不一致。`, { sourceId: ir.sourceId });
        recordCheck((ir.clauseId || ir.constraintId || '').startsWith(`${ir.sourceId}:clause:`), 'constraint_id_not_namespaced', `ConstraintIR ${identity(ir)} 未使用 sourceId 命名空间。`);
    }
    for (const source of sources) {
        for (const clause of asArray(source.clauses)) {
            const clauseId = clause.clauseId || clause.constraintId || clause.id;
            recordCheck(clauseIdSet.has(clauseId), 'source_clause_missing_ir', `来源 ${source.sourceId} 的 clause 未出现在 constraintIRs。`, { clauseId });
            recordCheck(clause.sourceId === source.sourceId, 'source_clause_provenance_mismatch', `来源 ${source.sourceId} 的 clause sourceId 不一致。`, { clauseId, actual: clause.sourceId });
        }
    }

    for (const [sourceRow, expected] of COMPLEX_SEMANTIC_BASELINE) {
        const source = sourceByRow.get(sourceRow);
        const clauses = asArray(source?.clauses);
        recordCheck(Boolean(source), 'complex_semantic_source_missing', `复杂语义基线缺少第 ${sourceRow} 行。`);
        if (!source) continue;
        recordCheck(clauses.length === expected.clauseCount, 'complex_semantic_clause_count_mismatch', `第 ${sourceRow} 行子句数量与复杂语义基线不一致。`, {
            expected: expected.clauseCount,
            actual: clauses.length,
            explanation: expected.explanation,
        });
        recordCheck(asArray(source.machineRuleIds).length === expected.machineRuleCount, 'complex_semantic_machine_count_mismatch', `第 ${sourceRow} 行机器规则数量与复杂语义基线不一致。`, {
            expected: expected.machineRuleCount,
            actual: asArray(source.machineRuleIds).length,
            explanation: expected.explanation,
        });
        if (expected.unresolvedCount !== undefined) {
            recordCheck(asArray(source.unresolvedClauseIds).length === expected.unresolvedCount, 'complex_semantic_unresolved_count_mismatch', `第 ${sourceRow} 行未落地语义数量与基线不一致。`, {
                expected: expected.unresolvedCount,
                actual: asArray(source.unresolvedClauseIds).length,
                explanation: expected.explanation,
            });
        }
        if (expected.rationaleCount !== undefined) {
            recordCheck(asArray(source.rationales).length === expected.rationaleCount, 'complex_semantic_rationale_count_mismatch', `第 ${sourceRow} 行原因说明数量与基线不一致。`, {
                expected: expected.rationaleCount,
                actual: asArray(source.rationales).length,
                explanation: expected.explanation,
            });
        }
    }

    const machineRows = draftRows.filter(row => row.machineRuleId);
    const machineRuleIds = machineRows.map(row => row.machineRuleId);
    const machineRuleIdSet = new Set(machineRuleIds.filter(Boolean));
    recordCheck(duplicateValues(machineRuleIds).length === 0, 'duplicate_machine_rule_ids', 'machineRuleId 必须唯一。', { duplicates: duplicateValues(machineRuleIds) });
    recordCheck(parseResult.statistics?.machineRuleCount === machineRows.length, 'statistics_machine_count_mismatch', 'statistics.machineRuleCount 必须等于带 machineRuleId 的可执行行数量。', { statistics: parseResult.statistics?.machineRuleCount, actual: machineRows.length });
    recordCheck(parseResult.statistics?.draftRowCount === draftRows.length, 'statistics_draft_count_mismatch', 'statistics.draftRowCount 必须等于 draftRows 数量。', { statistics: parseResult.statistics?.draftRowCount, actual: draftRows.length });

    for (const row of draftRows) {
        const machineRuleId = row.machineRuleId || '';
        const rowId = row.id || machineRuleId || '(anonymous draft row)';
        const source = sourceById.get(row.sourceId);
        recordCheck(Boolean(source), 'draft_row_unknown_source', `兼容行 ${rowId} 无法追溯到 sourceRequirement。`, { sourceId: row.sourceId });
        if (!source) continue;
        recordCheck(row.textHash === source.textHash, 'draft_row_text_hash_mismatch', `兼容行 ${rowId} 的 textHash 与来源不一致。`, { sourceId: row.sourceId });
        recordCheck(clauseIdSet.has(row.clauseId), 'draft_row_unknown_clause', `兼容行 ${rowId} 无法追溯到 ConstraintIR clause。`, { clauseId: row.clauseId });
        if (machineRuleId) {
            recordCheck(asArray(source.machineRuleIds).includes(machineRuleId), 'source_missing_machine_rule', `来源 ${source.sourceId} 未声明其机器规则 ${machineRuleId}。`);
        } else {
            recordCheck(
                ['blocked_by_reference', 'blocked_by_clarification', 'unsupported_by_solver'].includes(row.executionStatus),
                'review_row_missing_machine_rule_without_blocking_status',
                `无 machineRuleId 的兼容行 ${rowId} 必须明确为待绑定、待补充或求解器不支持。`,
                { executionStatus: row.executionStatus },
            );
        }
    }
    for (const source of sources) {
        for (const machineRuleId of asArray(source.machineRuleIds)) {
            recordCheck(machineRuleIdSet.has(machineRuleId), 'source_machine_rule_missing_row', `来源 ${source.sourceId} 引用了不存在的机器规则。`, { machineRuleId });
        }
    }

    const actualUserSources = sources.filter(source => source.origin === 'user_input');
    recordCheck(actualUserSources.length === parseResult.statistics?.userInputCount, 'system_supplement_polluted_user_count', 'userInputCount 只能统计 user_input 来源。', { actualUserSources: actualUserSources.length, statistics: parseResult.statistics?.userInputCount });
    recordCheck(systemSupplements.length === (parseResult.statistics?.systemSupplementCount || 0), 'system_supplement_count_mismatch', 'system supplement 必须独立统计。', { actual: systemSupplements.length, statistics: parseResult.statistics?.systemSupplementCount });
    const syntheticStatistics = buildRequirementStatistics({
        sourceRequirements: [
            { sourceId: 'audit:user', origin: 'user_input', clauses: [] },
            { sourceId: 'audit:manual', origin: 'manual', clauses: [] },
        ],
        systemSupplements: [{ supplementId: 'audit:system' }],
    });
    recordCheck(
        syntheticStatistics.userInputCount === 1
            && syntheticStatistics.manualInputCount === 1
            && syntheticStatistics.systemSupplementCount === 1,
        'statistics_origin_separation_failed',
        '统计函数必须把 user_input、manual 和 system_supplement 完全分开。',
        syntheticStatistics,
    );

    const irsBySourceId = new Map();
    const rowsBySourceId = new Map();
    for (const ir of constraintIRs) {
        if (!irsBySourceId.has(ir.sourceId)) irsBySourceId.set(ir.sourceId, []);
        irsBySourceId.get(ir.sourceId).push(compactConstraintIR(ir));
    }
    for (const row of draftRows) {
        if (!rowsBySourceId.has(row.sourceId)) rowsBySourceId.set(row.sourceId, []);
        rowsBySourceId.get(row.sourceId).push(compactDraftRow(row));
    }

    const items = [...sources]
        .sort((left, right) => (left.source?.rowNumber || 0) - (right.source?.rowNumber || 0))
        .map(source => ({
            sourceRow: source.source?.rowNumber || null,
            sourceSheet: source.source?.sheetName || '',
            sourceId: source.sourceId || '',
            textHash: source.textHash || source.source?.textHash || '',
            rawText: source.source?.rawText || source.rawText || '',
            origin: source.origin || '',
            parsedBy: asArray(source.parsedBy),
            status: source.status || '',
            understandingStatus: source.understandingStatus || '',
            executionStatus: source.executionStatus || '',
            reviewStatus: source.reviewStatus || '',
            warnings: asArray(source.warnings),
            questions: asArray(source.questions),
            rationales: asArray(source.rationales),
            partiallyApplicable: source.partiallyApplicable === true,
            applicableMachineRuleIds: asArray(source.applicableMachineRuleIds),
            unresolvedClauseIds: asArray(source.unresolvedClauseIds),
            semanticBaselineExplanation: COMPLEX_SEMANTIC_BASELINE.get(source.source?.rowNumber)?.explanation || '',
            clauses: asArray(source.clauses).map(compactClause),
            constraintIRs: irsBySourceId.get(source.sourceId) || [],
            machineRuleIds: asArray(source.machineRuleIds),
            draftRows: rowsBySourceId.get(source.sourceId) || [],
        }));

    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        inputs: {
            workbookPath: path.relative(root, workbookPath),
            fixturePath: path.relative(root, fixturePath),
            expectedSourceCount: EXPECTED_SOURCE_COUNT,
            expectedConstraintIrCount: EXPECTED_CONSTRAINT_IR_COUNT,
        },
        parser: {
            schemaVersion: parseResult.schemaVersion,
            parserVersion: parseResult.parserVersion,
            cacheHit: Boolean(parseResult.cacheHit),
        },
        summary: {
            excelSourceCount: sources.length,
            fixtureSourceCount: fixture.length,
            userInputCount: parseResult.statistics?.userInputCount || 0,
            sourceRequirementCount: parseResult.statistics?.sourceRequirementCount || 0,
            constraintIrCount: constraintIRs.length,
            clauseCount: parseResult.statistics?.clauseCount || 0,
            machineRuleCount: parseResult.statistics?.machineRuleCount || 0,
            draftRowCount: draftRows.length,
            requirementItemCount: requirementItems.length,
            systemSupplementCount: parseResult.statistics?.systemSupplementCount || 0,
            uniqueSourceIdCount: new Set(sourceIds).size,
            uniqueConstraintIdCount: clauseIdSet.size,
            uniqueMachineRuleIdCount: machineRuleIdSet.size,
            passedCheckCount,
            failedCheckCount: failures.length,
        },
        statistics: parseResult.statistics || {},
        failures,
        items,
    };
    writeReport(report);

    if (!failures.length) {
        console.log(`137 条自然语言审计通过：${sources.length} 个顶层来源，${constraintIRs.length} 个 ConstraintIR，${draftRows.length} 个兼容行，${machineRows.length} 个机器规则。`);
        console.log(`审计报告：${path.relative(root, reportPath)}`);
    }
}

try {
    await main();
} catch (error) {
    failures.push({
        code: 'audit_runtime_error',
        message: error?.message || String(error),
        stack: error?.stack || '',
    });
    writeReport({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        failures,
        items: [],
    });
}

if (failures.length) {
    console.error(`137 条自然语言审计失败：${failures.length} 项。`);
    for (const failure of failures.slice(0, 20)) {
        console.error(`- [${failure.code}] ${failure.message}`);
    }
    if (failures.length > 20) console.error(`- 其余 ${failures.length - 20} 项见 ${path.relative(root, reportPath)}`);
    process.exitCode = 1;
}
