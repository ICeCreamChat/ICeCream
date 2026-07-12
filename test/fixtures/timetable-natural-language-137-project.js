import fs from 'node:fs';

const SUBJECTS = [
    '语文', '数学', '英语', '道法', '历史', '地理', '生物',
    '体育', '音乐', '美术', '信息', '劳动', '物理', '化学',
];

function slug(prefix, index) {
    return `${prefix}-${String(index + 1).padStart(3, '0')}`;
}

function teacherNamesFromFixture(fixture) {
    return [...new Set(fixture.flatMap(item => {
        const match = item.rawText.match(/^([\u4e00-\u9fff]{2,4})老师/u);
        return match ? [match[1]] : [];
    }))];
}

function lessonMetadata(subjectName) {
    if (subjectName === '物理') return { activityTypes: ['普通课', '实验课'], requiredResourceTypes: ['物理实验室'] };
    if (subjectName === '化学') return { activityTypes: ['普通课', '实验课'], requiredResourceTypes: ['化学实验室'] };
    if (subjectName === '生物') return { activityTypes: ['普通课', '实验课'], requiredResourceTypes: ['生物实验室'] };
    if (subjectName === '信息') return { activityTypes: ['普通课', '上机课'], requiredResourceTypes: ['计算机教室'] };
    if (['语文', '数学', '英语', '物理', '化学'].includes(subjectName)) {
        return { activityTypes: ['普通课', '新授课', '复习', '答疑'], requiredResourceTypes: [] };
    }
    return { activityTypes: ['普通课'], requiredResourceTypes: [] };
}

export function createCompleteNaturalLanguage137Project(fixturePath = new URL('./timetable-natural-language-137.json', import.meta.url)) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const teachers = teacherNamesFromFixture(fixture).map((name, index) => ({ id: slug('teacher', index), name }));
    const classes = [7, 8, 9].flatMap(grade => Array.from({ length: 10 }, (_, index) => ({
        id: `G${grade}-${index + 1}`,
        name: `G${grade}-${index + 1}班`,
        grade: `${grade}年级`,
    })));
    const subjects = SUBJECTS.map((name, index) => ({ id: slug('subject', index), name }));
    const rooms = [
        { id: 'physics-a', name: '物理实验室A', tags: ['实验室', '物理实验室'] },
        { id: 'physics-b', name: '物理实验室B', tags: ['实验室', '物理实验室'] },
        { id: 'chemistry', name: '化学实验室', tags: ['实验室', '化学实验室'] },
        { id: 'biology-a', name: '生物实验室A', tags: ['实验室', '生物实验室'] },
        { id: 'biology-b', name: '生物实验室B', tags: ['实验室', '生物实验室'] },
        { id: 'computer-a', name: '计算机教室A', tags: ['机房', '计算机教室'] },
        { id: 'computer-b', name: '计算机教室B', tags: ['机房', '计算机教室'] },
        { id: 'ordinary-1', name: '普通教室1', tags: ['普通教室'] },
    ];
    const lessonPlans = classes.flatMap((klass, classIndex) => subjects.map((subject, subjectIndex) => {
        const teacher = teachers[(classIndex * subjects.length + subjectIndex) % teachers.length];
        return {
            id: `plan-${klass.id}-${subject.id}`,
            classId: klass.id,
            subjectId: subject.id,
            teacherId: teacher.id,
            teacherIds: [teacher.id],
            weeklyHours: 1,
            blockPreference: 'single',
            ...lessonMetadata(subject.name),
        };
    }));
    return {
        teachers,
        classes,
        subjects,
        rooms,
        lessonPlans,
        weekdays: 5,
        periodsPerDay: 8,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7, 8],
        rules: { hardRules: {}, softRules: {}, advancedRules: [] },
    };
}
