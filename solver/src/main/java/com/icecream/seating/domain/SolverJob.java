package com.icecream.seating.domain;

public class SolverJob {

    private String jobId;
    private String name;
    private Integer hardScore;
    private Integer softScore;
    private String score;
    private String solverStatus;

    public SolverJob() {
    }

    public SolverJob(String jobId, String name, Integer hardScore, Integer softScore, String score, String solverStatus) {
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
}
