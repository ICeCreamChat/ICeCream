package com.icecream.seating.domain;

public class SeatingConstraintConfig {

    private int frontRowThreshold = 0;
    private int backRowThreshold = Integer.MAX_VALUE;
    private int firstRow = 0;
    private int lastRow = Integer.MAX_VALUE;
    private int frontMidRowThreshold = 0;
    private int middleColStart = 0;
    private int middleColEnd = Integer.MAX_VALUE;
    private boolean genderBalanceEnabled = false;
    private boolean heightOrderEnabled = false;
    private String gradeStrategy = "none";
    private int seatQualityByGradeWeight = 4;
    private int genderBalanceWeight = 2;
    private int heightOrderWeight = 3;
    private int gradeBalanceWeight = 5;
    private int preferAdjacentWeight = 3;

    public int getFrontRowThreshold() {
        return frontRowThreshold;
    }

    public void setFrontRowThreshold(int frontRowThreshold) {
        this.frontRowThreshold = frontRowThreshold;
    }

    public int getBackRowThreshold() {
        return backRowThreshold;
    }

    public void setBackRowThreshold(int backRowThreshold) {
        this.backRowThreshold = backRowThreshold;
    }

    public int getFirstRow() {
        return firstRow;
    }

    public void setFirstRow(int firstRow) {
        this.firstRow = firstRow;
    }

    public int getLastRow() {
        return lastRow;
    }

    public void setLastRow(int lastRow) {
        this.lastRow = lastRow;
    }

    public int getFrontMidRowThreshold() {
        return frontMidRowThreshold;
    }

    public void setFrontMidRowThreshold(int frontMidRowThreshold) {
        this.frontMidRowThreshold = frontMidRowThreshold;
    }

    public int getMiddleColStart() {
        return middleColStart;
    }

    public void setMiddleColStart(int middleColStart) {
        this.middleColStart = middleColStart;
    }

    public int getMiddleColEnd() {
        return middleColEnd;
    }

    public void setMiddleColEnd(int middleColEnd) {
        this.middleColEnd = middleColEnd;
    }

    public boolean isGenderBalanceEnabled() {
        return genderBalanceEnabled;
    }

    public void setGenderBalanceEnabled(boolean genderBalanceEnabled) {
        this.genderBalanceEnabled = genderBalanceEnabled;
    }

    public boolean isHeightOrderEnabled() {
        return heightOrderEnabled;
    }

    public void setHeightOrderEnabled(boolean heightOrderEnabled) {
        this.heightOrderEnabled = heightOrderEnabled;
    }

    public String getGradeStrategy() {
        return gradeStrategy;
    }

    public void setGradeStrategy(String gradeStrategy) {
        this.gradeStrategy = gradeStrategy == null || gradeStrategy.isBlank() ? "none" : gradeStrategy;
    }

    public int getSeatQualityByGradeWeight() {
        return seatQualityByGradeWeight;
    }

    public void setSeatQualityByGradeWeight(int seatQualityByGradeWeight) {
        this.seatQualityByGradeWeight = seatQualityByGradeWeight;
    }

    public int getGenderBalanceWeight() {
        return genderBalanceWeight;
    }

    public void setGenderBalanceWeight(int genderBalanceWeight) {
        this.genderBalanceWeight = genderBalanceWeight;
    }

    public int getHeightOrderWeight() {
        return heightOrderWeight;
    }

    public void setHeightOrderWeight(int heightOrderWeight) {
        this.heightOrderWeight = heightOrderWeight;
    }

    public int getGradeBalanceWeight() {
        return gradeBalanceWeight;
    }

    public void setGradeBalanceWeight(int gradeBalanceWeight) {
        this.gradeBalanceWeight = gradeBalanceWeight;
    }

    public int getPreferAdjacentWeight() {
        return preferAdjacentWeight;
    }

    public void setPreferAdjacentWeight(int preferAdjacentWeight) {
        this.preferAdjacentWeight = preferAdjacentWeight;
    }

    public boolean isGradePriorityEnabled() {
        return "priority".equals(gradeStrategy);
    }

    public boolean isGradeBalanceEnabled() {
        return "balance".equals(gradeStrategy);
    }
}
