/**
 * timetable-v2 / domain / subject.js
 *
 * Subject 定义。保留旧 timetable-project.js 模型的 category / priority / tags / color，
 * 确保 Phase 3 导入器可无损映射。domain 只认归一后的枚举（容错归一在 Phase 3 导入器做）。
 *
 * 纯函数、零 IO。
 */

/** 旧模型科目分类枚举，V2 直接沿用以保证双向可映射。 */
export const SUBJECT_CATEGORIES = Object.freeze(['main', 'quality', 'lab', 'normal']);

const DEFAULT_COLOR = '#2563eb';

/**
 * 构造并校验一个 Subject。
 * @param {object} raw
 * @throws 当 category 不在枚举内、priority 越界、id/name 缺失
 */
export function createSubject(raw = {}) {
    const id = String(raw.id ?? '').trim();
    const name = String(raw.name ?? '').trim();
    if (!id) throw new Error('subject: 缺少 id');
    if (!name) throw new Error(`subject ${id}: 缺少 name`);

    const category = raw.category ?? 'normal';
    if (!SUBJECT_CATEGORIES.includes(category)) {
        throw new Error(`subject ${id}: category "${category}" 不在枚举 ${SUBJECT_CATEGORIES.join('|')} 内`);
    }

    const priority = Number(raw.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 100) {
        throw new Error(`subject ${id}: priority 必须是 1–100 的整数，收到 ${raw.priority}`);
    }

    const tags = Array.isArray(raw.tags)
        ? [...new Set(raw.tags.map(t => String(t).trim()).filter(Boolean))]
        : [];

    const color = /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : DEFAULT_COLOR;

    return { id, name, category, priority, tags, color };
}

export function isSubjectCategory(value) {
    return SUBJECT_CATEGORIES.includes(value);
}
