package com.icecream.seating.rest;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.notNullValue;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

@QuarkusTest
class SeatingSolverResourceTest {

    @Test
    void healthEndpointReportsOk() {
        given()
                .when().get("/seating-solutions/health")
                .then()
                .statusCode(200)
                .body("status", equalTo("ok"))
                .body("service", equalTo("timefold-seating-solver"));
    }

    @Test
    void jobLifecycleReturnsExplicitScoresAndCanBeDeleted() throws InterruptedException {
        String jobId = given()
                .contentType(ContentType.JSON)
                .body(problem())
                .when().post("/seating-solutions")
                .then()
                .statusCode(202)
                .header("Location", containsString("/seating-solutions/"))
                .body("jobId", notNullValue())
                .extract().path("jobId");

        assertNotNull(jobId);
        Map<String, Object> status = waitUntilDone(jobId);
        assertEquals("NOT_SOLVING", status.get("solverStatus"));
        assertNotNull(status.get("hardScore"));
        assertNotNull(status.get("softScore"));
        assertNotNull(status.get("score"));

        given()
                .when().get("/seating-solutions/{jobId}", jobId)
                .then()
                .statusCode(200)
                .body("jobId", equalTo(jobId))
                .body("hardScore", equalTo(0))
                .body("students.size()", equalTo(2));

        given()
                .when().delete("/seating-solutions/{jobId}", jobId)
                .then()
                .statusCode(204);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> waitUntilDone(String jobId) throws InterruptedException {
        Map<String, Object> status = null;
        for (int i = 0; i < 20; i++) {
            status = given()
                    .when().get("/seating-solutions/{jobId}/status", jobId)
                    .then()
                    .statusCode(200)
                    .extract().as(Map.class);
            if ("NOT_SOLVING".equals(status.get("solverStatus"))) {
                return status;
            }
            Thread.sleep(250);
        }
        return status;
    }

    private static Map<String, Object> problem() {
        return Map.of(
                "name", "rest-test",
                "seats", List.of(
                        Map.of(
                                "id", "r0c0",
                                "row", 0,
                                "col", 0,
                                "qualityScore", 80,
                                "groupId", 1,
                                "neighborSeatIds", List.of("r0c1")
                        ),
                        Map.of(
                                "id", "r0c1",
                                "row", 0,
                                "col", 1,
                                "qualityScore", 80,
                                "groupId", 1,
                                "neighborSeatIds", List.of("r0c0")
                        )
                ),
                "students", List.of(
                        Map.of("id", "s01", "name", "A", "gender", "M", "grade", 90, "height", 160),
                        Map.of("id", "s02", "name", "B", "gender", "F", "grade", 80, "height", 150)
                ),
                "config", Map.of(
                        "frontRowThreshold", 0,
                        "backRowThreshold", 0,
                        "gradeStrategy", "none"
                )
        );
    }
}
