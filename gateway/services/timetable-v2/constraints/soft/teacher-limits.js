/**
 * 软约束：教师每日课时上限（旧 teacherLimits.daily）。
 * 某教师某天课时超过上限时产生压力（超出越多压力越大）。
 * DSL: { type:'teacher_limits', target:{teacherId}, params:{ daily?:n } }
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';

export class TeacherLimits extends Constraint {
    compile(ctx) {
        this._teacherIdx = ctx.indexes.teachers.toIndex(this.target?.teacherId);
        this._daily = Number.isInteger(this.params?.daily) ? this.params.daily : null;
    }

    pressure(idx, time, room, solution, ctx) {
        if (this._teacherIdx < 0 || this._daily === null) return 0;
        const m = ctx.meta[idx];
        if (!m.teacherIdxs.includes(this._teacherIdx)) return 0;
        const cal = ctx.calendar;
        const myDay = time % cal.nDays;
        let dayUnits = m.duration;
        for (const { idx: other, time: ot } of solution.placements()) {
            if (other === idx) continue;
            const om = ctx.meta[other];
            if (!om.teacherIdxs.includes(this._teacherIdx)) continue;
            if ((ot % cal.nDays) !== myDay) continue;
            dayUnits += om.duration;
        }
        const over = dayUnits - this._daily;
        return over > 0 ? over : 0;
    }
}

register('teacher_limits', TeacherLimits);
