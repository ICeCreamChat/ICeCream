/**
 * 有效时段：每个已分配活动占用的全部 time 必须落在日历有效空间内。
 * 越界（含连堂溢出、负 time、超出 slotCount）判冲突。
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';
import { UNALLOCATED } from '../../domain/calendar.js';

export class ValidTimeslot extends Constraint {
    detect(solution, ctx) {
        const conflicts = [];
        for (const { idx, time } of solution.placements()) {
            if (time === UNALLOCATED) continue;
            const occupied = ctx.occupiedTimes(idx, time);
            const bad = occupied.some(t => !ctx.calendar.isValidTime(t));
            if (bad) {
                conflicts.push({
                    type: 'valid_timeslot',
                    activities: [idx],
                    time,
                    detail: `valid_timeslot: 活动 ${idx} 从 time ${time} 起的占用超出有效日期/节次范围`,
                });
            }
        }
        return conflicts;
    }
}

register('valid_timeslot', ValidTimeslot);
