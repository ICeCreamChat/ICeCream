package com.icecream.timetable.domain;

import ai.timefold.solver.core.api.domain.common.PlanningId;
import ai.timefold.solver.core.api.domain.entity.PlanningEntity;
import ai.timefold.solver.core.api.domain.variable.PlanningVariable;
import com.fasterxml.jackson.annotation.JsonIdentityReference;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

@PlanningEntity
public class LessonAssignment {

    @PlanningId
    private String id;
    private String lessonPlanId;
    private int sequence;
    private String classId;
    private String subjectId;
    private String teacherId;
    private List<String> teacherIds = new ArrayList<>();
    private String pinnedTimeSlotId;
    private List<String> blockedTimeSlotIds = new ArrayList<>();
    private List<String> allowedRoomIds = new ArrayList<>();
    private boolean requiresRoom;
    private String blockId;
    private int blockIndex;
    private int blockSize = 1;
    private int subjectPriority = 50;
    private boolean preferMorning;
    private boolean preferLater;

    @PlanningVariable(valueRangeProviderRefs = "timeSlotRange")
    @JsonIdentityReference(alwaysAsId = true)
    private TimeSlot timeSlot;

    @PlanningVariable(valueRangeProviderRefs = "roomRange")
    @JsonIdentityReference(alwaysAsId = true)
    private Room room;

    public LessonAssignment() {
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getLessonPlanId() {
        return lessonPlanId;
    }

    public void setLessonPlanId(String lessonPlanId) {
        this.lessonPlanId = lessonPlanId;
    }

    public int getSequence() {
        return sequence;
    }

    public void setSequence(int sequence) {
        this.sequence = sequence;
    }

    public String getClassId() {
        return classId;
    }

    public void setClassId(String classId) {
        this.classId = classId;
    }

    public String getSubjectId() {
        return subjectId;
    }

    public void setSubjectId(String subjectId) {
        this.subjectId = subjectId;
    }

    public String getTeacherId() {
        return teacherId;
    }

    public void setTeacherId(String teacherId) {
        this.teacherId = teacherId;
    }

    public List<String> getTeacherIds() {
        if ((teacherIds == null || teacherIds.isEmpty()) && hasText(teacherId)) {
            return List.of(teacherId);
        }
        return teacherIds == null ? List.of() : teacherIds;
    }

    public void setTeacherIds(List<String> teacherIds) {
        this.teacherIds = teacherIds == null ? new ArrayList<>() : new ArrayList<>(teacherIds);
    }

    public String getPinnedTimeSlotId() {
        return pinnedTimeSlotId;
    }

    public void setPinnedTimeSlotId(String pinnedTimeSlotId) {
        this.pinnedTimeSlotId = pinnedTimeSlotId;
    }

    public List<String> getBlockedTimeSlotIds() {
        return blockedTimeSlotIds == null ? List.of() : blockedTimeSlotIds;
    }

    public void setBlockedTimeSlotIds(List<String> blockedTimeSlotIds) {
        this.blockedTimeSlotIds = blockedTimeSlotIds == null ? new ArrayList<>() : new ArrayList<>(blockedTimeSlotIds);
    }

    public List<String> getAllowedRoomIds() {
        return allowedRoomIds == null ? List.of() : allowedRoomIds;
    }

    public void setAllowedRoomIds(List<String> allowedRoomIds) {
        this.allowedRoomIds = allowedRoomIds == null ? new ArrayList<>() : new ArrayList<>(allowedRoomIds);
    }

    public boolean isRequiresRoom() {
        return requiresRoom;
    }

    public void setRequiresRoom(boolean requiresRoom) {
        this.requiresRoom = requiresRoom;
    }

    public String getBlockId() {
        return blockId;
    }

    public void setBlockId(String blockId) {
        this.blockId = blockId;
    }

    public int getBlockIndex() {
        return blockIndex;
    }

    public void setBlockIndex(int blockIndex) {
        this.blockIndex = blockIndex;
    }

    public int getBlockSize() {
        return blockSize;
    }

    public void setBlockSize(int blockSize) {
        this.blockSize = Math.max(1, blockSize);
    }

    public int getSubjectPriority() {
        return subjectPriority;
    }

    public void setSubjectPriority(int subjectPriority) {
        this.subjectPriority = subjectPriority;
    }

    public boolean isPreferMorning() {
        return preferMorning;
    }

    public void setPreferMorning(boolean preferMorning) {
        this.preferMorning = preferMorning;
    }

    public boolean isPreferLater() {
        return preferLater;
    }

    public void setPreferLater(boolean preferLater) {
        this.preferLater = preferLater;
    }

    public TimeSlot getTimeSlot() {
        return timeSlot;
    }

    public void setTimeSlot(TimeSlot timeSlot) {
        this.timeSlot = timeSlot;
    }

    public Room getRoom() {
        return room;
    }

    public void setRoom(Room room) {
        this.room = room;
    }

    public boolean sharesClassWith(LessonAssignment other) {
        return other != null && hasText(classId) && classId.equals(other.getClassId());
    }

    public boolean sharesTeacherWith(LessonAssignment other) {
        if (other == null) {
            return false;
        }
        Set<String> mine = new HashSet<>(getTeacherIds());
        mine.remove("");
        mine.remove(null);
        mine.retainAll(other.getTeacherIds());
        return !mine.isEmpty();
    }

    public boolean isPinnedTimeSatisfied() {
        return !hasText(pinnedTimeSlotId)
                || (timeSlot != null && pinnedTimeSlotId.equals(timeSlot.getId()));
    }

    public boolean isAllowedTime() {
        return timeSlot != null && !getBlockedTimeSlotIds().contains(timeSlot.getId());
    }

    public boolean isAllowedRoom() {
        if (requiresRoom) {
            return room != null && !room.isNone() && getAllowedRoomIds().contains(room.getId());
        }
        return room == null || room.isNone();
    }

    public boolean sameBlockAs(LessonAssignment other) {
        return other != null
                && blockSize > 1
                && hasText(blockId)
                && blockId.equals(other.getBlockId());
    }

    public boolean consecutiveBlockViolation(LessonAssignment other) {
        if (!sameBlockAs(other) || timeSlot == null || other.getTimeSlot() == null) {
            return false;
        }
        int expectedDelta = other.getBlockIndex() - blockIndex;
        return timeSlot.getWeekday() != other.getTimeSlot().getWeekday()
                || timeSlot.getLessonIndex() + expectedDelta != other.getTimeSlot().getLessonIndex();
    }

    public boolean sameClassSubjectDay(LessonAssignment other) {
        return other != null
                && timeSlot != null
                && other.getTimeSlot() != null
                && timeSlot.getWeekday() == other.getTimeSlot().getWeekday()
                && sharesClassWith(other)
                && hasText(subjectId)
                && subjectId.equals(other.getSubjectId())
                && !sameBlockAs(other);
    }

    public boolean adjacentSameClassSubject(LessonAssignment other) {
        return sameClassSubjectDay(other) && timeSlot.isAdjacentTo(other.getTimeSlot());
    }

    public boolean sameTeacherDay(LessonAssignment other) {
        return other != null
                && timeSlot != null
                && other.getTimeSlot() != null
                && timeSlot.getWeekday() == other.getTimeSlot().getWeekday()
                && sharesTeacherWith(other);
    }

    public int earlierSubjectPenalty() {
        if (timeSlot == null || (!preferMorning && subjectPriority < 90)) {
            return 0;
        }
        if (timeSlot.isMorning()) {
            return Math.max(0, timeSlot.getLessonIndex() - 2);
        }
        return 8 + Math.max(0, timeSlot.getLessonIndex() - 2);
    }

    public int laterSubjectPenalty() {
        return timeSlot != null && preferLater && timeSlot.isMorning() ? 6 : 0;
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }
}
