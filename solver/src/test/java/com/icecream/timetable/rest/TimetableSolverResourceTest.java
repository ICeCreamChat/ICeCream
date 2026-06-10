package com.icecream.timetable.rest;

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
import static java.util.Map.entry;

@QuarkusTest
class TimetableSolverResourceTest {

    @Test
    void healthEndpointReportsOk() {
        given()
                .when().get("/timetable-solutions/health")
                .then()
                .statusCode(200)
                .body("status", equalTo("ok"))
                .body("service", equalTo("timefold-timetable-solver"));
    }

    @Test
    void jobLifecycleSolvesSmallTimetableAndCanBeDeleted() throws InterruptedException {
        String jobId = given()
                .contentType(ContentType.JSON)
                .body(problem())
                .when().post("/timetable-solutions")
                .then()
                .statusCode(202)
                .header("Location", containsString("/timetable-solutions/"))
                .body("jobId", notNullValue())
                .extract().path("jobId");

        assertNotNull(jobId);
        Map<String, Object> status = waitUntilDone(jobId);
        assertEquals("NOT_SOLVING", status.get("solverStatus"));
        assertEquals(0, status.get("hardScore"));

        given()
                .when().get("/timetable-solutions/{jobId}", jobId)
                .then()
                .statusCode(200)
                .body("jobId", equalTo(jobId))
                .body("hardScore", equalTo(0))
                .body("lessonAssignments.size()", equalTo(3));

        given()
                .when().delete("/timetable-solutions/{jobId}", jobId)
                .then()
                .statusCode(204);
    }

    @Test
    void jobLifecycleKeepsPinnedInitialLessonTime() throws InterruptedException {
        String jobId = given()
                .contentType(ContentType.JSON)
                .body(pinnedProblem())
                .when().post("/timetable-solutions")
                .then()
                .statusCode(202)
                .body("jobId", notNullValue())
                .extract().path("jobId");

        Map<String, Object> status = waitUntilDone(jobId);
        assertEquals("NOT_SOLVING", status.get("solverStatus"));
        assertEquals(0, status.get("hardScore"));

        given()
                .when().get("/timetable-solutions/{jobId}", jobId)
                .then()
                .statusCode(200)
                .body("hardScore", equalTo(0))
                .body("lessonAssignments.find { it.id == 'lp_math_1' }.timeSlot", equalTo("1-1"))
                .body("lessonAssignments.find { it.id == 'lp_math_1' }.pinnedTimeSlotId", equalTo("1-1"));

        given()
                .when().delete("/timetable-solutions/{jobId}", jobId)
                .then()
                .statusCode(204);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> waitUntilDone(String jobId) throws InterruptedException {
        Map<String, Object> status = null;
        for (int i = 0; i < 30; i++) {
            status = given()
                    .when().get("/timetable-solutions/{jobId}/status", jobId)
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
                "timeSlots", List.of(
                        slot("1-1", 1, 1),
                        slot("1-2", 1, 2),
                        slot("2-1", 2, 1),
                        slot("2-2", 2, 2)
                ),
                "rooms", List.of(Map.of("id", "__NONE__", "name", "None", "none", true)),
                "lessonAssignments", List.of(
                        lesson("lp_math_1", "lp_math", "c1", "math", "t1", 0),
                        lesson("lp_math_2", "lp_math", "c1", "math", "t1", 1),
                        lesson("lp_cn_1", "lp_cn", "c1", "chinese", "t2", 0)
                )
        );
    }

    private static Map<String, Object> pinnedProblem() {
        return Map.of(
                "name", "pinned-rest-test",
                "timeSlots", List.of(
                        slot("1-1", 1, 1),
                        slot("1-2", 1, 2),
                        slot("2-1", 2, 1)
                ),
                "rooms", List.of(Map.of("id", "__NONE__", "name", "None", "none", true)),
                "lessonAssignments", List.of(
                        pinnedLesson("lp_math_1", "lp_math", "c1", "math", "t1", 0, "1-1"),
                        lesson("lp_cn_1", "lp_cn", "c1", "chinese", "t2", 0),
                        lesson("lp_pe_1", "lp_pe", "c2", "pe", "t3", 0)
                )
        );
    }

    private static Map<String, Object> slot(String id, int weekday, int lessonIndex) {
        return Map.of(
                "id", id,
                "weekday", weekday,
                "lessonIndex", lessonIndex,
                "morning", lessonIndex <= 2
        );
    }

    private static Map<String, Object> lesson(String id, String planId, String classId, String subjectId,
                                              String teacherId, int sequence) {
        return Map.ofEntries(
                entry("id", id),
                entry("lessonPlanId", planId),
                entry("classId", classId),
                entry("subjectId", subjectId),
                entry("teacherId", teacherId),
                entry("teacherIds", List.of(teacherId)),
                entry("sequence", sequence),
                entry("blockIndex", 0),
                entry("blockSize", 1),
                entry("blockedTimeSlotIds", List.of()),
                entry("allowedRoomIds", List.of()),
                entry("requiresRoom", false),
                entry("subjectPriority", 95),
                entry("preferMorning", true),
                entry("preferLater", false)
        );
    }

    private static Map<String, Object> pinnedLesson(String id, String planId, String classId, String subjectId,
                                                    String teacherId, int sequence, String timeSlotId) {
        return Map.ofEntries(
                entry("id", id),
                entry("lessonPlanId", planId),
                entry("classId", classId),
                entry("subjectId", subjectId),
                entry("teacherId", teacherId),
                entry("teacherIds", List.of(teacherId)),
                entry("sequence", sequence),
                entry("timeSlot", timeSlotId),
                entry("pinnedTimeSlotId", timeSlotId),
                entry("blockIndex", 0),
                entry("blockSize", 1),
                entry("blockedTimeSlotIds", List.of()),
                entry("allowedRoomIds", List.of()),
                entry("requiresRoom", false),
                entry("subjectPriority", 95),
                entry("preferMorning", true),
                entry("preferLater", false)
        );
    }
}
