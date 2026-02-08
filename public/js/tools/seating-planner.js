/**
 * Smart Seating Planner - 智能座位编排系统
 * 完全重构版 - Premium SaaS Dashboard Style
 */

class SeatingPlanner {
    constructor() {
        this.students = [];
        this.constraints = [];
        this.layout = [];
        this.rows = 6;
        this.cols = 8;
        this.aisles = [];
        this.strategy = {
            genderBalance: true,
            gradeBalance: true,
            heightOrder: false
        };
        this.unsatisfied = [];
        this.container = null;
        this.dragSource = null;
    }

    init(container) {
        this.container = container;
        this.render();
        this.bindEvents();
        console.log('[SeatingPlanner] Initialized');
    }

    render() {
        this.container.innerHTML = `
            <div class="sp-app">
                <!-- 顶部工具栏 -->
                <header class="sp-toolbar">
                    <div class="sp-toolbar-left">
                        <h1 class="sp-title">
                            <span class="sp-title-icon">🪑</span>
                            智能座位安排
                        </h1>
                        <span class="sp-badge" id="sp-student-count">0 人</span>
                    </div>
                    <div class="sp-toolbar-right">
                        <div class="sp-legend">
                            <span class="sp-legend-item"><span class="sp-dot sp-dot-male"></span>男</span>
                            <span class="sp-legend-item"><span class="sp-dot sp-dot-female"></span>女</span>
                        </div>
                        <div class="sp-toolbar-divider"></div>
                        <button id="sp-export-png" class="sp-icon-btn" disabled title="导出图片">
                            <i data-lucide="image"></i>
                        </button>
                        <button id="sp-export-excel" class="sp-icon-btn" disabled title="导出Excel">
                            <i data-lucide="table"></i>
                        </button>
                    </div>
                </header>

                <!-- 主体区域 -->
                <main class="sp-body">
                    <!-- 左侧控制面板 -->
                    <aside class="sp-controls">
                        <!-- Tab 切换 -->
                        <div class="sp-tabs">
                            <button class="sp-tab active" data-tab="students">名单</button>
                            <button class="sp-tab" data-tab="constraints">约束</button>
                            <button class="sp-tab" data-tab="settings">设置</button>
                        </div>

                        <!-- Tab 内容 -->
                        <div class="sp-tab-content">
                            <!-- 名单 Tab -->
                            <div class="sp-panel" id="tab-students">
                                <textarea id="sp-students-input" class="sp-input" 
                                    placeholder="粘贴学生名单，每行一人&#10;&#10;支持格式:&#10;张三&#10;李四 男 85&#10;王五,女,92"></textarea>
                                <button id="sp-parse-students" class="sp-btn sp-btn-block">
                                    <i data-lucide="upload"></i> 导入名单
                                </button>
                                <div id="sp-students-preview" class="sp-preview"></div>
                            </div>

                            <!-- 约束 Tab -->
                            <div class="sp-panel hidden" id="tab-constraints">
                                <textarea id="sp-constraints-input" class="sp-input"
                                    placeholder="用自然语言描述座位要求&#10;&#10;例如:&#10;张三视力不好要坐前排&#10;李四和王五不能坐一起"></textarea>
                                <button id="sp-parse-constraints" class="sp-btn sp-btn-block">
                                    <i data-lucide="wand-2"></i> AI 解析
                                </button>
                                <div id="sp-constraints-list" class="sp-list"></div>
                            </div>

                            <!-- 设置 Tab -->
                            <div class="sp-panel hidden" id="tab-settings">
                                <div class="sp-field">
                                    <label>教室布局</label>
                                    <div class="sp-field-row">
                                        <div class="sp-field-item">
                                            <span>行</span>
                                            <input type="number" id="sp-rows" value="6" min="1" max="12">
                                        </div>
                                        <span class="sp-field-x">×</span>
                                        <div class="sp-field-item">
                                            <span>列</span>
                                            <input type="number" id="sp-cols" value="8" min="1" max="12">
                                        </div>
                                    </div>
                                </div>
                                <div class="sp-field">
                                    <label>排座策略</label>
                                    <div class="sp-switches">
                                        <label class="sp-switch">
                                            <input type="checkbox" id="sp-gender" checked>
                                            <span class="sp-switch-slider"></span>
                                            <span class="sp-switch-label">👫 男女搭配</span>
                                        </label>
                                        <label class="sp-switch">
                                            <input type="checkbox" id="sp-grade" checked>
                                            <span class="sp-switch-slider"></span>
                                            <span class="sp-switch-label">📊 强弱互补</span>
                                        </label>
                                        <label class="sp-switch">
                                            <input type="checkbox" id="sp-height">
                                            <span class="sp-switch-slider"></span>
                                            <span class="sp-switch-label">📏 身高排序</span>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- 生成按钮 -->
                        <button id="sp-generate" class="sp-btn sp-btn-primary sp-btn-block" disabled>
                            <i data-lucide="sparkles"></i> 生成座位表
                        </button>
                    </aside>

                    <!-- 右侧教室视图 -->
                    <section class="sp-classroom-wrapper">
                        <div class="sp-classroom">
                            <div class="sp-podium">📚 讲台</div>
                            <div id="sp-grid" class="sp-grid"></div>
                        </div>
                    </section>
                </main>
            </div>
        `;

        if (window.lucide) window.lucide.createIcons();
        this.renderGrid();
    }

    bindEvents() {
        // Tab 切换
        this.container.querySelectorAll('.sp-tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // 导入名单
        document.getElementById('sp-parse-students')?.addEventListener('click', () => this.parseStudents());
        
        // 解析约束
        document.getElementById('sp-parse-constraints')?.addEventListener('click', () => this.parseConstraints());
        
        // 生成座位表
        document.getElementById('sp-generate')?.addEventListener('click', () => this.generateSeating());
        
        // 导出
        document.getElementById('sp-export-png')?.addEventListener('click', () => this.exportPNG());
        document.getElementById('sp-export-excel')?.addEventListener('click', () => this.exportExcel());

        // 策略开关
        document.getElementById('sp-gender')?.addEventListener('change', e => this.strategy.genderBalance = e.target.checked);
        document.getElementById('sp-grade')?.addEventListener('change', e => this.strategy.gradeBalance = e.target.checked);
        document.getElementById('sp-height')?.addEventListener('change', e => this.strategy.heightOrder = e.target.checked);

        // 教室设置
        document.getElementById('sp-rows')?.addEventListener('change', e => {
            this.rows = parseInt(e.target.value) || 6;
            this.renderGrid();
        });
        document.getElementById('sp-cols')?.addEventListener('change', e => {
            this.cols = parseInt(e.target.value) || 8;
            this.renderGrid();
        });
    }

    switchTab(tabId) {
        // 更新 Tab 按钮
        this.container.querySelectorAll('.sp-tab').forEach(t => t.classList.remove('active'));
        this.container.querySelector(`[data-tab="${tabId}"]`)?.classList.add('active');
        
        // 更新内容
        this.container.querySelectorAll('.sp-panel').forEach(p => p.classList.add('hidden'));
        document.getElementById(`tab-${tabId}`)?.classList.remove('hidden');
    }

    renderGrid() {
        const grid = document.getElementById('sp-grid');
        if (!grid) return;

        grid.innerHTML = '';
        grid.style.gridTemplateColumns = `repeat(${this.cols}, 1fr)`;

        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const cell = document.createElement('div');
                cell.className = 'sp-seat';
                cell.dataset.row = r;
                cell.dataset.col = c;

                const studentId = this.layout[r]?.[c];
                if (studentId && studentId !== '_aisle_') {
                    const student = this.students.find(s => s.id === studentId);
                    if (student) {
                        cell.innerHTML = `<span class="sp-seat-name">${student.name}</span>`;
                        cell.classList.add('sp-seat-filled');
                        if (student.gender === 'M') cell.classList.add('sp-seat-male');
                        if (student.gender === 'F') cell.classList.add('sp-seat-female');

                        // 拖拽
                        cell.setAttribute('draggable', 'true');
                        cell.addEventListener('dragstart', e => this.handleDragStart(e, r, c));
                        cell.addEventListener('dragend', e => this.handleDragEnd(e));

                        // 约束图标
                        const icons = this.getConstraintIcons(student.id);
                        if (icons) {
                            cell.insertAdjacentHTML('beforeend', `<span class="sp-seat-icons">${icons}</span>`);
                        }
                    }
                }

                // Drop 目标
                cell.addEventListener('dragover', e => this.handleDragOver(e));
                cell.addEventListener('dragenter', e => this.handleDragEnter(e, cell));
                cell.addEventListener('dragleave', e => this.handleDragLeave(e, cell));
                cell.addEventListener('drop', e => this.handleDrop(e, r, c));

                grid.appendChild(cell);
            }
        }
    }

    getConstraintIcons(studentId) {
        const icons = [];
        for (const c of this.constraints) {
            if (c.target === studentId || c.related === studentId) {
                const unsatisfied = this.unsatisfied.find(u => u.target === studentId);
                if (c.type === 'front_row') icons.push(unsatisfied ? '👓⚠️' : '👓');
                else if (c.type === 'avoid') icons.push(unsatisfied ? '🚫⚠️' : '🚫');
                else if (c.type === 'prefer' || c.type === 'pair') icons.push(unsatisfied ? '💔' : '❤️');
            }
        }
        return icons.join('');
    }

    // ========== 拖拽 ==========
    handleDragStart(e, row, col) {
        this.dragSource = { row, col };
        e.target.classList.add('sp-dragging');
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => e.target.style.opacity = '0.4', 0);
    }

    handleDragEnd(e) {
        e.target.classList.remove('sp-dragging');
        e.target.style.opacity = '1';
        this.dragSource = null;
        document.querySelectorAll('.sp-seat.sp-drag-over').forEach(c => c.classList.remove('sp-drag-over'));
    }

    handleDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
    handleDragEnter(e, cell) { e.preventDefault(); if (!cell.classList.contains('sp-dragging')) cell.classList.add('sp-drag-over'); }
    handleDragLeave(e, cell) { cell.classList.remove('sp-drag-over'); }

    handleDrop(e, targetRow, targetCol) {
        e.preventDefault();
        e.currentTarget.classList.remove('sp-drag-over');
        if (!this.dragSource) return;
        const { row: sr, col: sc } = this.dragSource;
        if (sr === targetRow && sc === targetCol) return;
        this.swapSeats(sr, sc, targetRow, targetCol);
    }

    swapSeats(r1, c1, r2, c2) {
        if (!this.layout[r1]) this.layout[r1] = [];
        if (!this.layout[r2]) this.layout[r2] = [];
        const temp = this.layout[r1][c1];
        this.layout[r1][c1] = this.layout[r2][c2];
        this.layout[r2][c2] = temp;
        this.renderGrid();
        const s1 = this.students.find(s => s.id === this.layout[r1][c1]);
        const s2 = this.students.find(s => s.id === this.layout[r2][c2]);
        this.showToast(`已交换: ${s2?.name || '空位'} ↔ ${s1?.name || '空位'}`, 'success');
    }

    // ========== API 调用 ==========
    async parseStudents() {
        const text = document.getElementById('sp-students-input')?.value?.trim();
        if (!text) return this.showToast('请输入学生名单', 'warning');

        try {
            const res = await fetch('/api/tools/seating/parse-students', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            const result = await res.json();
            if (!result.success) throw new Error(result.error);

            this.students = result.data.students;
            document.getElementById('sp-student-count').textContent = `${result.data.count} 人`;
            document.getElementById('sp-generate').disabled = false;
            
            // 预览
            const preview = document.getElementById('sp-students-preview');
            preview.innerHTML = result.data.students.slice(0, 8).map(s => 
                `<span class="sp-tag ${s.gender === 'M' ? 'sp-tag-male' : s.gender === 'F' ? 'sp-tag-female' : ''}">${s.name}</span>`
            ).join('') + (result.data.count > 8 ? `<span class="sp-tag">+${result.data.count - 8}</span>` : '');
            
            this.showToast(`导入 ${result.data.count} 名学生`, 'success');
        } catch (err) {
            this.showToast(err.message, 'error');
        }
    }

    async parseConstraints() {
        const text = document.getElementById('sp-constraints-input')?.value?.trim();
        if (!text) return this.showToast('请输入约束描述', 'warning');

        try {
            const res = await fetch('/api/tools/seating/parse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, students: this.students })
            });
            const result = await res.json();
            if (!result.success) throw new Error(result.error);

            this.constraints = result.data.constraints;
            const list = document.getElementById('sp-constraints-list');
            list.innerHTML = this.constraints.map(c => {
                const icon = { front_row: '👓', avoid: '🚫', prefer: '💛', pair: '❤️' }[c.type] || '📌';
                return `<div class="sp-list-item">
                    <span class="sp-list-icon">${icon}</span>
                    <span class="sp-list-text">${c.target}${c.related ? ` ⇄ ${c.related}` : ''}: ${c.reason}</span>
                </div>`;
            }).join('') || '<div class="sp-empty">暂无约束</div>';
            
            this.showToast(`识别 ${this.constraints.length} 条约束`, 'success');
        } catch (err) {
            this.showToast(err.message, 'error');
        }
    }

    async generateSeating() {
        if (!this.students.length) return this.showToast('请先导入名单', 'warning');

        const btn = document.getElementById('sp-generate');
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> 生成中...';
        if (window.lucide) window.lucide.createIcons();

        try {
            const res = await fetch('/api/tools/seating/plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    students: this.students, constraints: this.constraints,
                    strategy: this.strategy, rows: this.rows, cols: this.cols, aisles: this.aisles
                })
            });
            const result = await res.json();
            if (!result.success) throw new Error(result.error);

            this.layout = result.data.layout;
            this.unsatisfied = result.data.unsatisfied || [];
            this.renderGrid();
            
            document.getElementById('sp-export-png').disabled = false;
            document.getElementById('sp-export-excel').disabled = false;
            this.showToast('座位表生成成功!', 'success');
        } catch (err) {
            this.showToast(err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="sparkles"></i> 生成座位表';
            if (window.lucide) window.lucide.createIcons();
        }
    }

    async exportPNG() {
        try {
            if (!window.html2canvas) {
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
                document.head.appendChild(s);
                await new Promise(r => s.onload = r);
            }
            const canvas = await window.html2canvas(document.querySelector('.sp-classroom'), { backgroundColor: '#0f172a', scale: 2 });
            const link = document.createElement('a');
            link.download = `座位表_${new Date().toISOString().split('T')[0]}.png`;
            link.href = canvas.toDataURL();
            link.click();
            this.showToast('图片已下载', 'success');
        } catch (err) {
            this.showToast('导出失败', 'error');
        }
    }

    exportExcel() {
        let csv = '\uFEFF';
        for (let r = 0; r < this.rows; r++) {
            const row = [];
            for (let c = 0; c < this.cols; c++) {
                const id = this.layout[r]?.[c];
                row.push(this.students.find(s => s.id === id)?.name || '');
            }
            csv += row.join(',') + '\n';
        }
        const link = document.createElement('a');
        link.download = `座位表_${new Date().toISOString().split('T')[0]}.csv`;
        link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        link.click();
        this.showToast('Excel 已下载', 'success');
    }

    showToast(msg, type = 'info') {
        window.ICeCream?.showToast ? window.ICeCream.showToast(msg, type) : console.log(`[${type}] ${msg}`);
    }
}

const seatingPlanner = new SeatingPlanner();
export function init(container) { seatingPlanner.init(container); }
export default seatingPlanner;
