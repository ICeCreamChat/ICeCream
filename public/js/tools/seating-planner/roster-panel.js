import * as seatingApi from './api-client.js';

class SeatingRosterPanelMethods {
    // ========== File Upload ==========
    showStudentEditor(text = '') {
        const textarea = document.getElementById('sp-students-input');
        const dropzone = document.getElementById('sp-dropzone');
        const parseBtn = document.getElementById('sp-parse-students');
        if (textarea) {
            textarea.value = text;
            textarea.classList.add('sp-hidden');
        }
        dropzone?.classList.add('sp-hidden');
        parseBtn?.classList.remove('sp-hidden');
    }

    formatStudentsForEditor(students = []) {
        return students.map(student => this.formatReviewedStudentLine(student)).filter(Boolean).join('\n');
    }

    openRosterEditor() {
        const students = this.students.length ? this.students : [];
        if (!students.length) {
            this.showToast('请先导入学生名单', 'warning');
            return;
        }
        this.showRosterReview(students);
    }

    async handleFileUpload(file) {
        try {
            const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
            if (ext === '.xlsx' || ext === '.xls') {
                await this.handleRosterFileUpload(file);
                return;
            }

            const text = await file.text();
            this.showStudentEditor(text);
            this.parseStudents();
        } catch (err) {
            console.error('[SeatingPlanner] File read error:', err);
            this.showToast('文件读取失败', 'error');
        }
    }

    async handleRosterFileUpload(file) {
        const formData = new FormData();
        formData.append('file', file, file.name);

        const res = await seatingApi.fetchRosterFileParse(formData);
        const result = await res.json();
        if (!result.success) throw new Error(result.error || '名单文件解析失败');

        this.students = result.data.students;
        this._buildStudentMap();
        this.showStudentEditor(this.formatStudentsForEditor(result.data.students));

        const badge = document.getElementById('sp-student-count');
        badge.innerHTML = `<i data-lucide="users"></i><span>${result.data.count} 人</span>`;
        this.updateArrangementActionState?.();
        this.renderStudentPreview(result.data.students, result.data.count);
        if (window.lucide) window.lucide.createIcons();
        this.showToast(`成功导入 ${result.data.count} 名学生`, 'success');
        this.hideSuggestions('arrange');
    }

    /**
     * Compress image via Canvas before upload.
     * Shrinks to max 1600px on longest side, outputs JPEG 0.8.
     * Typically reduces 5-10MB phone photos to ~100-300KB.
     */
    async compressImage(file) {
        const MAX_SIZE = 1600;
        const QUALITY = 0.8;

        const bitmap = await createImageBitmap(file);
        let { width, height } = bitmap;

        // Scale down if either dimension exceeds MAX_SIZE
        if (width > MAX_SIZE || height > MAX_SIZE) {
            const ratio = Math.min(MAX_SIZE / width, MAX_SIZE / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
        }

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();

        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
        console.log(`[SeatingPlanner] Image compressed: ${(file.size / 1024).toFixed(0)}KB → ${(blob.size / 1024).toFixed(0)}KB (${width}×${height})`);
        return blob;
    }

    async handleImageUpload(file) {
        // Limit size (20MB raw — will be compressed before upload)
        if (file.size > 20 * 1024 * 1024) {
            return this.showToast('图片太大了 (限制20MB)', 'warning');
        }

        const btn = document.getElementById('sp-upload-image');
        const originalIcon = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i>';
        if (window.lucide) window.lucide.createIcons();

        try {
            // Compress image client-side before uploading
            const compressed = await this.compressImage(file);

            const formData = new FormData();
            formData.append('image', compressed, 'photo.jpg');

            const res = await seatingApi.fetchRosterImageParse(formData);

            const result = await res.json();
            if (!result.success) throw new Error(result.error);

            this.showImageReview(result.data);

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

    formatReviewedStudentLine(s) {
        let line = s.name || '';
        if (s.gender) line += ` ${s.gender === 'M' ? '男' : '女'}`;
        if (s.height !== undefined && s.height !== null && s.height !== '') line += ` ${s.height}`;
        if (s.grade !== undefined && s.grade !== null && s.grade !== '') line += ` ${s.grade}`;
        return line.trim();
    }

    showImageReview(data = {}) {
        const students = Array.isArray(data.students) ? data.students : [];
        this._imageReviewMode = 'image';
        this._pendingImageReview = students;
        const modal = document.getElementById('sp-image-review');
        const title = document.getElementById('sp-image-review-title');
        const warnings = document.getElementById('sp-image-review-warnings');
        const confirmButton = document.getElementById('sp-image-review-confirm');
        const reuploadButton = document.getElementById('sp-image-review-reupload');
        if (title) title.textContent = students.length ? `识别结果确认（${students.length}人）` : '识别结果确认';
        if (confirmButton) confirmButton.textContent = '确认导入';
        reuploadButton?.classList.remove('sp-hidden');
        this.setRosterEditorControlsVisible(false);
        warnings.textContent = (data.warnings || []).join('；');
        warnings.classList.toggle('sp-hidden', !(data.warnings || []).length);
        this.renderImageReviewRows(students, { roster: false });
        modal?.classList.remove('sp-hidden');
        if (window.lucide) window.lucide.createIcons();
    }

    showRosterReview(students = []) {
        this._imageReviewMode = 'roster';
        this._pendingImageReview = students;
        const modal = document.getElementById('sp-image-review');
        const title = document.getElementById('sp-image-review-title');
        const warnings = document.getElementById('sp-image-review-warnings');
        const confirmButton = document.getElementById('sp-image-review-confirm');
        const reuploadButton = document.getElementById('sp-image-review-reupload');
        if (title) title.textContent = students.length ? `名单编辑（${students.length}人）` : '名单编辑';
        if (confirmButton) confirmButton.textContent = '确认更新';
        reuploadButton?.classList.add('sp-hidden');
        this.setRosterEditorControlsVisible(true);
        warnings?.classList.add('sp-hidden');
        if (warnings) warnings.textContent = '';
        this.renderImageReviewRows(students, { roster: true });
        modal?.classList.remove('sp-hidden');
        if (window.lucide) window.lucide.createIcons();
    }

    closeImageReview() {
        this._imageReviewMode = null;
        this._pendingImageReview = null;
        this.setRosterEditorControlsVisible(false);
        document.getElementById('sp-image-review')?.classList.add('sp-hidden');
    }

    setRosterEditorControlsVisible(visible) {
        const modal = document.getElementById('sp-image-review');
        const toolbar = document.getElementById('sp-roster-toolbar');
        const bulkPanel = document.getElementById('sp-roster-bulk-panel');
        modal?.classList.toggle('sp-image-review--roster', visible);
        toolbar?.classList.toggle('sp-hidden', !visible);
        if (!visible) bulkPanel?.classList.add('sp-hidden');
    }

    createReviewField(field, value, issues = []) {
        const input = document.createElement(field === 'gender' ? 'select' : 'input');
        input.className = 'sp-image-review-field';
        input.dataset.field = field;
        if (field === 'gender') {
            [['', ''], ['M', '男'], ['F', '女']].forEach(([optionValue, label]) => {
                const option = document.createElement('option');
                option.value = optionValue;
                option.textContent = label;
                input.appendChild(option);
            });
            input.value = value || '';
        } else {
            input.value = value ?? '';
            if (field === 'height' || field === 'grade') input.type = 'number';
        }
        const issueText = issues.join('|');
        const warningByField = {
            name: /missing_name|duplicate_name/,
            height: /missing_height|height_out_of_range/,
            grade: /grade_out_of_range/,
        };
        if (warningByField[field]?.test(issueText)) input.classList.add('sp-image-review-field--warning');
        return input;
    }

    createImageReviewRow(student = {}, index = 0, { roster = false } = {}) {
        const issues = Array.isArray(student.issues) ? student.issues : [];
        const row = document.createElement('tr');
        if (student.id) row.dataset.studentId = String(student.id);
        if (issues.length) row.classList.add('sp-image-review-row--warning');
        const indexCell = document.createElement('td');
        indexCell.className = 'sp-image-review-index';
        indexCell.textContent = String(index + 1);
        row.appendChild(indexCell);
        ['name', 'gender', 'height', 'grade'].forEach(field => {
            const cell = document.createElement('td');
            cell.appendChild(this.createReviewField(field, student[field], issues));
            row.appendChild(cell);
        });
        const actionCell = document.createElement('td');
        actionCell.className = 'sp-roster-action';
        if (roster) {
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'sp-roster-delete-row';
            deleteButton.title = '删除此学生';
            deleteButton.setAttribute('aria-label', '删除此学生');
            deleteButton.innerHTML = '<i data-lucide="trash-2"></i>';
            actionCell.appendChild(deleteButton);
        }
        row.appendChild(actionCell);
        return row;
    }

    renderImageReviewRows(students = [], options = {}) {
        const body = document.getElementById('sp-image-review-body');
        if (!body) return;
        body.replaceChildren();
        students.forEach((student, index) => {
            body.appendChild(this.createImageReviewRow(student, index, options));
        });
        this.renumberReviewRows();
    }

    addRosterReviewRow(student = {}) {
        const body = document.getElementById('sp-image-review-body');
        if (!body) return;
        body.appendChild(this.createImageReviewRow(student, body.querySelectorAll('tr').length, { roster: true }));
        this.renumberReviewRows();
        this.updateRosterReviewTitle();
        if (window.lucide) window.lucide.createIcons();
    }

    renumberReviewRows() {
        [...document.querySelectorAll('#sp-image-review-body tr')].forEach((row, index) => {
            const indexCell = row.querySelector('.sp-image-review-index');
            if (indexCell) indexCell.textContent = String(index + 1);
        });
    }

    updateRosterReviewTitle() {
        if (this._imageReviewMode !== 'roster') return;
        const title = document.getElementById('sp-image-review-title');
        const count = document.querySelectorAll('#sp-image-review-body tr').length;
        if (title) title.textContent = count ? `名单编辑（${count}人）` : '名单编辑';
    }

    toggleRosterBulkPanel() {
        document.getElementById('sp-roster-bulk-panel')?.classList.toggle('sp-hidden');
    }

    async appendRosterBulkText() {
        const textarea = document.getElementById('sp-roster-bulk-text');
        const button = document.getElementById('sp-roster-bulk-append');
        const text = textarea?.value?.trim() || '';
        if (!text) {
            this.showToast('请先粘贴学生名单', 'warning');
            return;
        }
        if (button) button.disabled = true;
        try {
            const res = await seatingApi.fetchStudentsParse(text);
            const result = await res.json();
            if (!result.success) throw new Error(result.error || '名单解析失败');
            const students = Array.isArray(result.data?.students) ? result.data.students : [];
            if (!students.length) {
                this.showToast('没有解析到可追加的学生', 'warning');
                return;
            }
            students.forEach(student => this.addRosterReviewRow({
                name: student.name,
                gender: student.gender,
                height: student.height,
                grade: student.grade,
            }));
            if (textarea) textarea.value = '';
            document.getElementById('sp-roster-bulk-panel')?.classList.add('sp-hidden');
            this.showToast(`已追加 ${students.length} 名学生`, 'success');
        } catch (err) {
            console.error('[SeatingPlanner] Bulk roster parse error:', err);
            this.showToast(err.message || '批量名单解析失败', 'error');
        } finally {
            if (button) button.disabled = false;
        }
    }

    getImageReviewStudents({ includePartial = false } = {}) {
        const rows = [...document.querySelectorAll('#sp-image-review-body tr')];
        return rows.map(row => {
            const value = field => row.querySelector(`[data-field="${field}"]`)?.value?.trim() || '';
            const numeric = field => {
                const raw = value(field);
                return raw === '' ? undefined : Number(raw);
            };
            const student = {
                id: row.dataset.studentId || '',
                name: value('name'),
                gender: value('gender'),
                height: numeric('height'),
                grade: numeric('grade'),
            };
            student._hasAnyValue = Boolean(student.name || student.gender || student.height !== undefined || student.grade !== undefined);
            return student;
        }).filter(student => includePartial ? student._hasAnyValue : student.name);
    }

    appendReviewedStudentsToInput(students) {
        const newStudentsText = students.map(s => this.formatReviewedStudentLine(s)).filter(Boolean).join('\n');
        const textarea = document.getElementById('sp-students-input');
        const current = textarea?.value?.trim() || '';
        const nextText = current ? (current + '\n' + newStudentsText) : newStudentsText;
        this.showStudentEditor(nextText);
        this.parseStudents();
    }

    updateReviewedStudentsInInput(students) {
        const nextText = this.formatStudentsForEditor(students);
        this.showStudentEditor(nextText);
        this.parseStudents();
    }

    nextStudentId(usedIds = new Set()) {
        let max = 0;
        for (const id of usedIds) {
            const match = String(id || '').match(/^s(\d+)$/i);
            if (match) max = Math.max(max, Number(match[1]));
        }
        let next = max + 1;
        let candidate = `s${String(next).padStart(2, '0')}`;
        while (usedIds.has(candidate)) {
            next += 1;
            candidate = `s${String(next).padStart(2, '0')}`;
        }
        return candidate;
    }

    normalizeRosterReviewStudent(student, id) {
        const normalizeNumber = value => {
            if (value === undefined || value === null || value === '') return undefined;
            const num = Number(value);
            return Number.isFinite(num) ? num : undefined;
        };
        return {
            id,
            name: String(student.name || '').trim(),
            gender: student.gender === 'M' || student.gender === 'F' ? student.gender : '',
            height: normalizeNumber(student.height),
            grade: normalizeNumber(student.grade),
        };
    }

    buildRosterUpdateFromReview(reviewStudents = []) {
        const previousIds = new Set(this.students.map(student => student.id));
        const usedIds = new Set(previousIds);
        const keptIds = new Set();
        const addedIds = [];
        const students = [];
        for (const item of reviewStudents) {
            const name = String(item?.name || '').trim();
            if (!name) continue;
            let id = String(item.id || '').trim();
            if (!previousIds.has(id) || keptIds.has(id)) {
                id = this.nextStudentId(usedIds);
                addedIds.push(id);
            }
            usedIds.add(id);
            keptIds.add(id);
            students.push(this.normalizeRosterReviewStudent({ ...item, name }, id));
        }
        const nextIds = new Set(students.map(student => student.id));
        const removedIds = this.students
            .map(student => student.id)
            .filter(id => !nextIds.has(id));
        return { students, removedIds, addedIds };
    }

    getPlacedRosterStudentIds() {
        const placed = new Set();
        for (const row of this.layout || []) {
            for (const id of row || []) {
                if (id && id !== '_aisle_') placed.add(id);
            }
        }
        for (const id of this.guardians || []) {
            if (id) placed.add(id);
        }
        return placed;
    }

    clearRemovedRosterStudentReferences(removedIds = []) {
        const removed = new Set(removedIds);
        if (!removed.size) return;
        for (const row of this.layout || []) {
            for (let c = 0; c < (row?.length || 0); c++) {
                if (removed.has(row[c])) row[c] = null;
            }
        }
        this.guardians = (this.guardians || [null, null]).map(id => removed.has(id) ? null : id);
        if (this.classroomLayout?.guardians) {
            if (removed.has(this.classroomLayout.guardians.left)) this.classroomLayout.guardians.left = null;
            if (removed.has(this.classroomLayout.guardians.right)) this.classroomLayout.guardians.right = null;
        }
        this.unassigned = (this.unassigned || []).filter(id => !removed.has(id));
    }

    applyRosterReviewState(update) {
        this.clearRemovedRosterStudentReferences(update.removedIds);
        this.students = update.students;
        this._buildStudentMap();

        const knownIds = new Set(this.students.map(student => student.id));
        const placedIds = this.getPlacedRosterStudentIds();
        const nextUnassigned = [];
        const pushUnassigned = id => {
            if (knownIds.has(id) && !placedIds.has(id) && !nextUnassigned.includes(id)) nextUnassigned.push(id);
        };
        (this.unassigned || []).forEach(pushUnassigned);
        this.students.forEach(student => pushUnassigned(student.id));
        this.unassigned = nextUnassigned;
    }

    syncRosterEditorAfterUpdate() {
        this.showStudentEditor(this.formatStudentsForEditor(this.students));
        const badge = document.getElementById('sp-student-count');
        if (badge) badge.innerHTML = `<i data-lucide="users"></i><span>${this.students.length} 人</span>`;
        this.updateArrangementActionState?.();
        this.renderStudentPreview(this.students, this.students.length);
        this.refreshConstraintStatus();
        this.saveSnapshot();
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        this.hideSuggestions('arrange');
        if (window.lucide) window.lucide.createIcons();
    }

    applyRosterReviewUpdate(reviewStudents = []) {
        const update = this.buildRosterUpdateFromReview(reviewStudents);
        this.applyRosterReviewState(update);
        this.syncRosterEditorAfterUpdate();
        return update;
    }

    validateRosterReviewRows() {
        const rows = [...document.querySelectorAll('#sp-image-review-body tr')];
        const seenNames = new Map();
        let invalid = false;
        let firstMessage = '';
        rows.forEach(row => {
            row.classList.remove('sp-image-review-row--warning');
            row.querySelectorAll('.sp-image-review-field--warning').forEach(field => {
                field.classList.remove('sp-image-review-field--warning');
            });
        });
        const flag = (row, field, message) => {
            row.classList.add('sp-image-review-row--warning');
            row.querySelector(`[data-field="${field}"]`)?.classList.add('sp-image-review-field--warning');
            invalid = true;
            if (!firstMessage) firstMessage = message;
        };
        rows.forEach(row => {
            const value = field => row.querySelector(`[data-field="${field}"]`)?.value?.trim() || '';
            const name = value('name');
            const gender = value('gender');
            const heightRaw = value('height');
            const gradeRaw = value('grade');
            const hasAny = Boolean(name || gender || heightRaw || gradeRaw);
            if (!hasAny) return;
            if (!name) flag(row, 'name', '请补全红色行的姓名，或删除该空行');
            if (name) {
                const existingRow = seenNames.get(name);
                if (existingRow) {
                    flag(row, 'name', `名单中有重复姓名：${name}`);
                    flag(existingRow, 'name', `名单中有重复姓名：${name}`);
                } else {
                    seenNames.set(name, row);
                }
            }
            const height = heightRaw === '' ? undefined : Number(heightRaw);
            if (height !== undefined && (!Number.isFinite(height) || height < 80 || height > 240)) {
                flag(row, 'height', '身高需要在 80-240 厘米之间');
            }
            const grade = gradeRaw === '' ? undefined : Number(gradeRaw);
            if (grade !== undefined && (!Number.isFinite(grade) || grade < 0 || grade > 100)) {
                flag(row, 'grade', '成绩需要在 0-100 之间');
            }
        });
        return { ok: !invalid, message: firstMessage };
    }

    confirmImageReview() {
        if (this._imageReviewMode === 'roster') {
            this.confirmRosterReview();
            return;
        }
        const students = this.getImageReviewStudents();
        if (!students.length) {
            this.showToast('请至少保留一名学生', 'warning');
            return;
        }
        this.appendReviewedStudentsToInput(students);
        this.closeImageReview();
        this.showToast(`已导入 ${students.length} 名学生`, 'success');
    }

    confirmRosterReview() {
        const validation = this.validateRosterReviewRows();
        if (!validation.ok) {
            this.showToast(validation.message || '请先修正红色字段', 'warning');
            return;
        }
        const students = this.getImageReviewStudents({ includePartial: true }).filter(student => student.name);
        if (!students.length) {
            this.showToast('请至少保留一名学生', 'warning');
            return;
        }
        this.applyRosterReviewUpdate(students);
        this.closeImageReview();
        this.showToast(`已更新 ${students.length} 名学生`, 'success');
    }

    // ========== API Calls ==========
    renderStudentPreview(students, count) {
        const visibleCount = this.constructor.VISIBLE_TAG_COUNT;
        const preview = document.getElementById('sp-students-preview');
        if (!preview) return;
        preview.innerHTML = '';
        students.slice(0, visibleCount).forEach(s => {
            const tag = document.createElement('span');
            tag.className = `sp-tag ${s.gender === 'M' ? 'sp-tag--male' : s.gender === 'F' ? 'sp-tag--female' : ''}`;
            tag.textContent = s.name;
            preview.appendChild(tag);
        });
        if (count > visibleCount) {
            preview.insertAdjacentHTML('beforeend', `<span class="sp-tag sp-tag--more">+${count - visibleCount}</span>`);
        }
    }

    async parseStudents() {
        const text = document.getElementById('sp-students-input')?.value?.trim();
        if (!text) return this.showToast('请输入学生名单', 'warning');

        try {
            const res = await seatingApi.fetchStudentsParse(text);
            const result = await res.json();
            if (!result.success) throw new Error(result.error);

            this.students = result.data.students;
            this._buildStudentMap();
            const badge = document.getElementById('sp-student-count');
            badge.innerHTML = `<i data-lucide="users"></i><span>${result.data.count} 人</span>`;
            if (window.lucide) window.lucide.createIcons();
            this.updateArrangementActionState?.();

            // Preview tags
            this.renderStudentPreview(result.data.students, result.data.count);

            this.showToast(`成功导入 ${result.data.count} 名学生`, 'success');
            this.hideSuggestions('arrange');
        } catch (err) {
            this.showToast(err.message, 'error');
        }
    }
}

export const seatingRosterMethods = Object.fromEntries(
    Object.getOwnPropertyNames(SeatingRosterPanelMethods.prototype)
        .filter(name => name !== 'constructor')
        .map(name => [name, SeatingRosterPanelMethods.prototype[name]])
);
