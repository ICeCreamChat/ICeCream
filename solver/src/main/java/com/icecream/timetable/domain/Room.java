package com.icecream.timetable.domain;

import ai.timefold.solver.core.api.domain.common.PlanningId;
import com.fasterxml.jackson.annotation.JsonIdentityInfo;
import com.fasterxml.jackson.annotation.ObjectIdGenerators;

import java.util.ArrayList;
import java.util.List;

@JsonIdentityInfo(scope = Room.class, generator = ObjectIdGenerators.PropertyGenerator.class, property = "id")
public class Room {

    public static final String NONE_ID = "__NONE__";

    @PlanningId
    private String id;
    private String name;
    private boolean none;
    private List<String> tags = new ArrayList<>();

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

    public List<String> getTags() {
        return tags == null ? List.of() : tags;
    }

    public void setTags(List<String> tags) {
        this.tags = tags == null ? new ArrayList<>() : new ArrayList<>(tags);
    }

    public boolean hasNormalizedTag(String expected) {
        String wanted = normalizeTag(expected);
        return getTags().stream().map(Room::normalizeTag).anyMatch(wanted::equals);
    }

    private static String normalizeTag(String value) {
        String key = value == null ? "" : value.trim().toLowerCase().replaceAll("[\\s_-]+", "");
        if (key.contains("普通教室") || key.contains("ordinary")) return "ordinaryclassroom";
        if (key.contains("计算机") || key.contains("机房") || key.contains("computer")) return "computerroom";
        if (key.contains("实验") || key.contains("lab")) return "lab";
        return key;
    }

    @Override
    public String toString() {
        return id;
    }
}
