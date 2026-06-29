/**
 * timetable-v2 / solver / placement.js
 *
 * 求解期的放置可行性与候选枚举。construct/swap/improve 共用。
 * 用增量占用表（资源×time → 活动 idx）做 O(1) 冲突查询，避免每次全量 detectHardConflicts。
 *
 * 占用语义与 Phase 1 硬约束一致：
 *   - 连堂占 occupiedTimes(idx, start) 全部 time
 *   - 单双周用 weekPattern 物理重叠判定
 *   - 教师/班级/教室同时段唯一
 *   - 教师/班级不可用（来自 ctx.shared）
 *   - 有效时段 + 连堂连续（候选枚举时即排除非法起点）
 *
 * 纯逻辑、零 IO。
 */

import { weekPatternsOverlap, NO_ROOM } from '../domain/calendar.js';

/**
 * 占用索引：teacher/class/room 各一张 Map<`res@time`, Set<activityIdx>>。
 * 维护与 Solution 同步：place/unplace 时增量更新。
 */
export class OccupancyIndex {
    constructor(ctx) {
        this.ctx = ctx;
        this.teacher = new Map();
        this.klass = new Map();
        this.room = new Map();
    }

    _key(res, time) { return res * 100000 + time; }

    _touch(map, res, time, idx, add) {
        const k = this._key(res, time);
        let set = map.get(k);
        if (add) {
            if (!set) map.set(k, (set = new Set()));
            set.add(idx);
        } else if (set) {
            set.delete(idx);
            if (set.size === 0) map.delete(k);
        }
    }

    _apply(idx, startTime, add) {
        const m = this.ctx.meta[idx];
        const times = this.ctx.occupiedTimes(idx, startTime);
        for (const t of times) {
            for (const tt of m.teacherIdxs) this._touch(this.teacher, tt, t, idx, add);
            for (const cc of m.classIdxs) this._touch(this.klass, cc, t, idx, add);
        }
    }

    place(idx, startTime, room) {
        this._apply(idx, startTime, true);
        if (room !== undefined && room !== NO_ROOM && room >= 0) {
            for (const t of this.ctx.occupiedTimes(idx, startTime)) {
                this._touch(this.room, room, t, idx, true);
            }
        }
    }

    unplace(idx, startTime, room) {
        this._apply(idx, startTime, false);
        if (room !== undefined && room !== NO_ROOM && room >= 0) {
            for (const t of this.ctx.occupiedTimes(idx, startTime)) {
                this._touch(this.room, room, t, idx, false);
            }
        }
    }

    /** 从一个 Solution 全量重建占用索引（用于回溯后与解对齐，保证一致性）。 */
    rebuildFrom(solution) {
        this.teacher.clear();
        this.klass.clear();
        this.room.clear();
        for (const { idx, time, room } of solution.placements()) {
            this.place(idx, time, room);
        }
    }

    /** 收集与 (idx,startTime) 在教师/班级上冲突的活动 idx（排除自身、考虑单双周）。 */
    blockersAt(idx, startTime) {
        const m = this.ctx.meta[idx];
        const out = new Set();
        const times = this.ctx.occupiedTimes(idx, startTime);
        for (const t of times) {
            for (const tt of m.teacherIdxs) this._collect(this.teacher, tt, t, idx, m.weekPattern, out);
            for (const cc of m.classIdxs) this._collect(this.klass, cc, t, idx, m.weekPattern, out);
        }
        // 教室维：活动需要教室且所有允许教室在该时段全被占用时，
        // 把"占用者最少的那间教室"的占用活动并入 blocker，使换位可通过弹出它们腾出教室。
        const rooms = m.roomIdxs;
        if (rooms && rooms.length > 0) {
            if (this.freeRoomAt(idx, startTime) === null) {
                const occupants = this._leastOccupiedRoomBlockers(idx, times);
                for (const o of occupants) out.add(o);
            }
        }
        return [...out];
    }

    /**
     * 返回该活动在 startTime 的一间空闲教室下标；
     * 无教室需求返回 NO_ROOM；需要教室但全被占返回 null（硬不可行信号）。
     */
    freeRoomAt(idx, startTime) {
        const rooms = this.ctx.meta[idx].roomIdxs;
        if (!rooms || rooms.length === 0) return NO_ROOM;
        const times = this.ctx.occupiedTimes(idx, startTime);
        for (const r of rooms) {
            if (this._roomFreeAt(r, times, idx)) return r;
        }
        return null;
    }

    _roomFreeAt(room, times, selfIdx) {
        for (const t of times) {
            const set = this.room.get(this._key(room, t));
            if (set) {
                for (const o of set) if (o !== selfIdx) return false;
            }
        }
        return true;
    }

    /** 占用者最少的允许教室的占用活动集合（供换位弹出以腾出教室）。 */
    _leastOccupiedRoomBlockers(idx, times) {
        const rooms = this.ctx.meta[idx].roomIdxs;
        let best = null;
        for (const r of rooms) {
            const occ = new Set();
            for (const t of times) {
                const set = this.room.get(this._key(r, t));
                if (set) for (const o of set) if (o !== idx) occ.add(o);
            }
            if (best === null || occ.size < best.size) best = occ;
        }
        return best ? [...best] : [];
    }

    _collect(map, res, time, selfIdx, selfWp, out) {
        const set = map.get(this._key(res, time));
        if (!set) return;
        for (const other of set) {
            if (other === selfIdx) continue;
            if (weekPatternsOverlap(selfWp, this.ctx.meta[other].weekPattern)) out.add(other);
        }
    }
}

/**
 * 枚举一个活动所有"时段合法"的候选起点 time（不含资源冲突判断）。
 * 排除：连堂溢出当天、超出有效范围、落在教师/班级不可用时段。
 * @returns {number[]} 合法起点 time 列表
 */
export function legalStartTimes(ctx, idx) {
    const { calendar, meta } = ctx;
    const m = meta[idx];
    // 锁定活动：唯一候选就是 fixedTime
    if (m.locked && m.fixedTime !== null && m.fixedTime !== undefined) {
        return [m.fixedTime];
    }
    const out = [];
    const teacherUnavail = ctx.shared.teacherUnavailable;
    const classUnavail = ctx.shared.classUnavailable;
    for (let pi = 0; pi + m.duration <= calendar.nPeriods; pi++) {
        for (let di = 0; di < calendar.nDays; di++) {
            const start = pi * calendar.nDays + di;
            const times = ctx.occupiedTimes(idx, start);
            if (!times.every(t => calendar.isValidTime(t))) continue;
            if (hitsUnavailable(times, m.teacherIdxs, teacherUnavail)) continue;
            if (hitsUnavailable(times, m.classIdxs, classUnavail)) continue;
            out.push(start);
        }
    }
    return out;
}

function hitsUnavailable(times, resIdxs, store) {
    if (!store || store.size === 0) return false;
    for (const res of resIdxs) {
        const set = store.get(res);
        if (!set) continue;
        for (const t of times) if (set.has(t)) return true;
    }
    return false;
}
