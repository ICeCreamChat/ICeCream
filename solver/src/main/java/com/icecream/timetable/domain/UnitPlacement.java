package com.icecream.timetable.domain;

import ai.timefold.solver.core.api.domain.common.PlanningId;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/** A data-derived candidate containing both time occupancy and room choice. */
public final class UnitPlacement {

    @PlanningId
    private String id;
    private List<TimeSlot> timeSlots = new ArrayList<>();
    private Room room;

    public UnitPlacement() {
    }

    public UnitPlacement(String id, List<TimeSlot> timeSlots, Room room) {
        this.id = id;
        this.timeSlots = new ArrayList<>(timeSlots);
        this.room = room;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public List<TimeSlot> getTimeSlots() {
        return timeSlots == null ? List.of() : timeSlots;
    }

    public void setTimeSlots(List<TimeSlot> timeSlots) {
        this.timeSlots = timeSlots == null ? new ArrayList<>() : new ArrayList<>(timeSlots);
    }

    public TimeSlot getStartTimeSlot() {
        return getTimeSlots().isEmpty() ? null : getTimeSlots().getFirst();
    }

    public Room getRoom() {
        return room;
    }

    public void setRoom(Room room) {
        this.room = room;
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof UnitPlacement placement && Objects.equals(id, placement.id);
    }

    @Override
    public int hashCode() {
        return Objects.hashCode(id);
    }

    @Override
    public String toString() {
        return id;
    }
}
