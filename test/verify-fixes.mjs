import { parseGeoGebraAgentReply } from '../services/geogebra/geogebra-agent.js';

// Test: truncated JSON (AI cut off mid-ShowLabel command)
const truncated = '{"summary":"三角形","perspective":"G","commands":["A = (0, 0)","B = (4, 0)","C = (1, 3)","poly = Polygon(A, B, C)","ShowLa';
const r = parseGeoGebraAgentReply(truncated);
console.log('Commands:', JSON.stringify(r.commands));
console.log('Summary:', r.summary);

if (r.commands.length >= 4) {
    console.log('✅ PASS: truncated JSON repaired, got', r.commands.length, 'commands');
} else {
    console.error('❌ FAIL: expected at least 4 commands, got', r.commands.length);
    process.exit(1);
}

// Test: Fermat point detection
import { tryCreateGeoGebraProblemPlan } from '../services/geogebra/problem-types.js';
const fermatPlan = tryCreateGeoGebraProblemPlan({
    message: '已知三角形ABC的三个内角都小于120度，在三角形内部找一点P，使得PA+PB+PC最小'
});
if (fermatPlan && fermatPlan.problemType === 'fermat_point') {
    console.log('✅ PASS: Fermat point template matched');
} else {
    console.error('❌ FAIL: Fermat point template not matched');
    process.exit(1);
}
