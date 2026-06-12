package com.icecream.timetable.solver;

import ai.timefold.solver.core.api.score.stream.Constraint;
import ai.timefold.solver.core.api.score.stream.ConstraintFactory;
import ai.timefold.solver.core.api.score.stream.Joiners;
import ai.timefold.solver.core.api.score.HardSoftScore;
import com.icecream.timetable.domain.LessonAssignment;
import com.icecream.timetable.domain.ChineseCurriculumContext;

/**
 * 中国教育场景专用约束
 * 基于国家课程标准、教师工作量规范和学生学习规律
 */
public class ChineseEducationConstraints {

    private final ChineseCurriculumContext context;

    public ChineseEducationConstraints(ChineseCurriculumContext context) {
        this.context = context != null ? context : new ChineseCurriculumContext();
    }

    /**
     * 主科优先黄金时段（软约束）
     * 语数外等主科应安排在上午2-4节
     */
    public Constraint mainSubjectGoldenHourPreference(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> lesson.getTimeSlot() != null
                        && lesson.getSubjectId() != null
                        && context.isMainSubject(lesson.getSubjectId())
                        && !context.isGoldenHourSlot(lesson.getTimeSlot().getLessonIndex()))
                .penalize(HardSoftScore.ONE_SOFT, lesson -> {
                    // 非黄金时段扣分，下午后半段扣分更多
                    if (context.isFatigueSlot(lesson.getTimeSlot().getLessonIndex(), 7)) {
                        return 6; // 疲劳时段主科扣分严重
                    }
                    return 3; // 一般非黄金时段
                })
                .asConstraint("Main subject golden hour preference");
    }

    /**
     * 体育课分散（硬约束）
     * 体育课不能同一天多节，应分散在不同天
     */
    public Constraint sportsClassDistribution(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class,
                        Joiners.equal(LessonAssignment::getClassId),
                        Joiners.equal(lesson -> lesson.getTimeSlot() != null ? lesson.getTimeSlot().getWeekday() : null))
                .filter((left, right) -> left.getTimeSlot() != null
                        && right.getTimeSlot() != null
                        && context.isSportsOrActivity(left.getSubjectId())
                        && context.isSportsOrActivity(right.getSubjectId()))
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Sports class distribution");
    }

    /**
     * 教师连续授课限制（软约束）
     * 同一教师不宜连续上超过3节课
     */
    public Constraint teacherContinuousTeachingLimit(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class,
                        Joiners.equal(LessonAssignment::getTeacherId))
                .filter((left, right) -> {
                    if (left.getTimeSlot() == null || right.getTimeSlot() == null) {
                        return false;
                    }
                    // 同一天
                    if (left.getTimeSlot().getWeekday() != right.getTimeSlot().getWeekday()) {
                        return false;
                    }
                    // 计算是否为连续3节的一部分
                    int indexDiff = Math.abs(left.getTimeSlot().getLessonIndex() - right.getTimeSlot().getLessonIndex());
                    return indexDiff == 2; // 间隔为2表示是连续3节的两端
                })
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> 5)
                .asConstraint("Teacher continuous teaching limit");
    }

    /**
     * 教师周课时上限（硬约束）
     * 根据教师角色限制每周课时数
     */
    public Constraint teacherWeeklyHourHardLimit(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> lesson.getTimeSlot() != null && lesson.getTeacherId() != null)
                .groupBy(LessonAssignment::getTeacherId, count())
                .filter((teacherId, count) -> count > context.getTeacherWeeklyHourLimit("regular"))
                .penalize(HardSoftScore.ONE_HARD, (teacherId, count) ->
                        count - context.getTeacherWeeklyHourLimit("regular"))
                .asConstraint("Teacher weekly hour hard limit");
    }

    /**
     * 下午疲劳时段避免高强度科目（软约束）
     * 下午最后两节不宜安排主科或难度大的科目
     */
    public Constraint afternoonFatigueAvoidance(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> lesson.getTimeSlot() != null
                        && lesson.getSubjectId() != null
                        && context.isMainSubject(lesson.getSubjectId())
                        && context.isFatigueSlot(lesson.getTimeSlot().getLessonIndex(), 7))
                .penalize(HardSoftScore.ONE_SOFT, lesson -> 4)
                .asConstraint("Afternoon fatigue avoidance");
    }

    /**
     * 实验课专用教室要求（硬约束）
     * 物理、化学、生物实验课必须安排在对应实验室
     */
    public Constraint laboratoryRoomRequirement(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> lesson.getSubjectId() != null
                        && context.needsLaboratory(lesson.getSubjectId())
                        && (lesson.getRoom() == null || lesson.getRoom().isNone()
                        || !lesson.getRoom().getName().contains("实验")
                        && !lesson.getRoom().getName().contains("lab")))
                .penalize(HardSoftScore.ONE_HARD)
                .asConstraint("Laboratory room requirement");
    }

    /**
     * 同一科目不同班级备课时间间隔（软约束）
     * 同一教师教同一科目的不同班级，应有间隔便于备课
     */
    public Constraint sameSubjectPreparationTimeGap(ConstraintFactory factory) {
        return factory.forEachUniquePair(LessonAssignment.class,
                        Joiners.equal(LessonAssignment::getTeacherId),
                        Joiners.equal(LessonAssignment::getSubjectId))
                .filter((left, right) -> left.getTimeSlot() != null
                        && right.getTimeSlot() != null
                        && !left.getClassId().equals(right.getClassId())
                        && left.getTimeSlot().getWeekday() == right.getTimeSlot().getWeekday()
                        && left.getTimeSlot().isAdjacentTo(right.getTimeSlot()))
                .penalize(HardSoftScore.ONE_SOFT, (left, right) -> 3)
                .asConstraint("Same subject preparation time gap");
    }

    /**
     * 教师每日工作量方差最小化（软约束）
     * 教师的课程应尽量均匀分布在各天，避免某天过多
     */
    public Constraint teacherDailyLoadVarianceMinimization(ConstraintFactory factory) {
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> lesson.getTimeSlot() != null && lesson.getTeacherId() != null)
                .groupBy(LessonAssignment::getTeacherId,
                        lesson -> lesson.getTimeSlot().getWeekday(),
                        count())
                .filter((teacherId, weekday, dailyCount) -> dailyCount > 4) // 单日超过4节
                .penalize(HardSoftScore.ONE_SOFT, (teacherId, weekday, dailyCount) ->
                        (dailyCount - 4) * 2) // 超过部分线性扣分
                .asConstraint("Teacher daily load variance minimization");
    }

    /**
     * 走班制时段对齐（硬约束）
     * 高中走班制下，同一时段的选课组合必须时间对齐
     */
    public Constraint walkingClassTimeAlignment(ConstraintFactory factory) {
        if (!context.isWalkingClassEnabled()) {
            return factory.forEach(LessonAssignment.class)
                    .filter(lesson -> false) // 未启用走班制，约束不生效
                    .penalize(HardSoftScore.ZERO)
                    .asConstraint("Walking class time alignment (disabled)");
        }

        // TODO: 需要走班分组信息才能实现完整逻辑
        // 这里提供基本框架
        return factory.forEach(LessonAssignment.class)
                .filter(lesson -> lesson.getTimeSlot() != null
                        && lesson.getBlockId() != null
                        && lesson.getBlockId().startsWith("walking_"))
                .penalize(HardSoftScore.ZERO) // 占位，需要完整实现
                .asConstraint("Walking class time alignment");
    }

    // 辅助方法
    private static <A> ai.timefold.solver.core.api.function.QuadFunction<A, A, A, Long, Long> count() {
        return (a, b, c, count) -> count;
    }
}
