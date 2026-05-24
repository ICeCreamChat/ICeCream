const GEOGEBRA_SCRIPT_SRC = '/vendor/geogebra/deployggb.js';
const GEOGEBRA_CODEBASE = '/vendor/geogebra/HTML5/5.0/web3d/';
const GEOGEBRA_APPLET_ID = 'icecreamGeoGebraApplet';
const DEFAULT_PERSPECTIVE = 'G';

function waitForNextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
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
    }

    async mount(containerId = 'geogebra-canvas-root') {
        this.containerId = containerId;
        await this.loadScript();
        this.injectApplet();
        await this.whenReady();
        await waitForNextFrame();
        this.resize();
        return this.getApi();
    }

    loadScript() {
        if (window.GGBApplet) {
            return Promise.resolve();
        }
        if (this.scriptPromise) {
            return this.scriptPromise;
        }

        this.scriptPromise = new Promise((resolve, reject) => {
            const existingScript = document.querySelector(`script[src="${GEOGEBRA_SCRIPT_SRC}"]`);
            if (existingScript) {
                existingScript.addEventListener('load', () => resolve(), { once: true });
                existingScript.addEventListener('error', () => reject(new Error('GeoGebra runtime load failed')), { once: true });
                return;
            }

            const script = document.createElement('script');
            script.src = GEOGEBRA_SCRIPT_SRC;
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('GeoGebra runtime load failed'));
            document.head.appendChild(script);
        });

        return this.scriptPromise;
    }

    injectApplet() {
        const host = document.getElementById(this.containerId);
        if (!host) {
            throw new Error('GeoGebra canvas container is missing');
        }
        if (this.appletApi && host.dataset.geogebraReady === 'true') {
            return;
        }

        host.dataset.geogebraReady = 'false';
        host.innerHTML = '';
        this.loaded = false;

        this.appletPromise = new Promise((resolve, reject) => {
            const failTimer = window.setTimeout(() => {
                reject(new Error('GeoGebra applet load timed out'));
            }, 30000);

            const applet = new window.GGBApplet({
                id: GEOGEBRA_APPLET_ID,
                appName: 'classic',
                width: Math.max(host.clientWidth, 720),
                height: Math.max(host.clientHeight, 520),
                showToolBar: true,
                showMenuBar: false,
                showAlgebraInput: true,
                enableLabelDrags: true,
                enableShiftDragZoom: true,
                enableRightClick: true,
                showResetIcon: true,
                allowStyleBar: true,
                errorDialogsActive: false,
                language: 'zh',
                appletOnLoad: (api) => {
                    window.clearTimeout(failTimer);
                    this.appletApi = api;
                    this.loaded = true;
                    host.dataset.geogebraReady = 'true';
                    this.bindSelectionListener(api);
                    this.setPerspective(this.lastPerspective);
                    resolve(api);
                },
            }, true);

            applet.setHTML5Codebase('/vendor/geogebra/HTML5/5.0/web3d/');
            applet.inject(this.containerId);
        });
    }

    bindSelectionListener(api) {
        try {
            api.registerClientListener?.((event = {}) => {
                if (event.type === 'select') {
                    this.selectedObjectNames = event.target ? [String(event.target)] : [];
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
        if (!this.appletPromise) {
            return this.mount(this.containerId);
        }
        return this.appletPromise;
    }

    getApi() {
        return this.appletApi || window[GEOGEBRA_APPLET_ID] || window.ggbApplet || null;
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
            let label = '';
            if (typeof api.asyncEvalCommandGetLabels === 'function') {
                label = await api.asyncEvalCommandGetLabels(normalizedCommand);
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
        const host = document.getElementById(this.containerId);
        if (!host || !api) return;
        try {
            api.setSize?.(Math.max(host.clientWidth, 320), Math.max(host.clientHeight, 320));
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
export { GEOGEBRA_SCRIPT_SRC, GEOGEBRA_CODEBASE, GEOGEBRA_APPLET_ID };
