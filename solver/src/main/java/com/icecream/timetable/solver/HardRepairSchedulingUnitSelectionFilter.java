package com.icecream.timetable.solver;

import ai.timefold.solver.core.impl.heuristic.selector.common.decorator.SelectionFilter;
import ai.timefold.solver.core.impl.score.director.ScoreDirector;
import com.icecream.timetable.domain.SchedulingUnit;
import com.icecream.timetable.domain.TimetableSolution;

import java.util.HashSet;
import java.util.Set;

public final class HardRepairSchedulingUnitSelectionFilter
        implements SelectionFilter<TimetableSolution, SchedulingUnit> {

    @Override
    public boolean accept(ScoreDirector<TimetableSolution> scoreDirector, SchedulingUnit selection) {
        return acceptSolution(scoreDirector.getWorkingSolution(), selection);
    }

    boolean acceptSolution(TimetableSolution solution, SchedulingUnit selection) {
        if (selection == null || selection.isPinned()) return false;
        if (selection.isHardRepairFocus() || selection.getPlacement() == null) return true;

        for (SchedulingUnit focus : solution.getSchedulingUnits()) {
            if (focus == null || (!focus.isHardRepairFocus() && focus.getPlacement() != null)) continue;
            if (selection.sharesClassWith(focus) || selection.sharesTeacherWith(focus)) return true;
            Set<String> candidateRoomIds = new HashSet<>();
            focus.getCandidatePlacements().forEach(placement -> {
                if (placement.getRoom() != null && !placement.getRoom().isNone()) {
                    candidateRoomIds.add(placement.getRoom().getId());
                }
            });
            if (selection.getRoom() != null && candidateRoomIds.contains(selection.getRoom().getId())) return true;
        }
        return false;
    }
}
