/**
 * timetable-v2 / constraints / nl-parser.js
 *
 * 中文自然语言约束 -> V2 约束 DSL（self-contained 移植自旧 timetable-rule-parser 本地解析层）。
 * 纯函数、零 IO、不调外部模型。命中不到/多候选 -> 标 unsupported 附原文，不臆造。
 *
 * 输出：{ constraints:[V2 DSL], unsupported:[{text, reason}] }
 * 每条 DSL：{ type, strength, target?, params?, source:{kind:'natural_language', text} }
 */

const DAY_NAME_TO_NUMBER = new Map([
    ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 7], ['天', 7],
    ['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
]);

const UNAVAILABLE_RE = /(不要排|不排|不可排|不能排|没空|不可用|unavailable|avoid)/i;
const PREFER_RE = /(优先|尽量|prefer|preferred|安排到|最好|希望)/i;
const AVOID_RE = /(避开|不要|不排|avoid)/i;
const LOCK_RE = /(必须|固定|锁定|指定)/;

function asText(value, max = 300) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function dayNumber(value) {
    return DAY_NAME_TO_NUMBER.get(String(value || '').trim()) || null;
}
function uniqueNumbers(values = []) {
    return [...new Set(values.map(v => Number.parseInt(v, 10)).filter(Number.isInteger))].sort((a, b) => a - b);
}
function expandRange(left, right, max = 12) {
    const start = Math.max(1, Number.parseInt(left, 10));
    const end = Math.min(max, Number.parseInt(right, 10));
    if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
    const [from, to] = start <= end ? [start, end] : [end, start];
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
function slotKey(day, period) { return `${Number(day)}-${Number(period)}`; }

function activeWeekdays(project) {
    const c = project.calendar ?? project;
    return Array.isArray(c.activeWeekdays) && c.activeWeekdays.length
        ? c.activeWeekdays.slice()
        : Array.from({ length: c.weekdays ?? c.nDays ?? 5 }, (_, i) => i + 1);
}
function activePeriods(project) {
    const c = project.calendar ?? project;
    return Array.isArray(c.activePeriods) && c.activePeriods.length
        ? c.activePeriods.slice()
        : Array.from({ length: c.periodsPerDay ?? c.nPeriods ?? 7 }, (_, i) => i + 1);
}

function parseDays(text, project) {
    const t = asText(text);
    if (!t) return [];
    if (/全部|全周|每天|all/i.test(t)) return activeWeekdays(project);
    if (/工作日|周一到周五|monday/i.test(t)) return activeWeekdays(project).filter(d => d <= 5);
    const values = [];
    for (const m of t.matchAll(/(?:周|星期|礼拜)([一二三四五六日天1-7])/g)) {
        const n = dayNumber(m[1]);
        if (n) values.push(n);
    }
    if (!values.length && /^[1-7](?:[,，、\s]+[1-7])*$/.test(t)) {
        values.push(...t.split(/[,，、\s]+/).map(x => Number.parseInt(x, 10)));
    }
    return uniqueNumbers(values);
}

function parsePeriods(text, project) {
    const t = asText(text);
    if (!t) return [];
    const active = activePeriods(project);
    if (/全部|全日|全天|整天|all/i.test(t)) return active;
    if (/上午|早上|morning/i.test(t)) return active.filter(p => p <= Math.ceil(active.length / 2));
    if (/下午|后半天|afternoon/i.test(t)) return active.filter(p => p > Math.ceil(active.length / 2));
    const values = [];
    for (const r of t.matchAll(/第?\s*(\d{1,2})\s*[-~到至]\s*(\d{1,2})\s*节?/g)) {
        values.push(...expandRange(r[1], r[2], Math.max(...active, 12)));
    }
    for (const m of t.matchAll(/第?\s*(\d{1,2})\s*节/g)) values.push(Number.parseInt(m[1], 10));
    if (!values.length && /^\d{1,2}$/.test(t)) values.push(Number.parseInt(t, 10));
    return uniqueNumbers(values);
}

function splitSentences(text = '') {
    return String(text).split(/[\n。；;，,!?！？]+/).map(s => s.trim()).filter(Boolean);
}

function textSlots(sentence, project) {
    const days = parseDays(sentence, project);
    const periods = parsePeriods(sentence, project);
    if (!periods.length) return [];
    const targetDays = days.length ? days : activeWeekdays(project);
    return [...new Set(targetDays.flatMap(d => periods.map(p => slotKey(d, p))))].sort();
}

function dedupe(targets) {
    const seen = new Set();
    return targets.filter(t => {
        const key = String(t.name || t.id || '').toLowerCase().replace(/\s+/g, '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
function teacherTargets(sentence, project) {
    const hit = [];
    for (const t of project.teachers ?? []) {
        if (t.name && sentence.includes(t.name)) hit.push({ id: t.id, name: t.name });
    }
    const regexOnly = !hit.length && /[一-龥]{1,4}(?:老师|教师)/.test(sentence);
    return { hit: dedupe(hit), regexOnly };
}
function classTargets(sentence, project) {
    const hit = [];
    for (const k of project.classes ?? []) {
        const label = k.grade && k.name && !String(k.name).startsWith(k.grade) ? `${k.grade}${k.name}` : k.name;
        if ((label && sentence.includes(label)) || (k.name && sentence.includes(k.name))) hit.push({ id: k.id, name: label || k.name });
    }
    const regexOnly = !hit.length && /(?:高|初|七|八|九)[一二三]?\s*\d{1,2}\s*班/.test(sentence);
    return { hit: dedupe(hit), regexOnly };
}
function subjectTargets(sentence, project) {
    const hit = [];
    for (const s of project.subjects ?? []) {
        if (s.name && sentence.includes(s.name)) hit.push({ id: s.id, name: s.name });
    }
    return { hit: dedupe(hit), regexOnly: false };
}

// PLACEHOLDER_MAIN

/** 查找匹配 class+subject+teacher 三元组的 activityPlan，返回 planId 或 null。 */
function findPlanId(project, classId, subjectId, teacherId) {
    for (const p of project.activityPlans ?? []) {
        const classes = p.classIds ?? (p.classId ? [p.classId] : []);
        const teachers = p.teacherIds ?? (p.teacherId ? [p.teacherId] : []);
        if (p.subjectId === subjectId && classes.includes(classId) && teachers.includes(teacherId)) return p.id;
    }
    return null;
}

/**
 * 解析自然语言约束文本为 V2 DSL。
 * @param {string} text 自然语言原文
 * @param {object} project 规范化后的 V2 项目
 * @returns {{ constraints:Array, unsupported:Array<{text,reason}> }}
 */
export function parseNaturalLanguageConstraints(text, project = {}) {
    const out = [];
    const unsupported = [];
    const morningSubjectIds = new Set();
    const subjectPeriods = new Map();

    for (const sentence of splitSentences(text)) {
        const slots = textSlots(sentence, project);
        const teachers = teacherTargets(sentence, project);
        const classes = classTargets(sentence, project);
        const subjects = subjectTargets(sentence, project);
        let matched = false;

        if (LOCK_RE.test(sentence) && slots.length && teachers.hit.length && classes.hit.length && subjects.hit.length) {
            const planId = findPlanId(project, classes.hit[0].id, subjects.hit[0].id, teachers.hit[0].id);
            if (planId) out.push(dsl('fixed_locked', { target: { planId }, params: { slot: slots[0] } }, sentence));
            else unsupported.push({ text: sentence, reason: '未找到匹配的教学计划（班级+科目+教师），无法锁定' });
            continue;
        }

        for (const t of teachers.hit) {
            if (UNAVAILABLE_RE.test(sentence) && slots.length) {
                out.push(dsl('teacher_unavailable', { target: { teacherId: t.id }, params: { slots } }, sentence));
                matched = true;
            }
            const daily = sentence.match(/每[天日].*?(?:最多|不超过|不多于|上限)\s*(\d{1,2})\s*节/);
            if (daily) {
                out.push(dsl('teacher_limits', { target: { teacherId: t.id }, params: { daily: Number(daily[1]) } }, sentence));
                matched = true;
            }
            const consec = sentence.match(/(?:连续|连排|连堂).*?(?:最多|不超过|不多于)\s*(\d{1,2})\s*节/);
            if (consec) {
                out.push(dsl('teacher_limits', { target: { teacherId: t.id }, params: { consecutive: Number(consec[1]) } }, sentence));
                matched = true;
            }
        }
        if (!teachers.hit.length && teachers.regexOnly && (UNAVAILABLE_RE.test(sentence) || /每[天日]|连续|连排|连堂/.test(sentence))) {
            unsupported.push({ text: sentence, reason: '句中教师不在项目教师名单内，无法确定 target' });
        }

        for (const k of classes.hit) {
            if (UNAVAILABLE_RE.test(sentence) && slots.length) {
                out.push(dsl('class_unavailable', { target: { classId: k.id }, params: { slots } }, sentence));
                matched = true;
            }
        }
        if (!classes.hit.length && classes.regexOnly && UNAVAILABLE_RE.test(sentence) && slots.length) {
            unsupported.push({ text: sentence, reason: '句中班级不在项目班级名单内，无法确定 target' });
        }

        const teacherUnavailSentence = (project.teachers ?? []).some(t => t.name && sentence.includes(t.name))
            && UNAVAILABLE_RE.test(sentence) && !PREFER_RE.test(sentence);
        if (!teacherUnavailSentence) {
            for (const s of subjects.hit) {
                if (/上午|早上/.test(sentence) && PREFER_RE.test(sentence)) {
                    morningSubjectIds.add(s.id); matched = true;
                } else if (slots.length && PREFER_RE.test(sentence)) {
                    bucket(subjectPeriods, s.id).prefer.push(...slots); matched = true;
                } else if (slots.length && AVOID_RE.test(sentence)) {
                    bucket(subjectPeriods, s.id).avoid.push(...slots); matched = true;
                }
            }
        }

        if (/语数英|语文.*数学.*英语|数学.*语文.*英语/i.test(sentence) && /上午|早上/.test(sentence)) {
            for (const s of project.subjects ?? []) {
                if (/(语文|数学|英语|chinese|math|english)/i.test(s.name)) { morningSubjectIds.add(s.id); matched = true; }
            }
        }

        if (!matched) unsupported.push({ text: sentence, reason: '未匹配到已知约束句式' });
    }

    if (morningSubjectIds.size) {
        out.push(dsl('morning_subjects', { params: { subjectIds: [...morningSubjectIds] } }, '主科上午（聚合）'));
    }
    for (const [subjectId, sets] of subjectPeriods) {
        const params = {};
        if (sets.prefer.length) params.prefer = [...new Set(sets.prefer)].sort();
        if (sets.avoid.length) params.avoid = [...new Set(sets.avoid)].sort();
        out.push(dsl('subject_preferred_periods', { target: { subjectId }, params }, '科目偏好节次（聚合）'));
    }

    return { constraints: dedupeDsl(out), unsupported };
}

function bucket(map, key) {
    if (!map.has(key)) map.set(key, { prefer: [], avoid: [] });
    return map.get(key);
}

const SOFT_DSL_TYPES = new Set(['teacher_limits', 'morning_subjects', 'subject_preferred_periods', 'spread_subjects', 'balanced_teacher_load']);
function dsl(type, body, sourceText) {
    return {
        type,
        strength: SOFT_DSL_TYPES.has(type) ? 'soft' : 'hard',
        ...body,
        source: { kind: 'natural_language', text: sourceText },
    };
}
function dedupeDsl(list) {
    const seen = new Set();
    return list.filter(c => {
        const key = JSON.stringify([c.type, c.target ?? null, c.params?.slots ?? c.params?.slot ?? c.params ?? null]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
