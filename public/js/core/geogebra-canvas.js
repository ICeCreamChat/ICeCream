const GEOGEBRA_SCRIPT_SRC = '/vendor/geogebra/deployggb.js';
const GEOGEBRA_CODEBASE = '/vendor/geogebra/HTML5/5.0/web3d/';
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
    }

    async mount(containerId = 'geogebra-canvas-root') {
        this.containerId = containerId;
        const host = this.getHost();
        this.setCanvasState(host, 'loading');

        await this.loadScript();
        await this.injectApplet();
        await this.whenReady();
        await waitForNextFrame();
        this.resize();
        this.observeResize();
        return this.getApi();
    }

    async rebuild(containerId = this.containerId) {
        this.containerId = containerId;
        this.disconnectResizeObserver();
        this.appletApi = null;
        this.appletPromise = null;
        this.loaded = false;
        this.selectedObjectNames = [];
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

            const existingScript = document.querySelector(`script[src="${GEOGEBRA_SCRIPT_SRC}"]`);
            if (existingScript) {
                existingScript.addEventListener('load', finish, { once: true });
                existingScript.addEventListener('error', fail, { once: true });
                waitForGgbAppletConstructor().then(resolve, reject);
                return;
            }

            const script = document.createElement('script');
            script.src = GEOGEBRA_SCRIPT_SRC;
            script.async = true;
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
    }

    exportPngBase64() {
        const api = this.getApi();
        try {
            return api?.getPNGBase64?.(1, true, 96, false, true) || '';
        } catch {
            return '';
        }
    }
}

export const geogebraCanvas = new GeoGebraCanvas();
export { GEOGEBRA_SCRIPT_SRC, GEOGEBRA_CODEBASE, GEOGEBRA_APPLET_ID, waitForGgbAppletConstructor };
