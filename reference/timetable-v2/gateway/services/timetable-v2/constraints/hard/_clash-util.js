/**
 * timetable-v2 / constraints / hard / _clash-util.js
 *
 * 资源同时段唯一的通用检测：对每个被占用的 (resource, time) 槽，
 * 若有 >=2 个活动且 weekPattern 物理重叠，则成对登记冲突。
 *
 * 连堂：用 ctx.occupiedTimes 展开活动占用的全部 time。
 * 单双周：仅当两活动 weekPattern 物理重叠（weekPatternsOverlap）才算冲突。
 */
import { weekPatternsOverlap } from '../../domain/calendar.js';

/**
 * @param {import('../../domain/solution.js').Solution} solution
 * @param {object} ctx
 * @param {string} type 冲突 type 标签
 * @param {(meta:object)=>number[]} resourceSelector 从活动 meta 取资源下标列表
 * @returns {Array<{type,activities:number[],time:number,resource:number,detail:string}>}
 */
export function detectResourceClash(solution, ctx, type, resourceSelector) {
    const { meta } = ctx;
    // 槽占用表：key = `${resource}@${time}` → [{idx, weekPattern}]
    const slots = new Map();

    for (const { idx, time } of solution.placements()) {
        const m = meta[idx];
        const occupied = ctx.occupiedTimes(idx, time);
        for (const res of resourceSelector(m)) {
            for (const t of occupied) {
                const key = `${res}@${t}`;
                let arr = slots.get(key);
                if (!arr) slots.set(key, (arr = []));
                arr.push({ idx, weekPattern: m.weekPattern, res, time: t });
            }
        }
    }

    const conflicts = [];
    const seenPair = new Set();
    for (const arr of slots.values()) {
        if (arr.length < 2) continue;
        for (let i = 0; i < arr.length; i++) {
            for (let j = i + 1; j < arr.length; j++) {
                if (arr[i].idx === arr[j].idx) continue;
                if (!weekPatternsOverlap(arr[i].weekPattern, arr[j].weekPattern)) continue;
                const a = Math.min(arr[i].idx, arr[j].idx);
                const b = Math.max(arr[i].idx, arr[j].idx);
                const pairKey = `${arr[i].res}:${a}:${b}:${arr[i].time}`;
                if (seenPair.has(pairKey)) continue;
                seenPair.add(pairKey);
                conflicts.push({
                    type,
                    activities: [a, b],
                    time: arr[i].time,
                    resource: arr[i].res,
                    detail: `${type}: 活动 ${a} 与 ${b} 在资源#${arr[i].res} 的 time ${arr[i].time} 冲突`,
                });
            }
        }
    }
    return conflicts;
}
