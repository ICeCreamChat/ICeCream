package com.icecream.timetable.domain;

import ai.timefold.solver.core.api.domain.solution.PlanningEntityCollectionProperty;
import ai.timefold.solver.core.api.domain.solution.PlanningScore;
import ai.timefold.solver.core.api.domain.solution.PlanningSolution;
import ai.timefold.solver.core.api.domain.solution.ProblemFactCollectionProperty;
import ai.timefold.solver.core.api.domain.valuerange.ValueRangeProvider;
import ai.timefold.solver.core.api.score.HardSoftScore;

import java.util.ArrayList;
import java.util.List;

@PlanningSolution
public class TimetableSolution {

    private String jobId;
    private String name;

    @ProblemFactCollectionProperty
    @ValueRangeProvider(id = "timeSlotRange")
    private List<TimeSlot> timeSlots = new ArrayList<>();

    @ProblemFactCollectionProperty
    @ValueRangeProvider(id = "roomRange")
    private List<Room> rooms = new ArrayList<>();

    @PlanningEntityCollectionProperty
    private List<LessonAssignment> lessonAssignments = new ArrayList<>();

    @PlanningScore
    private HardSoftScore score;

    private String solverStatus;

    public TimetableSolution() {
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

    public List<TimeSlot> getTimeSlots() {
        return timeSlots;
    }

    public void setTimeSlots(List<TimeSlot> timeSlots) {
        this.timeSlots = timeSlots == null ? new ArrayList<>() : timeSlots;
    }

    public List<Room> getRooms() {
        return rooms;
    }

    public void setRooms(List<Room> rooms) {
        this.rooms = rooms == null ? new ArrayList<>() : rooms;
    }

    public List<LessonAssignment> getLessonAssignments() {
        return lessonAssignments;
    }

    public void setLessonAssignments(List<LessonAssignment> lessonAssignments) {
        this.lessonAssignments = lessonAssignments == null ? new ArrayList<>() : lessonAssignments;
    }

    public HardSoftScore getScore() {
        return score;
    }

    public void setScore(HardSoftScore score) {
        this.score = score;
    }

    public Integer getHardScore() {
        return score == null ? null : score.hardScore();
    }

    public Integer getSoftScore() {
        return score == null ? null : score.softScore();
    }

    public String getSolverStatus() {
        return solverStatus;
    }

    public void setSolverStatus(String solverStatus) {
        this.solverStatus = solverStatus;
    }
}
