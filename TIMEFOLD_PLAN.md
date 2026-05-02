# Timefold Solver 集成计划

## 概述

在 `buildLocalArrangement()` 中**优先调用** Timefold 约束求解器做学生→座位分配，失败时自动回退现有的 `assignLocalSeats()` 贪心算法。

**职责边界**（三个不改）：
- AI（DeepSeek）仍负责：自然语言 → 结构化布局规格（组大小、过道策略、护法策略）
- 布局生成仍留在 Node：`buildExpandableClassroomLayout()` 产出网格
- Timefold 只负责：**给定布局和约束，把学生分配到座位格的最优解**

## 架构变化

```
当前:
  用户→Express→AI解析需求→assignLocalSeats()→返回座位表

改后:
  用户→Express→AI解析需求→await buildLocalArrangement()
       ├─ TIMEFOLD_SOLVER_URL 已配置 → POST http://localhost:8081/seating-solutions
       │     →轮询 GET /seating-solutions/{id}/status
       │     →获取解 GET /seating-solutions/{id}
       │     →转换→返回座位表
       └─ Timefold不可达/超时/硬违规 → assignLocalSeats() 回退
```

**重要：`buildLocalArrangement()` 改为 `async`**。因为内部需要 `await timefoldSolve()`，调用方 `runAiDrivenArrangement()`（已是 async）和所有现有调用点都必须加 `await`。

## 座位模型关键设计

### 两个独立概念：`groupId` 和 `neighborSeatIds`

```java
// Seat.java
public class Seat {
    @PlanningId
    private String id;                // "r0c0"
    private int row, col;
    private int qualityScore;         // 0-100, Gaussian

    // === 分组 ===
    private Integer groupId;          // 同组编号, null=不分组

    // === 物理相邻 ===
    // 预计算：遍历每对物理相邻 (Manhattan=1) 的座位格，
    // 如果之间没有 localAisle 分隔，则互加到此列表。
    // 注意：不限定同 groupId —— 回避相邻需要跨组也生效。
    private Set<String> neighborSeatIds;
}
```

**区别：**

| 概念 | 用途 | 范围 |
|------|------|------|
| `groupId` | 必须同桌（pair 约束） | 同组即为"同桌"，不要求物理相邻 |
| `neighborSeatIds` | 回避相邻、软约束邻座检查 | 物理相邻且不被 localAisle 分隔，**跨组也有效** |

**约束对应：**
- **必须同桌（pairNotSameGroup）**：优先 `s1.groupId == s2.groupId`（双方都有 groupId 时）；没有 groupId 时才退而用 `neighborSeatIds` 判断物理相邻
- **回避相邻（avoidAdjacent）**：只用 `neighborSeatIds`，不限定同组。两个回避学生在教室任何位置物理相邻都要惩罚

### 值域只放真实座位，过道不进入 solver 搜索空间

过道格**不提交给 Timefold**。Node bridge 在 `buildSeatList()` 时跳过 `CELL.AISLE` 格。值域天然不含过道，因此不需要 `aisleAssignment` 防御约束。

### 护法位处理（第一版）

Node 在调用 Timefold 之前先调用 `chooseGuardians()` 选出护法学生，这些学生从 solver 的 students 列表中排除。护法位不进入 Timefold 求解范围。

以后如需 Timefold 也选护法，可以把护法位建模为特殊 Seat（row=-1, col=0/1）。

## 文件变更清单

### 新建: Java 求解器模块 `solver/`

| 文件 | 用途 |
|------|------|
| `solver/pom.xml` | Maven 构建 (Java 21, Quarkus 3.34.5, Timefold 2.0.0) |
| `solver/src/main/java/com/icecream/seating/domain/Seat.java` | 问题事实：row, col, qualityScore, groupId, neighborSeatIds（**只含可坐座位，不含过道**） |
| `solver/src/main/java/com/icecream/seating/domain/StudentAssignment.java` | 规划实体：`@PlanningVariable Seat seat` |
| `solver/src/main/java/com/icecream/seating/domain/SeatingSolution.java` | 规划解 |
| `solver/src/main/java/com/icecream/seating/domain/SeatingConstraintConfig.java` | 软约束权重 + 策略开关 + frontRowThreshold/backRowThreshold |
| `solver/src/main/java/com/icecream/seating/domain/SolverJob.java` | `{ jobId, status, hardScore, softScore, score }` — 提交后返回 |
| `solver/src/main/java/com/icecream/seating/solver/SeatingConstraintProvider.java` | 约束定义（无 aisleAssignment，过道格不提交） |
| `solver/src/main/java/com/icecream/seating/rest/SeatingSolverResource.java` | REST API：POST/GET/DELETE `/seating-solutions` |
| `solver/src/main/resources/application.properties` | Quarkus 配置 (端口 8081, 默认求解 8s) |

### 新建: Node.js 桥接层

| 文件 | 用途 |
|------|------|
| `gateway/services/seating-solver-bridge.js` | `buildTimefoldProblem()`, `timefoldSolve()`, `transformSolutionToAssignments()`<br>包含 `computeNeighborSeatIds()` 预计算物理相邻 |

### 修改: 现有文件

| 文件 | 改动 |
|------|------|
| `gateway/services/seating-arrange.js` | `buildLocalArrangement()` **改为 async**：优先 `await timefoldSolve()`，失败回退贪心。调用方 `runAiDrivenArrangement()` 改为 `await buildLocalArrangement(...)` |
| `gateway/routes/tools.js` | health 端点增加 Timefold 状态上报 |
| `.env` | `TIMEFOLD_SOLVER_URL=` (默认空=不启用), `TIMEFOLD_SOLVER_TIMEOUT=8` |
| `package.json` | 新增 `solver`、`solver:build` 脚本 |

### 保留不变

- `assignLocalSeats()` 完整保留，一行不改
- AI 提示解析、布局生成、UI、聊天、导出、名单管理全部不动

## 约束模型

### Phase 1（最小可行）— 硬约束

| 约束 | Timefold 实现 | 说明 |
|------|-------------|------|
| seatConflict | `forEachUniquePair(equal seat).penalize(ONE_HARD)` | 不能两人同座 |
| pairNotSameGroup | `join(s1, s2).filter(mustPair).penalize(...)` | 优先同 groupId；无 group 时用 neighborSeatIds |
| frontRowViolation | `filter(mustFront && seat.row > frontThreshold).penalize(ONE_HARD)` | 必须前排 |
| backRowViolation | `filter(mustBack && seat.row < backThreshold).penalize(ONE_HARD)` | 必须后排 |
| avoidAdjacent | `forEachUniquePair.filter(avoid && neighborSeatIds).penalize(ONE_HARD)` | 回避→不可物理相邻（跨组） |

过道格**不提交给 Timefold**，值域天然不含它们，因此不需要 aisleAssignment 防御约束。

### pairNotSameGroup 的精确逻辑

```
if s1.mustPairWith 包含 s2.id:
    if s1.seat.groupId != null && s2.seat.groupId != null:
        if s1.seat.groupId == s2.seat.groupId → 满足
        else → 惩罚（同组才是同桌）
    else:
        if s1.seat.id in s2.seat.neighborSeatIds → 满足
        else → 惩罚（无分组时退而用物理相邻）
```

`frontThreshold` / `backThreshold` 由 Node 计算后通过 `SeatingConstraintConfig` 传入（usableRows 的前 1/3、后 1/3）。

### Phase 3（软约束）— 按策略开关启用

| 约束 | 权重 | 触发条件 |
|------|------|---------|
| seatQualityByGrade | 4/项 | gradeStrategy=priority 时，优生 seatQuality 低于阈值 → 惩罚 |
| genderBalance | 2/项 | genderBalance 启用时，同行 M/F 数量差 → 惩罚 |
| heightOrder | 3/项 | heightOrder 启用时，前排平均身高 > 后排+3cm → 惩罚 |
| gradeBalance | 5/项 | gradeStrategy=balance 时，行间成绩均差 >15 → 惩罚 |

权重可通过 `SeatingConstraintConfig` 从 Node 侧传入，允许 .env 或 AI 解析结果调参。

## REST API 契约

### POST /seating-solutions
```json
{
  "name": "Class 3A",
  "seats": [
    { "id": "r0c0", "row": 0, "col": 0, "qualityScore": 85,
      "groupId": 1, "neighborSeatIds": ["r0c1", "r1c0"] }
  ],
  "students": [
    { "id": "s01", "name": "张三", "gender": "M", "grade": 91, "height": 165,
      "mustFrontRow": false, "mustBackRow": false,
      "mustPairWith": ["s02"], "mustAvoidAdjacent": ["s03"] }
  ],
  "config": {
    "frontRowThreshold": 2, "backRowThreshold": 5,
    "genderBalanceEnabled": true, "heightOrderEnabled": false,
    "gradeStrategy": "priority"
  }
}
```
→ `202 Accepted`, body = `{ "jobId": "uuid-string" }`, header `Location: /seating-solutions/{jobId}`

### GET /seating-solutions/{jobId}
```json
{
  "name": "Class 3A",
  "seats": [...],
  "students": [
    { "id": "s01", "name": "张三", ..., "seat": "r0c0" }
  ],
  "config": {...},
  "hardScore": 0,
  "softScore": -12,
  "score": "0hard/-12soft",
  "solverStatus": "NOT_SOLVING"
}
```

**关键**：`hardScore` / `softScore` 为显式 int 字段，Node bridge 直接读 `data.hardScore < 0` 判断是否回退贪心，**不解析** score 字符串。

### GET /seating-solutions/{jobId}/status
→ `{ "jobId": "...", "name": "...", "hardScore": 0, "softScore": -12, "score": "0hard/-12soft", "solverStatus": "NOT_SOLVING" }`

### DELETE /seating-solutions/{jobId}
→ 返回当前最佳解

## 桥接层关键逻辑

```javascript
// computeNeighborSeatIds(seatList, localAisles):
//   预计算每个座位的物理相邻列表：
//   1. 物理相邻 (Manhattan=1)
//   2. 排除被 localAisle 分隔的对
//   3. 不限定同 groupId（回避相邻需要跨组判断）

// buildTimefoldProblem({ request, layout, spec, guardians }):
//   - buildSeatList(): 遍历 layout.cells，
//     * 过道格 (CELL.AISLE): 跳过，不提交到 Timefold
//     * 真实座位: 调用 calculateSeatScoreMap() 打分,
//       调用 computeNeighborSeatIds() 预计算物理相邻
//   - buildStudentAssignments(): 排除已选护法学生,
//     解析 request.constraints → mustPairWith/mustAvoidAdjacent

//   - 容量前置检查 (pre-solver guard):
//      if (solverStudents.length > nonAisleSeats.length) → 跳过 Timefold
//      (可坐座位不够，等一个必然硬违规的解毫无意义)

//   - buildConstraintConfig(): frontRowThreshold/backRowThreshold + 策略开关

// timefoldSolve(problem, { timeout = 8000 }):
//   POST → 轮询(status, 500ms间隔) → timeout抛错 → GET解 →
//   检查 data.hardScore < 0 → 抛错回退贪心 →
//   transformSolutionToAssignments()

// buildLocalArrangement() 改为 async:
//   export async function buildLocalArrangement(...) {
//     ...
//     const nonAisleSeats = countNonAisleSeats(layout);
//     const solverStudents = students.filter(s => !guardianIds.has(s.id));
//
//     if (process.env.TIMEFOLD_SOLVER_URL && solverStudents.length <= nonAisleSeats) {
//       try {
//         const problem = buildTimefoldProblem(...);
//         return await timefoldSolve(problem, { timeout: +process.env.TIMEFOLD_SOLVER_TIMEOUT || 8 });
//       } catch (e) {
//         log.warn('Timefold failed, fallback to greedy:', e.message);
//       }
//     }
//     return assignLocalSeats(...);
//   }

// runAiDrivenArrangement() 中改为:
//   const arrangement = await buildLocalArrangement(...);
```

## 构建与运行

```bash
# 开发 (Timefold 可选, 不配置则用贪心)
npm run dev

# 启用 Timefold (需 Java 21 + Maven)
cd solver && mvnw quarkus:dev    # Terminal 2: Timefold at :8081
TIMEFOLD_SOLVER_URL=http://localhost:8081 npm run dev  # Terminal 1

# 生产构建
cd solver && mvnw package -DskipTests
java -jar solver/target/quarkus-app/quarkus-run.jar &
TIMEFOLD_SOLVER_URL=http://localhost:8081 node gateway/server.js
```

## 测试策略

### Java 约束测试
`SeatingConstraintProviderTest.java` — `ConstraintVerifier` 逐条验证：
- 同座→硬惩罚
- pairNotSameGroup：两个 mustPair 学生不同 groupId → 惩罚；无 group 时不同 neighborSeatIds → 惩罚
- avoidAdjacent：两个 avoid 学生在 neighborSeatIds 内 → 惩罚（包括跨组）
- frontRow/backRow：阈值判断

### Java 集成测试
`SeatingSolverResourceTest.java` — REST Assured 验证：
- POST→poll→GET 完整流程
- 返回值含 `hardScore` / `softScore` / `score` 三个字段

### Node bridge 测试
`test/seating-solver-bridge.test.js`：
- `computeNeighborSeatIds` 正确排除 localAisle（不限定 groupId）
- `buildTimefoldProblem` 正确排除护法学生、过道格不在提交的 seats 里
- `transformSolutionToAssignments` 往返正确
- `hardScore < 0` 时正确抛错回退

### 质量对比测试（关键）
`test/seating-quality-compare.test.js` — 用固定班级 fixture：

**评分方式**：Timefold 结果先 `transformSolutionToAssignments()` 转回内部 layout 格式，然后和贪心结果统一用 `evaluateSeatingQuality()` 评分（同一个评分器，消除评分标准差异）。

- 同输入下 Timefold 解 `feasible = true`（hardScore = 0）
- 同输入下 Timefold 解 `softScore >=` 贪心 softScore（或 `percent >=` 贪心 percent）
- fixture 覆盖：普通座位 / 分组座位 / 有 localAisle 的分组 / 有回避约束跨组 / 有前排约束

### 现有测试
全部保持通过。`assignLocalSeats()` 被直接调用的测试不受影响。`buildLocalArrangement()` 的调用点需加 `await`（已在 Phase 2 中一并修改）。

## 回退策略

**自动回退触发条件：**
1. `TIMEFOLD_SOLVER_URL` 未配置或为空 → 直接用贪心
2. Timefold 连接拒绝 → try/catch 回退贪心
3. 求解超时（默认 8s，可配 `TIMEFOLD_SOLVER_TIMEOUT`）→ 回退贪心
4. 返回解 `hardScore < 0` → 丢弃，回退贪心
5. 学生数 > 可坐座位数 → 跳过 Timefold（容量前置检查）

**完全禁用**: 删除 `.env` 中 `TIMEFOLD_SOLVER_URL` 或设为空。

## 分阶段实施

### Phase 1: 最小 Java spike（硬约束 + 基础 seat 模型）
- `solver/pom.xml`、`application.properties`（端口 8081, 8s 超时）
- Domain: Seat（含 groupId + neighborSeatIds）、StudentAssignment、SeatingSolution、SolverJob、SeatingConstraintConfig（**不含过道**）
- ConstraintProvider: seatConflict, pairNotSameGroup, frontRow, backRow, avoidAdjacent（5 条硬约束）
- REST Resource: POST/GET/status/DELETE，POST 返回 `{ jobId }` + Location header，解含显式 hardScore/softScore
- Java 单元测试 + 集成测试
- **此阶段 Timefold 已可独立运行和测试，但不接入 Node**

### Phase 2: Node bridge + 特性开关
- `gateway/services/seating-solver-bridge.js`：computeNeighborSeatIds, buildTimefoldProblem, timefoldSolve, transformSolutionToAssignments
- 修改 `seating-arrange.js`：`buildLocalArrangement()` 改为 **async**，`runAiDrivenArrangement()` 中加 `await`
- 修改 `tools.js`：health 端点加 Timefold 状态
- `.env` 默认 `TIMEFOLD_SOLVER_URL=`（空=不启用）
- `package.json` 加脚本
- Node bridge 测试 + 第一个 fixture 测试
- **此阶段可手动开启 Timefold 进行对比测试**

### Phase 3: 软约束 + groupId/localAisles 完善
- ConstraintProvider 补全：seatQualityByGrade, genderBalance, heightOrder, gradeBalance
- `computeNeighborSeatIds` 正确处理 localAisle（不限定 groupId）
- SeatingConstraintConfig 从 Node 传入阈值和权重
- 质量对比 fixture 覆盖分组 + localAisle + 跨组回避场景
- **此阶段 Timefold 排座质量应全面优于贪心**

### Phase 4: 设为默认优先路径
- `.env` 默认 `TIMEFOLD_SOLVER_URL=http://localhost:8081`
- `TIMEFOLD_SOLVER_TIMEOUT=8`
- 加日志监控求解成功率
- 全量质量对比测试通过
- **正式上线**

## 前置条件

- **Java 21** (`java -version`)
- **Maven 3.9+** 或 Maven Wrapper (`mvnw`)
- Timefold 社区版 (Apache 2.0，无需 license)

## 验证步骤

1. `cd solver && mvnw test` — Java 测试通过
2. `cd solver && mvnw quarkus:dev` — Timefold 在 :8081 启动，Swagger UI 在 `/q/swagger-ui`
3. `npm test` — Node.js 全部测试通过（含 bridge + quality-compare）
4. 开启 Timefold → 手动生成座位表 → 评分面板确认硬约束=0，软分≥贪心
5. 关闭 Timefold → 再次生成 → 确认自动回退贪心，体验无感知
