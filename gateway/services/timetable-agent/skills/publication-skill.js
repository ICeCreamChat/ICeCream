import { normalizeTimetableProject, validateTimetablePublication } from '../../timetable-scheduler.js';
import { makeTimetableAgentArtifactId } from '../timetable-agent-state.js';

function scheduleSummary(schedule = null) {
    return {
        scheduleId: schedule?.id || null,
        source: schedule?.source || null,
        slotCount: (schedule?.slots || []).length,
        lockedCount: (schedule?.slots || []).filter(slot => slot.locked).length,
        manuallyAdjustedCount: (schedule?.slots || []).filter(slot => slot.manuallyAdjusted).length,
        hardConflicts: Number(schedule?.score?.hardConflicts ?? (schedule?.conflicts || []).length ?? 0),
        unplacedLessons: Number(schedule?.score?.unplacedLessons ?? (schedule?.unplaced || []).length ?? 0),
        completeness: Number(schedule?.score?.completeness ?? 0),
    };
}

function slotFingerprint(slot = {}) {
    return [
        slot.day,
        slot.period,
        slot.classId,
        slot.subjectId,
        slot.teacherId,
        (slot.teacherIds || []).join(','),
        slot.lessonPlanId,
        slot.roomId || '',
        slot.blockId || '',
        slot.locked ? 'locked' : '',
        slot.manuallyAdjusted ? 'manual' : '',
    ].join('|');
}

function buildTimetableExportLinks() {
    return [
        { type: 'class', label: '班级课表', url: '/api/tools/timetable/export', method: 'POST', payload: { type: 'class' } },
        { type: 'teacher', label: '教师课表', url: '/api/tools/timetable/export', method: 'POST', payload: { type: 'teacher' } },
        { type: 'master', label: '总课表', url: '/api/tools/timetable/export', method: 'POST', payload: { type: 'master' } },
        { type: 'plans', label: '任课数据', url: '/api/tools/timetable/export', method: 'POST', payload: { type: 'plans' } },
    ];
}

function buildPublicationReport(project = {}, publication = {}) {
    const schedule = project.schedule || {};
    return {
        summary: {
            scheduleId: schedule.id || null,
            source: schedule.source || null,
            slotCount: (schedule.slots || []).length,
            totalLessons: schedule.score?.totalLessons ?? 0,
            placedLessons: schedule.score?.placedLessons ?? (schedule.slots || []).length,
            hardConflicts: schedule.score?.hardConflicts ?? 0,
            unplacedLessons: schedule.score?.unplacedLessons ?? (schedule.unplaced || []).length,
            publicationReady: Boolean(publication.ok),
        },
        warnings: publication.warnings || [],
        blockingIssues: publication.blockingIssues || [],
    };
}

export function buildTimetableSaveDiff(beforeProject = {}, afterProject = {}) {
    const beforeSchedule = beforeProject?.schedule || null;
    const afterSchedule = afterProject?.schedule || null;
    const beforeSlots = new Set((beforeSchedule?.slots || []).map(slotFingerprint));
    const afterSlots = new Set((afterSchedule?.slots || []).map(slotFingerprint));
    let addedSlots = 0;
    let removedSlots = 0;

    for (const key of afterSlots) {
        if (!beforeSlots.has(key)) addedSlots += 1;
    }
    for (const key of beforeSlots) {
        if (!afterSlots.has(key)) removedSlots += 1;
    }

    const before = scheduleSummary(beforeSchedule);
    const after = scheduleSummary(afterSchedule);
    return {
        before,
        after,
        beforeScheduleId: before.scheduleId,
        afterScheduleId: after.scheduleId,
        slotDelta: after.slotCount - before.slotCount,
        addedSlots,
        removedSlots,
        hardConflictDelta: after.hardConflicts - before.hardConflicts,
        unplacedDelta: after.unplacedLessons - before.unplacedLessons,
        willOverwrite: Boolean(beforeSchedule?.id && afterSchedule?.id && beforeSchedule.id !== afterSchedule.id),
    };
}

export async function runPublicationSkill({ project, solution = {}, approval = {}, saveProject = null } = {}) {
    const previewProject = normalizeTimetableProject(solution.project || {
        ...project,
        schedule: solution.schedule || project?.schedule || null,
    });
    const diff = buildTimetableSaveDiff(project, previewProject);

    if (!approval.approved) {
        return {
            saved: false,
            project,
            exportLinks: [],
            report: {},
            artifacts: [{
                id: makeTimetableAgentArtifactId('save_preview'),
                type: 'save_preview',
                title: '保存预览',
                diff,
                solution,
                requiresApproval: true,
            }],
            nextAction: 'await_approval',
        };
    }

    const publication = validateTimetablePublication(previewProject);
    if (!publication.ok) {
        return {
            saved: false,
            project,
            exportLinks: [],
            report: { publication },
            warnings: publication.blockingIssues || [],
            artifacts: [{
                id: makeTimetableAgentArtifactId('save_preview'),
                type: 'save_preview',
                title: '保存被阻止',
                diff,
                solution,
                requiresApproval: true,
                publication,
            }],
            nextAction: 'failed',
        };
    }

    const saved = typeof saveProject === 'function' ? await saveProject(previewProject) : previewProject;
    const exportLinks = buildTimetableExportLinks();
    const report = buildPublicationReport(saved, publication);
    return {
        saved: true,
        project: saved,
        exportLinks,
        report,
        artifacts: [
            {
                id: makeTimetableAgentArtifactId('save_preview'),
                type: 'save_preview',
                title: '已保存正式课表',
                diff,
                solution,
                requiresApproval: false,
                publication,
                report,
            },
            {
                id: makeTimetableAgentArtifactId('export_result'),
                type: 'export_result',
                title: '导出入口',
                summary: '课表已保存，可继续导出班级课表、教师课表、总课表或任课数据。',
                exportLinks,
                report,
            },
        ],
        nextAction: 'done',
    };
}
