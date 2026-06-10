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

function publicationIssueLabel(type = '') {
    return ({
        class_capacity: '班级容量',
        class_load: '班级负载',
        hard_conflicts: '硬冲突',
        inactive_slot: '作息范围',
        incomplete_schedule: '未排课时',
        invalid_schedule_refs: '无效引用',
        manual_adjusted: '手动调整',
        manual_review: '教务复核',
        missing_lesson_plans: '任课数据',
        missing_schedule: '课表生成',
        quality_review: '质量建议',
        restored_published_draft: '恢复发布版',
        room_capacity: '教室容量',
        room_load: '教室负载',
        subject_avoid_period: '避开节次',
        subject_spread: '同科分散',
        teacher_capacity: '教师容量',
        teacher_consecutive: '教师连续课',
        teacher_daily_limit: '教师日课时',
        teacher_load: '教师负载',
    })[type] || (type ? '校验提醒' : '');
}

function publicationIssueText(item = {}) {
    return item.message || item.targetName || publicationIssueLabel(item.type);
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

function publicationMetadataRows(project = {}, options = {}) {
    if (options.type === 'plans') return [];
    const schedule = project.schedule || {};
    const published = schedule.published || null;
    const publication = schedule.publication || {};
    const summary = publication.summary || schedule.score || {};
    if (!published && !publication.ok && !options.published) return [];
    const version = Number.parseInt(published?.version, 10);
    const publishedAt = published?.publishedAt || '';
    const note = published?.note || '';
    const fingerprint = published?.fingerprint || published?.snapshot?.fingerprint || '';
    const validation = publication.ok ? '已通过' : publication.reason ? '未通过' : '未校验';
    const rows = [
        ['发布信息'],
        ['发布状态', published ? (published.status === 'draft_changed' ? '草稿已变化' : '已发布') : '未发布'],
        ['发布版本', Number.isInteger(version) ? `V${version}` : ''],
        ['发布时间', publishedAt],
        ['发布备注', note],
        ['发布指纹', fingerprint],
        ['课表编号', published?.scheduleId || schedule.id || ''],
        ['发布校验', validation],
        ['课时', `${summary.placedLessons ?? schedule.score?.placedLessons ?? 0}/${summary.totalLessons ?? schedule.score?.totalLessons ?? 0}`],
        ['硬冲突', String(summary.hardConflicts ?? schedule.score?.hardConflicts ?? 0)],
        ['未排课时', String(summary.unplacedLessons ?? schedule.score?.unplacedLessons ?? 0)],
    ];
    const warnings = Array.isArray(publication.warnings) ? publication.warnings : [];
    if (warnings.length) rows.push(['发布提醒', warnings.map(publicationIssueText).filter(Boolean).join('；')]);
    rows.push([]);
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
    const rows = type === 'plans'
        ? sheetRowsForPlans(project)
        : [...publicationMetadataRows(project, { ...options, type }), ...sheetRowsForSchedule(project, type)];
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
