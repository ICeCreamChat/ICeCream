/**
 * 软约束：同科分散（旧 spreadSubjects）。
 * 指定科目在同一班级同一天出现多次时产生压力（避免同科扎堆）。
 * DSL: { type:'spread_subjects', params:{ subjectIds:[...] } }
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';

export class SpreadSubjects extends Constraint {
    compile(ctx) {
        this._subjectIdxs = new Set(
            (this.params?.subjectIds ?? []).map(id => ctx.indexes.subjects.toIndex(id)).filter(i => i >= 0),
        );
    }

    pressure(idx, time, room, solution, ctx) {
        const m = ctx.meta[idx];
        if (!this._subjectIdxs || !this._subjectIdxs.has(m.subjectIdx)) return 0;
        const cal = ctx.calendar;
        const myDay = time % cal.nDays;
        let sameDayCount = 0;
        // 统计同班同科同天的其他已排活动
        for (const { idx: other, time: ot } of solution.placements()) {
            if (other === idx) continue;
            const om = ctx.meta[other];
            if (om.subjectIdx !== m.subjectIdx) continue;
            if ((ot % cal.nDays) !== myDay) continue;
            // 是否同班
            if (m.classIdxs.some(c => om.classIdxs.includes(c))) sameDayCount++;
        }
        return sameDayCount; // 同天同科越多压力越大
    }
}

register('spread_subjects', SpreadSubjects);
