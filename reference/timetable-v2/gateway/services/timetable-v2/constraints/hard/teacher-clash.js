/**
 * 教师同时段唯一：同一教师在物理重叠时段（含连堂、单双周）不能有两个活动。
 */
import { Constraint } from '../base.js';
import { register } from '../registry.js';
import { detectResourceClash } from './_clash-util.js';

export class TeacherClash extends Constraint {
    detect(solution, ctx) {
        return detectResourceClash(solution, ctx, 'teacher_clash', m => m.teacherIdxs);
    }
}

register('teacher_clash', TeacherClash);
