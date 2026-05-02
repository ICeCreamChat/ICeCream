package com.icecream.seating.domain;

import ai.timefold.solver.core.api.domain.lookup.PlanningId;
import com.fasterxml.jackson.annotation.JsonIdentityInfo;
import com.fasterxml.jackson.annotation.ObjectIdGenerators;

import java.util.LinkedHashSet;
import java.util.Set;

@JsonIdentityInfo(scope = Seat.class, generator = ObjectIdGenerators.PropertyGenerator.class, property = "id")
public class Seat {

    @PlanningId
    private String id;
    private int row;
    private int col;
    private int qualityScore;
    private Integer groupId;
    private Set<String> neighborSeatIds = new LinkedHashSet<>();

    public Seat() {
    }

    public Seat(String id, int row, int col, int qualityScore, Integer groupId, Set<String> neighborSeatIds) {
        this.id = id;
        this.row = row;
        this.col = col;
        this.qualityScore = qualityScore;
        this.groupId = groupId;
        this.neighborSeatIds = neighborSeatIds == null ? new LinkedHashSet<>() : new LinkedHashSet<>(neighborSeatIds);
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public int getRow() {
        return row;
    }

    public void setRow(int row) {
        this.row = row;
    }

    public int getCol() {
        return col;
    }

    public void setCol(int col) {
        this.col = col;
    }

    public int getQualityScore() {
        return qualityScore;
    }

    public void setQualityScore(int qualityScore) {
        this.qualityScore = qualityScore;
    }

    public Integer getGroupId() {
        return groupId;
    }

    public void setGroupId(Integer groupId) {
        this.groupId = groupId;
    }

    public Set<String> getNeighborSeatIds() {
        return neighborSeatIds;
    }

    public void setNeighborSeatIds(Set<String> neighborSeatIds) {
        this.neighborSeatIds = neighborSeatIds == null ? new LinkedHashSet<>() : new LinkedHashSet<>(neighborSeatIds);
    }

    public boolean isNeighbor(Seat other) {
        return other != null && neighborSeatIds != null && neighborSeatIds.contains(other.getId());
    }
}
