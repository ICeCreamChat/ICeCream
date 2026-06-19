/**
 * timetable-v2 / constraints / registry.js
 *
 * 约束类型注册表（type → 实现类）。每类约束自注册，index-builder 据此实例化。
 */

const registry = new Map();

/**
 * 注册一个约束实现。
 * @param {string} type DSL type
 * @param {typeof import('./base.js').Constraint} ctor 约束类
 */
export function register(type, ctor) {
    if (registry.has(type)) {
        throw new Error(`constraint registry: type "${type}" 重复注册`);
    }
    registry.set(type, ctor);
}

/** 取某 type 的实现类；未注册返回 undefined。 */
export function getConstraintClass(type) {
    return registry.get(type);
}

export function hasConstraint(type) {
    return registry.has(type);
}

export function registeredTypes() {
    return [...registry.keys()];
}

/** 仅供测试：清空注册表。 */
export function _resetRegistry() {
    registry.clear();
}
