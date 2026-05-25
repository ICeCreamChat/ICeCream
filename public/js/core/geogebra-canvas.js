const GEOGEBRA_RUNTIME_VERSION = 'chat-with-geogebra-next-20260525';
const GEOGEBRA_SCRIPT_SRC = `/vendor/geogebra/deployggb.js?v=${GEOGEBRA_RUNTIME_VERSION}`;
const GEOGEBRA_CODEBASE = '/vendor/geogebra/HTML5/5.0/web3d/';
const GEOGEBRA_IFRAME_SRC = '/vendor/geogebra/HTML5/5.0/GeoGebra.html?appName=classic&showToolBar=true&showMenuBar=true&showAlgebraInput=false';
const GEOGEBRA_APPLET_ID = 'icecreamGeoGebraApplet';
const DEFAULT_PERSPECTIVE = 'G';
const SCRIPT_READY_TIMEOUT_MS = 15000;
const APPLET_READY_TIMEOUT_MS = 30000;
const RESIZE_DEBOUNCE_MS = 160;

function waitForNextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function waitForGgbAppletConstructor(timeoutMs = SCRIPT_READY_TIMEOUT_MS) {
    if (window.GGBApplet) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const poll = () => {
            if (window.GGBApplet) {
                resolve();
                return;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                reject(new Error('GeoGebra runtime constructor is not available'));
                return;
            }
            window.setTimeout(poll, 50);
        };
        poll();
    });
}

function normalizeCommand(command) {
    return String(command || '').trim();
}

function readObjectNames(api) {
    try {
        const names = api?.getAllObjectNames?.();
        return Array.isArray(names) ? names.map(String) : [];
    } catch {
        return [];
    }
}

function readObjectSummary(api, objectName) {
    const entry = { name: objectName };
    try {
        entry.type = api.getObjectType?.(objectName) || '';
    } catch {
        entry.type = '';
    }
    try {
        entry.definition = api.getDefinitionString?.(objectName, true) || '';
    } catch {
        entry.definition = '';
    }
    try {
        entry.value = api.getValueString?.(objectName, true) || '';
    } catch {
        entry.value = '';
    }
    return entry;
}

function normalizeObjectNames(names = []) {
    return Array.isArray(names)
        ? names.map(item => {
            if (item && typeof item === 'object') {
                return String(item.name || item.label || '').trim();
            }
            return String(item || '').trim();
        }).filter(Boolean)
        : [];
}

function readFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeViewport(viewport = {}) {
    const xmin = readFiniteNumber(viewport.xmin);
    const ymin = readFiniteNumber(viewport.ymin);
    const xmax = readFiniteNumber(viewport.xmax);
    const ymax = readFiniteNumber(viewport.ymax);
    if ([xmin, ymin, xmax, ymax].some(value => value === null)) return null;
    if (xmax <= xmin || ymax <= ymin) return null;
    return {
        xmin,
        ymin,
        xmax,
        ymax,
        equalScale: viewport.equalScale !== false,
    };
}

function expandBoundsToAspect(viewport, width, height) {
    const targetAspect = Math.max(width, 1) / Math.max(height, 1);
    const centerX = (viewport.xmin + viewport.xmax) / 2;
    const centerY = (viewport.ymin + viewport.ymax) / 2;
    let mathWidth = Math.max(viewport.xmax - viewport.xmin, 1);
    let mathHeight = Math.max(viewport.ymax - viewport.ymin, 1);
    const mathAspect = mathWidth / mathHeight;

    if (mathAspect < targetAspect) {
        mathWidth = mathHeight * targetAspect;
    } else if (mathAspect > targetAspect) {
        mathHeight = mathWidth / targetAspect;
    }

    return {
        xmin: centerX - mathWidth / 2,
        xmax: centerX + mathWidth / 2,
        ymin: centerY - mathHeight / 2,
        ymax: centerY + mathHeight / 2,
    };
}

class GeoGebraCanvas {
    constructor() {
        this.scriptPromise = null;
        this.appletPromise = null;
        this.appletApi = null;
        this.containerId = 'geogebra-canvas-root';
        this.loaded = false;
        this.lastPerspective = DEFAULT_PERSPECTIVE;
        this.selectedObjectNames = [];
        this.resizeObserver = null;
        this.resizeHandler = null;
        this.resizeTimer = 0;
        this.geogebraRuntimeMode = 'direct';
        this.iframeWindow = null;
        this.lastEqualScaleViewport = null;
    }

    async mount(containerId = 'geogebra-canvas-root') {
        this.containerId = containerId;
        const host = this.getHost();
        this.setCanvasState(host, 'loading');

        try {
            this.geogebraRuntimeMode = 'direct';
            await this.loadScript();
            await this.injectApplet();
            await this.whenReady();
            await waitForNextFrame();
            this.resize();
            this.observeResize();
            return this.getApi();
        } catch (error) {
            return this.mountIframeFallback(error);
        }
    }

    async rebuild(containerId = this.containerId) {
        this.containerId = containerId;
        this.disconnectResizeObserver();
        this.appletApi = null;
        this.appletPromise = null;
        this.loaded = false;
        this.selectedObjectNames = [];
        this.geogebraRuntimeMode = 'direct';
        this.iframeWindow = null;
        this.lastEqualScaleViewport = null;
        this.resetGlobalAppletState();
        const host = this.getHost(false);
        if (host) {
            host.innerHTML = '';
            this.setCanvasState(host, 'idle');
            host.dataset.geogebraReady = 'false';
        }
        return this.mount(containerId);
    }

    loadScript() {
        if (window.GGBApplet) {
            return waitForGgbAppletConstructor();
        }
        if (this.scriptPromise) {
            return this.scriptPromise;
        }

        this.scriptPromise = new Promise((resolve, reject) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                waitForGgbAppletConstructor().then(resolve, reject);
            };
            const fail = () => {
                if (settled) return;
                settled = true;
                reject(new Error('GeoGebra runtime load failed'));
            };

            const existingScript = document.querySelector('script[data-geogebra-runtime="true"]');
            if (existingScript) {
                existingScript.addEventListener('load', finish, { once: true });
                existingScript.addEventListener('error', fail, { once: true });
                waitForGgbAppletConstructor().then(resolve, reject);
                return;
            }

            const script = document.createElement('script');
            script.src = GEOGEBRA_SCRIPT_SRC;
            script.async = true;
            script.dataset.geogebraRuntime = 'true';
            script.onload = finish;
            script.onerror = fail;
            (document.body || document.head).appendChild(script);
        });

        return this.scriptPromise;
    }

    injectApplet() {
        const host = this.getHost();
        if (this.appletApi && host.dataset.geogebraReady === 'true') {
            this.observeResize();
            this.resize();
            return this.appletPromise || Promise.resolve(this.appletApi);
        }
        if (!window.GGBApplet) {
            throw new Error('GeoGebra runtime is not ready');
        }

        this.disconnectResizeObserver();
        this.appletApi = null;
        this.loaded = false;
        this.selectedObjectNames = [];
        this.resetGlobalAppletState({ keepDomApplet: true });
        host.innerHTML = '';
        host.dataset.geogebraReady = 'false';
        this.setCanvasState(host, 'loading');

        this.appletPromise = new Promise((resolve, reject) => {
            const failTimer = window.setTimeout(() => {
                this.setCanvasState(host, 'error', 'GeoGebra applet load timed out');
                reject(new Error('GeoGebra applet load timed out'));
            }, APPLET_READY_TIMEOUT_MS);

            const appletParams = {
                id: GEOGEBRA_APPLET_ID,
                appName: 'classic',
                width: '100%',
                height: '100%',
                showToolBar: true,
                showAlgebraInput: false,
                showMenuBar: true,
                enableLabelDrags: false,
                enableShiftDragZoom: true,
                enableRightClick: true,
                enable3d: true,
                enableUndoRedo: true,
                errorDialogsActive: false,
                showResetIcon: true,
                useBrowserForJS: false,
                allowStyleBar: false,
                scaleContainerClass: 'geogebra-canvas-root',
                preventFocus: false,
                language: 'zh',
                appletOnLoad: (api) => {
                    window.clearTimeout(failTimer);
                    this.appletApi = api;
                    window.ggbApplet = api;
                    window[GEOGEBRA_APPLET_ID] = api;
                    window.ggbAppletReady = true;
                    this.loaded = true;
                    host.dataset.geogebraReady = 'true';
                    this.setCanvasState(host, 'ready');
                    this.bindSelectionListener(api);
                    this.setPerspective(this.lastPerspective);
                    this.resize();
                    this.observeResize();
                    resolve(api);
                },
            };

            try {
                const applet = new window.GGBApplet(appletParams, true);
                applet.setHTML5Codebase('/vendor/geogebra/HTML5/5.0/web3d/');
                applet.inject(this.containerId);
            } catch (error) {
                window.clearTimeout(failTimer);
                this.setCanvasState(host, 'error', error?.message || 'GeoGebra applet inject failed');
                reject(error);
            }
        });

        return this.appletPromise;
    }

    mountIframeFallback(reason) {
        const host = this.getHost();
        this.disconnectResizeObserver();
        host.innerHTML = '';
        this.geogebraRuntimeMode = 'iframe';
        this.loaded = true;
        this.selectedObjectNames = [];
        this.setCanvasState(host, 'ready');
        host.dataset.geogebraReady = 'true';
        host.dataset.geogebraRuntimeMode = 'iframe';
        if (reason?.message) {
            host.dataset.geogebraFallbackReason = reason.message;
        }

        const iframe = document.createElement('iframe');
        iframe.className = 'geogebra-iframe-fallback';
        iframe.title = 'GeoGebra fallback runtime';
        iframe.src = GEOGEBRA_IFRAME_SRC;
        iframe.allow = 'fullscreen';
        iframe.setAttribute('data-geogebra-iframe-fallback', 'true');
        iframe.addEventListener('load', () => {
            this.iframeWindow = iframe.contentWindow;
            this.postIframeMessage('setLanguage', { language: 'zh-CN' });
            this.postIframeMessage('edit', { showToolBar: true });
        });
        host.appendChild(iframe);
        this.iframeWindow = iframe.contentWindow;

        const bridgeApi = this.createIframeBridgeApi();
        this.appletApi = bridgeApi;
        window.ggbApplet = bridgeApi;
        window[GEOGEBRA_APPLET_ID] = bridgeApi;
        window.ggbAppletReady = true;
        this.observeResize();
        return Promise.resolve(bridgeApi);
    }

    postIframeMessage(action, payload = {}) {
        const frame = this.getHost(false)?.querySelector?.('.geogebra-iframe-fallback');
        const targetWindow = this.iframeWindow || frame?.contentWindow;
        if (!targetWindow) return false;
        targetWindow.postMessage(JSON.stringify({ action, ...payload }), '*');
        return true;
    }

    createIframeBridgeApi() {
        return {
            evalCommand: (command) => this.postIframeMessage('eval', { command }),
            asyncEvalCommandGetLabels: async (command) => {
                const sent = this.postIframeMessage('eval', { command });
                return sent ? '' : Promise.reject(new Error('GeoGebra iframe fallback is not ready'));
            },
            getAllObjectNames: () => [],
            getXML: () => '',
            setXML: () => false,
            getBase64: (callback) => {
                this.postIframeMessage('getggb');
                if (typeof callback === 'function') callback('');
                return '';
            },
            setBase64: (base64, callback) => {
                this.postIframeMessage('setggb', { base64 });
                if (typeof callback === 'function') callback();
            },
            newConstruction: () => this.postIframeMessage('reset'),
            reset: () => this.postIframeMessage('reset'),
            setPerspective: (perspective) => this.postIframeMessage('perspective', { perspective }),
            setCoordSystem: (xmin, xmax, ymin, ymax) => this.postIframeMessage('eval', {
                command: `ZoomIn(${xmin}, ${ymin}, ${xmax}, ${ymax})`,
            }),
            setSize: () => true,
            getPNGBase64: () => '',
            remove: () => {
                const host = this.getHost(false);
                if (host) host.innerHTML = '';
            },
        };
    }

    bindSelectionListener(api) {
        try {
            api.registerClientListener?.((event = {}) => {
                const target = event.target ? String(event.target) : '';
                switch (event.type) {
                    case 'select':
                        if (target && !this.selectedObjectNames.includes(target)) {
                            this.selectedObjectNames = [target, ...this.selectedObjectNames].slice(0, 20);
                        }
                        break;
                    case 'deselect':
                        if (target) {
                            this.selectedObjectNames = this.selectedObjectNames.filter(name => name !== target);
                        } else {
                            this.selectedObjectNames = [];
                        }
                        break;
                    default:
                        break;
                }
            });
        } catch {
            this.selectedObjectNames = [];
        }
    }

    whenReady() {
        if (this.appletApi) {
            return Promise.resolve(this.appletApi);
        }
        if (window.ggbAppletReady && window.ggbApplet) {
            this.appletApi = window.ggbApplet;
            return Promise.resolve(this.appletApi);
        }
        if (!this.appletPromise) {
            return this.mount(this.containerId);
        }
        return this.appletPromise;
    }

    getApi() {
        return this.appletApi || window.ggbApplet || window[GEOGEBRA_APPLET_ID] || null;
    }

    getHost(required = true) {
        const host = document.getElementById(this.containerId);
        if (!host && required) {
            throw new Error('GeoGebra canvas container is missing');
        }
        return host;
    }

    setCanvasState(host, state, error = '') {
        if (!host) return;
        host.dataset.geogebraState = state;
        if (error) {
            host.dataset.geogebraError = error;
        } else {
            delete host.dataset.geogebraError;
        }
    }

    resetGlobalAppletState(options = {}) {
        window.ggbAppletReady = false;
        window.ggbLastCommandError = '';
        if (!options.keepDomApplet) {
            try {
                window.ggbApplet?.remove?.();
            } catch {
                // The vendored applet may already have removed its DOM.
            }
        }
        window.ggbApplet = null;
        window[GEOGEBRA_APPLET_ID] = null;
    }

    observeResize() {
        const host = this.getHost(false);
        if (!host) return;
        this.disconnectResizeObserver();
        const scheduleResize = () => {
            window.clearTimeout(this.resizeTimer);
            this.resizeTimer = window.setTimeout(() => this.resize(), RESIZE_DEBOUNCE_MS);
        };
        this.resizeHandler = scheduleResize;
        if (window.ResizeObserver) {
            this.resizeObserver = new ResizeObserver(scheduleResize);
            this.resizeObserver.observe(host);
        }
        window.addEventListener('resize', scheduleResize);
    }

    disconnectResizeObserver() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.resizeHandler) {
            window.removeEventListener('resize', this.resizeHandler);
            this.resizeHandler = null;
        }
        window.clearTimeout(this.resizeTimer);
        this.resizeTimer = 0;
    }

    async executeCommand(command) {
        const normalizedCommand = normalizeCommand(command);
        if (!normalizedCommand) {
            return { command: normalizedCommand, success: false, label: '', error: 'Empty GeoGebra command' };
        }

        await this.whenReady();
        const api = this.getApi();
        if (!api) {
            return { command: normalizedCommand, success: false, label: '', error: 'GeoGebra applet is not ready' };
        }

        try {
            window.ggbLastCommandError = '';
            let label = '';
            if (typeof api.asyncEvalCommandGetLabels === 'function') {
                label = await api.asyncEvalCommandGetLabels(normalizedCommand);
                if (window.ggbLastCommandError) {
                    return {
                        command: normalizedCommand,
                        success: false,
                        label: String(label || ''),
                        error: window.ggbLastCommandError,
                    };
                }
            } else {
                const accepted = api.evalCommand(normalizedCommand);
                if (accepted === false) {
                    return { command: normalizedCommand, success: false, label: '', error: 'GeoGebra rejected the command' };
                }
            }
            return { command: normalizedCommand, success: true, label: String(label || ''), error: '' };
        } catch (error) {
            return {
                command: normalizedCommand,
                success: false,
                label: '',
                error: error?.message || 'GeoGebra command failed',
            };
        } finally {
            window.ggbLastCommandError = '';
        }
    }

    async executeCommands(commands = []) {
        const records = [];
        for (const command of commands) {
            const executionRecord = await this.executeCommand(command);
            records.push(executionRecord);
            if (!executionRecord.success) {
                break;
            }
        }
        return records;
    }

    async fitBoundsEqualScale(viewport = {}, options = {}) {
        const normalizedViewport = normalizeViewport(viewport);
        if (!normalizedViewport) return false;
        if (!normalizedViewport.equalScale) {
            this.lastEqualScaleViewport = null;
            return false;
        }

        await this.whenReady();
        const api = this.getApi();
        const host = this.getHost(false);
        if (!api || !host) return false;

        const width = Math.max(host.clientWidth || host.getBoundingClientRect?.().width || 0, 320);
        const height = Math.max(host.clientHeight || host.getBoundingClientRect?.().height || 0, 320);
        const fitted = expandBoundsToAspect(normalizedViewport, width, height);
        if (options.remember !== false) {
            this.lastEqualScaleViewport = normalizedViewport;
        }

        try {
            if (typeof api.setCoordSystem === 'function') {
                api.setCoordSystem(fitted.xmin, fitted.xmax, fitted.ymin, fitted.ymax);
            } else if (typeof api.evalCommand === 'function') {
                api.evalCommand(`ZoomIn(${fitted.xmin}, ${fitted.ymin}, ${fitted.xmax}, ${fitted.ymax})`);
            }
            if (typeof api.evalCommand === 'function') {
                api.evalCommand('SetAxesRatio(1, 1)');
            } else if (typeof api.asyncEvalCommandGetLabels === 'function') {
                await api.asyncEvalCommandGetLabels('SetAxesRatio(1, 1)');
            }
            return true;
        } catch {
            try {
                await this.executeCommand('SetAxesRatio(1, 1)');
                return true;
            } catch {
                return false;
            }
        }
    }

    async reapplyEqualScaleViewport() {
        if (!this.lastEqualScaleViewport) return false;
        return this.fitBoundsEqualScale(this.lastEqualScaleViewport, { remember: false });
    }

    readCanvas() {
        const api = this.getApi();
        if (!api) {
            return {
                xml: '',
                objects: [],
                selectedObjects: [],
                perspective: this.lastPerspective,
            };
        }

        const objectNames = readObjectNames(api);
        const objects = objectNames.slice(0, 80).map(name => readObjectSummary(api, name));
        let xml = '';
        try {
            xml = api.getXML?.() || '';
        } catch {
            xml = '';
        }

        return {
            xml,
            objects,
            selectedObjects: this.selectedObjectNames,
            perspective: this.lastPerspective,
        };
    }

    readSelectedObjects() {
        const api = this.getApi();
        if (!api) return [];
        return this.selectedObjectNames.map(name => readObjectSummary(api, name));
    }

    setSelectedObjectNames(names = []) {
        this.selectedObjectNames = normalizeObjectNames(names).slice(0, 20);
        const api = this.getApi();
        if (!api || !this.selectedObjectNames.length) return;
        try {
            api.setSelected?.(this.selectedObjectNames);
        } catch {
            // Selection is mirrored in Studio state even when the offline applet lacks setSelected.
        }
    }

    captureSnapshot(label = '') {
        const canvas = this.readCanvas();
        return {
            label: String(label || '').slice(0, 120),
            xml: canvas.xml || '',
            objects: canvas.objects || [],
            selectedObjects: canvas.selectedObjects || [],
            perspective: canvas.perspective || this.lastPerspective,
            createdAt: new Date().toISOString(),
        };
    }

    async setXML(xml) {
        const xmlText = String(xml || '').trim();
        if (!xmlText) return false;
        await this.whenReady();
        const api = this.getApi();
        if (!api || typeof api.setXML !== 'function') return false;

        api.setXML(xmlText);
        await waitForNextFrame();
        this.resize();
        this.selectedObjectNames = [];
        return true;
    }

    async restoreSnapshot(snapshot = {}) {
        const restored = await this.setXML(snapshot.xml || '');
        if (restored) {
            this.setPerspective(snapshot.perspective || this.lastPerspective || DEFAULT_PERSPECTIVE);
            this.setSelectedObjectNames(snapshot.selectedObjects || []);
        }
        return restored ? this.readCanvas() : null;
    }

    setPerspective(perspective = DEFAULT_PERSPECTIVE) {
        const nextPerspective = String(perspective || DEFAULT_PERSPECTIVE).trim() || DEFAULT_PERSPECTIVE;
        this.lastPerspective = nextPerspective;
        const api = this.getApi();
        try {
            api?.setPerspective?.(nextPerspective);
        } catch {
            // Older offline builds may reject newer perspective names; keep the applet usable.
        }
    }

    reset() {
        const api = this.getApi();
        try {
            api?.newConstruction?.();
        } catch {
            try {
                api?.reset?.();
            } catch {
                // Reset is best effort because some applet states temporarily lock commands.
            }
        }
        this.selectedObjectNames = [];
        this.lastEqualScaleViewport = null;
    }

    resize() {
        const api = this.getApi();
        const host = this.getHost(false);
        if (!host || !api) return;
        const width = Math.max(host.clientWidth || host.getBoundingClientRect?.().width || 0, 320);
        const height = Math.max(host.clientHeight || host.getBoundingClientRect?.().height || 0, 320);
        try {
            api.setSize?.(width, height);
        } catch {
            try {
                api.refreshViews?.();
            } catch {
                // Rendering remains functional even if resize hooks are unavailable.
            }
        }
        if (this.lastEqualScaleViewport) {
            void this.fitBoundsEqualScale(this.lastEqualScaleViewport, { remember: false });
        }
    }

    exportPngBase64() {
        const api = this.getApi();
        try {
            return api?.getPNGBase64?.(1, true, 96, false, true) || '';
        } catch {
            return '';
        }
    }

    async getBase64() {
        const api = this.getApi();
        if (!api || typeof api.getBase64 !== 'function') return '';
        try {
            if (api.getBase64.length > 0) {
                return await new Promise(resolve => {
                    api.getBase64(value => resolve(String(value || '')));
                });
            }
            return String(api.getBase64() || '');
        } catch {
            return '';
        }
    }

    async setBase64(base64) {
        const base64Text = String(base64 || '').trim();
        if (!base64Text) return false;
        await this.whenReady();
        const api = this.getApi();
        if (!api || typeof api.setBase64 !== 'function') return false;
        try {
            await new Promise(resolve => {
                const maybeResult = api.setBase64(base64Text, () => resolve(true));
                if (api.setBase64.length < 2) {
                    resolve(maybeResult !== false);
                }
            });
            await waitForNextFrame();
            this.resize();
            this.selectedObjectNames = [];
            return true;
        } catch {
            return false;
        }
    }

    async exportGgbBase64() {
        return this.getBase64();
    }
}

export const geogebraCanvas = new GeoGebraCanvas();
export { GEOGEBRA_SCRIPT_SRC, GEOGEBRA_CODEBASE, GEOGEBRA_IFRAME_SRC, GEOGEBRA_APPLET_ID, waitForGgbAppletConstructor };
