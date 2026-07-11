import { createDefaultTimetableProject } from '../../gateway/services/timetable-project.js';
import { parseTimetableRules } from '../../gateway/services/timetable-rule-parser.js';
import {
    aggregateCorpusScores,
    loadConstraintCorpus,
    localParseResultToRequirements,
    scoreCorpusRow,
    validateConstraintCorpus,
} from './timetable-market-language-corpus.js';

export function createMarketLanguageGoldenProject() {
    const subjects = [
        ['math', '数学', 90], ['chinese', '语文', 90], ['english', '英语', 85],
        ['pe', '体育', 30], ['music', '音乐', 25], ['art', '美术', 25],
        ['physics', '物理', 80], ['chemistry', '化学', 80], ['biology', '生物', 80],
        ['science', '科学', 75], ['it', '信息技术', 45], ['football', '足球', 25],
        ['theory', '理论课', 60], ['experiment', '实验课', 60], ['club', '社团课', 30],
        ['school_based', '校本课', 35], ['enrichment', '培优课', 60],
    ].map(([id, name, priority]) => ({ id, name, priority, color: '#64748b' }));
    const teachers = [
        { id: 't_zhang', name: '张老师', subjects: ['math', 'physics'], unavailableSlots: [] },
        { id: 't_wang', name: '王老师', subjects: ['chinese', 'english'], unavailableSlots: [] },
        { id: 't_li', name: '李老师', subjects: ['physics', 'chemistry', 'biology'], unavailableSlots: [] },
    ];
    const classes = [
        { id: 'c3_1', grade: '三', name: '1班' },
        { id: 'c7_1', grade: '七年级', name: '1班' },
        { id: 'c7_2', grade: '七年级', name: '2班' },
        { id: 'c9_1', grade: '九年级', name: '1班' },
    ];
    return createDefaultTimetableProject({
        schoolName: 'Market Language Golden Project',
        term: '2026',
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        dayPartBoundaries: { morningEndPeriod: 4, afternoonStartPeriod: 5 },
        teachers,
        classes,
        subjects,
        rooms: [
            { id: 'lab', name: '实验室', tags: ['实验室', '实验'] },
            { id: 'computer_room', name: '机房', tags: ['机房', '信息技术'] },
            { id: 'playground', name: '操场', tags: ['操场', '运动'] },
            { id: 'gym', name: '体育馆', tags: ['体育馆', '运动'] },
        ],
        lessonPlans: [
            { id: 'lp_math', classId: 'c7_1', subjectId: 'math', teacherId: 't_zhang', weeklyHours: 5 },
            { id: 'lp_chinese', classId: 'c7_1', subjectId: 'chinese', teacherId: 't_wang', weeklyHours: 5 },
            { id: 'lp_physics', classId: 'c9_1', subjectId: 'physics', teacherId: 't_li', weeklyHours: 3 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });
}

export async function evaluateLocalMarketLanguageCorpus({ rows = null, project = null, onProgress = null } = {}) {
    const corpus = rows ? { rows, hash: '', errors: [] } : await loadConstraintCorpus();
    if (corpus.errors?.length) throw new Error(corpus.errors.join('\n'));
    const validation = validateConstraintCorpus(corpus.rows);
    if (!validation.valid) throw new Error(validation.errors.join('\n'));
    const targetProject = project || createMarketLanguageGoldenProject();
    const scores = [];
    const details = [];
    for (let index = 0; index < corpus.rows.length; index += 1) {
        const row = corpus.rows[index];
        const result = await parseTimetableRules({
            project: targetProject,
            text: row.text,
            env: {
                TIMETABLE_RULE_AI_EXTRACT: '0',
                TIMETABLE_RULE_AI_REVIEW_DISABLED: '1',
                DEEPSEEK_API_KEY: '',
                OPENAI_API_KEY: '',
            },
        });
        const actualRequirements = localParseResultToRequirements(result, {
            morningEndPeriod: targetProject.dayPartBoundaries?.morningEndPeriod || 4,
        });
        const score = scoreCorpusRow(row, actualRequirements, {
            semanticRequirements: result.requirementItems || [],
            sourceRequirements: result.sourceRequirements || [],
        });
        const constraintIRs = Array.isArray(result.constraintIRs) ? result.constraintIRs : [];
        const unsupportedIrMachineRules = constraintIRs
            .filter(ir => ir.executionStatus === 'unsupported_by_solver'
                && Array.isArray(ir.machineRuleIds)
                && ir.machineRuleIds.length > 0)
            .map(ir => ({
                corpusId: row.id,
                constraintId: ir.constraintId,
                capabilityId: ir.capabilityId,
                machineRuleIds: [...ir.machineRuleIds],
            }));
        scores.push(score);
        details.push({
            id: row.id,
            text: row.text,
            primaryCategory: row.primaryCategory,
            categories: row.categories,
            covered: score.covered,
            intentMisses: score.intentMisses,
            fieldHits: score.fields.hits,
            fieldTotal: score.fields.total,
            fieldMisses: score.fields.misses,
            clarificationOk: score.clarificationOk,
            sourcePreserved: score.sourcePreserved,
            sourceAligned: score.sourceAligned,
            sourceCount: result.sourceRequirements?.length || 0,
            clauseCount: result.sourceRequirements?.[0]?.clauses?.length || 0,
            machineRuleCount: (result.draftRows || []).filter(item => item.machineRuleId).length,
            actualIntents: score.actualIntents,
            capabilityIds: [...new Set(constraintIRs.map(ir => ir.capabilityId).filter(Boolean))],
            unsupportedIrMachineRules,
            warnings: result.warnings || [],
        });
        onProgress?.({ index: index + 1, total: corpus.rows.length, row, score });
    }
    return {
        generatedAt: new Date().toISOString(),
        parserVersion: details.length ? undefined : '',
        corpusHash: corpus.hash,
        validation: validation.metrics,
        metrics: aggregateCorpusScores(scores),
        details,
    };
}
