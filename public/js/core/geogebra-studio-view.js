export function renderPresentationAssistant({
    promptText = '',
    busy = false,
    renderAssistantStatus,
    renderDemoControls,
    renderResultCards,
    escapeHtml,
} = {}) {
    return `
        <section class="geogebra-drawing-assistant" aria-label="GeoGebra 绘图助手">
            <div class="geogebra-assistant-head">
                <div>
                    <strong>绘图助手</strong>
                    <small>输入题目或上传截图，先准备动态构造，再由你点击播放演示。</small>
                </div>
            </div>
            <div class="geogebra-assistant-scroll">
                ${renderAssistantStatus()}
                <label class="geogebra-assistant-field">
                    <span>题目或调整要求</span>
                    <textarea class="geogebra-recognized-problem" data-geogebra-prompt-input rows="7" placeholder="例如：画一个可以拖动顶点的三角形并标出外接圆">${escapeHtml(promptText)}</textarea>
                </label>
                <div class="geogebra-assistant-actions">
                    <button type="button" class="manim-workbench-primary" data-geogebra-studio-action="draw-from-prompt" ${busy ? 'disabled' : ''}>
                        <i data-lucide="play"></i>
                        <span>生成图形</span>
                    </button>
                    <div class="geogebra-assistant-secondary-actions">
                        <button type="button" class="manim-workbench-secondary" data-geogebra-studio-action="redraw-from-prompt" ${busy ? 'disabled' : ''}>
                        <i data-lucide="refresh-ccw"></i>
                        <span>重新绘图</span>
                    </button>
                        <button type="button" class="manim-workbench-secondary geogebra-problem-upload" data-geogebra-studio-action="upload-problem" ${busy ? 'disabled' : ''}>
                        <i data-lucide="image-plus"></i>
                        <span>上传题目</span>
                    </button>
                        <button type="button" class="manim-workbench-secondary" data-geogebra-studio-action="adjust-current-graph" ${busy ? 'disabled' : ''}>
                        <i data-lucide="sparkles"></i>
                        <span>调整当前图</span>
                        </button>
                    </div>
                </div>
                ${renderDemoControls()}
                ${renderResultCards()}
            </div>
        </section>
    `;
}
