/**
 * timetable-v2 / domain / solution.js
 *
 * Solution：扁平 Int32Array 表示 + 显式撤销栈（FET solution.h / restore* 思路）。
 *   times[activityIdx] = 起始 time 整数（或 UNALLOCATED）
 *   rooms[activityIdx] = 教室下标（或 NO_ROOM）
 * 回溯零拷贝：move 记录撤销项，undo(n) 逆序回放。
 *
 * 下标 = 活动内部索引（由 ids.activities 提供），本类不关心业务 ID。
 *
 * 纯逻辑、零 IO。
 */

import { UNALLOCATED, NO_ROOM } from './calendar.js';

export class Solution {
    /**
     * @param {number} nActivities 活动数量
     */
    constructor(nActivities) {
        const n = Number(nActivities);
        if (!Number.isInteger(n) || n < 0) throw new Error(`Solution: 非法活动数 ${nActivities}`);
        this.n = n;
        this.times = new Int32Array(n).fill(UNALLOCATED);
        this.rooms = new Int32Array(n).fill(NO_ROOM);
        /** @type {{idx:number, prevTime:number, prevRoom:number}[]} 撤销栈 */
        this._undo = [];
    }

    /** 当前撤销栈长度（已记录的可回滚步数）。 */
    get historyLength() {
        return this._undo.length;
    }

    /** 已分配（time !== UNALLOCATED）的活动数。 */
    get placedCount() {
        let c = 0;
        for (let i = 0; i < this.n; i++) if (this.times[i] !== UNALLOCATED) c++;
        return c;
    }

    /**
     * 移动活动到指定时间/教室，记录撤销项。
     * @param {number} idx 活动下标
     * @param {number} time 目标 time（UNALLOCATED 表示取消分配）
     * @param {number} [room] 目标教室下标（默认 NO_ROOM）
     */
    move(idx, time, room = NO_ROOM) {
        this._assertIdx(idx);
        this._undo.push({ idx, prevTime: this.times[idx], prevRoom: this.rooms[idx] });
        this.times[idx] = time;
        this.rooms[idx] = room;
        return this;
    }

    /**
     * 撤销最近 n 次 move，精确回滚 times/rooms。
     * @param {number} [n=1]
     */
    undo(n = 1) {
        let steps = Math.min(Number(n) || 0, this._undo.length);
        while (steps-- > 0) {
            const rec = this._undo.pop();
            this.times[rec.idx] = rec.prevTime;
            this.rooms[rec.idx] = rec.prevRoom;
        }
        return this;
    }

    /** 取某活动的 placement（下标级）。 */
    timeOf(idx) {
        this._assertIdx(idx);
        return this.times[idx];
    }

    roomOf(idx) {
        this._assertIdx(idx);
        return this.rooms[idx];
    }

    isPlaced(idx) {
        this._assertIdx(idx);
        return this.times[idx] !== UNALLOCATED;
    }

    /**
     * placements 视图：已分配活动的 {idx, time, room} 列表。
     */
    placements() {
        const out = [];
        for (let i = 0; i < this.n; i++) {
            if (this.times[i] !== UNALLOCATED) {
                out.push({ idx: i, time: this.times[i], room: this.rooms[i] });
            }
        }
        return out;
    }

    /** 深拷贝当前解（不含撤销栈）。 */
    clone() {
        const copy = new Solution(this.n);
        copy.times.set(this.times);
        copy.rooms.set(this.rooms);
        return copy;
    }

    _assertIdx(idx) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= this.n) {
            throw new Error(`Solution: 活动下标越界 ${idx}（n=${this.n}）`);
        }
    }
}

export function createSolution(nActivities) {
    return new Solution(nActivities);
}
