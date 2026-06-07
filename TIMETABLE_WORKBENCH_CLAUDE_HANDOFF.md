# Timetable Workbench Claude Handoff

## Background

This repository is `ICeCream`, a local teaching assistant platform. The current task is to fix the timetable planner / scheduling workbench.

The user is unhappy with the current timetable UI and logic. The previous Codex pass attempted a refactor, but the result is still not acceptable. Please review the implementation critically rather than assuming the previous changes are good.

Current relevant area:

- Frontend entry: `public/js/tools/timetable-planner.js`
- Frontend modules: `public/js/tools/timetable/`
- Frontend styles: `public/css/timetable-planner.css`
- Node routes: `gateway/routes/timetable.js`
- Node scheduling/bridge services: `gateway/services/timetable-*.js`
- Java Timefold solver: `solver/`
- Startup script: `dev.bat`

Important constraint: do not touch unrelated GeoGebra files or Manim canvas generated files unless absolutely necessary.

## User-Visible Problems To Recheck

The user reported that the UI is still wrong and the logic is still wrong.

Known symptoms from screenshots and discussion:

- The timetable grid previously had huge blank header/row space and only later periods appeared clearly.
- The "pending lessons" queue was placed inside the main timetable area, making the center view cramped and semantically wrong.
- The right inspector was too empty when no lesson was selected.
- Timefold previously returned 404, then later changed to timeout.
- A large schedule around `690` lesson-hours can time out under the current synchronous solve flow.
- The UI should behave like an academic affairs workbench, not a decorative landing page.

Please verify the current browser state yourself before editing. The previous pass claims the queue moved to the inspector and the grid rows were fixed, but the user says it is still not good enough.

## Product Direction

Build a practical "教务排课工作台":

- Left panel: project data, import, constraints, export.
- Center panel: the timetable grid only. It should be visually dominant, dense, and usable for repeated operations.
- Right panel: selected lesson details, pending lessons, conflicts, solver state, and failure reason.
- Views: class view, teacher view, master view.
- Manual adjustment should remain block-aware for consecutive lessons.
- Official generation path must remain Timefold. Node should not silently save a local fallback schedule from the one-click generate route.
- Failed solve must keep the saved old schedule.

## What Codex Already Changed

Recent changes include:

- Split timetable frontend into native JS modules under `public/js/tools/timetable/`.
- Moved some pending-course rendering logic into `view.js`.
- Changed CSS in `public/css/timetable-planner.css`.
- Added timeout handling in `gateway/services/timetable-solver-bridge.js`.
- Changed `solver/src/main/resources/application.properties` to use `TIMETABLE_SOLVER_SPENT_LIMIT`.
- Added `TIMETABLE_SOLVER_TIMEOUT` and `TIMETABLE_SOLVER_SPENT_LIMIT` defaults in `dev.bat`.
- Added/updated tests:
  - `test/timetable-planner-ui.test.js`
  - `test/timetable-scheduler.test.js`
  - `test/timetable-solver-bridge.test.js`
  - `test/manim-env-check.test.js`

Do not trust these changes blindly. Use them as context and improve or replace them where needed.

## Required Rework

### 1. Browser-first UI review

Start the local app and inspect the actual timetable planner in a browser.

Check desktop around `1920x1080` and mobile around `390x844`.

Look for:

- Does the center grid show periods 1 through 7 clearly?
- Does the grid use horizontal scrolling on mobile instead of crushing columns?
- Is the right panel useful before selecting a lesson?
- Is pending work clearly separated from the timetable grid?
- Are buttons and labels readable?
- Are there any overlapping controls?
- Does the workbench look like a utilitarian school scheduling tool?

### 2. Improve the UI structure if needed

If the current layout is still awkward, refactor it decisively:

- The center schedule panel should be just toolbar + grid + solve progress/failure status.
- Pending lessons should live in the right inspector or a clearly separate bottom drawer, not inside the grid.
- The inspector default state should show:
  - current view
  - current owner
  - placed/total
  - pending lessons
  - conflicts
  - solver failure reason
  - old schedule kept state
- Selected-slot state should show:
  - subject
  - class
  - teacher(s)
  - room
  - block/consecutive lesson info
  - locked status
  - conflict status
  - lock/clear actions

### 3. Recheck scheduling logic

Confirm:

- `/api/tools/timetable/schedule/run` only calls Timefold.
- It does not save a schedule on Timefold failure, timeout, hard score failure, incomplete solution, or validation failure.
- Failure response keeps the current saved project/schedule.
- `/schedule/adjust` remains block-aware and does not save failed adjustments.
- multi-teacher conflicts, room conflicts, locked slots, and unavailable slots are represented consistently between Node and Java.

### 4. Recheck Timefold timeout semantics

The intended behavior is:

- Node wait timeout default: `TIMETABLE_SOLVER_TIMEOUT=660` seconds.
- Java solver spent limit default: `TIMETABLE_SOLVER_SPENT_LIMIT=600s`.
- Timeout response should use `reason: "timeout"`.
- `solverStats` should include useful scale/time data:
  - `lessonCount`
  - `assignmentCount`
  - `timeoutSeconds`
  - `durationMs`
  - `jobId` if available
  - `solverStatus` if available
- UI should show a short Chinese message:
  - `Timefold 求解超时，旧课表已保留。`

## Suggested Implementation Approach

Use TDD, but do not overfit to string-only tests.

Recommended order:

1. Run current tests and browser inspection.
2. Add failing tests for the actual defects you observe.
3. Fix UI and scheduling behavior.
4. Run full verification.
5. Re-open browser and visually inspect again.

Prefer behavior tests over fragile exact HTML-string assertions.

## Verification Commands

Run:

```powershell
npm test
cd solver
.\mvnw.cmd test
cd ..
.\dev.bat --check
```

Then start the app and inspect the timetable planner in browser.

## Acceptance Criteria

The fix is acceptable only if:

- The main grid is not blank or stretched.
- Periods `第1节` through `第7节` are visible or reachable naturally.
- Pending lessons are not inside `.tt-schedule-body`.
- Pending lessons are visible in the inspector when no lesson is selected.
- No selected lesson state is still useful.
- Timefold timeout does not overwrite the old schedule.
- The UI failure copy clearly says the old schedule was kept.
- Desktop and mobile screenshots show no obvious text overlap or broken panels.
- `npm test`, solver Maven tests, and `dev.bat --check` pass.

## Notes

The working tree may already contain many uncommitted timetable-related changes from the previous pass. Do not revert unrelated user changes. Work with the current state.

If you find that the previous refactor made the page worse, it is acceptable to simplify the UI and remove unnecessary abstractions, as long as public API routes and project data compatibility remain intact.
