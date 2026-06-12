/**
 * 并行多策略排课求解工作流
 * 使用5种不同策略同时求解，返回最优3个方案供用户选择
 */

export const meta = {
  name: 'parallel-timetable-solve',
  description: '并行多策略智能排课，自动选择最优方案',
  phases: [
    { title: 'Validate', detail: '数据完整性验证和约束分析' },
    { title: 'ParallelSolve', detail: '5种策略并行求解' },
    { title: 'Evaluate', detail: '质量评估和方案排序' },
    { title: 'Report', detail: '生成对比报告和推荐' }
  ]
};

// 方案评分Schema
const SOLUTION_EVALUATION_SCHEMA = {
  type: 'object',
  required: ['solutionId', 'scores', 'totalScore', 'grade', 'issues'],
  properties: {
    solutionId: { type: 'string' },
    scores: {
      type: 'object',
      required: ['hardConstraints', 'teacherBalance', 'studentQuality', 'resourceUtilization'],
      properties: {
        hardConstraints: { type: 'number', minimum: 0, maximum: 40 },
        teacherBalance: { type: 'number', minimum: 0, maximum: 25 },
        studentQuality: { type: 'number', minimum: 0, maximum: 25 },
        resourceUtilization: { type: 'number', minimum: 0, maximum: 10 }
      }
    },
    totalScore: { type: 'number', minimum: 0, maximum: 100 },
    grade: { type: 'string', enum: ['A+', 'A', 'B+', 'B', 'C', 'D', 'F'] },
    issues: { type: 'array', items: { type: 'object' } },
    highlights: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } }
  }
};

// 对比报告Schema
const COMPARISON_REPORT_SCHEMA = {
  type: 'object',
  required: ['topSolutions', 'recommendation', 'tradeoffAnalysis'],
  properties: {
    topSolutions: {
      type: 'array',
      items: { type: 'object' },
      minItems: 1,
      maxItems: 3
    },
    recommendation: {
      type: 'object',
      required: ['solutionId', 'reason'],
      properties: {
        solutionId: { type: 'string' },
        reason: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 }
      }
    },
    tradeoffAnalysis: {
      type: 'object',
      properties: {
        teacherVsStudent: { type: 'string' },
        qualityVsSpeed: { type: 'string' },
        flexibilityVsStability: { type: 'string' }
      }
    },
    summary: { type: 'string' }
  }
};

// ============ Phase 1: 数据验证 ============
phase('Validate');
log('开始验证排课数据...');

const validation = await agent(
  '验证排课项目数据的完整性，包括：1) 班级数量和完整性 2) 教师数量和任课关系 3) 课程设置 4) 周几和节次范围 5) 任课计划总课时数。返回验证结果，如果有阻塞性问题必须说明。',
  {
    phase: 'Validate',
    label: '数据验证',
    schema: {
      type: 'object',
      required: ['ok', 'issues', 'stats'],
      properties: {
        ok: { type: 'boolean' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            required: ['severity', 'type', 'message'],
            properties: {
              severity: { type: 'string', enum: ['error', 'warning', 'info'] },
              type: { type: 'string' },
              message: { type: 'string' }
            }
          }
        },
        stats: {
          type: 'object',
          properties: {
            classCount: { type: 'number' },
            teacherCount: { type: 'number' },
            subjectCount: { type: 'number' },
            totalLessons: { type: 'number' },
            availableSlots: { type: 'number' }
          }
        }
      }
    }
  }
);

if (!validation.ok) {
  log('数据验证未通过，终止求解流程');
  return {
    success: false,
    error: '数据验证失败',
    issues: validation.issues,
    phase: 'validation_failed'
  };
}

log(`数据验证通过：${validation.stats.classCount}个班级，${validation.stats.teacherCount}位教师，${validation.stats.totalLessons}节课`);

// ============ Phase 2: 并行多策略求解 ============
phase('ParallelSolve');
log('启动5种策略并行求解...');

const strategies = [
  {
    name: 'teacher-priority',
    description: '教师优先策略：优先平衡教师工作量和时段偏好，适合教师资源紧张的学校',
    agentPrompt: '使用教师优先策略生成排课方案：1) 优先确保教师工作量均衡 2) 尊重教师时段偏好 3) 避免教师过度疲劳 4) 合理安排跨班级教学。返回完整排课结果。'
  },
  {
    name: 'student-priority',
    description: '学生优先策略：优先学生学习质量和课表紧凑性，适合重点关注教学效果的学校',
    agentPrompt: '使用学生优先策略生成排课方案：1) 主科安排在黄金时段（上午2-4节）2) 文理科目交替 3) 避免下午疲劳时段安排难课 4) 课表紧凑减少空档。返回完整排课结果。'
  },
  {
    name: 'balanced',
    description: '均衡策略：教师和学生兼顾，各项指标均衡，适合大多数学校',
    agentPrompt: '使用均衡策略生成排课方案：综合考虑教师工作量、学生学习质量、教室利用率等多个维度，追求整体最优。返回完整排课结果。'
  },
  {
    name: 'chinese-standard',
    description: '国标优先策略：严格遵循中国课程标准和教学规律，适合规范化管理的学校',
    agentPrompt: '使用中国课程标准策略生成排课方案：1) 严格遵守课程标准课时要求 2) 体育课分散不连排 3) 实验课安排专用教室 4) 主科黄金时段 5) 教师周课时符合规范。返回完整排课结果。'
  },
  {
    name: 'adaptive',
    description: '自适应策略：根据当前项目特点动态调整优化目标，适合特殊需求学校',
    agentPrompt: '分析当前排课项目特点（班级数、教师数、课时密度等），自适应选择最合适的优化策略并生成排课方案。返回完整排课结果和选择理由。'
  }
];

const solutionSchema = {
  type: 'object',
  required: ['strategy', 'schedule', 'metrics'],
  properties: {
    strategy: { type: 'string' },
    schedule: {
      type: 'object',
      required: ['slots', 'unplaced'],
      properties: {
        slots: { type: 'array' },
        unplaced: { type: 'array' },
        conflicts: { type: 'array' }
      }
    },
    metrics: {
      type: 'object',
      properties: {
        hardConflicts: { type: 'number' },
        placedLessons: { type: 'number' },
        totalLessons: { type: 'number' },
        teacherLoadVariance: { type: 'number' },
        goldenHourUtilization: { type: 'number' }
      }
    },
    solverTime: { type: 'number' }
  }
};

// 并行执行5个策略
const solutions = await parallel(
  strategies.map(strategy =>
    () => agent(strategy.agentPrompt, {
      phase: 'ParallelSolve',
      label: strategy.name,
      schema: solutionSchema
    })
  )
);

// 过滤失败的方案
const validSolutions = solutions.filter(Boolean);

if (validSolutions.length === 0) {
  log('所有策略均求解失败');
  return {
    success: false,
    error: '所有求解策略均失败',
    phase: 'solve_failed'
  };
}

log(`成功生成${validSolutions.length}个候选方案`);

// ============ Phase 3: 质量评估 ============
phase('Evaluate');
log('开始评估方案质量...');

// 为每个方案评分
const evaluations = await parallel(
  validSolutions.map((solution, index) =>
    () => agent(
      `对排课方案进行全面质量评估，包括：
1. 硬约束满足度（40分）：教师冲突、班级冲突、教室要求等
2. 教师维度（25分）：工作量均衡、时段偏好、连续授课合理性
3. 学生维度（25分）：主科时段质量、课程分布、疲劳度管理
4. 资源维度（10分）：教室利用率、时段效率

方案策略：${solution.strategy}
已放置课节：${solution.metrics.placedLessons}/${solution.metrics.totalLessons}
硬冲突数：${solution.metrics.hardConflicts}

返回详细评分、总分、等级、亮点和不足。`,
      {
        phase: 'Evaluate',
        label: `评估-${solution.strategy}`,
        schema: SOLUTION_EVALUATION_SCHEMA
      }
    )
  )
);

// 按总分排序
const rankedSolutions = validSolutions
  .map((solution, i) => ({
    ...solution,
    evaluation: evaluations[i],
    rank: 0
  }))
  .filter(s => s.evaluation)
  .sort((a, b) => b.evaluation.totalScore - a.evaluation.totalScore)
  .map((s, i) => ({ ...s, rank: i + 1 }));

if (rankedSolutions.length === 0) {
  return {
    success: false,
    error: '所有方案评估失败',
    phase: 'evaluation_failed'
  };
}

log(`方案排序完成，最高分：${rankedSolutions[0].evaluation.totalScore}分（${rankedSolutions[0].evaluation.grade}）`);

// 取前3名
const topSolutions = rankedSolutions.slice(0, 3);

// ============ Phase 4: 生成对比报告 ============
phase('Report');
log('生成对比分析报告...');

const comparisonReport = await agent(
  `生成3个最优排课方案的对比分析报告：

方案1（排名${topSolutions[0].rank}）：
- 策略：${topSolutions[0].strategy}
- 总分：${topSolutions[0].evaluation.totalScore}（${topSolutions[0].evaluation.grade}）
- 亮点：${topSolutions[0].evaluation.highlights.join('；')}
- 不足：${topSolutions[0].evaluation.weaknesses.join('；')}

方案2（排名${topSolutions[1]?.rank || 'N/A'}）：
- 策略：${topSolutions[1]?.strategy || 'N/A'}
- 总分：${topSolutions[1]?.evaluation.totalScore || 'N/A'}（${topSolutions[1]?.evaluation.grade || 'N/A'}）

方案3（排名${topSolutions[2]?.rank || 'N/A'}）：
- 策略：${topSolutions[2]?.strategy || 'N/A'}
- 总分：${topSolutions[2]?.evaluation.totalScore || 'N/A'}（${topSolutions[2]?.evaluation.grade || 'N/A'}）

请分析：
1. 推荐哪个方案作为首选（给出充分理由和置信度）
2. 三个方案在不同维度的权衡（教师vs学生、质量vs速度、灵活vs稳定）
3. 总结性建议

返回结构化报告。`,
  {
    phase: 'Report',
    label: '对比报告',
    schema: COMPARISON_REPORT_SCHEMA
  }
);

log('对比报告生成完成');

// ============ 返回最终结果 ============
return {
  success: true,
  validation,
  solutions: topSolutions.map(s => ({
    strategy: s.strategy,
    rank: s.rank,
    score: s.evaluation.totalScore,
    grade: s.evaluation.grade,
    schedule: s.schedule,
    metrics: s.metrics,
    evaluation: s.evaluation
  })),
  recommendation: comparisonReport.recommendation,
  report: comparisonReport,
  summary: `成功生成${validSolutions.length}个方案，推荐使用【${comparisonReport.recommendation.solutionId}】策略（${comparisonReport.recommendation.reason}）`
};
