package com.icecream.timetable.domain;

import ai.timefold.solver.core.api.domain.common.PlanningId;
import com.fasterxml.jackson.annotation.JsonIdentityReference;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

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
    @JsonIdentityReference(alwaysAsId = true)
    private List<Room> roomRange = new ArrayList<>();
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
    private int teacherLoadBalanceWeight;
    private List<TeacherConstraintRef> teacherConstraintRefs = new ArrayList<>();
    private String gradeName;
    private List<String> activityTypes = new ArrayList<>();
    private List<String> requiredResourceTypes = new ArrayList<>();
    private List<AdvancedRuleRef> advancedRules = new ArrayList<>();

    @JsonIdentityReference(alwaysAsId = true)
    private TimeSlot timeSlot;

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

    public boolean isPinned() {
        return hasText(pinnedTimeSlotId) || locked || manuallyAdjusted;
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

    public List<Room> getRoomRange() {
        return roomRange == null ? List.of() : roomRange;
    }

    public void setRoomRange(List<Room> roomRange) {
        this.roomRange = roomRange == null ? new ArrayList<>() : new ArrayList<>(roomRange);
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

    public String getGradeName() {
        return gradeName;
    }

    public void setGradeName(String gradeName) {
        this.gradeName = gradeName;
    }

    public List<String> getActivityTypes() {
        return activityTypes == null ? List.of() : activityTypes;
    }

    public void setActivityTypes(List<String> activityTypes) {
        this.activityTypes = activityTypes == null ? new ArrayList<>() : new ArrayList<>(activityTypes);
    }

    public List<String> getRequiredResourceTypes() {
        return requiredResourceTypes == null ? List.of() : requiredResourceTypes;
    }

    public void setRequiredResourceTypes(List<String> requiredResourceTypes) {
        this.requiredResourceTypes = requiredResourceTypes == null ? new ArrayList<>() : new ArrayList<>(requiredResourceTypes);
    }

    public List<AdvancedRuleRef> getAdvancedRules() {
        return advancedRules == null ? List.of() : advancedRules;
    }

    public void setAdvancedRules(List<AdvancedRuleRef> advancedRules) {
        this.advancedRules = advancedRules == null ? new ArrayList<>() : new ArrayList<>(advancedRules);
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
        if (timeSlot == null || !preferMorning) {
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

    public boolean advancedHardViolation() {
        return getAdvancedRules().stream().anyMatch(rule -> rule.isHard() && rule.unaryViolation(this));
    }

    public int advancedSoftPenalty() {
        return getAdvancedRules().stream()
                .filter(rule -> !rule.isHard())
                .mapToInt(rule -> rule.unaryPenalty(this))
                .sum();
    }

    public boolean advancedPairHardViolation(LessonAssignment other) {
        return getAdvancedRules().stream().anyMatch(rule -> rule.isHard() && rule.pairViolation(this, other));
    }

    public int advancedPairSoftPenalty(LessonAssignment other) {
        return getAdvancedRules().stream()
                .filter(rule -> !rule.isHard())
                .mapToInt(rule -> rule.pairPenalty(this, other))
                .sum();
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
        private int loadBalanceWeight;

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

    public static class AdvancedRuleRef {
        private String id;
        private String type;
        private boolean hard;
        private List<String> slots = new ArrayList<>();
        private List<Integer> days = new ArrayList<>();
        private List<Integer> periods = new ArrayList<>();
        private List<String> subjectIds = new ArrayList<>();
        private List<String> roomIds = new ArrayList<>();
        private List<String> requiredRoomTypes = new ArrayList<>();
        private List<String> preferredRoomIds = new ArrayList<>();
        private List<String> forbiddenRoomTypes = new ArrayList<>();
        private List<Integer> boundaryPeriods = new ArrayList<>();
        private int minOccurrences;
        private int blockSize;

        public AdvancedRuleRef() {
        }

        public String getId() { return id; }
        public void setId(String id) { this.id = id; }
        public String getType() { return type; }
        public void setType(String type) { this.type = type; }
        public boolean isHard() { return hard; }
        public void setHard(boolean hard) { this.hard = hard; }
        public List<String> getSlots() { return slots == null ? List.of() : slots; }
        public void setSlots(List<String> slots) { this.slots = slots == null ? new ArrayList<>() : new ArrayList<>(slots); }
        public List<Integer> getDays() { return days == null ? List.of() : days; }
        public void setDays(List<Integer> days) { this.days = days == null ? new ArrayList<>() : new ArrayList<>(days); }
        public List<Integer> getPeriods() { return periods == null ? List.of() : periods; }
        public void setPeriods(List<Integer> periods) { this.periods = periods == null ? new ArrayList<>() : new ArrayList<>(periods); }
        public List<String> getSubjectIds() { return subjectIds == null ? List.of() : subjectIds; }
        public void setSubjectIds(List<String> subjectIds) { this.subjectIds = subjectIds == null ? new ArrayList<>() : new ArrayList<>(subjectIds); }
        public List<String> getRoomIds() { return roomIds == null ? List.of() : roomIds; }
        public void setRoomIds(List<String> roomIds) { this.roomIds = roomIds == null ? new ArrayList<>() : new ArrayList<>(roomIds); }
        public List<String> getRequiredRoomTypes() { return requiredRoomTypes == null ? List.of() : requiredRoomTypes; }
        public void setRequiredRoomTypes(List<String> types) { this.requiredRoomTypes = types == null ? new ArrayList<>() : new ArrayList<>(types); }
        public List<String> getPreferredRoomIds() { return preferredRoomIds == null ? List.of() : preferredRoomIds; }
        public void setPreferredRoomIds(List<String> ids) { this.preferredRoomIds = ids == null ? new ArrayList<>() : new ArrayList<>(ids); }
        public List<String> getForbiddenRoomTypes() { return forbiddenRoomTypes == null ? List.of() : forbiddenRoomTypes; }
        public void setForbiddenRoomTypes(List<String> types) { this.forbiddenRoomTypes = types == null ? new ArrayList<>() : new ArrayList<>(types); }
        public List<Integer> getBoundaryPeriods() { return boundaryPeriods == null ? List.of() : boundaryPeriods; }
        public void setBoundaryPeriods(List<Integer> values) { this.boundaryPeriods = values == null ? new ArrayList<>() : new ArrayList<>(values); }
        public int getMinOccurrences() { return minOccurrences; }
        public void setMinOccurrences(int minOccurrences) { this.minOccurrences = Math.max(0, minOccurrences); }
        public int getBlockSize() { return blockSize; }
        public void setBlockSize(int blockSize) { this.blockSize = Math.max(0, blockSize); }

        private boolean atTargetSlot(LessonAssignment lesson) {
            return lesson.getTimeSlot() != null && getSlots().contains(lesson.getTimeSlot().getId());
        }

        private boolean unaryViolation(LessonAssignment lesson) {
            if (lesson.getTimeSlot() == null) return false;
            if (List.of("subject.avoid_periods", "lesson.activity_scope_period_policy", "lesson.resource_attribute_avoid_periods").contains(type)) {
                return atTargetSlot(lesson);
            }
            if ("room.required".equals(type)) {
                boolean roomIdMatch = !getRoomIds().isEmpty()
                        && lesson.getRoom() != null
                        && getRoomIds().contains(lesson.getRoom().getId());
                boolean roomTypeMatch = !getRequiredRoomTypes().isEmpty()
                        && lesson.getRoom() != null
                        && getRequiredRoomTypes().stream().allMatch(lesson.getRoom()::hasNormalizedTag);
                return (!getRoomIds().isEmpty() || !getRequiredRoomTypes().isEmpty())
                        && !roomIdMatch
                        && !roomTypeMatch;
            }
            if ("room.forbidden_type".equals(type) && lesson.getRoom() != null) {
                return getForbiddenRoomTypes().stream().anyMatch(lesson.getRoom()::hasNormalizedTag);
            }
            return false;
        }

        private int unaryPenalty(LessonAssignment lesson) {
            if (lesson.getTimeSlot() == null) return 0;
            if (List.of("subject.avoid_periods", "lesson.activity_scope_period_policy", "lesson.resource_attribute_avoid_periods").contains(type)) {
                return atTargetSlot(lesson) ? 20 : 0;
            }
            if (List.of("subject.preferred_day_part", "subject.preferred_periods").contains(type)) {
                return !getSlots().isEmpty() && !atTargetSlot(lesson) ? 12 : 0;
            }
            if ("subject.avoid_weekday_concentration".equals(type)) {
                return getDays().contains(lesson.getTimeSlot().getWeekday()) ? 8 : 0;
            }
            if ("room.preferred".equals(type)) {
                return !getPreferredRoomIds().isEmpty() && (lesson.getRoom() == null || !getPreferredRoomIds().contains(lesson.getRoom().getId())) ? 10 : 0;
            }
            return 0;
        }

        private boolean pairViolation(LessonAssignment left, LessonAssignment right) {
            if (!"schedule.cross_venue_boundary".equals(type) || left.getTimeSlot() == null || right.getTimeSlot() == null) return false;
            if (!left.sharesClassWith(right)) return false;
            if (left.getTimeSlot().getWeekday() != right.getTimeSlot().getWeekday()) return false;
            if (!getBoundaryPeriods().contains(left.getTimeSlot().getLessonIndex()) || !getBoundaryPeriods().contains(right.getTimeSlot().getLessonIndex())) return false;
            String leftRoom = left.getRoom() == null ? "" : left.getRoom().getId();
            String rightRoom = right.getRoom() == null ? "" : right.getRoom().getId();
            return !leftRoom.equals(rightRoom);
        }

        private int pairPenalty(LessonAssignment left, LessonAssignment right) {
            if (left.getTimeSlot() == null || right.getTimeSlot() == null) return 0;
            if ("teacher.compact_day".equals(type) && left.sharesTeacherWith(right)
                    && left.getTimeSlot().getWeekday() == right.getTimeSlot().getWeekday()) {
                return Math.max(0, Math.abs(left.getTimeSlot().getLessonIndex() - right.getTimeSlot().getLessonIndex()) - 1) * 3;
            }
            if ("subject.not_consecutive_with".equals(type) && left.sharesClassWith(right)
                    && left.getTimeSlot().getWeekday() == right.getTimeSlot().getWeekday()
                    && Math.abs(left.getTimeSlot().getLessonIndex() - right.getTimeSlot().getLessonIndex()) == 1
                    && getSubjectIds().contains(right.getSubjectId())) return 12;
            if ("subject.spread".equals(type)
                    && left.sharesClassWith(right)
                    && left.getSubjectId().equals(right.getSubjectId())
                    && left.getTimeSlot().getWeekday() == right.getTimeSlot().getWeekday()
                    && right.getAdvancedRules().stream().anyMatch(rule -> id != null && id.equals(rule.getId()))) return 16;
            if ("class.daily_balance".equals(type) && left.sharesClassWith(right)
                    && left.getTimeSlot().getWeekday() == right.getTimeSlot().getWeekday()) return 2;
            if ("teacher.prep_group_fairness".equals(type) && left.sharesTeacherWith(right)
                    && left.getTimeSlot().getLessonIndex() >= 5
                    && right.getTimeSlot().getLessonIndex() >= 5) return 3;
            return 0;
        }
    }
}
