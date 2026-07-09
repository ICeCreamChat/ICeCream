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
    private boolean locked;
    private boolean manuallyAdjusted;
    private List<String> blockedTimeSlotIds = new ArrayList<>();
    private List<String> allowedRoomIds = new ArrayList<>();
    private boolean requiresRoom;
    private String blockId;
    private int blockIndex;
    private int blockSize = 1;
    private int subjectPriority = 50;
    private boolean preferMorning;
    private boolean preferLater;
    private int subjectDailyMax;
    private int teacherWeeklyMax;
    private int teacherMaxDays;
    private List<String> mutualExclusionGroups = new ArrayList<>();
    private List<String> notSameDaySubjectIds = new ArrayList<>();
    private List<SubjectSequenceRule> sequenceRules = new ArrayList<>();
    private int spreadMinGapDays = 1;
    private int classMainDailyMax;
    private int teacherGapWeight;
    private int teacherLoadBalanceWeight = 1;
    private List<TeacherConstraintRef> teacherConstraintRefs = new ArrayList<>();

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

    public boolean isLocked() {
        return locked;
    }

    public void setLocked(boolean locked) {
        this.locked = locked;
    }

    public boolean isManuallyAdjusted() {
        return manuallyAdjusted;
    }

    public void setManuallyAdjusted(boolean manuallyAdjusted) {
        this.manuallyAdjusted = manuallyAdjusted;
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

    public int getSubjectDailyMax() {
        return subjectDailyMax;
    }

    public void setSubjectDailyMax(int subjectDailyMax) {
        this.subjectDailyMax = Math.max(0, subjectDailyMax);
    }

    public int getTeacherWeeklyMax() {
        return teacherWeeklyMax;
    }

    public void setTeacherWeeklyMax(int teacherWeeklyMax) {
        this.teacherWeeklyMax = Math.max(0, teacherWeeklyMax);
    }

    public int getTeacherMaxDays() {
        return teacherMaxDays;
    }

    public void setTeacherMaxDays(int teacherMaxDays) {
        this.teacherMaxDays = Math.max(0, teacherMaxDays);
    }

    public List<String> getMutualExclusionGroups() {
        return mutualExclusionGroups == null ? List.of() : mutualExclusionGroups;
    }

    public void setMutualExclusionGroups(List<String> mutualExclusionGroups) {
        this.mutualExclusionGroups = mutualExclusionGroups == null ? new ArrayList<>() : new ArrayList<>(mutualExclusionGroups);
    }

    public List<String> getNotSameDaySubjectIds() {
        return notSameDaySubjectIds == null ? List.of() : notSameDaySubjectIds;
    }

    public void setNotSameDaySubjectIds(List<String> notSameDaySubjectIds) {
        this.notSameDaySubjectIds = notSameDaySubjectIds == null ? new ArrayList<>() : new ArrayList<>(notSameDaySubjectIds);
    }

    public List<SubjectSequenceRule> getSequenceRules() {
        return sequenceRules == null ? List.of() : sequenceRules;
    }

    public void setSequenceRules(List<SubjectSequenceRule> sequenceRules) {
        this.sequenceRules = sequenceRules == null ? new ArrayList<>() : new ArrayList<>(sequenceRules);
    }

    public int getSpreadMinGapDays() {
        return Math.max(1, spreadMinGapDays);
    }

    public void setSpreadMinGapDays(int spreadMinGapDays) {
        this.spreadMinGapDays = Math.max(1, spreadMinGapDays);
    }

    public int getClassMainDailyMax() {
        return classMainDailyMax;
    }

    public void setClassMainDailyMax(int classMainDailyMax) {
        this.classMainDailyMax = Math.max(0, classMainDailyMax);
    }

    public int getTeacherGapWeight() {
        return teacherGapWeight;
    }

    public void setTeacherGapWeight(int teacherGapWeight) {
        this.teacherGapWeight = Math.max(0, teacherGapWeight);
    }

    public int getTeacherLoadBalanceWeight() {
        return Math.max(0, teacherLoadBalanceWeight);
    }

    public void setTeacherLoadBalanceWeight(int teacherLoadBalanceWeight) {
        this.teacherLoadBalanceWeight = Math.max(0, teacherLoadBalanceWeight);
    }

    public List<TeacherConstraintRef> getTeacherConstraintRefs() {
        if (teacherConstraintRefs != null && !teacherConstraintRefs.isEmpty()) {
            return teacherConstraintRefs;
        }
        List<TeacherConstraintRef> refs = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String id : getTeacherIds()) {
            if (!hasText(id) || !seen.add(id)) {
                continue;
            }
            TeacherConstraintRef ref = new TeacherConstraintRef();
            ref.setTeacherId(id);
            ref.setWeeklyMax(teacherWeeklyMax);
            ref.setMaxDays(teacherMaxDays);
            ref.setLoadBalanceWeight(getTeacherLoadBalanceWeight());
            refs.add(ref);
        }
        return refs;
    }

    public void setTeacherConstraintRefs(List<TeacherConstraintRef> teacherConstraintRefs) {
        this.teacherConstraintRefs = teacherConstraintRefs == null
                ? new ArrayList<>()
                : new ArrayList<>(teacherConstraintRefs);
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

    public String classSubjectDayKey() {
        if (timeSlot == null) {
            return null;
        }
        return classId + "|" + subjectId + "|" + timeSlot.getWeekday();
    }

    public String teacherWeekKey() {
        return hasText(teacherId) ? teacherId : null;
    }

    public String teacherDayKey() {
        if (timeSlot == null || !hasText(teacherId)) {
            return null;
        }
        return teacherId + "|" + timeSlot.getWeekday();
    }

    public boolean adjacentSameClassSubject(LessonAssignment other) {
        return sameClassSubjectDay(other) && timeSlot.isAdjacentTo(other.getTimeSlot());
    }

    public int spreadSameCoursePenalty(LessonAssignment other) {
        if (other == null
                || timeSlot == null
                || other.getTimeSlot() == null
                || !sharesClassWith(other)
                || !hasText(subjectId)
                || !subjectId.equals(other.getSubjectId())
                || sameBlockAs(other)) {
            return 0;
        }
        int minGap = Math.max(getSpreadMinGapDays(), other.getSpreadMinGapDays());
        int dayDistance = Math.abs(timeSlot.getWeekday() - other.getTimeSlot().getWeekday());
        if (dayDistance >= minGap) {
            return 0;
        }
        return Math.max(1, minGap - dayDistance) * 4;
    }

    public boolean sameTeacherDay(LessonAssignment other) {
        return other != null
                && timeSlot != null
                && other.getTimeSlot() != null
                && timeSlot.getWeekday() == other.getTimeSlot().getWeekday()
                && sharesTeacherWith(other);
    }

    public boolean sharesMutualExclusionGroup(LessonAssignment other) {
        if (other == null) {
            return false;
        }
        Set<String> mine = new HashSet<>(getMutualExclusionGroups());
        mine.remove("");
        mine.remove(null);
        mine.retainAll(other.getMutualExclusionGroups());
        return !mine.isEmpty();
    }

    public boolean violatesNotSameDay(LessonAssignment other) {
        return other != null
                && timeSlot != null
                && other.getTimeSlot() != null
                && timeSlot.getWeekday() == other.getTimeSlot().getWeekday()
                && sharesClassWith(other)
                && getNotSameDaySubjectIds().contains(other.getSubjectId());
    }

    public int subjectSequencePenalty(LessonAssignment other) {
        if (other == null
                || timeSlot == null
                || other.getTimeSlot() == null
                || timeSlot.getWeekday() != other.getTimeSlot().getWeekday()
                || !sharesClassWith(other)) {
            return 0;
        }
        int penalty = 0;
        for (SubjectSequenceRule rule : getSequenceRules()) {
            if (rule == null
                    || !hasText(subjectId)
                    || !hasText(other.getSubjectId())
                    || !subjectId.equals(rule.getBeforeSubjectId())
                    || !other.getSubjectId().equals(rule.getAfterSubjectId())) {
                continue;
            }
            if (timeSlot.getLessonIndex() > other.getTimeSlot().getLessonIndex()) {
                penalty += Math.max(1, rule.getWeight());
            }
        }
        return penalty;
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

    public static class SubjectSequenceRule {
        private String beforeSubjectId;
        private String afterSubjectId;
        private int weight = 1;

        public SubjectSequenceRule() {
        }

        public String getBeforeSubjectId() {
            return beforeSubjectId;
        }

        public void setBeforeSubjectId(String beforeSubjectId) {
            this.beforeSubjectId = beforeSubjectId;
        }

        public String getAfterSubjectId() {
            return afterSubjectId;
        }

        public void setAfterSubjectId(String afterSubjectId) {
            this.afterSubjectId = afterSubjectId;
        }

        public int getWeight() {
            return Math.max(1, weight);
        }

        public void setWeight(int weight) {
            this.weight = Math.max(1, weight);
        }
    }

    public static class TeacherConstraintRef {
        private String teacherId;
        private int weeklyMax;
        private int maxDays;
        private int loadBalanceWeight = 1;

        public TeacherConstraintRef() {
        }

        public String getTeacherId() {
            return teacherId;
        }

        public void setTeacherId(String teacherId) {
            this.teacherId = teacherId;
        }

        public int getWeeklyMax() {
            return Math.max(0, weeklyMax);
        }

        public void setWeeklyMax(int weeklyMax) {
            this.weeklyMax = Math.max(0, weeklyMax);
        }

        public int getMaxDays() {
            return Math.max(0, maxDays);
        }

        public void setMaxDays(int maxDays) {
            this.maxDays = Math.max(0, maxDays);
        }

        public int getLoadBalanceWeight() {
            return Math.max(0, loadBalanceWeight);
        }

        public void setLoadBalanceWeight(int loadBalanceWeight) {
            this.loadBalanceWeight = Math.max(0, loadBalanceWeight);
        }
    }
}
