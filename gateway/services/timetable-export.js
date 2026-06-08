import AdmZip from 'adm-zip';

import {
    getActivePeriods,
    getActiveWeekdays,
} from './timetable-project.js';

export const TIMETABLE_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
${values.map(value => `<si><t>${xml(value)}</t></si>`).join('')}
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

function sheetRowsForPlans(project) {
    const classMap = new Map(project.classes.map(item => [item.id, item]));
    const subjectMap = new Map(project.subjects.map(item => [item.id, item]));
    const teacherMap = new Map(project.teachers.map(item => [item.id, item]));
    return [
        ['年级', '班级', '课程', '教师', '周课时', '连堂'],
        ...project.lessonPlans.map(plan => [
            classMap.get(plan.classId)?.grade || '',
            classMap.get(plan.classId)?.name || plan.className || '',
            subjectMap.get(plan.subjectId)?.name || plan.subjectName || '',
            teacherMap.get(plan.teacherId)?.name || plan.teacherName || '',
            String(plan.weeklyHours || ''),
            plan.blockPreference === 'double' ? '双连堂' : plan.blockPreference === 'mixed' ? '混合' : '单节',
        ]),
    ];
}

function lessonLabel(project, slot, mode) {
    const subject = project.subjects.find(item => item.id === slot.subjectId)?.name || slot.subjectId;
    const teacher = project.teachers.find(item => item.id === slot.teacherId)?.name || slot.teacherId;
    const klass = project.classes.find(item => item.id === slot.classId);
    if (mode === 'teacher') return `${subject}\n${klass?.grade || ''}${klass?.name || ''}`.trim();
    if (mode === 'master') return `${klass?.grade || ''}${klass?.name || ''}\n${subject}\n${teacher}`.trim();
    return `${subject}\n${teacher}`.trim();
}

function sheetRowsForSchedule(project, mode) {
    const slots = project.schedule?.slots || [];
    const owners = mode === 'teacher' ? project.teachers : mode === 'master' ? [{ id: 'all', name: '总课表' }] : project.classes;
    const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const activeWeekdays = getActiveWeekdays(project);
    const activePeriods = getActivePeriods(project);
    const rows = [['对象/节次', ...activeWeekdays.flatMap(day => activePeriods.map(period => `${weekdayNames[day - 1] || `周${day}`} 第${period}节`))]];

    for (const owner of owners) {
        const row = [mode === 'class' ? `${owner.grade}${owner.name}` : owner.name];
        for (const day of activeWeekdays) {
            for (const period of activePeriods) {
                const found = slots.filter(slot => slot.day === day && slot.period === period)
                    .filter(slot => mode === 'teacher' ? slot.teacherId === owner.id : mode === 'class' ? slot.classId === owner.id : true);
                row.push(found.map(slot => lessonLabel(project, slot, mode)).join('\n'));
            }
        }
        rows.push(row);
    }
    return rows;
}

function workbookXml(sheetName) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

export function buildTimetableExportXlsx(project, options = {}) {
    const type = options.type || 'class';
    const sheetName = type === 'plans' ? '任课信息' : type === 'teacher' ? '教师课表' : type === 'master' ? '总课表' : '班级课表';
    const rows = type === 'plans' ? sheetRowsForPlans(project) : sheetRowsForSchedule(project, type);
    const sharedStrings = createSharedStringTable();
    const sheet = buildSheet(rows, sharedStrings);
    const zip = new AdmZip();

    zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`));
    zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`));
    zip.addFile('xl/workbook.xml', Buffer.from(workbookXml(sheetName)));
    zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`));
    zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheet));
    zip.addFile('xl/sharedStrings.xml', Buffer.from(sharedStrings.xml()));
    return zip.toBuffer();
}
