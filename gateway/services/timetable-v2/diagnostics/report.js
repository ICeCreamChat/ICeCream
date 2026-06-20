/**
 * timetable-v2 / diagnostics / report.js
 *
 * 聚合 explain + audit + suggest 成单一 DiagnosticsReport：
 *   - items[]：扁平诊断项列表（severity 分级）
 *   - byObject：按对象（classId/teacherId/subjectId/roomId）倒排索引
 *   - suggestions[]：修复建议草稿
 *   - summary：分级计数
 * 可 JSON 序列化往返。纯函数、零 IO。
 *
 * 决策 5：列表视图 + 倒排索引，让 UI（Phase 5）零业务计算。
 */

import { explainUnplaced, explainHardConflicts, explainSoftViolations } from './explain.js';
import { auditProject } from './audit.js';
import { suggestForUnplaced, suggestForConflict, suggestForAudit } from './suggest.js';

/** 把 explain/audit 项的涉及对象抽成 {teachers,classes,subjects,rooms} id 列表，供倒排索引。 */
function objectsOf(item) {
    const out = { teachers: new Set(), classes: new Set(), subjects: new Set(), rooms: new Set() };
    // explain 项用显示名，倒排用显示名/id 都可——这里用显示名做键，UI 可直接匹配
    for (const t of item.teachers ?? []) out.teachers.add(t);
    for (const c of item.classes ?? []) out.classes.add(c);
    if (item.subject) out.subjects.add(item.subject);
    for (const b of item.blockers ?? []) {
        for (const t of b.teachers ?? []) out.teachers.add(t);
        for (const c of b.classes ?? []) out.classes.add(c);
        if (b.subject) out.subjects.add(b.subject);
    }
    if (item.objects) {
        for (const t of item.objects.teachers ?? []) out.teachers.add(t);
        for (const c of item.objects.classes ?? []) out.classes.add(c);
        if (item.objects.subject) out.subjects.add(item.objects.subject);
    }
    if (item.resourceName) {
        if (item.resourceKind === 'teacher') out.teachers.add(item.resourceName);
        else if (item.resourceKind === 'class') out.classes.add(item.resourceName);
        else if (item.resourceKind === 'room') out.rooms.add(item.resourceName);
    }
    return out;
}

/**
 * 构建完整诊断报告。
 * @param {object} project 已 createProject
 * @param {object} solution Phase 2 解（可为部分解）
 * @param {object} ctx buildContext 产出
 * @param {object[]} [hardConflicts] 可选，外部已算好的硬冲突；缺省时本地探测
 */
export function buildDiagnostics(project, solution, ctx, hardConflicts) {
    const unplaced = explainUnplaced(project, solution, ctx);
    const conflicts = explainHardConflicts(project, solution, ctx, hardConflicts);
    const softViolations = explainSoftViolations(project, solution, ctx);
    const auditFindings = auditProject(project, ctx);

    const items = [];
    const byObject = { teachers: {}, classes: {}, subjects: {}, rooms: {} };

    function index(item) {
        items.push(item);
        const objs = objectsOf(item);
        const ref = items.length - 1;
        for (const [k, set] of Object.entries(objs)) {
            for (const name of set) {
                (byObject[k][name] ??= []).push(ref);
            }
        }
    }

    for (const u of unplaced) index({ category: 'unplaced', severity: 'error', ...u });
    for (const c of conflicts) index({ category: 'hard-conflict', severity: 'error', ...c });
    for (const s of softViolations) index({ category: 'soft-violation', ...s });
    for (const a of auditFindings) index({ category: 'audit', ...a });

    // 建议草稿
    const suggestions = [];
    for (const u of unplaced) suggestions.push(...suggestForUnplaced(u));
    for (const c of conflicts) suggestions.push(...suggestForConflict(c));
    for (const a of auditFindings) suggestions.push(...suggestForAudit(a));

    const summary = { error: 0, warning: 0, info: 0, total: items.length, suggestions: suggestions.length };
    for (const it of items) summary[it.severity ?? 'info'] = (summary[it.severity ?? 'info'] || 0) + 1;

    return {
        items,
        byObject,
        suggestions,
        summary,
        /** 取某对象相关的全部诊断项（解引用倒排索引）。 */
        forObject(kind, name) {
            const refs = byObject[kind]?.[name] ?? [];
            return refs.map(r => items[r]);
        },
        toJSON() {
            return { items, byObject, suggestions, summary };
        },
    };
}
