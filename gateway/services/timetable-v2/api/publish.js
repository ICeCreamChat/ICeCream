import { createHash } from 'node:crypto';

import '../index.js'; // 触发硬/软约束自注册。
import { createProject } from '../domain/project.js';
import { expandActivityPlans } from '../domain/activity.js';
import { createSolution } from '../domain/solution.js';
import { buildContext, detectHardConflicts } from '../constraints/index-builder.js';
import { softScoreOf } from '../solver/score.js';

export function buildTrustedPublishResult(rawProject, rawSolution) {
    if (!rawProject || typeof rawProject !== 'object') {
        throw publishError('缺少 project', 'missing_project', 400);
    }
    if (!rawSolution || typeof rawSolution !== 'object') {
        throw publishError('缺少 solution', 'missing_solution', 400);
    }

    const project = preserveProjectSurface(rawProject, createProject(rawProject));
    const activities = expandActivityPlans(project.activityPlans);
    const ctx = buildContext(project, activities, project.constraints);
    const solution = createSolution(activities.length);
    applyPlacements(ctx, solution, rawSolution.placements);

    const hardConflicts = detectHardConflicts(solution, ctx);
    const unplaced = unplacedActivities(ctx, solution);
    const placements = solution.placements().map(p => decodePlacement(ctx, p));
    const softScore = softScoreOf(ctx, solution);
    const trustedSolution = {
        placements,
        unplaced,
        hardConflicts,
        softScore,
        stats: {
            total: activities.length,
            placed: placements.length,
            unplaced: unplaced.length,
        },
    };

    return {
        project,
        solution: trustedSolution,
        publishedSnapshot: {
            status: 'published',
            publishedAt: new Date().toISOString(),
            projectRevision: normalizeRevision(rawProject.revision),
            solutionHash: hashStableJson({
                projectId: project.id,
                placements,
                softScore,
            }),
            placements,
            softScore,
        },
    };
}

function applyPlacements(ctx, solution, placements) {
    if (!Array.isArray(placements)) {
        throw publishError('缺少 placements', 'missing_placements', 400);
    }

    const seen = new Set();
    for (const placement of placements) {
        const activityId = String(placement?.activityId ?? '').trim();
        const idx = ctx.indexes.activities.toIndex(activityId);
        if (idx < 0) {
            throw publishError(`未知活动 "${activityId}"`, 'invalid_solution', 422, { activityId });
        }
        if (seen.has(idx)) {
            throw publishError(`活动 "${activityId}" 重复排课`, 'invalid_solution', 422, { activityId });
        }
        seen.add(idx);

        const time = resolvePlacementTime(ctx, placement);
        const room = resolvePlacementRoom(ctx, placement);
        solution.move(idx, time, room);
    }
}

function resolvePlacementTime(ctx, placement) {
    if (Number.isInteger(placement?.time) && ctx.calendar.isValidTime(placement.time)) {
        return placement.time;
    }
    const time = ctx.calendar.encodeTime(placement?.day, placement?.period);
    if (!ctx.calendar.isValidTime(time)) {
        throw publishError('placement 时间不在有效日历内', 'invalid_solution', 422, {
            activityId: placement?.activityId ?? null,
            day: placement?.day ?? null,
            period: placement?.period ?? null,
        });
    }
    return time;
}

function resolvePlacementRoom(ctx, placement) {
    const roomId = placement?.roomId;
    if (roomId === undefined || roomId === null || roomId === '') return -1;
    const room = ctx.indexes.rooms.toIndex(roomId);
    if (room < 0) {
        throw publishError(`未知教室 "${roomId}"`, 'invalid_solution', 422, {
            activityId: placement?.activityId ?? null,
            roomId,
        });
    }
    return room;
}

function unplacedActivities(ctx, solution) {
    const out = [];
    for (let idx = 0; idx < ctx.activities.length; idx += 1) {
        if (solution.isPlaced(idx)) continue;
        out.push({
            activityIdx: idx,
            activityId: ctx.activities[idx].id,
            planId: ctx.activities[idx].planId,
            reason: { type: 'not_in_published_solution' },
        });
    }
    return out;
}

function decodePlacement(ctx, p) {
    const decoded = ctx.calendar.decodeTime(p.time);
    return {
        activityId: ctx.activities[p.idx].id,
        day: decoded?.day ?? null,
        period: decoded?.period ?? null,
        roomId: p.room >= 0 ? ctx.indexes.rooms.toId(p.room) : null,
        duration: ctx.meta[p.idx].duration,
        weekPattern: ctx.meta[p.idx].weekPattern,
    };
}

function preserveProjectSurface(source, project) {
    const out = { ...project };
    for (const key of ['revision', 'updatedAt', 'metadata', 'publishedHistory', 'publishedSnapshot']) {
        if (source[key] !== undefined) out[key] = cloneJson(source[key]);
    }
    return out;
}

function normalizeRevision(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

function hashStableJson(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function publishError(message, reason, statusCode = 400, data = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.data = { reason, ...data };
    return error;
}
