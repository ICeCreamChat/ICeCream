/**
 * 连堂必须连续：duration>1 的活动必须落在同一天连续节次内。
 *
 * 时间编码 time = periodIndex*nDays + dayIndex，连堂块占 start, start+nDays, ...
 * 只要块内任一 time 越出有效空间（slotCount）就说明连堂跑出了当天节次范围 → 冲突。
 * （+nDays 保持 dayIndex 不变，故"同一天"由编码天然保证；越界即不连续/不合法。）
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';
import { UNALLOCATED } from '../../domain/calendar.js';

export class Consecutive extends Constraint {
    detect(solution, ctx) {
        const conflicts = [];
        const { calendar, meta } = ctx;
        for (const { idx, time } of solution.placements()) {
            const d = meta[idx].duration;
            if (d <= 1) continue;
            if (time === UNALLOCATED) continue;
            const occupied = ctx.occupiedTimes(idx, time);
            const startPi = Math.floor(time / calendar.nDays);
            const fits = startPi + d <= calendar.nPeriods
                && occupied.every(t => calendar.isValidTime(t));
            if (!fits) {
                conflicts.push({
                    type: 'consecutive',
                    activities: [idx],
                    time,
                    detail: `consecutive: 连堂活动 ${idx}（duration=${d}）从 time ${time} 起无法连续放置在当天节次内`,
                });
            }
        }
        return conflicts;
    }
}

register('consecutive', Consecutive);
