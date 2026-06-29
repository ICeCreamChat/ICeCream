/**
 * 教室同时段唯一：同一教室在物理重叠时段不能有两个活动。
 * 仅对已分配教室（room >= 0）的活动检测。
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';
import { weekPatternsOverlap, NO_ROOM } from '../../domain/calendar.js';

export class RoomClash extends Constraint {
    detect(solution, ctx) {
        const { meta } = ctx;
        const slots = new Map(); // `${room}@${time}` → [{idx, weekPattern, time}]
        for (const { idx, time, room } of solution.placements()) {
            if (room === NO_ROOM || room < 0) continue;
            for (const t of ctx.occupiedTimes(idx, time)) {
                const key = `${room}@${t}`;
                let arr = slots.get(key);
                if (!arr) slots.set(key, (arr = []));
                arr.push({ idx, weekPattern: meta[idx].weekPattern, room, time: t });
            }
        }
        const conflicts = [];
        const seen = new Set();
        for (const arr of slots.values()) {
            if (arr.length < 2) continue;
            for (let i = 0; i < arr.length; i++) {
                for (let j = i + 1; j < arr.length; j++) {
                    if (arr[i].idx === arr[j].idx) continue;
                    if (!weekPatternsOverlap(arr[i].weekPattern, arr[j].weekPattern)) continue;
                    const a = Math.min(arr[i].idx, arr[j].idx);
                    const b = Math.max(arr[i].idx, arr[j].idx);
                    const key = `${arr[i].room}:${a}:${b}:${arr[i].time}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    conflicts.push({
                        type: 'room_clash',
                        activities: [a, b],
                        time: arr[i].time,
                        resource: arr[i].room,
                        detail: `room_clash: 活动 ${a} 与 ${b} 在教室#${arr[i].room} 的 time ${arr[i].time} 冲突`,
                    });
                }
            }
        }
        return conflicts;
    }
}

register('room_clash', RoomClash);
