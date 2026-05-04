package com.icecream.seating.solver;

import ai.timefold.solver.test.api.score.stream.ConstraintVerifier;
import com.icecream.seating.domain.Seat;
import com.icecream.seating.domain.SeatingConstraintConfig;
import com.icecream.seating.domain.SeatingSolution;
import com.icecream.seating.domain.StudentAssignment;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

class SeatingConstraintProviderTest {

    private final ConstraintVerifier<SeatingConstraintProvider, SeatingSolution> constraintVerifier =
            ConstraintVerifier.build(new SeatingConstraintProvider(), SeatingSolution.class, StudentAssignment.class);

    @Test
    void seatConflictPenalizesTwoStudentsOnSameSeat() {
        Seat seat = seat("r0c0", 0, 0, 80, 1, Set.of());
        StudentAssignment left = student("s01", seat);
        StudentAssignment right = student("s02", seat);

        constraintVerifier.verifyThat(SeatingConstraintProvider::seatConflict)
                .given(left, right)
                .penalizesBy(1);
    }

    @Test
    void pairRequiresSameGroupWhenBothSeatsHaveGroups() {
        StudentAssignment left = student("s01", seat("r0c0", 0, 0, 80, 1, Set.of()));
        StudentAssignment right = student("s02", seat("r0c1", 0, 1, 80, 2, Set.of("r0c0")));
        left.setMustPairWith(List.of("s02"));

        constraintVerifier.verifyThat(SeatingConstraintProvider::pairNotSameGroup)
                .given(left, right)
                .penalizesBy(1);
    }

    @Test
    void pairWithoutGroupsFallsBackToNeighborSeats() {
        StudentAssignment left = student("s01", seat("r0c0", 0, 0, 80, null, Set.of()));
        StudentAssignment right = student("s02", seat("r0c2", 0, 2, 80, null, Set.of()));
        left.setMustPairWith(List.of("s02"));

        constraintVerifier.verifyThat(SeatingConstraintProvider::pairNotSameGroup)
                .given(left, right)
                .penalizesBy(1);

        left.setSeat(seat("r0c0", 0, 0, 80, null, Set.of("r0c1")));
        right.setSeat(seat("r0c1", 0, 1, 80, null, Set.of("r0c0")));
        constraintVerifier.verifyThat(SeatingConstraintProvider::pairNotSameGroup)
                .given(left, right)
                .hasNoImpact();
    }

    @Test
    void avoidAdjacentUsesNeighborSeatIds() {
        StudentAssignment left = student("s01", seat("r0c0", 0, 0, 80, 1, Set.of("r0c1")));
        StudentAssignment right = student("s02", seat("r0c1", 0, 1, 80, 2, Set.of("r0c0")));
        left.setMustAvoidAdjacent(List.of("s02"));

        constraintVerifier.verifyThat(SeatingConstraintProvider::avoidAdjacent)
                .given(left, right)
                .penalizesBy(1);
    }

    @Test
    void frontAndBackThresholdsAreHardConstraints() {
        SeatingConstraintConfig config = new SeatingConstraintConfig();
        config.setFrontRowThreshold(1);
        config.setBackRowThreshold(3);
        StudentAssignment front = student("s01", seat("r2c0", 2, 0, 80, 1, Set.of()));
        front.setMustFrontRow(true);
        front.setConfig(config);
        StudentAssignment back = student("s02", seat("r2c1", 2, 1, 80, 1, Set.of()));
        back.setMustBackRow(true);
        back.setConfig(config);

        constraintVerifier.verifyThat(SeatingConstraintProvider::frontRowViolation)
                .given(front)
                .penalizesBy(1);
        constraintVerifier.verifyThat(SeatingConstraintProvider::backRowViolation)
                .given(back)
                .penalizesBy(1);
    }

    @Test
    void avoidRowConstraintsAreHardConstraints() {
        SeatingConstraintConfig config = new SeatingConstraintConfig();
        config.setFirstRow(0);
        config.setLastRow(3);
        config.setFrontRowThreshold(1);
        config.setBackRowThreshold(2);
        StudentAssignment first = student("s01", seat("r0c0", 0, 0, 80, 1, Set.of()));
        first.setMustAvoidFirstRow(true);
        first.setConfig(config);
        StudentAssignment last = student("s02", seat("r3c0", 3, 0, 80, 1, Set.of()));
        last.setMustAvoidLastRow(true);
        last.setConfig(config);
        StudentAssignment front = student("s03", seat("r1c0", 1, 0, 80, 1, Set.of()));
        front.setMustAvoidFrontRow(true);
        front.setConfig(config);
        StudentAssignment back = student("s04", seat("r2c0", 2, 0, 80, 1, Set.of()));
        back.setMustAvoidBackRow(true);
        back.setConfig(config);

        constraintVerifier.verifyThat(SeatingConstraintProvider::avoidFirstRowViolation)
                .given(first)
                .penalizesBy(1);
        constraintVerifier.verifyThat(SeatingConstraintProvider::avoidLastRowViolation)
                .given(last)
                .penalizesBy(1);
        constraintVerifier.verifyThat(SeatingConstraintProvider::avoidFrontRowViolation)
                .given(front)
                .penalizesBy(1);
        constraintVerifier.verifyThat(SeatingConstraintProvider::avoidBackRowViolation)
                .given(back)
                .penalizesBy(1);
    }

    @Test
    void avoidBehindOnlyPenalizesTargetBehindRelatedStudent() {
        StudentAssignment target = student("s01", seat("r2c0", 2, 0, 80, 1, Set.of()));
        StudentAssignment related = student("s02", seat("r1c0", 1, 0, 80, 1, Set.of()));
        target.setMustAvoidBehind(List.of("s02"));

        constraintVerifier.verifyThat(SeatingConstraintProvider::avoidBehindViolation)
                .given(target, related)
                .penalizesBy(1);

        target.setSeat(seat("r0c0", 0, 0, 80, 1, Set.of()));
        constraintVerifier.verifyThat(SeatingConstraintProvider::avoidBehindViolation)
                .given(target, related)
                .hasNoImpact();
    }

    @Test
    void frontMiddlePreferencesAreSoftConstraints() {
        SeatingConstraintConfig config = new SeatingConstraintConfig();
        config.setFrontRowThreshold(1);
        config.setFrontMidRowThreshold(2);
        config.setMiddleColStart(1);
        config.setMiddleColEnd(2);
        StudentAssignment frontMiddle = student("s01", seat("r2c0", 2, 0, 80, 1, Set.of()));
        frontMiddle.setPreferFrontMiddle(true);
        frontMiddle.setConfig(config);
        StudentAssignment frontMid = student("s02", seat("r3c1", 3, 1, 80, 1, Set.of()));
        frontMid.setPreferFrontMidRows(true);
        frontMid.setConfig(config);

        constraintVerifier.verifyThat(SeatingConstraintProvider::preferFrontMiddle)
                .given(frontMiddle)
                .penalizesBy(1);
        constraintVerifier.verifyThat(SeatingConstraintProvider::preferFrontMidRows)
                .given(frontMid)
                .penalizesBy(1);
    }

    @Test
    void heightOrderPenalizesTallStudentsInFrontRegardlessOfPairOrder() {
        SeatingConstraintConfig config = new SeatingConstraintConfig();
        config.setHeightOrderEnabled(true);
        StudentAssignment back = student("s01", seat("r1c0", 1, 0, 80, 1, Set.of()));
        back.setHeight(150);
        back.setConfig(config);
        StudentAssignment front = student("s02", seat("r0c0", 0, 0, 80, 1, Set.of()));
        front.setHeight(170);
        front.setConfig(config);

        constraintVerifier.verifyThat(SeatingConstraintProvider::heightOrder)
                .given(back, front)
                .penalizesBy(config.getHeightOrderWeight());
    }

    private static StudentAssignment student(String id, Seat seat) {
        StudentAssignment student = new StudentAssignment(id, id);
        student.setSeat(seat);
        return student;
    }

    private static Seat seat(String id, int row, int col, int qualityScore, Integer groupId, Set<String> neighbors) {
        return new Seat(id, row, col, qualityScore, groupId, neighbors);
    }
}
