package com.icecream.timetable.domain;

/**
 * 中国课程标准上下文
 * 用于约束中的国家课程标准检查和教学规律优化
 */
public class ChineseCurriculumContext {

    private String schoolType; // primary, middle, high
    private String gradeLevel; // 1-12
    private boolean walkingClassEnabled; // 走班制
    private int termWeeks; // 学期周数，通常18-20周

    public ChineseCurriculumContext() {
        this.schoolType = "middle";
        this.gradeLevel = "7";
        this.walkingClassEnabled = false;
        this.termWeeks = 18;
    }

    public String getSchoolType() {
        return schoolType;
    }

    public void setSchoolType(String schoolType) {
        this.schoolType = schoolType;
    }

    public String getGradeLevel() {
        return gradeLevel;
    }

    public void setGradeLevel(String gradeLevel) {
        this.gradeLevel = gradeLevel;
    }

    public boolean isWalkingClassEnabled() {
        return walkingClassEnabled;
    }

    public void setWalkingClassEnabled(boolean walkingClassEnabled) {
        this.walkingClassEnabled = walkingClassEnabled;
    }

    public int getTermWeeks() {
        return termWeeks;
    }

    public void setTermWeeks(int termWeeks) {
        this.termWeeks = termWeeks;
    }

    /**
     * 判断是否为主科（国家课程标准重点科目）
     */
    public boolean isMainSubject(String subjectName) {
        if (subjectName == null) {
            return false;
        }
        String name = subjectName.toLowerCase();
        return name.contains("语文") || name.contains("数学") || name.contains("英语")
                || name.contains("物理") || name.contains("化学") || name.contains("chinese")
                || name.contains("math") || name.contains("english");
    }

    /**
     * 判断是否为体育或活动课
     */
    public boolean isSportsOrActivity(String subjectName) {
        if (subjectName == null) {
            return false;
        }
        String name = subjectName.toLowerCase();
        return name.contains("体育") || name.contains("sports") || name.contains("pe")
                || name.contains("活动") || name.contains("健康");
    }

    /**
     * 判断是否需要实验室
     */
    public boolean needsLaboratory(String subjectName) {
        if (subjectName == null) {
            return false;
        }
        String name = subjectName.toLowerCase();
        return name.contains("实验") || name.contains("物理") || name.contains("化学")
                || name.contains("生物") || name.contains("科学")
                || name.contains("lab") || name.contains("physics")
                || name.contains("chemistry") || name.contains("biology");
    }

    /**
     * 获取黄金时段节次（上午2-4节为最佳学习时段）
     */
    public boolean isGoldenHourSlot(int lessonIndex) {
        // lessonIndex 从1开始，2-4节为黄金时段
        return lessonIndex >= 2 && lessonIndex <= 4;
    }

    /**
     * 判断是否为下午后半段（疲劳时段）
     */
    public boolean isFatigueSlot(int lessonIndex, int totalPeriods) {
        // 下午最后两节为疲劳时段
        int afternoonStart = (totalPeriods / 2) + 1;
        return lessonIndex >= totalPeriods - 1;
    }

    /**
     * 获取教师每周课时标准上限
     */
    public int getTeacherWeeklyHourLimit(String teacherRole) {
        if ("head_teacher".equals(teacherRole)) {
            return 14; // 班主任减少2节
        }
        if ("high".equals(schoolType)) {
            return 16; // 高中教师
        }
        if ("middle".equals(schoolType)) {
            return 18; // 初中教师
        }
        return 20; // 小学教师
    }

    /**
     * 获取连续授课上限（节数）
     */
    public int getContinuousTeachingLimit() {
        return 3; // 不超过3节连续
    }

    /**
     * 判断两个科目是否适合文理交替
     */
    public boolean isGoodSubjectAlternation(String subject1, String subject2) {
        if (subject1 == null || subject2 == null) {
            return false;
        }
        boolean s1Main = isMainSubject(subject1);
        boolean s2Main = isMainSubject(subject2);
        boolean s1Sports = isSportsOrActivity(subject1);
        boolean s2Sports = isSportsOrActivity(subject2);

        // 主科和体育交替很好
        if ((s1Main && s2Sports) || (s1Sports && s2Main)) {
            return true;
        }

        // 避免连续两节主科
        if (s1Main && s2Main) {
            return false;
        }

        return true; // 其他组合默认可接受
    }
}
