package com.icecream.timetable.solver;

import ai.timefold.solver.core.api.score.HardSoftScore;
import ai.timefold.solver.core.api.score.stream.Constraint;
import ai.timefold.solver.core.api.score.stream.ConstraintFactory;
import ai.timefold.solver.core.api.score.stream.ConstraintProvider;
import ai.timefold.solver.core.api.score.stream.Joiners;
import com.icecream.timetable.domain.LessonAssignment;
import com.icecream.timetable.domain.ChineseCurriculumContext;

public class TimetableConstraintProvider implements ConstraintProvider {

    private final ChineseCurriculumContext chineseContext;
    private final ChineseEducationConstraints chineseConstraints;

    public TimetableConstraintProvider() {
        this.chineseContext = new ChineseCurriculumContext();
        this.chineseConstraints = new ChineseEducationConstraints(chineseContext);
    }

    @Override
    public Constraint[] defineConstraints(ConstraintFactory factory) {
        return new Constraint[] {
                // 基础硬约束
                classConflict(factory),
                teacherConflict(factory),
                pinnedTime(factory),
                blockedTime(factory),
                roomRequirement(factory),
                roomConflict(factory),
                consecutiveBlock(factory),

                // 基础软约束
                spreadSameCourse(factory),
                avoidAdjacentSameCourse(factory),
                mainSubjectsEarlier(factory),
                practicalSubjectsLater(factory),
                teacherDailyLoad(factory),
                classDailyLoad(factory),
                teacherLunchBridge(factory),
                teacherGap(factory),
                sameCourseHalfDaySplit(factory),

                // 中国教育场景专用约束
                chineseConstraints.mainSubjectGoldenHourPreference(factory),
                chineseConstraints.sportsClassDistribution(factory),
                chineseConstraints.teacherContinuousTeachingLimit(factory),
                chineseConstraints.afternoonFatigueAvoidance(factory),
                chineseConstraints.laboratoryRoomRequirement(factory),
                chineseConstraints.sameSubjectPreparationTimeGap(factory),
                chineseConstraints.teacherDailyLoadVarianceMinimization(factory),
                chineseConstraints.walkingClassTimeAlignment(factory),
        };
    }

    Constraint classConflict(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class,
                        Joiners.equal(LessonAssignment::getTimeSlot))
                .filter((left, right) -> left.getTimeSlot() != null && left.sharesClassWith(right))
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Class conflict");
    }

    Constraint teacherConflict(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class,
                        Joiners.equal(LessonAssignment::getTimeSlot))
                .filter((left, right) -> left.getTimeSlot() != null && left.sharesTeacherWith(right))
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Teacher conflict");
    }

    Constraint pinnedTime(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> !lesson.isPinnedTimeSatisfied())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Pinned time");
    }

    Constraint blockedTime(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> !lesson.isAllowedTime())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Blocked time");
    }

    Constraint roomRequirement(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> !lesson.isAllowedRoom())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Room requirement");
    }

    Constraint roomConflict(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class,
                        Joiners.equal(LessonAssignment::getTimeSlot),
                        Joiners.equal(LessonAssignment::getRoom))
                .filter((left, right) -> left.getTimeSlot() != null
                        && left.getRoom() != null
                        && !left.getRoom().isNone())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Room conflict");
    }

    Constraint consecutiveBlock(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class)
                .filter(LessonAssignment::consecutiveBlockViolation)
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Consecutive block");
    }

    Constraint spreadSameCourse(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class)
                .filter(LessonAssignment::sameClassSubjectDay)
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> 4)
                .asConstraint("Spread same course");
    }

    Constraint avoidAdjacentSameCourse(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class)
                .filter(LessonAssignment::adjacentSameClassSubject)
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> 6)
                .asConstraint("Avoid adjacent same course");
    }

    Constraint mainSubjectsEarlier(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> lesson.earlierSubjectPenalty() > 0)
                .penalize(HardSoftScore.ONE_SOFT, LessonAssignment::earlierSubjectPenalty)
                .asConstraint("Main subjects earlier");
    }

    Constraint practicalSubjectsLater(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> lesson.laterSubjectPenalty() > 0)
                .penalize(HardSoftScore.ONE_SOFT, LessonAssignment::laterSubjectPenalty)
                .asConstraint("Practical subjects later");
    }

    Constraint teacherDailyLoad(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class)
                .filter(LessonAssignment::sameTeacherDay)
                .penalize(HardSoftScore.ONE_SOFT)
                .asConstraint("Teacher daily load");
    }

    Constraint classDailyLoad(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class)
                .filter((left, right) -> left.getTimeSlot() != null
                        && right.getTimeSlot() != null
                        && left.getTimeSlot().getWeekday() == right.getTimeSlot().getWeekday()
                        && left.sharesClassWith(right))
                .penalize(HardSoftScore.ONE_SOFT)
                .asConstraint("Class daily load");
    }

    Constraint teacherLunchBridge(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class)
                .filter(TimetableConstraintProvider::isTeacherLunchBridge)
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> 4)
                .asConstraint("Teacher lunch bridge");
    }

    Constraint teacherGap(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class)
                .filter((left, right) -> teacherGapPenalty(left, right) > 0)
                .penalize(HardSoftScore.ONE_SOFT, TimetableConstraintProvider::teacherGapPenalty)
                .asConstraint("Teacher gap");
    }

    Constraint sameCourseHalfDaySplit(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class)
                .filter(TimetableConstraintProvider::isSameCourseHalfDaySplit)
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> 5)
                .asConstraint("Same course half-day split");
    }

    private static boolean isTeacherLunchBridge(LessonAssignment left, LessonAssignment right) {
        return left.sameTeacherDay(right)
                && left.getTimeSlot().isMorning() != right.getTimeSlot().isMorning()
                && Math.abs(left.getTimeSlot().getLessonIndex() - right.getTimeSlot().getLessonIndex()) == 1;
    }

    private static int teacherGapPenalty(LessonAssignment left, LessonAssignment right) {
        if (!left.sameTeacherDay(right)
                || left.getTimeSlot().isMorning() != right.getTimeSlot().isMorning()) {
            return 0;
        }
        int gap = Math.abs(left.getTimeSlot().getLessonIndex() - right.getTimeSlot().getLessonIndex()) - 1;
        return Math.max(0, gap * 2);
    }

    private static boolean isSameCourseHalfDaySplit(LessonAssignment left, LessonAssignment right) {
        return left.sameClassSubjectDay(right)
                && left.getTimeSlot().isMorning() != right.getTimeSlot().isMorning();
    }
}
