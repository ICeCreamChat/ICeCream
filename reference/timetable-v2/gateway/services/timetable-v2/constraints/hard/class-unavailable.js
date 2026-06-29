/**
 * 班级不可用时段：班级在指定 time 不能被排课。
 * DSL: { type:'class_unavailable', target:{classId}, params:{slots:["1-3",...]} }
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';

export class ClassUnavailable extends Constraint {
    compile(ctx) {
        const store = ctx.shared.classUnavailable ??= new Map(); // classIdx → Set<time>
        const classId = this.target?.classId;
        const cIdx = ctx.indexes.classes.toIndex(classId);
        if (cIdx < 0) return;
        let set = store.get(cIdx);
        if (!set) store.set(cIdx, (set = new Set()));
        for (const slot of this.params?.slots ?? []) {
            try {
                set.add(ctx.calendar.parseSlotKey(slot));
            } catch { /* 越界 slot 忽略 */ }
        }
    }

    detect(solution, ctx) {
        const store = ctx.shared.classUnavailable;
        if (!store || store.size === 0) return [];
        const conflicts = [];
        for (const { idx, time } of solution.placements()) {
            const occupied = ctx.occupiedTimes(idx, time);
            for (const cIdx of ctx.meta[idx].classIdxs) {
                const set = store.get(cIdx);
                if (!set) continue;
                for (const t of occupied) {
                    if (set.has(t)) {
                        conflicts.push({
                            type: 'class_unavailable',
                            activities: [idx],
                            time: t,
                            resource: cIdx,
                            detail: `class_unavailable: 活动 ${idx} 落在班级#${cIdx} 的不可用 time ${t}`,
                        });
                    }
                }
            }
        }
        return conflicts;
    }
}

register('class_unavailable', ClassUnavailable);
