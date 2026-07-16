import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTimetablePlannerState } from '../public/js/tools/timetable/state.js';
import { renderConstraintDialog } from '../public/js/tools/timetable/view-constraint-dialog.js';

function generateMockConstraints(count, status = 'effective') {
    return Array.from({ length: count }, (_, index) => ({
        id: `rule-${index + 1}`,
        sourceId: `src:performance:${index + 1}`,
        textHash: `performance-hash-${index + 1}`,
        type: 'teacher_unavailable',
        status,
        confidence: index % 3 === 0 ? 0.92 : index % 3 === 1 ? 0.78 : 0.61,
        priority: index % 2 === 0 ? 'hard' : 'soft',
        targetName: `教师${index + 1}`,
        rawText: `教师${index + 1}在周${(index % 5) + 1}第${(index % 8) + 1}节不排课`,
    }));
}

function renderDialogWithRows(count) {
    const state = createTimetablePlannerState({
        project: { classes: [], teachers: [], subjects: [] },
        constraintDialog: { open: true },
        ruleReview: {
            inputMode: 'text',
            draftRows: generateMockConstraints(count),
        },
    });
    const startTime = performance.now();
    const html = renderConstraintDialog(state);
    return {
        html,
        durationMs: performance.now() - startTime,
        rowCount: (html.match(/class="tt-requirement-row(?:\s|")/g) || []).length,
        detailCount: (html.match(/class="tt-requirement-detail(?:\s|")/g) || []).length,
        cardCount: (html.match(/class="tt-constraint-card(?:\s|")/g) || []).length,
    };
}

describe('智能排课约束弹窗性能测试', () => {
    it('renders a small recognized constraint list quickly', () => {
        const result = renderDialogWithRows(10);

        assert.equal(result.rowCount, 10);
        assert.equal(result.detailCount, 1);
        assert.equal(result.cardCount, 0);
        assert.ok(result.durationMs < 50, '10 条约束渲染应在 50ms 内完成');
    });

    it('renders a larger constraint list without the removed smart workbench dependency', () => {
        const result = renderDialogWithRows(100);

        assert.equal(result.rowCount, 100);
        assert.equal(result.detailCount, 1);
        assert.equal(result.cardCount, 0);
        assert.match(result.html, /tt-constraint-dialog/);
        assert.match(result.html, /tt-requirement-workbench/);
        assert.doesNotMatch(result.html, /tt-smart-workbench/);
        assert.ok(result.durationMs < 250, '100 条约束渲染应保持在 250ms 内');
    });

    it('keeps dialog HTML bounded for school-scale constraint review', () => {
        const result = renderDialogWithRows(200);

        assert.equal(result.rowCount, 200);
        assert.equal(result.detailCount, 1);
        assert.equal(result.cardCount, 0);
        assert.ok(result.html.length < 260_000, '200 条约束 HTML 不应膨胀到不可维护体积');
    });
});
