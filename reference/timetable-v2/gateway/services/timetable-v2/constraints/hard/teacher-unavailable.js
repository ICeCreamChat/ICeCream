/**
 * 教师不可用时段：教师在指定 time 不能被排课。
 * DSL: { type:'teacher_unavailable', target:{teacherId}, params:{slots:["1-3",...]} }
 * compile 阶段把 slot 字符串解析成 time 整数集合，按教师下标聚合到 ctx.shared。
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';

export class TeacherUnavailable extends Constraint {
    compile(ctx) {
        const store = ctx.shared.teacherUnavailable ??= new Map(); // teacherIdx → Set<time>
        const teacherId = this.target?.teacherId;
        const tIdx = ctx.indexes.teachers.toIndex(teacherId);
        if (tIdx < 0) return;
        let set = store.get(tIdx);
        if (!set) store.set(tIdx, (set = new Set()));
        for (const slot of this.params?.slots ?? []) {
            try {
                set.add(ctx.calendar.parseSlotKey(slot));
            } catch { /* 越界 slot 忽略 */ }
        }
    }

    detect(solution, ctx) {
        const store = ctx.shared.teacherUnavailable;
        if (!store || store.size === 0) return [];
        const conflicts = [];
        for (const { idx, time } of solution.placements()) {
            const occupied = ctx.occupiedTimes(idx, time);
            for (const tIdx of ctx.meta[idx].teacherIdxs) {
                const set = store.get(tIdx);
                if (!set) continue;
                for (const t of occupied) {
                    if (set.has(t)) {
                        conflicts.push({
                            type: 'teacher_unavailable',
                            activities: [idx],
                            time: t,
                            resource: tIdx,
                            detail: `teacher_unavailable: 活动 ${idx} 落在教师#${tIdx} 的不可用 time ${t}`,
                        });
                    }
                }
            }
        }
        return conflicts;
    }
}

register('teacher_unavailable', TeacherUnavailable);
