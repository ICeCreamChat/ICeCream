/**
 * MathSolver - StateManager Module
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Centralized state management to eliminate global variables.
 */
const StateManager = {
    // ==========================================
    // Private State
    // ==========================================
    _state: {
        // TTS
        isTTSEnabled: false,

        // Theme
        isManualTheme: false,

        // Context Panel
        isManualContextSwitch: false,

        // Cropper
        cropper: null,
        croppedImageData: null,
        originalImageFile: null,

        // 3D Scene
        scene: null,
        camera: null,
        renderer: null,
        particles: null,
        clock: null,
        animationFrameId: null,
        isPageVisible: true,

        // Chat Sessions (loaded from localStorage)
        chatSessions: [],
        currentSessionId: null
    },

    // ==========================================
    // Initialization
    // ==========================================
    init() {
        // Safe JSON parse helper
        const safeJsonParse = (str, fallback) => {
            try {
                return str ? JSON.parse(str) : fallback;
            } catch (e) {
                console.error('Storage 解析失败:', e);
                return fallback;
            }
        };

        this._state.chatSessions = safeJsonParse(localStorage.getItem('mathSolverSessions'), []);
        this._state.currentSessionId = localStorage.getItem('mathSolverCurrentSession') || null;

        // Expose safeJsonParse for other modules
        window.safeJsonParse = safeJsonParse;
    },

    // ==========================================
    // Getters
    // ==========================================
    get(key) {
        return this._state[key];
    },

    // ==========================================
    // Setters
    // ==========================================
    set(key, value) {
        if (key in this._state) {
            this._state[key] = value;
        } else {
            console.warn(`StateManager: Unknown state key "${key}"`);
        }
    },

    // ==========================================
    // Chat Session Helpers
    // ==========================================
    getChatSessions() {
        return this._state.chatSessions;
    },

    setChatSessions(sessions) {
        this._state.chatSessions = sessions;
    },

    getCurrentSessionId() {
        return this._state.currentSessionId;
    },

    setCurrentSessionId(id) {
        this._state.currentSessionId = id;
        localStorage.setItem('mathSolverCurrentSession', id);
    },

    saveSessionsToStorage() {
        localStorage.setItem('mathSolverSessions', JSON.stringify(this._state.chatSessions));
    },

    findSession(id) {
        return this._state.chatSessions.find(s => s.id === id);
    },

    getCurrentSession() {
        return this.findSession(this._state.currentSessionId);
    },

    // ==========================================
    // 3D Scene Helpers
    // ==========================================
    setSceneObjects(scene, camera, renderer, particles, clock) {
        this._state.scene = scene;
        this._state.camera = camera;
        this._state.renderer = renderer;
        this._state.particles = particles;
        this._state.clock = clock;
    },

    getSceneObjects() {
        return {
            scene: this._state.scene,
            camera: this._state.camera,
            renderer: this._state.renderer,
            particles: this._state.particles,
            clock: this._state.clock
        };
    }
};

// Expose to window
window.StateManager = StateManager;
