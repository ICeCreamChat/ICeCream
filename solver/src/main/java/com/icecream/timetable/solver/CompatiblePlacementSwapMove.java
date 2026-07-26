package com.icecream.timetable.solver;

import ai.timefold.solver.core.api.domain.common.Lookup;
import ai.timefold.solver.core.preview.api.domain.metamodel.PlanningVariableMetaModel;
import ai.timefold.solver.core.preview.api.move.Move;
import ai.timefold.solver.core.preview.api.move.MutableSolutionView;
import com.icecream.timetable.domain.SchedulingUnit;
import com.icecream.timetable.domain.TimetableSolution;
import com.icecream.timetable.domain.UnitPlacement;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.SequencedCollection;

public final class CompatiblePlacementSwapMove implements Move<TimetableSolution> {

    private final SchedulingUnit leftUnit;
    private final SchedulingUnit rightUnit;
    private final UnitPlacement leftPlacement;
    private final UnitPlacement rightPlacement;

    public CompatiblePlacementSwapMove(
            SchedulingUnit leftUnit,
            SchedulingUnit rightUnit,
            UnitPlacement leftPlacement,
            UnitPlacement rightPlacement) {
        this.leftUnit = Objects.requireNonNull(leftUnit);
        this.rightUnit = Objects.requireNonNull(rightUnit);
        this.leftPlacement = Objects.requireNonNull(leftPlacement);
        this.rightPlacement = Objects.requireNonNull(rightPlacement);
    }

    @Override
    public void execute(MutableSolutionView<TimetableSolution> solutionView) {
        PlanningVariableMetaModel<TimetableSolution, SchedulingUnit, UnitPlacement> placementVariable =
                solutionView.getSolutionMetaModel()
                        .genuineEntity(SchedulingUnit.class)
                        .basicVariable("placement", UnitPlacement.class);
        solutionView.changeVariable(placementVariable, leftUnit, leftPlacement);
        solutionView.changeVariable(placementVariable, rightUnit, rightPlacement);
    }

    @Override
    public CompatiblePlacementSwapMove rebase(Lookup lookup) {
        SchedulingUnit rebasedLeft = lookup.lookUpWorkingObject(leftUnit);
        SchedulingUnit rebasedRight = lookup.lookUpWorkingObject(rightUnit);
        return new CompatiblePlacementSwapMove(
                rebasedLeft,
                rebasedRight,
                findPlacement(rebasedLeft, leftPlacement.getId()),
                findPlacement(rebasedRight, rightPlacement.getId()));
    }

    @Override
    public SequencedCollection<Object> getPlanningEntities() {
        return List.of(leftUnit, rightUnit);
    }

    @Override
    public SequencedCollection<Object> getPlanningValues() {
        return new LinkedHashSet<>(List.of(leftPlacement, rightPlacement));
    }

    @Override
    public String describe() {
        return "%s -> %s, %s -> %s".formatted(
                leftUnit.getId(), leftPlacement.getId(), rightUnit.getId(), rightPlacement.getId());
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof CompatiblePlacementSwapMove move
                && Objects.equals(leftUnit, move.leftUnit)
                && Objects.equals(rightUnit, move.rightUnit)
                && Objects.equals(leftPlacement, move.leftPlacement)
                && Objects.equals(rightPlacement, move.rightPlacement);
    }

    @Override
    public int hashCode() {
        return Objects.hash(leftUnit, rightUnit, leftPlacement, rightPlacement);
    }

    @Override
    public String toString() {
        return describe();
    }

    private static UnitPlacement findPlacement(SchedulingUnit unit, String placementId) {
        return unit.getCandidatePlacements().stream()
                .filter(candidate -> Objects.equals(candidate.getId(), placementId))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "Missing rebased placement %s for unit %s".formatted(placementId, unit.getId())));
    }
}
