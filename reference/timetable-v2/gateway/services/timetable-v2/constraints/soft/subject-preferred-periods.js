/**
 * 软约束：科目偏好/回避节次（旧 subjectPreferredPeriods）。
 * 指定科目落在 avoid 节次时产生压力；prefer 非空时落在 prefer 之外也产生压力。
 * DSL: { type:'subject_preferred_periods', target:{subjectId},
 *        params:{ prefer?:["day-period"...], avoid?:["day-period"...] } }
 *
 * slot 既可写整时段 "day-period"，也可只给 period（"*-period" 或纯数字），
 * 表示"任意天的该节次"。compile 阶段统一解析成 period 索引集合 + 精确 time 集合。
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';

function parseSlotSpec(spec, cal) {
    // 返回 { times:Set<number 编码time>, periods:Set<number 业务节次> }
    const times = new Set();
    const periods = new Set();
    for (const raw of spec ?? []) {
        const s = String(raw).trim();
        const m = s.match(/^(\d+)-(\d+)$/);
        if (m) {
            const day = Number(m[1]);
            const period = Number(m[2]);
            const t = cal.encodeTime(day, period);
            if (cal.isValidTime(t)) times.add(t); // 仅收录落在有效空间的精确时段
            periods.add(period); // 同时按"任意天的该节次"宽松匹配
            continue;
        }
        const only = s.match(/^\*?-?(\d+)$/);
        if (only) periods.add(Number(only[1])); // 任意天的该节次（业务节次号）
    }
    return { times, periods };
}

export class SubjectPreferredPeriods extends Constraint {
    compile(ctx) {
        this._subjectIdx = ctx.indexes.subjects.toIndex(this.target?.subjectId);
        this._prefer = parseSlotSpec(this.params?.prefer, ctx.calendar);
        this._avoid = parseSlotSpec(this.params?.avoid, ctx.calendar);
        this._hasPrefer = this._prefer.times.size > 0 || this._prefer.periods.size > 0;
        this._hasAvoid = this._avoid.times.size > 0 || this._avoid.periods.size > 0;
    }

    pressure(idx, time, room, solution, ctx) {
        if (this._subjectIdx < 0) return 0;
        if (ctx.meta[idx].subjectIdx !== this._subjectIdx) return 0;
        if (!this._hasPrefer && !this._hasAvoid) return 0;
        const dp = ctx.calendar.decodeTime(time);
        if (!dp) return 0;
        const inSet = (set) => set.times.has(time) || set.periods.has(dp.period);
        let pressure = 0;
        if (this._hasAvoid && inSet(this._avoid)) pressure += 1;
        if (this._hasPrefer && !inSet(this._prefer)) pressure += 1;
        return pressure;
    }
}

register('subject_preferred_periods', SubjectPreferredPeriods);
