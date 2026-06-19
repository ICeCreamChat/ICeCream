/**
 * timetable-v2 / importers / excel.js
 *
 * Excel/CSV 教学计划样本 → SchoolProjectV2（Phase 3 重写）。
 *
 * 纯函数读取层：只接收「已切分的行数组」或「制表符/逗号分隔的纯文本」，
 * 不读 .xlsx 二进制（那是 Phase 6 IO 层职责），零写回、零落盘。
 *
 * 复用 gateway/services/timetable-import.js 的解析约定（表头识别 / 周课时 /
 * 连堂偏好 / 实体名拆分），但产出 V2（ActivityPlan）而非旧 lessonPlan 模型。
 *
 * 聚合规则：行按 (grade-className, subjectName, teacherName 集合) 聚合为 ActivityPlan，
 *   - weeklyHours 累加 → weeklyUnits
 *   - blockPreference → durationPattern
 *   - roomName（多个）→ roomRequirements（去重）
 *   - 教师名（splitEntityNames 多教师）→ teacherIds
 * 缺列 / 空行 / 无法解析的行 → 迁移报告（dropped / degraded），不中断整体导入。
 */

import { createProject } from '../domain/project.js';
import { SUBJECT_CATEGORIES } from '../domain/subject.js';
import { createMigrationReport } from './migration-report.js';

const PALETTE = ['#14b8a6', '#60a5fa', '#f59e0b', '#f97316', '#a78bfa', '#22c55e', '#ef4444', '#06b6d4'];

// ---- 文本/单元格清洗（照搬 timetable-import.js 规则）----

function cleanCell(value, max = 200) {
    return String(value ?? '')
        .replace(/[\x00-\x1F\x7F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function splitLine(line) {
    return String(line ?? '')
        .replace(/[|；;]/g, ',')
        .split(/\t|,|，/)
        .map(v => cleanCell(v));
}

function splitEntityNames(value) {
    return cleanCell(value)
        .split(/[、,，/／;；|]+/)
        .map(v => cleanCell(v))
        .filter(Boolean);
}

function normalizeHeader(value) {
    const text = cleanCell(value).toLowerCase();
    if (/课程类型|课程类别|学科类型|subject\s*(category|type)|course\s*(category|type)|category|type/.test(text)) return 'subjectCategory';
    if (/课程标签|学科标签|subject\s*tags?|course\s*tags?|tags?/.test(text)) return 'subjectTags';
    if (/年级|grade/.test(text)) return 'grade';
    if (/班级|class/.test(text)) return 'className';
    if (/课程|科目|学科|subject|course/.test(text)) return 'subjectName';
    if (/教师|老师|teacher/.test(text)) return 'teacherName';
    if (/课时|周课时|hours|hour/.test(text)) return 'weeklyHours';
    if (/连堂|块|block/.test(text)) return 'blockPreference';
    if (/教室|场地|room|classroom/.test(text)) return 'roomName';
    return null;
}

function parseBlockPreference(value) {
    const text = cleanCell(value).toLowerCase();
    if (!text) return 'single';
    if (['double', 'block', '2'].includes(text) || /双|连堂|double|block/.test(text)) return 'double';
    if (['mixed', 'mix'].includes(text) || /混|单双|mixed|mix/.test(text)) return 'mixed';
    return 'single';
}

function parseWeeklyHours(value) {
    const text = cleanCell(value);
    if (!text) return 0;
    const plus = text.match(/^(\d+)\s*\+\s*(\d+)$/);
    if (plus) return Number(plus[1]) + Number(plus[2]) * 2;
    const match = text.match(/\d+/);
    return match ? Number(match[0]) : 0;
}

// ---- 稳定 id 生成（同名→同 id，自实现，不 import 旧模块）----

function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value ?? '')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function makeId(prefix, value) {
    const text = cleanCell(value, 80);
    const ascii = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return `${prefix}_${ascii || stableHash(text)}`;
}

// ---- 课程分类 / 标签归一（本地实现，避免耦合旧模型模块）----

function normalizeSubjectCategory(value = '', fallbackName = '') {
    const explicit = cleanCell(value, 40).toLowerCase();
    const text = explicit || cleanCell(fallbackName, 80).toLowerCase();
    if (!text) return 'normal';
    if (['main', 'core', 'major'].includes(text) || /main|core|major|chinese|math|english/.test(text)
        || /主科|核心|语文|数学|英语|外语/.test(text)) {
        return 'main';
    }
    if (['quality', 'elective', 'arts', 'sport', 'pe'].includes(text) || /quality|elective|arts?|sport|music|pe|labor|ict/.test(text)
        || /素质|艺体|体育|音乐|美术|劳动|信息/.test(text)) {
        return 'quality';
    }
    if (['lab', 'experiment', 'experimental'].includes(text) || /lab|experiment/.test(text) || /实验/.test(text)) {
        return 'lab';
    }
    return 'normal';
}

function normalizeSubjectTags(value = []) {
    const raw = Array.isArray(value) ? value : [value];
    const tags = [];
    for (const item of raw) {
        String(item ?? '')
            .split(/[,，、/;；|\s]+/)
            .map(part => cleanCell(part, 40))
            .filter(Boolean)
            .forEach(tag => {
                const normalized = /^[a-z0-9_-]+$/i.test(tag) ? tag.toLowerCase() : tag;
                if (!tags.includes(normalized)) tags.push(normalized);
            });
    }
    return tags;
}

function defaultPriority(category) {
    if (category === 'main') return 95;
    if (category === 'lab') return 60;
    if (category === 'quality') return 35;
    return 50;
}

// ---- 行解析（兼容字符串数组 / 已切分二维数组 / 纯文本）----

function toLines(input) {
    // 字符串保留空行（交由主流程记入报告），数组原样返回。
    if (Array.isArray(input)) return input;
    return String(input ?? '').split(/\r?\n/);
}

function splitRow(line) {
    // 已切分的行（数组）直接清洗；字符串走 splitLine。
    if (Array.isArray(line)) return line.map(v => cleanCell(v));
    return splitLine(line);
}

function parseRows(input) {
    // 保留空行位置以记入报告，但裁掉首尾全空行（纯换行噪声不计）。
    let rows = toLines(input).map(splitRow);
    while (rows.length && !rows[0].some(Boolean)) rows = rows.slice(1);
    while (rows.length && !rows[rows.length - 1].some(Boolean)) rows = rows.slice(0, -1);
    if (!rows.length) return [];

    const firstIdx = rows.findIndex(parts => parts.some(Boolean));

    let header = rows[firstIdx].map(normalizeHeader);
    let dataStart;
    if (!header.includes('className') || !header.includes('subjectName') || !header.includes('teacherName')) {
        // 默认表头兜底（与 timetable-import.js 一致）
        header = ['grade', 'className', 'subjectName', 'teacherName', 'weeklyHours', 'blockPreference', 'roomName'];
        dataStart = firstIdx;
    } else {
        dataStart = firstIdx + 1;
    }

    return rows.slice(dataStart).map((parts, index) => {
        const row = { sourceRow: dataStart + index + 1 };
        header.forEach((key, columnIndex) => {
            if (key && row[key] === undefined) row[key] = parts[columnIndex];
        });
        return row;
    });
}

function rowHasAnyValue(row = {}) {
    return ['grade', 'className', 'subjectName', 'teacherName', 'weeklyHours', 'blockPreference', 'roomName', 'subjectCategory', 'subjectTags']
        .some(key => cleanCell(row[key]));
}

// ---- 主入口 ----

/**
 * 把 Excel/CSV 教学计划行/文本导入为 SchoolProjectV2。
 * @param {string|Array} rowsOrText 已切分行数组、二维数组或制表符/逗号分隔纯文本
 * @param {object} [options] { id, name } 项目元信息
 * @returns {{ project: object, report: object, raw: any }}
 */
export function importExcelPlans(rowsOrText, options = {}) {
    const report = createMigrationReport('excel');
    const rows = parseRows(rowsOrText);

    const classes = new Map();
    const teachers = new Map();
    const subjects = new Map();
    const rooms = new Map();
    const plans = new Map(); // key -> plan accumulator

    rows.forEach(row => {
        const source = { row: row.sourceRow };

        if (!rowHasAnyValue(row)) {
            report.dropped({ source, field: 'row', reason: '空行，无任何可识别字段' });
            return;
        }

        const grade = cleanCell(row.grade) || '默认年级';
        const className = cleanCell(row.className);
        const subjectName = cleanCell(row.subjectName);
        const teacherNames = splitEntityNames(row.teacherName);
        const weeklyHours = parseWeeklyHours(row.weeklyHours);
        const blockPreference = parseBlockPreference(row.blockPreference);
        const roomNames = splitEntityNames(row.roomName);

        // 缺必填列 → dropped
        const missing = [];
        if (!className) missing.push('className');
        if (!subjectName) missing.push('subjectName');
        if (!teacherNames.length) missing.push('teacherName');
        if (missing.length) {
            report.dropped({
                source,
                field: missing.join(','),
                reason: `缺少必填列：${missing.join('、')}`,
                originalValue: { className, subjectName, teacherName: row.teacherName },
            });
            return;
        }
        if (weeklyHours <= 0) {
            report.dropped({
                source,
                field: 'weeklyHours',
                reason: '周课时无法解析为正整数',
                originalValue: row.weeklyHours,
            });
            return;
        }

        // 实体去重生成（稳定 id）
        const classId = makeId('c', `${grade}-${className}`);
        if (!classes.has(classId)) classes.set(classId, { id: classId, grade, name: className });

        const subjectId = makeId('s', subjectName);
        const category = normalizeSubjectCategory(row.subjectCategory, subjectName);
        const tags = normalizeSubjectTags(row.subjectTags);
        if (!subjects.has(subjectId)) {
            subjects.set(subjectId, {
                id: subjectId,
                name: subjectName,
                category: SUBJECT_CATEGORIES.includes(category) ? category : 'normal',
                priority: defaultPriority(category),
                tags: [...tags],
                color: PALETTE[subjects.size % PALETTE.length],
            });
        } else {
            // 合并标签
            const existing = subjects.get(subjectId);
            tags.forEach(t => { if (!existing.tags.includes(t)) existing.tags.push(t); });
        }

        const teacherIds = teacherNames.map(name => {
            const tid = makeId('t', name);
            if (!teachers.has(tid)) teachers.set(tid, { id: tid, name, subjects: [] });
            const teacher = teachers.get(tid);
            if (!teacher.subjects.includes(subjectId)) teacher.subjects.push(subjectId);
            return tid;
        });

        const roomIds = roomNames.map(name => {
            const rid = makeId('r', name);
            if (!rooms.has(rid)) rooms.set(rid, { id: rid, name });
            return rid;
        });

        // 聚合键：(班级, 课程, 教师集合)
        const planKey = [classId, subjectId, [...teacherIds].sort().join('+')].join('|');
        if (!plans.has(planKey)) {
            plans.set(planKey, {
                id: makeId('ap', planKey),
                classIds: [classId],
                subjectId,
                teacherIds: [...teacherIds],
                weeklyUnits: 0,
                durationPattern: 'single',
                roomRequirements: [],
                rowCount: 0,
                sourceRows: [],
            });
        }
        const plan = plans.get(planKey);
        plan.weeklyUnits += weeklyHours;
        plan.rowCount += 1;
        plan.sourceRows.push(row.sourceRow);
        // 连堂偏好：组内首个非 single 的偏好生效
        if (plan.durationPattern === 'single' && blockPreference !== 'single') {
            plan.durationPattern = blockPreference;
        }
        roomIds.forEach(rid => { if (!plan.roomRequirements.includes(rid)) plan.roomRequirements.push(rid); });
    });

    // 计划级后处理：连堂偏好但课时为奇数 → 降级提示（仍可展开，余 1 单节）
    const activityPlans = [...plans.values()].map(plan => {
        const source = { rows: plan.sourceRows.slice() };
        if (plan.durationPattern === 'double' && plan.weeklyUnits % 2 !== 0) {
            report.degraded({
                source,
                field: 'durationPattern',
                reason: `连堂课时为奇数(${plan.weeklyUnits})，展开时余 1 节按单节处理`,
                originalValue: plan.weeklyUnits,
            });
        }
        report.kept({
            source,
            field: 'activityPlan',
            reason: `聚合 ${plan.rowCount} 行 → ${plan.weeklyUnits} 周课时`,
        });
        return {
            id: plan.id,
            classIds: plan.classIds,
            subjectId: plan.subjectId,
            teacherIds: plan.teacherIds,
            weeklyUnits: plan.weeklyUnits,
            durationPattern: plan.durationPattern,
            roomRequirements: plan.roomRequirements,
        };
    });

    const project = createProject({
        id: options.id ?? 'excel_import',
        name: options.name ?? 'Excel 导入',
        classes: [...classes.values()],
        teachers: [...teachers.values()],
        subjects: [...subjects.values()],
        rooms: [...rooms.values()],
        activityPlans,
        constraints: [],
    });

    return { project, report, raw: rowsOrText };
}
