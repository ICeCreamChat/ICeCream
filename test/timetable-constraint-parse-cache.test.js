import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDefaultTimetableProject } from '../gateway/services/timetable-project.js';
import { parseTimetableRules } from '../gateway/services/timetable-rule-parser.js';
import { createTimetableConstraintParseCache } from '../gateway/services/timetable-constraints/parse-cache.js';

function project() {
    return createDefaultTimetableProject({
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7, 8],
        teachers: [{ id: 't1', name: '张老师' }],
        classes: [{ id: 'c1', name: '七年级1班', grade: '七年级' }],
        subjects: [{ id: 's1', name: '数学' }],
        lessonPlans: [{ id: 'lp1', teacherId: 't1', classId: 'c1', subjectId: 's1', weeklyHours: 5 }],
    });
}

function aiResponse() {
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ reviewItems: [], warnings: [] }) } }],
        }),
    };
}

test('persistent parse cache coalesces concurrent AI work and survives a fresh cache instance', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'icecream-constraint-cache-'));
    let aiCalls = 0;
    const env = {
        DEEPSEEK_API_KEY: 'test-key',
        DEEPSEEK_API_BASE: 'http://ai.test',
        DEEPSEEK_MODEL: 'stable-model',
        TIMETABLE_RULE_AI_EXTRACT: '0',
        TIMETABLE_RULE_AI_SEED: '17',
        TIMETABLE_RULE_PERSISTENT_CACHE: '1',
        TIMETABLE_DATA_DIR: dataDir,
    };
    const fetchImpl = async () => {
        aiCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        return aiResponse();
    };

    try {
        const [first, second] = await Promise.all([
            parseTimetableRules({ text: '七年级1班数学尽量安排在上午。', project: project(), env, fetchImpl }),
            parseTimetableRules({ text: '七年级1班数学尽量安排在上午。', project: project(), env, fetchImpl }),
        ]);
        assert.equal(aiCalls, 1);
        assert.equal(first.determinism.cacheKey, second.determinism.cacheKey);
        assert.deepEqual(first.sourceRequirements, second.sourceRequirements);
        assert.deepEqual(first.constraintIRs, second.constraintIRs);
        assert.equal([first.cacheHit, second.cacheHit].filter(Boolean).length, 1);

        const freshCache = createTimetableConstraintParseCache({ dataDir });
        const diskValue = await freshCache.get(first.determinism.cacheKey);
        assert.ok(diskValue);
        assert.deepEqual(diskValue.sourceRequirements, first.sourceRequirements);
        assert.deepEqual(diskValue.constraintIRs, first.constraintIRs);

        const changedSeed = await parseTimetableRules({
            text: '七年级1班数学尽量安排在上午。',
            project: project(),
            env: { ...env, TIMETABLE_RULE_AI_SEED: '18' },
            fetchImpl,
        });
        assert.equal(aiCalls, 2);
        assert.notEqual(changedSeed.determinism.cacheKey, first.determinism.cacheKey);
    } finally {
        await rm(dataDir, { recursive: true, force: true });
    }
});

test('persistent parse cache does not store values rejected by the admission gate', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'icecream-constraint-cache-admission-'));
    const cache = createTimetableConstraintParseCache({ dataDir });
    let productions = 0;

    try {
        const produce = async () => ({ sequence: ++productions, invalid: true });
        const options = { shouldCache: value => value.invalid !== true };
        const first = await cache.getOrCreate('rejected-result', produce, options);
        const second = await cache.getOrCreate('rejected-result', produce, options);

        assert.equal(first.cacheHit, false);
        assert.equal(second.cacheHit, false);
        assert.equal(productions, 2);
        assert.equal(await cache.get('rejected-result'), null);
    } finally {
        await rm(dataDir, { recursive: true, force: true });
    }
});
