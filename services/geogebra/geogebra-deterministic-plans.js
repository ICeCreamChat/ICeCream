/**
 * @deprecated This module is retained for backward compatibility only.
 * It serves as a fallback when AI configuration is unavailable.
 * Do NOT add new deterministic templates here.
 * The primary GeoGebra planning path is now the general AI Planner
 * in geogebra-agent.js → requestGeoGebraCompletion.
 */
import { tryCreateGeoGebraProblemPlan } from './problem-types.js';

export function tryCreateDeterministicGeoGebraPlan(requestPayload = {}) {
    return tryCreateGeoGebraProblemPlan(requestPayload);
}
