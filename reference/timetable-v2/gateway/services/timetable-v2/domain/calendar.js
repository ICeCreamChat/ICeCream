/**
 * timetable-v2 / domain / calendar.js
 *
 * 日历与时间编码。全程只传整数，字符串解析留在编译层（FET computeInternalStructure 思路）。
 *
 * 时间编码：time = period0 * nDays + day0（day0/period0 为 0 基内部下标）。
 * 业务侧使用 day 1–7、period 1–12（与旧 timetable-project.js "day-period" 字符串一致）。
 * weekPattern：单双周。'all' 每周、'odd' 单周、'even' 双周。
 *
 * 纯函数、零 IO。
 */

/** 未分配时间哨兵：任何有效 time 都是 [0, nDays*nPeriods)，哨兵取 -1。 */
export const UNALLOCATED = -1;

/** 未分配教室哨兵。 */
export const NO_ROOM = -1;

export const WEEK_PATTERNS = Object.freeze(['all', 'odd', 'even']);

const SLOT_RE = /^(\d{1,2})-(\d{1,2})$/;

/**
 * 创建日历。
 * @param {object} opts
 * @param {number[]} [opts.activeWeekdays] 有效星期（1–7），默认 1..weekdays
 * @param {number[]} [opts.activePeriods] 有效节次（1–12），默认 1..periodsPerDay
 * @param {number} [opts.weekdays] 当未给 activeWeekdays 时用于生成 1..weekdays
 * @param {number} [opts.periodsPerDay]
 */
export function createCalendar(opts = {}) {
    const weekdays = clampInt(opts.weekdays, 5, 1, 7);
    const periodsPerDay = clampInt(opts.periodsPerDay, 7, 1, 12);
    const activeWeekdays = normalizeList(opts.activeWeekdays, range(1, weekdays), 1, 7);
    const activePeriods = normalizeList(opts.activePeriods, range(1, periodsPerDay), 1, 12);

    if (activeWeekdays.length === 0) throw new Error('calendar: activeWeekdays 不能为空');
    if (activePeriods.length === 0) throw new Error('calendar: activePeriods 不能为空');

    // 内部维度按"有效日期/节次的下标"建立连续空间，编码紧凑。
    const nDays = activeWeekdays.length;
    const nPeriods = activePeriods.length;
    const dayToIndex = new Map(activeWeekdays.map((d, i) => [d, i]));
    const periodToIndex = new Map(activePeriods.map((p, i) => [p, i]));

    return {
        weekdays,
        periodsPerDay,
        activeWeekdays,
        activePeriods,
        nDays,
        nPeriods,
        slotCount: nDays * nPeriods,

        /** (day,period) 业务值 → time 整数。越界返回 UNALLOCATED。 */
        encodeTime(day, period) {
            const di = dayToIndex.get(Number(day));
            const pi = periodToIndex.get(Number(period));
            if (di === undefined || pi === undefined) return UNALLOCATED;
            return pi * nDays + di;
        },

        /** time 整数 → {day, period} 业务值。哨兵或越界返回 null。 */
        decodeTime(time) {
            const t = Number(time);
            if (!Number.isInteger(t) || t < 0 || t >= nDays * nPeriods) return null;
            const di = t % nDays;
            const pi = Math.floor(t / nDays);
            return { day: activeWeekdays[di], period: activePeriods[pi] };
        },

        /** time 是否落在有效空间内（非哨兵且在范围）。 */
        isValidTime(time) {
            const t = Number(time);
            return Number.isInteger(t) && t >= 0 && t < nDays * nPeriods;
        },

        /** 同一天判定：解码后 day 相同。 */
        sameDay(timeA, timeB) {
            const a = this.decodeTime(timeA);
            const b = this.decodeTime(timeB);
            return !!a && !!b && a.day === b.day;
        },

        /** 旧 "day-period" 字符串 → time 整数。非法/越界抛错。 */
        parseSlotKey(key) {
            const parsed = parseSlotKey(key);
            const time = this.encodeTime(parsed.day, parsed.period);
            if (time === UNALLOCATED) {
                throw new Error(`calendar: slot "${key}" 不在有效日期/节次内`);
            }
            return time;
        },

        /** time 整数 → 旧 "day-period" 字符串。 */
        toSlotKey(time) {
            const dp = this.decodeTime(time);
            if (!dp) throw new Error(`calendar: 无效 time ${time}`);
            return `${dp.day}-${dp.period}`;
        },
    };
}

/**
 * 解析旧 "day-period" 字符串（如 "1-3"），day 1–7、period 1–12。
 * 非 "n-n" 形态或越界则抛错。不依赖具体日历的有效集合。
 * @returns {{day:number, period:number}}
 */
export function parseSlotKey(key) {
    if (typeof key !== 'string') throw new Error(`slotKey 必须是字符串，收到 ${typeof key}`);
    const m = key.trim().match(SLOT_RE);
    if (!m) throw new Error(`slotKey 格式非法（应为 "day-period"）："${key}"`);
    const day = Number(m[1]);
    const period = Number(m[2]);
    if (day < 1 || day > 7) throw new Error(`slotKey day 越界（1–7）："${key}"`);
    if (period < 1 || period > 12) throw new Error(`slotKey period 越界（1–12）："${key}"`);
    return { day, period };
}

/** (day,period) → 旧 "day-period" 字符串。 */
export function toSlotKey(day, period) {
    return `${Number(day)}-${Number(period)}`;
}

/** 单双周是否在物理上重叠：仅当两者占同一周时才可能冲突。 */
export function weekPatternsOverlap(a, b) {
    const pa = normalizeWeekPattern(a);
    const pb = normalizeWeekPattern(b);
    if (pa === 'all' || pb === 'all') return true;
    return pa === pb;
}

export function normalizeWeekPattern(value) {
    return WEEK_PATTERNS.includes(value) ? value : 'all';
}

// ---- internal helpers ----

function clampInt(value, fallback, min, max) {
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function range(start, end) {
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);
}

function normalizeList(values, fallback, min, max) {
    const arr = Array.isArray(values) ? values : null;
    if (!arr) return [...fallback];
    const normalized = arr
        .map(v => Number.parseInt(v, 10))
        .filter(v => Number.isInteger(v) && v >= min && v <= max);
    const source = normalized.length ? normalized : fallback;
    return [...new Set(source)].sort((l, r) => l - r);
}
