/**
 * timetable-v2 / diagnostics / suggest.js
 *
 * 修复建议草稿生成器：基于 explain/audit 结论产出结构化建议草稿。
 * 决策 6：每条建议是结构化对象，文案由字段渲染。
 *
 * 铁律：只产草稿（applied:false），不调用求解器、不改解、不回写项目（无副作用）。
 * 纯函数、零 IO。
 */

function suggestionId(kind, targetDiagnostics, action) {
    const value = JSON.stringify([kind, targetDiagnostics ?? [], action ?? null]);
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `sug_${(hash >>> 0).toString(36)}`;
}

function make(kind, { targetDiagnostics, action, expectedRelief, impactScope, confidence, message }) {
    return {
        id: suggestionId(kind, targetDiagnostics, action),
        kind,
        targetDiagnostics: targetDiagnostics ?? [],
        action: action ?? null,
        expectedRelief: expectedRelief ?? '',
        impactScope: impactScope ?? 'unknown',
        confidence: confidence ?? 'medium',
        applied: false,
        message: message ?? '',
    };
}

/** 针对未排活动的建议。 */
export function suggestForUnplaced(explainItem) {
    const out = [];
    if (explainItem.kind === 'no-candidate') {
        for (const root of explainItem.rootConstraints ?? []) {
            if (root.kind === 'teacher_unavailable') {
                out.push(make('relax-unavailable', {
                    targetDiagnostics: [explainItem.activityId],
                    action: { type: 'relax-teacher-unavailable', target: { teacher: root.teacher } },
                    expectedRelief: `放宽 ${root.teacher} 的不可用时段，可能为 ${explainItem.subject} 腾出候选位`,
                    impactScope: 'teacher', confidence: 'high',
                    message: `建议放宽教师 ${root.teacher} 的不可用限制`,
                }));
            } else if (root.kind === 'class_unavailable') {
                out.push(make('relax-unavailable', {
                    targetDiagnostics: [explainItem.activityId],
                    action: { type: 'relax-class-unavailable', target: { klass: root.klass } },
                    expectedRelief: `放宽 ${root.klass} 班的不可用时段`,
                    impactScope: 'class', confidence: 'high',
                    message: `建议放宽班级 ${root.klass} 的不可用限制`,
                }));
            } else if (root.kind === 'consecutive-too-long') {
                out.push(make('reduce-consecutive', {
                    targetDiagnostics: [explainItem.activityId],
                    action: { type: 'reduce-duration', target: { activityId: explainItem.activityId } },
                    expectedRelief: '减小连堂时长或拆分课时，使其能放入单日',
                    impactScope: 'activity', confidence: 'high',
                    message: `建议缩短 ${explainItem.subject} 的连堂时长`,
                }));
            }
        }
        if (out.length === 0) {
            out.push(make('add-resource', {
                targetDiagnostics: [explainItem.activityId],
                action: { type: 'review-structural', target: { activityId: explainItem.activityId } },
                expectedRelief: '该活动结构性不可排，需放宽相关约束或补充资源',
                impactScope: 'activity', confidence: 'low',
                message: `${explainItem.subject} 结构性不可排，建议人工复核相关约束`,
            }));
        }
    } else if (explainItem.kind === 'all-blocked') {
        out.push(make('adjust-blocker', {
            targetDiagnostics: [explainItem.activityId],
            action: { type: 'adjust-competing-activities', target: { activityId: explainItem.activityId, blockers: (explainItem.blockers ?? []).map(b => b.activityId) } },
            expectedRelief: '调整占位的竞争活动或放宽软约束，腾出候选时段',
            impactScope: 'multi', confidence: 'medium',
            message: `${explainItem.subject} 候选位被占，建议调整竞争活动或软约束`,
        }));
    }
    return out;
}

/** 针对硬冲突的建议。 */
export function suggestForConflict(conflictItem) {
    return [make('resolve-conflict', {
        targetDiagnostics: conflictItem.activities?.map(a => a.activityId) ?? [],
        action: { type: 'move-one-activity', target: { resource: conflictItem.resourceName, day: conflictItem.day, period: conflictItem.period } },
        expectedRelief: `把 ${conflictItem.resourceName} 在该时段的其中一节课移走，消除同时段争用`,
        impactScope: conflictItem.resourceKind ?? 'resource', confidence: 'high',
        message: `建议移动 ${conflictItem.message} 中的一节课到空闲时段`,
    })];
}

/** 针对审计 error 的建议。 */
export function suggestForAudit(auditItem) {
    if (auditItem.severity !== 'error') return [];
    if (auditItem.code === 'teacher_no_capacity') {
        return [make('relax-or-reduce', {
            targetDiagnostics: [auditItem.code],
            action: { type: 'reduce-load-or-relax-unavailable', target: auditItem.ref, detail: auditItem.detail },
            expectedRelief: `减少该教师任课课时 ${auditItem.detail?.deficit ?? ''} 节，或放宽其不可用时段`,
            impactScope: 'teacher', confidence: 'high',
            message: `教师可用时段不足：${auditItem.message}`,
        })];
    }
    if (auditItem.code === 'class_no_capacity') {
        return [make('reduce-load', {
            targetDiagnostics: [auditItem.code],
            action: { type: 'reduce-class-load', target: auditItem.ref, detail: auditItem.detail },
            expectedRelief: `减少该班级课时或扩充可用时段`,
            impactScope: 'class', confidence: 'high',
            message: `班级可用时段不足：${auditItem.message}`,
        })];
    }
    if (auditItem.code === 'activity_no_slot' || auditItem.code === 'consecutive_no_block') {
        return [make('relax-or-add-room', {
            targetDiagnostics: [auditItem.code],
            action: { type: 'relax-constraints-or-add-room', target: auditItem.ref },
            expectedRelief: '放宽相关不可用约束、缩短连堂或增加可用教室',
            impactScope: 'activity', confidence: 'medium',
            message: auditItem.message,
        })];
    }
    return [make('review', {
        targetDiagnostics: [auditItem.code],
        action: { type: 'manual-review', target: auditItem.ref },
        expectedRelief: '需人工复核',
        impactScope: 'unknown', confidence: 'low',
        message: auditItem.message,
    })];
}
