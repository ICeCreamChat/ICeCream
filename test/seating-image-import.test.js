import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildImageImportReview,
  mergeStudentDetails,
  normalizeSeatingStudents,
  parseStudentsText,
} from '../gateway/services/seating-roster.js';

const ocrSourcePath = new URL('../gateway/services/ocr.js', import.meta.url);
const toolsRoutePath = new URL('../gateway/routes/tools.js', import.meta.url);
const plannerSourcePath = new URL('../public/js/tools/seating-planner.js', import.meta.url);

test('seating image OCR prompts require height extraction', async () => {
  const source = await readFile(ocrSourcePath, 'utf8');

  assert.match(source, /身高\(height\)/);
  assert.match(source, /"height":170/);
  assert.match(source, /如果身高看不清/);
});

test('seating image import preserves recognized height end to end', async () => {
  const routeSource = await readFile(toolsRoutePath, 'utf8');
  const plannerSource = await readFile(plannerSourcePath, 'utf8');

  assert.match(routeSource, /normalizeSeatingStudents\(students\)/);
  assert.match(routeSource, /mergeStudentDetails\(studentsWithIds, parsed\)/);
  assert.match(routeSource, /buildImageImportReview\(studentsWithIds\)/);
  assert.match(plannerSource, /s\.height !== undefined/);
  assert.match(plannerSource, /line \+= ` \$\{s\.height\}`/);
});

test('seating image import can merge OCR table heights into VLM students', () => {
  const vlmStudents = normalizeSeatingStudents([
    { name: '米寒琳', gender: 'F', grade: 62 },
    { name: '南门橙', gender: 'M', grade: 91 },
  ]);
  const ocrStudents = parseStudentsText(`
| 序号 | 姓名 | 性别 | 身高 | 成绩 |
| 1 | 米寒琳 | 女 | 111cm | 62 |
| 2 | 南门橙 | 男 | 177 | 91 |
`).students;

  const merged = mergeStudentDetails(vlmStudents, ocrStudents);

  assert.equal(merged[0].height, 111);
  assert.equal(merged[1].height, 177);
  assert.equal(merged[0].grade, 62);
});

test('seating image import review flags low-confidence fields', () => {
  const review = buildImageImportReview([
    { id: 's01', name: '米寒琳', gender: 'F', height: 111, grade: 62 },
    { id: 's02', name: '南门橙', gender: 'M', grade: 191 },
    { id: 's03', name: '米寒琳', gender: 'F', height: 260, grade: 88 },
  ]);

  assert.equal(review.needsReview, true);
  assert.match(review.students[0].issues.join('|'), /duplicate_name/);
  assert.match(review.students[1].issues.join('|'), /missing_height/);
  assert.match(review.students[1].issues.join('|'), /grade_out_of_range/);
  assert.match(review.students[2].issues.join('|'), /duplicate_name/);
  assert.match(review.students[2].issues.join('|'), /height_out_of_range/);
  assert.ok(review.warnings.length > 0);
});

test('seating image student normalization accepts height aliases and strings', () => {
  const students = normalizeSeatingStudents([
    { 姓名: '小同学', 性别: '女', 身高: '95厘米', 成绩: '88' },
    { name: 'Tall', gender: 'M', height_cm: '181cm', grade: '76' },
  ]);

  assert.equal(students[0].height, 95);
  assert.equal(students[0].grade, 88);
  assert.equal(students[1].height, 181);
});
