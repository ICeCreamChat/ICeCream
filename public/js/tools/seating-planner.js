/**
 * Smart Seating Planner - 智能座位编排系统
 * 前端模块
 */

class SeatingPlanner {
    constructor() {
        this.students = [];
        this.constraints = [];
        this.layout = [];
        this.rows = 6;
        this.cols = 8;
        this.aisles = [4]; // 默认中间过道
        this.strategy = {
            genderBalance: true,
            gradeBalance: true,
            heightOrder: false
        };
        this.unsatisfied = [];
        this.container = null;
    }

    /**
     * 初始化模块
     */
    init(container) {
        this.container = container;
        this.render();
        this.bindEvents();
        console.log('[SeatingPlanner] Initialized');
    }

    /**
     * 渲染主界面
     */
    render() {
        this.container.innerHTML = `
            <div class="seating-planner">
                <div class="sp-sidebar">
                    <!-- 学生名单 -->
                    <div class="sp-section">
                        <div class="sp-section-header">
                            <span>📝 学生名单</span>
                            <span class="sp-count" id="sp-student-count">0 人</span>
                        </div>
                        <textarea id="sp-students-input" class="sp-textarea" 
                            placeholder="粘贴学生名单 (支持 Excel)
格式: 姓名 [性别] [成绩]
例如:
张三	男	85
李四	女	92"></textarea>
                        <button id="sp-parse-students" class="sp-btn sp-btn-secondary">
                            <i data-lucide="upload"></i> 导入名单
                        </button>
                        <div id="sp-students-preview" class="sp-preview hidden"></div>
                    </div>

                    <!-- 约束描述 -->
                    <div class="sp-section">
                        <div class="sp-section-header">
                            <span>📣 约束描述</span>
                        </div>
                        <textarea id="sp-constraints-input" class="sp-textarea" 
                            placeholder="用自然语言描述要求，例如:
张三视力不好要坐前排
李四和王五老说话别放一起
赵六想跟钱七坐"></textarea>
                        <button id="sp-parse-constraints" class="sp-btn sp-btn-secondary">
                            <i data-lucide="search"></i> 解析约束
                        </button>
                    </div>

                    <!-- 策略开关 -->
                    <div class="sp-section">
                        <div class="sp-section-header">
                            <span>⚙️ 排座策略</span>
                        </div>
                        <div class="sp-strategies">
                            <label class="sp-checkbox">
                                <input type="checkbox" id="sp-gender" checked>
                                <span>👫 男女搭配</span>
                            </label>
                            <label class="sp-checkbox">
                                <input type="checkbox" id="sp-grade" checked>
                                <span>📊 强弱互补</span>
                            </label>
                            <label class="sp-checkbox">
                                <input type="checkbox" id="sp-height">
                                <span>📏 身高排序</span>
                            </label>
                        </div>
                    </div>

                    <!-- 教室设置 -->
                    <div class="sp-section">
                        <div class="sp-section-header">
                            <span>🏫 教室设置</span>
                        </div>
                        <div class="sp-grid-settings">
                            <label>
                                行数: <input type="number" id="sp-rows" value="6" min="1" max="10">
                            </label>
                            <label>
                                列数: <input type="number" id="sp-cols" value="8" min="1" max="12">
                            </label>
                        </div>
                    </div>
                </div>

                <div class="sp-main">
                    <!-- 教室视图 -->
                    <div class="sp-classroom">
                        <div class="sp-blackboard">讲 台</div>
                        <div id="sp-grid" class="sp-grid"></div>
                    </div>

                    <!-- 约束状态 -->
                    <div class="sp-constraints-panel">
                        <div class="sp-section-header">
                            <span>📊 约束状态</span>
                        </div>
                        <div id="sp-constraints-list" class="sp-constraints-list">
                            <div class="sp-empty">暂无约束</div>
                        </div>
                    </div>

                    <!-- 操作按钮 -->
                    <div class="sp-actions">
                        <button id="sp-generate" class="sp-btn sp-btn-primary" disabled>
                            <i data-lucide="sparkles"></i> 生成座位表
                        </button>
                        <button id="sp-export-png" class="sp-btn sp-btn-secondary" disabled>
                            <i data-lucide="image"></i> 导出图片
                        </button>
                        <button id="sp-export-excel" class="sp-btn sp-btn-secondary" disabled>
                            <i data-lucide="table"></i> 导出Excel
                        </button>
                    </div>
                </div>
            </div>
        `;

        // 刷新 Lucide 图标
        if (window.lucide) window.lucide.createIcons();

        // 渲染空网格
        this.renderGrid();
    }

    /**
     * 绑定事件
     */
    bindEvents() {
        // 导入名单
        document.getElementById('sp-parse-students')?.addEventListener('click', () => {
            this.parseStudents();
        });

        // 解析约束
        document.getElementById('sp-parse-constraints')?.addEventListener('click', () => {
            this.parseConstraints();
        });

        // 生成座位表
        document.getElementById('sp-generate')?.addEventListener('click', () => {
            this.generateSeating();
        });

        // 导出 PNG
        document.getElementById('sp-export-png')?.addEventListener('click', () => {
            this.exportPNG();
        });

        // 导出 Excel
        document.getElementById('sp-export-excel')?.addEventListener('click', () => {
            this.exportExcel();
        });

        // 策略开关
        document.getElementById('sp-gender')?.addEventListener('change', (e) => {
            this.strategy.genderBalance = e.target.checked;
        });
        document.getElementById('sp-grade')?.addEventListener('change', (e) => {
            this.strategy.gradeBalance = e.target.checked;
        });
        document.getElementById('sp-height')?.addEventListener('change', (e) => {
            this.strategy.heightOrder = e.target.checked;
        });

        // 教室设置
        document.getElementById('sp-rows')?.addEventListener('change', (e) => {
            this.rows = parseInt(e.target.value) || 6;
            this.renderGrid();
        });
        document.getElementById('sp-cols')?.addEventListener('change', (e) => {
            this.cols = parseInt(e.target.value) || 8;
            this.renderGrid();
        });
    }

    /**
     * 渲染座位网格
     */
    renderGrid() {
        const grid = document.getElementById('sp-grid');
        if (!grid) return;

        grid.innerHTML = '';
        grid.style.gridTemplateColumns = `repeat(${this.cols}, 1fr)`;

        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const cell = document.createElement('div');
                cell.className = 'sp-cell';
                cell.dataset.row = r;
                cell.dataset.col = c;

                // 过道
                if (this.aisles.includes(c)) {
                    cell.classList.add('sp-aisle');
                } else {
                    // 查找此位置的学生
                    const studentId = this.layout[r]?.[c];
                    if (studentId && studentId !== '_aisle_') {
                        const student = this.students.find(s => s.id === studentId);
                        if (student) {
                            cell.innerHTML = this.renderStudentCard(student);
                            cell.classList.add('sp-occupied');
                            
                            // 性别颜色
                            if (student.gender === 'M') cell.classList.add('sp-male');
                            if (student.gender === 'F') cell.classList.add('sp-female');
                            
                            // 约束状态图标
                            const icons = this.getConstraintIcons(student.id);
                            if (icons) {
                                cell.querySelector('.sp-card')?.insertAdjacentHTML('beforeend', 
                                    `<div class="sp-icons">${icons}</div>`);
                            }
                        }
                    }
                }

                grid.appendChild(cell);
            }
        }
    }

    /**
     * 渲染学生卡片
     */
    renderStudentCard(student) {
        return `
            <div class="sp-card" data-id="${student.id}">
                <span class="sp-name">${student.name}</span>
            </div>
        `;
    }

    /**
     * 获取学生约束图标
     */
    getConstraintIcons(studentId) {
        const icons = [];
        
        for (const c of this.constraints) {
            if (c.target === studentId || c.related === studentId) {
                // 检查是否满足
                const unsatisfied = this.unsatisfied.find(u => u.target === studentId);
                
                if (c.type === 'front_row') {
                    icons.push(unsatisfied ? '👓⚠️' : '👓');
                } else if (c.type === 'avoid') {
                    icons.push(unsatisfied ? '🚫⚠️' : '🚫');
                } else if (c.type === 'prefer' || c.type === 'pair') {
                    icons.push(unsatisfied ? '💔' : '❤️');
                }
            }
        }
        
        return icons.join('');
    }

    /**
     * 解析学生名单
     */
    async parseStudents() {
        const input = document.getElementById('sp-students-input');
        const text = input?.value?.trim();
        
        if (!text) {
            this.showToast('请输入学生名单', 'warning');
            return;
        }

        try {
            const response = await fetch('/api/tools/seating/parse-students', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });

            const result = await response.json();
            
            if (!result.success) {
                throw new Error(result.error);
            }

            this.students = result.data.students;
            this.updateStudentCount();
            this.showStudentsPreview(result.data);
            
            // 启用生成按钮
            document.getElementById('sp-generate').disabled = false;
            
            this.showToast(`成功导入 ${result.data.count} 名学生`, 'success');

        } catch (error) {
            console.error('[SeatingPlanner] Parse students error:', error);
            this.showToast(error.message, 'error');
        }
    }

    /**
     * 显示学生预览
     */
    showStudentsPreview(data) {
        const preview = document.getElementById('sp-students-preview');
        if (!preview) return;

        preview.classList.remove('hidden');
        preview.innerHTML = `
            <div class="sp-preview-header">
                识别到 ${data.count} 人
                ${data.hasGender ? '✓性别' : ''}
                ${data.hasGrade ? '✓成绩' : ''}
            </div>
            <div class="sp-preview-list">
                ${data.students.slice(0, 5).map(s => 
                    `<span class="sp-preview-tag ${s.gender === 'M' ? 'sp-male' : s.gender === 'F' ? 'sp-female' : ''}">
                        ${s.name}
                    </span>`
                ).join('')}
                ${data.count > 5 ? `<span class="sp-preview-more">+${data.count - 5}</span>` : ''}
            </div>
        `;
    }

    /**
     * 更新学生数量显示
     */
    updateStudentCount() {
        const countEl = document.getElementById('sp-student-count');
        if (countEl) {
            countEl.textContent = `${this.students.length} 人`;
        }
    }

    /**
     * 解析约束条件
     */
    async parseConstraints() {
        const input = document.getElementById('sp-constraints-input');
        const text = input?.value?.trim();
        
        if (!text) {
            this.showToast('请输入约束描述', 'warning');
            return;
        }

        try {
            const response = await fetch('/api/tools/seating/parse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    text,
                    students: this.students 
                })
            });

            const result = await response.json();
            
            if (!result.success) {
                throw new Error(result.error);
            }

            this.constraints = result.data.constraints;
            this.renderConstraintsList();
            
            this.showToast(`识别到 ${this.constraints.length} 条约束`, 'success');

        } catch (error) {
            console.error('[SeatingPlanner] Parse constraints error:', error);
            this.showToast(error.message, 'error');
        }
    }

    /**
     * 渲染约束列表
     */
    renderConstraintsList() {
        const list = document.getElementById('sp-constraints-list');
        if (!list) return;

        if (this.constraints.length === 0) {
            list.innerHTML = '<div class="sp-empty">暂无约束</div>';
            return;
        }

        list.innerHTML = this.constraints.map(c => {
            const typeIcons = {
                front_row: '👓',
                back_row: '🔙',
                avoid: '🚫',
                prefer: '💛',
                pair: '❤️'
            };
            const icon = typeIcons[c.type] || '📌';
            const isHard = c.priority === 'hard';
            
            return `
                <div class="sp-constraint-item ${isHard ? 'sp-hard' : 'sp-soft'}">
                    <span class="sp-constraint-icon">${icon}</span>
                    <span class="sp-constraint-text">
                        ${c.target} ${c.related ? `⇄ ${c.related}` : ''}: ${c.reason}
                    </span>
                    <span class="sp-constraint-badge">${isHard ? '必须' : '尽量'}</span>
                </div>
            `;
        }).join('');
    }

    /**
     * 生成座位表
     */
    async generateSeating() {
        if (this.students.length === 0) {
            this.showToast('请先导入学生名单', 'warning');
            return;
        }

        const generateBtn = document.getElementById('sp-generate');
        generateBtn.disabled = true;
        generateBtn.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> 生成中...';
        if (window.lucide) window.lucide.createIcons();

        try {
            const response = await fetch('/api/tools/seating/plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    students: this.students,
                    constraints: this.constraints,
                    strategy: this.strategy,
                    rows: this.rows,
                    cols: this.cols,
                    aisles: this.aisles
                })
            });

            const result = await response.json();
            
            if (!result.success) {
                throw new Error(result.error);
            }

            this.layout = result.data.layout;
            this.unsatisfied = result.data.unsatisfied || [];
            
            this.renderGrid();
            this.renderUnsatisfiedList();
            
            // 启用导出按钮
            document.getElementById('sp-export-png').disabled = false;
            document.getElementById('sp-export-excel').disabled = false;
            
            this.showToast('座位表生成成功！', 'success');

        } catch (error) {
            console.error('[SeatingPlanner] Generate error:', error);
            this.showToast(error.message, 'error');
        } finally {
            generateBtn.disabled = false;
            generateBtn.innerHTML = '<i data-lucide="sparkles"></i> 生成座位表';
            if (window.lucide) window.lucide.createIcons();
        }
    }

    /**
     * 渲染未满足约束
     */
    renderUnsatisfiedList() {
        if (this.unsatisfied.length === 0) return;

        const list = document.getElementById('sp-constraints-list');
        if (!list) return;

        const unsatisfiedHtml = this.unsatisfied.map(u => `
            <div class="sp-constraint-item sp-unsatisfied">
                <span class="sp-constraint-icon">⚠️</span>
                <span class="sp-constraint-text">${u.target}: ${u.reason}</span>
            </div>
        `).join('');

        list.insertAdjacentHTML('beforeend', unsatisfiedHtml);
    }

    /**
     * 导出 PNG
     */
    async exportPNG() {
        try {
            // 动态加载 html2canvas
            if (!window.html2canvas) {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
                document.head.appendChild(script);
                await new Promise(resolve => script.onload = resolve);
            }

            const grid = document.querySelector('.sp-classroom');
            const canvas = await window.html2canvas(grid, {
                backgroundColor: '#0f172a',
                scale: 2
            });

            const link = document.createElement('a');
            link.download = `座位表_${new Date().toISOString().split('T')[0]}.png`;
            link.href = canvas.toDataURL();
            link.click();

            this.showToast('图片已下载', 'success');

        } catch (error) {
            console.error('[SeatingPlanner] Export PNG error:', error);
            this.showToast('导出失败: ' + error.message, 'error');
        }
    }

    /**
     * 导出 Excel (CSV)
     */
    exportExcel() {
        try {
            let csv = '\uFEFF'; // BOM for UTF-8
            
            for (let r = 0; r < this.rows; r++) {
                const row = [];
                for (let c = 0; c < this.cols; c++) {
                    if (this.aisles.includes(c)) {
                        row.push('');
                    } else {
                        const studentId = this.layout[r]?.[c];
                        const student = this.students.find(s => s.id === studentId);
                        row.push(student?.name || '');
                    }
                }
                csv += row.join(',') + '\n';
            }

            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const link = document.createElement('a');
            link.download = `座位表_${new Date().toISOString().split('T')[0]}.csv`;
            link.href = URL.createObjectURL(blob);
            link.click();

            this.showToast('Excel 已下载', 'success');

        } catch (error) {
            console.error('[SeatingPlanner] Export Excel error:', error);
            this.showToast('导出失败: ' + error.message, 'error');
        }
    }

    /**
     * 显示 Toast
     */
    showToast(message, type = 'info') {
        if (window.ICeCream?.showToast) {
            window.ICeCream.showToast(message, type);
        } else {
            console.log(`[Toast/${type}] ${message}`);
        }
    }
}

// 导出
const seatingPlanner = new SeatingPlanner();
export function init(container) {
    seatingPlanner.init(container);
}
export default seatingPlanner;
