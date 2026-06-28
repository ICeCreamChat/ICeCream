import { getLayoutCapacity as getClassroomCapacity } from '../classroom-layout.js';
import { getPlacedStudentIds, normalizeLocalAisles } from '../seating-core.js';
import * as seatingApi from './api-client.js';

export const seatingFeedbackMethods = {
    getFeedbackScreenshotPrivacyMode() {
        const redactToggle = document.getElementById('sp-feedback-screenshot-redact');
        return redactToggle?.checked === false ? 'full' : 'redacted';
    },

    setFeedbackScreenshotStatus(message, tone = 'muted') {
        const status = document.getElementById('sp-feedback-screenshot-status');
        if (!status) return;
        status.textContent = message;
        status.dataset.tone = tone;
    },

    setFeedbackScreenshotControlsBusy(active) {
        const recapture = document.getElementById('sp-feedback-screenshot-recapture');
        const fallback = document.getElementById('sp-feedback-screenshot-fallback');
        [recapture, fallback].forEach(button => {
            if (!button) return;
            button.disabled = Boolean(active);
            button.toggleAttribute('aria-busy', Boolean(active));
        });
    },

    renderFeedbackScreenshotPreview(screenshot = null, message = '暂无截图') {
        const preview = document.getElementById('sp-feedback-screenshot-preview');
        if (!preview) return;
        preview.classList.toggle('is-loading', false);
        preview.replaceChildren();
        if (screenshot?.dataUrl) {
            const image = document.createElement('img');
            image.src = screenshot.dataUrl;
            image.alt = '前端截图预览';
            preview.appendChild(image);
            return;
        }
        const placeholder = document.createElement('span');
        placeholder.className = 'sp-feedback-screenshot-placeholder';
        placeholder.textContent = message;
        preview.appendChild(placeholder);
    },

    setFeedbackScreenshotLoading(message, { preservePreview = false } = {}) {
        const preview = document.getElementById('sp-feedback-screenshot-preview');
        if (!preview) return;
        preview.classList.add('is-loading');
        if (preservePreview && this._feedbackScreenshot?.dataUrl) return;
        preview.replaceChildren();
        const placeholder = document.createElement('span');
        placeholder.className = 'sp-feedback-screenshot-placeholder';
        placeholder.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i><span></span>';
        placeholder.querySelector('span').textContent = message;
        preview.appendChild(placeholder);
        if (window.lucide) window.lucide.createIcons();
    },

    getFeedbackScreenshotTarget() {
        return document.querySelector('.sp-main') || document.querySelector('.sp-app');
    },

    prepareFeedbackScreenshotClone(clonedDocument, privacyMode) {
        const app = clonedDocument.querySelector('.sp-app');
        app?.classList.add('sp-feedback-capture--active');
        app?.classList.toggle('sp-feedback-capture--redacted', privacyMode === 'redacted');
        clonedDocument.querySelectorAll('.sp-feedback, .sp-chat, .sp-context-menu, .sp-seat-tooltip, .sp-autocomplete')
            .forEach(element => {
                element.style.display = 'none';
                element.style.visibility = 'hidden';
                element.style.pointerEvents = 'none';
            });
        clonedDocument.querySelectorAll('.sp-guide, .sp-guide-transition')
            .forEach(element => {
                element.style.display = 'none';
            });
    },

    waitForFeedbackCaptureFrame() {
        const raf = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : callback => setTimeout(callback, 16);
        return new Promise(resolve => raf(() => raf(resolve)));
    },

    createFeedbackScreenshotPayload(canvas, privacyMode) {
        const maxWidth = 1280;
        const ratio = canvas.width > maxWidth ? maxWidth / canvas.width : 1;
        const width = Math.max(1, Math.round(canvas.width * ratio));
        const height = Math.max(1, Math.round(canvas.height * ratio));
        const output = document.createElement('canvas');
        output.width = width;
        output.height = height;
        const context = output.getContext('2d');
        if (context) {
            const isLightMode = document.body?.classList?.contains('light-mode');
            context.fillStyle = isLightMode ? '#f8fafc' : '#0f172a';
            context.fillRect(0, 0, width, height);
            context.drawImage(canvas, 0, 0, width, height);
        }
        return {
            included: true,
            privacyMode,
            mimeType: 'image/jpeg',
            dataUrl: output.toDataURL('image/jpeg', 0.72),
            width,
            height,
            capturedAt: new Date().toISOString(),
            target: 'seating-tool',
        };
    },

    getFeedbackScreenshotCropRect(target, frame = {}) {
        const rect = target?.getBoundingClientRect?.();
        if (!rect) throw new Error('找不到座位工具区域');
        const viewport = window.visualViewport || {};
        const viewportWidth = Math.max(1, viewport.width || window.innerWidth || document.documentElement?.clientWidth || frame.width || rect.width);
        const viewportHeight = Math.max(1, viewport.height || window.innerHeight || document.documentElement?.clientHeight || frame.height || rect.height);
        const frameWidth = Math.max(1, Math.round(frame.width || viewportWidth));
        const frameHeight = Math.max(1, Math.round(frame.height || viewportHeight));
        const scaleX = frameWidth / viewportWidth;
        const scaleY = frameHeight / viewportHeight;
        const x = Math.max(0, Math.round(rect.left * scaleX));
        const y = Math.max(0, Math.round(rect.top * scaleY));
        const right = Math.min(frameWidth, Math.round((rect.left + rect.width) * scaleX));
        const bottom = Math.min(frameHeight, Math.round((rect.top + rect.height) * scaleY));
        return {
            x,
            y,
            width: Math.max(1, right - x),
            height: Math.max(1, bottom - y),
            scaleX,
            scaleY,
            viewportWidth,
            viewportHeight,
        };
    },

    drawScreenCaptureFrameToCanvas(video, cropRect) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(cropRect.width));
        canvas.height = Math.max(1, Math.round(cropRect.height));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建截图画布');
        context.drawImage(
            video,
            Math.round(cropRect.x),
            Math.round(cropRect.y),
            Math.round(cropRect.width),
            Math.round(cropRect.height),
            0,
            0,
            canvas.width,
            canvas.height
        );
        return canvas;
    },

    getFeedbackScreenshotRedactionElements() {
        return Array.from(document.querySelectorAll([
            '.sp-name-tag',
            '.sp-seat-detail-name',
            '.sp-seat-detail-constraint-text',
            '.sp-seat-meta-item',
            '.sp-tags',
            '#sp-students-preview',
            '#sp-students-input',
            '#sp-arrange-prompt',
            '#sp-chat-messages',
        ].join(','))).filter(element => !element.closest?.('#sp-feedback-dialog'));
    },

    applyFeedbackScreenshotRedactionMasks(canvas, cropRect, elements = this.getFeedbackScreenshotRedactionElements()) {
        const context = canvas?.getContext?.('2d');
        if (!context || !cropRect) return canvas;
        context.save?.();
        context.fillStyle = 'rgba(148, 163, 184, 0.82)';
        context.strokeStyle = 'rgba(255, 255, 255, 0.48)';
        context.lineWidth = 1;
        elements.forEach(element => {
            const rect = element?.getBoundingClientRect?.();
            if (!rect || rect.width <= 0 || rect.height <= 0) return;
            const rawX = Math.round((rect.left * cropRect.scaleX) - cropRect.x);
            const rawY = Math.round((rect.top * cropRect.scaleY) - cropRect.y);
            const rawRight = Math.round(((rect.left + rect.width) * cropRect.scaleX) - cropRect.x);
            const rawBottom = Math.round(((rect.top + rect.height) * cropRect.scaleY) - cropRect.y);
            const x = Math.max(0, rawX);
            const y = Math.max(0, rawY);
            const width = Math.min(canvas.width, rawRight) - x;
            const height = Math.min(canvas.height, rawBottom) - y;
            if (width <= 0 || height <= 0) return;
            context.beginPath?.();
            if (typeof context.roundRect === 'function') {
                context.roundRect(x, y, width, height, 6);
                context.fill?.();
                context.stroke?.();
            } else {
                context.fillRect(x, y, width, height);
            }
        });
        context.restore?.();
        return canvas;
    },

    async withFeedbackScreenshotHiddenOverlays(callback) {
        const elements = Array.from(document.querySelectorAll([
            '#sp-feedback-dialog',
            '.sp-chat',
            '.sp-context-menu',
            '.sp-seat-tooltip',
            '.sp-autocomplete',
        ].join(',')));
        const previous = elements.map(element => ({
            element,
            opacity: element.style.opacity,
            visibility: element.style.visibility,
            pointerEvents: element.style.pointerEvents,
        }));
        elements.forEach(element => {
            element.style.opacity = '0';
            element.style.visibility = 'hidden';
            element.style.pointerEvents = 'none';
        });
        try {
            await this.waitForFeedbackCaptureFrame();
            return await callback();
        } finally {
            previous.forEach(({ element, opacity, visibility, pointerEvents }) => {
                element.style.opacity = opacity;
                element.style.visibility = visibility;
                element.style.pointerEvents = pointerEvents;
            });
        }
    },

    async waitForScreenCaptureVideo(video) {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('真实截图视频加载超时')), 5000);
            video.onloadedmetadata = () => {
                clearTimeout(timeout);
                const playResult = video.play?.();
                if (playResult?.then) {
                    playResult.then(resolve).catch(resolve);
                } else {
                    resolve();
                }
            };
            video.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('真实截图视频加载失败'));
            };
        });
        await this.waitForFeedbackCaptureFrame();
    },

    async captureFeedbackScreenScreenshot({ privacyMode = this.getFeedbackScreenshotPrivacyMode(), hideDialog = true } = {}) {
        const target = this.getFeedbackScreenshotTarget();
        if (!target) throw new Error('找不到座位工具区域');
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) throw new Error('浏览器不支持真实截图');
        let stream = null;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    displaySurface: 'browser',
                    width: { ideal: Math.round((window.innerWidth || 1280) * (window.devicePixelRatio || 1)) },
                    height: { ideal: Math.round((window.innerHeight || 720) * (window.devicePixelRatio || 1)) },
                },
                audio: false,
                preferCurrentTab: true,
                selfBrowserSurface: 'include',
                surfaceSwitching: 'exclude',
                systemAudio: 'exclude',
            });
            const video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.srcObject = stream;
            await this.waitForScreenCaptureVideo(video);
            const settings = stream.getVideoTracks?.()[0]?.getSettings?.() || {};
            const frame = {
                width: video.videoWidth || settings.width || window.innerWidth || 1280,
                height: video.videoHeight || settings.height || window.innerHeight || 720,
            };
            const cropRect = this.getFeedbackScreenshotCropRect(target, frame);
            const drawFrame = () => {
                const canvas = this.drawScreenCaptureFrameToCanvas(video, cropRect);
                if (privacyMode === 'redacted') {
                    this.applyFeedbackScreenshotRedactionMasks(canvas, cropRect);
                }
                return canvas;
            };
            return hideDialog
                ? await this.withFeedbackScreenshotHiddenOverlays(drawFrame)
                : drawFrame();
        } finally {
            if (stream) stream.getTracks().forEach(track => track.stop());
        }
    },

    async captureFeedbackDomFallbackScreenshot({ privacyMode = this.getFeedbackScreenshotPrivacyMode() } = {}) {
        const target = this.getFeedbackScreenshotTarget();
        if (!target) throw new Error('找不到座位工具区域');
        const html2canvas = await this.ensureHtml2Canvas();
        const isLightMode = document.body?.classList?.contains('light-mode');
        await this.waitForFeedbackCaptureFrame();
        return html2canvas(target, {
            backgroundColor: isLightMode ? '#f8fafc' : '#0f172a',
            scale: Math.min(1.5, Math.max(1, window.devicePixelRatio || 1.25)),
            useCORS: true,
            logging: false,
            onclone: clonedDocument => this.prepareFeedbackScreenshotClone(clonedDocument, privacyMode),
        });
    },

    captureFeedbackScreenshot({
        privacyMode = this.getFeedbackScreenshotPrivacyMode(),
        mode = 'screen',
        hideDialog = true,
    } = {}) {
        if (this._feedbackScreenshotRunning) {
            this._feedbackScreenshotQueuedPrivacyMode = privacyMode;
            this.setFeedbackScreenshotStatus('当前截图生成中，稍后自动重新截图...', 'loading');
            return this._feedbackScreenshotPromise;
        }
        const captureId = this._feedbackScreenshotCaptureId + 1;
        this._feedbackScreenshotCaptureId = captureId;
        const previousScreenshot = this._feedbackScreenshot;
        this._feedbackScreenshotRunning = true;
        this._feedbackScreenshotState = 'loading';
        this.setFeedbackScreenshotControlsBusy(true);
        const isFallback = mode === 'dom-fallback';
        const loadingText = isFallback
            ? '正在生成自动快照（可能不完全一致）...'
            : (previousScreenshot ? '正在获取真实截图...' : '正在请求真实截图授权...');
        this.setFeedbackScreenshotLoading(
            loadingText,
            { preservePreview: Boolean(previousScreenshot) }
        );
        this.setFeedbackScreenshotStatus(loadingText, 'loading');

        const promise = (async () => {
            const canvas = isFallback
                ? await this.captureFeedbackDomFallbackScreenshot({ privacyMode })
                : await this.captureFeedbackScreenScreenshot({ privacyMode, hideDialog });
            const screenshot = this.createFeedbackScreenshotPayload(canvas, privacyMode);
            if (captureId !== this._feedbackScreenshotCaptureId) return null;
            this._feedbackScreenshot = screenshot;
            this._feedbackScreenshotState = 'success';
            this.renderFeedbackScreenshotPreview(screenshot);
            this.setFeedbackScreenshotStatus(
                isFallback
                    ? '已生成自动快照（可能不完全一致）'
                    : (privacyMode === 'redacted' ? '已生成截图（已遮挡姓名）' : '已生成截图（保留真实画面）'),
                'success'
            );
            return screenshot;
        })().catch(error => {
            if (captureId === this._feedbackScreenshotCaptureId) {
                this._feedbackScreenshot = previousScreenshot;
                this._feedbackScreenshotState = 'error';
                if (previousScreenshot?.dataUrl) {
                    this.renderFeedbackScreenshotPreview(previousScreenshot);
                    this.setFeedbackScreenshotStatus('重新截图失败，已保留上一张，可再次尝试或直接提交', 'error');
                } else {
                    this.renderFeedbackScreenshotPreview(null, '未获取真实截图，可直接提交或使用自动快照');
                    this.setFeedbackScreenshotStatus('未获取真实截图，可直接提交或使用自动快照', 'error');
                }
            }
            this.recordDiagnosticEvent('feedback_screenshot_failed', {
                error: error.message || 'feedback_screenshot_failed',
                mode,
            });
            return null;
        }).finally(() => {
            if (captureId === this._feedbackScreenshotCaptureId) {
                this._feedbackScreenshotRunning = false;
                this.setFeedbackScreenshotControlsBusy(false);
                this._feedbackScreenshotPromise = null;
                const queuedPrivacyMode = this._feedbackScreenshotQueuedPrivacyMode;
                if (queuedPrivacyMode) {
                    this._feedbackScreenshotQueuedPrivacyMode = null;
                    this.captureFeedbackScreenshot({
                        privacyMode: queuedPrivacyMode,
                        mode,
                        hideDialog,
                    });
                }
            }
        });

        this._feedbackScreenshotPromise = promise;
        return promise;
    },

    async openFeedbackDialog() {
        const dialog = document.getElementById('sp-feedback-dialog');
        if (!dialog) return;
        await this.captureFeedbackScreenshot({
            privacyMode: this.getFeedbackScreenshotPrivacyMode(),
            mode: 'screen',
            hideDialog: true,
        });
        dialog.classList.remove('sp-hidden');
        if (this._feedbackScreenshot?.dataUrl) {
            this.renderFeedbackScreenshotPreview(this._feedbackScreenshot);
            this.setFeedbackScreenshotStatus(
                this._feedbackScreenshot.privacyMode === 'redacted' ? '已生成截图（已遮挡姓名）' : '已生成截图（保留真实画面）',
                'success'
            );
        } else {
            this.renderFeedbackScreenshotPreview(null, '未获取真实截图，可直接提交或使用自动快照');
            this.setFeedbackScreenshotStatus('未获取真实截图，可直接提交或使用自动快照', 'error');
        }
        document.getElementById('sp-feedback-message')?.focus();
        if (window.lucide) window.lucide.createIcons();
    },

    closeFeedbackDialog() {
        const dialog = document.getElementById('sp-feedback-dialog');
        if (!dialog) return;
        dialog.classList.add('sp-hidden');
    },

    getFeedbackSelection(group, fallback) {
        return document.querySelector(`[data-feedback-group="${group}"] .sp-feedback-chip.is-active`)?.dataset.value || fallback;
    },

    makeFeedbackAnonymizer() {
        const idToAnon = new Map();
        const nameToAnon = new Map();
        this.students.forEach((student, index) => {
            const anonId = `stu_${String(index + 1).padStart(3, '0')}`;
            if (student.id) idToAnon.set(String(student.id), anonId);
            if (student.name) nameToAnon.set(String(student.name), anonId);
        });
        return { idToAnon, nameToAnon };
    },

    anonymizeFeedbackText(value, anonymizer = this.makeFeedbackAnonymizer()) {
        let text = String(value ?? '');
        const names = Array.from(anonymizer.nameToAnon.entries())
            .filter(([name]) => name)
            .sort((a, b) => b[0].length - a[0].length);
        for (const [name, anonId] of names) {
            text = text.split(name).join(anonId);
        }
        return text;
    },

    isDiagnosticSensitiveKey(key) {
        return /(api[_-]?key|authorization|bearer|token|jwt|secret|password|passwd|smtp[_-]?(pass|password)|auth(code)?|credential)/i
            .test(String(key ?? ''));
    },

    redactDiagnosticText(value, maxLength = 1000) {
        let text = String(value ?? '');
        text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
        text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED]');
        text = text.replace(
            /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS|AUTHORIZATION|JWT|SMTP[_-]?PASS)[A-Z0-9_]*)\s*[:=]\s*['"]?[^'",\s;]+/gi,
            '$1=[REDACTED]'
        );
        text = text.replace(
            /\b((?:smtp|api|bearer|authorization|token|secret|password|pass|auth|授权码)\s*(?:key|pass|password|token|code|secret|授权码)?)\s*[:= ]+\s*['"]?[A-Za-z0-9._~+/-]{8,}/gi,
            '$1 [REDACTED]'
        );
        text = text.replace(/\b(?=[A-Za-z0-9._~+/-]*[A-Za-z])(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{24,}\b/g, '[REDACTED]');
        return text.length > maxLength ? `${text.slice(0, maxLength)}...[truncated]` : text;
    },

    anonymizeFeedbackValue(value, anonymizer) {
        if (value == null) return value;
        if (typeof value === 'string') {
            if (anonymizer.idToAnon.has(value)) return anonymizer.idToAnon.get(value);
            return this.redactDiagnosticText(this.anonymizeFeedbackText(value, anonymizer));
        }
        if (Array.isArray(value)) return value.map(item => this.anonymizeFeedbackValue(item, anonymizer));
        if (typeof value === 'object') {
            const result = {};
            for (const [key, item] of Object.entries(value)) {
                if (key === 'name' || key === 'studentName') continue;
                if (this.isDiagnosticSensitiveKey(key)) {
                    result[key] = '[REDACTED]';
                    continue;
                }
                result[key] = this.anonymizeFeedbackValue(item, anonymizer);
            }
            return result;
        }
        return value;
    },

    recordDiagnosticEvent(type, detail = {}) {
        const anonymizer = this.makeFeedbackAnonymizer();
        const event = {
            at: new Date().toISOString(),
            type: this.redactDiagnosticText(type, 80),
            detail: this.anonymizeFeedbackValue(detail, anonymizer),
        };
        this._diagnosticEvents = [...(this._diagnosticEvents || []), event].slice(-20);
        if (/error|fail|failed|warning|noop|rejected/i.test(String(type))) {
            this._lastErrors = [...(this._lastErrors || []), event].slice(-10);
        }
        return event;
    },

    async loadBackendDiagnostics() {
        try {
            const response = await seatingApi.fetchDiagnostics();
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.success) throw new Error(result.error || 'diagnostics_request_failed');
            return this.anonymizeFeedbackValue(result.data || {}, this.makeFeedbackAnonymizer());
        } catch (error) {
            return {
                available: false,
                error: 'diagnostics_request_failed',
                message: this.redactDiagnosticText(error.message || 'diagnostics_request_failed', 300),
            };
        }
    },

    toFeedbackBand(value, step = 10) {
        const number = Number(value);
        if (!Number.isFinite(number)) return 'unknown';
        const start = Math.floor(number / step) * step;
        return `${start}-${start + step - 1}`;
    },

    buildFeedbackSnapshot() {
        const anonymizer = this.makeFeedbackAnonymizer();
        const arrangePrompt = typeof document !== 'undefined'
            ? document.getElementById('sp-arrange-prompt')?.value?.trim() || ''
            : '';
        const quality = this._qualityEvaluation || {};
        const constraintEvaluation = this._constraintEvaluation || {};
        const availableSeats = getClassroomCapacity(this.classroomLayout);
        const assignedCount = new Set(getPlacedStudentIds(this.layout)).size + this.guardians.filter(Boolean).length;
        const win = typeof window !== 'undefined' ? window : null;

        const snapshot = {
            version: 2,
            diagnosticsVersion: 2,
            rows: this.rows,
            cols: this.cols,
            strategy: structuredClone(this.strategy || {}),
            arrangePrompt: this.anonymizeFeedbackText(arrangePrompt, anonymizer),
            students: this.students.map(student => ({
                anonId: anonymizer.idToAnon.get(String(student.id)),
                gender: student.gender || 'unknown',
                gradeBand: this.toFeedbackBand(student.grade),
                heightBand: this.toFeedbackBand(student.height),
            })),
            layout: this.layout.map(row => row.map(value => this.anonymizeFeedbackValue(value || null, anonymizer))),
            guardians: {
                left: this.anonymizeFeedbackValue(this.guardians?.[0] || null, anonymizer),
                right: this.anonymizeFeedbackValue(this.guardians?.[1] || null, anonymizer),
                enabled: Boolean(this.classroomLayout?.guardians?.enabled || this.guardians?.[0] || this.guardians?.[1]),
            },
            classroomLayout: {
                rows: this.classroomLayout?.rows || this.rows,
                cols: this.classroomLayout?.cols || this.cols,
                template: this.classroomLayout?.template || 'standard',
                groupSize: this.classroomLayout?.groupSize || 1,
                localAisles: normalizeLocalAisles(this.classroomLayout?.localAisles, this.rows, this.cols),
            },
            rowAisles: [...(this.rowAisles || [])],
            colAisles: [...(this.colAisles || [])],
            constraints: this.anonymizeFeedbackValue(this.constraints || [], anonymizer),
            unsatisfied: this.anonymizeFeedbackValue(this.unsatisfied || [], anonymizer),
            unassigned: this.anonymizeFeedbackValue(this.unassigned || [], anonymizer),
            arrangementSource: this.arrangementSource || null,
            arrangementSpec: this.anonymizeFeedbackValue(this.arrangementSpec || null, anonymizer),
            arrangementStats: this.anonymizeFeedbackValue(this.arrangementStats || null, anonymizer),
            arrangementInterpretation: this.anonymizeFeedbackValue(this.arrangementInterpretation || null, anonymizer),
            diagnostics: {
                page: {
                    tool: 'seating',
                    version: 2,
                    url: win?.location?.href || '',
                    theme: typeof document !== 'undefined' && document.body?.classList?.contains('light-mode') ? 'light' : 'dark',
                    width: win?.innerWidth || 0,
                    height: win?.innerHeight || 0,
                    userAgent: this.redactDiagnosticText(win?.navigator?.userAgent || '', 500),
                    capturedAt: new Date().toISOString(),
                },
                seatingState: {
                    rows: this.rows,
                    cols: this.cols,
                    availableSeats,
                    assignedCount,
                    unassignedCount: this.unassigned?.length || 0,
                    guardianEnabled: Boolean(this.classroomLayout?.guardians?.enabled || this.guardians?.some(Boolean)),
                    rowAisles: [...(this.rowAisles || [])],
                    colAisles: [...(this.colAisles || [])],
                    localAisles: normalizeLocalAisles(this.classroomLayout?.localAisles, this.rows, this.cols),
                },
                arrangement: {
                    source: this.arrangementSource || null,
                    spec: this.anonymizeFeedbackValue(this.arrangementSpec || null, anonymizer),
                    stats: this.anonymizeFeedbackValue(this.arrangementStats || null, anonymizer),
                    interpretation: this.anonymizeFeedbackValue(this.arrangementInterpretation || null, anonymizer),
                },
                scoring: {
                    quality: this.anonymizeFeedbackValue(quality, anonymizer),
                    constraints: this.anonymizeFeedbackValue(constraintEvaluation, anonymizer),
                },
            },
            diagnosticEvents: this.anonymizeFeedbackValue(this._diagnosticEvents || [], anonymizer),
            lastErrors: this.anonymizeFeedbackValue(this._lastErrors || [], anonymizer),
            quality: {
                feasible: Boolean(quality.feasible),
                percent: quality.percent,
                label: quality.label,
                hardScore: quality.hardScore,
                softScore: quality.softScore,
                hardViolationCount: quality.hardViolationCount,
                softViolationCount: quality.softViolationCount,
                topIssues: this.anonymizeFeedbackValue(quality.topIssues || [], anonymizer),
            },
            anonymizer,
        };
        return snapshot;
    },

    async buildFeedbackPayload() {
        const snapshot = this.buildFeedbackSnapshot();
        const { anonymizer, ...safeSnapshot } = snapshot;
        safeSnapshot.backendDiagnostics = await this.loadBackendDiagnostics();
        const message = document.getElementById('sp-feedback-message')?.value?.trim() || '';
        const expected = document.getElementById('sp-feedback-expected')?.value?.trim() || '';
        const win = typeof window !== 'undefined' ? window : null;
        return {
            message: this.redactDiagnosticText(this.anonymizeFeedbackText(message, anonymizer), 2000),
            expected: this.redactDiagnosticText(this.anonymizeFeedbackText(expected, anonymizer), 1000),
            category: this.getFeedbackSelection('category', 'other'),
            severity: this.getFeedbackSelection('severity', 'workaround'),
            snapshot: safeSnapshot,
            screenshot: this._feedbackScreenshot,
            client: {
                url: win?.location?.href || '',
                width: win?.innerWidth || 0,
                height: win?.innerHeight || 0,
                theme: document.body?.classList?.contains('light-mode') ? 'light' : 'dark',
                sentAt: new Date().toISOString(),
            },
        };
    },

    async submitFeedback() {
        const button = document.getElementById('sp-feedback-submit');
        const message = document.getElementById('sp-feedback-message')?.value?.trim() || '';
        if (message.length < 5) {
            this.showToast('请至少写 5 个字，方便我们复现问题', 'warning');
            return;
        }

        const originalHtml = button?.innerHTML;
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> 提交中';
            if (window.lucide) window.lucide.createIcons();
        }

        try {
            if (this._feedbackScreenshotPromise) {
                this.setFeedbackScreenshotStatus('正在完成截图...', 'loading');
                await this._feedbackScreenshotPromise;
            }
            const response = await seatingApi.fetchFeedback(await this.buildFeedbackPayload());
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.success) {
                throw new Error(result.error || '反馈提交失败');
            }
            const id = result.data?.id || '已记录';
            this.closeFeedbackDialog();
            const messageInput = document.getElementById('sp-feedback-message');
            const expectedInput = document.getElementById('sp-feedback-expected');
            if (messageInput) messageInput.value = '';
            if (expectedInput) expectedInput.value = '';
            this.showToast(`反馈已提交：${id}`, 'success');
        } catch (error) {
            this.showToast(error.message || '反馈提交失败，请稍后再试', 'error');
        } finally {
            if (button) {
                button.disabled = false;
                button.innerHTML = originalHtml;
                if (window.lucide) window.lucide.createIcons();
            }
        }
    }
};
