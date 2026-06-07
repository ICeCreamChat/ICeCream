package com.icecream.seating.domain;

import ai.timefold.solver.core.api.domain.entity.PlanningEntity;
import ai.timefold.solver.core.api.domain.common.PlanningId;
import ai.timefold.solver.core.api.domain.variable.PlanningVariable;
import com.fasterxml.jackson.annotation.JsonIdentityReference;
import com.fasterxml.jackson.annotation.JsonIgnore;

import java.util.ArrayList;
import java.util.List;

@PlanningEntity
public class StudentAssignment {

    @PlanningId
    private String id;
    private String name;
    private String gender;
    private Integer grade;
    private Integer height;
    private boolean mustFrontRow;
    private boolean mustBackRow;
    private boolean mustAvoidFirstRow;
    private boolean mustAvoidLastRow;
    private boolean mustAvoidFrontRow;
    private boolean mustAvoidBackRow;
    private List<String> mustAvoidBehind = new ArrayList<>();
    private boolean preferFrontMiddle;
    private boolean preferFrontMidRows;
    private List<String> mustPairWith = new ArrayList<>();
    private List<String> mustAvoidAdjacent = new ArrayList<>();
    private List<String> preferAdjacent = new ArrayList<>();

    @JsonIgnore
    private SeatingConstraintConfig config = new SeatingConstraintConfig();

    @PlanningVariable(valueRangeProviderRefs = "seatRange")
    @JsonIdentityReference(alwaysAsId = true)
    private Seat seat;

    public StudentAssignment() {
    }

    public StudentAssignment(String id, String name) {
        this.id = id;
        this.name = name;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getGender() {
        return gender;
    }

    public void setGender(String gender) {
        this.gender = gender;
    }

    public Integer getGrade() {
        return grade;
    }

    public void setGrade(Integer grade) {
        this.grade = grade;
    }

    public Integer getHeight() {
        return height;
    }

    public void setHeight(Integer height) {
        this.height = height;
    }

    public boolean isMustFrontRow() {
        return mustFrontRow;
    }

    public void setMustFrontRow(boolean mustFrontRow) {
        this.mustFrontRow = mustFrontRow;
    }

    public boolean isMustBackRow() {
        return mustBackRow;
    }

    public void setMustBackRow(boolean mustBackRow) {
        this.mustBackRow = mustBackRow;
    }

    public boolean isMustAvoidFirstRow() {
        return mustAvoidFirstRow;
    }

    public void setMustAvoidFirstRow(boolean mustAvoidFirstRow) {
        this.mustAvoidFirstRow = mustAvoidFirstRow;
    }

    public boolean isMustAvoidLastRow() {
        return mustAvoidLastRow;
    }

    public void setMustAvoidLastRow(boolean mustAvoidLastRow) {
        this.mustAvoidLastRow = mustAvoidLastRow;
    }

    public boolean isMustAvoidFrontRow() {
        return mustAvoidFrontRow;
    }

    public void setMustAvoidFrontRow(boolean mustAvoidFrontRow) {
        this.mustAvoidFrontRow = mustAvoidFrontRow;
    }

    public boolean isMustAvoidBackRow() {
        return mustAvoidBackRow;
    }

    public void setMustAvoidBackRow(boolean mustAvoidBackRow) {
        this.mustAvoidBackRow = mustAvoidBackRow;
    }

    public List<String> getMustAvoidBehind() {
        return mustAvoidBehind;
    }

    public void setMustAvoidBehind(List<String> mustAvoidBehind) {
        this.mustAvoidBehind = mustAvoidBehind == null ? new ArrayList<>() : new ArrayList<>(mustAvoidBehind);
    }

    public boolean isPreferFrontMiddle() {
        return preferFrontMiddle;
    }

    public void setPreferFrontMiddle(boolean preferFrontMiddle) {
        this.preferFrontMiddle = preferFrontMiddle;
    }

    public boolean isPreferFrontMidRows() {
        return preferFrontMidRows;
    }

    public void setPreferFrontMidRows(boolean preferFrontMidRows) {
        this.preferFrontMidRows = preferFrontMidRows;
    }

    public List<String> getMustPairWith() {
        return mustPairWith;
    }

    public void setMustPairWith(List<String> mustPairWith) {
        this.mustPairWith = mustPairWith == null ? new ArrayList<>() : new ArrayList<>(mustPairWith);
    }

    public List<String> getMustAvoidAdjacent() {
        return mustAvoidAdjacent;
    }

    public void setMustAvoidAdjacent(List<String> mustAvoidAdjacent) {
        this.mustAvoidAdjacent = mustAvoidAdjacent == null ? new ArrayList<>() : new ArrayList<>(mustAvoidAdjacent);
    }

    public List<String> getPreferAdjacent() {
        return preferAdjacent;
    }

    public void setPreferAdjacent(List<String> preferAdjacent) {
        this.preferAdjacent = preferAdjacent == null ? new ArrayList<>() : new ArrayList<>(preferAdjacent);
    }

    public Seat getSeat() {
        return seat;
    }

    public void setSeat(Seat seat) {
        this.seat = seat;
    }

    public SeatingConstraintConfig getConfig() {
        return config;
    }

    public void setConfig(SeatingConstraintConfig config) {
        this.config = config == null ? new SeatingConstraintConfig() : config;
    }

    public boolean mustPairWith(StudentAssignment other) {
        return other != null && mustPairWith != null && mustPairWith.contains(other.getId());
    }

    public boolean mustAvoidAdjacent(StudentAssignment other) {
        return other != null && mustAvoidAdjacent != null && mustAvoidAdjacent.contains(other.getId());
    }

    public boolean mustAvoidBehind(StudentAssignment other) {
        return other != null && mustAvoidBehind != null && mustAvoidBehind.contains(other.getId());
    }

    public boolean prefersAdjacent(StudentAssignment other) {
        return other != null && preferAdjacent != null && preferAdjacent.contains(other.getId());
    }
}
