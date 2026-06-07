package com.icecream.seating.solver;

import ai.timefold.solver.core.api.score.HardSoftScore;
import ai.timefold.solver.core.api.score.stream.Constraint;
import ai.timefold.solver.core.api.score.stream.ConstraintFactory;
import ai.timefold.solver.core.api.score.stream.ConstraintProvider;
import ai.timefold.solver.core.api.score.stream.Joiners;
import com.icecream.seating.domain.Seat;
import com.icecream.seating.domain.SeatingConstraintConfig;
import com.icecream.seating.domain.StudentAssignment;

import java.util.Objects;

public class SeatingConstraintProvider implements ConstraintProvider {

    @Override
    public Constraint[] defineConstraints(ConstraintFactory constraintFactory) {
        return new Constraint[] {
                seatConflict(constraintFactory),
                pairNotSameGroup(constraintFactory),
                frontRowViolation(constraintFactory),
                backRowViolation(constraintFactory),
                avoidFirstRowViolation(constraintFactory),
                avoidLastRowViolation(constraintFactory),
                avoidFrontRowViolation(constraintFactory),
                avoidBackRowViolation(constraintFactory),
                avoidBehindViolation(constraintFactory),
                preferFrontMiddle(constraintFactory),
                preferFrontMidRows(constraintFactory),
                avoidAdjacent(constraintFactory),
                preferAdjacent(constraintFactory),
                seatQualityByGrade(constraintFactory),
                genderBalance(constraintFactory),
                heightOrder(constraintFactory),
                gradeBalance(constraintFactory),
        };
    }

    Constraint seatConflict(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEachUniquePair(StudentAssignment.class, Joiners.equal(StudentAssignment::getSeat))
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Seat conflict");
    }

    Constraint pairNotSameGroup(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEachUniquePair(StudentAssignment.class)
                .filter((left, right) -> left.mustPairWith(right) || right.mustPairWith(left))
                .filter((left, right) -> !pairSatisfied(left.getSeat(), right.getSeat()))
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Pair not same group");
    }

    Constraint frontRowViolation(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEach(StudentAssignment.class)
                .filter(student -> student.isMustFrontRow()
                        && student.getSeat() != null
                        && student.getSeat().getRow() > config(student).getFrontRowThreshold())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Front row violation");
    }

    Constraint backRowViolation(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEach(StudentAssignment.class)
                .filter(student -> student.isMustBackRow()
                        && student.getSeat() != null
                        && student.getSeat().getRow() < config(student).getBackRowThreshold())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Back row violation");
    }

    Constraint avoidFirstRowViolation(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEach(StudentAssignment.class)
                .filter(student -> student.isMustAvoidFirstRow()
                        && student.getSeat() != null
                        && student.getSeat().getRow() == config(student).getFirstRow())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Avoid first row violation");
    }

    Constraint avoidLastRowViolation(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEach(StudentAssignment.class)
                .filter(student -> student.isMustAvoidLastRow()
                        && student.getSeat() != null
                        && student.getSeat().getRow() == config(student).getLastRow())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Avoid last row violation");
    }

    Constraint avoidFrontRowViolation(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEach(StudentAssignment.class)
                .filter(student -> student.isMustAvoidFrontRow()
                        && student.getSeat() != null
                        && student.getSeat().getRow() <= config(student).getFrontRowThreshold())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Avoid front row violation");
    }

    Constraint avoidBackRowViolation(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEach(StudentAssignment.class)
                .filter(student -> student.isMustAvoidBackRow()
                        && student.getSeat() != null
                        && student.getSeat().getRow() >= config(student).getBackRowThreshold())
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Avoid back row violation");
    }

    Constraint avoidBehindViolation(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEachUniquePair(StudentAssignment.class)
                .filter((left, right) -> behindViolation(left, right) || behindViolation(right, left))
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Avoid behind violation");
    }

    Constraint preferFrontMiddle(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEach(StudentAssignment.class)
                .filter(student -> student.isPreferFrontMiddle()
                        && student.getSeat() != null
                        && !frontMiddleSatisfied(student))
                .penalize(HardSoftScore.ONE_SOFT)
                .asConstraint("Prefer front middle");
    }

    Constraint preferFrontMidRows(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEach(StudentAssignment.class)
                .filter(student -> student.isPreferFrontMidRows()
                        && student.getSeat() != null
                        && student.getSeat().getRow() > config(student).getFrontMidRowThreshold())
                .penalize(HardSoftScore.ONE_SOFT)
                .asConstraint("Prefer front mid rows");
    }

    Constraint avoidAdjacent(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEachUniquePair(StudentAssignment.class)
                .filter((left, right) -> left.mustAvoidAdjacent(right) || right.mustAvoidAdjacent(left))
                .filter((left, right) -> neighbors(left.getSeat(), right.getSeat()))
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Avoid adjacent");
    }

    Constraint preferAdjacent(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEachUniquePair(StudentAssignment.class)
                .filter((left, right) -> left.prefersAdjacent(right) || right.prefersAdjacent(left))
                .filter((left, right) -> !neighbors(left.getSeat(), right.getSeat()))
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> config(left).getPreferAdjacentWeight())
                .asConstraint("Prefer adjacent");
    }

    Constraint seatQualityByGrade(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEach(StudentAssignment.class)
                .filter(student -> config(student).isGradePriorityEnabled()
                        && finiteGrade(student)
                        && student.getGrade() >= 85
                        && student.getSeat() != null
                        && student.getSeat().getQualityScore() < 70)
                .penalize(HardSoftScore.ONE_SOFT, student -> config(student).getSeatQualityByGradeWeight()
                        * (70 - student.getSeat().getQualityScore()))
                .asConstraint("Seat quality by grade");
    }

    Constraint genderBalance(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEachUniquePair(StudentAssignment.class)
                .filter((left, right) -> config(left).isGenderBalanceEnabled()
                        && left.getSeat() != null
                        && right.getSeat() != null
                        && left.getSeat().getRow() == right.getSeat().getRow()
                        && sameKnownGender(left, right))
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> config(left).getGenderBalanceWeight())
                .asConstraint("Gender balance");
    }

    Constraint heightOrder(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEachUniquePair(StudentAssignment.class)
                .filter((left, right) -> config(left).isHeightOrderEnabled()
                        && (heightOrderViolation(left, right) || heightOrderViolation(right, left)))
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> config(left).getHeightOrderWeight())
                .asConstraint("Height order");
    }

    Constraint gradeBalance(ConstraintFactory constraintFactory) {
        return constraintFactory
                .forEachUniquePair(StudentAssignment.class)
                .filter((left, right) -> config(left).isGradeBalanceEnabled()
                        && left.getSeat() != null
                        && right.getSeat() != null
                        && left.getSeat().getRow() == right.getSeat().getRow()
                        && finiteGrade(left)
                        && finiteGrade(right)
                        && Math.abs(left.getGrade() - right.getGrade()) > 20)
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> config(left).getGradeBalanceWeight())
                .asConstraint("Grade balance");
    }

    private static boolean pairSatisfied(Seat left, Seat right) {
        if (left == null || right == null) return false;
        if (left.getGroupId() != null && right.getGroupId() != null) {
            return Objects.equals(left.getGroupId(), right.getGroupId());
        }
        return neighbors(left, right);
    }

    private static boolean neighbors(Seat left, Seat right) {
        return left != null && right != null && (left.isNeighbor(right) || right.isNeighbor(left));
    }

    private static boolean behindViolation(StudentAssignment target, StudentAssignment related) {
        return target.mustAvoidBehind(related)
                && target.getSeat() != null
                && related.getSeat() != null
                && target.getSeat().getRow() > related.getSeat().getRow();
    }

    private static boolean frontMiddleSatisfied(StudentAssignment student) {
        SeatingConstraintConfig config = config(student);
        Seat seat = student.getSeat();
        return seat.getRow() <= config.getFrontRowThreshold()
                && seat.getCol() >= config.getMiddleColStart()
                && seat.getCol() <= config.getMiddleColEnd();
    }

    private static boolean rowBefore(Seat left, Seat right) {
        return left.getRow() < right.getRow();
    }

    private static boolean heightOrderViolation(StudentAssignment frontCandidate, StudentAssignment backCandidate) {
        return frontCandidate.getSeat() != null
                && backCandidate.getSeat() != null
                && frontCandidate.getHeight() != null
                && backCandidate.getHeight() != null
                && rowBefore(frontCandidate.getSeat(), backCandidate.getSeat())
                && frontCandidate.getHeight() > backCandidate.getHeight() + 3;
    }

    private static boolean finiteGrade(StudentAssignment student) {
        return student.getGrade() != null;
    }

    private static boolean sameKnownGender(StudentAssignment left, StudentAssignment right) {
        return left.getGender() != null
                && !left.getGender().isBlank()
                && left.getGender().equals(right.getGender());
    }

    private static SeatingConstraintConfig config(StudentAssignment ignored) {
        return ignored.getConfig() == null ? new SeatingConstraintConfig() : ignored.getConfig();
    }
}
