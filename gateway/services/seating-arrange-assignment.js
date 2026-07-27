import * as shared from './seating-arrange-shared.js';
import * as spec from './seating-arrange-spec.js';
const { applyAiLayoutMatrix, CELL, solveWithTimefold, TimefoldUnavailableError, evaluateSeatingConstraints, evaluateSeatingQuality, normalizeLocalAisles, MAX_ROWS, MAX_COLS, TOP_GRADE_PERCENT, asText, boolValue, numberValue, cellValue, ensureStudents, normalizeLayout, normalizeStudentRef, normalizeAssignments, normalizeUnassigned, normalizeWarnings, studentLabel, seatCapacity, gridSeatCount, availableSeats, normalizeGuardians, validateGuardians, validateBatchAssignments, chineseNumberValue, positiveInt, NATURAL_NUMBER_PATTERN, naturalNumberFromMatch, firstNaturalNumber, extractGroupSize, hasGroupColumnWording, extractColumnCount, extractGridDimensions, extractRowCount, inferColumnPattern, normalizeColumnPattern, normalizeCapacityPolicy, inferCapacityPolicy, inferArrangementSpecFromPrompt, normalizeAislePolicy, normalizeGuardianPolicy, normalizeGuardianStrategy, normalizeGuardianGender, normalizeGuardianSlots, hasExplicitGuardianRequirement, normalizeGradeStrategy, normalizeUiPlacementPolicy, definedPlacementPolicy, inferPlacementOverridesFromPrompt, hasAnyOwn, valueConflict, specConflictWarnings, desiredGroupsPerRow, resolveSeatRows, columnPatternSeatCount, buildSeatRowFromRuns, buildPhysicalGridLayout, buildColumnPatternLayout, buildExpandableClassroomLayout, studentGradeValue, rankedStudentsByGradeDesc, getTopGradeStudentIds, getLowGradeStudentIds, protectExcellentStudentsFromLastRow, layoutSeatList, calculateSeatScoreMap, seatQuality, sortSeatsByQuality, normalizeStudentRefKey, buildNormalizedStudentMap, resolveConstraintStudentId, interleaveGender, applyGradeStrategy, sortStudentsForPlacement, placeTopGradeStudentsInBestSeats, areAdjacent, areAdjacentSeats, areNearAssignments, assignmentsToLayout, constraintEvaluationForAssignments, betterConstraintEvaluation, betterScoreEvaluation, cloneAssignments, assignmentSeatKey, buildLayoutInterpretation, buildSolverFacts } = shared;
const { strategyOverrideWarnings, appliedStrategiesFor } = spec;

function validateAiArrangement({ raw, students, allowUnassigned = false }) {
    const safeStudents = ensureStudents(students);
    const studentById = new Map(safeStudents.map(student => [student.id, student]));
    const errors = [];

    let classroomLayout;
    let assignments;
    try {
        classroomLayout = normalizeLayout(raw || {});
        assignments = normalizeAssignments(raw?.assignments);
    } catch (error) {
        return { ok: false, errors: [error.message], data: null };
    }

    const placedStudents = new Set();
    const occupiedSeats = new Set();
    for (const assignment of assignments) {
        const student = studentById.get(assignment.studentId);
        if (!student) {
            errors.push(`未知学生 id: ${assignment.studentId || '空'}`);
            continue;
        }
        if (placedStudents.has(assignment.studentId)) {
            errors.push(`${studentLabel(student)} 被重复安排`);
            continue;
        }
        if (!Number.isInteger(assignment.row) || !Number.isInteger(assignment.col)
            || assignment.row < 0 || assignment.col < 0
            || assignment.row >= classroomLayout.rows || assignment.col >= classroomLayout.cols) {
            errors.push(`${studentLabel(student)} 的座位坐标越界`);
            continue;
        }
        if (classroomLayout.cells[assignment.row][assignment.col] !== CELL.SEAT) {
            errors.push(`${studentLabel(student)} 被安排到非座位格`);
            continue;
        }
        const seatKey = `${assignment.row},${assignment.col}`;
        if (occupiedSeats.has(seatKey)) {
            errors.push(`第${assignment.row + 1}排第${assignment.col + 1}列被重复安排`);
            continue;
        }
        placedStudents.add(assignment.studentId);
        occupiedSeats.add(seatKey);
    }

    const guardiansFromRaw = raw?.guardians || {};
    const guardians = {
        left: normalizeStudentRef(guardiansFromRaw.left ?? classroomLayout.guardians.left),
        right: normalizeStudentRef(guardiansFromRaw.right ?? classroomLayout.guardians.right),
    };
    const guardianIds = new Set();
    for (const side of ['left', 'right']) {
        const id = guardians[side];
        if (!id) continue;
        const student = studentById.get(id);
        if (!student) {
            errors.push(`护法位包含未知学生 id: ${id}`);
            continue;
        }
        if (placedStudents.has(id) || guardianIds.has(id)) {
            errors.push(`${studentLabel(student)} 被重复安排`);
            continue;
        }
        guardianIds.add(id);
        placedStudents.add(id);
    }

    classroomLayout.guardians = {
        enabled: boolValue(classroomLayout.guardians.enabled, Boolean(guardians.left || guardians.right)),
        left: guardians.left,
        right: guardians.right,
    };

    const unassigned = normalizeUnassigned(raw?.unassigned);
    const unassignedSet = new Set();
    for (const id of unassigned) {
        if (!studentById.has(id)) {
            errors.push(`未安排名单包含未知学生 id: ${id}`);
            continue;
        }
        if (placedStudents.has(id)) {
            errors.push(`${studentLabel(studentById.get(id))} 同时出现在座位和未安排名单中`);
            continue;
        }
        if (unassignedSet.has(id)) {
            errors.push(`未安排名单重复: ${id}`);
            continue;
        }
        unassignedSet.add(id);
    }

    const missing = safeStudents
        .filter(student => !placedStudents.has(student.id) && !unassignedSet.has(student.id))
        .map(studentLabel);
    if (missing.length) errors.push(`缺少学生: ${missing.join('、')}`);
    if (!allowUnassigned && unassignedSet.size > 0) {
        errors.push(`默认不能留下未安排学生，请扩大教室布局到至少 ${safeStudents.length} 个可用位置；当前容量 ${seatCapacity(classroomLayout)}，未安排 ${unassignedSet.size} 名`);
    }

    if (errors.length) return { ok: false, errors, data: null };

    const warnings = normalizeWarnings(raw?.warnings);
    if (unassigned.length && warnings.length === 0) warnings.push(`${unassigned.length} 名学生未安排`);

    return {
        ok: true,
        errors: [],
        data: {
            reply: asText(raw?.reply) || '已根据需求生成座位表',
            classroomLayout,
            assignments,
            guardians,
            unassigned,
            warnings,
            reasoning: asText(raw?.reasoning),
        },
    };
}

function chooseGuardians(students, spec) {
    const policy = spec.guardianPolicy || {};
    if (!policy.enabled || students.length === 0) return { left: null, right: null };
    const byId = new Map(students.map(student => [student.id, student]));
    const chosen = [];
    for (const explicit of [policy.left, policy.right]) {
        if (explicit && byId.has(explicit) && !chosen.includes(explicit)) chosen.push(explicit);
    }

    function rankedForSlot(slot = {}) {
        let candidates = students.filter(student => !chosen.includes(student.id));
        if (slot.gender) candidates = candidates.filter(student => student.gender === slot.gender);
        const strategy = normalizeGuardianStrategy(slot.strategy || policy.strategy);
        if (strategy === 'lowest_grade') {
            return candidates.sort((a, b) => {
                const gradeDiff = studentGradeValue(a) - studentGradeValue(b);
                if (gradeDiff !== 0) return gradeDiff;
                return a.id.localeCompare(b.id);
            });
        }
        if (strategy === 'top_grade_percent') {
            return [
                ...rankedStudentsByGradeDesc(candidates),
                ...candidates
                    .filter(student => !Number.isFinite(Number(student?.grade)))
                    .sort((a, b) => a.id.localeCompare(b.id)),
            ];
        }
        return candidates.sort((a, b) => a.id.localeCompare(b.id));
    }

    for (const slot of policy.slots || []) {
        if (chosen.length >= 2) break;
        if (slot.studentId && byId.has(slot.studentId) && !chosen.includes(slot.studentId)) {
            chosen.push(slot.studentId);
            continue;
        }
        const candidate = rankedForSlot(slot)[0];
        if (candidate) chosen.push(candidate.id);
    }

    let ranked = [];
    if (policy.strategy === 'lowest_grade') {
        ranked = [...students].sort((a, b) => {
            const gradeDiff = studentGradeValue(a) - studentGradeValue(b);
            if (gradeDiff !== 0) return gradeDiff;
            return a.id.localeCompare(b.id);
        });
    } else if (policy.strategy === 'top_grade_percent') {
        const byGrade = rankedStudentsByGradeDesc(students);
        const topCount = Math.max(2, Math.ceil(byGrade.length * TOP_GRADE_PERCENT));
        const topCandidates = byGrade.slice(0, topCount);
        ranked = [
            ...topCandidates,
            ...byGrade.slice(topCount),
            ...students
                .filter(student => !Number.isFinite(Number(student?.grade)))
                .sort((a, b) => a.id.localeCompare(b.id)),
        ];
    }
    for (const student of ranked) {
        if (chosen.length >= 2) break;
        if (!chosen.includes(student.id)) chosen.push(student.id);
    }
    return {
        left: chosen[0] || null,
        right: chosen[1] || null,
    };
}

function assignLocalSeats({ request, layout, spec, guardians }) {
    const guardianIds = new Set([guardians.left, guardians.right].filter(Boolean));
    const regularStudents = request.students.filter(student => !guardianIds.has(student.id));
    const studentsById = new Map(request.students.map(student => [student.id, student]));
    const studentsByName = new Map(request.students.map(student => [student.name, student]));
    const studentsByNormalized = buildNormalizedStudentMap(request.students);
    const allSeats = layoutSeatList(layout);
    const seatScoreMap = calculateSeatScoreMap(layout);
    const seatRows = [...new Set(allSeats.map(seat => seat.r))].sort((a, b) => a - b);
    const seatCols = [...new Set(allSeats.map(seat => seat.c))].sort((a, b) => a - b);
    const rowBandSize = Math.max(1, Math.ceil(seatRows.length / 3));
    const firstRow = seatRows[0];
    const lastRow = seatRows[seatRows.length - 1];
    const frontRows = new Set(seatRows.slice(0, rowBandSize));
    const backRows = new Set(seatRows.slice(Math.max(0, seatRows.length - rowBandSize)));
    const frontMidRows = new Set(seatRows.slice(0, Math.max(1, Math.ceil(seatRows.length * 2 / 3))));
    const middleColSize = Math.max(1, Math.ceil(seatCols.length / 3));
    const middleColStart = Math.max(0, Math.floor((seatCols.length - middleColSize) / 2));
    const middleCols = new Set(seatCols.slice(middleColStart, middleColStart + middleColSize));
    const edgeCols = new Set([seatCols[0], seatCols[seatCols.length - 1]].filter(Number.isInteger));
    const hardSeatRules = new Map();
    const occupied = new Set();
    const placed = new Set();
    const assignments = [];
    const warnings = [];
    const unsatisfied = [];

    function seatKey(seat) {
        return `${seat.r},${seat.c}`;
    }

    function isFree(seat) {
        return seat && !occupied.has(seatKey(seat));
    }

    function rulesFor(studentId) {
        if (!hardSeatRules.has(studentId)) {
            hardSeatRules.set(studentId, {
                avoidFirstRow: false,
                avoidLastRow: false,
                avoidFrontRow: false,
                avoidBackRow: false,
            });
        }
        return hardSeatRules.get(studentId);
    }

    function allowedSeatForStudent(studentId, seat) {
        if (!studentId || !seat) return false;
        const rules = hardSeatRules.get(studentId);
        if (!rules) return true;
        if (rules.avoidFirstRow && seat.r === firstRow) return false;
        if (rules.avoidLastRow && seat.r === lastRow) return false;
        if (rules.avoidFrontRow && frontRows.has(seat.r)) return false;
        if (rules.avoidBackRow && backRows.has(seat.r)) return false;
        return true;
    }

    function place(studentId, seat, { allowHardViolation = false } = {}) {
        if (!studentId || !seat || occupied.has(seatKey(seat)) || placed.has(studentId)) return false;
        if (!allowHardViolation && !allowedSeatForStudent(studentId, seat)) return false;
        assignments.push({ studentId, row: seat.r, col: seat.c });
        occupied.add(seatKey(seat));
        placed.add(studentId);
        return true;
    }

    function nextSeat(predicate = () => true, { reverse = false, byQuality = false } = {}) {
        const seats = byQuality ? sortSeatsByQuality(allSeats, seatScoreMap) : (reverse ? [...allSeats].reverse() : allSeats);
        return seats.find(seat => isFree(seat) && predicate(seat));
    }

    function nextSeatForStudent(studentId, predicate = () => true, options = {}) {
        return nextSeat(seat => predicate(seat) && allowedSeatForStudent(studentId, seat), options);
    }

    function isAisleSeat(seat) {
        if (!seat) return false;
        const left = seat.c > 0 ? layout.cells?.[seat.r]?.[seat.c - 1] : null;
        const right = seat.c < layout.cols - 1 ? layout.cells?.[seat.r]?.[seat.c + 1] : null;
        return left === CELL.AISLE || right === CELL.AISLE || seat.c === 0 || seat.c === layout.cols - 1;
    }

    function isEdgeSeat(seat) {
        return Boolean(seat && edgeCols.has(seat.c));
    }

    function placeRemainingStudents(regionStudents, regionSeats) {
        let ordered = [...regionStudents];
        if (spec.placementPolicy?.genderBalance) ordered = interleaveGender(ordered);
        for (const student of ordered) {
            const seat = regionSeats.find(candidate => isFree(candidate) && allowedSeatForStudent(student.id, candidate))
                || regionSeats.find(candidate => isFree(candidate));
            if (seat) {
                place(student.id, seat, { allowHardViolation: !allowedSeatForStudent(student.id, seat) });
            }
        }
    }

    function placePriorityRegion(regionStudents, regionSeats, topGradeIds) {
        const placedExcellent = placeTopGradeStudentsInBestSeats({
            students: regionStudents,
            seats: regionSeats.filter(isFree),
            topGradeIds,
            scoreMap: seatScoreMap,
            place,
        });
        placeRemainingStudents(
            regionStudents.filter(student => !placedExcellent.has(student.id)),
            regionSeats
        );
    }

    function placePriorityStudents(students, seats) {
        const topGradeIds = getTopGradeStudentIds([...studentsById.values()]);
        if (spec.placementPolicy?.heightOrder) {
            const byHeight = [...students].sort((a, b) => {
                const diff = (Number(a.height) || 0) - (Number(b.height) || 0);
                return diff || a.id.localeCompare(b.id);
            });
            const rowSeatGroups = [];
            for (const seat of seats) {
                const last = rowSeatGroups[rowSeatGroups.length - 1];
                if (!last || last.row !== seat.r) rowSeatGroups.push({ row: seat.r, seats: [seat] });
                else last.seats.push(seat);
            }
            let cursor = 0;
            for (const group of rowSeatGroups) {
                const chunk = byHeight.slice(cursor, cursor + group.seats.length);
                cursor += group.seats.length;
                placePriorityRegion(chunk, group.seats, topGradeIds);
            }
            if (cursor < byHeight.length) {
                placePriorityRegion(byHeight.slice(cursor), seats.filter(isFree), topGradeIds);
            }
            return;
        }
        placePriorityRegion(students, seats, topGradeIds);
    }

    const avoidPairs = [];
    const avoidNearPairs = [];
    const avoidBehindPairs = [];
    const pairConstraints = [];
    const frontIds = [];
    const backIds = [];
    const frontMiddleIds = [];
    const frontMidIds = [];
    const aisleIds = [];
    const edgeIds = [];
    const highGradeNeighborIds = [];
    const avoidLowGradeNeighborIds = [];

    for (const constraint of request.constraints || []) {
        const id = resolveConstraintStudentId(constraint.target, studentsById, studentsByName, studentsByNormalized);
        const related = resolveConstraintStudentId(constraint.related, studentsById, studentsByName, studentsByNormalized);
        if (constraint.type === 'front_row' && id) frontIds.push(id);
        if (constraint.type === 'back_row' && id) backIds.push(id);
        if (constraint.type === 'prefer_front_middle' && id) frontMiddleIds.push(id);
        if (constraint.type === 'prefer_front_mid_rows' && id) frontMidIds.push(id);
        if (constraint.type === 'prefer_aisle' && id) aisleIds.push(id);
        if (constraint.type === 'prefer_edge' && id) edgeIds.push(id);
        if (constraint.type === 'prefer_high_grade_neighbor' && id) highGradeNeighborIds.push(id);
        if (constraint.type === 'avoid_low_grade_deskmate' && id) avoidLowGradeNeighborIds.push(id);
        if (constraint.type === 'avoid_first_row' && id) rulesFor(id).avoidFirstRow = true;
        if (constraint.type === 'avoid_last_row' && id) rulesFor(id).avoidLastRow = true;
        if (constraint.type === 'avoid_front_row' && id) rulesFor(id).avoidFrontRow = true;
        if (constraint.type === 'avoid_back_row' && id) rulesFor(id).avoidBackRow = true;
        if ((constraint.type === 'pair' || constraint.type === 'must_adjacent') && id && related) pairConstraints.push([id, related]);
        if ((constraint.type === 'avoid' || constraint.type === 'not_adjacent') && id && related) avoidPairs.push([id, related]);
        if (constraint.type === 'avoid_near' && id && related) avoidNearPairs.push([id, related]);
        if (constraint.type === 'avoid_behind' && id && related) avoidBehindPairs.push([id, related]);
    }

    for (const [id1, id2] of pairConstraints) {
        if (guardianIds.has(id1) || guardianIds.has(id2) || placed.has(id1) || placed.has(id2)) continue;
        let placedPair = false;
        for (const seat of allSeats) {
            if (!isFree(seat) || !allowedSeatForStudent(id1, seat)) continue;
            const mate = allSeats.find(candidate => isFree(candidate)
                && allowedSeatForStudent(id2, candidate)
                && candidate.group === seat.group
                && areAdjacentSeats(candidate, seat));
            if (mate && place(id1, seat) && place(id2, mate)) {
                placedPair = true;
                break;
            }
        }
        if (!placedPair) {
            warnings.push(`未能让 ${id1} 和 ${id2} 相邻`);
            unsatisfied.push({ target: id1, related: id2, type: 'pair', reason: '没有可用相邻座位' });
        }
    }

    const targetSeatPredicate = id => {
        const predicates = [];
        if (frontMiddleIds.includes(id)) predicates.push(seat => frontRows.has(seat.r) && middleCols.has(seat.c));
        else if (frontMidIds.includes(id)) predicates.push(seat => frontMidRows.has(seat.r));
        else {
            if (frontIds.includes(id)) predicates.push(seat => frontRows.has(seat.r));
            if (backIds.includes(id)) predicates.push(seat => backRows.has(seat.r));
        }
        if (edgeIds.includes(id)) predicates.push(isEdgeSeat);
        if (aisleIds.includes(id)) predicates.push(isAisleSeat);
        return predicates.length ? seat => predicates.every(predicate => predicate(seat)) : () => true;
    };

    const topGradeIds = getTopGradeStudentIds([...studentsById.values()]);
    for (const id of highGradeNeighborIds) {
        if (guardianIds.has(id) || placed.has(id)) continue;
        const partner = rankedStudentsByGradeDesc(regularStudents)
            .find(student => student.id !== id && topGradeIds.has(student.id) && !placed.has(student.id) && !guardianIds.has(student.id));
        if (!partner) continue;
        const preferredTargetSeat = targetSeatPredicate(id);
        let placedNeighbor = false;
        for (const seat of sortSeatsByQuality(allSeats, seatScoreMap)) {
            if (!isFree(seat) || !preferredTargetSeat(seat) || !allowedSeatForStudent(id, seat)) continue;
            const mate = allSeats.find(candidate => isFree(candidate)
                && allowedSeatForStudent(partner.id, candidate)
                && candidate.group === seat.group
                && areAdjacentSeats(candidate, seat));
            if (mate && place(id, seat) && place(partner.id, mate)) {
                placedNeighbor = true;
                break;
            }
        }
        if (!placedNeighbor) {
            warnings.push(`未能优先为 ${id} 安排成绩较好的邻座`);
        }
    }

    for (const id of frontMiddleIds) {
        if (!guardianIds.has(id) && !placed.has(id)) {
            place(id, nextSeatForStudent(id, targetSeatPredicate(id), { byQuality: true }));
        }
    }
    for (const id of frontMidIds) {
        if (!guardianIds.has(id) && !placed.has(id)) {
            place(id, nextSeatForStudent(id, targetSeatPredicate(id), { byQuality: true }));
        }
    }
    for (const id of frontIds) {
        if (!guardianIds.has(id) && !placed.has(id)) place(id, nextSeatForStudent(id, targetSeatPredicate(id), { byQuality: true }));
    }
    for (const id of backIds) {
        if (!guardianIds.has(id) && !placed.has(id)) place(id, nextSeatForStudent(id, targetSeatPredicate(id), { byQuality: true }));
    }
    for (const id of edgeIds) {
        if (!guardianIds.has(id) && !placed.has(id)) place(id, nextSeatForStudent(id, targetSeatPredicate(id), { byQuality: true }));
    }
    for (const id of aisleIds) {
        if (!guardianIds.has(id) && !placed.has(id)) place(id, nextSeatForStudent(id, targetSeatPredicate(id), { byQuality: true }));
    }

    const freeSeatsForRemaining = allSeats.filter(isFree);
    const studentsToPlace = regularStudents.filter(student => !placed.has(student.id));
    if (spec.placementPolicy?.gradeStrategy === 'priority') {
        placePriorityStudents(studentsToPlace, freeSeatsForRemaining);
    } else {
        const remaining = sortStudentsForPlacement(
            studentsToPlace,
            spec,
            freeSeatsForRemaining
        );
        for (const student of remaining) {
            const seat = freeSeatsForRemaining.find(candidate => isFree(candidate) && allowedSeatForStudent(student.id, candidate))
                || freeSeatsForRemaining.find(candidate => isFree(candidate));
            if (seat) place(student.id, seat, { allowHardViolation: !allowedSeatForStudent(student.id, seat) });
        }
    }

    const positionById = () => new Map(assignments.map(assignment => [assignment.studentId, assignment]));
    for (const [id1, id2] of avoidPairs) {
        let positions = positionById();
        const pos1 = positions.get(id1);
        const pos2 = positions.get(id2);
        if (!areAdjacent(pos1, pos2)) continue;
        const index2 = assignments.findIndex(assignment => assignment.studentId === id2);
        let fixed = false;
        for (let i = 0; i < assignments.length; i++) {
            const candidate = assignments[i];
            if (candidate.studentId === id1 || candidate.studentId === id2) continue;
            if (areAdjacent(pos1, candidate)) continue;
            if (!allowedSeatForStudent(id2, { r: candidate.row, c: candidate.col })) continue;
            if (!allowedSeatForStudent(candidate.studentId, { r: pos2.row, c: pos2.col })) continue;
            const original = { row: candidate.row, col: candidate.col };
            candidate.row = pos2.row;
            candidate.col = pos2.col;
            assignments[index2].row = original.row;
            assignments[index2].col = original.col;
            positions = positionById();
            if (!areAdjacent(positions.get(id1), positions.get(id2))) {
                fixed = true;
                break;
            }
        }
        if (!fixed) {
            warnings.push(`未能完全满足 ${id1} 和 ${id2} 不相邻`);
            unsatisfied.push({ target: id1, related: id2, type: 'avoid', reason: '没有找到可交换的远离座位' });
        }
    }

    for (const [id1, id2] of avoidNearPairs) {
        let positions = positionById();
        const pos1 = positions.get(id1);
        const pos2 = positions.get(id2);
        if (!areNearAssignments(pos1, pos2)) continue;
        const index2 = assignments.findIndex(assignment => assignment.studentId === id2);
        let fixed = false;
        for (const candidate of assignments) {
            if (candidate.studentId === id1 || candidate.studentId === id2) continue;
            if (areNearAssignments(pos1, candidate)) continue;
            if (!allowedSeatForStudent(id2, { r: candidate.row, c: candidate.col })) continue;
            if (!allowedSeatForStudent(candidate.studentId, { r: pos2.row, c: pos2.col })) continue;
            const original = { row: candidate.row, col: candidate.col };
            candidate.row = pos2.row;
            candidate.col = pos2.col;
            assignments[index2].row = original.row;
            assignments[index2].col = original.col;
            positions = positionById();
            if (!areNearAssignments(positions.get(id1), positions.get(id2))) {
                fixed = true;
                break;
            }
        }
        if (!fixed) {
            warnings.push(`未能完全满足 ${id1} 和 ${id2} 不要太近`);
            unsatisfied.push({ target: id1, related: id2, type: 'avoid_near', reason: '没有找到更远座位' });
        }
    }

    for (const [targetId, relatedId] of avoidBehindPairs) {
        let positions = positionById();
        const target = positions.get(targetId);
        const related = positions.get(relatedId);
        if (!target || !related || target.row <= related.row) continue;
        const targetIndex = assignments.findIndex(assignment => assignment.studentId === targetId);
        let fixed = false;
        for (const candidate of assignments) {
            if (candidate.studentId === targetId || candidate.studentId === relatedId) continue;
            if (candidate.row > related.row) continue;
            if (!allowedSeatForStudent(targetId, { r: candidate.row, c: candidate.col })) continue;
            if (!allowedSeatForStudent(candidate.studentId, { r: target.row, c: target.col })) continue;
            const original = { row: candidate.row, col: candidate.col };
            candidate.row = target.row;
            candidate.col = target.col;
            assignments[targetIndex].row = original.row;
            assignments[targetIndex].col = original.col;
            positions = positionById();
            if (positions.get(targetId)?.row <= positions.get(relatedId)?.row) {
                fixed = true;
                break;
            }
        }
        if (!fixed) {
            warnings.push(`未能完全满足 ${targetId} 不坐在 ${relatedId} 后面`);
            unsatisfied.push({ target: targetId, related: relatedId, type: 'avoid_behind', reason: '没有找到前方可交换座位' });
        }
    }

    const lowGradeIds = getLowGradeStudentIds([...studentsById.values()]);
    for (const id of avoidLowGradeNeighborIds) {
        const positions = positionById();
        const pos = positions.get(id);
        if (!pos) continue;
        const hasLowNeighbor = assignments.some(candidate => candidate.studentId !== id
            && lowGradeIds.has(candidate.studentId)
            && areAdjacent(pos, candidate));
        if (hasLowNeighbor) {
            unsatisfied.push({ target: id, type: 'avoid_low_grade_deskmate', reason: '旁边仍有成绩偏低的同学' });
        }
    }

    const excellentProtection = protectExcellentStudentsFromLastRow({
        assignments,
        studentsById,
        seats: allSeats,
        gradeStrategy: spec.placementPolicy?.gradeStrategy,
        scoreMap: seatScoreMap,
    });
    if (excellentProtection.remaining > 0) {
        warnings.push(`优秀优先下最后一排外座位不足，仍有 ${excellentProtection.remaining} 名优秀学生在最后一排`);
    }

    const unassigned = regularStudents.filter(student => !placed.has(student.id)).map(student => student.id);
    if (unassigned.length) warnings.push(`${unassigned.length} 名学生未安排`);
    return { assignments, unassigned, warnings, unsatisfied };
}

function refineSeatingAssignments({
    seating,
    request,
    classroomLayout,
    guardians,
    spec,
    maxRounds = 100,
}) {
    if (!request.constraints?.length || !seating?.assignments?.length) {
        return {
            ...seating,
            refinementApplied: false,
            refinementRounds: 0,
        };
    }

    let assignments = cloneAssignments(seating.assignments);
    let current = constraintEvaluationForAssignments({
        assignments,
        request,
        classroomLayout,
        guardians,
        unassigned: seating.unassigned || [],
        spec,
    });
    if (!current.needEvaluation.unsatisfied.length) {
        return {
            ...seating,
            assignments,
            unsatisfied: [],
            refinementApplied: false,
            refinementRounds: 0,
        };
    }

    const guardianIds = new Set([guardians.left, guardians.right].filter(Boolean));
    const seatOptions = layoutSeatList(classroomLayout);
    let rounds = 0;
    let applied = false;

    while (rounds < maxRounds) {
        let improved = false;
        const occupied = new Map(assignments.map((assignment, index) => [assignmentSeatKey(assignment), index]));

        for (let i = 0; i < assignments.length && !improved; i++) {
            if (guardianIds.has(assignments[i].studentId)) continue;

            for (const seat of seatOptions) {
                const key = `${seat.r},${seat.c}`;
                const occupantIndex = occupied.get(key);
                if (occupantIndex === i) continue;
                if (occupantIndex != null && guardianIds.has(assignments[occupantIndex].studentId)) continue;

                const candidateAssignments = cloneAssignments(assignments);
                if (occupantIndex == null) {
                    candidateAssignments[i].row = seat.r;
                    candidateAssignments[i].col = seat.c;
                } else {
                    const original = {
                        row: candidateAssignments[i].row,
                        col: candidateAssignments[i].col,
                    };
                    candidateAssignments[i].row = candidateAssignments[occupantIndex].row;
                    candidateAssignments[i].col = candidateAssignments[occupantIndex].col;
                    candidateAssignments[occupantIndex].row = original.row;
                    candidateAssignments[occupantIndex].col = original.col;
                }

                const candidate = constraintEvaluationForAssignments({
                    assignments: candidateAssignments,
                    request,
                    classroomLayout,
                    guardians,
                    unassigned: seating.unassigned || [],
                    spec,
                });
                if (!betterConstraintEvaluation(candidate, current)) continue;

                assignments = candidateAssignments;
                current = candidate;
                improved = true;
                applied = true;
                rounds++;
                break;
            }
        }

        if (!improved) break;
    }

    return {
        ...seating,
        assignments,
        unsatisfied: current.needEvaluation.unsatisfied,
        refinementApplied: applied,
        refinementRounds: rounds,
    };
}

function optimizeSeatingScore({
    seating,
    request,
    classroomLayout,
    guardians = {},
    spec = {},
    maxRounds = 250,
    maxDurationMs = 4000,
    now = () => Date.now(),
} = {}) {
    if (!seating?.assignments?.length) {
        return {
            ...seating,
            scoreOptimizationApplied: false,
            scoreOptimizationRounds: 0,
            scoreBeforePercent: null,
            scoreAfterPercent: null,
            scoreOptimizerTimedOut: false,
        };
    }

    let assignments = cloneAssignments(seating.assignments);
    let current = constraintEvaluationForAssignments({
        assignments,
        request,
        classroomLayout,
        guardians,
        unassigned: seating.unassigned || [],
        spec,
    });
    const scoreBeforePercent = current.quality.percent;
    const guardianIds = new Set([guardians.left, guardians.right].filter(Boolean));
    const scoreMap = calculateSeatScoreMap(classroomLayout);
    const seatOptions = sortSeatsByQuality(layoutSeatList(classroomLayout), scoreMap);
    const policy = spec.placementPolicy || request.strategy || {};
    const usableRows = [...new Set(seatOptions.map(seat => seat.r))].sort((a, b) => a - b);
    const lastUsableRow = usableRows.at(-1);
    const topGradeIds = getTopGradeStudentIds(request.students || []);
    const canMoveStudentToSeat = (studentId, fromRow, seat) => {
        if (!studentId || !seat) return false;
        if (policy.heightOrder && seat.r !== fromRow) return false;
        if (policy.gradeStrategy === 'priority' && topGradeIds.has(studentId) && seat.r === lastUsableRow) return false;
        return true;
    };
    const deadline = now() + Math.max(1, Number(maxDurationMs) || 1);
    let rounds = 0;
    let applied = false;
    let timedOut = false;

    while (rounds < maxRounds) {
        if (now() >= deadline) {
            timedOut = true;
            break;
        }
        let improved = false;
        const occupied = new Map(assignments.map((assignment, index) => [assignmentSeatKey(assignment), index]));

        for (let i = 0; i < assignments.length && !improved; i++) {
            if (guardianIds.has(assignments[i].studentId)) continue;

            for (const seat of seatOptions) {
                if (now() >= deadline) {
                    timedOut = true;
                    break;
                }
                const key = `${seat.r},${seat.c}`;
                const occupantIndex = occupied.get(key);
                if (occupantIndex === i) continue;
                if (occupantIndex != null && guardianIds.has(assignments[occupantIndex].studentId)) continue;
                if (!canMoveStudentToSeat(assignments[i].studentId, assignments[i].row, seat)) continue;
                if (occupantIndex != null) {
                    const occupant = assignments[occupantIndex];
                    if (!canMoveStudentToSeat(occupant.studentId, occupant.row, assignments[i])) continue;
                }

                const candidateAssignments = cloneAssignments(assignments);
                if (occupantIndex == null) {
                    candidateAssignments[i].row = seat.r;
                    candidateAssignments[i].col = seat.c;
                } else {
                    const original = {
                        row: candidateAssignments[i].row,
                        col: candidateAssignments[i].col,
                    };
                    candidateAssignments[i].row = candidateAssignments[occupantIndex].row;
                    candidateAssignments[i].col = candidateAssignments[occupantIndex].col;
                    candidateAssignments[occupantIndex].row = original.row;
                    candidateAssignments[occupantIndex].col = original.col;
                }

                const candidate = constraintEvaluationForAssignments({
                    assignments: candidateAssignments,
                    request,
                    classroomLayout,
                    guardians,
                    unassigned: seating.unassigned || [],
                    spec,
                });
                if (!betterScoreEvaluation(candidate, current)) continue;

                assignments = candidateAssignments;
                current = candidate;
                rounds++;
                applied = true;
                improved = true;
                break;
            }
        }

        if (timedOut || !improved) break;
    }

    const protection = protectExcellentStudentsFromLastRow({
        assignments,
        studentsById: new Map((request.students || []).map(student => [student.id, student])),
        seats: seatOptions,
        gradeStrategy: policy.gradeStrategy,
        scoreMap,
    });
    if (protection.moved > 0) {
        current = constraintEvaluationForAssignments({
            assignments,
            request,
            classroomLayout,
            guardians,
            unassigned: seating.unassigned || [],
            spec,
        });
        applied = true;
        rounds += protection.moved;
    }

    return {
        ...seating,
        assignments,
        unsatisfied: current.needEvaluation.unsatisfied,
        scoreOptimizationApplied: applied,
        scoreOptimizationRounds: rounds,
        scoreBeforePercent,
        scoreAfterPercent: current.quality.percent,
        scoreOptimizerTimedOut: timedOut,
    };
}

function buildArrangementInterpretation({ request, spec, layout, source, solverStats }) {
    const layoutInterpretation = buildLayoutInterpretation({ request, spec, layout });
    const solverFacts = buildSolverFacts({ source, solverStats });
    return {
        ...layoutInterpretation,
        solverFacts,
    };
}

async function assignStudentsToLayout({
    request,
    spec,
    specWarnings = [],
    classroomLayout,
    layoutSource = 'local_layout_fallback',
    env = process.env,
    fetchImpl,
}) {
    const guardians = chooseGuardians(request.students, spec);
    classroomLayout.guardians = {
        enabled: Boolean(spec.guardianPolicy.enabled || guardians.left || guardians.right),
        left: guardians.left,
        right: guardians.right,
    };
    let seating;
    let source = layoutSource === 'ai_layout_preview'
        ? 'ai_layout_local_assignment'
        : layoutSource === 'confirmed_layout'
            ? 'confirmed_layout_local_assignment'
            : layoutSource;
    const solverWarnings = [];
    const solverStats = {
        solverUsed: false,
        solverName: '本地排座',
        hardScore: null,
        softScore: null,
        score: null,
        durationMs: null,
        fallbackReason: null,
        refinementApplied: false,
        refinementRounds: 0,
        scoreOptimizationApplied: false,
        scoreOptimizationRounds: 0,
        scoreBeforePercent: null,
        scoreAfterPercent: null,
        scoreOptimizerTimedOut: false,
    };
    try {
        seating = await solveWithTimefold({
            request,
            layout: classroomLayout,
            spec,
            guardians,
            env,
            fetchImpl,
        });
        source = 'timefold_solver';
        solverStats.solverUsed = true;
        solverStats.solverName = 'Timefold Solver';
        solverStats.hardScore = seating.hardScore ?? null;
        solverStats.softScore = seating.softScore ?? null;
        solverStats.score = seating.score ?? null;
        solverStats.durationMs = seating.durationMs ?? null;
    } catch (error) {
        solverStats.fallbackReason = error instanceof TimefoldUnavailableError
            ? error.reason
            : (error?.message || 'unknown_error');
        if (!(error instanceof TimefoldUnavailableError && ['not_configured', 'rich_constraints'].includes(error.reason))
            && asText(env?.TIMEFOLD_SOLVER_URL)) {
            solverWarnings.push(`Timefold solver unavailable (${error.reason || error.message}); used local seating algorithm.`);
        }
        seating = assignLocalSeats({ request, layout: classroomLayout, spec, guardians });
    }
    seating = refineSeatingAssignments({
        seating,
        request,
        classroomLayout,
        guardians,
        spec,
    });
    solverStats.refinementApplied = Boolean(seating.refinementApplied);
    solverStats.refinementRounds = seating.refinementRounds || 0;
    seating = optimizeSeatingScore({
        seating,
        request,
        classroomLayout,
        guardians,
        spec,
    });
    solverStats.scoreOptimizationApplied = Boolean(seating.scoreOptimizationApplied);
    solverStats.scoreOptimizationRounds = seating.scoreOptimizationRounds || 0;
    solverStats.scoreBeforePercent = seating.scoreBeforePercent ?? null;
    solverStats.scoreAfterPercent = seating.scoreAfterPercent ?? null;
    solverStats.scoreOptimizerTimedOut = Boolean(seating.scoreOptimizerTimedOut);
    const regularSeatCount = gridSeatCount(classroomLayout);
    const guardianSeatCount = [guardians.left, guardians.right].filter(Boolean).length;
    const warnings = [
        ...specWarnings,
        ...strategyOverrideWarnings(spec, request.strategy),
        ...solverWarnings,
        ...normalizeWarnings(seating.warnings),
    ];
    const interpretation = buildArrangementInterpretation({
        request,
        spec,
        layout: classroomLayout,
        source,
        solverStats,
    });
    return {
        reply: `已根据需求自动扩容并安排 ${request.students.length - seating.unassigned.length} 名学生。`,
        classroomLayout,
        assignments: seating.assignments,
        guardians,
        unassigned: seating.unassigned,
        warnings,
        unsatisfied: seating.unsatisfied,
        reasoning: source === 'timefold_solver'
            ? 'Timefold solver generated the seating plan from the parsed constraints.'
            : (spec.notes || 'AI 解析需求，本地算法稳定生成完整座位表。'),
        source,
        interpretation,
        arrangementSpec: spec,
        stats: {
            studentCount: request.students.length,
            regularSeatCount,
            guardianSeatCount,
            rows: classroomLayout.rows,
            cols: classroomLayout.cols,
            layoutSource,
            appliedStrategies: appliedStrategiesFor(spec),
            ...solverStats,
        },
    };
}

export {
    validateAiArrangement,
    chooseGuardians,
    assignLocalSeats,
    refineSeatingAssignments,
    optimizeSeatingScore,
    buildArrangementInterpretation,
    assignStudentsToLayout,
};
