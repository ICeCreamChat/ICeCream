package com.icecream.timetable.solver;

import ai.timefold.solver.core.api.score.stream.test.ConstraintVerifier;
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
    void roomRequirementRejectsRoomsOutsideAllowedRoomList() {
        LessonAssignment wrongRoom = lesson("a", "lp1", "c1", "science", List.of("t1"), slot("1-1", 1, 1));
        wrongRoom.setRequiresRoom(true);
        wrongRoom.setAllowedRoomIds(List.of("lab-a"));
        wrongRoom.setRoom(room("gym", false));

        constraintVerifier.verifyThat(TimetableConstraintProvider::roomRequirement)
                .given(wrongRoom)
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

    @Test
    void teacherLunchBridgePenalizesTeacherAcrossNoon() {
        LessonAssignment morningLast = lesson("a", "lp1", "c1", "math", List.of("t1"), slot("1-3", 1, 3, true));
        LessonAssignment afternoonFirst = lesson("b", "lp2", "c2", "english", List.of("t1"), slot("1-4", 1, 4, false));

        constraintVerifier.verifyThat(TimetableConstraintProvider::teacherLunchBridge)
                .given(morningLast, afternoonFirst)
                .penalizesBy(4);
    }

    @Test
    void teacherGapPenalizesNonContinuousLessonsInSameHalfDay() {
        LessonAssignment first = lesson("a", "lp1", "c1", "math", List.of("t1"), slot("1-1", 1, 1, true));
        LessonAssignment third = lesson("b", "lp2", "c2", "english", List.of("t1"), slot("1-3", 1, 3, true));

        constraintVerifier.verifyThat(TimetableConstraintProvider::teacherGap)
                .given(first, third)
                .penalizesBy(2);
    }

    @Test
    void teacherWeeklyLimitCountsSecondaryTeachersIndependently() {
        LessonAssignment first = lesson("a", "lp1", "c1", "math", List.of("t_primary", "t_helper"), slot("1-1", 1, 1));
        LessonAssignment second = lesson("b", "lp2", "c2", "science", List.of("t_primary", "t_helper"), slot("2-1", 2, 1));
        setTeacherConstraintRefs(first, List.of(
                teacherRef("t_primary", 99, 5, 1),
                teacherRef("t_helper", 1, 5, 1)));
        setTeacherConstraintRefs(second, List.of(
                teacherRef("t_primary", 99, 5, 1),
                teacherRef("t_helper", 1, 5, 1)));

        constraintVerifier.verifyThat(TimetableConstraintProvider::teacherWeeklyLimit)
                .given(first, second)
                .penalizesBy(1);
    }

    @Test
    void teacherMaxDaysPerWeekCountsSecondaryTeachersIndependently() {
        LessonAssignment first = lesson("a", "lp1", "c1", "math", List.of("t_primary", "t_helper"), slot("1-1", 1, 1));
        LessonAssignment second = lesson("b", "lp2", "c2", "science", List.of("t_primary", "t_helper"), slot("2-1", 2, 1));
        setTeacherConstraintRefs(first, List.of(
                teacherRef("t_primary", 99, 5, 1),
                teacherRef("t_helper", 99, 1, 1)));
        setTeacherConstraintRefs(second, List.of(
                teacherRef("t_primary", 99, 5, 1),
                teacherRef("t_helper", 99, 1, 1)));

        constraintVerifier.verifyThat(TimetableConstraintProvider::teacherMaxDaysPerWeek)
                .given(first, second)
                .penalizesBy(1);
    }

    @Test
    void teacherDailyLoadHonorsBalanceWeight() {
        LessonAssignment disabledFirst = lesson("a", "lp1", "c1", "math", List.of("t1"), slot("1-1", 1, 1));
        LessonAssignment disabledSecond = lesson("b", "lp2", "c2", "science", List.of("t1"), slot("1-2", 1, 2));
        disabledFirst.setTeacherLoadBalanceWeight(0);
        disabledSecond.setTeacherLoadBalanceWeight(0);

        constraintVerifier.verifyThat(TimetableConstraintProvider::teacherDailyLoad)
                .given(disabledFirst, disabledSecond)
                .hasNoImpact();

        LessonAssignment weightedFirst = lesson("c", "lp3", "c3", "math", List.of("t1"), slot("1-1", 1, 1));
        LessonAssignment weightedSecond = lesson("d", "lp4", "c4", "science", List.of("t1"), slot("1-2", 1, 2));
        weightedFirst.setTeacherLoadBalanceWeight(3);
        weightedSecond.setTeacherLoadBalanceWeight(3);

        constraintVerifier.verifyThat(TimetableConstraintProvider::teacherDailyLoad)
                .given(weightedFirst, weightedSecond)
                .penalizesBy(3);
    }

    @Test
    void teacherDailyLoadVarianceHonorsBalanceWeight() {
        List<LessonAssignment> disabled = sameDayTeacherLessons("disabled", "t1", 0);

        constraintVerifier.verifyThat(TimetableConstraintProvider::teacherDailyLoadVariance)
                .given(disabled.toArray())
                .hasNoImpact();

        List<LessonAssignment> weighted = sameDayTeacherLessons("weighted", "t1", 3);

        constraintVerifier.verifyThat(TimetableConstraintProvider::teacherDailyLoadVariance)
                .given(weighted.toArray())
                .penalizesBy(6);
    }

    @Test
    void sameCourseHalfDaySplitPenalizesSameClassSubjectAcrossMorningAndAfternoon() {
        LessonAssignment morning = lesson("a", "lp1", "c1", "math", List.of("t1"), slot("1-2", 1, 2, true));
        LessonAssignment afternoon = lesson("b", "lp1", "c1", "math", List.of("t2"), slot("1-5", 1, 5, false));

        constraintVerifier.verifyThat(TimetableConstraintProvider::sameCourseHalfDaySplit)
                .given(morning, afternoon)
                .penalizesBy(5);
    }

    @Test
    void scopedSubjectSpreadOnlyPenalizesAssignmentsWithTheSameInjectedRule() {
        LessonAssignment first = lesson("a", "lp1", "c1", "math", List.of("t1"), slot("1-1", 1, 1));
        LessonAssignment second = lesson("b", "lp2", "c1", "math", List.of("t1"), slot("1-2", 1, 2));
        LessonAssignment outsideScope = lesson("c", "lp3", "c2", "math", List.of("t2"), slot("1-3", 1, 3));
        first.setAdvancedRules(List.of(advancedRule("scope-g7-1", "subject.spread")));
        second.setAdvancedRules(List.of(advancedRule("scope-g7-1", "subject.spread")));

        constraintVerifier.verifyThat(TimetableConstraintProvider::advancedPairSoftRules)
                .given(first, second)
                .penalizesBy(32);
        constraintVerifier.verifyThat(TimetableConstraintProvider::advancedPairSoftRules)
                .given(first, outsideScope)
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

    private static List<LessonAssignment> sameDayTeacherLessons(String prefix, String teacherId, int weight) {
        return List.of(
                weightedLesson(prefix + "-1", "lp1", "c1", teacherId, slot("1-1", 1, 1), weight),
                weightedLesson(prefix + "-2", "lp2", "c2", teacherId, slot("1-2", 1, 2), weight),
                weightedLesson(prefix + "-3", "lp3", "c3", teacherId, slot("1-3", 1, 3), weight),
                weightedLesson(prefix + "-4", "lp4", "c4", teacherId, slot("1-4", 1, 4), weight),
                weightedLesson(prefix + "-5", "lp5", "c5", teacherId, slot("1-5", 1, 5), weight));
    }

    private static LessonAssignment weightedLesson(String id, String planId, String classId, String teacherId,
                                                   TimeSlot slot, int weight) {
        LessonAssignment assignment = lesson(id, planId, classId, "math", List.of(teacherId), slot);
        assignment.setTeacherLoadBalanceWeight(weight);
        setTeacherConstraintRefs(assignment, List.of(teacherRef(teacherId, 99, 5, weight)));
        return assignment;
    }

    private static LessonAssignment.TeacherConstraintRef teacherRef(String teacherId, int weeklyMax,
                                                                    int maxDays, int loadBalanceWeight) {
        LessonAssignment.TeacherConstraintRef ref = new LessonAssignment.TeacherConstraintRef();
        ref.setTeacherId(teacherId);
        ref.setWeeklyMax(weeklyMax);
        ref.setMaxDays(maxDays);
        ref.setLoadBalanceWeight(loadBalanceWeight);
        return ref;
    }

    private static LessonAssignment.AdvancedRuleRef advancedRule(String id, String type) {
        LessonAssignment.AdvancedRuleRef ref = new LessonAssignment.AdvancedRuleRef();
        ref.setId(id);
        ref.setType(type);
        ref.setHard(false);
        return ref;
    }

    private static void setTeacherConstraintRefs(LessonAssignment assignment,
                                                 List<LessonAssignment.TeacherConstraintRef> refs) {
        assignment.setTeacherConstraintRefs(refs);
    }

    private static TimeSlot slot(String id, int weekday, int lessonIndex) {
        return slot(id, weekday, lessonIndex, lessonIndex <= 2);
    }

    private static TimeSlot slot(String id, int weekday, int lessonIndex, boolean morning) {
        TimeSlot slot = new TimeSlot();
        slot.setId(id);
        slot.setWeekday(weekday);
        slot.setLessonIndex(lessonIndex);
        slot.setMorning(morning);
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
