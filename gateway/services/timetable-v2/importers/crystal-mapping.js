/**
 * timetable-v2 / importers / crystal-mapping.js
 *
 * 水晶 cloneSeed / business mapping → SchoolProjectV2（Phase 3）。
 *
 * 纯函数读取层：接收已规范化的 cloneSeed 对象（schema=icecream-scheduler-clone-seed,
 * schemaVersion=1，契约见 reverse_work/clone_seed_schema.md），零 IO、零写回。
 *
 * 规则三分类（design 决策 4）：
 *   - hardForbids、preset status=3 → 硬约束 DSL
 *   - 软上下限(max/min)、preset status 1/2、PaiOpt 软开关 → 软约束草稿（strength=soft，本阶段不评分）
 *   - 纯运行态开关 → 导入元数据（report kept + project.metadata）
 *   - 语义不明 / 当前不支持 → report review（不报错中断、不臆造）
 *
 * 只通过 Phase 1 公开工厂构造 V2，不旁路拼对象。
 */

import { createProject } from '../domain/project.js';
import { SUBJECT_CATEGORIES } from '../domain/subject.js';
import { createMigrationReport } from './migration-report.js';

const SCHEMA = 'icecream-scheduler-clone-seed';
const SCHEMA_VERSION = 1;
const PALETTE = ['#14b8a6', '#60a5fa', '#f59e0b', '#f97316', '#a78bfa', '#22c55e', '#ef4444', '#06b6d4'];

function cleanText(value, max = 80) {
    return String(value ?? '')
        .replace(/[\x00-\x1F\x7F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function asArray(v) {
    return Array.isArray(v) ? v : [];
}

function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value ?? '')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function makeId(prefix, value) {
    const text = cleanText(value, 80);
    const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `${prefix}_${ascii || stableHash(text)}`;
}

function inferCategory(name = '') {
    const t = cleanText(name, 40).toLowerCase();
    if (/语文|数学|英语|外语|chinese|math|english/.test(t)) return 'main';
    if (/实验|lab/.test(t)) return 'lab';
    if (/体育|音乐|美术|劳动|信息|艺体|pe|music|art/.test(t)) return 'quality';
    return 'normal';
}

function defaultPriority(category) {
    if (category === 'main') return 95;
    if (category === 'lab') return 60;
    if (category === 'quality') return 35;
    return 50;
}

/**
 * 把水晶 cloneSeed 导入为 SchoolProjectV2。
 * @param {object} cloneSeed 规范化的 cloneSeed（schema=icecream-scheduler-clone-seed, schemaVersion=1）
 * @param {object} [options] { id, name }
 * @returns {{ project: object, report: object, raw: any }}
 */
export function importCrystalCloneSeed(cloneSeed, options = {}) {
    if (!cloneSeed || typeof cloneSeed !== 'object') {
        throw new Error('crystal-mapping: cloneSeed 必须是对象');
    }
    if (cloneSeed.schema !== SCHEMA) {
        throw new Error(`crystal-mapping: schema 不符，期望 "${SCHEMA}"，收到 "${cloneSeed.schema}"`);
    }
    if (Number(cloneSeed.schemaVersion) !== SCHEMA_VERSION) {
        throw new Error(`crystal-mapping: schemaVersion 不符，期望 ${SCHEMA_VERSION}，收到 "${cloneSeed.schemaVersion}"`);
    }

    const report = createMigrationReport('crystal');
    const constraints = [];
    const metadata = { crystalOptions: [] };

    // ---- classes：selectedClassIds + keJie.classGroups ----
    const classes = new Map();
    const classGroups = asArray(cloneSeed.keJie?.classGroups);
    const groupNameById = new Map();
    for (const g of classGroups) {
        const gid = g?.id ?? g?.groupId ?? g?.classId;
        if (gid != null) groupNameById.set(String(gid), cleanText(g.name ?? g.groupName ?? gid, 40));
    }
    for (const cid of asArray(cloneSeed.selectedClassIds)) {
        const id = makeId('c', cid);
        if (!classes.has(id)) {
            classes.set(id, { id, name: groupNameById.get(String(cid)) || `班级${cid}`, grade: '默认年级' });
        }
    }
    function classRef(rawId) {
        const id = makeId('c', rawId);
        if (!classes.has(id)) classes.set(id, { id, name: `班级${rawId}`, grade: '默认年级' });
        return id;
    }

    // ---- subjects：courses(kemubd) ----
    const subjects = new Map();
    // 课程级连堂 / 固定教室（kemubd.lianpai / kemubd.roomid），延后到 rooms 建好后解析教室。
    const courseDuration = new Map(); // subjectId → durationPattern（仅 lianpai>0 时记 'double'）
    const courseRoomRaw = new Map();  // subjectId → 原始 roomid（待解析）
    for (const c of asArray(cloneSeed.courses)) {
        const rawId = c?.id ?? c?.kemuId ?? c?.courseId;
        if (rawId == null) { report.dropped({ source: { table: 'courses' }, field: 'course.id', reason: '课程缺 id', originalValue: c }); continue; }
        const id = makeId('s', rawId);
        const name = cleanText(c.name ?? c.kemuName ?? rawId, 40);
        const category = inferCategory(name);
        if (!subjects.has(id)) {
            subjects.set(id, {
                id, name, category: SUBJECT_CATEGORIES.includes(category) ? category : 'normal',
                priority: defaultPriority(category), tags: [], color: PALETTE[subjects.size % PALETTE.length],
            });
        }
        // M-5：课程带连堂 → durationPattern=double（对齐 yqd lianpai>0 逻辑）
        const lianpai = Number(c?.lianpai ?? c?.lianpaiNum ?? c?.lianpaiCount);
        if (Number.isFinite(lianpai) && lianpai > 0) {
            courseDuration.set(id, 'double');
            report.kept({ source: { table: 'courses', optId: rawId }, field: 'course.lianpai', reason: `连堂(lianpai=${lianpai}) → durationPattern=double` });
        }
        // M-5：课程带固定教室 → 暂存原始 roomid，待 rooms 建好后解析
        const roomRaw = c?.roomid ?? c?.roomId;
        if (roomRaw != null && Number(roomRaw) !== 0) {
            courseRoomRaw.set(id, roomRaw);
        }
    }
    function subjectRef(rawId) {
        const id = makeId('s', rawId);
        if (!subjects.has(id)) {
            subjects.set(id, { id, name: `课程${rawId}`, category: 'normal', priority: 50, tags: [], color: PALETTE[subjects.size % PALETTE.length] });
        }
        return id;
    }

    // ---- rooms：rooms(roombd) ----
    const rooms = new Map();
    for (const r of asArray(cloneSeed.rooms)) {
        const rawId = r?.id ?? r?.roomId ?? r?.roomnum;
        if (rawId == null) continue;
        const id = makeId('r', rawId);
        if (!rooms.has(id)) rooms.set(id, { id, name: cleanText(r.name ?? r.roomName ?? rawId, 40), capacity: Number(r.capacity ?? r.roomsize) || undefined });
    }

    // M-5：把课程固定教室原始 id 解析为 V2 roomId（教室存在才落 roomRequirements，否则报告）。
    const courseRoom = new Map(); // subjectId → V2 roomId
    for (const [subjectId, roomRaw] of courseRoomRaw) {
        const roomId = makeId('r', roomRaw);
        if (rooms.has(roomId)) {
            courseRoom.set(subjectId, roomId);
            report.kept({ source: { table: 'courses', optId: roomRaw }, field: 'course.roomid', reason: `固定教室(roomid=${roomRaw}) → roomRequirements` });
        } else {
            report.review({ source: { table: 'courses', optId: roomRaw }, field: 'course.roomid', reason: '课程固定教室 roomid 在 rooms 表中不存在，无法落 roomRequirements，待复核', originalValue: roomRaw });
        }
    }

    // ---- teachers：从 sections / relationGroups 推导（cloneSeed 无独立教师表时兜底）----
    const teachers = new Map();
    function teacherRef(rawId) {
        const id = makeId('t', rawId);
        if (!teachers.has(id)) teachers.set(id, { id, name: `教师${rawId}`, subjects: [] });
        return id;
    }

    // ---- ActivityPlan：classCourseSections(kemujieshu) ----
    const plans = [];
    let planSeq = 0;
    for (const sec of asArray(cloneSeed.classCourseSections)) {
        const classRaw = sec?.classId ?? sec?.banId ?? sec?.banid;
        const courseRaw = sec?.courseId ?? sec?.kemuId ?? sec?.keid;
        const teacherRaw = sec?.teacherId ?? sec?.teaId ?? sec?.teaid;
        const units = Number(sec?.sections ?? sec?.jieshu ?? sec?.weeklyHours);
        if (classRaw == null || courseRaw == null || !Number.isInteger(units) || units <= 0) {
            report.dropped({ source: { table: 'classCourseSections' }, field: 'section', reason: '缺班级/课程/课时或课时非正', originalValue: sec });
            continue;
        }
        const subjectId = subjectRef(courseRaw);
        const teacherId = teacherRaw != null ? teacherRef(teacherRaw) : teacherRef(`auto_${courseRaw}`);
        plans.push({
            id: makeId('ap', `${classRaw}-${courseRaw}-${planSeq++}`),
            classIds: [classRef(classRaw)],
            subjectId,
            teacherIds: [teacherId],
            weeklyUnits: units,
            durationPattern: courseDuration.get(subjectId) ?? 'single',
            roomRequirements: courseRoom.has(subjectId) ? [courseRoom.get(subjectId)] : [],
        });
    }

    // ---- relationGroups(heban) → 合班 ActivityPlan（多 classIds）----
    for (const g of asArray(cloneSeed.relationGroups)) {
        const memberClasses = asArray(g?.classIds ?? g?.members ?? g?.classes).map(classRef);
        const courseRaw = g?.courseId ?? g?.kemuId ?? g?.keid;
        const teacherRaw = g?.teacherId ?? g?.teaId ?? g?.teaid;
        const units = Number(g?.sections ?? g?.jieshu ?? g?.weeklyHours) || 1;
        if (memberClasses.length === 0 || courseRaw == null) {
            report.review({ source: { table: 'relationGroups' }, field: 'relationGroup', reason: '合班组缺成员班级或课程，无法构造合班活动', originalValue: g });
            continue;
        }
        plans.push({
            id: makeId('ap', `heban-${courseRaw}-${planSeq++}`),
            classIds: [...new Set(memberClasses)],
            subjectId: subjectRef(courseRaw),
            teacherIds: [teacherRaw != null ? teacherRef(teacherRaw) : teacherRef(`auto_${courseRaw}`)],
            weeklyUnits: units,
            durationPattern: courseDuration.get(subjectRef(courseRaw)) ?? 'single',
            roomRequirements: courseRoom.has(subjectRef(courseRaw)) ? [courseRoom.get(subjectRef(courseRaw))] : [],
        });
        report.kept({ source: { table: 'relationGroups' }, field: 'relationGroup', reason: `合班组 → ${memberClasses.length} 班级活动` });
    }

    // ---- 规则三分类 ----
    let cSeq = 0;
    const nextCid = (type) => `${type}_crystal_${cSeq++}`;

    // 硬：constraints.hardForbids → 教师维度落 teacher_unavailable；课程@班级维度进 review（对齐 yqd）
    for (const hf of asArray(cloneSeed.constraints?.hardForbids)) {
        const src = { table: 'constraints.hardForbids', optId: hf?.optId };
        if (hf?.target === 'teacher' && hf?.teacherId != null) {
            constraints.push({ id: nextCid('teacher_unavailable'), type: 'teacher_unavailable', target: { teacherId: teacherRef(hf.teacherId) }, params: { slots: slotsOf(hf) }, source: { kind: 'crystal', text: 'hardForbid teacher', ref: src } });
            report.kept({ source: src, field: 'hardForbid', reason: '→ teacher_unavailable(hard)' });
        } else if (hf?.target === 'classCourse' && hf?.classId != null) {
            // M-2：课程@班级维度硬禁。class_unavailable 会误伤该班其他课，无精确 V2 对应，路由 review（对齐 yqd）。
            report.review({ source: src, field: 'hardForbid', reason: '课程@班级维度硬禁，class_unavailable 会误伤该班其他课，无精确 V2 对应，待支持', originalValue: hf });
        } else {
            report.review({ source: src, field: 'hardForbid', reason: '硬禁规则 target/字段不明，无对应 V2 硬约束', originalValue: hf });
        }
    }

    // 软上下限：periodRules/dayRules 的 max/min → subject_preferred_periods 草稿（按 target）
    for (const tableName of ['periodRules', 'dayRules']) {
        for (const rule of asArray(cloneSeed.constraints?.[tableName])) {
            const src = { table: `constraints.${tableName}`, optId: rule?.optId };
            const mode = rule?.limit?.mode ?? rule?.limit;
            if (rule?.limit?.hard) {
                // 已在 hardForbids 镜像；此处仅记元数据避免重复硬约束
                report.kept({ source: src, field: tableName, reason: '硬限已由 hardForbids 覆盖' });
                continue;
            }
            if (mode === 'max' || mode === 'min') {
                constraints.push({ id: nextCid('subject_preferred_periods'), type: 'subject_preferred_periods', strength: 'soft', target: ruleTarget(rule, { teacherRef, subjectRef, classRef }), params: { mode, ...timeParams(rule) }, source: { kind: 'crystal', text: `${tableName} ${mode}`, ref: src } });
                report.kept({ source: src, field: tableName, reason: `软上下限(${mode}) → subject_preferred_periods 草稿` });
            } else {
                report.review({ source: src, field: tableName, reason: `规则 mode 不明(${JSON.stringify(mode)})，无法分类`, originalValue: rule });
            }
        }
    }

    // presets：course/teacher，status 1弱/2强→软；3硬禁→硬；
    classifyPresets(asArray(cloneSeed.presets?.course), 'course', { constraints, report, nextCid, classRef, subjectRef });
    classifyPresets(asArray(cloneSeed.presets?.teacher), 'teacher', { constraints, report, nextCid, teacherRef });

    // C-1：关系数组（teacherMutualExclusion / courseXorPairs / courseNearPairs）。
    // V2 当前无对应约束 type，逐条 review（绝不静默丢），待 Phase 后续支持。
    for (const pair of asArray(cloneSeed.constraints?.teacherMutualExclusion)) {
        report.review({ source: { table: 'constraints.teacherMutualExclusion' }, field: 'teacherMutualExclusion', reason: '教师互斥（teaman/teawife 合并组）V2 当前无对应约束 type，待 Phase 后续支持', originalValue: pair });
    }
    for (const pair of asArray(cloneSeed.constraints?.courseXorPairs)) {
        report.review({ source: { table: 'constraints.courseXorPairs' }, field: 'courseXorPairs', reason: '课程互斥对（KemuXorBd）V2 当前无对应约束 type，待 Phase 后续支持', originalValue: pair });
    }
    for (const pair of asArray(cloneSeed.constraints?.courseNearPairs)) {
        report.review({ source: { table: 'constraints.courseNearPairs' }, field: 'courseNearPairs', reason: '课程临近偏好对（KemuNearBd）V2 当前无对应约束 type，待 Phase 后续支持', originalValue: pair });
    }

    // options：PaiOpt 五开关 → 导入元数据（保留 item/value/mode）
    for (const opt of optionEntries(cloneSeed.options)) {
        metadata.crystalOptions.push({ item: opt.item, value: opt.value, mode: opt.mode });
        report.kept({ source: { table: 'options', optId: opt.item }, field: `option.${opt.item}`, reason: '→ 导入元数据（PaiOpt 开关）' });
    }

    // consistency 警告并入报告
    for (const w of asArray(cloneSeed.consistency?.warnings ?? cloneSeed.consistency)) {
        report.review({ source: { table: 'consistency' }, field: 'consistency', reason: cleanText(w?.message ?? w, 200) || '来源一致性警告', originalValue: w });
    }

    // APPEND-CRYSTAL-4
    // 教师补全科目（来自 sections/relationGroups 已建立的 teacher）。
    const project = createProject({
        id: options.id ?? 'crystal_import',
        name: options.name ?? '水晶 cloneSeed 导入',
        classes: [...classes.values()],
        teachers: [...teachers.values()],
        subjects: [...subjects.values()],
        rooms: [...rooms.values()],
        activityPlans: plans,
        constraints,
    });
    project.metadata = metadata;

    return { project, report, raw: cloneSeed };
}

// ---- 辅助：规则时间/目标解析 ----

/** 从规则对象提取 slot 列表（"day-period" 字符串）。尽量兼容多种字段形态。 */
function slotsOf(rule = {}) {
    if (Array.isArray(rule.slots)) return rule.slots.map(s => String(s)).filter(Boolean);
    const day = rule.time?.day ?? rule.day;
    const period = rule.time?.period ?? rule.period;
    if (day != null && period != null) return [`${Number(day)}-${Number(period)}`];
    return [];
}

/** 软规则的时间参数（prefer/avoid 节次、day/segment 等原值带入 params）。 */
function timeParams(rule = {}) {
    const t = rule.time ?? {};
    const out = {};
    if (t.period != null) out.period = Number(t.period);
    if (t.day != null) out.day = Number(t.day);
    if (t.segment != null) out.segment = t.segment;
    if (rule.limit?.value != null) out.value = Number(rule.limit.value);
    return out;
}

/** 软规则 target：classCourse → {classId,subjectId}；teacher → {teacherId}。 */
function ruleTarget(rule, refs) {
    if (rule?.target === 'teacher' && rule.teacherId != null) {
        return { teacherId: refs.teacherRef(rule.teacherId) };
    }
    const out = {};
    if (rule?.classId != null) out.classId = refs.classRef(rule.classId);
    if (rule?.courseId != null || rule?.kemuId != null) out.subjectId = refs.subjectRef(rule.courseId ?? rule.kemuId);
    return out;
}

/** PaiOpt options：归一为 [{item,value,mode}]。兼容对象 map 或数组。 */
function optionEntries(options) {
    if (!options || typeof options !== 'object') return [];
    if (Array.isArray(options)) {
        return options.map(o => ({ item: o.item ?? o.key, value: o.value, mode: o.mode }));
    }
    return Object.entries(options).map(([item, v]) => ({
        item,
        value: v && typeof v === 'object' ? v.value : v,
        mode: v && typeof v === 'object' ? v.mode : undefined,
    }));
}

/**
 * preset 三分类：status 3 → 硬禁；status 1/2 → 软草稿；其余 → review。
 * course preset 关联 classId/subjectId；teacher preset 关联 teacherId。
 */
function classifyPresets(presets, kind, { constraints, report, nextCid, classRef, subjectRef, teacherRef }) {
    for (const p of presets) {
        const src = { table: `presets.${kind}`, optId: p?.id ?? p?.optId };
        const status = Number(p?.status);
        const slots = slotsOf(p);
        if (status === 3) {
            // 硬禁
            if (kind === 'teacher' && p?.teacherId != null) {
                constraints.push({ id: nextCid('teacher_unavailable'), type: 'teacher_unavailable', target: { teacherId: teacherRef(p.teacherId) }, params: { slots }, source: { kind: 'crystal', text: 'preset status=3 (hard forbid)', ref: src } });
                report.kept({ source: src, field: 'preset', reason: 'status=3 → teacher_unavailable(hard)' });
            } else if (kind === 'course' && p?.classId != null && Number(p.classId) !== 0) {
                // M-2：课程@班级维度硬禁。class_unavailable 会误伤该班其他课，无精确 V2 对应 → review，不臆造、不谎报 kept。
                report.review({ source: src, field: 'preset', reason: 'status=3：课程@班级维度硬禁，class_unavailable 会误伤该班其他课，无精确 V2 对应，待支持', originalValue: p });
            } else {
                report.review({ source: src, field: 'preset', reason: 'status=3 硬禁但 target 不明（如 appliesToAllClasses），无对应 V2 硬约束', originalValue: p });
            }
        } else if (status === 1 || status === 2) {
            // 软偏好草稿
            const target = {};
            if (kind === 'teacher' && p?.teacherId != null) target.teacherId = teacherRef(p.teacherId);
            if (kind === 'course') {
                if (p?.classId != null && Number(p.classId) !== 0) target.classId = classRef(p.classId);
                if (p?.courseId != null || p?.kemuId != null) target.subjectId = subjectRef(p.courseId ?? p.kemuId);
            }
            constraints.push({ id: nextCid('subject_preferred_periods'), type: 'subject_preferred_periods', strength: 'soft', target, params: { slots, status }, source: { kind: 'crystal', text: `preset status=${status}`, ref: src } });
            report.kept({ source: src, field: 'preset', reason: `status=${status} → subject_preferred_periods 草稿(soft)` });
        } else {
            report.review({ source: src, field: 'preset', reason: `preset status 不明(${p?.status})，无法分类`, originalValue: p });
        }
    }
}

