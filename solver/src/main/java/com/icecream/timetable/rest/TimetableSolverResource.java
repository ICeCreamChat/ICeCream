package com.icecream.timetable.rest;

import ai.timefold.solver.core.api.solver.SolverManager;
import ai.timefold.solver.core.api.solver.SolverStatus;
import com.icecream.timetable.domain.Room;
import com.icecream.timetable.domain.TimetableSolution;
import com.icecream.timetable.domain.TimetableSolverJob;
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
        solverManager.solve(jobId, problem, solution -> {
            prepare(solution, jobId, solverManager.getSolverStatus(jobId));
            bestSolutions.put(jobId, solution);
        });
        URI location = uriInfo.getAbsolutePathBuilder().path(jobId).build();
        return Response.accepted(TimetableSolverJob.fromSolution(jobId, problem, SolverStatus.SOLVING_ACTIVE.name()))
                .location(location)
                .build();
    }

    @GET
    @Path("/{jobId}/status")
    public TimetableSolverJob status(@PathParam("jobId") String jobId) {
        TimetableSolution solution = find(jobId);
        SolverStatus status = solverManager.getSolverStatus(jobId);
        prepare(solution, jobId, status);
        return TimetableSolverJob.fromSolution(jobId, solution, statusName(status));
    }

    @GET
    @Path("/{jobId}")
    public TimetableSolution solution(@PathParam("jobId") String jobId) {
        TimetableSolution solution = find(jobId);
        SolverStatus status = solverManager.getSolverStatus(jobId);
        prepare(solution, jobId, status);
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
        solution.setJobId(jobId);
        solution.setSolverStatus(statusName(status));
    }

    private String statusName(SolverStatus status) {
        return status == null ? SolverStatus.NOT_SOLVING.name() : status.name();
    }

    private void normalize(TimetableSolution solution) {
        if (solution.getRooms() == null || solution.getRooms().isEmpty()) {
            solution.setRooms(new ArrayList<>(java.util.List.of(Room.none())));
            return;
        }
        boolean hasNone = solution.getRooms().stream().anyMatch(Room::isNone);
        if (!hasNone) {
            ArrayList<Room> rooms = new ArrayList<>(solution.getRooms());
            rooms.add(0, Room.none());
            solution.setRooms(rooms);
        }
    }
}
