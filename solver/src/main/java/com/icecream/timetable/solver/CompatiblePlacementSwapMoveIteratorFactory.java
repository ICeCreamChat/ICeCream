package com.icecream.timetable.solver;

import ai.timefold.solver.core.impl.heuristic.selector.move.factory.MoveIteratorFactory;
import ai.timefold.solver.core.impl.score.director.ScoreDirector;
import com.icecream.timetable.domain.Room;
import com.icecream.timetable.domain.SchedulingUnit;
import com.icecream.timetable.domain.TimetableSolution;
import com.icecream.timetable.domain.UnitPlacement;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.Set;
import java.util.random.RandomGenerator;

public final class CompatiblePlacementSwapMoveIteratorFactory
        implements MoveIteratorFactory<TimetableSolution, CompatiblePlacementSwapMove> {

    @Override
    public long getSize(ScoreDirector<TimetableSolution> scoreDirector) {
        return buildMoves(scoreDirector.getWorkingSolution()).size();
    }

    @Override
    public Iterator<CompatiblePlacementSwapMove> createOriginalMoveIterator(
            ScoreDirector<TimetableSolution> scoreDirector) {
        return buildMoves(scoreDirector.getWorkingSolution()).iterator();
    }

    @Override
    public Iterator<CompatiblePlacementSwapMove> createRandomMoveIterator(
            ScoreDirector<TimetableSolution> scoreDirector,
            RandomGenerator workingRandom) {
        List<CompatiblePlacementSwapMove> moves = buildMoves(scoreDirector.getWorkingSolution());
        return new Iterator<>() {
            @Override
            public boolean hasNext() {
                return !moves.isEmpty();
            }

            @Override
            public CompatiblePlacementSwapMove next() {
                if (moves.isEmpty()) throw new NoSuchElementException();
                return moves.get(workingRandom.nextInt(moves.size()));
            }
        };
    }

    static List<CompatiblePlacementSwapMove> buildMoves(TimetableSolution solution) {
        if (solution == null || solution.getSchedulingUnits().isEmpty()) return List.of();
        List<CompatiblePlacementSwapMove> moves = new ArrayList<>();
        Set<String> moveKeys = new HashSet<>();
        for (SchedulingUnit focus : solution.getSchedulingUnits()) {
            if (!isMovableFocus(focus)) continue;
            for (SchedulingUnit blocker : solution.getSchedulingUnits()) {
                if (blocker == focus || blocker == null || blocker.isPinned() || blocker.getPlacement() == null) continue;
                if (!sharesHardResource(focus, blocker)) continue;
                addCompatibleExchanges(focus, blocker, moves, moveKeys);
            }
        }
        return moves;
    }

    private static boolean isMovableFocus(SchedulingUnit unit) {
        return unit != null
                && unit.isHardRepairFocus()
                && !unit.isPinned()
                && unit.getPlacement() != null
                && unit.getStartTimeSlot() != null;
    }

    private static boolean sharesHardResource(SchedulingUnit left, SchedulingUnit right) {
        if (left.sharesClassWith(right)
                || left.sharesTeacherWith(right)
                || left.sharesMutualExclusionGroup(right)) {
            return true;
        }
        Set<String> leftRooms = candidateRoomIds(left);
        return right.getCandidatePlacements().stream()
                .map(UnitPlacement::getRoom)
                .filter(Objects::nonNull)
                .filter(room -> !room.isNone())
                .map(Room::getId)
                .anyMatch(leftRooms::contains);
    }

    private static Set<String> candidateRoomIds(SchedulingUnit unit) {
        Set<String> roomIds = new HashSet<>();
        for (UnitPlacement placement : unit.getCandidatePlacements()) {
            Room room = placement.getRoom();
            if (room != null && !room.isNone()) roomIds.add(room.getId());
        }
        return roomIds;
    }

    private static void addCompatibleExchanges(
            SchedulingUnit focus,
            SchedulingUnit blocker,
            List<CompatiblePlacementSwapMove> moves,
            Set<String> moveKeys) {
        String focusStartId = focus.getStartTimeSlot().getId();
        String blockerStartId = blocker.getStartTimeSlot().getId();
        if (Objects.equals(focusStartId, blockerStartId)) return;

        List<UnitPlacement> focusTargets = placementsStartingAt(focus, blockerStartId);
        List<UnitPlacement> blockerTargets = placementsStartingAt(blocker, focusStartId);
        for (UnitPlacement focusTarget : focusTargets) {
            for (UnitPlacement blockerTarget : blockerTargets) {
                String key = focus.getId() + "|" + blocker.getId() + "|"
                        + focusTarget.getId() + "|" + blockerTarget.getId();
                if (!moveKeys.add(key)) continue;
                moves.add(new CompatiblePlacementSwapMove(focus, blocker, focusTarget, blockerTarget));
            }
        }
    }

    private static List<UnitPlacement> placementsStartingAt(SchedulingUnit unit, String timeSlotId) {
        return unit.getCandidatePlacements().stream()
                .filter(placement -> placement.getStartTimeSlot() != null)
                .filter(placement -> Objects.equals(placement.getStartTimeSlot().getId(), timeSlotId))
                .toList();
    }
}
