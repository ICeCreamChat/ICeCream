const ANIMATION_ENGINE_KEY = 'icecream_animation_engine_v1';
const ANIMATION_ENGINES = new Set(['manim', 'geogebra']);

function normalizeAnimationEngine(engine) {
    return ANIMATION_ENGINES.has(engine) ? engine : 'manim';
}

function readStoredAnimationEngine() {
    try {
        if (typeof window === 'undefined') return 'manim';
        return normalizeAnimationEngine(window.localStorage?.getItem(ANIMATION_ENGINE_KEY));
    } catch {
        return 'manim';
    }
}

let currentAnimationEngine = readStoredAnimationEngine();

export function getAnimationEngine() {
    return currentAnimationEngine;
}

export function setAnimationEngine(engine) {
    const nextEngine = normalizeAnimationEngine(engine);
    currentAnimationEngine = nextEngine;
    try {
        if (typeof window !== 'undefined') {
            window.localStorage?.setItem(ANIMATION_ENGINE_KEY, nextEngine);
        }
    } catch {
        // The selected engine is still kept for the current page session.
    }
    return currentAnimationEngine;
}

export function isGeoGebraAnimationEngine() {
    return currentAnimationEngine === 'geogebra';
}

export { ANIMATION_ENGINE_KEY };
