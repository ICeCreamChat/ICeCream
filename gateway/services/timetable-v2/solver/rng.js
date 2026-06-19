/**
 * timetable-v2 / solver / rng.js
 *
 * 种子化随机（mulberry32）。求解器所有随机点统一从这里取数，
 * 禁用 Math.random()，保证同 seed 同序列、解可复现（决策 4 / D5）。
 *
 * 纯函数、零 IO。
 */

/**
 * 创建一个种子化 RNG。
 * @param {number} seed 32 位整数种子
 * @returns {() => number} 每次返回 [0,1) 的浮点数
 */
export function createRng(seed = 1) {
    let a = (seed >>> 0) || 1;
    return function next() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** [0, n) 的整数。 */
export function randInt(rng, n) {
    return Math.floor(rng() * n);
}

/**
 * 按权重数组加权随机抽一个下标。权重需非负；全 0 时退化为均匀。
 * @param {() => number} rng
 * @param {number[]} weights
 * @returns {number} 选中的下标；空数组返回 -1
 */
export function weightedPick(rng, weights) {
    const n = weights.length;
    if (n === 0) return -1;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.max(0, weights[i]);
    if (sum <= 0) return randInt(rng, n); // 全 0 → 均匀
    let threshold = rng() * sum;
    for (let i = 0; i < n; i++) {
        threshold -= Math.max(0, weights[i]);
        if (threshold < 0) return i;
    }
    return n - 1;
}

/** Fisher–Yates 洗牌（原地），用种子化 RNG，保证可复现。 */
export function shuffle(rng, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = randInt(rng, i + 1);
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
}
