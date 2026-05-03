import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeConstraintItems,
  parseSeatingConstraints,
  parseSeatingConstraintsLocally,
} from '../gateway/services/seating-constraints.js';

const exampleText = `卫黛宜希望坐在前排中间，不想坐在鲜于振、司婕燕、邵元后面。
卢宁倩荔希望坐在前中排，不想坐在家枝飘、詹梦素、尤东后面。
能志飞保希望坐在前排，但不一定要正中间。
胡进乐希望坐得靠前一些，旁边最好安排一名成绩较好的同学。
家枝飘因为身高较高，不希望坐前排，但成绩偏低，希望不要被安排到最后一排。
米寒琳希望和邰丽或计纯坐得近一些，方便学习交流。
詹世不希望和成绩同样偏低的同学同桌，希望旁边有一名成绩较好的学生。
仇涛强不想坐最后一排，希望坐在中后排靠过道位置。
鲜于振、司婕燕、邵元不希望坐在第一排，避免遮挡后排同学。
尹婕悦、庞竹素、卢宁倩荔成绩较高，可以分散安排，不希望三人坐得过近。`;

const exampleNames = [
  '卫黛宜',
  '鲜于振',
  '司婕燕',
  '邵元',
  '卢宁倩荔',
  '家枝飘',
  '詹梦素',
  '尤东',
  '能志飞保',
  '胡进乐',
  '米寒琳',
  '邰丽',
  '计纯',
  '詹世',
  '仇涛强',
  '尹婕悦',
  '庞竹素',
];

const exampleStudents = exampleNames.map(name => ({ name }));

test('local seating constraint parser extracts actionable rich needs from long teacher text', () => {
  const constraints = parseSeatingConstraintsLocally({
    text: exampleText,
    students: exampleStudents,
  });

  assert.ok(constraints.some(item => item.type === 'prefer_front_middle' && item.target === '卫黛宜'));
  assert.ok(constraints.some(item => item.type === 'avoid_behind' && item.target === '卫黛宜' && item.related === '鲜于振'));
  assert.ok(constraints.some(item => item.type === 'prefer_front_mid_rows' && item.target === '卢宁倩荔'));
  assert.ok(constraints.some(item => item.type === 'front_row' && item.target === '能志飞保'));
  assert.ok(constraints.some(item => item.type === 'prefer_high_grade_neighbor' && item.target === '胡进乐'));
  assert.ok(constraints.some(item => item.type === 'avoid_front_row' && item.target === '家枝飘'));
  assert.ok(constraints.some(item => item.type === 'avoid_last_row' && item.target === '家枝飘'));
  assert.ok(constraints.some(item => item.type === 'prefer_near' && item.target === '米寒琳' && item.related === '邰丽'));
  assert.ok(constraints.some(item => item.type === 'avoid_low_grade_deskmate' && item.target === '詹世'));
  assert.ok(constraints.some(item => item.type === 'prefer_aisle' && item.target === '仇涛强'));
  assert.ok(constraints.some(item => item.type === 'avoid_first_row' && item.target === '鲜于振'));
  assert.ok(constraints.some(item => item.type === 'avoid_near' && item.target === '尹婕悦' && item.related === '庞竹素'));
});

test('AI constraint normalization turns row words and grade placeholders into executable types', () => {
  const constraints = normalizeConstraintItems([
    { type: 'avoid', target: '家枝飘', related: '前排', reason: '身高较高，不希望坐前排', priority: 'hard' },
    { type: 'avoid', target: '仇涛强', related: '最后一排', reason: '不想坐最后一排', priority: 'hard' },
    { type: 'avoid', target: '鲜于振、司婕燕、邵元', related: '第一排', reason: '避免遮挡后排同学', priority: 'hard' },
    { type: 'prefer', target: '胡进乐', related: '成绩较好的同学', reason: '旁边最好安排一名成绩较好的同学', priority: 'soft' },
    { type: 'prefer', target: '仇涛强', related: '中后排靠过道位置', reason: '希望坐在中后排靠过道位置', priority: 'soft' },
  ], { students: exampleStudents });

  assert.ok(constraints.some(item => item.type === 'avoid_front_row' && item.target === '家枝飘'));
  assert.ok(constraints.some(item => item.type === 'avoid_last_row' && item.target === '仇涛强'));
  assert.ok(constraints.some(item => item.type === 'avoid_first_row' && item.target === '鲜于振'));
  assert.ok(constraints.some(item => item.type === 'avoid_first_row' && item.target === '邵元'));
  assert.ok(constraints.some(item => item.type === 'prefer_high_grade_neighbor' && item.target === '胡进乐'));
  assert.ok(constraints.some(item => item.type === 'prefer_aisle' && item.target === '仇涛强'));
});

test('parseSeatingConstraints falls back to deterministic extraction when AI JSON is truncated', async () => {
  const names = Array.from({ length: 70 }, (_, index) => `张${String(index + 1).padStart(2, '0')}`);
  const text = names.map(name => `${name}希望坐在前排。`).join('\n');
  const students = names.map(name => ({ name }));
  let requestedBody;
  const fetchImpl = async (_url, options) => {
    requestedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"constraints":[{"type":"front_row","target":"张01",' } }],
      }),
    };
  };

  const result = await parseSeatingConstraints({
    text,
    students,
    fetchImpl,
    env: { DEEPSEEK_API_BASE: 'http://fake-ai', DEEPSEEK_API_KEY: 'key' },
  });

  assert.equal(requestedBody.max_tokens, 4096);
  assert.equal(result.constraints.filter(item => item.type === 'front_row').length, 70);
  assert.match(result.warnings.join('；'), /AI 返回的学生需求 JSON 无效/);
});
