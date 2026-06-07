package com.icecream.timetable.solver;

import ai.timefold.solver.test.api.score.stream.ConstraintVerifier;
import com.icecream.timetable.domain.LessonAssignment;
import com.icecream.timetable.domain.Room;
import com.icecream.timetable.domain.TimeSlot;
import com.icecream.timetable.domain.TimetableSolution;
import org.junit.jupiter.api.Test;

import java.util.List;

class TimetableConstraintProviderTest {

    private final ConstraintVerifier<TimetableConstraintProvider, TimetableSolution> constraintVerifier =
            ConstraintVerifier.build(new TimetableConstraintProvider(), TimetableSolution.class, LessonAssignment.class);

    @Test
    void classConflictPenalizesTwoLessonsForSameClassAtSameTime() {
        TimeSlot slot = slot("1-1", 1, 1);
        LessonAssignment left = lesson("a", "lp1", "c1", "math", List.of("t1"), slot);
        LessonAssignment right = lesson("b", "lp2", "c1", "english", List.of("t2"), slot);

        constraintVerifier.verifyThat(TimetableConstraintProvider::classConflict)
                .given(left, right)
                .penalizesBy(1);
    }

    @Test
    void teacherConflictChecksAllTeachersOnCoTaughtLessons() {
        TimeSlot slot = slot("1-1", 1, 1);
        LessonAssignment left = lesson("a", "lp1", "c1", "math", List.of("t1", "t2"), slot);
        LessonAssignment right = lesson("b", "lp2", "c2", "science", List.of("t2", "t3"), slot);

        constraintVerifier.verifyThat(TimetableConstraintProvider::teacherConflict)
                .given(left, right)
                .penalizesBy(1);
    }

    @Test
    void pinnedAndBlockedTimesAreHardConstraints() {
        LessonAssignment pinnedWrong = lesson("a", "lp1", "c1", "math", List.of("t1"), slot("1-2", 1, 2));
        pinnedWrong.setPinnedTimeSlotId("1-1");
        LessonAssignment blocked = lesson("b", "lp2", "c1", "english", List.of("t2"), slot("2-1", 2, 1));
        blocked.setBlockedTimeSlotIds(List.of("2-1"));

        constraintVerifier.verifyThat(TimetableConstraintProvider::pinnedTime)
                .given(pinnedWrong)
                .penalizesBy(1);
        constraintVerifier.verifyThat(TimetableConstraintProvider::blockedTime)
                .given(blocked)
                .penalizesBy(1);
    }

    @Test
    void roomRequirementAndRoomConflictAreHardConstraints() {
        TimeSlot slot = slot("1-1", 1, 1);
        Room gym = room("gym", false);
        LessonAssignment missingRoom = lesson("a", "lp1", "c1", "pe", List.of("t1"), slot);
        missingRoom.setRequiresRoom(true);
        missingRoom.setAllowedRoomIds(List.of("gym"));
        missingRoom.setRoom(room("__NONE__", true));
        LessonAssignment left = lesson("b", "lp2", "c2", "pe", List.of("t2"), slot);
        LessonAssignment right = lesson("c", "lp3", "c3", "pe", List.of("t3"), slot);
        left.setRequiresRoom(true);
        right.setRequiresRoom(true);
        left.setAllowedRoomIds(List.of("gym"));
        right.setAllowedRoomIds(List.of("gym"));
        left.setRoom(gym);
        right.setRoom(gym);

        constraintVerifier.verifyThat(TimetableConstraintProvider::roomRequirement)
                .given(missingRoom)
                .penalizesBy(1);
        constraintVerifier.verifyThat(TimetableConstraintProvider::roomConflict)
                .given(left, right)
                .penalizesBy(1);
    }

    @Test
    void consecutiveBlockRequiresSameDayAndAdjacentOrderedPeriods() {
        LessonAssignment first = lesson("a", "lp1", "c1", "math", List.of("t1"), slot("1-1", 1, 1));
        LessonAssignment second = lesson("b", "lp1", "c1", "math", List.of("t1"), slot("1-3", 1, 3));
        first.setBlockId("block-1");
        second.setBlockId("block-1");
        first.setBlockIndex(0);
        second.setBlockIndex(1);
        first.setBlockSize(2);
        second.setBlockSize(2);

        constraintVerifier.verifyThat(TimetableConstraintProvider::consecutiveBlock)
                .given(first, second)
                .penalizesBy(1);

        second.setTimeSlot(slot("1-2", 1, 2));
        constraintVerifier.verifyThat(TimetableConstraintProvider::consecutiveBlock)
                .given(first, second)
                .hasNoImpact();
    }

    private static LessonAssignment lesson(String id, String planId, String classId, String subjectId,
                                           List<String> teacherIds, TimeSlot timeSlot) {
        LessonAssignment assignment = new LessonAssignment();
        assignment.setId(id);
        assignment.setLessonPlanId(planId);
        assignment.setClassId(classId);
        assignment.setSubjectId(subjectId);
        assignment.setTeacherId(teacherIds.get(0));
        assignment.setTeacherIds(teacherIds);
        assignment.setBlockSize(1);
        assignment.setTimeSlot(timeSlot);
        assignment.setRoom(room("__NONE__", true));
        return assignment;
    }

    private static TimeSlot slot(String id, int weekday, int lessonIndex) {
        TimeSlot slot = new TimeSlot();
        slot.setId(id);
        slot.setWeekday(weekday);
        slot.setLessonIndex(lessonIndex);
        slot.setMorning(lessonIndex <= 2);
        return slot;
    }

    private static Room room(String id, boolean none) {
        Room room = new Room();
        room.setId(id);
        room.setName(id);
        room.setNone(none);
        return room;
    }
}
