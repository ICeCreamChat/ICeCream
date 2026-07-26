package com.icecream.timetable.solver;

import com.icecream.timetable.domain.LessonAssignment;
import com.icecream.timetable.domain.Room;
import com.icecream.timetable.domain.SchedulingUnit;
import com.icecream.timetable.domain.TimeSlot;
import com.icecream.timetable.domain.TimetableSolution;
import com.icecream.timetable.domain.UnitPlacement;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class SchedulingUnitFactory {

    private SchedulingUnitFactory() {
    }

    public static List<SchedulingUnit> build(TimetableSolution solution) {
        Map<String, List<LessonAssignment>> groups = new LinkedHashMap<>();
        for (LessonAssignment assignment : solution.getLessonAssignments()) {
            String key = assignment.getBlockSize() > 1 && hasText(assignment.getBlockId())
                    ? "block:" + assignment.getBlockId()
                    : "lesson:" + assignment.getId();
            groups.computeIfAbsent(key, ignored -> new ArrayList<>()).add(assignment);
        }
        Map<Integer, Map<Integer, TimeSlot>> slotsByDay = slotsByDay(solution.getTimeSlots());
        List<SchedulingUnit> units = new ArrayList<>();
        for (Map.Entry<String, List<LessonAssignment>> entry : groups.entrySet()) {
            List<LessonAssignment> assignments = entry.getValue().stream()
                    .sorted(Comparator.comparingInt(LessonAssignment::getBlockIndex))
                    .toList();
            SchedulingUnit unit = new SchedulingUnit();
            unit.setId(entry.getKey());
            unit.setAssignments(assignments);
            if (!validGroup(assignments)) {
                unit.setCandidatePlacements(List.of());
                unit.setPlacement(null);
                units.add(unit);
                continue;
            }
            List<UnitPlacement> placements = placements(unit, solution, slotsByDay);
            unit.setCandidatePlacements(placements);
            UnitPlacement initialPlacement = findInitialPlacement(assignments, placements);
            unit.setPlacement(initialPlacement);
            unit.setHardRepairFocus(initialPlacement == null);
            units.add(unit);
        }
        return units;
    }

    private static List<UnitPlacement> placements(
            SchedulingUnit unit,
            TimetableSolution solution,
            Map<Integer, Map<Integer, TimeSlot>> slotsByDay) {
        List<UnitPlacement> result = new ArrayList<>();
        List<Room> rooms = allowedRooms(unit.getAssignments(), solution.getRooms());
        for (TimeSlot start : solution.getTimeSlots()) {
            List<TimeSlot> occupied = new ArrayList<>(unit.getBlockSize());
            Map<Integer, TimeSlot> daySlots = slotsByDay.getOrDefault(start.getWeekday(), Map.of());
            for (int offset = 0; offset < unit.getBlockSize(); offset++) {
                TimeSlot slot = daySlots.get(start.getLessonIndex() + offset);
                LessonAssignment assignment = unit.getAssignments().get(offset);
                if (slot == null
                        || assignment.getBlockedTimeSlotIds().contains(slot.getId())
                        || (hasText(assignment.getPinnedTimeSlotId())
                            && !assignment.getPinnedTimeSlotId().equals(slot.getId()))) {
                    occupied.clear();
                    break;
                }
                occupied.add(slot);
            }
            if (occupied.size() != unit.getBlockSize()) continue;
            for (Room room : rooms) {
                if (!unit.getAssignments().stream().allMatch(assignment -> roomAllowed(assignment, room))) continue;
                String roomId = room == null ? "none" : room.getId();
                result.add(new UnitPlacement(
                        unit.getId() + "@" + start.getId() + "@" + roomId,
                        occupied,
                        room));
            }
        }
        return result;
    }

    private static UnitPlacement findInitialPlacement(
            List<LessonAssignment> assignments,
            List<UnitPlacement> placements) {
        if (assignments.stream().anyMatch(assignment -> assignment.getTimeSlot() == null)) return null;
        List<String> slotIds = assignments.stream().map(assignment -> assignment.getTimeSlot().getId()).toList();
        String roomId = assignments.stream().map(LessonAssignment::getRoom)
                .filter(java.util.Objects::nonNull)
                .map(Room::getId)
                .findFirst()
                .orElse(Room.NONE_ID);
        return placements.stream().filter(placement -> (
                placement.getTimeSlots().stream().map(TimeSlot::getId).toList().equals(slotIds)
                        && placement.getRoom() != null
                        && roomId.equals(placement.getRoom().getId())
        )).findFirst().orElse(null);
    }

    private static List<Room> allowedRooms(List<LessonAssignment> assignments, List<Room> solutionRooms) {
        Map<String, Room> byId = new LinkedHashMap<>();
        for (Room room : solutionRooms) byId.put(room.getId(), room);
        Set<String> allowed = null;
        for (LessonAssignment assignment : assignments) {
            Set<String> assignmentRooms = new LinkedHashSet<>();
            if (assignment.isRequiresRoom()) {
                assignmentRooms.addAll(assignment.getAllowedRoomIds());
            } else {
                assignmentRooms.add(Room.NONE_ID);
            }
            allowed = allowed == null ? assignmentRooms : intersection(allowed, assignmentRooms);
        }
        if (allowed == null) return List.of();
        return allowed.stream().map(byId::get).filter(java.util.Objects::nonNull).toList();
    }

    private static Set<String> intersection(Set<String> left, Set<String> right) {
        Set<String> result = new LinkedHashSet<>(left);
        result.retainAll(right);
        return result;
    }

    private static boolean roomAllowed(LessonAssignment assignment, Room room) {
        if (assignment.isRequiresRoom()) {
            return room != null && !room.isNone() && assignment.getAllowedRoomIds().contains(room.getId());
        }
        return room != null && room.isNone();
    }

    private static Map<Integer, Map<Integer, TimeSlot>> slotsByDay(List<TimeSlot> timeSlots) {
        Map<Integer, Map<Integer, TimeSlot>> result = new HashMap<>();
        for (TimeSlot slot : timeSlots) {
            result.computeIfAbsent(slot.getWeekday(), ignored -> new HashMap<>())
                    .put(slot.getLessonIndex(), slot);
        }
        return result;
    }

    private static boolean validGroup(List<LessonAssignment> assignments) {
        if (assignments.isEmpty()) return false;
        int expectedSize = Math.max(1, assignments.getFirst().getBlockSize());
        if (assignments.size() != expectedSize) return false;
        for (int index = 0; index < assignments.size(); index++) {
            LessonAssignment assignment = assignments.get(index);
            if (assignment.getBlockSize() != expectedSize || assignment.getBlockIndex() != index) return false;
        }
        return true;
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }
}
