package com.icecream.timetable.domain;

import java.util.List;
import java.util.Map;

public class TimetableSolverJob {

    private String jobId;
    private String name;
    private Long hardScore;
    private Long softScore;
    private String score;
    private String solverStatus;
    private int assignmentCount;
    private String stage;
    private Long elapsedMs;
    private boolean initialized;
    private List<Map<String, Object>> constraintAnalysis = List.of();
    private Map<String, Object> failureSummary = Map.of();

    public TimetableSolverJob() {
    }

    public TimetableSolverJob(String jobId, String name, Long hardScore, Long softScore,
                              String score, String solverStatus, int assignmentCount) {
        this.jobId = jobId;
        this.name = name;
        this.hardScore = hardScore;
        this.softScore = softScore;
        this.score = score;
        this.solverStatus = solverStatus;
        this.assignmentCount = assignmentCount;
    }

    public static TimetableSolverJob fromSolution(String jobId, TimetableSolution solution, String solverStatus) {
        return new TimetableSolverJob(
                jobId,
                solution == null ? null : solution.getName(),
                solution == null ? null : solution.getHardScore(),
                solution == null ? null : solution.getSoftScore(),
                solution == null || solution.getScore() == null ? null : solution.getScore().toString(),
                solverStatus,
                solution == null || solution.getLessonAssignments() == null ? 0 : solution.getLessonAssignments().size()
        );
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

    public Long getHardScore() {
        return hardScore;
    }

    public void setHardScore(Long hardScore) {
        this.hardScore = hardScore;
    }

    public Long getSoftScore() {
        return softScore;
    }

    public void setSoftScore(Long softScore) {
        this.softScore = softScore;
    }

    public String getScore() {
        return score;
    }

    public void setScore(String score) {
        this.score = score;
    }

    public String getSolverStatus() {
        return solverStatus;
    }

    public void setSolverStatus(String solverStatus) {
        this.solverStatus = solverStatus;
    }

    public int getAssignmentCount() {
        return assignmentCount;
    }

    public void setAssignmentCount(int assignmentCount) {
        this.assignmentCount = assignmentCount;
    }

    public String getStage() {
        return stage;
    }

    public void setStage(String stage) {
        this.stage = stage;
    }

    public Long getElapsedMs() {
        return elapsedMs;
    }

    public void setElapsedMs(Long elapsedMs) {
        this.elapsedMs = elapsedMs;
    }

    public boolean isInitialized() {
        return initialized;
    }

    public void setInitialized(boolean initialized) {
        this.initialized = initialized;
    }

    public List<Map<String, Object>> getConstraintAnalysis() {
        return constraintAnalysis;
    }

    public void setConstraintAnalysis(List<Map<String, Object>> constraintAnalysis) {
        this.constraintAnalysis = constraintAnalysis == null ? List.of() : List.copyOf(constraintAnalysis);
    }

    public Map<String, Object> getFailureSummary() {
        return failureSummary;
    }

    public void setFailureSummary(Map<String, Object> failureSummary) {
        this.failureSummary = failureSummary == null ? Map.of() : Map.copyOf(failureSummary);
    }
}
