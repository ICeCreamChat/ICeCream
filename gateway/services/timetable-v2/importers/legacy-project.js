/**
 * timetable-v2 / importers / legacy-project.js
 *
 * 旧 ICeCream 排课项目 JSON → 合法 SchoolProjectV2（决策 1 / 3 / 3.1）。
 *
 * 纯读取层：零 IO、零写回、不 mutate 入参。返回 { project, report, raw }。
 *   - project：经 Phase 1 createProject 构造并通过校验的 SchoolProjectV2（含只读 publishedHistory）。
 *   - report ：createMigrationReport('legacy-project') 收集的四分类迁移报告。
 *   - raw    ：原始旧项目对象引用（供诊断 / 回溯），不被改写。
 *
 * 字段形态以 gateway/services/timetable-project.js 的 normalizeTimetableProject 产出为准，
 * 但本导入器直接只读访问 raw（不预归一），以便捕获"非枚举 blockPreference 降级"等需记入
 * 迁移报告的情形（归一会静默兜底，掩盖降级）。
 *
 * 仅通过 Phase 1 公开工厂构造 V2（createProject / createActivityPlan / createSubject /
 * createCalendar），不旁路拼对象。约束以 DSL 草稿产出（type 用 Phase 1 dsl.js 的下划线枚举）。
 */

import { createProject } from '../domain/project.js';
import { DURATION_PATTERNS } from '../domain/activity.js';
import { SUBJECT_CATEGORIES } from '../domain/subject.js';
import { parseSlotKey, toSlotKey } from '../domain/calendar.js';
import { createMigrationReport } from './migration-report.js';

const SCHEDULE_PLAN_PREFIX = 'sched';

/**
 * 把一个旧 ICeCream 项目 JSON 导入为 SchoolProjectV2。
 * @param {object} rawProject 旧项目对象（只读，不会被 mutate）
 * @returns {{ project: object, report: object, raw: object }}
 */
export function importLegacyProject(rawProject = {}) {
    const report = createMigrationReport('legacy-project');
    const raw = rawProject ?? {};

    // ---- 日历 ----
    const calendarInput = {
        weekdays: raw.weekdays,
        periodsPerDay: raw.periodsPerDay,
        activeWeekdays: raw.activeWeekdays,
        activePeriods: raw.activePeriods,
    };

    // ---- 实体：classes / teachers / subjects ----
    const classes = mapClasses(raw.classes, report);
    const teachers = mapTeachers(raw.teachers, report);
    const subjects = mapSubjects(raw.subjects, report);

    const classIds = new Set(classes.map(c => c.id));
    const teacherIds = new Set(teachers.map(t => t.id));
    const subjectIds = new Set(subjects.map(s => s.id));

    // ---- rooms：旧模型无独立 rooms，从 lessonPlans / schedule / lockedSlots 汇集去重 ----
    const roomIds = collectRoomIds(raw, report);
    const rooms = [...roomIds].map(id => ({ id, name: id }));

    // ---- 教学计划 → ActivityPlan ----
    const activityPlans = [];
    const refs = { classIds, teacherIds, subjectIds, roomIds };
    mapLessonPlans(raw.lessonPlans, refs, report, activityPlans);

    // ---- 当前课表 schedule.slots → locked reference（连堂块还原） ----
    const constraints = [];
    mapScheduleSlots(raw.schedule, refs, report, activityPlans, constraints);

    // 产物中真实存在的 ActivityPlan id 集合（含 lessonPlan 与 schedule 派生计划），
    // 供 hardRules.lockedSlots 校验绑定目标，杜绝悬空 fixed_locked。
    refs.planIds = new Set(activityPlans.map(p => p.id));

    // ---- raw.periodTimes / raw.term：V2 不承载，记报告并留存 metadata（不静默丢） ----
    const metadata = mapMetadata(raw, report);

    // ---- 规则：hardRules / softRules → 约束 DSL ----
    mapHardRules(raw, refs, report, constraints);
    mapSoftRules(raw, refs, report, constraints);

    // ---- 课程分类/优先级 → 软约束草稿 ----
    mapSubjectCategoryDrafts(subjects, raw, report, constraints);

    // ---- 构造并校验 V2 ----
    const project = createProject({
        id: raw.id ?? 'default',
        name: raw.schoolName ?? raw.name ?? '',
        calendar: calendarInput,
        classes,
        teachers,
        subjects,
        rooms,
        activityPlans,
        constraints,
    });

    // ---- 发布历史：只读带入，不递归转换 ----
    project.publishedHistory = mapPublishedHistory(raw.schedule, report);

    // ---- 旁路保留 metadata（V2 schema 不承载，仅供诊断 / 回溯，不参与求解） ----
    if (metadata) project.metadata = metadata;

    return { project, report, raw };
}

// ---------------------------------------------------------------------------
// 实体映射
// ---------------------------------------------------------------------------

function mapClasses(rawClasses, report) {
    const out = [];
    for (const [i, c] of asArray(rawClasses).entries()) {
        const id = str(c?.id);
        if (!id) {
            report.dropped({ source: `classes[${i}]`, field: 'class.id', reason: '缺少 id，无法构造 V2 班级', originalValue: c });
            continue;
        }
        out.push({ id, name: str(c?.name), grade: str(c?.grade) });
        report.kept({ source: `classes[${i}]`, field: 'class', reason: '直译为 V2 班级实体' });
    }
    return out;
}

function mapTeachers(rawTeachers, report) {
    const out = [];
    for (const [i, t] of asArray(rawTeachers).entries()) {
        const id = str(t?.id);
        if (!id) {
            report.dropped({ source: `teachers[${i}]`, field: 'teacher.id', reason: '缺少 id，无法构造 V2 教师', originalValue: t });
            continue;
        }
        out.push({
            id,
            name: str(t?.name),
            subjects: asArray(t?.subjects).map(str).filter(Boolean),
        });
        report.kept({ source: `teachers[${i}]`, field: 'teacher', reason: '直译为 V2 教师实体（unavailableSlots 转硬约束）' });
    }
    return out;
}

function mapSubjects(rawSubjects, report) {
    const out = [];
    for (const [i, s] of asArray(rawSubjects).entries()) {
        const id = str(s?.id);
        if (!id) {
            report.dropped({ source: `subjects[${i}]`, field: 'subject.id', reason: '缺少 id，无法构造 V2 课程', originalValue: s });
            continue;
        }
        const category = SUBJECT_CATEGORIES.includes(s?.category) ? s.category : 'normal';
        if (s?.category !== undefined && !SUBJECT_CATEGORIES.includes(s.category)) {
            report.degraded({ source: `subjects[${i}].category`, field: 'subject.category', reason: `非枚举 category 降级为 normal`, originalValue: s.category });
        }
        const priority = clampInt(s?.priority, 50, 1, 100);
        out.push({
            id,
            name: str(s?.name) || id,
            category,
            priority,
            tags: asArray(s?.tags).map(str).filter(Boolean),
            color: s?.color,
        });
        report.kept({ source: `subjects[${i}]`, field: 'subject', reason: '直译为 V2 课程实体（保留 category/priority/tags/color）' });
    }
    return out;
}

function collectRoomIds(raw, report) {
    const ids = new Set();
    const add = v => { const id = str(v); if (id) ids.add(id); };
    for (const lp of asArray(raw.lessonPlans)) {
        add(lp?.roomId);
        asArray(lp?.allowedRoomIds).forEach(add);
    }
    for (const slot of asArray(raw.schedule?.slots)) add(slot?.roomId);
    for (const ls of asArray(raw.schedule?.lockedSlots)) add(ls?.roomId);
    for (const ls of asArray(raw.rules?.hardRules?.lockedSlots)) add(ls?.roomId);
    if (ids.size) {
        report.kept({ source: 'lessonPlans/schedule.roomId+allowedRoomIds', field: 'rooms', reason: `旧模型无独立 rooms，汇集去重生成 ${ids.size} 间教室` });
    }
    return ids;
}

// ---------------------------------------------------------------------------
// 教学计划 → ActivityPlan
// ---------------------------------------------------------------------------

function mapLessonPlans(rawPlans, refs, report, out) {
    for (const [i, lp] of asArray(rawPlans).entries()) {
        const src = `lessonPlans[${i}]`;
        const id = str(lp?.id) || `lp_${i + 1}`;
        const subjectId = str(lp?.subjectId);
        const classId = str(lp?.classId);

        if (!subjectId || !refs.subjectIds.has(subjectId)) {
            report.dropped({ source: src, field: 'lessonPlan.subjectId', reason: '悬空或缺失 subjectId，无法映射为 ActivityPlan', originalValue: lp?.subjectId });
            continue;
        }
        if (!classId || !refs.classIds.has(classId)) {
            report.dropped({ source: src, field: 'lessonPlan.classId', reason: '悬空或缺失 classId，无法映射为 ActivityPlan', originalValue: lp?.classId });
            continue;
        }

        // 多教师：teacherId + teacherIds[] 合并去重，过滤悬空
        const { kept: teacherList, dropped: droppedTeachers } = resolveIds(
            mergeIds(lp?.teacherId, lp?.teacherIds), refs.teacherIds,
        );
        if (droppedTeachers.length) {
            report.degraded({ source: src, field: 'lessonPlan.teacherIds', reason: '剔除悬空 teacherId', originalValue: droppedTeachers });
        }
        if (teacherList.length === 0) {
            report.dropped({ source: src, field: 'lessonPlan.teacherIds', reason: '无有效 teacherId，无法映射为 ActivityPlan', originalValue: mergeIds(lp?.teacherId, lp?.teacherIds) });
            continue;
        }

        const weeklyUnits = Number.parseInt(lp?.weeklyHours ?? lp?.weeklyUnits, 10);
        if (!Number.isInteger(weeklyUnits) || weeklyUnits <= 0) {
            report.dropped({ source: src, field: 'lessonPlan.weeklyHours', reason: 'weeklyHours 非正整数，无法映射为可排活动', originalValue: lp?.weeklyHours });
            continue;
        }

        // blockPreference → durationPattern（非枚举降级 single 记 degraded）
        let durationPattern = lp?.blockPreference;
        if (!DURATION_PATTERNS.includes(durationPattern)) {
            report.degraded({ source: `${src}.blockPreference`, field: 'lessonPlan.blockPreference', reason: '非枚举 blockPreference 降级为 single', originalValue: lp?.blockPreference });
            durationPattern = 'single';
        }

        // roomId + allowedRoomIds[] → roomRequirements（过滤悬空）
        const { kept: roomList, dropped: droppedRooms } = resolveIds(
            mergeIds(lp?.roomId, lp?.allowedRoomIds), refs.roomIds,
        );
        if (droppedRooms.length) {
            report.degraded({ source: src, field: 'lessonPlan.roomRequirements', reason: '剔除悬空 roomId', originalValue: droppedRooms });
        }

        out.push({
            id,
            classId,
            subjectId,
            teacherIds: teacherList,
            weeklyUnits,
            durationPattern,
            roomRequirements: roomList,
            priority: clampInt(lp?.priority, 50, 1, 100),
        });
        report.kept({ source: src, field: 'lessonPlan', reason: '映射为 V2 ActivityPlan（weeklyHours→weeklyUnits / blockPreference→durationPattern / 多教师 / roomRequirements）' });

        // 冗余显示名：保留为 kept（不作引用源）
        if (lp?.className || lp?.subjectName || lp?.teacherName) {
            report.kept({ source: src, field: 'lessonPlan.displayNames', reason: '冗余显示名（className/subjectName/teacherName）保留，引用以 id 为准' });
        }
    }
}

// ---------------------------------------------------------------------------
// 当前课表 schedule.slots → locked reference（连堂块还原）
// ---------------------------------------------------------------------------

function mapScheduleSlots(schedule, refs, report, plansOut, constraintsOut) {
    const slots = asArray(schedule?.slots);
    if (slots.length === 0) return;

    // 按 blockId 分组；blockId 为空各自成组（按 slot 序号唯一化）。
    const groups = new Map();
    slots.forEach((slot, i) => {
        const blockId = str(slot?.blockId);
        const key = blockId || `__single_${i}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ slot, i });
    });

    let seq = 0;
    for (const [key, members] of groups) {
        const src = `schedule.slots[block=${key}]`;
        // 连堂块：按 blockIndex 排序，校验连续节次
        members.sort((a, b) => num(a.slot?.blockIndex) - num(b.slot?.blockIndex));
        const head = members[0].slot;

        const subjectId = str(head?.subjectId);
        const classId = str(head?.classId);
        if (!subjectId || !refs.subjectIds.has(subjectId) || !classId || !refs.classIds.has(classId)) {
            report.dropped({ source: src, field: 'schedule.slot.ref', reason: '已排格悬空引用（subjectId/classId 不存在），无法生成锁定活动', originalValue: { classId: head?.classId, subjectId: head?.subjectId } });
            continue;
        }

        const { kept: teacherList } = resolveIds(mergeIds(head?.teacherId, head?.teacherIds), refs.teacherIds);
        if (teacherList.length === 0) {
            report.dropped({ source: src, field: 'schedule.slot.teacherIds', reason: '已排格无有效 teacherId，无法生成锁定活动', originalValue: mergeIds(head?.teacherId, head?.teacherIds) });
            continue;
        }

        const day = num(head?.day);
        const startPeriod = num(head?.period);
        const blockSize = Math.max(1, members.length);

        // 校验起始 slotKey 合法
        let startKey;
        try {
            startKey = toSlotKey(day, startPeriod);
            parseSlotKey(startKey);
        } catch (e) {
            report.dropped({ source: src, field: 'schedule.slot.time', reason: `已排格时间非法：${e.message}`, originalValue: { day, period: startPeriod } });
            continue;
        }

        // 连堂块：blockIndex 0..blockSize-1 且连续节次校验
        if (blockSize > 1) {
            const periods = members.map(m => num(m.slot?.period));
            const consecutive = periods.every((p, k) => p === startPeriod + k)
                && members.every((m, k) => num(m.slot?.blockIndex) === k)
                && members.every(m => num(m.slot?.day) === day);
            if (!consecutive) {
                report.degraded({ source: src, field: 'schedule.block', reason: '连堂块节次不连续或 blockIndex 不规整，降级为按首格单节锁定', originalValue: { periods } });
                // 退化为单节
                pushLockedPlan(plansOut, constraintsOut, report, src, {
                    seq: seq++, classId, subjectId, teacherList,
                    roomId: str(head?.roomId), refs, blockSize: 1, startKey,
                });
                continue;
            }
        }

        const roomId = str(head?.roomId);

        // blockSize≥3：V2 durationPattern 只能表达 1(single)/2(double) 节连堂，
        // 无法用单个连堂活动表示 N≥3，故降级为“每个原始 slot 独立锁定单节活动”，
        // 保证该块展开出的全部已排格都被钉死、无自由浮动（牺牲连堂语义）。
        if (blockSize >= 3) {
            const slotKeys = [];
            for (const m of members) {
                const k = normalizeSlot(toSlotKey(num(m.slot?.day), num(m.slot?.period)));
                if (k) slotKeys.push(k);
            }
            pushLockedSingles(plansOut, constraintsOut, src, {
                seq: seq++, classId, subjectId, teacherList, roomId, refs, slotKeys,
            });
            report.degraded({
                source: src,
                field: 'schedule.block',
                reason: `V2 durationPattern 仅支持 1/2 节连堂，blockSize=${blockSize} 无法表达为单个连堂活动，已降级为 ${slotKeys.length} 个独立锁定单节活动（每格不可移动，连堂语义降级）`,
                originalValue: { blockSize, slotKeys },
            });
            continue;
        }

        pushLockedPlan(plansOut, constraintsOut, report, src, {
            seq: seq++, classId, subjectId, teacherList, roomId, refs, blockSize, startKey,
        });
        report.kept({
            source: src,
            field: 'schedule.block',
            reason: blockSize === 2
                ? '连堂块（blockSize=2）合并为单个 duration=2 锁定活动'
                : '已排单格映射为单节锁定活动',
        });
    }
}

function pushLockedPlan(plansOut, constraintsOut, report, src, opts) {
    const { seq, classId, subjectId, teacherList, roomId, refs, blockSize, startKey } = opts;
    const planId = `${SCHEDULE_PLAN_PREFIX}_${seq}`;
    const roomRequirements = roomId && refs.roomIds.has(roomId) ? [roomId] : [];

    plansOut.push({
        id: planId,
        classId,
        subjectId,
        teacherIds: teacherList,
        weeklyUnits: blockSize,
        durationPattern: blockSize > 1 ? 'double' : 'single',
        roomRequirements,
        priority: 50,
    });

    // fixed_locked：blockSize=1/2 时该计划恰好展开为单个活动（duration=blockSize），
    // 故锁定 #0 即覆盖整块。
    constraintsOut.push({
        type: 'fixed_locked',
        strength: 'hard',
        target: { activityId: `${planId}#0` },
        params: { slot: startKey },
        source: { kind: 'legacy-schedule', text: `legacy-schedule ${src}`, ref: src },
    });
}

/**
 * blockSize≥3 降级路径：建一个 single 计划（weeklyUnits=slotKeys.length），
 * 展开为 N 个单节活动 `${planId}#0..#N-1`，逐一锁定到对应原始 slot 时间，
 * 确保该块的每个已排格都不可移动（无自由浮动）。
 */
function pushLockedSingles(plansOut, constraintsOut, src, opts) {
    const { seq, classId, subjectId, teacherList, roomId, refs, slotKeys } = opts;
    if (slotKeys.length === 0) return;
    const planId = `${SCHEDULE_PLAN_PREFIX}_${seq}`;
    const roomRequirements = roomId && refs.roomIds.has(roomId) ? [roomId] : [];

    plansOut.push({
        id: planId,
        classId,
        subjectId,
        teacherIds: teacherList,
        weeklyUnits: slotKeys.length,
        durationPattern: 'single',
        roomRequirements,
        priority: 50,
    });

    slotKeys.forEach((slot, k) => {
        constraintsOut.push({
            type: 'fixed_locked',
            strength: 'hard',
            target: { activityId: `${planId}#${k}` },
            params: { slot },
            source: { kind: 'legacy-schedule', text: `legacy-schedule ${src} #${k}`, ref: src },
        });
    });
}

// ---------------------------------------------------------------------------
// 硬规则 rules.hardRules → 硬约束 DSL
// ---------------------------------------------------------------------------

function mapHardRules(raw, refs, report, out) {
    const hard = raw.rules?.hardRules ?? {};

    // lockedSlots → fixed_locked（绑定 lessonPlan 的首个活动）
    for (const [i, ls] of asArray(hard.lockedSlots).entries()) {
        const src = `rules.hardRules.lockedSlots[${i}]`;
        const lessonPlanId = str(ls?.lessonPlanId);
        const day = num(ls?.day);
        const period = num(ls?.period);
        if (!lessonPlanId) {
            report.review({ source: src, field: 'lockedSlot.lessonPlanId', reason: '锁定格缺 lessonPlanId，无法绑定到具体活动，需人工复核', originalValue: ls });
            continue;
        }
        // 防悬空 fixed_locked：lessonPlanId 必须对应产物中真实存在的 ActivityPlan，
        // 否则约束 target 无活动可绑（compile 找不到 idx，锁定形同虚设），记 dropped。
        if (!refs.planIds || !refs.planIds.has(lessonPlanId)) {
            report.dropped({ source: src, field: 'lockedSlot.lessonPlanId', reason: `lessonPlanId "${lessonPlanId}" 在产物中无对应 ActivityPlan（缺失或已被丢弃），不发悬空 fixed_locked 约束`, originalValue: ls });
            continue;
        }
        let slot;
        try {
            slot = toSlotKey(day, period);
            parseSlotKey(slot);
        } catch (e) {
            report.dropped({ source: src, field: 'lockedSlot.time', reason: `锁定时间非法：${e.message}`, originalValue: { day, period } });
            continue;
        }
        out.push({
            type: 'fixed_locked',
            strength: 'hard',
            target: { activityId: `${lessonPlanId}#0` },
            params: { slot, roomId: str(ls?.roomId) || undefined },
            source: { kind: 'legacy-hardrule', text: `lockedSlot ${slot}`, ref: src },
        });
        report.kept({ source: src, field: 'hardRules.lockedSlots', reason: '映射为 fixed_locked 硬约束（绑定 lessonPlan#0）' });
    }

    // teacherUnavailable + teachers[].unavailableSlots 合并去重 → teacher_unavailable
    const teacherSlots = new Map(); // teacherId → Set<slotKey>
    const addSlot = (tid, slotKey, src) => {
        const id = str(tid);
        if (!id) return;
        if (!refs.teacherIds.has(id)) {
            report.dropped({ source: src, field: 'teacher_unavailable.teacherId', reason: '悬空 teacherId，不可用时段无法映射', originalValue: tid });
            return;
        }
        const key = normalizeSlot(slotKey);
        if (!key) {
            report.dropped({ source: src, field: 'teacher_unavailable.slot', reason: '不可用时段 slotKey 非法', originalValue: slotKey });
            return;
        }
        if (!teacherSlots.has(id)) teacherSlots.set(id, new Set());
        teacherSlots.get(id).add(key);
    };
    for (const [tid, list] of Object.entries(hard.teacherUnavailable ?? {})) {
        for (const s of asArray(list)) addSlot(tid, s, `rules.hardRules.teacherUnavailable[${tid}]`);
    }
    for (const [i, t] of asArray(raw.teachers).entries()) {
        for (const s of asArray(t?.unavailableSlots)) addSlot(t?.id, s, `teachers[${i}].unavailableSlots`);
    }
    for (const [tid, set] of teacherSlots) {
        out.push({
            type: 'teacher_unavailable',
            strength: 'hard',
            target: { teacherId: tid },
            params: { slots: [...set] },
            source: { kind: 'legacy-hardrule', text: `teacher_unavailable ${tid}`, ref: 'rules.hardRules.teacherUnavailable+teachers.unavailableSlots' },
        });
        report.kept({ source: `teacher_unavailable[${tid}]`, field: 'hardRules.teacherUnavailable', reason: '合并 teachers.unavailableSlots 去重后映射为 teacher_unavailable 硬约束' });
    }

    // classUnavailable → class_unavailable
    for (const [cid, list] of Object.entries(hard.classUnavailable ?? {})) {
        const src = `rules.hardRules.classUnavailable[${cid}]`;
        if (!refs.classIds.has(str(cid))) {
            report.dropped({ source: src, field: 'class_unavailable.classId', reason: '悬空 classId，不可用时段无法映射', originalValue: cid });
            continue;
        }
        const slots = [...new Set(asArray(list).map(normalizeSlot).filter(Boolean))];
        if (slots.length === 0) continue;
        out.push({
            type: 'class_unavailable',
            strength: 'hard',
            target: { classId: str(cid) },
            params: { slots },
            source: { kind: 'legacy-hardrule', text: `class_unavailable ${cid}`, ref: src },
        });
        report.kept({ source: src, field: 'hardRules.classUnavailable', reason: '映射为 class_unavailable 硬约束' });
    }
}

// ---------------------------------------------------------------------------
// 软规则 rules.softRules → 软约束 DSL 草稿（strength=soft，本阶段不评分）
// ---------------------------------------------------------------------------

function mapSoftRules(raw, refs, report, out) {
    const soft = raw.rules?.softRules ?? {};
    const morningSlots = morningSlotKeys(raw);

    // morningSubjects → subject_preferred_periods（prefer 上午）
    for (const [i, sid] of asArray(soft.morningSubjects).entries()) {
        const src = `rules.softRules.morningSubjects[${i}]`;
        if (!refs.subjectIds.has(str(sid))) {
            report.dropped({ source: src, field: 'softRules.morningSubjects', reason: '悬空 subjectId', originalValue: sid });
            continue;
        }
        out.push(softConstraint('subject_preferred_periods', { subjectId: str(sid) }, { prefer: morningSlots, avoid: [], weight: 50 }, src, 'morningSubjects→上午偏好'));
        report.kept({ source: src, field: 'softRules.morningSubjects', reason: '映射为 subject_preferred_periods 软约束草稿（prefer 上午）' });
    }

    // subjectPreferredPeriods → subject_preferred_periods 直译
    for (const [sid, cfg] of Object.entries(soft.subjectPreferredPeriods ?? {})) {
        const src = `rules.softRules.subjectPreferredPeriods[${sid}]`;
        if (!refs.subjectIds.has(str(sid))) {
            report.dropped({ source: src, field: 'softRules.subjectPreferredPeriods', reason: '悬空 subjectId', originalValue: sid });
            continue;
        }
        const prefer = asArray(cfg?.prefer).map(normalizeSlot).filter(Boolean);
        const avoid = asArray(cfg?.avoid).map(normalizeSlot).filter(Boolean);
        out.push(softConstraint('subject_preferred_periods', { subjectId: str(sid) }, { prefer, avoid, weight: clampInt(cfg?.weight, 20, 0, 100) }, src, 'subjectPreferredPeriods 直译'));
        report.kept({ source: src, field: 'softRules.subjectPreferredPeriods', reason: '直译为 subject_preferred_periods 软约束草稿' });
    }

    // teacherLimits{daily,consecutive} → teacher_limits（Phase 1 单一 type，daily+consecutive 并入 params）
    for (const [tid, cfg] of Object.entries(soft.teacherLimits ?? {})) {
        const src = `rules.softRules.teacherLimits[${tid}]`;
        if (!refs.teacherIds.has(str(tid))) {
            report.dropped({ source: src, field: 'softRules.teacherLimits', reason: '悬空 teacherId', originalValue: tid });
            continue;
        }
        const params = {};
        if (Number.isInteger(cfg?.daily)) params.daily = cfg.daily;
        if (Number.isInteger(cfg?.consecutive)) params.consecutive = cfg.consecutive;
        if (Object.keys(params).length === 0) continue;
        out.push(softConstraint('teacher_limits', { teacherId: str(tid) }, params, src, 'teacherLimits daily/consecutive'));
        report.kept({ source: src, field: 'softRules.teacherLimits', reason: 'daily/consecutive 并入单一 teacher_limits 软约束草稿（Phase 1 无独立 consecutive type）' });
    }

    // spreadSubjects → spread_subjects
    const spread = asArray(soft.spreadSubjects).map(str).filter(id => refs.subjectIds.has(id));
    const spreadDropped = asArray(soft.spreadSubjects).map(str).filter(id => id && !refs.subjectIds.has(id));
    if (spreadDropped.length) {
        report.dropped({ source: 'rules.softRules.spreadSubjects', field: 'softRules.spreadSubjects', reason: '悬空 subjectId 被剔除', originalValue: spreadDropped });
    }
    if (spread.length) {
        out.push(softConstraint('spread_subjects', null, { subjectIds: spread }, 'rules.softRules.spreadSubjects', 'spreadSubjects 一周分散'));
        report.kept({ source: 'rules.softRules.spreadSubjects', field: 'softRules.spreadSubjects', reason: '映射为 spread_subjects 软约束草稿' });
    }

    // balancedTeacherLoad → balanced_teacher_load（开关）
    if (soft.balancedTeacherLoad !== undefined) {
        if (soft.balancedTeacherLoad) {
            out.push(softConstraint('balanced_teacher_load', null, { enabled: true }, 'rules.softRules.balancedTeacherLoad', 'balancedTeacherLoad 开关'));
        }
        report.kept({ source: 'rules.softRules.balancedTeacherLoad', field: 'softRules.balancedTeacherLoad', reason: `映射为 balanced_teacher_load 软约束草稿（enabled=${!!soft.balancedTeacherLoad}）` });
    }
}

// ---------------------------------------------------------------------------
// 课程分类/优先级 → 软约束草稿
// ---------------------------------------------------------------------------

function mapSubjectCategoryDrafts(subjects, raw, report, out) {
    const morning = morningSlotKeys(raw);
    const late = lateSlotKeys(raw);
    const early = earlySlotKeys(raw);

    for (const s of subjects) {
        const weight = clampInt(s.priority, 50, 0, 100);
        const src = `subjects[${s.id}].category`;
        if (s.category === 'main') {
            out.push(softConstraint('subject_preferred_periods', { subjectId: s.id }, { prefer: morning, avoid: [], weight }, src, 'main→上午偏好'));
            report.kept({ source: src, field: 'subject.category(main)', reason: 'main 课程生成上午偏好软约束草稿（priority 作权重）' });
        } else if (s.category === 'lab') {
            out.push(softConstraint('subject_preferred_periods', { subjectId: s.id }, { prefer: late, avoid: early, weight }, src, 'lab→后段节次偏好'));
            report.kept({ source: src, field: 'subject.category(lab)', reason: 'lab 课程生成后段节次偏好软约束草稿（避开早节）' });
        } else {
            report.kept({ source: src, field: `subject.category(${s.category})`, reason: 'quality/normal 默认无强偏好，不生成软约束草稿' });
        }
    }
}

// ---------------------------------------------------------------------------
// raw.periodTimes / raw.term → metadata 旁路 + 迁移报告（V2 schema 不承载）
// ---------------------------------------------------------------------------

/**
 * V2 的 SchoolProjectV2 schema 不承载“节次物理时刻表（periodTimes）”与“学期（term）”，
 * createProject 也不会保留这两个字段。为避免静默丢失，各记一条迁移报告，并把原值留在
 * project.metadata 旁路（仅供诊断 / 回溯，不参与日历编码与求解）。
 * @returns {object|null} metadata（无可留存字段时返回 null）
 */
function mapMetadata(raw, report) {
    const metadata = {};

    // term：并入 metadata 旁路（degraded：V2 不建模学期，仅留痕）。
    const term = str(raw?.term);
    if (term) {
        metadata.term = term;
        report.degraded({
            source: 'term', field: 'project.term',
            reason: 'V2 SchoolProjectV2 不承载学期字段，已并入 project.metadata 旁路（仅供诊断 / 回溯，不参与求解）',
            originalValue: raw.term,
        });
    }

    // periodTimes：V2 日历只编码 day/period 序号、不建模物理时刻，无法承载（dropped），
    // 但非空时仍留存在 metadata 旁路以便回溯。
    const periodTimes = asArray(raw?.periodTimes);
    if (periodTimes.length) {
        metadata.periodTimes = deepClone(periodTimes);
        report.dropped({
            source: 'periodTimes', field: 'project.periodTimes',
            reason: 'V2 日历仅编码 day/period 序号、不承载节次物理时刻表，已丢弃；原值留存于 project.metadata 旁路供回溯',
            originalValue: periodTimes,
        });
    }

    return Object.keys(metadata).length ? metadata : null;
}

// ---------------------------------------------------------------------------
// 发布历史 schedule.published → 只读带入（不递归转换）
// ---------------------------------------------------------------------------

function mapPublishedHistory(schedule, report) {
    const published = schedule?.published;
    if (!published || typeof published !== 'object') return null;

    // 深拷贝，确保只读历史与入参解耦。
    const cloned = deepClone(published);

    // history[] 逐条校验结构；损坏快照降级并剔除。
    if (Array.isArray(cloned.history)) {
        const validHistory = [];
        cloned.history.forEach((h, i) => {
            if (!h || typeof h !== 'object' || !h.snapshot || typeof h.snapshot !== 'object') {
                report.degraded({ source: `schedule.published.history[${i}]`, field: 'published.history', reason: '历史快照结构损坏（缺 snapshot），无法保留', originalValue: h });
                return;
            }
            validHistory.push(h);
            report.kept({ source: `schedule.published.history[${i}]`, field: 'published.history', reason: '历史快照（含 projectContext + slots）原样只读保留，不递归转 V2' });
        });
        cloned.history = validHistory;
    }

    report.kept({ source: 'schedule.published', field: 'published', reason: '发布历史只读带入 V2（保留 status/version/publishedAt/scheduleId/note/fingerprint/snapshot），不参与求解、不被改写' });
    return cloned;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function softConstraint(type, target, params, src, text) {
    return {
        type,
        strength: 'soft',
        target: target ?? null,
        params,
        source: { kind: 'legacy-softrule', text, ref: src },
    };
}

function asArray(v) {
    return Array.isArray(v) ? v : [];
}

function str(v) {
    return String(v ?? '').trim();
}

function num(v) {
    return Number.parseInt(v, 10);
}

function clampInt(value, fallback, min, max) {
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

/** 合并单值 + 列表为去重字符串数组（单值置首）。 */
function mergeIds(single, list) {
    const out = [];
    const push = v => { const id = str(v); if (id && !out.includes(id)) out.push(id); };
    push(single);
    asArray(list).forEach(push);
    return out;
}

/** 按实体集合过滤 id 列表，返回 { kept, dropped }。 */
function resolveIds(ids, validSet) {
    const kept = [];
    const dropped = [];
    for (const id of ids) {
        if (validSet.has(id)) kept.push(id);
        else dropped.push(id);
    }
    return { kept, dropped };
}

/** 规范化 slotKey："day-period"，非法返回 null。 */
function normalizeSlot(v) {
    const s = str(v);
    if (!s) return null;
    try {
        const { day, period } = parseSlotKey(s);
        return toSlotKey(day, period);
    } catch {
        return null;
    }
}

function activePeriodsOf(raw) {
    const list = asArray(raw.activePeriods).map(num).filter(Number.isInteger);
    if (list.length) return [...new Set(list)].sort((a, b) => a - b);
    const ppd = clampInt(raw.periodsPerDay, 7, 1, 12);
    return Array.from({ length: ppd }, (_, i) => i + 1);
}

function activeWeekdaysOf(raw) {
    const list = asArray(raw.activeWeekdays).map(num).filter(Number.isInteger);
    if (list.length) return [...new Set(list)].sort((a, b) => a - b);
    const wd = clampInt(raw.weekdays, 5, 1, 7);
    return Array.from({ length: wd }, (_, i) => i + 1);
}

/** 上午节次（前半）× 全部有效星期 的 slotKey 列表。 */
function morningSlotKeys(raw) {
    const periods = activePeriodsOf(raw);
    const half = Math.ceil(periods.length / 2);
    return slotKeysFor(activeWeekdaysOf(raw), periods.slice(0, half));
}

/** 后段节次（后半）× 全部有效星期。 */
function lateSlotKeys(raw) {
    const periods = activePeriodsOf(raw);
    const half = Math.ceil(periods.length / 2);
    return slotKeysFor(activeWeekdaysOf(raw), periods.slice(half));
}

/** 早段节次（首节）× 全部有效星期。 */
function earlySlotKeys(raw) {
    const periods = activePeriodsOf(raw);
    return slotKeysFor(activeWeekdaysOf(raw), periods.slice(0, 1));
}

function slotKeysFor(days, periods) {
    const out = [];
    for (const p of periods) for (const d of days) out.push(toSlotKey(d, p));
    return out;
}

function deepClone(v) {
    if (typeof structuredClone === 'function') return structuredClone(v);
    return JSON.parse(JSON.stringify(v));
}
