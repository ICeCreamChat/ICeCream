package com.icecream.timetable.solver;

import ai.timefold.solver.core.impl.heuristic.selector.move.factory.MoveIteratorFactory;
import ai.timefold.solver.core.impl.score.director.ScoreDirector;
import com.icecream.timetable.domain.Room;
import com.icecream.timetable.domain.SchedulingUnit;
import com.icecream.timetable.domain.TimeSlot;
import com.icecream.timetable.domain.TimetableSolution;
import com.icecream.timetable.domain.UnitPlacement;
import org.jboss.logging.Logger;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.Set;
import java.util.random.RandomGenerator;

public final class CompatiblePlacementChainMoveIteratorFactory
        implements MoveIteratorFactory<TimetableSolution, CompatiblePlacementChainMove> {

    private static final Logger LOGGER = Logger.getLogger(CompatiblePlacementChainMoveIteratorFactory.class);
    private static final int MAX_CHAIN_DEPTH = 3;
    private static final int MAX_CHAIN_UNITS = 5;
    private static final int MAX_BLOCKERS_PER_PLACEMENT = 2;
    private static final int MAX_SEARCH_NODES = 20_000;

    private String cachedFingerprint;
    private List<CompatiblePlacementChainMove> cachedMoves = List.of();

    @Override
    public void phaseStarted(ScoreDirector<TimetableSolution> scoreDirector) {
        cachedFingerprint = null;
        cachedMoves = List.of();
        TimetableSolution solution = scoreDirector.getWorkingSolution();
        List<CompatiblePlacementChainMove> moves = moves(solution);
        long focusCount = solution.getSchedulingUnits().stream()
                .filter(CompatiblePlacementChainMoveIteratorFactory::isMovableFocus)
                .count();
        String sample = moves.stream().limit(3).map(CompatiblePlacementChainMove::describe)
                .reduce((left, right) -> left + " | " + right).orElse("");
        LOGGER.infof("Prepared %d compatible placement ejection chains for %d hard repair focus units.%s",
                moves.size(), focusCount, sample.isBlank() ? "" : " Sample: " + sample);
    }

    @Override
    public long getSize(ScoreDirector<TimetableSolution> scoreDirector) {
        return moves(scoreDirector.getWorkingSolution()).size();
    }

    @Override
    public Iterator<CompatiblePlacementChainMove> createOriginalMoveIterator(
            ScoreDirector<TimetableSolution> scoreDirector) {
        return moves(scoreDirector.getWorkingSolution()).iterator();
    }

    @Override
    public Iterator<CompatiblePlacementChainMove> createRandomMoveIterator(
            ScoreDirector<TimetableSolution> scoreDirector,
            RandomGenerator workingRandom) {
        List<CompatiblePlacementChainMove> moves = moves(scoreDirector.getWorkingSolution());
        return new Iterator<>() {
            @Override
            public boolean hasNext() {
                return !moves.isEmpty();
            }

            @Override
            public CompatiblePlacementChainMove next() {
                if (moves.isEmpty()) throw new NoSuchElementException();
                return moves.get(workingRandom.nextInt(moves.size()));
            }
        };
    }

    static List<CompatiblePlacementChainMove> buildMoves(TimetableSolution solution) {
        if (solution == null || solution.getSchedulingUnits().isEmpty()) return List.of();
        List<CompatiblePlacementChainMove> moves = new ArrayList<>();
        for (SchedulingUnit focus : solution.getSchedulingUnits()) {
            if (!isMovableFocus(focus)) continue;
            SearchBudget budget = new SearchBudget(MAX_SEARCH_NODES);
            LinkedHashMap<SchedulingUnit, UnitPlacement> plan = new LinkedHashMap<>();
            Set<SchedulingUnit> visiting = new HashSet<>();
            visiting.add(focus);
            if (findChain(solution.getSchedulingUnits(), focus, MAX_CHAIN_DEPTH, plan, visiting, budget)
                    && plan.size() >= 2) {
                moves.add(new CompatiblePlacementChainMove(
                        new ArrayList<>(plan.keySet()),
                        new ArrayList<>(plan.values())));
            }
        }
        return moves;
    }

    private List<CompatiblePlacementChainMove> moves(TimetableSolution solution) {
        String fingerprint = placementFingerprint(solution);
        if (!Objects.equals(fingerprint, cachedFingerprint)) {
            cachedFingerprint = fingerprint;
            cachedMoves = buildMoves(solution);
        }
        return cachedMoves;
    }

    private static boolean findChain(
            List<SchedulingUnit> units,
            SchedulingUnit unit,
            int remainingDepth,
            LinkedHashMap<SchedulingUnit, UnitPlacement> plan,
            Set<SchedulingUnit> visiting,
            SearchBudget budget) {
        UnitPlacement currentPlacement = unit.getPlacement();
        for (UnitPlacement candidate : orderedCandidates(unit, currentPlacement)) {
            if (!budget.tryVisit()) return false;
            if (Objects.equals(candidate, currentPlacement)) continue;
            LinkedHashMap<SchedulingUnit, UnitPlacement> planSnapshot = new LinkedHashMap<>(plan);
            Set<SchedulingUnit> visitingSnapshot = new HashSet<>(visiting);
            plan.put(unit, candidate);
            List<SchedulingUnit> conflicts = unit.advancedHardViolation(candidate)
                    ? List.of(unit)
                    : basicConflicts(units, unit, candidate, plan);
            if (conflicts.isEmpty()) {
                if (plan.size() >= 2) return true;
            } else if (conflicts.size() <= MAX_BLOCKERS_PER_PLACEMENT
                    && remainingDepth > 0
                    && plan.size() < MAX_CHAIN_UNITS) {
                int relocatedBlockers = 0;
                boolean resolved = true;
                while (!conflicts.isEmpty()) {
                    if (relocatedBlockers >= MAX_BLOCKERS_PER_PLACEMENT || plan.size() >= MAX_CHAIN_UNITS) {
                        resolved = false;
                        break;
                    }
                    SchedulingUnit blocker = conflicts.getFirst();
                    if (blocker.isPinned()
                            || blocker.getPlacement() == null
                            || !visiting.add(blocker)
                            || !findChain(units, blocker, remainingDepth - 1, plan, visiting, budget)) {
                        resolved = false;
                        break;
                    }
                    relocatedBlockers += 1;
                    conflicts = basicConflicts(units, unit, candidate, plan);
                }
                if (resolved && planIsConflictFree(units, plan)) return true;
            }
            plan.clear();
            plan.putAll(planSnapshot);
            visiting.clear();
            visiting.addAll(visitingSnapshot);
        }
        return false;
    }

    private static List<UnitPlacement> orderedCandidates(SchedulingUnit unit, UnitPlacement currentPlacement) {
        String currentRoomId = roomId(currentPlacement == null ? null : currentPlacement.getRoom());
        return unit.getCandidatePlacements().stream()
                .sorted(Comparator
                        .comparing((UnitPlacement placement) -> !Objects.equals(
                                currentRoomId,
                                roomId(placement.getRoom())))
                        .thenComparing(UnitPlacement::getId, Comparator.nullsLast(String::compareTo)))
                .toList();
    }

    private static List<SchedulingUnit> basicConflicts(
            List<SchedulingUnit> units,
            SchedulingUnit movingUnit,
            UnitPlacement candidate,
            Map<SchedulingUnit, UnitPlacement> plan) {
        List<SchedulingUnit> conflicts = new ArrayList<>();
        for (SchedulingUnit other : units) {
            if (other == null || other == movingUnit) continue;
            UnitPlacement otherPlacement = plan.getOrDefault(other, other.getPlacement());
            if (hardConflict(movingUnit, candidate, other, otherPlacement)) conflicts.add(other);
        }
        return conflicts;
    }

    private static boolean planIsConflictFree(
            List<SchedulingUnit> units,
            Map<SchedulingUnit, UnitPlacement> plan) {
        for (Map.Entry<SchedulingUnit, UnitPlacement> entry : plan.entrySet()) {
            if (entry.getKey().advancedHardViolation(entry.getValue())
                    || !basicConflicts(units, entry.getKey(), entry.getValue(), plan).isEmpty()) return false;
        }
        return true;
    }

    private static boolean basicConflict(
            SchedulingUnit left,
            UnitPlacement leftPlacement,
            SchedulingUnit right,
            UnitPlacement rightPlacement) {
        if (!overlaps(leftPlacement, rightPlacement)) return false;
        if (left.sharesClassWith(right)
                || left.sharesTeacherWith(right)
                || left.sharesMutualExclusionGroup(right)) {
            return true;
        }
        Room leftRoom = leftPlacement == null ? null : leftPlacement.getRoom();
        Room rightRoom = rightPlacement == null ? null : rightPlacement.getRoom();
        return leftRoom != null
                && rightRoom != null
                && !leftRoom.isNone()
                && !rightRoom.isNone()
                && Objects.equals(leftRoom.getId(), rightRoom.getId());
    }

    private static boolean hardConflict(
            SchedulingUnit left,
            UnitPlacement leftPlacement,
            SchedulingUnit right,
            UnitPlacement rightPlacement) {
        return basicConflict(left, leftPlacement, right, rightPlacement)
                || left.advancedHardViolation(leftPlacement)
                || right.advancedHardViolation(rightPlacement)
                || left.advancedPairHardViolation(right, leftPlacement, rightPlacement)
                || right.advancedPairHardViolation(left, rightPlacement, leftPlacement);
    }

    private static boolean overlaps(UnitPlacement left, UnitPlacement right) {
        if (left == null || right == null) return false;
        Set<String> leftSlotIds = new HashSet<>();
        for (TimeSlot slot : left.getTimeSlots()) leftSlotIds.add(slot.getId());
        return right.getTimeSlots().stream().map(TimeSlot::getId).anyMatch(leftSlotIds::contains);
    }

    private static boolean isMovableFocus(SchedulingUnit unit) {
        return unit != null
                && unit.isHardRepairFocus()
                && !unit.isPinned()
                && unit.getPlacement() != null;
    }

    private static String placementFingerprint(TimetableSolution solution) {
        if (solution == null) return "";
        StringBuilder fingerprint = new StringBuilder(solution.getSchedulingUnits().size() * 24);
        for (SchedulingUnit unit : solution.getSchedulingUnits()) {
            fingerprint.append(unit.getId()).append('=');
            fingerprint.append(unit.getPlacement() == null ? "" : unit.getPlacement().getId()).append(';');
        }
        return fingerprint.toString();
    }

    private static String roomId(Room room) {
        return room == null ? "" : room.getId();
    }

    private static final class SearchBudget {
        private final int maximum;
        private int visited;

        private SearchBudget(int maximum) {
            this.maximum = maximum;
        }

        private boolean tryVisit() {
            visited += 1;
            return visited <= maximum;
        }
    }
}
