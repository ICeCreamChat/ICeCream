package com.icecream.seating.domain;

import ai.timefold.solver.core.api.domain.solution.PlanningEntityCollectionProperty;
import ai.timefold.solver.core.api.domain.solution.PlanningScore;
import ai.timefold.solver.core.api.domain.solution.PlanningSolution;
import ai.timefold.solver.core.api.domain.solution.ProblemFactCollectionProperty;
import ai.timefold.solver.core.api.domain.valuerange.ValueRangeProvider;
import ai.timefold.solver.core.api.score.HardSoftScore;

import java.util.ArrayList;
import java.util.List;

@PlanningSolution
public class SeatingSolution {

    private String jobId;
    private String name;

    @ProblemFactCollectionProperty
    @ValueRangeProvider(id = "seatRange")
    private List<Seat> seats = new ArrayList<>();

    @PlanningEntityCollectionProperty
    private List<StudentAssignment> students = new ArrayList<>();

    private SeatingConstraintConfig config = new SeatingConstraintConfig();

    @PlanningScore
    private HardSoftScore score;

    private String solverStatus;

    public SeatingSolution() {
    }

    public String getJobId() {
        return jobId;
    }

    public void setJobId(String jobId) {
        this.jobId = jobId;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public List<Seat> getSeats() {
        return seats;
    }

    public void setSeats(List<Seat> seats) {
        this.seats = seats == null ? new ArrayList<>() : seats;
    }

    public List<StudentAssignment> getStudents() {
        return students;
    }

    public void setStudents(List<StudentAssignment> students) {
        this.students = students == null ? new ArrayList<>() : students;
    }

    public SeatingConstraintConfig getConfig() {
        return config;
    }

    public void setConfig(SeatingConstraintConfig config) {
        this.config = config == null ? new SeatingConstraintConfig() : config;
    }

    public HardSoftScore getScore() {
        return score;
    }

    public void setScore(HardSoftScore score) {
        this.score = score;
    }

    public Long getHardScore() {
        return score == null ? null : score.hardScore();
    }

    public Long getSoftScore() {
        return score == null ? null : score.softScore();
    }

    public String getSolverStatus() {
        return solverStatus;
    }

    public void setSolverStatus(String solverStatus) {
        this.solverStatus = solverStatus;
    }
}
