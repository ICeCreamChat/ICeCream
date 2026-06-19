/**
 * timetable-v2 / solver / audit.js
 *
 * 输入数据审计：求解前识别缺对象、课时矛盾、不可能约束（build-guide §4.1 第 2 步）。
 * 本阶段只产结构化发现，人类语言归因/修复建议留 Phase 4。
 *
 * 纯函数、零 IO。
 */

/**
 * @param {object} project 已 createProject
 * @param {object[]} activities 已展开
 * @returns {{ findings: Array<{level,code,message,ref?}> }}
 */
export function auditInputData(project, activities) {
    const findings = [];
    const cal = project.calendar;
    const slotCount = cal.slotCount;

    // 1. 教师总课时是否超过其可用时段（粗粒度不可能约束）
    const teacherUnits = new Map();
    for (const a of activities) {
        for (const tid of a.teacherIds) {
            teacherUnits.set(tid, (teacherUnits.get(tid) || 0) + a.duration);
        }
    }
    for (const [tid, units] of teacherUnits) {
        if (units > slotCount) {
            findings.push({
                level: 'error', code: 'teacher_overload',
                message: `教师 ${tid} 的总课时 ${units} 超过日历总时段 ${slotCount}，必有课排不下`,
                ref: { teacherId: tid },
            });
        }
    }

    // 2. 班级总课时是否超过日历时段
    const classUnits = new Map();
    for (const a of activities) {
        for (const cid of a.classIds) {
            classUnits.set(cid, (classUnits.get(cid) || 0) + a.duration);
        }
    }
    for (const [cid, units] of classUnits) {
        if (units > slotCount) {
            findings.push({
                level: 'error', code: 'class_overload',
                message: `班级 ${cid} 的总课时 ${units} 超过日历总时段 ${slotCount}`,
                ref: { classId: cid },
            });
        }
    }

    // 3. 教师"可用时段不足"：扣除不可用时段后，剩余容量 < 该教师总课时（不可能约束）
    const unavail = collectUnavailableByTeacher(project);
    for (const [tid, units] of teacherUnits) {
        const blocked = unavail.get(tid) || 0;
        const capacity = slotCount - blocked;
        if (units > capacity) {
            findings.push({
                level: 'error', code: 'teacher_no_capacity',
                message: `教师 ${tid} 总课时 ${units} 超过其可用时段 ${capacity}（总时段 ${slotCount} 扣除不可用 ${blocked}），必有课排不下`,
                ref: { teacherId: tid },
            });
        }
    }

    // 4. 空活动集
    if (activities.length === 0) {
        findings.push({ level: 'warn', code: 'no_activities', message: '没有可排活动（activityPlans 为空或展开为空）' });
    }

    return { findings };
}

/** 统计每个教师被约束声明的不可用时段数（去重）。 */
function collectUnavailableByTeacher(project) {
    const map = new Map();
    for (const c of project.constraints ?? []) {
        if (c.type !== 'teacher_unavailable') continue;
        const tid = c.target?.teacherId;
        if (!tid) continue;
        const slots = new Set(c.params?.slots ?? []);
        map.set(tid, Math.max(map.get(tid) || 0, slots.size));
    }
    return map;
}
