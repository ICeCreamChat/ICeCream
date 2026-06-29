/**
 * timetable-v2 / importers / migration-report.js
 *
 * 统一迁移报告：四个导入器共用，记录字段映射结果，杜绝静默丢失。
 * 四分类：
 *   kept     无损映射进 V2
 *   degraded 降级映射（如未知 blockPreference 退化为 single）
 *   dropped  无法映射、丢弃
 *   review   语义不明 / 当前不支持，需人工复核
 *
 * 每条含 source（来源定位：表名/行号/字段路径）、field、reason、可选 originalValue。
 * 纯函数、零 IO。
 */

export const REPORT_CATEGORIES = Object.freeze(['kept', 'degraded', 'dropped', 'review']);

/**
 * 创建一个迁移报告收集器。
 * @param {string} sourceKind 来源类型标识（legacy-project / excel / crystal / yqd）
 */
export function createMigrationReport(sourceKind = 'unknown') {
    const entries = [];

    function add(category, { source, field, reason, originalValue } = {}) {
        if (!REPORT_CATEGORIES.includes(category)) {
            throw new Error(`migration-report: 未知分类 "${category}"，须为 ${REPORT_CATEGORIES.join('/')}`);
        }
        if (!field) throw new Error('migration-report: 条目缺少 field');
        const entry = { category, source: source ?? null, field, reason: reason ?? '' };
        if (originalValue !== undefined) entry.originalValue = originalValue;
        entries.push(entry);
        return entry;
    }

    const api = {
        sourceKind,
        entries,
        kept: (info) => add('kept', info),
        degraded: (info) => add('degraded', info),
        dropped: (info) => add('dropped', info),
        review: (info) => add('review', info),
        add,
        /** 汇总计数，与 entries 一致。 */
        summary() {
            const counts = { kept: 0, degraded: 0, dropped: 0, review: 0 };
            for (const e of entries) counts[e.category] += 1;
            return { sourceKind, total: entries.length, counts };
        },
        /** 是否存在需关注的项（degraded/dropped/review）。 */
        hasIssues() {
            return entries.some(e => e.category !== 'kept');
        },
        /** 导出为纯数据（供持久化/诊断）。 */
        toJSON() {
            return { sourceKind, summary: api.summary(), entries: entries.slice() };
        },
    };
    return api;
}

/**
 * 校验报告内部一致性：汇总计数 == 实际条目分类计数。
 * 供门禁断言"汇总与条目一致"。
 */
export function verifyReportConsistency(report) {
    const summary = report.summary();
    const recount = { kept: 0, degraded: 0, dropped: 0, review: 0 };
    for (const e of report.entries) recount[e.category] += 1;
    for (const cat of REPORT_CATEGORIES) {
        if (summary.counts[cat] !== recount[cat]) {
            return { ok: false, reason: `分类 ${cat} 汇总 ${summary.counts[cat]} != 实际 ${recount[cat]}` };
        }
    }
    if (summary.total !== report.entries.length) {
        return { ok: false, reason: `total ${summary.total} != entries ${report.entries.length}` };
    }
    return { ok: true };
}
