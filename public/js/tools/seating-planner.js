/**
 * Smart Seating Planner - 智能座位编排系统
 * Professional Redesign - Based on UI/UX Pro Max
 */

class SeatingPlanner {
    constructor() {
        this.students = [];
        this.constraints = [];
        this.layout = [];
        this.rows = 6;
        this.cols = 8;
        this.colAisles = [];
        this.rowAisles = [];
        this.strategy = {
            genderBalance: true,
            gradeBalance: true,
            heightOrder: false
        };
        this.unsatisfied = [];
        this.container = null;
        this.dragSource = null;
        this.contextTarget = null;
        // Guardians: [Left, Right]
        // Coords: Row -1, Col 0 (Left), Col 1 (Right)
        this.guardians = [null, null];
    }

    init(container) {
        this.container = container;
        this.render();
        this.bindEvents();
        this.bindPodiumEvents(); // Bind events for static podium seats
        console.log('[SeatingPlanner] Initialized with new design');
    }

    // ... (render method remains mostly same, but we need to ensure renderPodiumSeats is called) ...

    // Helper to get seat value (student ID or null)
    getSeat(r, c) {
        if (r === -1) {
            return this.guardians[c];
        }
        return this.layout[r]?.[c];
    }

    // Helper to set seat value
    setSeat(r, c, val) {
        if (r === -1) {
            this.guardians[c] = val;
        } else {
            if (!this.layout[r]) this.layout[r] = [];
            this.layout[r][c] = val;
        }
    }

    // ... existing methods ...

    // ========== Podium / Guardian Seats ==========
    
    bindPodiumEvents() {
        const left = document.getElementById('sp-guardian-left');
        const right = document.getElementById('sp-guardian-right');
        
        [left, right].forEach((seat, index) => {
            if (!seat) return;
            
            // Drag Start
            seat.addEventListener('dragstart', e => this.handleDragStart(e, -1, index));
            seat.addEventListener('dragend', e => this.handleDragEnd(e));
            
            // Drop Target
            seat.addEventListener('dragover', e => this.handleDragOver(e));
            seat.addEventListener('dragenter', e => this.handleDragEnter(e, seat));
            seat.addEventListener('dragleave', e => this.handleDragLeave(e, seat));
            seat.addEventListener('drop', e => this.handleDrop(e, -1, index)); // Row -1
            
            // Context Menu (optional, maybe just clear)
            seat.addEventListener('contextmenu', e => {
                e.preventDefault();
                if (this.guardians[index]) {
                    // Simple clear for now or custom menu
                     if (confirm('是否清空该护法座位?')) {
                         this.guardians[index] = null;
                         this.renderPodiumSeats();
                     }
                }
            });
        });
    }

    renderPodiumSeats() {
        const left = document.getElementById('sp-guardian-left');
        const right = document.getElementById('sp-guardian-right');
        
        [left, right].forEach((seat, index) => {
            if (!seat) return;
            const studentId = this.guardians[index];
            
            // Clear current content (keep the desk div if we want, but easiest is rebuild)
            seat.innerHTML = '';
            
            // Reset classes
            seat.className = 'sp-seat sp-seat--guardian';
            
            if (studentId) {
                const student = this.students.find(s => s.id === studentId);
                if (student) {
                    seat.classList.add('sp-seat--filled');
                    seat.dataset.studentId = student.id;
                    seat.setAttribute('draggable', 'true'); // Make draggable

                    // === The Desk ===
                    const desk = document.createElement('div');
                    desk.className = 'sp-desk';
                    
                    // Name Tag
                    const nameTag = document.createElement('span');
                    nameTag.className = 'sp-name-tag';
                    nameTag.textContent = student.name;
                    desk.appendChild(nameTag);
                    
                    seat.appendChild(desk);
                    
                    // === The Chair Back ===
                    const chair = document.createElement('div');
                    chair.className = `sp-chair sp-chair--${student.gender === 'M' ? 'male' : 'female'}`;
                    seat.appendChild(chair);

                     // === Tooltip ===
                    const tooltip = document.createElement('div');
                    tooltip.className = 'sp-seat-tooltip';
                    tooltip.textContent = `${student.name} (左右护法)`;
                    seat.appendChild(tooltip);

                } else {
                     // Invalid ID? Treat as empty
                     this.guardians[index] = null;
                     seat.classList.add('sp-seat--empty');
                     const desk = document.createElement('div');
                     desk.className = 'sp-desk';
                     seat.appendChild(desk);
                     seat.removeAttribute('draggable');
                }
            } else {
                seat.classList.add('sp-seat--empty');
                const desk = document.createElement('div');
                desk.className = 'sp-desk';
                seat.appendChild(desk);
                seat.removeAttribute('draggable');
            }
        });
    }

    // ... (existing renderGrid) ...

    // ========== Drag & Drop ==========
    handleDragStart(e, row, col) {
        this.dragSource = { row, col };
        e.target.classList.add('sp-seat--dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Use timeout to allow drag image to be generated before hiding element
        setTimeout(() => e.target.style.opacity = '0.4', 0);
    }

    handleDragEnd(e) {
        e.target.classList.remove('sp-seat--dragging');
        e.target.style.opacity = '1';
        this.dragSource = null;
        document.querySelectorAll('.sp-seat--drag-over').forEach(c => c.classList.remove('sp-seat--drag-over'));
    }

    handleDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
    
    updatedHandleDragEnter(e, cell) { // Renamed to avoid conflict if just pasting snippet? No, overwrite.
         e.preventDefault(); 
         if (!cell.classList.contains('sp-seat--dragging')) cell.classList.add('sp-seat--drag-over'); 
    }

    handleDragLeave(e, cell) { cell.classList.remove('sp-seat--drag-over'); }

    handleDrop(e, targetRow, targetCol) {
        e.preventDefault();
        e.currentTarget.classList.remove('sp-seat--drag-over');
        
        if (!this.dragSource) return;
        const { row: sr, col: sc } = this.dragSource;
        
        if (sr === targetRow && sc === targetCol) return;
        
        this.swapSeats(sr, sc, targetRow, targetCol);
    }

    swapSeats(r1, c1, r2, c2) {
        const val1 = this.getSeat(r1, c1);
        const val2 = this.getSeat(r2, c2);

        this.setSeat(r1, c1, val2);
        this.setSeat(r2, c2, val1);
        
        this.renderGrid();
        this.renderPodiumSeats(); // Update podium logic
        
        const s1 = this.students.find(s => s.id === val1);
        const s2 = this.students.find(s => s.id === val2);
        
        // Custom Toast for Guardian
        if (r1 === -1 || r2 === -1) {
             this.showToast(`护法位已更新`, 'success');
        } else {
             this.showToast(`已交换: ${s2?.name || '空位'} ↔ ${s1?.name || '空位'}`, 'success');
        }
    }

    render() {
        this.container.innerHTML = `
            <div class="sp-app">
                <!-- Header -->
                <header class="sp-header">
                    <div class="sp-header-left">
                        <h1 class="sp-title">
                            <span class="sp-title-icon">
                                <i data-lucide="layout-grid"></i>
                            </span>
                            智能座位安排
                        </h1>
                        <span class="sp-badge" id="sp-student-count">
                            <i data-lucide="users"></i>
                            <span>0 人</span>
                        </span>
                    </div>
                    <div class="sp-header-right">
                        <div class="sp-legend">
                            <span class="sp-legend-item">
                                <span class="sp-legend-dot sp-legend-dot--male"></span>男
                            </span>
                            <span class="sp-legend-item">
                                <span class="sp-legend-dot sp-legend-dot--female"></span>女
                            </span>
                        </div>
                        <button id="sp-export-png" class="sp-icon-btn" disabled title="导出图片">
                            <i data-lucide="image"></i>
                        </button>
                        <button id="sp-export-excel" class="sp-icon-btn" disabled title="导出Excel">
                            <i data-lucide="table"></i>
                        </button>
                    </div>
                </header>

                <!-- Main content -->
                <main class="sp-main">
                    <!-- Left Panel -->
                    <aside class="sp-panel">
                        <!-- Students Section -->
                        <section class="sp-section">
                            <div class="sp-section-header">
                                <h3 class="sp-section-title">
                                    <i data-lucide="users"></i>
                                    学生名单
                                </h3>
                                <div class="sp-section-actions">
                                    <input type="file" id="sp-image-input" accept="image/*" style="display:none">
                                    <button class="sp-section-action" id="sp-upload-image" title="拍照/上传图片">
                                        <i data-lucide="camera"></i>
                                    </button>
                                    <button class="sp-section-action" id="sp-clear-students" title="清空">
                                        <i data-lucide="trash-2"></i>
                                    </button>
                                </div>
                            </div>
                            <div class="sp-dropzone" id="sp-dropzone">
                                <input type="file" id="sp-file-input" class="sp-file-input" accept=".csv,.xlsx,.xls,.txt">
                                <div class="sp-dropzone-icon">
                                    <i data-lucide="upload"></i>
                                </div>
                                <div class="sp-dropzone-text">点击选择或拖拽文件</div>
                                <div class="sp-dropzone-hint">支持 Excel / CSV / 文本</div>
                            </div>
                            <textarea id="sp-students-input" class="sp-textarea sp-hidden" 
                                placeholder="粘贴学生名单，每行一人&#10;&#10;支持格式:&#10;张三&#10;李四 男 85"></textarea>
                            <button id="sp-parse-students" class="sp-btn sp-btn--block sp-btn--sm sp-hidden">
                                <i data-lucide="check"></i>
                                确认导入
                            </button>
                            <div id="sp-students-preview" class="sp-tags"></div>
                        </section>

                        <!-- Constraints Section -->
                        <section class="sp-section">
                            <div class="sp-section-header">
                                <h3 class="sp-section-title">
                                    <i data-lucide="link"></i>
                                    座位约束
                                </h3>
                            </div>
                            <textarea id="sp-constraints-input" class="sp-textarea"
                                placeholder="用自然语言描述座位要求&#10;&#10;例如:&#10;张三视力不好要坐前排&#10;李四和王五不能坐一起"></textarea>
                            <button id="sp-parse-constraints" class="sp-btn sp-btn--block sp-btn--sm">
                                <i data-lucide="sparkles"></i>
                                AI 解析
                            </button>
                            <div id="sp-constraints-list" class="sp-constraints"></div>
                        </section>

                        <!-- Strategy Section -->
                        <section class="sp-section">
                            <div class="sp-section-header">
                                <h3 class="sp-section-title">
                                    <i data-lucide="settings"></i>
                                    排座策略
                                </h3>
                            </div>
                            <div class="sp-strategies">
                                <label class="sp-strategy">
                                    <input type="checkbox" id="sp-gender" checked>
                                    <span class="sp-strategy-toggle"></span>
                                    <span class="sp-strategy-label">
                                        <i data-lucide="users"></i>
                                        男女搭配
                                    </span>
                                </label>
                                <label class="sp-strategy">
                                    <input type="checkbox" id="sp-grade" checked>
                                    <span class="sp-strategy-toggle"></span>
                                    <span class="sp-strategy-label">
                                        <i data-lucide="bar-chart-3"></i>
                                        强弱互补
                                    </span>
                                </label>
                                <label class="sp-strategy">
                                    <input type="checkbox" id="sp-height">
                                    <span class="sp-strategy-toggle"></span>
                                    <span class="sp-strategy-label">
                                        <i data-lucide="arrow-up-down"></i>
                                        身高排序
                                    </span>
                                </label>
                            </div>
                        </section>

                        <!-- Grid size -->
                        <section class="sp-section">
                            <div class="sp-section-header">
                                <h3 class="sp-section-title">
                                    <i data-lucide="grid-3x3"></i>
                                    教室布局
                                </h3>
                            </div>
                            <div class="sp-layout-controls">
                                <label class="sp-layout-input">
                                    <span>行</span>
                                    <input type="number" id="sp-rows" value="6" min="1" max="12">
                                </label>
                                <span class="sp-layout-sep">×</span>
                                <label class="sp-layout-input">
                                    <span>列</span>
                                    <input type="number" id="sp-cols" value="8" min="1" max="12">
                                </label>
                            </div>
                        </section>

                        <!-- Generate Button -->
                        <button id="sp-generate" class="sp-btn sp-btn--primary sp-btn--block" disabled>
                            <i data-lucide="sparkles"></i>
                            生成座位表
                        </button>
                    </aside>

                    <!-- Right Classroom -->
                    <section class="sp-classroom">
                        <div class="sp-classroom-view">
                            <!-- Cinematic Blackboard Scene -->
                            <div class="sp-blackboard-scene">
                                <!-- The Blackboard -->
                                <div class="sp-blackboard" id="sp-blackboard">
                                    <div class="sp-blackboard-frame"></div>
                                    
                                    <!-- Ghost Symbols (High School Subjects) -->
                                    <div class="sp-blackboard-notes">
                                        <div>今天也要加油 ✨</div>
                                        <div>本项目感谢李妮姗女士出谋划策 ✨</div>
                                    </div>
                                    <!-- Chalk Tray -->
                                    <div class="sp-chalk-tray" id="sp-chalk-tray">
                                        <div class="sp-chalk sp-chalk--white"></div>
                                        <div class="sp-chalk sp-chalk--red"></div>
                                        <div class="sp-chalk sp-chalk--yellow"></div>
                                        <div class="sp-eraser"></div>
                                        <div class="sp-chalk sp-chalk--blue"></div>
                                    </div>
                                </div>
                                
                                <!-- Podium Row: Left Guardian + Podium + Right Guardian -->
                                <div class="sp-podium-row" id="sp-podium-row">
                                    <!-- Left Guardian Seat -->
                                    <div class="sp-seat sp-seat--guardian sp-seat--empty" id="sp-guardian-left">
                                        <div class="sp-desk"></div>
                                    </div>
                                    
                                    <!-- Podium (Center) -->
                                    <div class="sp-podium" id="sp-podium">
                                        <div class="sp-podium-toggle" id="sp-podium-toggle" title="启用/禁用左右护法"></div>
                                    </div>
                                    
                                    <!-- Right Guardian Seat -->
                                    <div class="sp-seat sp-seat--guardian sp-seat--empty" id="sp-guardian-right">
                                        <div class="sp-desk"></div>
                                    </div>
                                </div>
                            </div>
                            
                            <div id="sp-grid" class="sp-grid"></div>
                        </div>
                        <div class="sp-status" id="sp-status">
                            <div class="sp-status-left">
                                <span class="sp-status-item">
                                    <i data-lucide="info"></i>
                                    点击右键设置过道
                                </span>
                            </div>
                            <div class="sp-status-right"></div>
                        </div>
                    </section>
                </main>

                <!-- Context Menu -->
                <div id="sp-context-menu" class="sp-context-menu">
                    <button class="sp-context-item" data-action="set-col-aisle">
                        <i data-lucide="move-vertical"></i>
                        设为竖过道（整列）
                    </button>
                    <button class="sp-context-item" data-action="set-row-aisle">
                        <i data-lucide="move-horizontal"></i>
                        设为横过道（整行）
                    </button>
                    <button class="sp-context-item" data-action="clear-aisle">
                        <i data-lucide="square"></i>
                        取消过道
                    </button>
                    <div class="sp-context-divider"></div>
                    <button class="sp-context-item" data-action="clear-seat">
                        <i data-lucide="user-minus"></i>
                        清空座位
                    </button>
                </div>
            </div>
        `;

        if (window.lucide) window.lucide.createIcons();
        this.renderGrid();

        // Initialize Blackboard Text Interaction
        this.initBlackboardText();
        this.initPodiumToggle();
    }

    initPodiumToggle() {
        const toggle = document.getElementById('sp-podium-toggle');
        const podiumRow = document.getElementById('sp-podium-row');
        if (toggle && podiumRow) {
             toggle.addEventListener('click', (e) => {
                 e.stopPropagation(); // Prevent bubbling layout jitters
                 podiumRow.classList.toggle('is-expanded');
                 
                 // Update tooltip/title based on state
                 const isExpanded = podiumRow.classList.contains('is-expanded');
                 toggle.title = isExpanded ? '收起左右护法' : '启用左右护法';
             });
        }
    }

    initBlackboardText() {
        const blackboard = document.getElementById('sp-blackboard');
        if (!blackboard) return;

        let selectedEl = null;
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        const deselectAll = () => {
            const texts = blackboard.querySelectorAll('.sp-chalk-text');
            texts.forEach(el => {
                el.classList.remove('sp-selected', 'sp-editing');
                el.contentEditable = false;
            });
            selectedEl = null;
        };

        // Cleanup old global listeners if they exist
        if (this._textKeyDownHandler) window.removeEventListener('keydown', this._textKeyDownHandler);

        // Mousedown: Select & Start Drag
        blackboard.addEventListener('mousedown', (e) => {
            const textEl = e.target.closest('.sp-chalk-text');
            if (textEl) {
                // Select
                if (selectedEl !== textEl) {
                    deselectAll();
                    selectedEl = textEl;
                    textEl.classList.add('sp-selected');
                }
                
                // Start Drag (if not editing)
                if (!textEl.isContentEditable) {
                    isDragging = true;
                    startX = e.clientX;
                    startY = e.clientY;
                    initialLeft = textEl.offsetLeft;
                    initialTop = textEl.offsetTop;
                    e.preventDefault(); // Prevent text selection
                    
                    // Attach temp drag listeners
                    window.addEventListener('mousemove', onMouseMove);
                    window.addEventListener('mouseup', onMouseUp);
                }
            }
        });

        const onMouseMove = (e) => {
            if (isDragging && selectedEl) {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                let newLeft = initialLeft + dx;
                let newTop = initialTop + dy;

                // Clamp Position
                const rect = blackboard.getBoundingClientRect();
                // Safe area: 10px padding
                // Width: text width? sp-chalk-text min-width 20px.
                const elWidth = selectedEl.offsetWidth;
                const elHeight = selectedEl.offsetHeight;
                
                if (newLeft < 0) newLeft = 0;
                if (newLeft > rect.width - elWidth) newLeft = rect.width - elWidth;
                if (newTop < 0) newTop = 0;
                if (newTop > rect.height - elHeight) newTop = rect.height - elHeight;

                selectedEl.style.left = `${newLeft}px`;
                selectedEl.style.top = `${newTop}px`;
            }
        };

        const onMouseUp = () => {
            isDragging = false;
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        // Click: Create New (BG)
        blackboard.addEventListener('click', (e) => {
            if (e.target.closest('.sp-chalk-text') || e.target.closest('.sp-blackboard-notes')) return;

            // Deselect existing
            deselectAll();

            const rect = blackboard.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            // Boundary Check: Ensure text is within safe writing area
            // Frame is 6px, but let's give more padding (10px) top/bottom
            // Blackboard height is 120px. 
            // Safe Y: 10px to 110px.
            if (y < 10 || y > 110) return;
            
            // Safe X: 10px to rect.width - 10px
            if (x < 10 || x > rect.width - 10) return;

            const textEl = document.createElement('div');
            textEl.className = 'sp-chalk-text sp-editing sp-selected';
            textEl.contentEditable = true;
            textEl.style.left = `${x}px`;
            textEl.style.top = `${y}px`;
            
            blackboard.appendChild(textEl);
            selectedEl = textEl;
            
            textEl.focus({ preventScroll: true }); // Prevent layout jump
            
            // Handle blur to remove empty textEl.focus(), 0);

            textEl.addEventListener('blur', () => {
                textEl.contentEditable = false;
                textEl.classList.remove('sp-editing');
                if (!textEl.textContent.trim()) {
                    textEl.remove();
                    if (selectedEl === textEl) selectedEl = null;
                }
            });
        });

        // Double Click: Edit
        blackboard.addEventListener('dblclick', (e) => {
            const textEl = e.target.closest('.sp-chalk-text');
            if (textEl) {
                textEl.contentEditable = true;
                textEl.classList.add('sp-editing');
                textEl.focus();
            }
        });

        // Wheel: Resize
        blackboard.addEventListener('wheel', (e) => {
            if (selectedEl) {
                e.preventDefault();
                const style = window.getComputedStyle(selectedEl);
                let currentSize = parseFloat(style.fontSize);
                const delta = e.deltaY > 0 ? -2 : 2; // Resize step
                let newSize = currentSize + delta;
                
                if (newSize < 12) newSize = 12;
                if (newSize > 120) newSize = 120; // Max size limit
                
                selectedEl.style.fontSize = `${newSize}px`;
            }
        }, { passive: false });

        // Global Keydown (Delete / Enter)
        this._textKeyDownHandler = (e) => {
            // Only active if blackboard exists and we have selection
            if (!document.getElementById('sp-blackboard')) return;

            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEl && !selectedEl.isContentEditable) {
                selectedEl.remove();
                selectedEl = null;
            }
            if (e.key === 'Enter' && !e.shiftKey && selectedEl && selectedEl.isContentEditable) {
                e.preventDefault();
                selectedEl.blur();
            }
        };
        window.addEventListener('keydown', this._textKeyDownHandler);
    }

    bindEvents() {
        const $ = id => document.getElementById(id);

        // Dropzone toggle
        const dropzone = $('sp-dropzone');
        const textarea = $('sp-students-input');
        const parseBtn = $('sp-parse-students');
        
        // Dropzone - clicking triggers file input
        const fileInput = $('sp-file-input');
        dropzone?.addEventListener('click', () => {
            fileInput?.click();
        });

        // Image Upload
        const imgInput = $('sp-image-input');
        const imgBtn = $('sp-upload-image');
        imgBtn?.addEventListener('click', () => imgInput?.click());
        imgInput?.addEventListener('change', e => {
            if (e.target.files[0]) this.handleImageUpload(e.target.files[0]);
        });

        // File input change handler
        fileInput?.addEventListener('change', e => {
            const file = e.target.files[0];
            if (file) this.handleFileUpload(file);
        });

        // File drag and drop
        dropzone?.addEventListener('dragover', e => {
            e.preventDefault();
            dropzone.classList.add('sp-dropzone--active');
        });
        dropzone?.addEventListener('dragleave', () => {
            dropzone.classList.remove('sp-dropzone--active');
        });
        dropzone?.addEventListener('drop', e => {
            e.preventDefault();
            dropzone.classList.remove('sp-dropzone--active');
            const file = e.dataTransfer.files[0];
            if (file) this.handleFileUpload(file);
        });

        // Parse students (manual paste mode)
        $('sp-parse-students')?.addEventListener('click', () => this.parseStudents());
        
        // Clear students
        $('sp-clear-students')?.addEventListener('click', () => {
            this.students = [];
            $('sp-student-count').innerHTML = '<i data-lucide="users"></i><span>0 人</span>';
            $('sp-students-preview').innerHTML = '';
            $('sp-students-input').value = '';
            $('sp-generate').disabled = true;
            $('sp-dropzone').classList.remove('sp-hidden');
            $('sp-students-input').classList.add('sp-hidden');
            $('sp-parse-students').classList.add('sp-hidden');
            if (window.lucide) window.lucide.createIcons();
        });

        // Parse constraints
        $('sp-parse-constraints')?.addEventListener('click', () => this.parseConstraints());

        // Generate
        $('sp-generate')?.addEventListener('click', () => this.generateSeating());

        // Exports
        $('sp-export-png')?.addEventListener('click', () => this.exportPNG());
        $('sp-export-excel')?.addEventListener('click', () => this.exportExcel());

        // Strategy toggles
        $('sp-gender')?.addEventListener('change', e => this.strategy.genderBalance = e.target.checked);
        $('sp-grade')?.addEventListener('change', e => this.strategy.gradeBalance = e.target.checked);
        $('sp-height')?.addEventListener('change', e => this.strategy.heightOrder = e.target.checked);

        // Grid size
        $('sp-rows')?.addEventListener('change', e => {
            this.rows = parseInt(e.target.value) || 6;
            this.renderGrid();
        });
        $('sp-cols')?.addEventListener('change', e => {
            this.cols = parseInt(e.target.value) || 8;
            this.renderGrid();
        });

        // Context menu
        document.addEventListener('click', () => this.hideContextMenu());
        $('sp-context-menu')?.querySelectorAll('.sp-context-item').forEach(item => {
            item.addEventListener('click', e => {
                e.stopPropagation();
                this.handleMenuAction(item.dataset.action);
            });
        });
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

                const isColAisle = this.colAisles.includes(c);
                const isRowAisle = this.rowAisles.includes(r);

                if (isColAisle || isRowAisle) {
                    cell.classList.add('sp-seat--aisle');
                    const line = document.createElement('span');
                    line.className = `sp-aisle-line ${isRowAisle ? 'sp-aisle-line--horizontal' : 'sp-aisle-line--vertical'}`;
                    cell.appendChild(line);
                    cell.addEventListener('contextmenu', e => this.showContextMenu(e, r, c));
                    grid.appendChild(cell);
                    continue;
                }

                const studentId = this.layout[r]?.[c];
                if (studentId && studentId !== '_aisle_') {
                    const student = this.students.find(s => s.id === studentId);
                    if (student) {
                        cell.classList.add('sp-seat--filled');
                        cell.dataset.studentId = student.id;

                        // === The Desk ===
                        const desk = document.createElement('div');
                        desk.className = 'sp-desk';

                        // Name Tag (姓名贴)
                        const nameTag = document.createElement('span');
                        nameTag.className = 'sp-name-tag';
                        nameTag.textContent = student.name;
                        desk.appendChild(nameTag);

                        // Desk Items Container
                        const itemsContainer = document.createElement('div');
                        itemsContainer.className = 'sp-desk-items';

                        // Status items based on student data
                        const indicator = this.getConstraintIndicator(student.id);
                        
                        // Glasses - for vision constraint (近视)
                        if (indicator && indicator.reason?.includes('视力')) {
                            const glasses = document.createElement('span');
                            glasses.className = 'sp-desk-item sp-desk-item--glasses';
                            glasses.textContent = '👓';
                            glasses.title = '近视需要关照';
                            itemsContainer.appendChild(glasses);
                        }

                        // Books - for high grades (学霸)
                        if (student.grade && student.grade >= 90) {
                            const books = document.createElement('span');
                            books.className = 'sp-desk-item sp-desk-item--books';
                            books.textContent = '📚';
                            books.title = `成绩: ${student.grade}分`;
                            itemsContainer.appendChild(books);
                        }

                        // Candy - wish fulfilled (心愿达成)
                        if (indicator && indicator.type === 'success') {
                            const candy = document.createElement('span');
                            candy.className = 'sp-desk-item sp-desk-item--candy';
                            candy.textContent = '🍬';
                            candy.title = '心愿已满足';
                            itemsContainer.appendChild(candy);
                        }

                        // Warning indicator
                        if (indicator && indicator.type === 'warning') {
                            const warning = document.createElement('span');
                            warning.className = 'sp-desk-item sp-desk-item--quiet';
                            warning.textContent = '⚠️';
                            warning.title = indicator.reason;
                            itemsContainer.appendChild(warning);
                        }

                        desk.appendChild(itemsContainer);
                        cell.appendChild(desk);

                        // === The Chair Back ===
                        const chair = document.createElement('div');
                        chair.className = `sp-chair sp-chair--${student.gender === 'M' ? 'male' : 'female'}`;
                        cell.appendChild(chair);

                        // === Tooltip ===
                        const tooltip = document.createElement('div');
                        tooltip.className = 'sp-seat-tooltip';
                        const gradeText = student.grade ? ` | 成绩: ${student.grade}` : '';
                        const genderText = student.gender === 'M' ? '男' : '女';
                        tooltip.textContent = `${student.name} (${genderText})${gradeText}`;
                        cell.appendChild(tooltip);

                        // Hover interaction
                        cell.addEventListener('mouseenter', () => this.highlightRelationships(student.id));
                        cell.addEventListener('mouseleave', () => this.clearHighlights());

                        // Drag events
                        cell.setAttribute('draggable', 'true');
                        cell.addEventListener('dragstart', e => this.handleDragStart(e, r, c));
                        cell.addEventListener('dragend', e => this.handleDragEnd(e));
                    }
                } else {
                    cell.classList.add('sp-seat--empty');
                    // Empty desk placeholder
                    const emptyDesk = document.createElement('div');
                    emptyDesk.className = 'sp-desk';
                    cell.appendChild(emptyDesk);
                }

                // Drop target events
                cell.addEventListener('dragover', e => this.handleDragOver(e));
                cell.addEventListener('dragenter', e => this.handleDragEnter(e, cell));
                cell.addEventListener('dragleave', e => this.handleDragLeave(e, cell));
                cell.addEventListener('drop', e => this.handleDrop(e, r, c));

                // Context menu
                cell.addEventListener('contextmenu', e => this.showContextMenu(e, r, c));

                grid.appendChild(cell);
            }
        }

        if (window.lucide) window.lucide.createIcons();

        // Sync podium seat width with grid seats
        requestAnimationFrame(() => this.syncPodiumSeatWidth());
        
        // Add resize listener if not already added
        if (!this._resizeHandler) {
            this._resizeHandler = () => this.syncPodiumSeatWidth();
            window.addEventListener('resize', this._resizeHandler);
        }
    }

    getConstraintIndicator(studentId) {
        const unsatisfied = this.unsatisfied.find(u => u.target === studentId);
        if (unsatisfied) {
            return { type: 'warning', icon: 'alert-triangle', reason: unsatisfied.reason };
        }

        for (const c of this.constraints) {
            if (c.target === studentId) {
                if (c.type === 'front_row') {
                    return { type: 'success', icon: 'eye', reason: '需坐前排' };
                }
                if (c.type === 'avoid') {
                    return { type: 'error', icon: 'x-circle', reason: `避免与${c.related}相邻` };
                }
            }
        }
        return null;
    }

    // ========== Relationship Highlighting ==========
    highlightRelationships(studentId) {
        const grid = document.getElementById('sp-grid');
        if (!grid) return;

        // Add highlighting mode to grid
        grid.classList.add('sp-grid--highlighting');

        // Get related students from constraints
        const relatedIds = new Set();
        for (const c of this.constraints) {
            if (c.target === studentId && c.related) {
                const relatedStudent = this.students.find(s => s.name === c.related);
                if (relatedStudent) relatedIds.add(relatedStudent.id);
            }
            if (c.related === this.students.find(s => s.id === studentId)?.name) {
                const targetStudent = this.students.find(s => s.name === c.target);
                if (targetStudent) relatedIds.add(targetStudent.id);
            }
        }

        // Highlight current and related students
        const seats = grid.querySelectorAll('.sp-seat--filled');
        seats.forEach(seat => {
            const seatStudentId = seat.dataset.studentId;
            if (seatStudentId === studentId || relatedIds.has(seatStudentId)) {
                seat.classList.add('sp-seat--highlighted');
            }
        });
    }

    clearHighlights() {
        const grid = document.getElementById('sp-grid');
        if (!grid) return;

        grid.classList.remove('sp-grid--highlighting');
        const seats = grid.querySelectorAll('.sp-seat--highlighted');
        seats.forEach(seat => seat.classList.remove('sp-seat--highlighted'));
    }

    // ========== Layout Sync ==========
    syncPodiumSeatWidth() {
        const gridSeat = document.querySelector('.sp-grid .sp-seat');
        const podiumSeats = document.querySelectorAll('.sp-podium-row .sp-seat');
        
        if (gridSeat && podiumSeats.length) {
            const width = gridSeat.getBoundingClientRect().width;
            podiumSeats.forEach(seat => {
                seat.style.width = `${width}px`;
                seat.style.minWidth = `${width}px`;
            });
        }
    }



    // ========== Context Menu ==========
    showContextMenu(e, row, col) {
        e.preventDefault();
        this.contextTarget = { row, col };

        const menu = document.getElementById('sp-context-menu');
        if (!menu) return;

        const isColAisle = this.colAisles.includes(col);
        const isRowAisle = this.rowAisles.includes(row);
        const isAisle = isColAisle || isRowAisle;

        menu.querySelector('[data-action="set-col-aisle"]').style.display = isAisle ? 'none' : 'flex';
        menu.querySelector('[data-action="set-row-aisle"]').style.display = isAisle ? 'none' : 'flex';
        menu.querySelector('[data-action="clear-aisle"]').style.display = isAisle ? 'flex' : 'none';

        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.classList.add('sp-context-menu--visible');
    }

    hideContextMenu() {
        document.getElementById('sp-context-menu')?.classList.remove('sp-context-menu--visible');
    }

    handleMenuAction(action) {
        if (!this.contextTarget) return;
        const { row, col } = this.contextTarget;

        switch (action) {
            case 'set-col-aisle':
                if (!this.colAisles.includes(col)) {
                    this.colAisles.push(col);
                    this.showToast(`第 ${col + 1} 列设为竖过道`, 'success');
                }
                break;
            case 'set-row-aisle':
                if (!this.rowAisles.includes(row)) {
                    this.rowAisles.push(row);
                    this.showToast(`第 ${row + 1} 行设为横过道`, 'success');
                }
                break;
            case 'clear-aisle':
                this.colAisles = this.colAisles.filter(a => a !== col);
                this.rowAisles = this.rowAisles.filter(a => a !== row);
                this.showToast('过道已取消', 'success');
                break;
            case 'clear-seat':
                if (this.layout[row]?.[col]) {
                    this.layout[row][col] = null;
                    this.showToast('座位已清空', 'success');
                }
                break;
        }

        this.hideContextMenu();
        this.renderGrid();
    }

    // ========== File Upload ==========
    async handleFileUpload(file) {
        const text = await file.text();
        document.getElementById('sp-students-input').value = text;
        document.getElementById('sp-dropzone').classList.add('sp-hidden');
        document.getElementById('sp-students-input').classList.remove('sp-hidden');
        document.getElementById('sp-parse-students').classList.remove('sp-hidden');
        this.parseStudents();
    }

    async handleImageUpload(file) {
        // Limit size (10MB)
        if (file.size > 10 * 1024 * 1024) {
            return this.showToast('图片太大了 (限制10MB)', 'warning');
        }

        const btn = document.getElementById('sp-upload-image');
        const originalIcon = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i>';
        if (window.lucide) window.lucide.createIcons();

        try {
            const formData = new FormData();
            formData.append('image', file);

            const res = await fetch('/api/tools/seating/parse-image', {
                method: 'POST',
                body: formData
            });

            const result = await res.json();
            if (!result.success) throw new Error(result.error);

            // Convert result to text format and append
            // Format: Name Gender Grade
            const newStudentsText = result.data.students.map(s => {
                let line = s.name;
                if (s.gender) line += ` ${s.gender === 'M' ? '男' : '女'}`;
                if (s.grade !== undefined) line += ` ${s.grade}`;
                return line;
            }).join('\n');

            const textarea = document.getElementById('sp-students-input');
            const dropzone = document.getElementById('sp-dropzone');
            
            // Show textarea if hidden
            dropzone.classList.add('sp-hidden');
            textarea.classList.remove('sp-hidden');
            document.getElementById('sp-parse-students').classList.remove('sp-hidden');

            const current = textarea.value.trim();
            textarea.value = current ? (current + '\n' + newStudentsText) : newStudentsText;

            this.showToast(`成功识别 ${result.data.count} 名学生`, 'success');
            
            // Trigger parse to update UI list
            this.parseStudents();

        } catch (err) {
            console.error(err);
            this.showToast(err.message || '识别失败', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalIcon;
            if (window.lucide) window.lucide.createIcons();
            // Clear input
            document.getElementById('sp-image-input').value = '';
        }
    }

    // ========== API Calls ==========
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
            
            const badge = document.getElementById('sp-student-count');
            badge.innerHTML = `<i data-lucide="users"></i><span>${result.data.count} 人</span>`;
            if (window.lucide) window.lucide.createIcons();
            
            document.getElementById('sp-generate').disabled = false;

            // Preview tags
            const preview = document.getElementById('sp-students-preview');
            const visibleCount = 6;
            preview.innerHTML = result.data.students.slice(0, visibleCount).map(s => {
                const cls = s.gender === 'M' ? 'sp-tag--male' : s.gender === 'F' ? 'sp-tag--female' : '';
                return `<span class="sp-tag ${cls}">${s.name}</span>`;
            }).join('');
            
            if (result.data.count > visibleCount) {
                preview.innerHTML += `<span class="sp-tag sp-tag--more">+${result.data.count - visibleCount}</span>`;
            }

            this.showToast(`成功导入 ${result.data.count} 名学生`, 'success');
        } catch (err) {
            this.showToast(err.message, 'error');
        }
    }

    async parseConstraints() {
        const text = document.getElementById('sp-constraints-input')?.value?.trim();
        if (!text) return this.showToast('请输入约束描述', 'warning');

        const btn = document.getElementById('sp-parse-constraints');
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> 解析中...';
        if (window.lucide) window.lucide.createIcons();

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
            if (this.constraints.length === 0) {
                list.innerHTML = '<div style="text-align:center;color:var(--sp-text-muted);font-size:0.85rem;padding:16px;">未识别到约束条件</div>';
            } else {
                list.innerHTML = this.constraints.map(c => {
                    const iconMap = { front_row: 'eye', back_row: 'arrow-down', avoid: 'x-circle', prefer: 'heart', pair: 'link' };
                    const typeMap = { front_row: 'front', avoid: 'avoid', prefer: 'prefer', pair: 'prefer', back_row: 'front' };
                    return `
                        <div class="sp-constraint">
                            <span class="sp-constraint-icon sp-constraint-icon--${typeMap[c.type] || 'front'}">
                                <i data-lucide="${iconMap[c.type] || 'circle'}"></i>
                            </span>
                            <span class="sp-constraint-text">${c.target}${c.related ? ` ⇄ ${c.related}` : ''}: ${c.reason}</span>
                            <span class="sp-constraint-priority sp-constraint-priority--${c.priority}">${c.priority === 'hard' ? '必须' : '尽量'}</span>
                        </div>
                    `;
                }).join('');
            }

            if (window.lucide) window.lucide.createIcons();
            this.showToast(`识别到 ${this.constraints.length} 条约束`, 'success');
        } catch (err) {
            this.showToast(err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="sparkles"></i> AI 解析';
            if (window.lucide) window.lucide.createIcons();
        }
    }

    async generateSeating() {
        if (!this.students.length) return this.showToast('请先导入名单', 'warning');

        const btn = document.getElementById('sp-generate');
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> 生成中...';
        if (window.lucide) window.lucide.createIcons();

        try {
            const aisles = [...this.colAisles];
            const res = await fetch('/api/tools/seating/plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    students: this.students,
                    constraints: this.constraints,
                    strategy: this.strategy,
                    rows: this.rows,
                    cols: this.cols,
                    aisles
                })
            });
            const result = await res.json();
            if (!result.success) throw new Error(result.error);

            this.layout = result.data.layout;
            this.unsatisfied = result.data.unsatisfied || [];
            this.renderGrid();
            this.updateStatus();

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

    updateStatus() {
        const status = document.getElementById('sp-status');
        const satisfied = this.constraints.length - this.unsatisfied.length;
        
        let html = `
            <div class="sp-status-left">
                <span class="sp-status-item sp-status-item--success">
                    <i data-lucide="check-circle"></i>
                    满足 ${satisfied}/${this.constraints.length} 约束
                </span>
        `;

        if (this.unsatisfied.length > 0) {
            html += `
                <span class="sp-status-item sp-status-item--warning">
                    <i data-lucide="alert-triangle"></i>
                    ${this.unsatisfied[0].target}: ${this.unsatisfied[0].reason}
                </span>
            `;
        }

        html += '</div><div class="sp-status-right"></div>';
        status.innerHTML = html;
        if (window.lucide) window.lucide.createIcons();
    }

    // ========== Exports ==========
    async exportPNG() {
        try {
            if (!window.html2canvas) {
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
                document.head.appendChild(s);
                await new Promise(r => s.onload = r);
            }
            const canvas = await window.html2canvas(document.querySelector('.sp-classroom-view'), { 
                backgroundColor: '#0f172a', 
                scale: 2 
            });
            const link = document.createElement('a');
            link.download = `座位表_${new Date().toISOString().split('T')[0]}.png`;
            link.href = canvas.toDataURL();
            link.click();
            this.showToast('图片已下载', 'success');
        } catch (err) {
            this.showToast('导出失败: ' + err.message, 'error');
        }
    }

    exportExcel() {
        let csv = '\uFEFF'; // BOM for Excel
        for (let r = 0; r < this.rows; r++) {
            const row = [];
            for (let c = 0; c < this.cols; c++) {
                if (this.colAisles.includes(c) || this.rowAisles.includes(r)) {
                    row.push('');
                } else {
                    const id = this.layout[r]?.[c];
                    row.push(this.students.find(s => s.id === id)?.name || '');
                }
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
        if (window.ICeCream?.showToast) {
            window.ICeCream.showToast(msg, type);
        } else {
            console.log(`[${type.toUpperCase()}] ${msg}`);
        }
    }
}

// Export
const seatingPlanner = new SeatingPlanner();
export function init(container) { seatingPlanner.init(container); }
export default seatingPlanner;
