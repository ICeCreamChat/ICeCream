export function renderAdvancedDrawer({
    open = false,
    tabsHtml = '',
    panelHtml = '',
} = {}) {
    return `
        <section class="geogebra-advanced-tools geogebra-advanced-drawer ${open ? 'open' : ''}" data-geogebra-advanced-tools ${open ? '' : 'hidden'}>
            <header class="geogebra-advanced-head">
                <span>高级工具</span>
                <small>对象、命令、历史、参考和草稿</small>
                <button type="button" class="manim-workbench-secondary" data-geogebra-studio-action="close-advanced-tools">
                    <i data-lucide="x"></i>
                    <span>关闭</span>
                </button>
            </header>
            <div class="geogebra-studio-tabs" role="tablist" aria-label="GeoGebra Studio advanced panels">
                ${tabsHtml}
            </div>
            <div class="geogebra-studio-panel">
                ${panelHtml}
            </div>
        </section>
    `;
}
