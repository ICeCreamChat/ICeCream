package com.icecream.timetable.rest;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import io.restassured.path.json.JsonPath;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.HashMap;
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
        assertEquals("completed", status.get("stage"));
        assertNotNull(status.get("elapsedMs"));
        assertNotNull(status.get("constraintAnalysis"));

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

    @Test
    void solveEndpointAcceptsGatewayWarmStartMetadata() {
        Map<String, Object> warmStartProblem = new HashMap<>(pinnedProblem());
        warmStartProblem.put("initialAssignment", List.of(
                Map.of("id", "lp_math_1", "timeSlot", "1-1")
        ));
        warmStartProblem.put("pinnedAssignments", List.of(
                Map.of("id", "lp_math_1", "timeSlot", "1-1")
        ));
        warmStartProblem.put("solverConfig", Map.of("warmStart", true));

        String jobId = given()
                .contentType(ContentType.JSON)
                .body(warmStartProblem)
                .when().post("/timetable-solutions")
                .then()
                .statusCode(202)
                .body("jobId", notNullValue())
                .extract().path("jobId");

        given()
                .when().delete("/timetable-solutions/{jobId}", jobId)
                .then()
                .statusCode(204);
    }

    @Test
    void jobLifecyclePreservesManualProtectedFlagsWithoutConvertingThemToLocked() throws InterruptedException {
        String jobId = given()
                .contentType(ContentType.JSON)
                .body(manualProtectedProblem())
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
                .body("lessonAssignments.find { it.id == 'lp_math_1' }.locked", equalTo(true))
                .body("lessonAssignments.find { it.id == 'lp_math_1' }.manuallyAdjusted", equalTo(true))
                .body("lessonAssignments.find { it.id == 'lp_pe_1' }.pinnedTimeSlotId", equalTo("2-1"))
                .body("lessonAssignments.find { it.id == 'lp_pe_1' }.locked", equalTo(false))
                .body("lessonAssignments.find { it.id == 'lp_pe_1' }.manuallyAdjusted", equalTo(true));

        given()
                .when().delete("/timetable-solutions/{jobId}", jobId)
                .then()
                .statusCode(204);
    }

    @Test
    void jobLifecycleKeepsDoubleBlockOnOneDayAndConsecutive() throws InterruptedException {
        String jobId = given()
                .contentType(ContentType.JSON)
                .body(doubleBlockProblem())
                .when().post("/timetable-solutions")
                .then()
                .statusCode(202)
                .body("jobId", notNullValue())
                .extract().path("jobId");

        Map<String, Object> status = waitUntilDone(jobId);
        assertEquals("NOT_SOLVING", status.get("solverStatus"));

        JsonPath solution = given()
                .when().get("/timetable-solutions/{jobId}", jobId)
                .then()
                .statusCode(200)
                .body("hardScore", equalTo(0))
                .extract().jsonPath();
        assertEquals(0, status.get("hardScore"), solution.prettify());
        List<Map<String, Object>> assignments = solution.getList("lessonAssignments");
        Map<String, Object> firstAssignment = assignments.stream()
                .filter(item -> "lp_double_1".equals(item.get("id")))
                .findFirst().orElseThrow();
        Map<String, Object> secondAssignment = assignments.stream()
                .filter(item -> "lp_double_2".equals(item.get("id")))
                .findFirst().orElseThrow();
        assertEquals("lp_double_block_1", firstAssignment.get("blockId"), assignments.toString());
        assertEquals("lp_double_block_1", secondAssignment.get("blockId"), assignments.toString());
        assertEquals(0, firstAssignment.get("blockIndex"), assignments.toString());
        assertEquals(1, secondAssignment.get("blockIndex"), assignments.toString());
        assertEquals(2, firstAssignment.get("blockSize"), assignments.toString());
        assertEquals(2, secondAssignment.get("blockSize"), assignments.toString());
        String firstSlot = String.valueOf(firstAssignment.get("timeSlot"));
        String secondSlot = String.valueOf(secondAssignment.get("timeSlot"));
        String[] firstParts = firstSlot.split("-");
        String[] secondParts = secondSlot.split("-");
        assertEquals(firstParts[0], secondParts[0]);
        assertEquals(
                Integer.parseInt(firstParts[1]) + 1,
                Integer.parseInt(secondParts[1]),
                "block slots: " + firstSlot + " / " + secondSlot
        );

        given()
                .when().delete("/timetable-solutions/{jobId}", jobId)
                .then()
                .statusCode(204);
    }

    @Test
    void jobLifecycleRepairsWarmStartedDoubleBlockBySwappingWithAnotherLesson() throws InterruptedException {
        String jobId = given()
                .contentType(ContentType.JSON)
                .body(warmStartedDoubleBlockSwapProblem())
                .when().post("/timetable-solutions")
                .then()
                .statusCode(202)
                .body("jobId", notNullValue())
                .extract().path("jobId");

        Map<String, Object> status = waitUntilDone(jobId);
        assertEquals("NOT_SOLVING", status.get("solverStatus"));

        JsonPath solution = given()
                .when().get("/timetable-solutions/{jobId}", jobId)
                .then()
                .statusCode(200)
                .extract().jsonPath();
        assertEquals(0, status.get("hardScore"), solution.prettify());
        List<Map<String, Object>> assignments = solution.getList("lessonAssignments");
        Map<String, Object> firstAssignment = assignments.stream()
                .filter(item -> "lp_double_1".equals(item.get("id")))
                .findFirst().orElseThrow();
        Map<String, Object> secondAssignment = assignments.stream()
                .filter(item -> "lp_double_2".equals(item.get("id")))
                .findFirst().orElseThrow();
        Map<String, Object> singleAssignment = assignments.stream()
                .filter(item -> "lp_single".equals(item.get("id")))
                .findFirst().orElseThrow();
        String firstSlot = String.valueOf(firstAssignment.get("timeSlot"));
        String secondSlot = String.valueOf(secondAssignment.get("timeSlot"));
        String singleSlot = String.valueOf(singleAssignment.get("timeSlot"));
        String[] firstParts = firstSlot.split("-");
        String[] secondParts = secondSlot.split("-");
        assertEquals(firstParts[0], secondParts[0]);
        assertEquals(Integer.parseInt(firstParts[1]) + 1, Integer.parseInt(secondParts[1]));
        assertEquals(3, java.util.Set.of(firstSlot, secondSlot, singleSlot).size());

        given()
                .when().delete("/timetable-solutions/{jobId}", jobId)
                .then()
                .statusCode(204);
    }

    private static Map<String, Object> waitUntilDone(String jobId) throws InterruptedException {
        Map<String, Object> status = null;
        for (int i = 0; i < 30; i++) {
            status = given()
                    .when().get("/timetable-solutions/{jobId}/status", jobId)
                    .then()
                    .statusCode(200)
                    .extract().jsonPath().getMap("$");
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

    private static Map<String, Object> manualProtectedProblem() {
        return Map.of(
                "name", "manual-protected-rest-test",
                "timeSlots", List.of(
                        slot("1-1", 1, 1),
                        slot("1-2", 1, 2),
                        slot("2-1", 2, 1)
                ),
                "rooms", List.of(Map.of("id", "__NONE__", "name", "None", "none", true)),
                "lessonAssignments", List.of(
                        protectedLesson("lp_math_1", "lp_math", "c1", "math", "t1", 0, "1-1", true, true),
                        lesson("lp_cn_1", "lp_cn", "c1", "chinese", "t2", 0),
                        protectedLesson("lp_pe_1", "lp_pe", "c2", "pe", "t3", 0, "2-1", false, true)
                )
        );
    }

    private static Map<String, Object> doubleBlockProblem() {
        return Map.of(
                "name", "double-block-rest-test",
                "timeSlots", List.of(
                        slot("1-1", 1, 1),
                        slot("1-2", 1, 2),
                        slot("1-3", 1, 3),
                        slot("2-1", 2, 1),
                        slot("2-2", 2, 2),
                        slot("2-3", 2, 3)
                ),
                "rooms", List.of(Map.of("id", "__NONE__", "name", "None", "none", true)),
                "lessonAssignments", List.of(
                        blockLesson("lp_double_1", 0),
                        blockLesson("lp_double_2", 1),
                        pinnedLesson("lp_blocker", "lp_blocker", "c-block", "chinese", "t-blocker", 0, "1-2")
                )
        );
    }

    private static Map<String, Object> warmStartedDoubleBlockSwapProblem() {
        Map<String, Object> firstBlockLesson = blockLesson("lp_double_1", 0);
        firstBlockLesson.put("timeSlot", "1-1");
        Map<String, Object> secondBlockLesson = blockLesson("lp_double_2", 1);
        secondBlockLesson.put("timeSlot", "1-3");
        Map<String, Object> singleLesson = new HashMap<>(
                lesson("lp_single", "lp_single", "c-block", "chinese", "t-single", 0)
        );
        singleLesson.put("timeSlot", "1-2");

        return Map.of(
                "name", "warm-started-double-block-swap-rest-test",
                "timeSlots", List.of(
                        slot("1-1", 1, 1),
                        slot("1-2", 1, 2),
                        slot("1-3", 1, 3)
                ),
                "rooms", List.of(Map.of("id", "__NONE__", "name", "None", "none", true)),
                "lessonAssignments", List.of(firstBlockLesson, secondBlockLesson, singleLesson)
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

    private static Map<String, Object> blockLesson(String id, int blockIndex) {
        Map<String, Object> lesson = new HashMap<>(lesson(
                id,
                "lp_double",
                "c-block",
                "math",
                "t-block",
                blockIndex
        ));
        lesson.put("blockId", "lp_double_block_1");
        lesson.put("blockIndex", blockIndex);
        lesson.put("blockSize", 2);
        return lesson;
    }

    private static Map<String, Object> protectedLesson(String id, String planId, String classId, String subjectId,
                                                       String teacherId, int sequence, String timeSlotId,
                                                       boolean locked, boolean manuallyAdjusted) {
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
                entry("locked", locked),
                entry("manuallyAdjusted", manuallyAdjusted),
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
