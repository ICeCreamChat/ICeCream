package com.icecream.timetable.domain;

public class TimetableSolverJob {

    private String jobId;
    private String name;
    private Integer hardScore;
    private Integer softScore;
    private String score;
    private String solverStatus;
    private int assignmentCount;

    public TimetableSolverJob() {
    }

    public TimetableSolverJob(String jobId, String name, Integer hardScore, Integer softScore,
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

    public Integer getHardScore() {
        return hardScore;
    }

    public void setHardScore(Integer hardScore) {
        this.hardScore = hardScore;
    }

    public Integer getSoftScore() {
        return softScore;
    }

    public void setSoftScore(Integer softScore) {
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
}
