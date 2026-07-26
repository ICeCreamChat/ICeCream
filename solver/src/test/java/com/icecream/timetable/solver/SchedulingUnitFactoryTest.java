package com.icecream.timetable.solver;

import com.icecream.timetable.domain.LessonAssignment;
import com.icecream.timetable.domain.Room;
import com.icecream.timetable.domain.SchedulingUnit;
import com.icecream.timetable.domain.TimeSlot;
import com.icecream.timetable.domain.TimetableSolution;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SchedulingUnitFactoryTest {

    @Test
    void createsOneAtomicUnitForACompleteDoubleBlockWithOnlyContiguousCandidates() {
        LessonAssignment first = assignment("first", "block-a", 0, 2);
        LessonAssignment second = assignment("second", "block-a", 1, 2);
        TimetableSolution solution = solution(List.of(first, second));

        List<SchedulingUnit> units = SchedulingUnitFactory.build(solution);

        assertEquals(1, units.size());
        SchedulingUnit unit = units.getFirst();
        assertEquals(2, unit.getBlockSize());
        assertFalse(unit.getCandidatePlacements().isEmpty());
        assertTrue(unit.getCandidatePlacements().stream().allMatch(placement -> (
                placement.getTimeSlots().size() == 2
                        && placement.getTimeSlots().get(0).getWeekday() == placement.getTimeSlots().get(1).getWeekday()
                        && placement.getTimeSlots().get(1).getLessonIndex()
                            == placement.getTimeSlots().get(0).getLessonIndex() + 1
        )));
    }

    @Test
    void clearsPartialBlockSeedsInsteadOfPassingAFragmentToTheSolver() {
        LessonAssignment first = assignment("first", "block-partial", 0, 2);
        LessonAssignment second = assignment("second", "block-partial", 1, 2);
        TimetableSolution solution = solution(List.of(first, second));
        first.setTimeSlot(solution.getTimeSlots().getFirst());
        second.setTimeSlot(null);

        SchedulingUnit unit = SchedulingUnitFactory.build(solution).getFirst();

        assertNull(unit.getPlacement());
        assertNull(second.getTimeSlot());
    }

    @Test
    void intersectsRoomDomainsAcrossEveryMemberOfTheUnit() {
        Room gymA = room("gym-a", false);
        Room gymB = room("gym-b", false);
        LessonAssignment first = assignment("first", "block-room", 0, 2);
        LessonAssignment second = assignment("second", "block-room", 1, 2);
        for (LessonAssignment assignment : List.of(first, second)) {
            assignment.setRequiresRoom(true);
            assignment.setRoomRange(List.of(gymA, gymB));
        }
        first.setAllowedRoomIds(List.of("gym-a", "gym-b"));
        second.setAllowedRoomIds(List.of("gym-b"));
        TimetableSolution solution = solution(List.of(first, second));
        solution.setRooms(List.of(Room.none(), gymA, gymB));

        SchedulingUnit unit = SchedulingUnitFactory.build(solution).getFirst();

        assertTrue(unit.getCandidatePlacements().stream()
                .allMatch(placement -> "gym-b".equals(placement.getRoom().getId())));
    }

    private static TimetableSolution solution(List<LessonAssignment> assignments) {
        TimetableSolution solution = new TimetableSolution();
        solution.setTimeSlots(List.of(
                new TimeSlot("1-1", 1, 1, true),
                new TimeSlot("1-2", 1, 2, true),
                new TimeSlot("1-3", 1, 3, false),
                new TimeSlot("2-1", 2, 1, true),
                new TimeSlot("2-2", 2, 2, true),
                new TimeSlot("2-3", 2, 3, false)));
        solution.setRooms(List.of(Room.none()));
        solution.setLessonAssignments(assignments);
        return solution;
    }

    private static LessonAssignment assignment(String id, String blockId, int blockIndex, int blockSize) {
        LessonAssignment assignment = new LessonAssignment();
        assignment.setId(id);
        assignment.setClassId("c1");
        assignment.setSubjectId("subject");
        assignment.setTeacherId("t1");
        assignment.setTeacherIds(List.of("t1"));
        assignment.setBlockId(blockId);
        assignment.setBlockIndex(blockIndex);
        assignment.setBlockSize(blockSize);
        assignment.setBlockedTimeSlotIds(List.of());
        assignment.setRoom(Room.none());
        assignment.setRoomRange(List.of(Room.none()));
        return assignment;
    }

    private static Room room(String id, boolean none) {
        Room room = new Room();
        room.setId(id);
        room.setNone(none);
        return room;
    }
}
