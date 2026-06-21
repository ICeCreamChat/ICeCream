/**
 * 软约束：教师每日课时上限 + 连续节次上限（旧 teacherLimits.daily / consecutive）。
 * 某教师某天课时超过 daily、或连续节次超过 consecutive 时产生压力（超出越多压力越大）。
 * DSL: { type:'teacher_limits', target:{teacherId}, params:{ daily?:n, consecutive?:n } }
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';

export class TeacherLimits extends Constraint {
    compile(ctx) {
        this._teacherIdx = ctx.indexes.teachers.toIndex(this.target?.teacherId);
        this._daily = Number.isInteger(this.params?.daily) ? this.params.daily : null;
        this._consecutive = Number.isInteger(this.params?.consecutive) ? this.params.consecutive : null;
    }

    pressure(idx, time, room, solution, ctx) {
        if (this._teacherIdx < 0) return 0;
        if (this._daily === null && this._consecutive === null) return 0;
        const m = ctx.meta[idx];
        if (!m.teacherIdxs.includes(this._teacherIdx)) return 0;
        const cal = ctx.calendar;
        const myDay = time % cal.nDays;

        // 收集该教师当天所有占用的节次索引（0 基），含连堂展开。
        const periods = [];
        let dayUnits = 0;
        const collect = (otherIdx, ot) => {
            const om = ctx.meta[otherIdx];
            if (!om.teacherIdxs.includes(this._teacherIdx)) return;
            if ((ot % cal.nDays) !== myDay) return;
            dayUnits += om.duration;
            const startP = Math.floor(ot / cal.nDays);
            for (let k = 0; k < om.duration; k++) periods.push(startP + k);
        };
        collect(idx, time);
        for (const { idx: other, time: ot } of solution.placements()) {
            if (other === idx) continue;
            collect(other, ot);
        }

        let pressure = 0;
        if (this._daily !== null) {
            const over = dayUnits - this._daily;
            if (over > 0) pressure += over;
        }
        if (this._consecutive !== null) {
            pressure += this._consecutiveOverflow(periods, this._consecutive);
        }
        return pressure;
    }

    /** 当天节次按连续段计长，最长连续段超过上限的超出量之和。 */
    _consecutiveOverflow(periods, limit) {
        if (periods.length === 0) return 0;
        const sorted = [...new Set(periods)].sort((a, b) => a - b);
        let run = 1;
        let over = 0;
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] === sorted[i - 1] + 1) {
                run += 1;
            } else {
                if (run > limit) over += run - limit;
                run = 1;
            }
        }
        if (run > limit) over += run - limit;
        return over;
    }
}

register('teacher_limits', TeacherLimits);
