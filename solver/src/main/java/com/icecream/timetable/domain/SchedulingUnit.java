package com.icecream.timetable.domain;

import ai.timefold.solver.core.api.domain.common.PlanningId;
import ai.timefold.solver.core.api.domain.entity.PlanningEntity;
import ai.timefold.solver.core.api.domain.entity.PlanningPin;
import ai.timefold.solver.core.api.domain.valuerange.ValueRangeProvider;
import ai.timefold.solver.core.api.domain.variable.PlanningVariable;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

@PlanningEntity
public class SchedulingUnit {

    private String id;
    private List<LessonAssignment> assignments = new ArrayList<>();

    private List<UnitPlacement> candidatePlacements = new ArrayList<>();

    private UnitPlacement placement;
    private boolean hardRepairFocus;

    public SchedulingUnit() {
    }

    @PlanningId
    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public List<LessonAssignment> getAssignments() {
        return assignments == null ? List.of() : assignments;
    }

    public void setAssignments(List<LessonAssignment> assignments) {
        this.assignments = assignments == null ? new ArrayList<>() : new ArrayList<>(assignments);
    }

    @ValueRangeProvider(id = "candidatePlacementRange")
    public List<UnitPlacement> getCandidatePlacements() {
        return candidatePlacements == null ? List.of() : candidatePlacements;
    }

    public void setCandidatePlacements(List<UnitPlacement> candidatePlacements) {
        this.candidatePlacements = candidatePlacements == null
                ? new ArrayList<>()
                : new ArrayList<>(candidatePlacements);
    }

    @PlanningVariable(valueRangeProviderRefs = "candidatePlacementRange", allowsUnassigned = true)
    public UnitPlacement getPlacement() {
        return placement;
    }

    public void setPlacement(UnitPlacement placement) {
        this.placement = placement;
    }

    public boolean isHardRepairFocus() {
        return hardRepairFocus;
    }

    public void setHardRepairFocus(boolean hardRepairFocus) {
        this.hardRepairFocus = hardRepairFocus;
    }

    @PlanningPin
    public boolean isPinned() {
        return getAssignments().stream().anyMatch(LessonAssignment::isPinned);
    }

    public LessonAssignment firstAssignment() {
        return getAssignments().isEmpty() ? null : getAssignments().getFirst();
    }

    public int getBlockSize() {
        return getAssignments().size();
    }

    public String getClassId() {
        return firstAssignment() == null ? null : firstAssignment().getClassId();
    }

    public String getSubjectId() {
        return firstAssignment() == null ? null : firstAssignment().getSubjectId();
    }

    public String getTeacherId() {
        return firstAssignment() == null ? null : firstAssignment().getTeacherId();
    }

    public List<String> getTeacherIds() {
        return firstAssignment() == null ? List.of() : firstAssignment().getTeacherIds();
    }

    public String getTeacherSetKey() {
        return getTeacherIds().stream().filter(SchedulingUnit::hasText).sorted().distinct()
                .reduce((left, right) -> left + "|" + right).orElse("");
    }

    public TimeSlot getStartTimeSlot() {
        return placement == null ? null : placement.getStartTimeSlot();
    }

    public List<TimeSlot> getTimeSlots() {
        return placement == null ? List.of() : placement.getTimeSlots();
    }

    public TimeSlot getTimeSlotAt(int index) {
        return index >= 0 && index < getTimeSlots().size() ? getTimeSlots().get(index) : null;
    }

    public Room getRoom() {
        return placement == null ? null : placement.getRoom();
    }

    public boolean overlaps(SchedulingUnit other) {
        return overlapCount(other) > 0;
    }

    public int overlapCount(SchedulingUnit other) {
        if (other == null || placement == null || other.placement == null) return 0;
        Set<String> occupied = new HashSet<>();
        for (TimeSlot slot : placement.getTimeSlots()) occupied.add(slot.getId());
        int count = 0;
        for (TimeSlot slot : other.placement.getTimeSlots()) {
            if (occupied.contains(slot.getId())) count += 1;
        }
        return count;
    }

    public boolean sharesClassWith(SchedulingUnit other) {
        return other != null && hasText(getClassId()) && getClassId().equals(other.getClassId());
    }

    public boolean sharesTeacherWith(SchedulingUnit other) {
        if (other == null) return false;
        Set<String> mine = new HashSet<>(getTeacherIds());
        mine.removeIf(value -> !hasText(value));
        mine.retainAll(other.getTeacherIds());
        return !mine.isEmpty();
    }

    public boolean sharesMutualExclusionGroup(SchedulingUnit other) {
        if (firstAssignment() == null || other == null || other.firstAssignment() == null) return false;
        return firstAssignment().sharesMutualExclusionGroup(other.firstAssignment());
    }

    public boolean isPlacementValid() {
        return placement != null
                && placement.getTimeSlots().size() == getAssignments().size()
                && isPinnedTimeSatisfied()
                && isAllowedTime()
                && isAllowedRoom();
    }

    public boolean isPinnedTimeSatisfied() {
        if (placement == null) return false;
        for (int index = 0; index < getAssignments().size(); index++) {
            String pinned = getAssignments().get(index).getPinnedTimeSlotId();
            TimeSlot slot = getTimeSlotAt(index);
            if (hasText(pinned) && (slot == null || !pinned.equals(slot.getId()))) return false;
        }
        return true;
    }

    public boolean isAllowedTime() {
        if (placement == null) return false;
        for (int index = 0; index < getAssignments().size(); index++) {
            TimeSlot slot = getTimeSlotAt(index);
            if (slot == null || getAssignments().get(index).getBlockedTimeSlotIds().contains(slot.getId())) return false;
        }
        return true;
    }

    public boolean isAllowedRoom() {
        if (placement == null || placement.getRoom() == null) return false;
        for (LessonAssignment assignment : getAssignments()) {
            if (assignment.isRequiresRoom()) {
                if (placement.getRoom().isNone() || !assignment.getAllowedRoomIds().contains(placement.getRoom().getId())) return false;
            } else if (!placement.getRoom().isNone()) {
                return false;
            }
        }
        return true;
    }

    public String classSubjectDayKey() {
        TimeSlot start = getStartTimeSlot();
        return start == null ? null : getClassId() + "|" + getSubjectId() + "|" + start.getWeekday();
    }

    public int getSubjectDailyMax() {
        return firstAssignment() == null ? 0 : firstAssignment().getSubjectDailyMax();
    }

    public List<LessonAssignment.TeacherConstraintRef> getTeacherConstraintRefs() {
        return firstAssignment() == null ? List.of() : firstAssignment().getTeacherConstraintRefs();
    }

    public List<LessonAssignment.TeacherConstraintRef> getTeacherConstraintRefsPerLesson() {
        List<LessonAssignment.TeacherConstraintRef> refs = getTeacherConstraintRefs();
        if (refs.isEmpty() || getBlockSize() <= 1) return refs;
        List<LessonAssignment.TeacherConstraintRef> repeated = new ArrayList<>(refs.size() * getBlockSize());
        for (int index = 0; index < getBlockSize(); index++) repeated.addAll(refs);
        return repeated;
    }

    public int getClassMainDailyMax() {
        return firstAssignment() == null ? 0 : firstAssignment().getClassMainDailyMax();
    }

    public int getSubjectPriority() {
        return firstAssignment() == null ? 0 : firstAssignment().getSubjectPriority();
    }

    public int getTeacherGapWeight() {
        return firstAssignment() == null ? 0 : firstAssignment().getTeacherGapWeight();
    }

    public int getTeacherLoadBalanceWeight() {
        return firstAssignment() == null ? 0 : firstAssignment().getTeacherLoadBalanceWeight();
    }

    public boolean violatesNotSameDay(SchedulingUnit other) {
        return other != null
                && getStartTimeSlot() != null
                && other.getStartTimeSlot() != null
                && getStartTimeSlot().getWeekday() == other.getStartTimeSlot().getWeekday()
                && sharesClassWith(other)
                && firstAssignment() != null
                && other.firstAssignment() != null
                && firstAssignment().getNotSameDaySubjectIds().contains(other.getSubjectId());
    }

    public int spreadSameCoursePenalty(SchedulingUnit other) {
        if (other == null || getStartTimeSlot() == null || other.getStartTimeSlot() == null
                || !sharesClassWith(other) || !java.util.Objects.equals(getSubjectId(), other.getSubjectId())) return 0;
        int minGap = Math.max(firstAssignment().getSpreadMinGapDays(), other.firstAssignment().getSpreadMinGapDays());
        int distance = Math.abs(getStartTimeSlot().getWeekday() - other.getStartTimeSlot().getWeekday());
        return distance >= minGap ? 0 : Math.max(1, minGap - distance) * 4 * getBlockSize() * other.getBlockSize();
    }

    public boolean adjacentSameClassSubject(SchedulingUnit other) {
        if (other == null || !sharesClassWith(other) || !java.util.Objects.equals(getSubjectId(), other.getSubjectId())) return false;
        for (TimeSlot left : getTimeSlots()) {
            for (TimeSlot right : other.getTimeSlots()) {
                if (left.isAdjacentTo(right)) return true;
            }
        }
        return false;
    }

    public int subjectSequencePenalty(SchedulingUnit other) {
        if (other == null || !sharesClassWith(other)) return 0;
        int penalty = 0;
        for (int leftIndex = 0; leftIndex < getAssignments().size(); leftIndex++) {
            LessonAssignment left = getAssignments().get(leftIndex);
            TimeSlot leftSlot = getTimeSlotAt(leftIndex);
            if (leftSlot == null) continue;
            for (int rightIndex = 0; rightIndex < other.getAssignments().size(); rightIndex++) {
                LessonAssignment right = other.getAssignments().get(rightIndex);
                TimeSlot rightSlot = other.getTimeSlotAt(rightIndex);
                if (rightSlot == null || leftSlot.getWeekday() != rightSlot.getWeekday()) continue;
                for (LessonAssignment.SubjectSequenceRule rule : left.getSequenceRules()) {
                    if (rule != null
                            && java.util.Objects.equals(left.getSubjectId(), rule.getBeforeSubjectId())
                            && java.util.Objects.equals(right.getSubjectId(), rule.getAfterSubjectId())
                            && leftSlot.getLessonIndex() > rightSlot.getLessonIndex()) {
                        penalty += rule.getWeight();
                    }
                }
            }
        }
        return penalty;
    }

    public boolean advancedHardViolation() {
        return advancedHardViolation(placement);
    }

    public boolean advancedHardViolation(UnitPlacement proposedPlacement) {
        return advancedUnaryPenalty(proposedPlacement, true) > 0;
    }

    public int advancedSoftPenalty() {
        return advancedUnaryPenalty(placement, false);
    }

    public boolean advancedPairHardViolation(SchedulingUnit other) {
        return advancedPairHardViolation(other, placement, other == null ? null : other.placement);
    }

    public boolean advancedPairHardViolation(
            SchedulingUnit other,
            UnitPlacement proposedPlacement,
            UnitPlacement proposedOtherPlacement) {
        return advancedPairPenalty(other, proposedPlacement, proposedOtherPlacement, true) > 0;
    }

    public int advancedPairSoftPenalty(SchedulingUnit other) {
        return advancedPairPenalty(other, placement, other == null ? null : other.placement, false);
    }

    public int earlierSubjectPenalty() {
        int penalty = 0;
        for (int index = 0; index < getAssignments().size(); index++) {
            LessonAssignment assignment = getAssignments().get(index);
            TimeSlot slot = getTimeSlotAt(index);
            if (slot == null || !assignment.isPreferMorning()) continue;
            penalty += slot.isMorning() ? Math.max(0, slot.getLessonIndex() - 2) : 8 + Math.max(0, slot.getLessonIndex() - 2);
        }
        return penalty;
    }

    public int laterSubjectPenalty() {
        int penalty = 0;
        for (int index = 0; index < getAssignments().size(); index++) {
            if (getAssignments().get(index).isPreferLater() && getTimeSlotAt(index) != null && getTimeSlotAt(index).isMorning()) penalty += 6;
        }
        return penalty;
    }

    public boolean sameTeacherDay(SchedulingUnit other) {
        return other != null
                && getStartTimeSlot() != null
                && other.getStartTimeSlot() != null
                && getStartTimeSlot().getWeekday() == other.getStartTimeSlot().getWeekday()
                && sharesTeacherWith(other);
    }

    private int advancedUnaryPenalty(UnitPlacement proposedPlacement, boolean hard) {
        if (proposedPlacement == null) return 0;
        int total = 0;
        for (int index = 0; index < getAssignments().size(); index++) {
            LessonAssignment assignment = getAssignments().get(index);
            TimeSlot slot = index < proposedPlacement.getTimeSlots().size()
                    ? proposedPlacement.getTimeSlots().get(index) : null;
            if (slot == null) continue;
            for (LessonAssignment.AdvancedRuleRef rule : assignment.getAdvancedRules()) {
                if (rule == null || rule.isHard() != hard) continue;
                boolean atTarget = rule.getSlots().contains(slot.getId());
                boolean violation = false;
                int penalty = 0;
                if (List.of("subject.avoid_periods", "lesson.activity_scope_period_policy", "lesson.resource_attribute_avoid_periods").contains(rule.getType())) {
                    violation = atTarget;
                    penalty = 20;
                } else if ("room.required".equals(rule.getType())) {
                    boolean roomIdMatch = !rule.getRoomIds().isEmpty() && proposedPlacement.getRoom() != null
                            && rule.getRoomIds().contains(proposedPlacement.getRoom().getId());
                    boolean roomTypeMatch = !rule.getRequiredRoomTypes().isEmpty() && proposedPlacement.getRoom() != null
                            && rule.getRequiredRoomTypes().stream().allMatch(proposedPlacement.getRoom()::hasNormalizedTag);
                    violation = (!rule.getRoomIds().isEmpty() || !rule.getRequiredRoomTypes().isEmpty()) && !roomIdMatch && !roomTypeMatch;
                    penalty = 1;
                } else if ("room.forbidden_type".equals(rule.getType())) {
                    violation = proposedPlacement.getRoom() != null
                            && rule.getForbiddenRoomTypes().stream().anyMatch(proposedPlacement.getRoom()::hasNormalizedTag);
                    penalty = 1;
                } else if (!hard && List.of("subject.preferred_day_part", "subject.preferred_periods").contains(rule.getType())) {
                    violation = !rule.getSlots().isEmpty() && !atTarget;
                    penalty = 12;
                } else if (!hard && "subject.avoid_weekday_concentration".equals(rule.getType())) {
                    violation = rule.getDays().contains(slot.getWeekday());
                    penalty = 8;
                } else if (!hard && "room.preferred".equals(rule.getType())) {
                    violation = !rule.getPreferredRoomIds().isEmpty()
                            && (proposedPlacement.getRoom() == null
                            || !rule.getPreferredRoomIds().contains(proposedPlacement.getRoom().getId()));
                    penalty = 10;
                }
                if (violation) total += hard ? 1 : penalty;
            }
        }
        return total;
    }

    private int advancedPairPenalty(
            SchedulingUnit other,
            UnitPlacement proposedPlacement,
            UnitPlacement proposedOtherPlacement,
            boolean hard) {
        if (other == null || proposedPlacement == null || proposedOtherPlacement == null) return 0;
        int total = 0;
        for (int leftIndex = 0; leftIndex < getAssignments().size(); leftIndex++) {
            LessonAssignment left = getAssignments().get(leftIndex);
            TimeSlot leftSlot = leftIndex < proposedPlacement.getTimeSlots().size()
                    ? proposedPlacement.getTimeSlots().get(leftIndex) : null;
            if (leftSlot == null) continue;
            for (int rightIndex = 0; rightIndex < other.getAssignments().size(); rightIndex++) {
                LessonAssignment right = other.getAssignments().get(rightIndex);
                TimeSlot rightSlot = rightIndex < proposedOtherPlacement.getTimeSlots().size()
                        ? proposedOtherPlacement.getTimeSlots().get(rightIndex) : null;
                if (rightSlot == null) continue;
                for (LessonAssignment.AdvancedRuleRef rule : left.getAdvancedRules()) {
                    if (rule == null || rule.isHard() != hard) continue;
                    if ("schedule.cross_venue_boundary".equals(rule.getType())
                            && sharesClassWith(other)
                            && leftSlot.getWeekday() == rightSlot.getWeekday()
                            && rule.getBoundaryPeriods().contains(leftSlot.getLessonIndex())
                            && rule.getBoundaryPeriods().contains(rightSlot.getLessonIndex())
                            && !java.util.Objects.equals(roomId(proposedPlacement.getRoom()), roomId(proposedOtherPlacement.getRoom()))) {
                        total += hard ? 1 : 0;
                    } else if (!hard && "teacher.compact_day".equals(rule.getType())
                            && sharesTeacherWith(other) && leftSlot.getWeekday() == rightSlot.getWeekday()) {
                        total += Math.max(0, Math.abs(leftSlot.getLessonIndex() - rightSlot.getLessonIndex()) - 1) * 3;
                    } else if (!hard && "subject.not_consecutive_with".equals(rule.getType())
                            && sharesClassWith(other) && leftSlot.getWeekday() == rightSlot.getWeekday()
                            && Math.abs(leftSlot.getLessonIndex() - rightSlot.getLessonIndex()) == 1
                            && rule.getSubjectIds().contains(right.getSubjectId())) {
                        total += 12;
                    } else if (!hard && "subject.spread".equals(rule.getType())
                            && sharesClassWith(other) && java.util.Objects.equals(left.getSubjectId(), right.getSubjectId())
                            && leftSlot.getWeekday() == rightSlot.getWeekday()
                            && right.getAdvancedRules().stream().anyMatch(candidate -> rule.getId() != null && rule.getId().equals(candidate.getId()))) {
                        total += 16;
                    } else if (!hard && "class.daily_balance".equals(rule.getType())
                            && sharesClassWith(other) && leftSlot.getWeekday() == rightSlot.getWeekday()) {
                        total += 2;
                    } else if (!hard && "teacher.prep_group_fairness".equals(rule.getType())
                            && sharesTeacherWith(other) && leftSlot.getLessonIndex() >= 5 && rightSlot.getLessonIndex() >= 5) {
                        total += 3;
                    }
                }
            }
        }
        return total;
    }

    private static String roomId(Room room) {
        return room == null ? "" : room.getId();
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

}
