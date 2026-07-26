package com.icecream.timetable.rest;

import ai.timefold.solver.core.api.score.HardSoftScore;
import ai.timefold.solver.core.api.score.analysis.ConstraintAnalysis;
import ai.timefold.solver.core.api.score.analysis.ScoreAnalysis;
import ai.timefold.solver.core.api.solver.SolutionManager;
import ai.timefold.solver.core.api.solver.SolverManager;
import ai.timefold.solver.core.api.solver.SolverStatus;
import com.icecream.timetable.domain.Room;
import com.icecream.timetable.domain.TimetableSolution;
import com.icecream.timetable.domain.TimetableSolverJob;
import com.icecream.timetable.solver.SchedulingUnitFactory;
import jakarta.inject.Inject;
import jakarta.inject.Named;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.DELETE;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.NotFoundException;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.Context;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.core.UriInfo;

import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@Path("/timetable-solutions")
@Consumes(MediaType.APPLICATION_JSON)
@Produces(MediaType.APPLICATION_JSON)
public class TimetableSolverResource {

    @Inject
    @Named("timetable")
    SolverManager<TimetableSolution> solverManager;

    private final Map<String, TimetableSolution> bestSolutions = new ConcurrentHashMap<>();
    private final Map<String, SolverJobState> jobStates = new ConcurrentHashMap<>();
    private volatile SolutionManager<TimetableSolution, HardSoftScore> solutionManager;

    @GET
    @Path("/health")
    public Map<String, Object> health() {
        return Map.of(
                "status", "ok",
                "service", "timefold-timetable-solver",
                "available", true
        );
    }

    @POST
    public Response solve(TimetableSolution problem, @Context UriInfo uriInfo) {
        if (problem == null || problem.getTimeSlots() == null || problem.getTimeSlots().isEmpty()) {
            return Response.status(Response.Status.BAD_REQUEST)
                    .entity(Map.of("error", "timeSlots are required"))
                    .build();
        }
        if (problem.getLessonAssignments() == null || problem.getLessonAssignments().isEmpty()) {
            return Response.status(Response.Status.BAD_REQUEST)
                    .entity(Map.of("error", "lessonAssignments are required"))
                    .build();
        }

        String jobId = UUID.randomUUID().toString();
        normalize(problem);
        prepare(problem, jobId, SolverStatus.SOLVING_ACTIVE);
        bestSolutions.put(jobId, problem);
        SolverJobState jobState = new SolverJobState();
        jobStates.put(jobId, jobState);
        solverManager.solveBuilder()
                .withProblemId(jobId)
                .withProblem(problem)
                .withSolverJobStartedEventConsumer(event -> capture(jobId, event.solution(), "timefold_started", false))
                .withFirstInitializedSolutionEventConsumer(event -> {
                    jobState.initialized = true;
                    capture(jobId, event.solution(), "timefold_initialized", false);
                })
                .withBestSolutionEventConsumer(event -> capture(jobId, event.solution(), "timefold_hard_repair", false))
                .withFinalBestSolutionEventConsumer(event -> capture(jobId, event.solution(), "completed", true))
                .withExceptionHandler((ignored, exception) -> fail(jobId, exception))
                .run();
        URI location = uriInfo.getAbsolutePathBuilder().path(jobId).build();
        return Response.accepted(toJob(jobId, problem, SolverStatus.SOLVING_ACTIVE))
                .location(location)
                .build();
    }

    @GET
    @Path("/{jobId}/status")
    public TimetableSolverJob status(@PathParam("jobId") String jobId) {
        TimetableSolution solution = find(jobId);
        SolverStatus status = solverManager.getSolverStatus(jobId);
        prepare(solution, jobId, status);
        completeIfStopped(jobId, solution, status);
        return toJob(jobId, solution, status);
    }

    @GET
    @Path("/{jobId}")
    public TimetableSolution solution(@PathParam("jobId") String jobId) {
        TimetableSolution solution = find(jobId);
        SolverStatus status = solverManager.getSolverStatus(jobId);
        prepare(solution, jobId, status);
        completeIfStopped(jobId, solution, status);
        return solution;
    }

    @DELETE
    @Path("/{jobId}")
    public Response terminate(@PathParam("jobId") String jobId) {
        TimetableSolution solution = find(jobId);
        solverManager.terminateEarly(jobId);
        SolverStatus status = solverManager.getSolverStatus(jobId);
        prepare(solution, jobId, status);
        bestSolutions.remove(jobId);
        jobStates.remove(jobId);
        return Response.noContent().build();
    }

    private TimetableSolution find(String jobId) {
        TimetableSolution solution = bestSolutions.get(jobId);
        if (solution == null) {
            throw new NotFoundException("Solver job not found: " + jobId);
        }
        return solution;
    }

    private void prepare(TimetableSolution solution, String jobId, SolverStatus status) {
        if (solution == null) {
            return;
        }
        normalize(solution);
        syncLessonAssignmentsFromUnits(solution);
        solution.setJobId(jobId);
        solution.setSolverStatus(statusName(status));
    }

    private String statusName(SolverStatus status) {
        return status == null ? SolverStatus.NOT_SOLVING.name() : status.name();
    }

    private TimetableSolverJob toJob(String jobId, TimetableSolution solution, SolverStatus solverStatus) {
        TimetableSolverJob job = TimetableSolverJob.fromSolution(jobId, solution, statusName(solverStatus));
        SolverJobState state = jobStates.get(jobId);
        if (state == null) return job;
        job.setStage(state.stage);
        job.setElapsedMs(System.currentTimeMillis() - state.startedAtMillis);
        job.setInitialized(state.initialized);
        job.setConstraintAnalysis(state.constraintAnalysis);
        job.setFailureSummary(state.failureSummary);
        if (state.hardScore != null) job.setHardScore(state.hardScore);
        if (state.softScore != null) job.setSoftScore(state.softScore);
        if (state.score != null) job.setScore(state.score);
        return job;
    }

    private void capture(String jobId, TimetableSolution solution, String stage, boolean finalResult) {
        if (solution == null) return;
        SolverJobState state = jobStates.get(jobId);
        if (state == null) return;
        normalize(solution);
        syncLessonAssignmentsFromUnits(solution);
        solution.setJobId(jobId);
        state.stage = resolveStage(stage, solution);
        updateScore(state, solution);
        bestSolutions.put(jobId, solution);
        if (finalResult) analyzeFinalSolution(state, solution);
    }

    private void completeIfStopped(String jobId, TimetableSolution solution, SolverStatus status) {
        if (status != SolverStatus.NOT_SOLVING || solution == null) return;
        SolverJobState state = jobStates.get(jobId);
        if (state == null || "failed".equals(state.stage) || "completed".equals(state.stage)) return;
        capture(jobId, solution, "completed", true);
    }

    private void updateScore(SolverJobState state, TimetableSolution solution) {
        HardSoftScore score = solution.getScore();
        if (score == null) return;
        state.hardScore = score.hardScore();
        state.softScore = score.softScore();
        state.score = score.toString();
    }

    private String resolveStage(String requested, TimetableSolution solution) {
        if (!"timefold_hard_repair".equals(requested) || solution == null || solution.getScore() == null) {
            return requested;
        }
        return solution.getScore().hardScore() >= 0 ? "soft_optimization" : requested;
    }

    private void analyzeFinalSolution(SolverJobState state, TimetableSolution solution) {
        try {
            ScoreAnalysis<HardSoftScore> analysis = solutionManager().analyze(solution);
            List<Map<String, Object>> constraints = analysis.constraintAnalyses().stream()
                    .filter(item -> item.score().hardScore() < 0)
                    .sorted(java.util.Comparator.comparingLong((ConstraintAnalysis<HardSoftScore> item) -> item.score().hardScore()))
                    .limit(5)
                    .map(item -> Map.<String, Object>of(
                            "constraintId", item.constraintId(),
                            "hardScore", item.score().hardScore(),
                            "softScore", item.score().softScore(),
                            "matchCount", item.matchCount()))
                    .toList();
            state.constraintAnalysis = constraints;
            if (solution.getScore() != null && solution.getScore().hardScore() < 0) {
                state.stage = "search_exhausted";
                state.failureSummary = Map.of(
                        "reason", "search_exhausted",
                        "status", "search_exhausted",
                        "hardScore", solution.getScore().hardScore(),
                        "softScore", solution.getScore().softScore(),
                        "hardViolationCount", constraints.stream().mapToInt(item -> ((Number) item.get("matchCount")).intValue()).sum(),
                        "topConstraints", constraints);
            } else if (!constraints.isEmpty()) {
                state.failureSummary = Map.of(
                        "hardViolationCount", constraints.stream().mapToInt(item -> ((Number) item.get("matchCount")).intValue()).sum(),
                        "topConstraints", constraints);
            }
        } catch (RuntimeException exception) {
            Throwable root = exception;
            while (root.getCause() != null && root.getCause() != root) {
                root = root.getCause();
            }
            String message = root.getMessage();
            state.failureSummary = Map.of(
                    "analysisError", exception.getClass().getSimpleName(),
                    "analysisErrorMessage", message == null || message.isBlank()
                            ? root.getClass().getSimpleName()
                            : message);
        }
    }

    private void fail(String jobId, Throwable exception) {
        SolverJobState state = jobStates.get(jobId);
        if (state == null) return;
        state.stage = "failed";
        state.failureSummary = Map.of(
                "reason", "solver_exception",
                "message", exception == null ? "Unknown solver error" : String.valueOf(exception.getMessage()));
    }

    private SolutionManager<TimetableSolution, HardSoftScore> solutionManager() {
        SolutionManager<TimetableSolution, HardSoftScore> current = solutionManager;
        if (current != null) return current;
        synchronized (this) {
            if (solutionManager == null) {
                solutionManager = SolutionManager.create(solverManager);
            }
            return solutionManager;
        }
    }

    private void normalize(TimetableSolution solution) {
        if (solution.getRooms() == null || solution.getRooms().isEmpty()) {
            solution.setRooms(new ArrayList<>(java.util.List.of(Room.none())));
        } else if (solution.getRooms().stream().noneMatch(Room::isNone)) {
            ArrayList<Room> rooms = new ArrayList<>(solution.getRooms());
            rooms.add(0, Room.none());
            solution.setRooms(rooms);
        }

        Map<String, Room> roomsById = new HashMap<>();
        for (Room room : solution.getRooms()) {
            roomsById.put(room.getId(), room);
        }
        Room none = roomsById.get(Room.NONE_ID);
        if (solution.getLessonAssignments() == null) {
            return;
        }
        solution.getLessonAssignments().forEach(assignment -> {
            List<Room> allowed = assignment.getRoomRange();
            if (allowed.isEmpty()) {
                allowed = assignment.getAllowedRoomIds().stream()
                        .map(roomsById::get)
                        .filter(java.util.Objects::nonNull)
                        .toList();
                assignment.setRoomRange(allowed.isEmpty() && !assignment.isRequiresRoom()
                        ? List.of(none)
                        : allowed);
            }
            if (assignment.isPinned() && assignment.getRoom() == null) {
                if (assignment.isRequiresRoom() && !allowed.isEmpty()) {
                    assignment.setRoom(allowed.getFirst());
                } else {
                    assignment.setRoom(none);
                }
            }
        });
        if (solution.getSchedulingUnits() == null || solution.getSchedulingUnits().isEmpty()) {
            solution.setSchedulingUnits(SchedulingUnitFactory.build(solution));
        }
    }

    private void syncLessonAssignmentsFromUnits(TimetableSolution solution) {
        if (solution.getLessonAssignments() == null || solution.getSchedulingUnits() == null) return;
        Map<String, com.icecream.timetable.domain.LessonAssignment> byId = new HashMap<>();
        for (com.icecream.timetable.domain.LessonAssignment assignment : solution.getLessonAssignments()) {
            byId.put(assignment.getId(), assignment);
        }
        for (com.icecream.timetable.domain.SchedulingUnit unit : solution.getSchedulingUnits()) {
            var placement = unit.getPlacement();
            if (placement == null) continue;
            List<com.icecream.timetable.domain.LessonAssignment> members = unit.getAssignments();
            List<com.icecream.timetable.domain.TimeSlot> slots = placement.getTimeSlots();
            for (int index = 0; index < members.size() && index < slots.size(); index++) {
                com.icecream.timetable.domain.LessonAssignment assignment = byId.get(members.get(index).getId());
                if (assignment == null) continue;
                assignment.setTimeSlot(slots.get(index));
                assignment.setRoom(placement.getRoom());
            }
        }
    }

    private static final class SolverJobState {
        private final long startedAtMillis = System.currentTimeMillis();
        private volatile String stage = "queued";
        private volatile boolean initialized;
        private volatile Long hardScore;
        private volatile Long softScore;
        private volatile String score;
        private volatile List<Map<String, Object>> constraintAnalysis = List.of();
        private volatile Map<String, Object> failureSummary = Map.of();
    }
}
