import { tryCreateGeoGebraProblemPlan } from './problem-types.js';

export function tryCreateDeterministicGeoGebraPlan(requestPayload = {}) {
    return tryCreateGeoGebraProblemPlan(requestPayload);
}
