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
    const detail = state.problemDetailDialog?.open ? state.problemDetailDialog.problem : null;
    const expandedGroups = scan.expandedGroups instanceof Set ? scan.expandedGroups : new Set(scan.expandedGroups || []);

    return `
        <div class="tt-smart-helper" data-smart-helper>
            ${scanning ? renderScanningProgress(scan) : ''}
            ${!scanning && scan.error ? renderScanError(scan) : ''}
            ${!scanning && !scan.error && problems.length > 0 ? renderProblemCards(problems, stats, expandedGroups, scan) : ''}
            ${!scanning && problems.length === 0 && scan.completed ? renderAllClear() : ''}
            ${detail ? renderProblemDetail(detail) : ''}
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
            ${urgentProblems.length > 0 ? renderProblemGroup('urgent', '紧急问题', urgentProblems, expandedGroups) : ''}
            ${optimizeProblems.length > 0 ? renderProblemGroup('optimize', '可优化', optimizeProblems, expandedGroups) : ''}
            ${infoProblems.length > 0 ? renderProblemGroup('info', '信息提示', infoProblems, expandedGroups) : ''}
        </div>

        <div class="tt-helper-actions">
            ${stats.autoFixable > 0 ? `
                <button class="tt-btn tt-btn--primary tt-btn--large" data-action="apply-all-fixes" ${scan.applyingAll ? 'disabled' : ''}>
                    <i data-lucide="${scan.applyingAll ? 'loader-2' : 'wand-sparkles'}" class="${scan.applyingAll ? 'tt-spin' : ''}"></i>
                    <span>${scan.applyingAll ? '生成修复中' : `一键修复全部（${stats.autoFixable}个）`}</span>
                </button>
            ` : ''}
            <button class="tt-btn tt-btn--secondary" data-action="open-ai-chat">
                <i data-lucide="message-circle"></i>
                <span>不确定？问问智能助手</span>
            </button>
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
                        <span>问智能</span>
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
        ['修复建议', problem.fixSuggestion || '暂无自动建议'],
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
                <footer class="tt-smart-detail-actions">
                    <button class="tt-btn tt-btn--secondary" type="button" data-action="discuss-with-ai" data-problem-id="${escapeAttr(problem.id || '')}">
                        <i data-lucide="message-circle"></i>
                        <span>问智能</span>
                    </button>
                    ${problem.autoFixable ? `
                        <button class="tt-btn tt-btn--primary" type="button" data-action="apply-fix" data-problem-id="${escapeAttr(problem.id || '')}">
                            <i data-lucide="wand-sparkles"></i>
                            <span>生成修复预览</span>
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
                        修复预览：${escapeHtml(problem.title)}
                    </h3>
                    <button class="tt-icon-btn" data-action="close-preview" ${applying ? 'disabled' : ''}>
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
                    <button class="tt-btn tt-btn--ghost" data-action="close-preview" ${applying ? 'disabled' : ''}>
                        <i data-lucide="x"></i>
                        <span>取消</span>
                    </button>
                    <button class="tt-btn tt-btn--primary" data-action="confirm-fix" data-problem-id="${problem.id}" ${applying ? 'disabled' : ''}>
                        <i data-lucide="${applying ? 'loader-2' : 'check'}" class="${applying ? 'tt-spin' : ''}"></i>
                        <span>${applying ? '应用中' : '应用此修复'}</span>
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
