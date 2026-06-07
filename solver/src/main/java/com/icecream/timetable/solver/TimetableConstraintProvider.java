package com.icecream.timetable.solver;

import ai.timefold.solver.core.api.score.HardSoftScore;
import ai.timefold.solver.core.api.score.stream.Constraint;
import ai.timefold.solver.core.api.score.stream.ConstraintFactory;
import ai.timefold.solver.core.api.score.stream.ConstraintProvider;
import ai.timefold.solver.core.api.score.stream.Joiners;
import com.icecream.timetable.domain.LessonAssignment;

public class TimetableConstraintProvider implements ConstraintProvider {

    @Override
    public Constraint[] defineConstraints(ConstraintFactory factory) {
        return new Constraint[] {
                classConflict(factory),
                teacherConflict(factory),
                pinnedTime(factory),
                blockedTime(factory),
                roomRequirement(factory),
                roomConflict(factory),
                consecutiveBlock(factory),
                spreadSameCourse(factory),
                avoidAdjacentSameCourse(factory),
                mainSubjectsEarlier(factory),
                practicalSubjectsLater(factory),
                teacherDailyLoad(factory),
                classDailyLoad(factory),
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
}
