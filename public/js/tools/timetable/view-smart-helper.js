/**
 * 智能约束自动扫描UI组件
 * 显示扫描进度和问题卡片
 */

/**
 * 渲染自动扫描界面（全新设计）
 */
export function renderSmartConstraintHelper(state) {
    const scan = state.constraintScan || {};
    const scanning = scan.scanning;
    const problems = scan.problems || [];
    const stats = scan.stats || {};

    return `
        <div class="tt-smart-helper" data-smart-helper>
            ${scanning ? renderScanningProgress(scan) : ''}
            ${!scanning && problems.length > 0 ? renderProblemCards(problems, stats) : ''}
            ${!scanning && problems.length === 0 && scan.completed ? renderAllClear() : ''}
        </div>
    `;
}

/**
 * 渲染扫描进度
 */
function renderScanningProgress(scan) {
    const progress = scan.progress || 0;
    const phase = scan.phase || '准备分析';

    return `
        <div class="tt-scan-progress">
            <div class="tt-scan-icon">
                <i data-lucide="scan" class="tt-pulse"></i>
            </div>
            <h3>🔍 智能助手正在分析...</h3>
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
            <h3>✅ 太棒了！没有发现问题</h3>
            <p>您的约束配置看起来很合理</p>
            <button class="tt-btn tt-btn--secondary" data-action="close-smart-helper">
                <i data-lucide="check"></i>
                <span>完成</span>
            </button>
        </div>
    `;
}

/**
 * 渲染问题卡片
 */
function renderProblemCards(problems, stats) {
    const urgentProblems = problems.filter(p => p.severity === 'urgent');
    const optimizeProblems = problems.filter(p => p.severity === 'optimize');
    const infoProblems = problems.filter(p => p.severity === 'info');

    return `
        <div class="tt-problem-summary">
            <div class="tt-summary-header">
                <h3>
                    <i data-lucide="sparkles"></i>
                    智能分析完成！
                </h3>
                <div class="tt-summary-stats">
                    <span class="tt-stat">发现 ${stats.total || 0} 个问题</span>
                    ${stats.autoFixable > 0 ? `<span class="tt-stat tt-stat--success">${stats.autoFixable} 个可自动修复</span>` : ''}
                </div>
            </div>

            <div class="tt-completeness">
                <div class="tt-completeness-bar">
                    <div class="tt-completeness-fill" style="width: ${stats.completeness || 0}%"></div>
                </div>
                <span class="tt-completeness-text">完成度 ${stats.completeness || 0}%</span>
            </div>

            ${renderPerformanceMetrics(stats)}
        </div>

        <div class="tt-problem-cards">
            ${urgentProblems.length > 0 ? renderProblemGroup('urgent', '🔴 紧急问题', urgentProblems) : ''}
            ${optimizeProblems.length > 0 ? renderProblemGroup('optimize', '🟡 可优化', optimizeProblems) : ''}
            ${infoProblems.length > 0 ? renderProblemGroup('info', '🔵 信息提示', infoProblems) : ''}
        </div>

        <div class="tt-helper-actions">
            ${stats.autoFixable > 0 ? `
                <button class="tt-btn tt-btn--primary tt-btn--large" data-action="apply-all-fixes">
                    <i data-lucide="wand-sparkles"></i>
                    <span>一键修复全部（${stats.autoFixable}个）</span>
                </button>
            ` : ''}
            <button class="tt-btn tt-btn--secondary" data-action="open-ai-chat">
                <i data-lucide="message-circle"></i>
                <span>💬 不确定？问问AI助手</span>
            </button>
        </div>
    `;
}

/**
 * 渲染问题组
 */
function renderProblemGroup(severity, title, problems) {
    const collapsed = problems.length > 3;

    return `
        <div class="tt-problem-group tt-problem-group--${severity}">
            <div class="tt-problem-group-header">
                <h4>${escapeHtml(title)} (${problems.length})</h4>
                ${collapsed ? `<button class="tt-expand-btn" data-action="toggle-group" data-group="${severity}">
                    <i data-lucide="chevron-down"></i>
                </button>` : ''}
            </div>
            <div class="tt-problem-list ${collapsed ? 'tt-collapsed' : ''}">
                ${problems.map(problem => renderProblemCard(problem)).join('')}
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
                    <span class="tt-metric-label">扫描耗时</span>
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
                    <span class="tt-metric-label">行业合规度</span>
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
                    <span>查看详情</span>
                </button>
                ${problem.autoFixable ? `
                    <button
                        class="tt-btn tt-btn--sm tt-btn--primary"
                        data-action="apply-fix"
                        data-problem-id="${problem.id}">
                        <i data-lucide="wand-sparkles"></i>
                        <span>一键修复</span>
                    </button>
                ` : `
                    <button
                        class="tt-btn tt-btn--sm tt-btn--secondary"
                        data-action="discuss-with-ai"
                        data-problem-id="${problem.id}">
                        <i data-lucide="message-circle"></i>
                        <span>问AI</span>
                    </button>
                `}
            </div>
        </div>
    `;
}

/**
 * 渲染修复预览
 */
export function renderFixPreview(fix, problem) {
    return `
        <div class="tt-fix-preview-modal">
            <div class="tt-fix-preview-content">
                <div class="tt-fix-preview-header">
                    <h3>
                        <i data-lucide="wrench"></i>
                        修复预览：${escapeHtml(problem.title)}
                    </h3>
                    <button class="tt-icon-btn" data-action="close-preview">
                        <i data-lucide="x"></i>
                    </button>
                </div>

                <div class="tt-fix-comparison">
                    <div class="tt-comparison-side">
                        <h4>❌ 修复前</h4>
                        <div class="tt-comparison-content">
                            ${escapeHtml(fix.preview.before)}
                        </div>
                    </div>

                    <div class="tt-comparison-arrow">
                        <i data-lucide="arrow-right"></i>
                    </div>

                    <div class="tt-comparison-side tt-comparison-side--after">
                        <h4>✅ 修复后</h4>
                        <div class="tt-comparison-content">
                            ${escapeHtml(fix.preview.after)}
                        </div>
                    </div>
                </div>

                <div class="tt-fix-details">
                    <h4>修复详情：</h4>
                    <ul>
                        ${fix.fixes.map(f => `
                            <li>${escapeHtml(f.reason || '自动调整')}</li>
                        `).join('')}
                    </ul>
                </div>

                <div class="tt-fix-preview-actions">
                    <button class="tt-btn tt-btn--ghost" data-action="close-preview">
                        <i data-lucide="x"></i>
                        <span>取消</span>
                    </button>
                    <button class="tt-btn tt-btn--primary" data-action="confirm-fix" data-problem-id="${problem.id}">
                        <i data-lucide="check"></i>
                        <span>应用此修复</span>
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
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
