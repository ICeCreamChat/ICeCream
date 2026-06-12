# ICeCream 商业级排课系统优化方案

## 1. 现状分析

### 1.1 现有架构
- **求解器**: Timefold Solver (Java) - 基于约束满足的优化引擎
- **Agent架构**: Node.js + Skills模式
- **Skills**: data-prep, constraint, solve-plan, solve, diagnosis, publication
- **约束**: 15个基础约束（7硬约束 + 8软约束）

### 1.2 主要问题
1. **约束简单**: 缺少商业场景的复杂需求（走班制、选课、分层教学等）
2. **单一求解**: 未充分利用多agent并行探索不同策略
3. **质量评估不足**: 缺少多维度质量评估和用户满意度量化
4. **中国特色缺失**: 未考虑国家课程标准、教师工作量规范等

## 2. 商业级排课核心需求

### 2.1 中国中小学排课特点

#### 国家课程标准约束
- **课程结构**: 国家课程 + 地方课程 + 校本课程
- **课时要求**: 语数外等主科每周4-6节，其他科目按标准配置
- **体育要求**: 体育课不能连排，每天必须有阳光体育活动
- **实验课程**: 物理、化学、生物实验需要专用教室

#### 教师工作量平衡
- **周课时上限**: 专任教师12-18节，班主任适当减少
- **连续授课限制**: 不宜超过3节连续上课
- **跨年级教学**: 同一教师跨年级授课的节次间隔
- **备课时间**: 同一科目不同班级需要间隔安排

#### 学生学习规律
- **黄金时段**: 上午2-4节为最佳学习时段，安排主科
- **疲劳规律**: 避免下午连续安排高强度科目
- **科目搭配**: 文理交替、动静结合
- **作业负担**: 考虑课后作业总量的均衡

#### 走班制排课（高中新课改）
- **选课组合**: 3+1+2模式下的多种选课组合
- **行政班与教学班**: 行政班固定，教学班流动
- **教室资源**: 专用教室、实验室的复用和调度
- **走班时段**: 集中安排走班课程，避免频繁切换

### 2.2 质量评估维度

#### 硬约束（必须满足）
- 教师时间冲突
- 班级时间冲突
- 教室容量和类型
- 固定课节（如体育、实验）
- 教师不可用时段

#### 软约束（优化目标）
- 教师工作量均衡（日均方差）
- 学生课表质量（主科分布、疲劳度）
- 教室利用率
- 连续课节合理性
- 空档最小化
- 跨校区调度成本

#### 用户满意度
- 教师满意度（工作量、时段偏好）
- 学生满意度（课表紧凑性、黄金时段）
- 管理员满意度（调整灵活性、冲突处理）

## 3. 多Agent优化架构设计

### 3.1 整体架构

```
TimetableMasterAgent (协调者)
├── DataValidationAgent (数据验证)
├── ConstraintAnalysisAgent (约束分析)
├── ParallelSolverAgents (并行求解 - 3-5个)
│   ├── GreedySolverAgent (贪心策略)
│   ├── SimulatedAnnealingSolverAgent (模拟退火)
│   ├── TimefoldSolverAgent (Timefold优化)
│   ├── HybridSolverAgent (混合策略)
│   └── AdaptiveSolverAgent (自适应策略)
├── QualityEvaluationAgent (质量评估)
├── ConflictResolutionAgent (冲突解决)
└── ReportGenerationAgent (报告生成)
```

### 3.2 核心Skills增强

#### 新增Skills
1. **chinese-curriculum-skill**: 国家课程标准检查
2. **workload-balance-skill**: 教师工作量智能平衡
3. **walking-class-skill**: 走班制排课专项处理
4. **quality-optimization-skill**: 多维质量优化
5. **adaptive-tuning-skill**: 参数自适应调优
6. **conflict-auto-resolve-skill**: 智能冲突解决

#### 增强现有Skills
- **constraint-skill**: 增加中国教育场景约束模板
- **solve-skill**: 支持多策略并行求解
- **diagnosis-skill**: 增加智能建议和自动修复

### 3.3 多Agent并行求解流程

```
1. Master接收排课任务
2. DataValidation验证数据完整性
3. ConstraintAnalysis分析约束复杂度
4. 启动3-5个ParallelSolver（不同策略）
   ├── 策略A: 优先主科黄金时段
   ├── 策略B: 优先教师工作量平衡
   ├── 策略C: 优先学生疲劳度优化
   ├── 策略D: 混合策略
   └── 策略E: 基于历史数据自适应
5. QualityEvaluation对所有方案评分
6. ConflictResolution处理冲突
7. 返回Top3方案 + 详细对比报告
```

## 4. 增强约束系统

### 4.1 新增硬约束

```java
// 国家课程标准约束
Constraint nationalCurriculumStandard(ConstraintFactory factory)
Constraint dailySportsRequirement(ConstraintFactory factory)
Constraint experimentRoomRequirement(ConstraintFactory factory)

// 走班制约束
Constraint walkingClassTimeAlignment(ConstraintFactory factory)
Constraint administrativeClassStability(ConstraintFactory factory)

// 教师工作量约束
Constraint teacherWeeklyHourLimit(ConstraintFactory factory)
Constraint teacherContinuousTeachingLimit(ConstraintFactory factory)
```

### 4.2 新增软约束

```java
// 学生学习规律
Constraint goldenHourMainSubjects(ConstraintFactory factory)
Constraint subjectAlternation(ConstraintFactory factory)
Constraint afternoonFatigueAvoidance(ConstraintFactory factory)

// 教师工作量平衡
Constraint teacherDailyLoadVariance(ConstraintFactory factory)
Constraint teacherPreparationTimeGap(ConstraintFactory factory)
Constraint teacherCrossGradeInterval(ConstraintFactory factory)

// 教室资源优化
Constraint classroomUtilizationRate(ConstraintFactory factory)
Constraint specialRoomScheduleConcentration(ConstraintFactory factory)
```

### 4.3 约束权重动态调整

```javascript
// 根据学校类型、年级、时期自动调整约束权重
const getConstraintWeights = (context) => {
  const { schoolType, grade, term, mode } = context;
  
  // 高中走班模式
  if (schoolType === 'high' && mode === 'walking') {
    return {
      walkingClassAlignment: 100,  // 极高
      administrativeClassStability: 90,
      teacherLoad: 70,
      studentQuality: 80
    };
  }
  
  // 初中固定班级模式
  if (schoolType === 'middle') {
    return {
      teacherLoad: 90,
      studentQuality: 85,
      mainSubjectGoldenHour: 80,
      sportsDistribution: 85
    };
  }
  
  // 小学模式
  return {
    teacherLoad: 85,
    studentQuality: 90,
    simplicity: 80  // 课表简洁性
  };
};
```

## 5. 质量评估体系

### 5.1 综合评分模型

```javascript
const calculateOverallScore = (schedule, context) => {
  const scores = {
    // 基础得分 (40分)
    hardConstraints: checkHardConstraints(schedule) * 40,
    
    // 教师维度 (25分)
    teacherBalance: evaluateTeacherWorkload(schedule) * 10,
    teacherSatisfaction: evaluateTeacherPreference(schedule) * 8,
    teacherEfficiency: evaluateTeacherScheduleQuality(schedule) * 7,
    
    // 学生维度 (25分)
    learningQuality: evaluateStudentScheduleQuality(schedule) * 12,
    fatigueManagement: evaluateFatigueDistribution(schedule) * 8,
    courseDistribution: evaluateCourseSpread(schedule) * 5,
    
    // 资源维度 (10分)
    classroomUtilization: evaluateRoomUsage(schedule) * 5,
    timeSlotEfficiency: evaluateTimeEfficiency(schedule) * 5
  };
  
  return {
    total: Object.values(scores).reduce((a, b) => a + b, 0),
    breakdown: scores,
    grade: getGrade(scores.total)  // A+, A, B+, B, C
  };
};
```

### 5.2 对比分析报告

```javascript
const generateComparisonReport = (solutions) => {
  return {
    solutions: solutions.map(s => ({
      id: s.id,
      strategy: s.strategy,
      score: s.score,
      metrics: s.metrics,
      highlights: extractHighlights(s),
      weaknesses: extractWeaknesses(s)
    })),
    recommendation: selectBestSolution(solutions),
    tradeoffs: analyzeTradeoffs(solutions),
    visualizations: generateCharts(solutions)
  };
};
```

## 6. 实施路线图

### Phase 1: 基础增强 (当前阶段)
- [x] 分析现有系统架构
- [ ] 增强约束系统（国家课程标准）
- [ ] 实现质量评估体系
- [ ] 优化现有Skills

### Phase 2: 多Agent架构 (核心)
- [ ] 实现MasterAgent协调器
- [ ] 实现3-5个并行求解策略
- [ ] 实现智能冲突解决
- [ ] 实现方案对比和推荐

### Phase 3: 走班制专项 (高级)
- [ ] 走班制约束建模
- [ ] 行政班/教学班双轨调度
- [ ] 教室资源动态分配
- [ ] 选课组合优化

### Phase 4: 智能优化 (高级)
- [ ] 历史数据学习
- [ ] 参数自适应调优
- [ ] 智能建议系统
- [ ] A/B测试框架

## 7. 技术实现要点

### 7.1 并行求解实现

```javascript
// 使用Workflow实现多策略并行求解
export const parallelSolveWorkflow = `
export const meta = {
  name: 'parallel-timetable-solve',
  description: '并行多策略排课求解',
  phases: [
    { title: 'Prepare', detail: '数据验证和约束分析' },
    { title: 'Solve', detail: '5个策略并行求解' },
    { title: 'Evaluate', detail: '质量评估和排序' },
    { title: 'Report', detail: '生成对比报告' }
  ]
};

phase('Prepare');
const validation = await agent('验证排课数据完整性', {
  schema: DATA_VALIDATION_SCHEMA,
  label: '数据验证'
});

if (!validation.ok) {
  return { error: validation.message };
}

phase('Solve');
const strategies = [
  { name: 'greedy', priority: 'teacher-first' },
  { name: 'balanced', priority: 'balanced' },
  { name: 'student-first', priority: 'learning-quality' },
  { name: 'timefold', priority: 'optimal' },
  { name: 'adaptive', priority: 'context-aware' }
];

const solutions = await parallel(strategies.map(strategy => 
  () => agent(\`使用\${strategy.name}策略求解排课\`, {
    schema: SOLUTION_SCHEMA,
    label: strategy.name,
    phase: 'Solve'
  })
));

phase('Evaluate');
const evaluated = await agent('评估所有方案质量并排序', {
  schema: EVALUATION_SCHEMA,
  label: '质量评估'
});

phase('Report');
const report = await agent('生成详细对比报告', {
  schema: REPORT_SCHEMA,
  label: '报告生成'
});

return {
  solutions: evaluated.rankedSolutions,
  recommendation: evaluated.best,
  report
};
`;
```

### 7.2 约束权重优化

使用遗传算法或贝叶斯优化自动调整约束权重：

```java
public class AdaptiveConstraintWeightOptimizer {
    
    // 基于历史反馈优化权重
    public Map<String, Integer> optimizeWeights(
        List<HistoricalFeedback> feedback,
        SchoolContext context
    ) {
        // 初始权重
        Map<String, Integer> weights = getDefaultWeights(context);
        
        // 分析历史反馈
        for (HistoricalFeedback fb : feedback) {
            if (fb.getUserSatisfaction() < 0.7) {
                // 用户不满意的维度增加权重
                weights.put(fb.getUnsatisfiedDimension(),
                    weights.get(fb.getUnsatisfiedDimension()) + 5);
            }
        }
        
        // 归一化
        return normalizeWeights(weights);
    }
}
```

### 7.3 冲突智能解决

```javascript
const autoResolveConflicts = async (schedule, conflicts) => {
  const strategies = [
    { name: 'swap-slots', priority: 1 },
    { name: 'adjust-teacher', priority: 2 },
    { name: 'split-block', priority: 3 },
    { name: 'relax-constraint', priority: 4 }
  ];
  
  for (const conflict of conflicts) {
    for (const strategy of strategies) {
      const resolution = await tryResolveStrategy(
        schedule, 
        conflict, 
        strategy
      );
      
      if (resolution.success) {
        return resolution;
      }
    }
  }
  
  return { success: false, suggestions: generateManualSuggestions(conflicts) };
};
```

## 8. 成功指标

### 8.1 性能指标
- **求解速度**: 500课时以内 < 60秒（95%的案例）
- **并行效率**: 5个agent并行加速比 > 3
- **内存占用**: < 2GB（单次求解）

### 8.2 质量指标
- **硬约束满足率**: 100%（商业必需）
- **综合评分**: 平均 > 85分（满分100）
- **用户满意度**: > 90%（A/B测试）

### 8.3 功能指标
- **走班制支持**: 支持3+1+2全部选课组合
- **约束覆盖**: 覆盖中国教育90%+常见场景
- **智能度**: 80%+的冲突可自动解决

## 9. 后续展望

### 9.1 AI增强
- 大模型理解自然语言约束
- 从历史课表学习学校偏好
- 智能推荐最优策略组合

### 9.2 可视化分析
- 课表热力图
- 教师工作量雷达图
- 冲突关系网络图
- 优化过程动画

### 9.3 协同排课
- 多校区联合排课
- 集团校资源共享
- 跨校选修课调度

---

**文档版本**: 1.0  
**更新日期**: 2026-06-13  
**负责人**: Claude Agent Team
