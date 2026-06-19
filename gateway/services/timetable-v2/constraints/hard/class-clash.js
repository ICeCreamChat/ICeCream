/**
 * 班级同时段唯一：同一班级在物理重叠时段不能有两个活动（合班按多 classIdxs 展开）。
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';
import { detectResourceClash } from './_clash-util.js';

export class ClassClash extends Constraint {
    detect(solution, ctx) {
        return detectResourceClash(solution, ctx, 'class_clash', m => m.classIdxs);
    }
}

register('class_clash', ClassClash);
