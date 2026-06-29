/**
 * 固定课/锁定课：被标记 locked（或含 fixedTime）的活动不可移动。
 * 检测语义：若锁定活动当前 time 与其 fixedTime 不一致，则判冲突。
 * 同时提供 isLocked/assertMovable 供求解器（Phase 2）查询不可移动语义。
 *
 * DSL（可选）: { type:'fixed_locked', target:{activityId|planId}, params:{time|slot} }
 *   compile 把指定活动标记为 locked 并写入 fixedTime。
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';
import { UNALLOCATED } from '../../domain/calendar.js';

export class FixedLocked extends Constraint {
    compile(ctx) {
        const store = ctx.shared.lockedActivities ??= new Map(); // activityIdx → fixedTime|null
        // 来自 Activity 自身的 locked/fixedTime
        ctx.meta.forEach((m, idx) => {
            if (m.locked || m.fixedTime !== null) {
                store.set(idx, m.fixedTime);
            }
        });
        // 来自 DSL 的显式锁定
        const actId = this.target?.activityId;
        if (actId) {
            const idx = ctx.indexes.activities?.toIndex(actId) ?? -1;
            if (idx >= 0) {
                let time = null;
                if (this.params?.slot) {
                    try { time = ctx.calendar.parseSlotKey(this.params.slot); } catch { /* ignore */ }
                } else if (Number.isInteger(this.params?.time)) {
                    time = this.params.time;
                }
                ctx.meta[idx].locked = true;
                if (time !== null) ctx.meta[idx].fixedTime = time;
                store.set(idx, ctx.meta[idx].fixedTime);
            }
        }
    }

    detect(solution, ctx) {
        const store = ctx.shared.lockedActivities;
        if (!store || store.size === 0) return [];
        const conflicts = [];
        for (const [idx, fixedTime] of store) {
            if (fixedTime === null || fixedTime === undefined) continue;
            const cur = solution.timeOf(idx);
            if (cur !== UNALLOCATED && cur !== fixedTime) {
                conflicts.push({
                    type: 'fixed_locked',
                    activities: [idx],
                    time: cur,
                    detail: `fixed_locked: 锁定活动 ${idx} 应在 time ${fixedTime}，却被放到 ${cur}`,
                });
            }
        }
        return conflicts;
    }
}

/** 求解器辅助：该活动是否锁定（不可移动）。 */
export function isLocked(ctx, idx) {
    const store = ctx.shared?.lockedActivities;
    return !!store && store.has(idx);
}

register('fixed_locked', FixedLocked);
