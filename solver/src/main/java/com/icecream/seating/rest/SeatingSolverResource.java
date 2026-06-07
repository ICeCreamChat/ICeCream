package com.icecream.seating.rest;

import ai.timefold.solver.core.api.solver.SolverManager;
import ai.timefold.solver.core.api.solver.SolverStatus;
import com.icecream.seating.domain.SeatingConstraintConfig;
import com.icecream.seating.domain.SeatingSolution;
import com.icecream.seating.domain.SolverJob;
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
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@Path("/seating-solutions")
@Consumes(MediaType.APPLICATION_JSON)
@Produces(MediaType.APPLICATION_JSON)
public class SeatingSolverResource {

    @Inject
    @Named("seating")
    SolverManager<SeatingSolution> solverManager;

    private final Map<String, SeatingSolution> bestSolutions = new ConcurrentHashMap<>();

    @GET
    @Path("/health")
    public Map<String, Object> health() {
        return Map.of(
                "status", "ok",
                "service", "timefold-seating-solver",
                "available", true
        );
    }

    @POST
    public Response solve(SeatingSolution problem, @Context UriInfo uriInfo) {
        if (problem == null || problem.getSeats() == null || problem.getSeats().isEmpty()) {
            return Response.status(Response.Status.BAD_REQUEST)
                    .entity(Map.of("error", "seats are required"))
                    .build();
        }
        if (problem.getStudents() == null || problem.getStudents().isEmpty()) {
            return Response.status(Response.Status.BAD_REQUEST)
                    .entity(Map.of("error", "students are required"))
                    .build();
        }
        String jobId = UUID.randomUUID().toString();
        prepare(problem, jobId, SolverStatus.SOLVING_ACTIVE);
        bestSolutions.put(jobId, problem);
        solverManager.solve(jobId, problem, solution -> {
            prepare(solution, jobId, solverManager.getSolverStatus(jobId));
            bestSolutions.put(jobId, solution);
        });
        URI location = uriInfo.getAbsolutePathBuilder().path(jobId).build();
        return Response.accepted(SolverJob.fromSolution(jobId, problem, SolverStatus.SOLVING_ACTIVE.name()))
                .location(location)
                .build();
    }

    @GET
    @Path("/{jobId}/status")
    public SolverJob status(@PathParam("jobId") String jobId) {
        SeatingSolution solution = find(jobId);
        SolverStatus status = solverManager.getSolverStatus(jobId);
        prepare(solution, jobId, status);
        return SolverJob.fromSolution(jobId, solution, status.name());
    }

    @GET
    @Path("/{jobId}")
    public SeatingSolution solution(@PathParam("jobId") String jobId) {
        SeatingSolution solution = find(jobId);
        SolverStatus status = solverManager.getSolverStatus(jobId);
        prepare(solution, jobId, status);
        return solution;
    }

    @DELETE
    @Path("/{jobId}")
    public Response terminate(@PathParam("jobId") String jobId) {
        SeatingSolution solution = find(jobId);
        solverManager.terminateEarly(jobId);
        SolverStatus status = solverManager.getSolverStatus(jobId);
        prepare(solution, jobId, status);
        bestSolutions.remove(jobId);
        return Response.noContent().build();
    }

    private SeatingSolution find(String jobId) {
        SeatingSolution solution = bestSolutions.get(jobId);
        if (solution == null) throw new NotFoundException("Solver job not found: " + jobId);
        return solution;
    }

    private void prepare(SeatingSolution solution, String jobId, SolverStatus status) {
        if (solution == null) return;
        solution.setJobId(jobId);
        solution.setSolverStatus(status == null ? SolverStatus.NOT_SOLVING.name() : status.name());
        SeatingConstraintConfig config = solution.getConfig();
        solution.getStudents().forEach(student -> student.setConfig(config));
    }
}
