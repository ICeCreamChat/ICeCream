import { normalizeLocalAisles } from '../seating-core.js';
import * as seatingApi from './api-client.js';

export const seatingExportMethods = {
    suppressHtml2CanvasAmdRegistration() {
        const amdDefine = window.define;
        if (typeof amdDefine !== 'function' || !amdDefine.amd) return () => {};

        const previousAmd = amdDefine.amd;
        try {
            amdDefine.amd = undefined;
        } catch (error) {
            return () => {};
        }

        return () => {
            try {
                amdDefine.amd = previousAmd;
            } catch (error) {
                // Monaco owns the AMD loader; failing to restore should not block export retry handling.
            }
        };
    },

    async ensureHtml2Canvas() {
        if (typeof window.html2canvas === 'function') return window.html2canvas;

        const loadScript = (retry = false) => new Promise((resolve, reject) => {
            const restoreAmd = this.suppressHtml2CanvasAmdRegistration();
            let done = false;
            let timer = null;
            const finish = callback => {
                if (done) return;
                done = true;
                if (timer) clearTimeout(timer);
                restoreAmd();
                callback();
            };
            let script = document.querySelector('script[data-html2canvas-loader]');
            if (retry && script) {
                script.remove();
                script = null;
            }
            let shouldAppend = false;
            if (!script) {
                script = document.createElement('script');
                script.src = `/js/libs/html2canvas.min.js${retry ? '?html2canvas-retry=1' : ''}`;
                script.dataset.html2canvasLoader = 'true';
                script.async = true;
                shouldAppend = true;
            }
            if (typeof window.html2canvas === 'function') {
                finish(resolve);
                return;
            }
            if (script.dataset.loaded === 'true') {
                finish(resolve);
                return;
            }
            timer = setTimeout(() => {
                script.remove();
                finish(() => reject(new Error('html2canvas load timed out')));
            }, 5000);
            script.addEventListener('load', () => {
                script.dataset.loaded = 'true';
                finish(resolve);
            }, { once: true });
            script.addEventListener('error', () => {
                script.dataset.failed = 'true';
                finish(() => reject(new Error('本地图片导出组件加载失败')));
            }, { once: true });
            if (shouldAppend) document.head.appendChild(script);
        });

        let firstError = null;
        try {
            await loadScript(false);
        } catch (error) {
            firstError = error;
        }
        if (typeof window.html2canvas !== 'function') {
            try {
                await loadScript(true);
            } catch (error) {
                throw firstError || error;
            }
        }

        if (typeof window.html2canvas !== 'function') {
            throw new Error('本地图片导出组件已加载，但没有注册 window.html2canvas，请刷新后重试');
        }
        return window.html2canvas;
    },

    async ensureHtml2CanvasLegacy() {
        let script = document.querySelector('script[data-html2canvas-loader]');
        if (!script) {
            script = document.createElement('script');
            script.src = '/js/libs/html2canvas.min.js';
            script.dataset.html2canvasLoader = 'true';
            script.async = true;
            document.head.appendChild(script);
        }

        await new Promise((resolve, reject) => {
            if (typeof window.html2canvas === 'function' || script.dataset.loaded === 'true') {
                resolve();
                return;
            }
            script.addEventListener('load', () => {
                script.dataset.loaded = 'true';
                resolve();
            }, { once: true });
            script.addEventListener('error', () => reject(new Error('本地图片导出组件加载失败')), { once: true });
        });

        if (typeof window.html2canvas !== 'function') {
            throw new Error('本地图片导出组件不可用，请刷新后重试');
        }
        return window.html2canvas;
    },

    setExportMode(active) {
        document.querySelectorAll('.sp-aisle-gap-layer, .sp-chat, .sp-context-menu, .sp-seat-tooltip')
            .forEach(element => element.classList.toggle('sp-export-hide', Boolean(active)));
    },

    async exportPNG() {
        try {
            const html2canvas = await this.ensureHtml2Canvas();
            const target = document.querySelector('.sp-classroom-view');
            if (!target) throw new Error('没有可导出的座位图');
            const isLightMode = document.body.classList.contains('light-mode');
            this.setExportMode(true);
            await new Promise(resolve => requestAnimationFrame(resolve));
            const canvas = await html2canvas(target, {
                backgroundColor: isLightMode ? '#f8fafc' : '#0f172a',
                scale: 2,
                useCORS: true,
            });
            const link = document.createElement('a');
            link.download = `座位表_${new Date().toISOString().split('T')[0]}.png`;
            link.href = canvas.toDataURL();
            link.click();
            this.showToast('图片已下载', 'success');
        } catch (err) {
            this.recordDiagnosticEvent('export_png_failed', {
                error: err.message || 'export_png_failed',
            });
            this.showToast('导出失败: ' + err.message, 'error');
        } finally {
            this.setExportMode(false);
        }
    },

    exportSnapshot() {
        return {
            rows: this.rows,
            cols: this.cols,
            layout: this.layout.map(row => row.map(value => value || null)),
            classroomLayout: structuredClone(this.classroomLayout),
            localAisles: normalizeLocalAisles(this.classroomLayout?.localAisles, this.rows, this.cols),
            guardians: [...this.guardians],
            students: this.students.map(student => ({
                id: student.id,
                name: student.name,
                gender: student.gender,
                grade: student.grade,
                height: student.height,
            })),
        };
    },

    async exportXLSX() {
        try {
            const res = await seatingApi.fetchExportXlsx(this.exportSnapshot());
            if (!res.ok) {
                const error = await res.json().catch(() => ({}));
                throw new Error(error.error || '导出服务暂时不可用');
            }
            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
                throw new Error('导出服务返回格式错误');
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = `座位表_${new Date().toISOString().split('T')[0]}.xlsx`;
            link.href = url;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            this.showToast('Excel 已下载', 'success');
        } catch (err) {
            this.recordDiagnosticEvent('export_xlsx_failed', {
                error: err.message || 'export_xlsx_failed',
            });
            this.showToast('导出失败: ' + err.message, 'error');
        }
    },

    exportCSV() {
        let csv = '\uFEFF'; // BOM for Excel
        for (let r = 0; r < this.rows; r++) {
            const row = [];
            for (let c = 0; c < this.cols; c++) {
                if (this.colAisles.includes(c) || this.rowAisles.includes(r)) {
                    row.push('');
                } else {
                    const id = this.layout[r]?.[c];
                    const name = this.studentMap.get(id)?.name || '';
                    // Escape names containing commas or quotes for CSV safety
                    row.push(name.includes(',') || name.includes('"') ? `"${name.replace(/"/g, '""')}"` : name);
                }
            }
            csv += row.join(',') + '\n';
        }
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `座位表_${new Date().toISOString().split('T')[0]}.csv`;
        link.href = url;
        link.click();
        // Release Blob URL
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        this.showToast('CSV 已下载', 'success');
    }
};
