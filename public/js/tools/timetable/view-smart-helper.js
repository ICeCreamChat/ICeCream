/**
 * 智能约束自动扫描UI组件
 * 显示扫描进度和问题卡片
 */

/**
 * 渲染智能助手弹窗（新）
 * 作为独立的模态框显示，不再占据整个工作区
 */
export function renderSmartHelperDialog(state) {
    if (!state.constraintScan?.open) return '';

    const scan = state.constraintScan || {};
    const scanning = scan.scanning;
    const problems = scan.problems || [];
    const stats = scan.stats || {};
    const expandedGroups = scan.expandedGroups instanceof Set ? scan.expandedGroups : new Set(scan.expandedGroups || []);

    return `
        <div class="tt-dialog-overlay" data-smart-helper-overlay>
            <section class="tt-smart-helper-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-smart-helper-title">
                <div class="tt-dialog-header">
                    <div>
                        <span class="tt-eyebrow">智能助手</span>
                        <h3 id="tt-smart-helper-title">约束检查</h3>
                        <p>自动检测并修正约束问题</p>
                    </div>
                    <button class="tt-icon-btn" data-action="close-smart-helper" type="button" title="关闭智能助手" aria-label="关闭智能助手">
                        <i data-lucide="x"></i>
                    </button>
                </div>

                <div class="tt-smart-helper-body">
                    ${scanning ? renderScanningProgress(scan) : ''}
                    ${!scanning && scan.error ? renderScanError(scan) : ''}
                    ${!scanning && !scan.error && problems.length > 0 ? renderProblemCards(problems, stats, expandedGroups, scan) : ''}
                    ${!scanning && problems.length === 0 && scan.completed ? renderAllClear() : ''}
                </div>
            </section>

            ${state.fixPreview?.open ? renderFixPreview(state.fixPreview.fix, state.fixPreview.problem, state.fixPreview) : ''}
            ${state.problemDetailDialog?.open ? renderProblemDetail(state.problemDetailDialog.problem) : ''}
        </div>
    `;
}

/**
 * 渲染扫描进度
 */
function renderScanningProgress(scan) {
    const progress = scan.progress || 0;
    const phase = scan.phase || '准备检查约束';

    return `
        <div class="tt-scan-progress">
            <div class="tt-scan-icon">
                <i data-lucide="loader-2" class="tt-spin"></i>
            </div>
            <h3>智能助手正在检查约束</h3>
            <div class="tt-progress-bar">
                <div class="tt-progress-fill" style="width: ${progress}%"></div>
            </div>
            <p class="tt-scan-phase">${escapeHtml(phase)}</p>
        </div>
    `;
}

/**
 * 渲染所有问题已解决
 */
function renderAllClear() {
    return `
        <div class="tt-all-clear">
            <div class="tt-success-icon">
                <i data-lucide="check-circle"></i>
            </div>
            <h3>没有发现需要处理的问题</h3>
            <p>当前约束可以继续复核或确认生效。</p>
            <button class="tt-btn tt-btn--secondary" data-action="close-smart-helper">
                <i data-lucide="check"></i>
                <span>完成</span>
            </button>
        </div>
    `;
}

function renderScanError(scan = {}) {
    return `
        <div class="tt-scan-error" role="alert">
            <i data-lucide="triangle-alert"></i>
            <strong>智能扫描失败</strong>
            <span>${escapeHtml(scan.error || '请稍后重试。')}</span>
            <button class="tt-btn tt-btn--secondary" type="button" data-action="rescan-smart-helper">
                <i data-lucide="rotate-ccw"></i>
                <span>重新扫描</span>
            </button>
        </div>
    `;
}

/**
 * 渲染问题卡片
 */
function renderProblemCards(problems, stats, expandedGroups = new Set(), scan = {}) {
    const urgentProblems = problems.filter(p => p.severity === 'urgent');
    const optimizeProblems = problems.filter(p => p.severity === 'optimize');
    const infoProblems = problems.filter(p => p.severity === 'info');

    return `
        <div class="tt-problem-summary">
            <div class="tt-summary-header">
                <h3>
                    <i data-lucide="sparkles"></i>
                    智能检查完成
                </h3>
                <div class="tt-summary-stats">
                    <span class="tt-stat">发现 ${stats.total || 0} 个问题</span>
                    ${stats.autoFixable > 0 ? `<span class="tt-stat tt-stat--success">${stats.autoFixable} 个可生成修正</span>` : ''}
                </div>
            </div>

            ${renderBeginnerScanSummary(problems, stats)}
        </div>

        <div class="tt-problem-cards">
            ${urgentProblems.length > 0 ? renderProblemGroup('urgent', '还缺什么', urgentProblems, expandedGroups) : ''}
            ${optimizeProblems.length > 0 ? renderProblemGroup('optimize', '哪些可以优化', optimizeProblems, expandedGroups) : ''}
            ${infoProblems.length > 0 ? renderProblemGroup('info', '信息提示', infoProblems, expandedGroups) : ''}
        </div>

        <div class="tt-helper-actions">
            ${stats.autoFixable > 0 ? `
                <button class="tt-btn tt-btn--primary tt-btn--large" data-action="apply-all-fixes" ${scan.applyingAll ? 'disabled' : ''}>
                    <i data-lucide="${scan.applyingAll ? 'loader-2' : 'wand-sparkles'}" class="${scan.applyingAll ? 'tt-spin' : ''}"></i>
                    <span>${scan.applyingAll ? '准备修正中' : `一键生成可修正项（${stats.autoFixable}个）`}</span>
                </button>
            ` : ''}
            <button class="tt-btn tt-btn--secondary" data-action="open-ai-chat">
                <i data-lucide="message-circle"></i>
                <span>问智能助手</span>
            </button>
        </div>
    `;
}

function renderBeginnerScanSummary(problems = [], stats = {}) {
    const urgent = problems.filter(problem => problem.severity === 'urgent').length;
    const conflict = problems.filter(problem => /conflict|冲突|time_conflicts/i.test(`${problem.id || ''} ${problem.type || ''} ${problem.title || ''}`)).length;
    const autoFixable = stats.autoFixable || problems.filter(problem => problem.autoFixable).length;
    return `
        <div class="tt-helper-insight-grid">
            <article>
                <i data-lucide="circle-help"></i>
                <strong>还缺什么</strong>
                <span>${urgent ? `${urgent} 类问题需要先看` : '没有明显缺失'}</span>
            </article>
            <article>
                <i data-lucide="triangle-alert"></i>
                <strong>哪里可能冲突</strong>
                <span>${conflict ? `${conflict} 类冲突需要确认` : '暂未发现硬冲突'}</span>
            </article>
            <article>
                <i data-lucide="wand-sparkles"></i>
                <strong>哪些可以一键修正</strong>
                <span>${autoFixable ? `${autoFixable} 项可生成修正预览` : '暂无可自动修正项'}</span>
            </article>
        </div>
    `;
}

/**
 * 渲染问题组
 */
function renderProblemGroup(severity, title, problems, expandedGroups = new Set()) {
    const collapsed = problems.length > 3 && !expandedGroups.has(severity);

    return `
        <div class="tt-problem-group tt-problem-group--${severity}">
            <div class="tt-problem-group-header">
                <h4>${escapeHtml(title)} (${problems.length})</h4>
                ${problems.length > 3 ? `<button class="tt-expand-btn" data-action="toggle-group" data-group="${severity}" aria-expanded="${collapsed ? 'false' : 'true'}">
                    <i data-lucide="${collapsed ? 'chevron-down' : 'chevron-up'}"></i>
                </button>` : ''}
            </div>
            <div class="tt-problem-list ${collapsed ? 'tt-collapsed' : ''}">
                ${(collapsed ? problems.slice(0, 3) : problems).map(problem => renderProblemCard(problem)).join('')}
                ${collapsed ? `<div class="tt-problem-more">还有 ${problems.length - 3} 个问题，展开后查看。</div>` : ''}
            </div>
        </div>
    `;
}

/**
 * 渲染性能指标
 */
function renderPerformanceMetrics(stats) {
    const scanDuration = stats.scanDuration || 0;
    const checksPerformed = stats.checksPerformed || 0;
    const complianceScore = stats.complianceScore || 0;

    return `
        <div class="tt-performance-metrics">
            <div class="tt-metric-card">
                <div class="tt-metric-icon">
                    <i data-lucide="timer"></i>
                </div>
                <div class="tt-metric-content">
                    <span class="tt-metric-label">检查耗时</span>
                    <span class="tt-metric-value">${scanDuration} ms</span>
                </div>
            </div>
            <div class="tt-metric-card">
                <div class="tt-metric-icon">
                    <i data-lucide="check-square"></i>
                </div>
                <div class="tt-metric-content">
                    <span class="tt-metric-label">检查项</span>
                    <span class="tt-metric-value">${checksPerformed}</span>
                </div>
            </div>
            <div class="tt-metric-card">
                <div class="tt-metric-icon">
                    <i data-lucide="award"></i>
                </div>
                <div class="tt-metric-content">
                    <span class="tt-metric-label">可用度</span>
                    <span class="tt-metric-value">${complianceScore}%</span>
                </div>
            </div>
        </div>
    `;
}

/**
 * 渲染单个问题卡片
 */
function renderProblemCard(problem) {
    const severityIcons = {
        urgent: 'alert-circle',
        optimize: 'lightbulb',
        info: 'info',
    };

    return `
        <div class="tt-problem-card tt-problem-card--${problem.severity}" data-problem-id="${problem.id}">
            <div class="tt-problem-header">
                <div class="tt-problem-icon">
                    <i data-lucide="${problem.icon || severityIcons[problem.severity]}"></i>
                </div>
                <div class="tt-problem-info">
                    <h5>${escapeHtml(problem.title)}</h5>
                    <p>${escapeHtml(problem.description)}</p>
                </div>
                ${problem.count > 1 ? `<span class="tt-problem-count">${problem.count}</span>` : ''}
            </div>

            ${problem.fixSuggestion ? `
                <div class="tt-problem-suggestion">
                    <i data-lucide="sparkles"></i>
                    <span>${escapeHtml(problem.fixSuggestion)}</span>
                </div>
            ` : ''}

            <div class="tt-problem-actions">
                <button
                    class="tt-btn tt-btn--sm tt-btn--ghost"
                    data-action="view-problem-details"
                    data-problem-id="${problem.id}">
                    <i data-lucide="eye"></i>
                    <span>查看原因</span>
                </button>
                ${problem.autoFixable ? `
                    <button
                        class="tt-btn tt-btn--sm tt-btn--primary"
                        data-action="apply-fix"
                        data-problem-id="${problem.id}">
                        <i data-lucide="wand-sparkles"></i>
                        <span>生成修正</span>
                    </button>
                ` : `
                    <button
                        class="tt-btn tt-btn--sm tt-btn--secondary"
                        data-action="discuss-with-ai"
                        data-problem-id="${problem.id}">
                        <i data-lucide="message-circle"></i>
                        <span>问智能助手</span>
                    </button>
                `}
            </div>
        </div>
    `;
}

function renderProblemDetail(problem = {}) {
    const items = [
        ['类型', problem.type || '未分类'],
        ['级别', problem.severity || '提示'],
        ['数量', problem.count ?? 1],
        ['修正建议', problem.fixSuggestion || '暂无自动建议'],
    ];
    const related = [
        ...(problem.constraints || []),
        ...(problem.conflicts || []),
        ...(problem.teachers || []),
        ...(problem.subjects || []),
    ];
    return `
        <div class="tt-smart-detail-backdrop" data-smart-detail-backdrop>
            <section class="tt-smart-detail" role="dialog" aria-modal="true" aria-labelledby="tt-smart-detail-title">
                <header class="tt-smart-detail-header">
                    <div>
                        <span>问题详情</span>
                        <h3 id="tt-smart-detail-title">${escapeHtml(problem.title || '待处理问题')}</h3>
                    </div>
                    <button class="tt-icon-btn" type="button" data-action="close-problem-detail" aria-label="关闭问题详情">
                        <i data-lucide="x"></i>
                    </button>
                </header>
                <p class="tt-smart-detail-desc">${escapeHtml(problem.description || '暂无详细说明。')}</p>
                <dl class="tt-smart-detail-list">
                    ${items.map(([label, value]) => `
                        <div>
                            <dt>${escapeHtml(label)}</dt>
                            <dd>${escapeHtml(value)}</dd>
                        </div>
                    `).join('')}
                </dl>
                ${related.length ? `
                    <div class="tt-smart-detail-related">
                        <strong>关联内容</strong>
                        ${related.slice(0, 8).map(item => `
                            <span>${escapeHtml(item.description || item.rawText || item.name || item.slot || item.id || '关联项')}</span>
                        `).join('')}
                    </div>
                ` : ''}
                <div class="tt-smart-detail-related">
                    <strong>会改哪几条</strong>
                    <span>${problem.autoFixable ? '点击“生成修正”后，会先生成预览，不会直接写入项目。' : '这类问题需要你确认后再处理。'}</span>
                </div>
                <footer class="tt-smart-detail-actions">
                    <button class="tt-btn tt-btn--secondary" type="button" data-action="discuss-with-ai" data-problem-id="${escapeAttr(problem.id || '')}">
                        <i data-lucide="message-circle"></i>
                        <span>问智能</span>
                    </button>
                    ${problem.autoFixable ? `
                        <button class="tt-btn tt-btn--primary" type="button" data-action="apply-fix" data-problem-id="${escapeAttr(problem.id || '')}">
                            <i data-lucide="wand-sparkles"></i>
                            <span>生成修正</span>
                        </button>
                    ` : ''}
                </footer>
            </section>
        </div>
    `;
}

/**
 * 渲染修复预览
 */
export function renderFixPreview(fix, problem, previewState = {}) {
    const applying = Boolean(previewState.applying);
    return `
        <div class="tt-fix-preview-modal" role="presentation">
            <div class="tt-fix-preview-content" role="dialog" aria-modal="true" aria-labelledby="tt-fix-preview-title">
                <div class="tt-fix-preview-header">
                    <h3 id="tt-fix-preview-title">
                        <i data-lucide="wrench"></i>
                        修正预览：${escapeHtml(problem.title)}
                    </h3>
                    <button class="tt-icon-btn" data-action="close-preview" ${applying ? 'disabled' : ''}>
                        <i data-lucide="x"></i>
                    </button>
                </div>

                <div class="tt-fix-comparison">
                    <div class="tt-comparison-side">
                        <h4>当前理解</h4>
                        <div class="tt-comparison-content">
                            ${escapeHtml(fix.preview.before)}
                        </div>
                    </div>

                    <div class="tt-comparison-arrow">
                        <i data-lucide="arrow-right"></i>
                    </div>

                    <div class="tt-comparison-side tt-comparison-side--after">
                        <h4>准备改成</h4>
                        <div class="tt-comparison-content">
                            ${escapeHtml(fix.preview.after)}
                        </div>
                    </div>
                </div>

                <div class="tt-fix-details">
                    <h4>会改哪几条</h4>
                    <ul>
                        ${fix.fixes.map(f => `
                            <li>${escapeHtml(f.reason || '自动调整')}</li>
                        `).join('')}
                    </ul>
                    <p class="tt-muted">需要你再确认什么：应用后请回到复核卡片，确认对象、节次和强弱是否符合教务要求。</p>
                </div>

                <div class="tt-fix-preview-actions">
                    <button class="tt-btn tt-btn--ghost" data-action="close-preview" ${applying ? 'disabled' : ''}>
                        <i data-lucide="x"></i>
                        <span>取消</span>
                    </button>
                    <button class="tt-btn tt-btn--primary" data-action="confirm-fix" data-problem-id="${problem.id}" ${applying ? 'disabled' : ''}>
                        <i data-lucide="${applying ? 'loader-2' : 'check'}" class="${applying ? 'tt-spin' : ''}"></i>
                        <span>${applying ? '应用中' : '应用此修正'}</span>
                    </button>
                </div>
            </div>
        </div>
    `;
}

/**
 * 辅助函数
 */
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[char]);
}

function escapeAttr(str) {
    return escapeHtml(str);
}
