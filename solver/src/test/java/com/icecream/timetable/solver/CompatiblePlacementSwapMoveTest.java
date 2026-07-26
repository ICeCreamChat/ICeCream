package com.icecream.timetable.solver;

import ai.timefold.solver.core.preview.api.domain.metamodel.PlanningSolutionMetaModel;
import ai.timefold.solver.core.preview.api.move.test.MoveTester;
import com.icecream.timetable.domain.LessonAssignment;
import com.icecream.timetable.domain.Room;
import com.icecream.timetable.domain.SchedulingUnit;
import com.icecream.timetable.domain.TimeSlot;
import com.icecream.timetable.domain.TimetableSolution;
import com.icecream.timetable.domain.UnitPlacement;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CompatiblePlacementSwapMoveTest {

    private static final PlanningSolutionMetaModel<TimetableSolution> SOLUTION_META_MODEL =
            PlanningSolutionMetaModel.of(TimetableSolution.class, SchedulingUnit.class);

    @Test
    void swapsTimesUsingEntitySpecificPlacementsWithoutSwappingRooms() {
        TimeSlot mondayFirst = slot("1-1", 1, 1);
        TimeSlot mondaySecond = slot("1-2", 1, 2);
        Room leftRoom = room("left-room");
        Room rightRoom = room("right-room");
        SchedulingUnit left = unit("left", "c1", "t1", false, List.of(
                placement("left@1-1", List.of(mondayFirst), leftRoom),
                placement("left@1-2", List.of(mondaySecond), leftRoom)));
        SchedulingUnit right = unit("right", "c2", "t1", false, List.of(
                placement("right@1-1", List.of(mondayFirst), rightRoom),
                placement("right@1-2", List.of(mondaySecond), rightRoom)));
        TimetableSolution solution = solution(left, right);

        CompatiblePlacementSwapMove move = new CompatiblePlacementSwapMove(
                left,
                right,
                left.getCandidatePlacements().get(1),
                right.getCandidatePlacements().get(0));
        MoveTester.build(SOLUTION_META_MODEL).using(solution).execute(move);

        assertEquals("1-2", left.getStartTimeSlot().getId());
        assertEquals("left-room", left.getRoom().getId());
        assertEquals("1-1", right.getStartTimeSlot().getId());
        assertEquals("right-room", right.getRoom().getId());
    }

    @Test
    void swapsWholeConsecutivePlacementsWithoutSplittingBlocks() {
        TimeSlot mondayFirst = slot("1-1", 1, 1);
        TimeSlot mondaySecond = slot("1-2", 1, 2);
        TimeSlot tuesdayFirst = slot("2-1", 2, 1);
        TimeSlot tuesdaySecond = slot("2-2", 2, 2);
        Room none = room(Room.NONE_ID);
        SchedulingUnit left = blockUnit("left", "c1", "t1", false, List.of(
                placement("left@monday", List.of(mondayFirst, mondaySecond), none),
                placement("left@tuesday", List.of(tuesdayFirst, tuesdaySecond), none)));
        SchedulingUnit right = blockUnit("right", "c2", "t1", false, List.of(
                placement("right@monday", List.of(mondayFirst, mondaySecond), none),
                placement("right@tuesday", List.of(tuesdayFirst, tuesdaySecond), none)));

        CompatiblePlacementSwapMove move = new CompatiblePlacementSwapMove(
                left,
                right,
                left.getCandidatePlacements().get(1),
                right.getCandidatePlacements().get(0));
        MoveTester.build(SOLUTION_META_MODEL).using(solution(left, right)).execute(move);

        assertEquals(List.of("2-1", "2-2"), left.getTimeSlots().stream().map(TimeSlot::getId).toList());
        assertEquals(List.of("1-1", "1-2"), right.getTimeSlots().stream().map(TimeSlot::getId).toList());
    }

    @Test
    void factoryBuildsCompatibleExchangesForRepairFocusAndSkipsPinnedUnits() {
        TimeSlot mondayFirst = slot("1-1", 1, 1);
        TimeSlot mondaySecond = slot("1-2", 1, 2);
        Room none = room(Room.NONE_ID);
        SchedulingUnit focus = unit("focus", "c1", "shared-teacher", false, List.of(
                placement("focus@1-1", List.of(mondayFirst), none),
                placement("focus@1-2", List.of(mondaySecond), none)));
        focus.setHardRepairFocus(true);
        SchedulingUnit blocker = unit("blocker", "c2", "shared-teacher", false, List.of(
                placement("blocker@1-1", List.of(mondayFirst), none),
                placement("blocker@1-2", List.of(mondaySecond), none)));
        blocker.setPlacement(blocker.getCandidatePlacements().get(1));
        SchedulingUnit pinned = unit("pinned", "c3", "shared-teacher", true, List.of(
                placement("pinned@1-1", List.of(mondayFirst), none),
                placement("pinned@1-2", List.of(mondaySecond), none)));
        pinned.setPlacement(pinned.getCandidatePlacements().get(1));

        List<CompatiblePlacementSwapMove> moves = CompatiblePlacementSwapMoveIteratorFactory.buildMoves(
                solution(focus, blocker, pinned));

        assertEquals(1, moves.size());
        assertTrue(moves.getFirst().getPlanningEntities().containsAll(List.of(focus, blocker)));
    }

    @Test
    void boundedEjectionChainRelocatesABlockerInsteadOfCreatingAnotherConflict() {
        TimeSlot first = slot("1-1", 1, 1);
        TimeSlot second = slot("1-2", 1, 2);
        TimeSlot third = slot("1-3", 1, 3);
        Room none = room(Room.NONE_ID);
        SchedulingUnit focus = unit("focus", "class-a", "teacher-a", false, List.of(
                placement("focus@1", List.of(first), none),
                placement("focus@2", List.of(second), none)));
        focus.setHardRepairFocus(true);
        SchedulingUnit originalClassBlocker = unit("class-a-existing", "class-a", "teacher-b", true, List.of(
                placement("class-a-existing@1", List.of(first), none)));
        SchedulingUnit targetTeacherBlocker = unit("teacher-a-blocker", "class-b", "teacher-a", false, List.of(
                placement("teacher-a-blocker@1", List.of(first), none),
                placement("teacher-a-blocker@2", List.of(second), none),
                placement("teacher-a-blocker@3", List.of(third), none)));
        targetTeacherBlocker.setPlacement(targetTeacherBlocker.getCandidatePlacements().get(1));
        SchedulingUnit targetClassBlocker = unit("class-b-existing", "class-b", "teacher-c", true, List.of(
                placement("class-b-existing@1", List.of(first), none)));
        TimetableSolution solution = solution(
                focus,
                originalClassBlocker,
                targetTeacherBlocker,
                targetClassBlocker);

        List<CompatiblePlacementChainMove> moves = CompatiblePlacementChainMoveIteratorFactory.buildMoves(solution);

        assertEquals(1, moves.size());
        MoveTester.build(SOLUTION_META_MODEL).using(solution).execute(moves.getFirst());
        assertEquals("1-2", focus.getStartTimeSlot().getId());
        assertEquals("1-3", targetTeacherBlocker.getStartTimeSlot().getId());
    }

    @Test
    void boundedEjectionChainCanRelocateTwoIndependentResourceBlockers() {
        TimeSlot first = slot("1-1", 1, 1);
        TimeSlot second = slot("1-2", 1, 2);
        TimeSlot third = slot("1-3", 1, 3);
        TimeSlot fourth = slot("1-4", 1, 4);
        Room sharedRoom = room("shared-room");
        Room otherRoom = room("other-room");
        SchedulingUnit focus = unit("focus", "class-a", "teacher-a", false, List.of(
                placement("focus@1", List.of(first), sharedRoom),
                placement("focus@2", List.of(second), sharedRoom)));
        focus.setHardRepairFocus(true);
        SchedulingUnit originalClassBlocker = unit("class-a-existing", "class-a", "teacher-b", true, List.of(
                placement("class-a-existing@1", List.of(first), otherRoom)));
        SchedulingUnit teacherBlocker = unit("teacher-a-blocker", "class-b", "teacher-a", false, List.of(
                placement("teacher-a-blocker@2", List.of(second), otherRoom),
                placement("teacher-a-blocker@3", List.of(third), otherRoom)));
        SchedulingUnit roomBlocker = unit("room-blocker", "class-c", "teacher-c", false, List.of(
                placement("room-blocker@2", List.of(second), sharedRoom),
                placement("room-blocker@4", List.of(fourth), sharedRoom)));
        TimetableSolution solution = solution(focus, originalClassBlocker, teacherBlocker, roomBlocker);

        List<CompatiblePlacementChainMove> moves = CompatiblePlacementChainMoveIteratorFactory.buildMoves(solution);

        assertEquals(1, moves.size());
        MoveTester.build(SOLUTION_META_MODEL).using(solution).execute(moves.getFirst());
        assertEquals("1-2", focus.getStartTimeSlot().getId());
        assertEquals("1-3", teacherBlocker.getStartTimeSlot().getId());
        assertEquals("1-4", roomBlocker.getStartTimeSlot().getId());
    }

    @Test
    void ejectionChainRejectsAdvancedCrossVenueBoundaryConflicts() {
        TimeSlot beforeBoundary = slot("1-4", 1, 4);
        TimeSlot afterBoundary = slot("1-5", 1, 5);
        TimeSlot current = slot("1-3", 1, 3);
        Room leftRoom = room("left-room");
        Room rightRoom = room("right-room");

        SchedulingUnit focus = unit("focus", "class-a", "teacher-a", false, List.of(
                placement("focus@current", List.of(current), leftRoom),
                placement("focus@boundary", List.of(afterBoundary), rightRoom)));
        focus.setHardRepairFocus(true);
        LessonAssignment.AdvancedRuleRef boundaryRule = new LessonAssignment.AdvancedRuleRef();
        boundaryRule.setType("schedule.cross_venue_boundary");
        boundaryRule.setHard(true);
        boundaryRule.setBoundaryPeriods(List.of(4, 5));
        focus.firstAssignment().setAdvancedRules(List.of(boundaryRule));

        SchedulingUnit pinnedBoundary = unit("pinned-boundary", "class-a", "teacher-b", true, List.of(
                placement("pinned-boundary@boundary", List.of(beforeBoundary), leftRoom)));

        assertTrue(CompatiblePlacementChainMoveIteratorFactory.buildMoves(
                solution(focus, pinnedBoundary)).isEmpty());
    }

    private static TimetableSolution solution(SchedulingUnit... units) {
        TimetableSolution solution = new TimetableSolution();
        solution.setSchedulingUnits(List.of(units));
        solution.setLessonAssignments(List.of(units).stream()
                .flatMap(unit -> unit.getAssignments().stream())
                .toList());
        return solution;
    }

    private static SchedulingUnit unit(
            String id,
            String classId,
            String teacherId,
            boolean pinned,
            List<UnitPlacement> placements) {
        LessonAssignment assignment = lesson(id + "-lesson", classId, teacherId, pinned, 0, 1);
        SchedulingUnit unit = new SchedulingUnit();
        unit.setId(id);
        unit.setAssignments(List.of(assignment));
        unit.setCandidatePlacements(placements);
        unit.setPlacement(placements.getFirst());
        return unit;
    }

    private static SchedulingUnit blockUnit(
            String id,
            String classId,
            String teacherId,
            boolean pinned,
            List<UnitPlacement> placements) {
        SchedulingUnit unit = new SchedulingUnit();
        unit.setId(id);
        unit.setAssignments(List.of(
                lesson(id + "-0", classId, teacherId, pinned, 0, 2),
                lesson(id + "-1", classId, teacherId, pinned, 1, 2)));
        unit.setCandidatePlacements(placements);
        unit.setPlacement(placements.getFirst());
        return unit;
    }

    private static LessonAssignment lesson(
            String id,
            String classId,
            String teacherId,
            boolean pinned,
            int blockIndex,
            int blockSize) {
        LessonAssignment assignment = new LessonAssignment();
        assignment.setId(id);
        assignment.setClassId(classId);
        assignment.setTeacherId(teacherId);
        assignment.setTeacherIds(List.of(teacherId));
        assignment.setLocked(pinned);
        assignment.setBlockId(blockSize > 1 ? id.substring(0, id.length() - 2) : null);
        assignment.setBlockIndex(blockIndex);
        assignment.setBlockSize(blockSize);
        return assignment;
    }

    private static UnitPlacement placement(String id, List<TimeSlot> slots, Room room) {
        return new UnitPlacement(id, slots, room);
    }

    private static TimeSlot slot(String id, int weekday, int lessonIndex) {
        TimeSlot slot = new TimeSlot();
        slot.setId(id);
        slot.setWeekday(weekday);
        slot.setLessonIndex(lessonIndex);
        return slot;
    }

    private static Room room(String id) {
        Room room = new Room();
        room.setId(id);
        room.setName(id);
        room.setNone(Room.NONE_ID.equals(id));
        return room;
    }
}
