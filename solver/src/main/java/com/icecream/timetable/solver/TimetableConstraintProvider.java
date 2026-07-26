package com.icecream.timetable.solver;

import ai.timefold.solver.core.api.score.HardSoftScore;
import ai.timefold.solver.core.api.score.stream.Constraint;
import ai.timefold.solver.core.api.score.stream.ConstraintCollectors;
import ai.timefold.solver.core.api.score.stream.ConstraintFactory;
import ai.timefold.solver.core.api.score.stream.ConstraintProvider;
import ai.timefold.solver.core.api.score.stream.Joiners;
import com.icecream.timetable.domain.LessonAssignment;
import com.icecream.timetable.domain.SchedulingUnit;

public class TimetableConstraintProvider implements ConstraintProvider {

    @Override
    public Constraint[] defineConstraints(ConstraintFactory factory) {
        return new Constraint[] {
                unassignedUnit(factory),
                classConflict(factory),
                teacherConflict(factory),
                mixedTeamTeacherConflict(factory),
                pinnedTime(factory),
                blockedTime(factory),
                roomRequirement(factory),
                roomConflict(factory),
                subjectDailyLimit(factory),
                teacherWeeklyLimit(factory),
                teacherMaxDaysPerWeek(factory),
                teacherMutualExclusion(factory),
                subjectNotSameDay(factory),
                advancedHardRules(factory),
                advancedPairHardRules(factory),

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
                advancedSoftRules(factory),
                advancedPairSoftRules(factory),
                teacherDailyLoadVariance(factory),
        };
    }

    Constraint unassignedUnit(ConstraintFactory factory) {
        return factory.forEachIncludingUnassigned(SchedulingUnit.class)
                .filter(unit -> unit.getPlacement() == null)
                .penalize(HardSoftScore.ONE_HARD, unit -> 10)
                .asConstraint("Unassigned scheduling unit");
    }

    Constraint classConflict(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class,
                        Joiners.equal(SchedulingUnit::getClassId))
                .filter(SchedulingUnit::overlaps)
                .penalize(HardSoftScore.ONE_HARD, SchedulingUnit::overlapCount)
                .asConstraint("Class conflict");
    }

    Constraint teacherConflict(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class,
                        Joiners.equal(SchedulingUnit::getTeacherSetKey))
                .filter((left, right) -> !left.getTeacherSetKey().isBlank() && left.overlaps(right))
                .penalize(HardSoftScore.ONE_HARD, SchedulingUnit::overlapCount)
                .asConstraint("Teacher conflict");
    }

    Constraint mixedTeamTeacherConflict(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class)
                .filter((left, right) -> !left.getTeacherSetKey().equals(right.getTeacherSetKey())
                        && (left.getTeacherIds().size() > 1 || right.getTeacherIds().size() > 1)
                        && left.sharesTeacherWith(right)
                        && left.overlaps(right))
                .penalize(HardSoftScore.ONE_HARD, SchedulingUnit::overlapCount)
                .asConstraint("Mixed-team teacher conflict");
    }

    Constraint pinnedTime(ConstraintFactory factory) {
        return factory.forEach(SchedulingUnit.class)
                .filter(unit -> !unit.isPinnedTimeSatisfied())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Pinned time");
    }

    Constraint blockedTime(ConstraintFactory factory) {
        return factory.forEach(SchedulingUnit.class)
                .filter(unit -> !unit.isAllowedTime())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Blocked time");
    }

    Constraint roomRequirement(ConstraintFactory factory) {
        return factory.forEach(SchedulingUnit.class)
                .filter(unit -> !unit.isAllowedRoom())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Room requirement");
    }

    Constraint roomConflict(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class,
                        Joiners.equal(SchedulingUnit::getRoom))
                .filter((left, right) -> left.getRoom() != null && !left.getRoom().isNone() && left.overlaps(right))
                .penalize(HardSoftScore.ONE_HARD, SchedulingUnit::overlapCount)
                .asConstraint("Room conflict");
    }

    Constraint spreadSameCourse(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class,
                        Joiners.equal(SchedulingUnit::getClassId),
                        Joiners.equal(SchedulingUnit::getSubjectId))
                .filter((left, right) -> left.spreadSameCoursePenalty(right) > 0)
                .penalize(HardSoftScore.ONE_SOFT, SchedulingUnit::spreadSameCoursePenalty)
                .asConstraint("Spread same course");
    }

    Constraint subjectDailyLimit(ConstraintFactory factory) {
        return factory.forEach(SchedulingUnit.class)
                .filter(unit -> unit.getStartTimeSlot() != null && unit.getSubjectDailyMax() > 0)
                .groupBy(SchedulingUnit::classSubjectDayKey,
                        SchedulingUnit::getSubjectDailyMax,
                        ConstraintCollectors.sum(SchedulingUnit::getBlockSize))
                .filter((key, max, count) -> key != null && count > max)
                .penalize(HardSoftScore.ONE_HARD, (key, max, count) -> count - max)
                .asConstraint("Subject daily limit");
    }

    Constraint teacherWeeklyLimit(ConstraintFactory factory) {
        return factory.forEach(SchedulingUnit.class)
                .filter(unit -> unit.getStartTimeSlot() != null)
                .flatten(SchedulingUnit::getTeacherConstraintRefsPerLesson)
                .filter((unit, ref) -> hasTeacherRef(ref) && ref.getWeeklyMax() > 0)
                .groupBy((unit, ref) -> ref.getTeacherId(),
                        (unit, ref) -> ref.getWeeklyMax(),
                        ConstraintCollectors.countBi())
                .filter((teacherId, max, count) -> teacherId != null && count > max)
                .penalize(HardSoftScore.ONE_HARD, (teacherId, max, count) -> count - max)
                .asConstraint("Teacher weekly limit");
    }

    Constraint teacherMaxDaysPerWeek(ConstraintFactory factory) {
        return factory.forEach(SchedulingUnit.class)
                .filter(unit -> unit.getStartTimeSlot() != null)
                .flatten(SchedulingUnit::getTeacherConstraintRefsPerLesson)
                .filter((unit, ref) -> hasTeacherRef(ref) && ref.getMaxDays() > 0)
                .groupBy((unit, ref) -> ref.getTeacherId(),
                        (unit, ref) -> ref.getMaxDays(),
                        ConstraintCollectors.countDistinct((unit, ref) -> unit.getStartTimeSlot().getWeekday()))
                .filter((teacherId, max, count) -> teacherId != null && count > max)
                .penalize(HardSoftScore.ONE_HARD, (teacherId, max, count) -> count.longValue() - max)
                .asConstraint("Teacher max days per week");
    }

    Constraint teacherMutualExclusion(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class)
                .filter((left, right) -> left.sharesMutualExclusionGroup(right) && left.overlaps(right))
                .penalize(HardSoftScore.ONE_HARD, SchedulingUnit::overlapCount)
                .asConstraint("Teacher mutual exclusion");
    }

    Constraint subjectNotSameDay(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class,
                        Joiners.equal(SchedulingUnit::getClassId))
                .filter((left, right) -> left.violatesNotSameDay(right) || right.violatesNotSameDay(left))
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Subject not same day");
    }

    Constraint advancedHardRules(ConstraintFactory factory) {
        return factory.forEach(SchedulingUnit.class)
                .filter(SchedulingUnit::advancedHardViolation)
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Advanced hard rules");
    }

    Constraint advancedPairHardRules(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class)
                .filter((left, right) -> left.advancedPairHardViolation(right) || right.advancedPairHardViolation(left))
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Advanced pair hard rules");
    }

    Constraint advancedSoftRules(ConstraintFactory factory) {
        return factory.forEach(SchedulingUnit.class)
                .filter(unit -> unit.advancedSoftPenalty() > 0)
                .penalize(HardSoftScore.ONE_SOFT, SchedulingUnit::advancedSoftPenalty)
                .asConstraint("Advanced soft rules");
    }

    Constraint advancedPairSoftRules(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class)
                .filter((left, right) -> left.advancedPairSoftPenalty(right) + right.advancedPairSoftPenalty(left) > 0)
                .penalize(HardSoftScore.ONE_SOFT,
                        (left, right) -> left.advancedPairSoftPenalty(right) + right.advancedPairSoftPenalty(left))
                .asConstraint("Advanced pair soft rules");
    }

    Constraint avoidAdjacentSameCourse(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class,
                        Joiners.equal(SchedulingUnit::getClassId),
                        Joiners.equal(SchedulingUnit::getSubjectId))
                .filter(SchedulingUnit::adjacentSameClassSubject)
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> 6)
                .asConstraint("Avoid adjacent same course");
    }

    Constraint mainSubjectsEarlier(ConstraintFactory factory) {
        return factory.forEach(SchedulingUnit.class)
                .filter(unit -> unit.earlierSubjectPenalty() > 0)
                .penalize(HardSoftScore.ONE_SOFT, SchedulingUnit::earlierSubjectPenalty)
                .asConstraint("Main subjects earlier");
    }

    Constraint practicalSubjectsLater(ConstraintFactory factory) {
        return factory.forEach(SchedulingUnit.class)
                .filter(unit -> unit.laterSubjectPenalty() > 0)
                .penalize(HardSoftScore.ONE_SOFT, SchedulingUnit::laterSubjectPenalty)
                .asConstraint("Practical subjects later");
    }

    Constraint teacherDailyLoad(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class,
                        Joiners.equal(SchedulingUnit::getTeacherId))
                .filter((left, right) -> left.sameTeacherDay(right) && teacherLoadBalancePairWeight(left, right) > 0)
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> teacherLoadBalancePairWeight(left, right)
                        * left.getBlockSize() * right.getBlockSize())
                .asConstraint("Teacher daily load");
    }

    Constraint teacherDailyLoadVariance(ConstraintFactory factory) {
        return factory.forEach(SchedulingUnit.class)
                .filter(unit -> unit.getStartTimeSlot() != null)
                .flatten(SchedulingUnit::getTeacherConstraintRefs)
                .filter((unit, ref) -> hasTeacherRef(ref) && ref.getLoadBalanceWeight() > 0)
                .groupBy((unit, ref) -> ref.getTeacherId(),
                        (unit, ref) -> unit.getStartTimeSlot().getWeekday(),
                        (unit, ref) -> ref.getLoadBalanceWeight(),
                        ConstraintCollectors.countBi())
                .filter((teacherId, weekday, weight, dailyCount) -> dailyCount > 1)
                .penalize(HardSoftScore.ONE_SOFT,
                        (teacherId, weekday, weight, dailyCount) -> (dailyCount.longValue() - 1) * weight)
                .asConstraint("Teacher daily load balance");
    }

    Constraint classDailyLoad(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class,
                        Joiners.equal(SchedulingUnit::getClassId))
                .filter((left, right) -> sameDay(left, right))
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> left.getBlockSize() * right.getBlockSize())
                .asConstraint("Class daily load");
    }

    Constraint classMainDailyLimit(ConstraintFactory factory) {
        return factory.forEach(SchedulingUnit.class)
                .filter(unit -> unit.getStartTimeSlot() != null
                        && unit.getClassMainDailyMax() > 0
                        && unit.getSubjectPriority() >= 80)
                .groupBy(unit -> unit.getClassId() + "|" + unit.getStartTimeSlot().getWeekday(),
                        SchedulingUnit::getClassMainDailyMax,
                        ConstraintCollectors.sum(SchedulingUnit::getBlockSize))
                .filter((key, max, count) -> count > max)
                .penalize(HardSoftScore.ONE_SOFT, (key, max, count) -> count - max)
                .asConstraint("Class main subject daily limit");
    }

    Constraint teacherLunchBridge(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class,
                        Joiners.equal(SchedulingUnit::getTeacherId))
                .filter(TimetableConstraintProvider::isTeacherLunchBridge)
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> 4)
                .asConstraint("Teacher lunch bridge");
    }

    Constraint teacherGap(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class,
                        Joiners.equal(SchedulingUnit::getTeacherId))
                .filter((left, right) -> teacherGapPenalty(left, right) > 0)
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> {
                    int weight = Math.max(left.getTeacherGapWeight(), right.getTeacherGapWeight());
                    return teacherGapPenalty(left, right) * Math.max(1, weight);
                })
                .asConstraint("Teacher gap");
    }

    Constraint subjectSequence(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class,
                        Joiners.equal(SchedulingUnit::getClassId))
                .filter((left, right) -> left.subjectSequencePenalty(right) + right.subjectSequencePenalty(left) > 0)
                .penalize(HardSoftScore.ONE_SOFT,
                        (left, right) -> left.subjectSequencePenalty(right) + right.subjectSequencePenalty(left))
                .asConstraint("Subject sequence");
    }

    Constraint sameCourseHalfDaySplit(ConstraintFactory factory) {
        return factory.forEachUniquePair(SchedulingUnit.class,
                        Joiners.equal(SchedulingUnit::getClassId),
                        Joiners.equal(SchedulingUnit::getSubjectId))
                .filter(TimetableConstraintProvider::isSameCourseHalfDaySplit)
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> 5)
                .asConstraint("Same course half-day split");
    }

    private static boolean sameDay(SchedulingUnit left, SchedulingUnit right) {
        return left.getStartTimeSlot() != null
                && right.getStartTimeSlot() != null
                && left.getStartTimeSlot().getWeekday() == right.getStartTimeSlot().getWeekday();
    }

    private static boolean isTeacherLunchBridge(SchedulingUnit left, SchedulingUnit right) {
        if (!left.sharesTeacherWith(right)) return false;
        for (var leftSlot : left.getTimeSlots()) {
            for (var rightSlot : right.getTimeSlots()) {
                if (leftSlot.getWeekday() == rightSlot.getWeekday()
                        && leftSlot.isMorning() != rightSlot.isMorning()
                        && Math.abs(leftSlot.getLessonIndex() - rightSlot.getLessonIndex()) == 1) {
                    return true;
                }
            }
        }
        return false;
    }

    private static int teacherGapPenalty(SchedulingUnit left, SchedulingUnit right) {
        if (!left.sharesTeacherWith(right)) return 0;
        int penalty = 0;
        for (var leftSlot : left.getTimeSlots()) {
            for (var rightSlot : right.getTimeSlots()) {
                if (leftSlot.getWeekday() != rightSlot.getWeekday()
                        || leftSlot.isMorning() != rightSlot.isMorning()) continue;
                penalty += Math.max(0, Math.abs(leftSlot.getLessonIndex() - rightSlot.getLessonIndex()) - 1) * 2;
            }
        }
        return penalty;
    }

    private static int teacherLoadBalancePairWeight(SchedulingUnit left, SchedulingUnit right) {
        return Math.max(left.getTeacherLoadBalanceWeight(), right.getTeacherLoadBalanceWeight());
    }

    private static boolean hasTeacherRef(LessonAssignment.TeacherConstraintRef ref) {
        return ref != null && ref.getTeacherId() != null && !ref.getTeacherId().isBlank();
    }

    private static boolean isSameCourseHalfDaySplit(SchedulingUnit left, SchedulingUnit right) {
        return sameDay(left, right)
                && left.getStartTimeSlot().isMorning() != right.getStartTimeSlot().isMorning();
    }
}
