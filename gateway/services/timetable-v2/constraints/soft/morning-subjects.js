/**
 * 软约束：主科优先上午（旧 morningSubjects）。
 * 指定科目的活动落在下午/晚上节次时产生压力（越晚压力越大）。
 * DSL: { type:'morning_subjects', params:{ subjectIds:[...], morningPeriods?:n } }
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';

export class MorningSubjects extends Constraint {
    compile(ctx) {
        this._subjectIdxs = new Set(
            (this.params?.subjectIds ?? []).map(id => ctx.indexes.subjects.toIndex(id)).filter(i => i >= 0),
        );
        // 上午节次数：默认取有效节次的前半
        this._morning = this.params?.morningPeriods ?? Math.ceil(ctx.calendar.nPeriods / 2);
    }

    pressure(idx, time, room, solution, ctx) {
        if (!this._subjectIdxs || this._subjectIdxs.size === 0) return 0;
        if (!this._subjectIdxs.has(ctx.meta[idx].subjectIdx)) return 0;
        const periodIndex = Math.floor(time / ctx.calendar.nDays); // 0 基
        const over = periodIndex - (this._morning - 1);
        return over > 0 ? over : 0; // 越靠后压力越大
    }
}

register('morning_subjects', MorningSubjects);
