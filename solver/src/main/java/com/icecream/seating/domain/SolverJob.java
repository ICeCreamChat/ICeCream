package com.icecream.seating.domain;

public class SolverJob {

    private String jobId;
    private String name;
    private Long hardScore;
    private Long softScore;
    private String score;
    private String solverStatus;

    public SolverJob() {
    }

    public SolverJob(String jobId, String name, Long hardScore, Long softScore, String score, String solverStatus) {
        this.jobId = jobId;
        this.name = name;
        this.hardScore = hardScore;
        this.softScore = softScore;
        this.score = score;
        this.solverStatus = solverStatus;
    }

    public static SolverJob fromSolution(String jobId, SeatingSolution solution, String solverStatus) {
        return new SolverJob(
                jobId,
                solution == null ? null : solution.getName(),
                solution == null ? null : solution.getHardScore(),
                solution == null ? null : solution.getSoftScore(),
                solution == null || solution.getScore() == null ? null : solution.getScore().toString(),
                solverStatus
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
}
