import { detectScheduleConflicts } from '../../timetable-conflicts.js';
import { runTimetableScheduler, validateTimetableProjectForSolve } from '../../timetable-scheduler.js';
import {
    solveTimetableWithTimefold,
    TimetableTimefoldError,
} from '../../timetable-solver-bridge.js';
import { validateTimetablePublication } from '../../timetable-validation.js';
import {
    makeTimetableAgentActionId,
    makeTimetableAgentArtifactId,
} from '../timetable-agent-state.js';
import { buildTimetableSaveDiff } from './publication-skill.js';

function scoreForSchedule(schedule = {}) {
    const score = schedule.score || {};
    return {
        totalScore: Math.max(0, Math.round((score.softScore ?? score.softSatisfaction ?? 0) - (score.hardConflicts || 0) * 20)),
        hardViolationCount: score.hardConflicts || 0,
        softViolationCount: Math.max(0, 100 - (score.softSatisfaction || score.softScore || 0)),
        teacherBalanceScore: score.softBreakdown?.teacherBalance?.score ?? null,
        subjectDistributionScore: score.softBreakdown?.subjectSpread?.score ?? null,
        morningCoreSubjectScore: score.softBreakdown?.morningSubjects?.score ?? null,
        gapPenalty: score.softBreakdown?.teacherGaps?.penalty ?? null,
        consecutivePenalty: score.softBreakdown?.teacherConsecutive?.penalty ?? null,
        classDailyLoadScore: score.softBreakdown?.classDailyLoad?.score ?? null,
        explanation: `已排 ${score.placedLessons || 0}/${score.totalLessons || 0} 节，硬冲突 ${score.hardConflicts || 0} 个。`,
    };
}

function solutionFromResult(result, { solverUsed, fallbackUsed, explanation }) {
    const schedule = result.schedule || {};
    const conflicts = [
        ...(schedule.conflicts || []),
        ...detectScheduleConflicts(result.project || {}, schedule.slots || []),
    ];
    const hardConflictCount = conflicts.filter(item => item.severity === 'hard').length;
    const score = scoreForSchedule({
        ...schedule,
        score: {
            ...(schedule.score || {}),
            hardConflicts: Math.max(schedule.score?.hardConflicts || 0, hardConflictCount),
        },
    });
    return {
        id: schedule.id || `solution_${Date.now()}_${solverUsed}`,
        name: solverUsed === 'timefold' ? 'Timefold 优化方案' : '本地快速方案',
        solverUsed,
        fallbackUsed,
        schedule,
        project: result.project,
        score,
        violations: conflicts,
        canSave: score.hardViolationCount === 0 && !(schedule.unplaced || []).length,
        explanation,
    };
}

function solutionRank(solution = {}) {
    const canSaveBonus = solution.canSave ? 100000 : 0;
    const hardPenalty = Number(solution.score?.hardViolationCount || 0) * 10000;
    const unplacedPenalty = Number(solution.schedule?.unplaced?.length || 0) * 1000;
    return canSaveBonus + Number(solution.score?.totalScore || 0) - hardPenalty - unplacedPenalty;
}

function bestSolutionOf(solutions = []) {
    return [...solutions].sort((left, right) => solutionRank(right) - solutionRank(left))[0] || null;
}

function solutionComparison(solutions = [], bestSolutionId = null) {
    return solutions.map(solution => ({
        id: solution.id,
        name: solution.name,
        solverUsed: solution.solverUsed,
        fallbackUsed: solution.fallbackUsed,
        totalScore: solution.score?.totalScore ?? 0,
        hardViolationCount: solution.score?.hardViolationCount ?? 0,
        softViolationCount: solution.score?.softViolationCount ?? 0,
        completeness: solution.schedule?.score?.completeness ?? 0,
        canSave: Boolean(solution.canSave),
        recommended: Boolean(bestSolutionId && solution.id === bestSolutionId),
        explanation: solution.explanation,
    }));
}

function projectForSolution(baseProject = {}, solution = {}) {
    return solution.project || {
        ...baseProject,
        schedule: solution.schedule || baseProject.schedule || null,
    };
}

function saveApprovalsForSolutions({ project, solutions = [], bestSolution = null } = {}) {
    return solutions
        .filter(solution => solution.canSave)
        .map(solution => {
            const solutionProject = projectForSolution(project, solution);
            const publication = validateTimetablePublication(solutionProject);
            if (!publication.ok) return null;
            const recommended = Boolean(bestSolution?.id && solution.id === bestSolution.id);
            const diff = buildTimetableSaveDiff(project, solutionProject);
            return {
                id: makeTimetableAgentActionId('save_solution'),
                type: 'save_solution',
                title: recommended ? `保存推荐方案：${solution.name}` : `保存候选方案：${solution.name}`,
                description: `总分 ${solution.score?.totalScore ?? 0}，硬冲突 ${solution.score?.hardViolationCount ?? 0}。保存会覆盖当前正式课表，必须再次确认。`,
                risk: 'high',
                requiresApproval: true,
                recommended,
                payload: {
                    solutionId: solution.id,
                    project: solution.project,
                    schedule: solution.schedule,
                    score: solution.score,
                    diff,
                },
            };
        })
        .filter(Boolean);
}

async function runTimefoldIfAvailable({ project, solvePlan, env, fetchImpl }) {
    if (solvePlan?.solverPreference === 'local_only' || !String(env?.TIMEFOLD_SOLVER_URL || '').trim()) {
        return { result: null, warning: 'Timefold 未配置，已切换为本地排课。' };
    }
    try {
        const result = await solveTimetableWithTimefold({ project, env, fetchImpl });
        return { result, warning: null };
    } catch (error) {
        if (error instanceof TimetableTimefoldError) {
            return { result: null, warning: `Timefold 不可用，已回退本地排课：${error.reason || error.message}` };
        }
        return { result: null, warning: `Timefold 求解异常，已回退本地排课：${error.message}` };
    }
}

function failedResult(validation) {
    const warning = { type: validation.reason, message: validation.message, details: validation.details || {} };
    return {
        status: 'failed',
        solverUsed: 'none',
        fallbackUsed: false,
        solutions: [],
        bestSolution: null,
        score: {},
        violations: [],
        warnings: [warning],
        explanation: '数据校验未通过，不能进入求解。',
        diagnosticsInput: { validation },
        artifacts: [{
            id: makeTimetableAgentArtifactId('solve_result'),
            type: 'solve_result',
            title: '求解失败',
            status: 'failed',
            solverUsed: 'none',
            fallbackUsed: false,
            solutions: [],
            comparison: [],
            warnings: [warning],
            explanation: validation.message,
        }],
        approvalQueue: [],
        nextAction: 'diagnose',
    };
}

export async function runSolveSkill({ project, solvePlan = {}, env = process.env, fetchImpl } = {}) {
    const validation = validateTimetableProjectForSolve(project);
    if (!validation.ok) return failedResult(validation);

    const localResult = runTimetableScheduler(project, { seed: solvePlan?.seed });
    const localSolution = solutionFromResult(localResult, {
        solverUsed: 'local_scheduler',
        fallbackUsed: true,
        explanation: '已使用本地排课算法生成确定性兜底候选方案。',
    });
    const timefold = await runTimefoldIfAvailable({ project, solvePlan, env, fetchImpl });
    const warnings = timefold.warning ? [{ type: 'solver_fallback', message: timefold.warning }] : [];
    const solutions = [localSolution];

    if (timefold.result) {
        solutions.push(solutionFromResult(timefold.result, {
            solverUsed: 'timefold',
            fallbackUsed: false,
            explanation: 'Timefold 返回了可校验候选方案。',
        }));
    }

    const bestSolution = bestSolutionOf(solutions);
    const bestProject = bestSolution?.project || localResult.project || project;
    const publication = validateTimetablePublication(bestProject);
    const status = bestSolution?.canSave && publication.ok
        ? 'solved'
        : solutions.some(solution => solution.schedule?.score?.hardConflicts === 0)
            ? 'partial'
            : 'failed';
    const comparison = solutionComparison(solutions, bestSolution?.id || null);
    const saveDiff = bestSolution
        ? buildTimetableSaveDiff(project, bestProject)
        : null;
    const artifact = {
        id: makeTimetableAgentArtifactId('solve_result'),
        type: 'solve_result',
        title: '排课方案',
        status,
        solverUsed: bestSolution?.solverUsed || 'none',
        fallbackUsed: !timefold.result,
        solutions,
        comparison,
        bestSolution,
        score: bestSolution?.score || {},
        violations: bestSolution?.violations || [],
        warnings,
        explanation: bestSolution?.explanation || '没有生成可用方案。',
        publication,
        savePreview: saveDiff ? { diff: saveDiff, requiresApproval: true } : null,
    };

    return {
        status,
        solverUsed: bestSolution?.solverUsed || 'none',
        fallbackUsed: !timefold.result,
        solutions,
        bestSolution,
        score: bestSolution?.score || {},
        violations: bestSolution?.violations || [],
        warnings,
        explanation: bestSolution?.explanation || '没有生成可用方案。',
        diagnosticsInput: status === 'failed' ? { publication, schedule: bestSolution?.schedule || null } : {},
        artifacts: [artifact],
        approvalQueue: saveApprovalsForSolutions({ project, solutions, bestSolution }),
        nextAction: bestSolution?.canSave ? 'await_approval' : 'diagnose',
    };
}
