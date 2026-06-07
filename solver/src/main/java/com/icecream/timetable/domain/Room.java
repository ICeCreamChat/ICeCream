package com.icecream.timetable.domain;

import ai.timefold.solver.core.api.domain.common.PlanningId;
import com.fasterxml.jackson.annotation.JsonIdentityInfo;
import com.fasterxml.jackson.annotation.ObjectIdGenerators;

@JsonIdentityInfo(scope = Room.class, generator = ObjectIdGenerators.PropertyGenerator.class, property = "id")
public class Room {

    public static final String NONE_ID = "__NONE__";

    @PlanningId
    private String id;
    private String name;
    private boolean none;

    public Room() {
    }

    public Room(String id, String name, boolean none) {
        this.id = id;
        this.name = name;
        this.none = none;
    }

    public static Room none() {
        return new Room(NONE_ID, "None", true);
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

    public boolean isNone() {
        return none;
    }

    public void setNone(boolean none) {
        this.none = none;
    }

    @Override
    public String toString() {
        return id;
    }
}
