import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTimetablePlannerState } from '../public/js/tools/timetable/state.js';
import { createSmartWorkbenchState } from '../public/js/tools/timetable/smart-workbench/workbench-state.js';
import { renderSmartWorkbench } from '../public/js/tools/timetable/smart-workbench/workbench-view.js';

function generateMockConstraints(count, status = 'effective') {
    const constraints = [];
    for (let i = 0; i < count; i++) {
        constraints.push({
            id: `rule-${i + 1}`,
            type: 'teacher_unavailable',
            status,
            confidence: i % 3 === 0 ? 'high' : i % 3 === 1 ? 'medium' : 'low',
            priority: i % 2 === 0 ? 'hard' : 'soft',
            target: { type: 'teacher', id: `teacher-${i % 10}`, name: `教师${i % 10}` },
            time: { day: (i % 5) + 1, period: (i % 8) + 1 },
            sourceText: `教师${i % 10}在周${(i % 5) + 1}第${(i % 8) + 1}节不排课`,
            source: 'text',
            sourceRow: i + 1,
            understanding: `教师${i % 10}在周${(i % 5) + 1}第${(i % 8) + 1}节不可排课`,
        });
    }
    return constraints;
}

function measureRenderTime(state, iterations = 3) {
    const times = [];
    for (let i = 0; i < iterations; i++) {
        const startTime = performance.now();
        const html = renderSmartWorkbench(state);
        const endTime = performance.now();
        times.push(endTime - startTime);

        // 模拟字符串操作以测量实际开销
        const _ = html.length;
    }
    return {
        min: Math.min(...times),
        max: Math.max(...times),
        avg: times.reduce((a, b) => a + b, 0) / times.length,
    };
}

function countRenderedCards(html) {
    const matches = html.match(/class="tt-smart-rule-card/g);
    return matches ? matches.length : 0;
}

function measureHtmlSize(html) {
    return {
        htmlSize: html.length,
        htmlSizeKB: (html.length / 1024).toFixed(2),
        cardCount: countRenderedCards(html),
    };
}

describe('智能排课工作台分页性能测试', () => {
    it('基准测试：10 条约束，未分页场景', () => {
        const state = createTimetablePlannerState({
            project: { classes: [], teachers: [], subjects: [] },
            ruleReview: {
                draftRows: generateMockConstraints(10, 'effective'),
            },
            smartWorkbench: createSmartWorkbenchState({
                open: true,
                stage: 'reviewing_constraints',
                selectedSection: 'ready',
            }),
        });

        const renderMetrics = measureRenderTime(state);
        const html = renderSmartWorkbench(state);
        const sizeMetrics = measureHtmlSize(html);

        console.log('10 条约束基准测试：');
        console.log(`  渲染时间：平均 ${renderMetrics.avg.toFixed(2)}ms (${renderMetrics.min.toFixed(2)}ms - ${renderMetrics.max.toFixed(2)}ms)`);
        console.log(`  规则卡片：${sizeMetrics.cardCount}`);
        console.log(`  HTML 大小：${sizeMetrics.htmlSizeKB}KB`);

        assert.equal(sizeMetrics.cardCount, 10, '应渲染 10 张规则卡片');
        assert.ok(renderMetrics.avg < 50, '10 条约束渲染应在 50ms 内完成');
    });

    it('性能测试：100 条约束，未启用分页（模拟优化前）', () => {
        const state = createTimetablePlannerState({
            project: { classes: [], teachers: [], subjects: [] },
            ruleReview: {
                draftRows: generateMockConstraints(100, 'effective'),
            },
            smartWorkbench: createSmartWorkbenchState({
                open: true,
                stage: 'reviewing_constraints',
                selectedSection: 'ready',
                pageSize: 999,
                currentPage: 1,
            }),
        });

        const renderMetrics = measureRenderTime(state);
        const html = renderSmartWorkbench(state);
        const sizeMetrics = measureHtmlSize(html);

        console.log('\n100 条约束无分页测试（优化前）：');
        console.log(`  渲染时间：平均 ${renderMetrics.avg.toFixed(2)}ms (${renderMetrics.min.toFixed(2)}ms - ${renderMetrics.max.toFixed(2)}ms)`);
        console.log(`  规则卡片：${sizeMetrics.cardCount}`);
        console.log(`  HTML 大小：${sizeMetrics.htmlSizeKB}KB`);

        assert.equal(sizeMetrics.cardCount, 100, '应渲染 100 张规则卡片');
    });

    it('性能测试：100 条约束，启用分页（pageSize=20，优化后）', () => {
        const state = createTimetablePlannerState({
            project: { classes: [], teachers: [], subjects: [] },
            ruleReview: {
                draftRows: generateMockConstraints(100, 'effective'),
            },
            smartWorkbench: createSmartWorkbenchState({
                open: true,
                stage: 'reviewing_constraints',
                selectedSection: 'ready',
                pageSize: 20,
                currentPage: 1,
            }),
        });

        const renderMetrics = measureRenderTime(state);
        const html = renderSmartWorkbench(state);
        const sizeMetrics = measureHtmlSize(html);

        console.log('\n100 条约束启用分页测试（优化后）：');
        console.log(`  渲染时间：平均 ${renderMetrics.avg.toFixed(2)}ms (${renderMetrics.min.toFixed(2)}ms - ${renderMetrics.max.toFixed(2)}ms)`);
        console.log(`  规则卡片：${sizeMetrics.cardCount}`);
        console.log(`  HTML 大小：${sizeMetrics.htmlSizeKB}KB`);

        assert.equal(sizeMetrics.cardCount, 20, '应仅渲染当前页的 20 张规则卡片');
        assert.ok(renderMetrics.avg < 100, '分页后渲染应保持在 100ms 内');
    });

    it('性能测试：200 条约束，启用分页（pageSize=20）', () => {
        const state = createTimetablePlannerState({
            project: { classes: [], teachers: [], subjects: [] },
            ruleReview: {
                draftRows: generateMockConstraints(200, 'effective'),
            },
            smartWorkbench: createSmartWorkbenchState({
                open: true,
                stage: 'reviewing_constraints',
                selectedSection: 'ready',
                pageSize: 20,
                currentPage: 1,
            }),
        });

        const renderMetrics = measureRenderTime(state);
        const html = renderSmartWorkbench(state);
        const sizeMetrics = measureHtmlSize(html);

        console.log('\n200 条约束启用分页测试：');
        console.log(`  渲染时间：平均 ${renderMetrics.avg.toFixed(2)}ms (${renderMetrics.min.toFixed(2)}ms - ${renderMetrics.max.toFixed(2)}ms)`);
        console.log(`  规则卡片：${sizeMetrics.cardCount}`);
        console.log(`  HTML 大小：${sizeMetrics.htmlSizeKB}KB`);

        assert.equal(sizeMetrics.cardCount, 20, '应仅渲染当前页的 20 张规则卡片');
        assert.ok(renderMetrics.avg < 120, '200 条数据分页后渲染应保持在 120ms 内');
    });

    it('分页器功能测试：翻页不影响卡片总数', () => {
        const draftRows = generateMockConstraints(50, 'effective');

        const statePage1 = createTimetablePlannerState({
            project: { classes: [], teachers: [], subjects: [] },
            ruleReview: { draftRows },
            smartWorkbench: createSmartWorkbenchState({
                open: true,
                stage: 'reviewing_constraints',
                selectedSection: 'ready',
                pageSize: 20,
                currentPage: 1,
            }),
        });

        const statePage2 = createTimetablePlannerState({
            project: { classes: [], teachers: [], subjects: [] },
            ruleReview: { draftRows },
            smartWorkbench: createSmartWorkbenchState({
                open: true,
                stage: 'reviewing_constraints',
                selectedSection: 'ready',
                pageSize: 20,
                currentPage: 2,
            }),
        });

        const statePage3 = createTimetablePlannerState({
            project: { classes: [], teachers: [], subjects: [] },
            ruleReview: { draftRows },
            smartWorkbench: createSmartWorkbenchState({
                open: true,
                stage: 'reviewing_constraints',
                selectedSection: 'ready',
                pageSize: 20,
                currentPage: 3,
            }),
        });

        const page1Cards = countRenderedCards(renderSmartWorkbench(statePage1));
        const page2Cards = countRenderedCards(renderSmartWorkbench(statePage2));
        const page3Cards = countRenderedCards(renderSmartWorkbench(statePage3));

        console.log('\n分页器功能测试（50 条数据）：');
        console.log(`  第 1 页卡片数：${page1Cards}`);
        console.log(`  第 2 页卡片数：${page2Cards}`);
        console.log(`  第 3 页卡片数：${page3Cards}`);

        assert.equal(page1Cards, 20, '第 1 页应显示 20 张卡片');
        assert.equal(page2Cards, 20, '第 2 页应显示 20 张卡片');
        assert.equal(page3Cards, 10, '第 3 页应显示剩余 10 张卡片');
    });

    it('分页器 UI 测试：验证分页按钮生成正确', () => {
        const state = createTimetablePlannerState({
            project: { classes: [], teachers: [], subjects: [] },
            ruleReview: {
                draftRows: generateMockConstraints(100, 'effective'),
            },
            smartWorkbench: createSmartWorkbenchState({
                open: true,
                stage: 'reviewing_constraints',
                selectedSection: 'ready',
                pageSize: 20,
                currentPage: 3,
            }),
        });

        const html = renderSmartWorkbench(state);
        const hasPaginator = html.includes('tt-smart-paginator');
        const hasPageInfo = html.includes('第 3 / 5 页，共 100 条');

        console.log('\n分页器 UI 测试：');
        console.log(`  分页器存在：${hasPaginator}`);
        console.log(`  页面信息正确：${hasPageInfo}`);

        assert.ok(hasPaginator, '应渲染分页器');
        assert.ok(hasPageInfo, '页面信息应正确显示');
    });

    it('性能对比汇总：计算优化提升比例', () => {
        const testSizes = [50, 100, 200];
        const results = [];

        for (const size of testSizes) {
            // 未分页
            const stateNoPagination = createTimetablePlannerState({
                project: { classes: [], teachers: [], subjects: [] },
                ruleReview: { draftRows: generateMockConstraints(size, 'effective') },
                smartWorkbench: createSmartWorkbenchState({
                    open: true,
                    stage: 'reviewing_constraints',
                    selectedSection: 'ready',
                    pageSize: 999,
                    currentPage: 1,
                }),
            });

            // 启用分页
            const stateWithPagination = createTimetablePlannerState({
                project: { classes: [], teachers: [], subjects: [] },
                ruleReview: { draftRows: generateMockConstraints(size, 'effective') },
                smartWorkbench: createSmartWorkbenchState({
                    open: true,
                    stage: 'reviewing_constraints',
                    selectedSection: 'ready',
                    pageSize: 20,
                    currentPage: 1,
                }),
            });

            const noPaginationTime = measureRenderTime(stateNoPagination, 5).avg;
            const withPaginationTime = measureRenderTime(stateWithPagination, 5).avg;
            const noPaginationHtml = renderSmartWorkbench(stateNoPagination);
            const withPaginationHtml = renderSmartWorkbench(stateWithPagination);
            const noPaginationSize = noPaginationHtml.length;
            const withPaginationSize = withPaginationHtml.length;

            const timeImprovement = ((noPaginationTime - withPaginationTime) / noPaginationTime * 100).toFixed(1);
            const sizeReduction = ((noPaginationSize - withPaginationSize) / noPaginationSize * 100).toFixed(1);

            results.push({
                size,
                noPaginationTime: noPaginationTime.toFixed(2),
                withPaginationTime: withPaginationTime.toFixed(2),
                timeImprovement,
                noPaginationSize: (noPaginationSize / 1024).toFixed(1),
                withPaginationSize: (withPaginationSize / 1024).toFixed(1),
                sizeReduction,
            });
        }

        console.log('\n=== 性能优化效果汇总 ===');
        console.log('数据量 | 优化前耗时 | 优化后耗时 | 提升比例 | 优化前大小 | 优化后大小 | 大小减少');
        console.log('-------|------------|------------|----------|------------|------------|----------');
        for (const r of results) {
            console.log(`${r.size.toString().padStart(6)} | ${r.noPaginationTime.padStart(10)}ms | ${r.withPaginationTime.padStart(10)}ms | ${r.timeImprovement.padStart(7)}% | ${r.noPaginationSize.padStart(9)}KB | ${r.withPaginationSize.padStart(9)}KB | ${r.sizeReduction.padStart(7)}%`);
        }

        assert.ok(results.every(r => parseFloat(r.timeImprovement) > 0), '所有场景均应有性能提升');
        assert.ok(results.some(r => parseFloat(r.timeImprovement) >= 70), '100+ 条数据应有 70% 以上提升');
    });
});

