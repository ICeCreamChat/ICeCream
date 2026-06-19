/**
 * timetable-v2 / index.js
 *
 * Phase 1 子树聚合导出。导入硬约束模块以触发自注册。
 * 零 IO，不被任何现有路由引用（并行子树）。
 */

// 领域层
export * from './domain/calendar.js';
export * from './domain/ids.js';
export * from './domain/subject.js';
export * from './domain/activity.js';
export { Solution, createSolution } from './domain/solution.js';
export * from './domain/project.js';

// 约束基础设施
export { Constraint, STRENGTH } from './constraints/base.js';
export * from './constraints/dsl.js';
export { register, getConstraintClass, hasConstraint, registeredTypes } from './constraints/registry.js';
export { buildContext, detectHardConflicts } from './constraints/index-builder.js';

// 硬约束（import 触发 register 自注册）
import './constraints/hard/teacher-clash.js';
import './constraints/hard/class-clash.js';
import './constraints/hard/room-clash.js';
import './constraints/hard/teacher-unavailable.js';
import './constraints/hard/class-unavailable.js';
import './constraints/hard/fixed-locked.js';
import './constraints/hard/consecutive.js';
import './constraints/hard/valid-timeslot.js';

export { isLocked } from './constraints/hard/fixed-locked.js';
