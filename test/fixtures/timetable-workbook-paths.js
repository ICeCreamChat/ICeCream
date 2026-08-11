import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const TIMETABLE_CONSTRAINT_WORKBOOK_PATH = path.join(
    projectRoot,
    'data',
    'timetable',
    '真实学校排课约束需求.xlsx',
);

export const TIMETABLE_ROSTER_WORKBOOK_PATH = path.join(
    projectRoot,
    'data',
    'timetable',
    '真实学校整学期任课数据.xlsx',
);
