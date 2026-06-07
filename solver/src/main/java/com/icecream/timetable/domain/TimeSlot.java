package com.icecream.timetable.domain;

import ai.timefold.solver.core.api.domain.common.PlanningId;
import com.fasterxml.jackson.annotation.JsonIdentityInfo;
import com.fasterxml.jackson.annotation.ObjectIdGenerators;

@JsonIdentityInfo(scope = TimeSlot.class, generator = ObjectIdGenerators.PropertyGenerator.class, property = "id")
public class TimeSlot {

    @PlanningId
    private String id;
    private int weekday;
    private int lessonIndex;
    private boolean morning;

    public TimeSlot() {
    }

    public TimeSlot(String id, int weekday, int lessonIndex, boolean morning) {
        this.id = id;
        this.weekday = weekday;
        this.lessonIndex = lessonIndex;
        this.morning = morning;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public int getWeekday() {
        return weekday;
    }

    public void setWeekday(int weekday) {
        this.weekday = weekday;
    }

    public int getLessonIndex() {
        return lessonIndex;
    }

    public void setLessonIndex(int lessonIndex) {
        this.lessonIndex = lessonIndex;
    }

    public boolean isMorning() {
        return morning;
    }

    public void setMorning(boolean morning) {
        this.morning = morning;
    }

    public boolean isAdjacentTo(TimeSlot other) {
        return other != null
                && weekday == other.weekday
                && Math.abs(lessonIndex - other.lessonIndex) == 1;
    }

    @Override
    public String toString() {
        return id;
    }
}
