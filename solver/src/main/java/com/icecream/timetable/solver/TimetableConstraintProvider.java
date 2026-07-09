package com.icecream.timetable.solver;

import ai.timefold.solver.core.api.score.HardSoftScore;
import ai.timefold.solver.core.api.score.stream.Constraint;
import ai.timefold.solver.core.api.score.stream.ConstraintCollectors;
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
                subjectDailyLimit(factory),
                teacherWeeklyLimit(factory),
                teacherMaxDaysPerWeek(factory),
                teacherMutualExclusion(factory),
                subjectNotSameDay(factory),

                // 基础软约束
                spreadSameCourse(factory),
                avoidAdjacentSameCourse(factory),
                mainSubjectsEarlier(factory),
                practicalSubjectsLater(factory),
                teacherDailyLoad(factory),
                classDailyLoad(factory),
                classMainDailyLimit(factory),
                teacherLunchBridge(factory),
                teacherGap(factory),
                subjectSequence(factory),
                sameCourseHalfDaySplit(factory),

                // 中国教育场景专用约束
                chineseConstraints.mainSubjectGoldenHourPreference(factory),
                chineseConstraints.sportsClassDistribution(factory),
                chineseConstraints.teacherContinuousTeachingLimit(factory),
                chineseConstraints.afternoonFatigueAvoidance(factory),
                chineseConstraints.laboratoryRoomRequirement(factory),
                chineseConstraints.sameSubjectPreparationTimeGap(factory),
                teacherDailyLoadVariance(factory),
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
                .filter((left, right) -> left.spreadSameCoursePenalty(right) > 0)
                .penalize(HardSoftScore.ONE_SOFT, LessonAssignment::spreadSameCoursePenalty)
                .asConstraint("Spread same course");
    }

    Constraint subjectDailyLimit(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> lesson.getTimeSlot() != null && lesson.getSubjectDailyMax() > 0)
                .groupBy(LessonAssignment::classSubjectDayKey,
                        LessonAssignment::getSubjectDailyMax,
                        ConstraintCollectors.count())
                .filter((key, max, count) -> key != null && count > max)
                .penalize(HardSoftScore.ONE_HARD, (key, max, count) -> count - max)
                .asConstraint("Subject daily limit");
    }

    Constraint teacherWeeklyLimit(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> lesson.getTimeSlot() != null)
                .flatten(LessonAssignment::getTeacherConstraintRefs)
                .filter((lesson, ref) -> hasTeacherRef(ref) && ref.getWeeklyMax() > 0)
                .groupBy((lesson, ref) -> ref.getTeacherId(),
                        (lesson, ref) -> ref.getWeeklyMax(),
                        ConstraintCollectors.countBi())
                .filter((teacherId, max, count) -> teacherId != null && count > max)
                .penalize(HardSoftScore.ONE_HARD, (teacherId, max, count) -> count.longValue() - max)
                .asConstraint("Teacher weekly limit");
    }

    Constraint teacherMaxDaysPerWeek(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> lesson.getTimeSlot() != null)
                .flatten(LessonAssignment::getTeacherConstraintRefs)
                .filter((lesson, ref) -> hasTeacherRef(ref) && ref.getMaxDays() > 0)
                .groupBy((lesson, ref) -> ref.getTeacherId(),
                        (lesson, ref) -> ref.getMaxDays(),
                        ConstraintCollectors.countDistinct((lesson, ref) -> lesson.getTimeSlot().getWeekday()))
                .filter((teacherId, max, count) -> teacherId != null && count > max)
                .penalize(HardSoftScore.ONE_HARD, (teacherId, max, count) -> count.longValue() - max)
                .asConstraint("Teacher max days per week");
    }

    Constraint teacherMutualExclusion(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class,
                        Joiners.equal(LessonAssignment::getTimeSlot))
                .filter((left, right) -> left.getTimeSlot() != null && left.sharesMutualExclusionGroup(right))
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Teacher mutual exclusion");
    }

    Constraint subjectNotSameDay(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class)
                .filter((left, right) -> left.violatesNotSameDay(right) || right.violatesNotSameDay(left))
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Subject not same day");
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
                .filter((left, right) -> left.sameTeacherDay(right) && teacherLoadBalancePairWeight(left, right) > 0)
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> teacherLoadBalancePairWeight(left, right))
                .asConstraint("Teacher daily load");
    }

    Constraint teacherDailyLoadVariance(ConstraintFactory factory) {
        return chineseConstraints.teacherDailyLoadVarianceMinimization(factory);
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

    Constraint classMainDailyLimit(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> lesson.getTimeSlot() != null
                        && lesson.getClassMainDailyMax() > 0
                        && lesson.getSubjectPriority() >= 80)
                .groupBy(lesson -> lesson.getClassId() + "|" + lesson.getTimeSlot().getWeekday(),
                        LessonAssignment::getClassMainDailyMax,
                        ConstraintCollectors.count())
                .filter((key, max, count) -> count > max)
                .penalize(HardSoftScore.ONE_SOFT, (key, max, count) -> count - max)
                .asConstraint("Class main subject daily limit");
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
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> {
                    int weight = Math.max(left.getTeacherGapWeight(), right.getTeacherGapWeight());
                    return teacherGapPenalty(left, right) * Math.max(1, weight);
                })
                .asConstraint("Teacher gap");
    }

    Constraint subjectSequence(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class)
                .filter((left, right) -> left.subjectSequencePenalty(right) + right.subjectSequencePenalty(left) > 0)
                .penalize(HardSoftScore.ONE_SOFT,
                        (left, right) -> left.subjectSequencePenalty(right) + right.subjectSequencePenalty(left))
                .asConstraint("Subject sequence");
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

    private static int teacherLoadBalancePairWeight(LessonAssignment left, LessonAssignment right) {
        return Math.max(left.getTeacherLoadBalanceWeight(), right.getTeacherLoadBalanceWeight());
    }

    private static boolean hasTeacherRef(LessonAssignment.TeacherConstraintRef ref) {
        return ref != null && ref.getTeacherId() != null && !ref.getTeacherId().isBlank();
    }

    private static boolean isSameCourseHalfDaySplit(LessonAssignment left, LessonAssignment right) {
        return left.sameClassSubjectDay(right)
                && left.getTimeSlot().isMorning() != right.getTimeSlot().isMorning();
    }
}
