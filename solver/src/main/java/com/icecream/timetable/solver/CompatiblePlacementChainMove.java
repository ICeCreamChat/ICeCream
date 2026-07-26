package com.icecream.timetable.solver;

import ai.timefold.solver.core.api.domain.common.Lookup;
import ai.timefold.solver.core.preview.api.domain.metamodel.PlanningVariableMetaModel;
import ai.timefold.solver.core.preview.api.move.Move;
import ai.timefold.solver.core.preview.api.move.MutableSolutionView;
import com.icecream.timetable.domain.SchedulingUnit;
import com.icecream.timetable.domain.TimetableSolution;
import com.icecream.timetable.domain.UnitPlacement;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.SequencedCollection;

public final class CompatiblePlacementChainMove implements Move<TimetableSolution> {

    private final List<SchedulingUnit> units;
    private final List<UnitPlacement> placements;

    public CompatiblePlacementChainMove(List<SchedulingUnit> units, List<UnitPlacement> placements) {
        if (units == null || placements == null || units.size() != placements.size() || units.size() < 2) {
            throw new IllegalArgumentException("A placement chain requires at least two matching units and placements.");
        }
        this.units = List.copyOf(units);
        this.placements = List.copyOf(placements);
    }

    @Override
    public void execute(MutableSolutionView<TimetableSolution> solutionView) {
        PlanningVariableMetaModel<TimetableSolution, SchedulingUnit, UnitPlacement> placementVariable =
                solutionView.getSolutionMetaModel()
                        .genuineEntity(SchedulingUnit.class)
                        .basicVariable("placement", UnitPlacement.class);
        for (int index = 0; index < units.size(); index++) {
            solutionView.changeVariable(placementVariable, units.get(index), placements.get(index));
        }
    }

    @Override
    public CompatiblePlacementChainMove rebase(Lookup lookup) {
        List<SchedulingUnit> rebasedUnits = new ArrayList<>(units.size());
        List<UnitPlacement> rebasedPlacements = new ArrayList<>(placements.size());
        for (int index = 0; index < units.size(); index++) {
            SchedulingUnit rebasedUnit = lookup.lookUpWorkingObject(units.get(index));
            rebasedUnits.add(rebasedUnit);
            rebasedPlacements.add(findPlacement(rebasedUnit, placements.get(index).getId()));
        }
        return new CompatiblePlacementChainMove(rebasedUnits, rebasedPlacements);
    }

    @Override
    public SequencedCollection<Object> getPlanningEntities() {
        return new ArrayList<>(units);
    }

    @Override
    public SequencedCollection<Object> getPlanningValues() {
        return new LinkedHashSet<>(placements);
    }

    @Override
    public String describe() {
        List<String> changes = new ArrayList<>(units.size());
        for (int index = 0; index < units.size(); index++) {
            changes.add(units.get(index).getId() + " -> " + placements.get(index).getId());
        }
        return String.join(", ", changes);
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof CompatiblePlacementChainMove move
                && Objects.equals(units, move.units)
                && Objects.equals(placements, move.placements);
    }

    @Override
    public int hashCode() {
        return Objects.hash(units, placements);
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
