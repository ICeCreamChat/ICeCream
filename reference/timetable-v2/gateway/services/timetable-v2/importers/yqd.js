/**
 * timetable-v2 / importers / yqd.js
 *
 * 已导出的 .yqd 业务表 → 合法 SchoolProjectV2（决策 5：只消费业务表，第一阶段只导入不写回）。
 *
 * 纯读取层：零 IO、零写回、不 mutate 入参。返回 { project, report, raw }。
 *   - project：经 Phase 1 createProject 构造并通过校验的 SchoolProjectV2。
 *   - report ：createMigrationReport('yqd') 收集的四分类迁移报告。
 *   - raw    ：原始业务表对象引用 + 派生的 ruleDrafts / metadata（供诊断 / 回溯），不被改写。
 *
 * 入参 tables 是「已导出的业务表对象」（CSV/business mapping 解析结果），行是普通对象：
 *   banbd(班级) / jibd(年级) / kemubd(课程) / teabd(教师) / renkebd(任课关系，含 heban 合班) /
 *   roombd(教室) / kemujieshu(班课课时) / gudinbd(固定课) / teshuke(课程预排) / teshutea(教师预排) /
 *   PaiOptJie(节限制) / PaiOptDay(日限制) / PaiOpt(主开关) / daybd / jieshu(早中晚节数)。
 *
 * 明确不做：二进制 .yqd 解包（仓外脚本职责）、写回来源。缺表 / 缺字段 → 迁移报告，不崩溃。
 *
 * 仅通过 Phase 1 公开工厂构造 V2（createProject），约束以 DSL 草稿产出（type 用 dsl.js 下划线枚举）。
 * 细粒度规则（PaiOptJie/PaiOptDay）与预排（teshuke/teshutea）按硬 / 软 / 元数据三分类落地，
 * 语义不明或当前 DSL 不支持的进 review，不臆造、不中断。
 */

import { createProject } from '../domain/project.js';
import { toSlotKey } from '../domain/calendar.js';
import { createMigrationReport } from './migration-report.js';

/**
 * 把已导出的 .yqd 业务表导入为 SchoolProjectV2。
 * @param {object} tables 业务表对象（每个键是一张表的行数组）
 * @param {object} [options] { id, name } 项目元信息
 * @returns {{ project: object, report: object, raw: object }}
 */
export function importYqdTables(tables = {}, options = {}) {
    const report = createMigrationReport('yqd');
    const t = tables ?? {};

    // ---- 日历：从 daybd / jieshu + 被引用的 day/period 推导 ----
    const calendarInfo = deriveCalendar(t, report);

    // ---- 实体 ----
    const grades = indexGrades(t.jibd);
    const classes = mapClasses(t.banbd, grades, report);
    const subjects = mapSubjects(t.kemubd, report);
    const teachers = mapTeachers(t.teabd, report);
    const rooms = mapRooms(t.roombd, report);

    const classIds = new Set(classes.map(c => c.id));
    const subjectIds = new Set(subjects.map(s => s.id));
    const teacherIds = new Set(teachers.map(s => s.id));
    const roomIds = new Set(rooms.map(r => r.id));
    const refs = { classIds, subjectIds, teacherIds, roomIds };

    // 课程连堂偏好 / 班课课时查表
    const lianpaiOf = indexLianpai(t.kemubd);
    const sectionOf = indexSections(t.kemujieshu, report);

    // ---- 任课关系 renkebd → ActivityPlan（heban 合班合并多 classIds） ----
    const activityPlans = mapRenke(t.renkebd, refs, lianpaiOf, sectionOf, teachers, report);

    // ---- 约束草稿与元数据 ----
    const constraints = [];
    const ruleDrafts = [];
    const metadata = {};

    mapGudin(t.gudinbd, refs, calendarInfo, report, constraints, ruleDrafts);
    mapTeshuke(t.teshuke, refs, calendarInfo, report, constraints, ruleDrafts);
    mapTeshutea(t.teshutea, refs, calendarInfo, report, constraints, ruleDrafts);
    mapFineRules(t.PaiOptJie, 'PaiOptJie', refs, calendarInfo, report, constraints, ruleDrafts);
    mapFineRules(t.PaiOptDay, 'PaiOptDay', refs, calendarInfo, report, constraints, ruleDrafts);
    mapOptions(t.PaiOpt, report, metadata, ruleDrafts);
    keepSections(sectionOf, metadata, report);

    // ---- 构造并校验 V2 ----
    const project = createProject({
        id: options.id ?? 'yqd_import',
        name: options.name ?? 'YQD 业务表导入',
        calendar: calendarInfo.calendarInput,
        classes,
        teachers,
        subjects,
        rooms,
        activityPlans,
        constraints,
    });

    return { project, report, raw: { tables: t, ruleDrafts, metadata } };
}

// ===========================================================================
// 日历推导
// ===========================================================================

function deriveCalendar(t, report) {
    // 有效星期：daybd.dayid 优先，否则 1..5；并入被引用的 theday。
    const dayIds = asArray(t.daybd).map(r => num(r?.dayid)).filter(d => d >= 1 && d <= 7);
    const refDays = collectRefValues(t, 'theday').filter(d => d >= 1 && d <= 7);
    let activeWeekdays = uniqSorted([...(dayIds.length ? dayIds : [1, 2, 3, 4, 5]), ...refDays]);
    if (activeWeekdays.length === 0) activeWeekdays = [1, 2, 3, 4, 5];

    // 节次：jieshu(mor/aft/nig) 之和优先，否则被引用的最大 thejie，否则 8。
    const js = asArray(t.jieshu)[0] ?? null;
    const mor = num(js?.mor);
    const aft = num(js?.aft);
    const nig = num(js?.nig);
    const segTotal = (mor > 0 ? mor : 0) + (aft > 0 ? aft : 0) + (nig > 0 ? nig : 0);
    const refPeriods = collectRefValues(t, 'thejie').filter(p => p >= 1 && p <= 12);
    const maxRefPeriod = refPeriods.length ? Math.max(...refPeriods) : 0;
    let periodsPerDay = Math.max(segTotal, maxRefPeriod, 0);
    if (periodsPerDay <= 0) periodsPerDay = 8;
    periodsPerDay = Math.min(12, periodsPerDay);
    const activePeriods = Array.from({ length: periodsPerDay }, (_, i) => i + 1);

    // 早中晚分段（供 theJie 101/102/103 解析）
    let segments;
    if (segTotal > 0) {
        segments = buildSegments(mor, aft, nig, periodsPerDay);
    } else {
        const half = Math.ceil(periodsPerDay / 2);
        segments = {
            101: activePeriods.slice(0, half),
            102: activePeriods.slice(half),
            103: [],
        };
    }

    report.kept({
        source: 'daybd/jieshu',
        field: 'calendar',
        reason: `推导日历：activeWeekdays=[${activeWeekdays.join(',')}]，periodsPerDay=${periodsPerDay}`,
    });

    return {
        activeWeekdays,
        activePeriods,
        segments,
        calendarInput: { activeWeekdays, activePeriods },
    };
}

function buildSegments(mor, aft, nig, periodsPerDay) {
    const out = { 101: [], 102: [], 103: [] };
    let p = 1;
    for (let i = 0; i < Math.max(0, mor) && p <= periodsPerDay; i++, p++) out[101].push(p);
    for (let i = 0; i < Math.max(0, aft) && p <= periodsPerDay; i++, p++) out[102].push(p);
    for (let i = 0; i < Math.max(0, nig) && p <= periodsPerDay; i++, p++) out[103].push(p);
    return out;
}

function collectRefValues(t, field) {
    const out = [];
    for (const name of ['gudinbd', 'teshuke', 'teshutea', 'PaiOptJie', 'PaiOptDay']) {
        for (const row of asArray(t[name])) {
            const v = num(row?.[field]);
            if (Number.isInteger(v)) out.push(v);
        }
    }
    return out;
}

// ===========================================================================
// 实体映射：banbd/jibd → classes，kemubd → subjects，teabd → teachers，roombd → rooms
// ===========================================================================

function indexGrades(jibd) {
    const map = new Map();
    for (const r of asArray(jibd)) {
        const id = str(r?.jiid);
        if (id) map.set(id, str(r?.jiname));
    }
    return map;
}

function mapClasses(banbd, grades, report) {
    const out = [];
    for (const [i, c] of asArray(banbd).entries()) {
        const id = str(c?.banid);
        if (!id) {
            report.dropped({ source: `banbd[${i}]`, field: 'banbd.banid', reason: '缺少 banid，无法构造 V2 班级', originalValue: c });
            continue;
        }
        out.push({ id, name: str(c?.banname) || id, grade: grades.get(str(c?.jiid)) ?? str(c?.jiid) });
        report.kept({ source: `banbd[${i}]`, field: 'class', reason: '直译为 V2 班级实体（jiid→grade）' });
    }
    return out;
}

function mapSubjects(kemubd, report) {
    const out = [];
    for (const [i, s] of asArray(kemubd).entries()) {
        const id = str(s?.kemuid);
        if (!id) {
            report.dropped({ source: `kemubd[${i}]`, field: 'kemubd.kemuid', reason: '缺少 kemuid，无法构造 V2 课程', originalValue: s });
            continue;
        }
        const name = str(s?.kemuname) || id;
        out.push({
            id,
            name,
            category: inferCategory(name),
            priority: 50,
            tags: [],
        });
        report.kept({ source: `kemubd[${i}]`, field: 'subject', reason: '直译为 V2 课程实体（kemuname→name，类别按名称推断）' });
    }
    return out;
}

function mapTeachers(teabd, report) {
    const out = [];
    for (const [i, tr] of asArray(teabd).entries()) {
        const id = str(tr?.teaid);
        if (!id) {
            report.dropped({ source: `teabd[${i}]`, field: 'teabd.teaid', reason: '缺少 teaid，无法构造 V2 教师', originalValue: tr });
            continue;
        }
        out.push({ id, name: str(tr?.teaname) || id, subjects: [] });
        report.kept({ source: `teabd[${i}]`, field: 'teacher', reason: '直译为 V2 教师实体（subjects 由 renkebd 回填）' });
    }
    return out;
}

function mapRooms(roombd, report) {
    const out = [];
    for (const [i, r] of asArray(roombd).entries()) {
        const id = str(r?.roomid);
        if (!id) {
            report.dropped({ source: `roombd[${i}]`, field: 'roombd.roomid', reason: '缺少 roomid，无法构造 V2 教室', originalValue: r });
            continue;
        }
        const capacity = num(r?.roomsize);
        out.push({ id, name: str(r?.roomname) || id, capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : null });
        report.kept({ source: `roombd[${i}]`, field: 'room', reason: '直译为 V2 教室实体' });
    }
    return out;
}

/** kemubd.lianpai>0 → 连堂偏好 'double'，否则 'single'。 */
function indexLianpai(kemubd) {
    const map = new Map();
    for (const s of asArray(kemubd)) {
        const id = str(s?.kemuid);
        if (id) map.set(id, num(s?.lianpai) > 0 ? 'double' : 'single');
    }
    return map;
}

/** kemujieshu(班课课时)：key `kemuid|banid` → jieshu，作为学期级元数据保留。 */
function indexSections(kemujieshu, report) {
    const map = new Map();
    for (const [i, r] of asArray(kemujieshu).entries()) {
        const kemuid = str(r?.kemuid);
        const banid = str(r?.banid);
        const jieshu = num(r?.jieshu);
        if (!kemuid || !banid) {
            report.dropped({ source: `kemujieshu[${i}]`, field: 'kemujieshu', reason: '缺 kemuid/banid，班课课时无法定位', originalValue: r });
            continue;
        }
        map.set(`${kemuid}|${banid}`, jieshu);
    }
    return map;
}

function keepSections(sectionOf, metadata, report) {
    if (sectionOf.size === 0) return;
    metadata.classCourseSections = Object.fromEntries(sectionOf);
    report.kept({ source: 'kemujieshu', field: 'classCourseSections', reason: `班课课时（${sectionOf.size} 条）作为学期级元数据保留，周课时以 renkebd.jieshu 为准` });
}

// ===========================================================================
// 任课关系 renkebd → ActivityPlan（teacher↔class↔subject 绑定，heban>0 合班）
// ===========================================================================

function mapRenke(renkebd, refs, lianpaiOf, sectionOf, teachers, report) {
    const teacherById = new Map(teachers.map(tr => [tr.id, tr]));
    const out = [];
    const hebanGroups = new Map(); // heban → { rows:[{row,i}] }

    for (const [i, r] of asArray(renkebd).entries()) {
        const src = `renkebd[${i}]`;
        const teaid = str(r?.teaid);
        const banid = str(r?.banid);
        const keid = str(r?.keid);
        const jieshu = num(r?.jieshu);
        const heban = num(r?.heban);

        if (!keid || !refs.subjectIds.has(keid)) {
            report.dropped({ source: src, field: 'renkebd.keid', reason: '悬空或缺失课程 keid，无法映射为 ActivityPlan', originalValue: r?.keid });
            continue;
        }
        if (!banid || !refs.classIds.has(banid)) {
            report.dropped({ source: src, field: 'renkebd.banid', reason: '悬空或缺失班级 banid，无法映射为 ActivityPlan', originalValue: r?.banid });
            continue;
        }
        if (!teaid || !refs.teacherIds.has(teaid)) {
            report.dropped({ source: src, field: 'renkebd.teaid', reason: '悬空或缺失教师 teaid，无法映射为 ActivityPlan', originalValue: r?.teaid });
            continue;
        }
        if (!Number.isInteger(jieshu) || jieshu <= 0) {
            report.dropped({ source: src, field: 'renkebd.jieshu', reason: 'jieshu 非正整数，无法映射为可排活动', originalValue: r?.jieshu });
            continue;
        }

        // 回填教师任教课程
        const teacher = teacherById.get(teaid);
        if (teacher && !teacher.subjects.includes(keid)) teacher.subjects.push(keid);

        if (heban > 0) {
            if (!hebanGroups.has(heban)) hebanGroups.set(heban, []);
            hebanGroups.get(heban).push({ r, i, teaid, banid, keid, jieshu });
            continue;
        }

        out.push({
            id: `rk_${i}`,
            classIds: [banid],
            subjectId: keid,
            teacherIds: [teaid],
            weeklyUnits: jieshu,
            durationPattern: lianpaiOf.get(keid) ?? 'single',
            roomRequirements: [],
            priority: 50,
        });
        report.kept({ source: src, field: 'renkebd', reason: '映射为 V2 ActivityPlan（teacher↔class↔subject，jieshu→weeklyUnits）' });
    }

    // heban 合班：同组首行 teacher/keid/jieshu 为准，合并所有 classIds（决策：组内同师同课同时段）
    for (const [heban, members] of hebanGroups) {
        const src = `renkebd[heban=${heban}]`;
        const head = members[0];
        const classIdsSet = [];
        for (const m of members) if (!classIdsSet.includes(m.banid)) classIdsSet.push(m.banid);

        out.push({
            id: `rk_heban_${heban}`,
            classIds: classIdsSet,
            subjectId: head.keid,
            teacherIds: [head.teaid],
            weeklyUnits: head.jieshu,
            durationPattern: lianpaiOf.get(head.keid) ?? 'single',
            roomRequirements: [],
            priority: 50,
        });
        report.kept({
            source: src,
            field: 'renkebd.heban',
            reason: `合班组（${members.length} 个班）合并为单个多 classIds ActivityPlan（同师同课同时段）`,
        });
    }

    return out;
}

// ===========================================================================
// 固定课 gudinbd → class_unavailable 硬约束（固定占用格，非可排课程）
// ===========================================================================

function mapGudin(gudinbd, refs, cal, report, constraints, ruleDrafts) {
    // 按班级聚合不可用 slot
    const byClass = new Map(); // banid → Set<slotKey>
    for (const [i, g] of asArray(gudinbd).entries()) {
        const src = `gudinbd[${i}]`;
        const banid = str(g?.theban);
        const day = num(g?.theday);
        const period = num(g?.thejie);
        if (!banid || !refs.classIds.has(banid)) {
            report.dropped({ source: src, field: 'gudinbd.theban', reason: '悬空或缺失班级 theban，固定课无法映射', originalValue: g?.theban });
            continue;
        }
        if (!cal.activeWeekdays.includes(day) || !cal.activePeriods.includes(period)) {
            report.dropped({ source: src, field: 'gudinbd.time', reason: `固定课时间 ${day}-${period} 不在有效日期/节次内`, originalValue: { theday: g?.theday, thejie: g?.thejie } });
            continue;
        }
        const slot = toSlotKey(day, period);
        if (!byClass.has(banid)) byClass.set(banid, new Set());
        byClass.get(banid).add(slot);
        ruleDrafts.push({ source: src, table: 'gudinbd', classification: 'hard', target: { classId: banid }, slot, name: str(g?.gudinname) });
    }
    for (const [banid, set] of byClass) {
        constraints.push({
            type: 'class_unavailable',
            strength: 'hard',
            target: { classId: banid },
            params: { slots: [...set] },
            source: { kind: 'yqd-gudin', text: `gudinbd 固定课占用 班级 ${banid}`, ref: 'gudinbd' },
        });
        report.kept({ source: `gudinbd[class=${banid}]`, field: 'gudinbd', reason: `固定课映射为 class_unavailable 硬约束（占用 ${set.size} 格不可排）` });
    }
}

// ===========================================================================
// 预排 teshuke(课程/班级) / teshutea(教师)：status 1 弱 / 2 强 / 3 硬禁，三分类
// ===========================================================================

function mapTeshuke(teshuke, refs, cal, report, constraints, ruleDrafts) {
    for (const [i, p] of asArray(teshuke).entries()) {
        const src = `teshuke[${i}]`;
        const kemuid = str(p?.kemuid);
        const banid = str(p?.banid);
        const day = num(p?.theday);
        const period = num(p?.thejie);
        const status = num(p?.teshu);

        if (!kemuid || !refs.subjectIds.has(kemuid)) {
            report.dropped({ source: src, field: 'teshuke.kemuid', reason: '悬空或缺失课程 kemuid，预排无法映射', originalValue: p?.kemuid });
            continue;
        }
        // banid=0/缺 表示 all-class 默认行；非 0 须存在
        const allClass = !banid || banid === '0';
        if (!allClass && !refs.classIds.has(banid)) {
            report.dropped({ source: src, field: 'teshuke.banid', reason: '悬空班级 banid，预排无法映射', originalValue: p?.banid });
            continue;
        }
        if (!cal.activeWeekdays.includes(day) || !cal.activePeriods.includes(period)) {
            report.dropped({ source: src, field: 'teshuke.time', reason: `预排时间 ${day}-${period} 不在有效日期/节次内`, originalValue: { theday: p?.theday, thejie: p?.thejie } });
            continue;
        }
        const slot = toSlotKey(day, period);

        if (status === 3) {
            // 硬禁：课程@班级@时段。V2 无「课程在某班某时段禁排」硬 type（class_unavailable 会误伤全班）→ review。
            ruleDrafts.push({ source: src, table: 'teshuke', classification: 'review', target: { subjectId: kemuid, classId: allClass ? 'ALL' : banid }, slot, status });
            report.review({ source: src, field: 'teshuke.status3', reason: '课程级硬禁排（kemuid@banid@slot）当前 V2 无对应硬 type（class_unavailable 会误伤全班其他课），需人工复核', originalValue: { kemuid, banid, slot } });
        } else if (status === 1 || status === 2) {
            // 软偏好：映射为 subject_preferred_periods（prefer 该 slot）。班级粒度丢失 → degraded 标注。
            constraints.push(softConstraint('subject_preferred_periods', { subjectId: kemuid }, { prefer: [slot], avoid: [], weight: status === 2 ? 80 : 30 }, src, `teshuke status=${status} 课程预排偏好`, 'yqd-teshuke'));
            report.kept({ source: src, field: 'teshuke.softPreset', reason: `课程预排（status=${status}）映射为 subject_preferred_periods 软约束草稿（prefer ${slot}）` });
            if (!allClass) {
                report.degraded({ source: src, field: 'teshuke.classScope', reason: '软偏好降级为课程级（V2 subject_preferred_periods 无班级粒度），原班级范围记录待复核', originalValue: { banid } });
            }
            ruleDrafts.push({ source: src, table: 'teshuke', classification: 'soft', target: { subjectId: kemuid, classId: allClass ? 'ALL' : banid }, slot, status });
        } else {
            report.dropped({ source: src, field: 'teshuke.teshu', reason: `未知预排 status=${status}（应为 1/2/3）`, originalValue: p?.teshu });
        }
    }
}

function mapTeshutea(teshutea, refs, cal, report, constraints, ruleDrafts) {
    const hardByTeacher = new Map(); // teaid → Set<slot>
    for (const [i, p] of asArray(teshutea).entries()) {
        const src = `teshutea[${i}]`;
        const teaid = str(p?.teaid);
        const day = num(p?.theday);
        const period = num(p?.thejie);
        const status = num(p?.teshu);

        if (!teaid || !refs.teacherIds.has(teaid)) {
            report.dropped({ source: src, field: 'teshutea.teaid', reason: '悬空或缺失教师 teaid，预排无法映射', originalValue: p?.teaid });
            continue;
        }
        if (!cal.activeWeekdays.includes(day) || !cal.activePeriods.includes(period)) {
            report.dropped({ source: src, field: 'teshutea.time', reason: `预排时间 ${day}-${period} 不在有效日期/节次内`, originalValue: { theday: p?.theday, thejie: p?.thejie } });
            continue;
        }
        const slot = toSlotKey(day, period);

        if (status === 3) {
            // 教师硬禁排 → teacher_unavailable 硬约束
            if (!hardByTeacher.has(teaid)) hardByTeacher.set(teaid, new Set());
            hardByTeacher.get(teaid).add(slot);
            ruleDrafts.push({ source: src, table: 'teshutea', classification: 'hard', target: { teacherId: teaid }, slot, status });
        } else if (status === 1 || status === 2) {
            // 教师软偏好：V2 无 teacher_preferred_periods 软 type → review，不臆造。
            ruleDrafts.push({ source: src, table: 'teshutea', classification: 'review', target: { teacherId: teaid }, slot, status });
            report.review({ source: src, field: 'teshutea.softPreset', reason: `教师软偏好（status=${status}）当前 V2 无 teacher_preferred_periods 软 type，需人工复核`, originalValue: { teaid, slot, status } });
        } else {
            report.dropped({ source: src, field: 'teshutea.teshu', reason: `未知预排 status=${status}（应为 1/2/3）`, originalValue: p?.teshu });
        }
    }
    for (const [teaid, set] of hardByTeacher) {
        constraints.push({
            type: 'teacher_unavailable',
            strength: 'hard',
            target: { teacherId: teaid },
            params: { slots: [...set] },
            source: { kind: 'yqd-teshutea', text: `teshutea status=3 教师硬禁排 ${teaid}`, ref: 'teshutea' },
        });
        report.kept({ source: `teshutea[tea=${teaid}]`, field: 'teshutea.status3', reason: `教师硬禁排映射为 teacher_unavailable 硬约束（${set.size} 个时段）` });
    }
}

// ===========================================================================
// 细粒度日/节限制 PaiOptJie / PaiOptDay → 水晶风格规则草稿，硬/软/元数据三分类
//   theNum 编码（frmpaiopt_rule_mapping）：
//     正 1..      固定恰好 n（n=theNum-1）        → 软（计数约束）
//     负          上限至多 n                       → 软
//     >1000       下限至少 n（n=theNum-1000）       → 软
//     ==1000      硬禁排                            → 硬（仅教师可直译，余进 review）
// ===========================================================================

function decodeTheNum(theNum) {
    const v = num(theNum);
    if (!Number.isInteger(v)) return { mode: 'unknown', hard: false };
    if (v === 1000) return { mode: 'forbidden', hard: true };
    if (v > 1000) return { mode: 'min', hard: false, n: v - 1000 };
    if (v < 0) return { mode: 'max', hard: false, n: -v - 1 };
    if (v >= 1) return { mode: 'fixed', hard: false, n: v - 1 };
    return { mode: 'unknown', hard: false };
}

/** theJie/theDay → 具体节次数组（101/102/103 段，0/缺=每节，1..N 具体节）。 */
function resolveJie(theJie, cal) {
    const v = num(theJie);
    if (v === 101 || v === 102 || v === 103) return cal.segments[v] ?? [];
    if (v >= 1 && cal.activePeriods.includes(v)) return [v];
    if (!Number.isInteger(v) || v === 0) return [...cal.activePeriods]; // 每节
    return [];
}

function resolveDay(theDay, cal) {
    const v = num(theDay);
    if (v >= 1 && cal.activeWeekdays.includes(v)) return [v];
    if (!Number.isInteger(v) || v === 0) return [...cal.activeWeekdays]; // 每天
    return [];
}

function mapFineRules(table, tableName, refs, cal, report, constraints, ruleDrafts) {
    for (const [i, row] of asArray(table).entries()) {
        const src = `${tableName}[${i}]`;
        const decoded = decodeTheNum(row?.theNum);
        const teaid = str(row?.TeaId);
        const banid = str(row?.BanId);
        const keid = str(row?.KeId);

        // 解析受限的 (day, period) 集合
        const days = tableName === 'PaiOptDay' ? resolveDay(row?.theDay, cal) : [...cal.activeWeekdays];
        const periods = tableName === 'PaiOptJie' ? resolveJie(row?.theJie, cal) : [...cal.activePeriods];
        const slots = [];
        for (const d of days) for (const p of periods) slots.push(toSlotKey(d, p));

        const target = teaid ? { teacherId: teaid } : { classId: banid || null, subjectId: keid || null };

        if (decoded.mode === 'unknown') {
            report.review({ source: src, field: `${tableName}.theNum`, reason: 'theNum 编码无法解码，语义不明，需人工复核', originalValue: row?.theNum });
            ruleDrafts.push({ source: src, table: tableName, classification: 'review', target, mode: 'unknown' });
            continue;
        }
        if (slots.length === 0) {
            report.dropped({ source: src, field: `${tableName}.time`, reason: '规则时间范围解析为空（day/period 越界或无效）', originalValue: { theDay: row?.theDay, theJie: row?.theJie } });
            continue;
        }

        if (decoded.hard) {
            // 硬禁排：仅「教师整段禁排」可无损直译为 teacher_unavailable；
            // 课程@班级 的禁排无对应硬 type（会误伤全班其他课）→ review。
            if (teaid && refs.teacherIds.has(teaid)) {
                constraints.push({
                    type: 'teacher_unavailable',
                    strength: 'hard',
                    target: { teacherId: teaid },
                    params: { slots },
                    source: { kind: `yqd-${tableName}`, text: `${tableName} 硬禁排 教师 ${teaid}`, ref: src },
                });
                report.kept({ source: src, field: `${tableName}.hardForbid`, reason: `教师硬禁排映射为 teacher_unavailable 硬约束（${slots.length} 个时段）` });
                ruleDrafts.push({ source: src, table: tableName, classification: 'hard', target, slots });
            } else {
                report.review({ source: src, field: `${tableName}.hardForbid`, reason: '课程/班级级硬禁排（非教师）当前 V2 无对应硬 type，需人工复核', originalValue: { banid, keid, mode: decoded.mode } });
                ruleDrafts.push({ source: src, table: tableName, classification: 'review', target, slots, mode: decoded.mode });
            }
            continue;
        }

        // 软计数约束（fixed/max/min）：V2 无「节次计数上下限」软 type → 草稿 + review，不臆造硬映射。
        report.review({ source: src, field: `${tableName}.${decoded.mode}`, reason: `计数型软约束（${decoded.mode} n=${decoded.n}）当前 V2 软 type 未覆盖节次计数上下限，保留草稿待 Phase 2 扩展`, originalValue: row?.theNum });
        ruleDrafts.push({ source: src, table: tableName, classification: 'soft', target, slots, mode: decoded.mode, n: decoded.n });
    }
}

// ===========================================================================
// PaiOpt 五开关 → 导入元数据（保留 item/value/mode 原值，纯运行态不转约束）
// ===========================================================================

function mapOptions(paiOpt, report, metadata, ruleDrafts) {
    const rows = asArray(paiOpt);
    if (rows.length === 0) return;
    const opts = rows.map(r => ({ item: r?.item ?? null, value: r?.value ?? null, mode: r?.mode ?? null }));
    metadata.options = opts;
    report.kept({ source: 'PaiOpt', field: 'options', reason: `PaiOpt 全局开关（${opts.length} 项）作为导入元数据保留（item/value/mode），纯运行态不转约束` });
    for (const [i, o] of opts.entries()) {
        ruleDrafts.push({ source: `PaiOpt[${i}]`, table: 'PaiOpt', classification: 'meta', target: null, item: o.item, value: o.value, mode: o.mode });
    }
}

// ===========================================================================
// helpers
// ===========================================================================

function softConstraint(type, target, params, src, text, kind) {
    return {
        type,
        strength: 'soft',
        target: target ?? null,
        params,
        source: { kind: kind ?? 'yqd', text, ref: src },
    };
}

function inferCategory(name = '') {
    const text = String(name ?? '');
    if (/语文|数学|英语|外语|chinese|math|english/i.test(text)) return 'main';
    if (/体育|音乐|美术|劳动|信息|品德|综合|艺术/i.test(text)) return 'quality';
    if (/实验|lab/i.test(text)) return 'lab';
    return 'normal';
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

function uniqSorted(list) {
    return [...new Set(list)].sort((a, b) => a - b);
}




