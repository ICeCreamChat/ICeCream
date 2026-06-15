/**
 * 测试数据生成工厂
 *
 * 生成不同规模的约束数据用于性能测试和功能验证
 */

/**
 * 约束类型定义
 */
const CONSTRAINT_TYPES = [
  '教师连堂要求',
  '教室固定安排',
  '年级互斥约束',
  '课时分散要求',
  '上下午均衡',
  '特殊时段禁用',
  '实验室预约',
  '体育场地协调',
  '多媒体教室排课',
  '考试周特殊安排'
];

/**
 * 教师名字库
 */
const TEACHERS = [
  '张老师', '李老师', '王老师', '赵老师', '刘老师',
  '陈老师', '杨老师', '黄老师', '周老师', '吴老师',
  '徐老师', '孙老师', '马老师', '朱老师', '胡老师',
  '郭老师', '何老师', '高老师', '林老师', '罗老师'
];

/**
 * 科目名字库
 */
const SUBJECTS = [
  '语文', '数学', '英语', '物理', '化学', '生物',
  '历史', '地理', '政治', '音乐', '美术', '体育',
  '信息技术', '通用技术', '心理健康', '劳动教育'
];

/**
 * 教室名字库
 */
const ROOMS = [
  '101教室', '102教室', '201教室', '202教室', '301教室',
  '物理实验室1', '化学实验室2', '生物实验室',
  '计算机教室1', '计算机教室2', '多媒体教室',
  '音乐教室', '美术教室', '体育馆', '操场'
];

/**
 * 年级班级库
 */
const CLASSES = [
  '高一1班', '高一2班', '高一3班', '高一4班',
  '高二1班', '高二2班', '高二3班', '高二4班',
  '高三1班', '高三2班', '高三3班', '高三4班'
];

/**
 * 时段描述库
 */
const TIME_SLOTS = [
  '周一上午', '周一下午', '周二上午', '周二下午',
  '周三上午', '周三下午', '周四上午', '周四下午',
  '周五上午', '周五下午', '第1-2节', '第3-4节',
  '第5-6节', '第7-8节'
];

/**
 * 随机选择数组元素
 */
function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 生成单个约束
 */
function generateConstraint(index) {
  const type = randomChoice(CONSTRAINT_TYPES);
  let description = '';

  switch (type) {
    case '教师连堂要求':
      description = `${randomChoice(TEACHERS)}的${randomChoice(SUBJECTS)}需要连续排课`;
      break;
    case '教室固定安排':
      description = `${randomChoice(CLASSES)}的${randomChoice(SUBJECTS)}固定在${randomChoice(ROOMS)}`;
      break;
    case '年级互斥约束':
      description = `${randomChoice(CLASSES)}和${randomChoice(CLASSES)}不能同时使用${randomChoice(ROOMS)}`;
      break;
    case '课时分散要求':
      description = `${randomChoice(SUBJECTS)}课程每天最多1节，避免疲劳`;
      break;
    case '上下午均衡':
      description = `${randomChoice(TEACHERS)}的课程上下午均匀分布`;
      break;
    case '特殊时段禁用':
      description = `${randomChoice(TIME_SLOTS)}${randomChoice(TEACHERS)}不可排课（会议）`;
      break;
    case '实验室预约':
      description = `${randomChoice(['物理实验室1', '化学实验室2', '生物实验室'])}${randomChoice(TIME_SLOTS)}被预约`;
      break;
    case '体育场地协调':
      description = `${randomChoice(TIME_SLOTS)}体育课优先使用操场，雨天调整到体育馆`;
      break;
    case '多媒体教室排课':
      description = `${randomChoice(CLASSES)}的${randomChoice(['信息技术', '通用技术'])}必须在计算机教室`;
      break;
    case '考试周特殊安排':
      description = `考试周${randomChoice(CLASSES)}暂停${randomChoice(SUBJECTS)}课程`;
      break;
  }

  return {
    id: `constraint-${index + 1}`,
    type,
    description,
    priority: randomChoice(['高', '中', '低']),
    status: 'pending'
  };
}

/**
 * 生成小型测试数据（10条约束）
 */
export function generateSmallDataset() {
  return {
    name: 'small-dataset',
    size: 10,
    constraints: Array.from({ length: 10 }, (_, i) => generateConstraint(i))
  };
}

/**
 * 生成中型测试数据（50条约束）
 */
export function generateMediumDataset() {
  return {
    name: 'medium-dataset',
    size: 50,
    constraints: Array.from({ length: 50 }, (_, i) => generateConstraint(i))
  };
}

/**
 * 生成大型测试数据（100+条约束）
 */
export function generateLargeDataset() {
  return {
    name: 'large-dataset',
    size: 120,
    constraints: Array.from({ length: 120 }, (_, i) => generateConstraint(i))
  };
}

/**
 * 将约束数据转换为自然语言文本（用于粘贴测试）
 */
export function constraintsToText(constraints) {
  return constraints.map((c, index) => {
    return `${index + 1}. ${c.description}（优先级：${c.priority}）`;
  }).join('\n');
}

/**
 * 生成包含错误格式的约束数据（用于错误处理测试）
 */
export function generateMalformedDataset() {
  return {
    name: 'malformed-dataset',
    size: 5,
    constraints: [
      { id: 'c1', description: '', priority: '高' }, // 空描述
      { id: 'c2', description: '正常约束', priority: '极高' }, // 无效优先级
      { id: 'c3', description: '   ', priority: '中' }, // 仅空格
      { id: 'c4', description: '超长约束'.repeat(100), priority: '低' }, // 超长文本
      { id: 'c5', description: '包含特殊字符<script>alert("xss")</script>', priority: '高' }, // XSS 测试
    ]
  };
}

/**
 * 生成冲突约束数据（用于冲突检测测试）
 */
export function generateConflictingDataset() {
  return {
    name: 'conflicting-dataset',
    size: 4,
    constraints: [
      {
        id: 'c1',
        description: '张老师的数学需要在周一上午第1节',
        priority: '高'
      },
      {
        id: 'c2',
        description: '张老师周一上午有教研活动不能排课',
        priority: '高'
      },
      {
        id: 'c3',
        description: '高一1班周一上午必须上数学课',
        priority: '中'
      },
      {
        id: 'c4',
        description: '高一1班周一上午需要班会课',
        priority: '中'
      }
    ]
  };
}
