import { CELL } from '../../public/js/tools/classroom-layout.js';
import {
    hasLocalAisle,
    normalizeLocalAisles,
} from '../../public/js/tools/seating-core.js';

const DEFAULT_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 500;
const TIMEFOLD_SUPPORTED_CONSTRAINT_TYPES = new Set([
    'front_row',
    'back_row',
    'avoid',
    'not_adjacent',
    'prefer',
    'prefer_near',
    'pair',
    'must_adjacent',
    'avoid_first_row',
    'avoid_last_row',
    'avoid_front_row',
    'avoid_back_row',
    'avoid_behind',
    'prefer_front_middle',
    'prefer_front_mid_rows',
]);

export class TimefoldUnavailableError extends Error {
    constructor(message, reason = 'unavailable') {
        super(message);
        this.name = 'TimefoldUnavailableError';
        this.reason = reason;
    }
}

function asText(value) {
    return String(value ?? '').trim();
}

function normalizeStudentRefKey(value) {
    return asText(value)
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[\s\p{P}\p{S}]+/gu, '')
        .toLowerCase();
}

function numberValue(value, fallback = null) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (/^(true|1|yes|on)$/i.test(value.trim())) return true;
        if (/^(false|0|no|off)$/i.test(value.trim())) return false;
    }
    return Boolean(value);
}

function normalizeGender(value) {
    const text = asText(value).toLowerCase();
    if (text === 'm' || text === 'male' || text === 'man' || text === 'boy' || text === '男') return 'M';
    if (text === 'f' || text === 'female' || text === 'woman' || text === 'girl' || text === '女') return 'F';
    return asText(value);
}

function normalizeSolverUrl(env = {}) {
    const url = asText(env.TIMEFOLD_SOLVER_URL);
    return url ? url.replace(/\/+$/, '') : '';
}

function timeoutMs(env = {}) {
    const seconds = Number(env.TIMEFOLD_SOLVER_TIMEOUT);
    return Number.isFinite(seconds) && seconds > 0
        ? Math.round(seconds * 1000)
        : DEFAULT_TIMEOUT_MS;
}

function seatId(row, col) {
    return `r${row}c${col}`;
}

function parseSeat(value) {
    if (!value) return null;
    if (typeof value === 'object') {
        if (Number.isInteger(value.row) && Number.isInteger(value.col)) {
            return { row: value.row, col: value.col };
        }
        return parseSeat(value.id);
    }
    const match = /^r(-?\d+)c(-?\d+)$/.exec(asText(value));
    if (!match) return null;
    return {
        row: Number.parseInt(match[1], 10),
        col: Number.parseInt(match[2], 10),
    };
}

function resolveConstraintStudentId(value, studentsById, studentsByName, studentsByNormalized) {
    const ref = asText(value?.studentId ?? value?.id ?? value?.name ?? value);
    if (!ref) return null;
    if (studentsById.has(ref)) return ref;
    return studentsByName.get(ref)?.id || studentsByNormalized.get(normalizeStudentRefKey(ref))?.id || null;
}

function constraintTarget(constraint) {
    return constraint?.target ?? constraint?.studentId ?? constraint?.student ?? constraint?.id;
}

function constraintRelated(constraint) {
    return constraint?.related
        ?? constraint?.student2Id
        ?? constraint?.student2
        ?? constraint?.mate
        ?? constraint?.with
        ?? constraint?.other;
}

function buildSeatQualityMap(layout) {
    const rowsWithSeats = [];
    const colsWithSeats = [];
    for (let r = 0; r < layout.rows; r++) {
        if (Array.from({ length: layout.cols }, (_, c) => c).some(c => layout.cells[r]?.[c] === CELL.SEAT)) {
            rowsWithSeats.push(r);
        }
    }
    for (let c = 0; c < layout.cols; c++) {
        if (Array.from({ length: layout.rows }, (_, r) => r).some(r => layout.cells[r]?.[c] === CELL.SEAT)) {
            colsWithSeats.push(c);
        }
    }
    const rowIndex = new Map(rowsWithSeats.map((row, index) => [row, index]));
    const colIndex = new Map(colsWithSeats.map((col, index) => [col, index]));
    const rowPeak = Math.max(0, rowsWithSeats.length * 0.33);
    const rowSigma = rowsWithSeats.length * 0.45 || 1;
    const colCenter = Math.max(0, (colsWithSeats.length - 1) / 2);
    const colSigma = colsWithSeats.length * 0.35 || 1;
    const result = new Map();

    for (let r = 0; r < layout.rows; r++) {
        for (let c = 0; c < layout.cols; c++) {
            if (layout.cells[r]?.[c] !== CELL.SEAT) continue;
            const rowDist = (rowIndex.get(r) ?? 0) - rowPeak;
            const colDist = (colIndex.get(c) ?? 0) - colCenter;
            const rowScore = Math.exp(-(rowDist * rowDist) / (2 * rowSigma * rowSigma));
            const colScore = Math.exp(-(colDist * colDist) / (2 * colSigma * colSigma));
            result.set(`${r},${c}`, Math.round(rowScore * colScore * 100));
        }
    }
    return result;
}

function buildSeatList(layout) {
    const scoreMap = buildSeatQualityMap(layout);
    const seats = [];
    for (let r = 0; r < layout.rows; r++) {
        for (let c = 0; c < layout.cols; c++) {
            if (layout.cells[r]?.[c] !== CELL.SEAT) continue;
            const groupValue = layout.groups?.[r]?.[c] ?? null;
            const groupId = Number.isFinite(Number(groupValue)) ? Number(groupValue) : null;
            seats.push({
                id: seatId(r, c),
                row: r,
                col: c,
                qualityScore: scoreMap.get(`${r},${c}`) ?? 0,
                groupId,
                neighborSeatIds: [],
            });
        }
    }
    const neighbors = computeNeighborSeatIds(
        seats,
        layout.localAisles,
        layout.rows,
        layout.cols
    );
    for (const seat of seats) {
        seat.neighborSeatIds = neighbors.get(seat.id) || [];
    }
    return seats;
}

function isSeparatedByLocalAisle(a, b, localAisles) {
    if (a.row === b.row && Math.abs(a.col - b.col) === 1) {
        return hasLocalAisle(localAisles, 'vertical', a.row, Math.min(a.col, b.col));
    }
    if (a.col === b.col && Math.abs(a.row - b.row) === 1) {
        return hasLocalAisle(localAisles, 'horizontal', Math.min(a.row, b.row), a.col);
    }
    return false;
}

export function computeNeighborSeatIds(seats, localAisles = {}, rows = 0, cols = 0) {
    const normalizedLocalAisles = normalizeLocalAisles(localAisles, rows, cols);
    const byPosition = new Map(seats.map(seat => [`${seat.row},${seat.col}`, seat]));
    const result = new Map();
    for (const seat of seats) {
        const neighbors = [];
        for (const [dr, dc] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
            const candidate = byPosition.get(`${seat.row + dr},${seat.col + dc}`);
            if (!candidate) continue;
            if (isSeparatedByLocalAisle(seat, candidate, normalizedLocalAisles)) continue;
            neighbors.push(candidate.id);
        }
        result.set(seat.id, neighbors.sort());
    }
    return result;
}

function buildStudentAssignments(request, guardianIds) {
    const studentsById = new Map(request.students.map(student => [student.id, student]));
    const studentsByName = new Map(request.students.map(student => [student.name, student]));
    const studentsByNormalized = new Map();
    for (const student of request.students) {
        for (const value of [student.id, student.name]) {
            const key = normalizeStudentRefKey(value);
            if (key && !studentsByNormalized.has(key)) studentsByNormalized.set(key, student);
        }
    }
    const byId = new Map();

    for (const student of request.students) {
        if (guardianIds.has(student.id)) continue;
        byId.set(student.id, {
            id: student.id,
            name: student.name || student.id,
            gender: normalizeGender(student.gender),
            grade: numberValue(student.grade),
            height: numberValue(student.height),
            mustFrontRow: false,
            mustBackRow: false,
            mustAvoidFirstRow: false,
            mustAvoidLastRow: false,
            mustAvoidFrontRow: false,
            mustAvoidBackRow: false,
            mustAvoidBehind: [],
            preferFrontMiddle: false,
            preferFrontMidRows: false,
            mustPairWith: [],
            mustAvoidAdjacent: [],
            preferAdjacent: [],
        });
    }

    const pushUnique = (id, field, value) => {
        const assignment = byId.get(id);
        if (!assignment || !byId.has(value) || assignment[field].includes(value)) return;
        assignment[field].push(value);
    };

    for (const constraint of request.constraints || []) {
        const id = resolveConstraintStudentId(constraintTarget(constraint), studentsById, studentsByName, studentsByNormalized);
        const related = resolveConstraintStudentId(constraintRelated(constraint), studentsById, studentsByName, studentsByNormalized);
        if (!id || !byId.has(id)) continue;
        if (constraint.type === 'front_row') byId.get(id).mustFrontRow = true;
        if (constraint.type === 'back_row') byId.get(id).mustBackRow = true;
        if (constraint.type === 'avoid_first_row') byId.get(id).mustAvoidFirstRow = true;
        if (constraint.type === 'avoid_last_row') byId.get(id).mustAvoidLastRow = true;
        if (constraint.type === 'avoid_front_row') byId.get(id).mustAvoidFrontRow = true;
        if (constraint.type === 'avoid_back_row') byId.get(id).mustAvoidBackRow = true;
        if (constraint.type === 'avoid_behind' && related) {
            pushUnique(id, 'mustAvoidBehind', related);
        }
        if (constraint.type === 'prefer_front_middle') byId.get(id).preferFrontMiddle = true;
        if (constraint.type === 'prefer_front_mid_rows') byId.get(id).preferFrontMidRows = true;
        if ((constraint.type === 'pair' || constraint.type === 'must_adjacent') && related) {
            pushUnique(id, 'mustPairWith', related);
            pushUnique(related, 'mustPairWith', id);
        }
        if ((constraint.type === 'avoid' || constraint.type === 'not_adjacent') && related) {
            pushUnique(id, 'mustAvoidAdjacent', related);
            pushUnique(related, 'mustAvoidAdjacent', id);
        }
        if ((constraint.type === 'prefer' || constraint.type === 'prefer_near') && related) {
            pushUnique(id, 'preferAdjacent', related);
            pushUnique(related, 'preferAdjacent', id);
        }
    }

    return [...byId.values()];
}

function buildConstraintConfig(layout, spec) {
    const rowsWithSeats = [];
    const colsWithSeats = [];
    for (let r = 0; r < layout.rows; r++) {
        if (Array.from({ length: layout.cols }, (_, c) => c).some(c => layout.cells[r]?.[c] === CELL.SEAT)) {
            rowsWithSeats.push(r);
        }
    }
    for (let c = 0; c < layout.cols; c++) {
        if (Array.from({ length: layout.rows }, (_, r) => r).some(r => layout.cells[r]?.[c] === CELL.SEAT)) {
            colsWithSeats.push(c);
        }
    }
    const regionSize = Math.max(1, Math.ceil(rowsWithSeats.length / 3));
    const frontRowThreshold = rowsWithSeats[Math.min(regionSize - 1, rowsWithSeats.length - 1)] ?? 0;
    const backRowThreshold = rowsWithSeats[Math.max(0, rowsWithSeats.length - regionSize)] ?? 0;
    const frontMidCount = Math.max(1, Math.ceil(rowsWithSeats.length * 2 / 3));
    const frontMidRowThreshold = rowsWithSeats[Math.min(frontMidCount - 1, rowsWithSeats.length - 1)] ?? frontRowThreshold;
    const middleColSize = Math.max(1, Math.ceil(colsWithSeats.length / 3));
    const middleColStartIndex = Math.max(0, Math.floor((colsWithSeats.length - middleColSize) / 2));
    const middleCols = colsWithSeats.slice(middleColStartIndex, middleColStartIndex + middleColSize);
    const policy = spec.placementPolicy || {};
    return {
        firstRow: rowsWithSeats[0] ?? 0,
        lastRow: rowsWithSeats[rowsWithSeats.length - 1] ?? 0,
        frontRowThreshold,
        backRowThreshold,
        frontMidRowThreshold,
        middleColStart: middleCols[0] ?? 0,
        middleColEnd: middleCols[middleCols.length - 1] ?? 0,
        genderBalanceEnabled: boolValue(policy.genderBalance, false),
        heightOrderEnabled: boolValue(policy.heightOrder, false),
        gradeStrategy: asText(policy.gradeStrategy || 'none') || 'none',
    };
}

function partitionConstraints(constraints = []) {
    const supported = [];
    const localOnlyConstraints = [];
    for (const constraint of constraints) {
        const type = constraint?.type;
        if (!type) continue;
        if (TIMEFOLD_SUPPORTED_CONSTRAINT_TYPES.has(type)) {
            supported.push(constraint);
        } else {
            localOnlyConstraints.push(constraint);
        }
    }
    return { supported, localOnlyConstraints };
}

export function buildTimefoldProblem({ request, layout, spec, guardians = {} } = {}) {
    if (!request || !layout || !spec) {
        throw new TimefoldUnavailableError('Timefold problem input is incomplete', 'invalid_input');
    }
    // Best-effort: partition constraints instead of rejecting entirely
    const { supported, localOnlyConstraints } = partitionConstraints(request.constraints);
    const guardianIds = new Set([guardians.left, guardians.right].filter(Boolean));
    const seats = buildSeatList(layout);
    // Build students using only supported constraints
    const students = buildStudentAssignments({ ...request, constraints: supported }, guardianIds);
    if (students.length > seats.length) {
        throw new TimefoldUnavailableError('Timefold skipped because there are more students than grid seats', 'capacity_exceeded');
    }
    return {
        name: 'ICeCream seating arrangement',
        seats,
        students,
        config: buildConstraintConfig(layout, spec),
        localOnlyConstraints,
        unsupportedConstraints: localOnlyConstraints,
    };
}

function solverRequestPayload(problem = {}) {
    const { localOnlyConstraints, unsupportedConstraints, ...payload } = problem;
    return payload;
}

async function parseJsonResponse(response, fallback = {}) {
    const text = await response.text();
    if (!text) return fallback;
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

async function fetchJson(fetchImpl, url, options, timeout) {
    const response = await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(timeout),
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        throw new TimefoldUnavailableError(
            payload?.error || `Timefold request failed with HTTP ${response.status}`,
            'http_error'
        );
    }
    return payload;
}

function resolveFetch(fetchImpl) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    throw new TimefoldUnavailableError('No fetch implementation is available for Timefold', 'missing_fetch');
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

export async function timefoldSolve(problem, {
    solverUrl,
    timeout = DEFAULT_TIMEOUT_MS,
    fetchImpl,
} = {}) {
    if (!solverUrl) {
        throw new TimefoldUnavailableError('TIMEFOLD_SOLVER_URL is not configured', 'not_configured');
    }
    const fetchClient = resolveFetch(fetchImpl);
    const deadline = Date.now() + timeout;
    const startedAt = Date.now();
    let jobId = null;

    const remaining = () => Math.max(1, deadline - Date.now());

    try {
        const created = await fetchJson(fetchClient, `${solverUrl}/seating-solutions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(solverRequestPayload(problem)),
        }, remaining());
        jobId = created.jobId;
        if (!jobId) throw new TimefoldUnavailableError('Timefold did not return a jobId', 'invalid_response');

        let status = created;
        while (Date.now() < deadline) {
            status = await fetchJson(fetchClient, `${solverUrl}/seating-solutions/${encodeURIComponent(jobId)}/status`, {
                method: 'GET',
            }, remaining());
            if (status.solverStatus === 'NOT_SOLVING') break;
            await sleep(Math.min(POLL_INTERVAL_MS, remaining()));
        }

        if (status.solverStatus !== 'NOT_SOLVING') {
            throw new TimefoldUnavailableError('Timefold solve timed out', 'timeout');
        }

        const solution = await fetchJson(fetchClient, `${solverUrl}/seating-solutions/${encodeURIComponent(jobId)}`, {
            method: 'GET',
        }, remaining());
        if (Number(solution.hardScore ?? 0) < 0) {
            throw new TimefoldUnavailableError('Timefold returned a hard constraint violation', 'hard_score_violation');
        }
        return {
            ...transformSolutionToAssignments(solution),
            durationMs: Date.now() - startedAt,
        };
    } finally {
        if (jobId) {
            fetchClient(`${solverUrl}/seating-solutions/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {});
        }
    }
}

export function transformSolutionToAssignments(solution = {}) {
    const assignments = [];
    const unassigned = [];
    const seenSeats = new Set();
    for (const student of solution.students || []) {
        const studentId = asText(student.studentId ?? student.id);
        if (!studentId) continue;
        const seat = parseSeat(student.seat);
        if (!seat) {
            unassigned.push(studentId);
            continue;
        }
        const key = `${seat.row},${seat.col}`;
        if (seenSeats.has(key)) {
            unassigned.push(studentId);
            continue;
        }
        seenSeats.add(key);
        assignments.push({ studentId, row: seat.row, col: seat.col });
    }
    return {
        assignments,
        unassigned,
        unsatisfied: [],
        warnings: [],
        hardScore: Number(solution.hardScore ?? 0),
        softScore: Number(solution.softScore ?? 0),
        score: solution.score ?? null,
    };
}

export async function solveWithTimefold({
    request,
    layout,
    spec,
    guardians,
    env = process.env,
    fetchImpl,
} = {}) {
    const solverUrl = normalizeSolverUrl(env);
    if (!solverUrl) {
        throw new TimefoldUnavailableError('TIMEFOLD_SOLVER_URL is not configured', 'not_configured');
    }
    const problem = buildTimefoldProblem({ request, layout, spec, guardians });
    const result = await timefoldSolve(problem, {
        solverUrl,
        timeout: timeoutMs(env),
        fetchImpl,
    });
    return {
        ...result,
        localOnlyConstraints: problem.localOnlyConstraints || [],
        unsupportedConstraints: problem.unsupportedConstraints || [],
    };
}

export async function checkTimefoldStatus({ env = process.env, fetchImpl } = {}) {
    const solverUrl = normalizeSolverUrl(env);
    if (!solverUrl) {
        return { configured: false, online: false };
    }
    try {
        const fetchClient = resolveFetch(fetchImpl);
        const payload = await fetchJson(fetchClient, `${solverUrl}/seating-solutions/health`, {
            method: 'GET',
        }, 1500);
        return {
            configured: true,
            online: payload?.status === 'ok',
            status: payload?.status || 'unknown',
        };
    } catch {
        return { configured: true, online: false };
    }
}
