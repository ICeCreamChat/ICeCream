import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildSeatingChatSnapshot,
  classifySeatingChatIntent,
  detectSeatingMutationIntent,
  normalizeChatOperations,
  resolveEmptyMutationResponse,
} from '../gateway/services/seating-chat.js';

const students = [
  { id: 's01', name: '张三', gender: 'M' },
  { id: 's02', name: '李四', gender: 'F' },
  { id: 's03', name: '王五', gender: 'M' },
];
const toolsRoutePath = new URL('../gateway/routes/tools.js', import.meta.url);

test('detectSeatingMutationIntent recognizes commands that should change seats', () => {
  assert.equal(detectSeatingMutationIntent('把张三和李四换一下'), true);
  assert.equal(detectSeatingMutationIntent('王五往前挪一排'), true);
  assert.equal(detectSeatingMutationIntent('分析一下有没有问题'), false);
});

test('classifySeatingChatIntent separates direct edits, batch tuning, regeneration, and clarification', () => {
  assert.deepEqual(
    classifySeatingChatIntent('把张三和李四换一下', students),
    {
      intent: 'direct_edit',
      requiresConfirmation: false,
      confirmationText: '',
      arrangementPrompt: '',
      mutationIntent: true,
    }
  );
  assert.equal(classifySeatingChatIntent('把张三移到过道右边', students).intent, 'direct_edit');
  assert.equal(classifySeatingChatIntent('把张三安排到第一排靠过道', students).intent, 'direct_edit');
  assert.equal(classifySeatingChatIntent('王五往前挪一排', students).intent, 'direct_edit');
  assert.equal(classifySeatingChatIntent('把张三安排到左护法', students).intent, 'direct_edit');

  assert.deepEqual(
    classifySeatingChatIntent('把成绩弱的同学分散开', students),
    {
      intent: 'batch_tune',
      requiresConfirmation: true,
      confirmationText: '这会批量调整当前座位，但不改变布局，确认执行吗？',
      arrangementPrompt: '',
      mutationIntent: true,
    }
  );
  assert.equal(classifySeatingChatIntent('把小组长均匀分布到教室各区域', students).intent, 'batch_tune');
  assert.equal(classifySeatingChatIntent('左右护法要两个成绩比较好的', students).intent, 'batch_tune');

  for (const message of ['改成考试模式', '重新排一下', '两人一组中间留过道', '按身高从前到后安排', '按成绩整体安排']) {
    assert.deepEqual(
      classifySeatingChatIntent(message, students),
      {
        intent: 'regenerate',
        requiresConfirmation: true,
        confirmationText: '这会重新生成座位表并可能大幅改变当前安排，确认继续吗？',
        arrangementPrompt: message,
        mutationIntent: false,
      }
    );
  }

  assert.equal(classifySeatingChatIntent('帮我往前挪', students).intent, 'clarify');
  assert.equal(classifySeatingChatIntent('帮我优化一下', students).intent, 'clarify');
  assert.equal(classifySeatingChatIntent('帮我检查一下有没有问题', students).intent, 'explain');
});

test('regenerate intent takes priority over direct_edit when both keywords present', () => {
  // "重新排" (regenerate) + student name + action should yield regenerate not direct_edit
  assert.equal(
    classifySeatingChatIntent('重新排，把张三换到前排', students).intent,
    'regenerate'
  );
  assert.equal(
    classifySeatingChatIntent('重新安排座位，李四坐第一排', students).intent,
    'regenerate'
  );
});

test('negation words prevent false regenerate detection', () => {
  // "不要考试模式" should NOT be regenerate
  assert.notEqual(
    classifySeatingChatIntent('不要考试模式', students).intent,
    'regenerate'
  );
  // "别改布局" should NOT be regenerate
  assert.notEqual(
    classifySeatingChatIntent('别改布局', students).intent,
    'regenerate'
  );
  // "不是重新排" should NOT be regenerate
  assert.notEqual(
    classifySeatingChatIntent('不是重新排', students).intent,
    'regenerate'
  );
  // But actual regenerate requests still work
  assert.equal(
    classifySeatingChatIntent('重新排成考试模式', students).intent,
    'regenerate'
  );
});

test('explicit mode parameter overrides auto-detection', () => {
  // explicit mode='regenerate' forces regenerate even for micro-like messages
  assert.equal(
    classifySeatingChatIntent('把张三和李四换一下', students, 'regenerate').intent,
    'regenerate'
  );
  // explicit mode='micro' prevents regenerate even for regenerate-like messages
  assert.equal(
    classifySeatingChatIntent('改成考试模式', students, 'micro').intent,
    'explain'
  );
  // explicit mode='micro' still allows direct_edit
  assert.equal(
    classifySeatingChatIntent('把张三和李四换一下', students, 'micro').intent,
    'direct_edit'
  );
  // explicit mode='micro' still allows batch_tune
  assert.equal(
    classifySeatingChatIntent('把成绩弱的同学分散开', students, 'micro').intent,
    'batch_tune'
  );
});

test('normalizeChatOperations keeps id-first operations and accepts names as fallback', () => {
  const result = normalizeChatOperations([
    { type: 'swap', student1Id: 's01', student2: '李四' },
    { type: 'move', student: '王五', row: 0, col: 2 },
    { type: 'set_guardian', student: '张三', side: 'left' },
    { type: 'reshape', rows: 8, cols: 8 },
  ], students);

  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /不支持的操作类型/);
  assert.deepEqual(result.operations, [
    { type: 'swap', student1Id: 's01', student1: '张三', student2Id: 's02', student2: '李四' },
    { type: 'move', studentId: 's03', student: '王五', row: 0, col: 2 },
    { type: 'set_guardian', studentId: 's01', student: '张三', side: 'left' },
  ]);
});

test('resolveEmptyMutationResponse marks empty operations as actionable failure for mutating commands', () => {
  const result = resolveEmptyMutationResponse({
    message: '把张三往前挪',
    operations: [],
    rejected: [],
  });

  assert.equal(result.mutationIntent, true);
  assert.equal(result.needsAction, true);
  assert.match(result.rejected[0].reason, /没有返回可执行/);
});

test('buildSeatingChatSnapshot includes id, name, and coordinates for each occupied seat', () => {
  const snapshot = buildSeatingChatSnapshot({
    layout: [
      ['s01', null],
      ['s02', 's03'],
    ],
    students,
    guardians: ['s03', 's02'],
  });

  assert.deepEqual(snapshot.occupied, [
    { id: 's01', name: '张三', row: 0, col: 0 },
    { id: 's02', name: '李四', row: 1, col: 0 },
    { id: 's03', name: '王五', row: 1, col: 1 },
    { id: 's03', name: '王五', row: -1, col: 0, role: 'guardian', side: 'left' },
    { id: 's02', name: '李四', row: -1, col: 1, role: 'guardian', side: 'right' },
  ]);
});

test('seating chat prompt limits the assistant to minor adjustments inside the existing layout', async () => {
  const source = await readFile(toolsRoutePath, 'utf8');

  assert.match(source, /只能在现有布局内微调/);
  assert.match(source, /不能改变教室结构、过道、座位容量/);
  assert.match(source, /当前已由后端判定为/);
  assert.match(source, /batch_tune/);
  assert.match(source, /regenerate/);
  assert.match(source, /set_guardian/);
});
