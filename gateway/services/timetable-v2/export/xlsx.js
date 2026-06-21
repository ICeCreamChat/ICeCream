/**
 * timetable-v2 / export / xlsx.js
 *
 * 消费 grid.js 的 buildGridView，生成 xlsx Buffer（多工作表：班级课表 / 教师课表 / 总表 / 任课计划）。
 * 复用旧 timetable-export.js 的 xlsx 生成机制（adm-zip 手写 OOXML），不依赖第三方 xlsx 库、不落盘。
 *
 * 纯函数：返回 Buffer，不修改入参，零磁盘 IO。
 */

import AdmZip from 'adm-zip';

import { buildGridView } from './grid.js';

/** 与旧 TIMETABLE_XLSX_MIME 同值，供路由层设置 Content-Type。 */
export const V2_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function xml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function columnName(index) {
    let n = index + 1;
    let name = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

function createSharedStringTable() {
    const map = new Map();
    const values = [];
    return {
        index(value) {
            const text = String(value ?? '');
            if (!map.has(text)) {
                map.set(text, values.length);
                values.push(text);
            }
            return map.get(text);
        },
        xml() {
            return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${values.length}" uniqueCount="${values.length}">
${values.map(value => `<si><t xml:space="preserve">${xml(value)}</t></si>`).join('')}
</sst>`;
        },
    };
}

function buildSheet(rows, sharedStrings) {
    const rowXml = rows.map((row, rowIndex) => {
        const cells = row.map((value, colIndex) => {
            const ref = `${columnName(colIndex)}${rowIndex + 1}`;
            return `<c r="${ref}" t="s"><v>${sharedStrings.index(value)}</v></c>`;
        }).join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

/** 网格单元 → 文本（多行用 \n，xlsx 可识别）。owner 类型决定展示哪些字段。 */
function cellText(cell, mode) {
    if (!cell) return '';
    if (cell.isBlockStart === false) return '↑'; // 连堂后续格，指向块首
    const subject = cell.subject || '';
    const teachers = (cell.teachers || []).join('、');
    const classes = (cell.classes || []).join('、');
    const room = cell.roomName || '';
    let lines;
    if (mode === 'teacher') lines = [subject, classes, room];
    else if (mode === 'room') lines = [subject, classes, teachers];
    else if (mode === 'master') lines = [classes, subject, teachers, room];
    else lines = [subject, teachers, room]; // class
    return lines.filter(Boolean).join('\n');
}

/** 表头：对象/节次 + 每个 (weekday, period) 列。 */
function headerRow(label, weekdays, periodsPerDay) {
    const head = [label];
    for (let d = 1; d <= weekdays; d++) {
        for (let p = 1; p <= periodsPerDay; p++) {
            head.push(`${WEEKDAY_NAMES[d - 1] || `周${d}`} 第${p}节`);
        }
    }
    return head;
}

/**
 * 把某一视图（byClass/byTeacher/byRoom）转成行数组。
 * @param {object} view { [id]: { <nameKey>, grid } }
 * @param {string} nameKey 'className'|'teacherName'|'roomName'
 * @param {string} mode cellText 模式
 */
function viewRows(view, nameKey, mode, weekdays, periodsPerDay, headerLabel) {
    const rows = [headerRow(headerLabel, weekdays, periodsPerDay)];
    for (const id of Object.keys(view)) {
        const entry = view[id];
        const row = [entry[nameKey] || id];
        for (let d = 0; d < weekdays; d++) {
            for (let p = 0; p < periodsPerDay; p++) {
                row.push(cellText(entry.grid[p]?.[d], mode));
            }
        }
        rows.push(row);
    }
    return rows;
}

/** 总表：每个班级一行，单元含科目 / 教师。 */
function masterRows(byClass, weekdays, periodsPerDay) {
    const rows = [headerRow('班级/节次', weekdays, periodsPerDay)];
    for (const id of Object.keys(byClass)) {
        const entry = byClass[id];
        const row = [entry.className || id];
        for (let d = 0; d < weekdays; d++) {
            for (let p = 0; p < periodsPerDay; p++) {
                row.push(cellText(entry.grid[p]?.[d], 'master'));
            }
        }
        rows.push(row);
    }
    return rows;
}

/** 任课计划表。 */
function planRows(project) {
    const classMap = new Map(asArray(project.classes).map(c => [c.id, c]));
    const subjectMap = new Map(asArray(project.subjects).map(s => [s.id, s]));
    const teacherMap = new Map(asArray(project.teachers).map(t => [t.id, t]));
    const rows = [['计划', '班级', '课程', '教师', '周课时', '连堂', '单双周']];
    for (const plan of asArray(project.activityPlans)) {
        const classNames = (plan.classIds || []).map(id => {
            const c = classMap.get(id);
            return c ? `${c.grade || ''}${c.name || ''}` : id;
        }).join('、');
        const teacherNames = (plan.teacherIds || []).map(id => teacherMap.get(id)?.name || id).join('、');
        const subjectName = subjectMap.get(plan.subjectId)?.name || plan.subjectId || '';
        const pattern = plan.durationPattern === 'double' ? '双连堂'
            : plan.durationPattern === 'mixed' ? '混合' : '单节';
        rows.push([
            plan.id,
            classNames,
            subjectName,
            teacherNames,
            String(plan.weeklyUnits ?? ''),
            pattern,
            plan.weekPattern === 'oddeven' ? '单双周' : '每周',
        ]);
    }
    return rows;
}

function asArray(v) {
    return Array.isArray(v) ? v : [];
}

function clampDim(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * 生成 v2 课表 xlsx Buffer。
 * @param {object} project SchoolProjectV2
 * @param {object} solveResult solve() 返回值
 * @param {object} [options] 预留（暂未使用具体开关）
 * @returns {Buffer} xlsx（zip）二进制
 */
export function buildV2ExportXlsx(project, solveResult, options = {}) {
    const calendar = project.calendar || {};
    const weekdays = clampDim(calendar.weekdays, 5);
    const periodsPerDay = clampDim(calendar.periodsPerDay, 7);

    const { byClass, byTeacher } = buildGridView(project, solveResult);

    const sheets = [
        { name: '班级课表', rows: viewRows(byClass, 'className', 'class', weekdays, periodsPerDay, '班级/节次') },
        { name: '教师课表', rows: viewRows(byTeacher, 'teacherName', 'teacher', weekdays, periodsPerDay, '教师/节次') },
        { name: '总表', rows: masterRows(byClass, weekdays, periodsPerDay) },
        { name: '任课计划', rows: planRows(project) },
    ];

    const sharedStrings = createSharedStringTable();
    const sheetXmls = sheets.map(s => buildSheet(s.rows, sharedStrings));

    const zip = new AdmZip();

    const contentTypeOverrides = sheets
        .map((_, i) => `  <Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('\n');

    zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${contentTypeOverrides}
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`));

    zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`));

    const sheetEntries = sheets
        .map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('');
    zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetEntries}</sheets>
</workbook>`));

    // worksheet rels: rId1..N 指向各 sheet，sharedStrings 用 rId(N+1)
    const ssRelId = sheets.length + 1;
    const wbRels = sheets
        .map((_, i) => `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('\n');
    zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${wbRels}
  <Relationship Id="rId${ssRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`));

    sheetXmls.forEach((sheetXml, i) => {
        zip.addFile(`xl/worksheets/sheet${i + 1}.xml`, Buffer.from(sheetXml));
    });
    zip.addFile('xl/sharedStrings.xml', Buffer.from(sharedStrings.xml()));

    return zip.toBuffer();
}
