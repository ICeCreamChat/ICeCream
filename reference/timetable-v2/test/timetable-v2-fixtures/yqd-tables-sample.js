/**
 * .yqd 业务表样本（Phase 3）。
 *
 * 模拟「已导出的业务表对象」——行是普通对象（CSV 解析结果），字段名与水晶业务表一致。
 * 不解析二进制 .yqd。覆盖：banbd/jibd 班级年级、kemubd 课程（含 lianpai 连堂）、teabd 教师、
 * renkebd 任课关系（含一个 heban 合班）、roombd 教室、kemujieshu 班课课时、gudinbd 固定课、
 * teshuke 课程预排（弱/强/硬禁）、teshutea 教师预排（硬禁/软偏好）、PaiOptJie/PaiOptDay 细粒度规则、PaiOpt 开关。
 *
 * yqdTablesSample()  → 完整最小样本
 * yqdTablesMissing() → 缺表 / 缺字段的残缺样本（验证不崩溃）
 */

export function yqdTablesSample() {
    return {
        // 年级
        jibd: [
            { jiid: 1, jiname: '一年' },
            { jiid: 2, jiname: '二年' },
        ],
        // 班级
        banbd: [
            { banid: 1, banname: '一年1班', jiid: 1, islock: 0 },
            { banid: 2, banname: '一年2班', jiid: 1, islock: 0 },
            { banid: 3, banname: '二年1班', jiid: 2, islock: 0 },
        ],
        // 课程（kemu 5：科学，lianpai=1 连堂）
        kemubd: [
            { kemuid: 1, kemuname: '语文', kemuname2: '语', maxjie: 0, lianpai: 0, roomid: 0 },
            { kemuid: 2, kemuname: '数学', kemuname2: '数', maxjie: 0, lianpai: 0, roomid: 0 },
            { kemuid: 3, kemuname: '体育', kemuname2: '体', maxjie: 0, lianpai: 0, roomid: 0 },
            { kemuid: 5, kemuname: '科学', kemuname2: '科', maxjie: 0, lianpai: 1, roomid: 0 },
        ],
        // 教师
        teabd: [
            { teaid: 1, teaname: '严如花', teaname2: '如花', islock: 0 },
            { teaid: 2, teaname: '廖爱华', teaname2: '爱华', islock: 0 },
            { teaid: 3, teaname: '王小明', teaname2: '小明', islock: 0 },
        ],
        // 教室
        roombd: [
            { roomid: 1, roomname: '操场', roomnum: 'P1', roomsize: 200 },
        ],
        // 班课课时（学期级元数据）
        kemujieshu: [
            { kemuid: 1, banid: 1, jieshu: 90 },
            { kemuid: 2, banid: 1, jieshu: 90 },
        ],
        // 任课关系：普通任课 + heban=1 合班组（班级 1、2 同上语文，同师同课）
        renkebd: [
            { difid: 0, teaid: 1, banid: 1, keid: 1, jieshu: 4, heban: 1 }, // 合班组首行
            { difid: 1, teaid: 1, banid: 2, keid: 1, jieshu: 4, heban: 1 }, // 合班组成员
            { difid: 2, teaid: 2, banid: 1, keid: 2, jieshu: 5, heban: 0 }, // 普通：班1 数学
            { difid: 3, teaid: 3, banid: 1, keid: 3, jieshu: 2, heban: 0 }, // 普通：班1 体育
            { difid: 4, teaid: 3, banid: 3, keid: 5, jieshu: 2, heban: 0 }, // 普通：班3 科学（连堂）
        ],
        // 固定课（班1 周三第6节 活动）→ class_unavailable
        gudinbd: [
            { gudinid: 1, gudinname: '活动', theday: 3, thejie: 6, theban: 1 },
        ],
        // 课程预排：强偏好(2)、硬禁(3)
        teshuke: [
            { kemuid: 1, banid: 1, theday: 1, thejie: 1, teshu: 2 }, // 强偏好 → 软约束草稿
            { kemuid: 2, banid: 1, theday: 5, thejie: 6, teshu: 3 }, // 硬禁课程@班级 → review
        ],
        // 教师预排：硬禁(3) → teacher_unavailable；软偏好(1) → review
        teshutea: [
            { teaid: 1, theday: 5, thejie: 5, teshu: 3 }, // 硬禁 → teacher_unavailable
            { teaid: 2, theday: 2, thejie: 1, teshu: 1 }, // 软偏好 → review
        ],
        // 细粒度节限制：教师硬禁(theNum=1000) + 课程计数软约束(min, theNum>1000)
        PaiOptJie: [
            { theJie: 1, theNum: 1000, OptId: 1, BanId: null, KeId: null, TeaId: 3 }, // 教师3 第1节硬禁 → teacher_unavailable
            { theJie: 2, theNum: 1002, OptId: 2, BanId: 1, KeId: 2, TeaId: null }, // 班1数学 第2节至少1 → 软草稿/review
        ],
        // 细粒度日限制：课程@班级 硬禁(1000) → review（非教师无对应硬 type）
        PaiOptDay: [
            { theDay: 4, theNum: 1000, OptId: 1, BanId: 1, KeId: 1, TeaId: null },
        ],
        // 主开关 → 元数据
        PaiOpt: [
            { item: 'schedulingStrength', value: 3, mode: 'auto' },
            { item: 'teacherDaySegment', value: 1, mode: 'same' },
        ],
        // 日历辅助
        daybd: [
            { dayid: 1, dayname: '星期一' },
            { dayid: 2, dayname: '星期二' },
            { dayid: 3, dayname: '星期三' },
            { dayid: 4, dayname: '星期四' },
            { dayid: 5, dayname: '星期五' },
        ],
        jieshu: [{ mor: 3, aft: 3, nig: 0 }],
    };
}

/**
 * 残缺样本：缺 teabd / roombd / 多个细粒度表，且 renkebd 有缺字段行。
 * 用于验证缺表 / 缺字段记报告、不崩溃。
 */
export function yqdTablesMissing() {
    return {
        banbd: [
            { banid: 1, banname: '一年1班', jiid: 1 },
        ],
        kemubd: [
            { kemuid: 1, kemuname: '语文' },
        ],
        // 无 teabd（教师表缺失）
        renkebd: [
            { difid: 0, teaid: 1, banid: 1, keid: 1, jieshu: 4, heban: 0 }, // teaid 悬空（无 teabd）→ dropped
            { difid: 1, banid: 1, keid: 1, jieshu: 3, heban: 0 },          // 缺 teaid → dropped
            { difid: 2, teaid: 9, banid: 1, keid: 9, jieshu: 2, heban: 0 }, // keid 悬空 → dropped
        ],
        // 缺 jibd / roombd / gudinbd / teshuke / teshutea / PaiOpt* / daybd / jieshu
    };
}
