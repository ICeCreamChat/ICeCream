import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MARKET_LANGUAGE_CATEGORIES,
    aggregateCorpusScores,
    countExpectedFieldChecks,
    loadConstraintCorpus,
    localParseResultToRequirements,
    normalizeCorpusRow,
    parseCorpusJsonl,
    scoreCorpusRow,
    validateConstraintCorpus,
} from '../scripts/lib/timetable-market-language-corpus.js';

const EXPECTED_CORPUS_HASH = 'ff22d5a11b12e8c71f1e567b32106f075f264b34f95ab1b54de5aae619ea2678';

test('market-language corpus has stable JSONL schema, hash and approved quotas', async () => {
    const corpus = await loadConstraintCorpus();
    assert.deepEqual(corpus.errors, []);
    assert.equal(corpus.hash, EXPECTED_CORPUS_HASH);

    const validation = validateConstraintCorpus(corpus.rows);
    assert.equal(validation.valid, true, validation.errors.join('\n'));
    assert.equal(validation.metrics.rowCount, 205);
    assert.equal(validation.metrics.uniqueIdCount, 205);
    assert.ok(validation.metrics.expectedClauseCount >= 125);
    assert.ok(countExpectedFieldChecks(corpus.rows) >= 300);
    for (const category of MARKET_LANGUAGE_CATEGORIES) {
        assert.equal(validation.metrics.categoryCounts[category], 15, category);
        assert.equal(validation.metrics.primaryCounts[category], 15, category);
    }
});
test('legacy rows remain readable while expectedFields aliases expectedClauses', () => {
    const legacy = normalizeCorpusRow({ id: 'legacy', text: '数学尽量上午', expectedIntents: ['subject_morning'] });
    assert.deepEqual(legacy.categories, []);
    assert.equal(legacy.understandingStatus, 'understood');
    assert.equal(legacy.executionStatus, 'ready');

    const compatible = normalizeCorpusRow({
        id: 'compatible',
        text: '张老师周一没空',
        expectedFields: [{ intent: 'teacher_unavailable', targetNames: ['张老师'] }],
    });
    assert.deepEqual(compatible.expectedIntents, ['teacher_unavailable']);
    assert.equal(compatible.expectedClauses.length, 1);
});

test('corpus validator rejects duplicate ids, empty text, unknown categories, missing truth and cross-label quota inflation', () => {
    const seed = MARKET_LANGUAGE_CATEGORIES.flatMap((category, categoryIndex) => Array.from({ length: 15 }, (_, index) => ({
        id: `s${categoryIndex}_${index}`,
        text: `${category}-${index}`,
        categories: [category],
        primaryCategory: category,
        expectedIntents: ['unknown'],
    })));
    while (seed.length < 200) seed.push({ id: `legacy_${seed.length}`, text: 'legacy', expectedIntents: ['unknown'] });
    seed[1].id = seed[0].id;
    seed[2].text = '   ';
    seed[3].categories = ['not_a_category'];
    seed[3].primaryCategory = 'not_a_category';
    seed[4].expectedIntents = [];
    seed[5].categories = ['colloquial'];
    seed[5].primaryCategory = 'noisy_text';

    const validation = validateConstraintCorpus(seed);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some(error => error.includes('duplicate id')));
    assert.ok(validation.errors.some(error => error.includes('text is required')));
    assert.ok(validation.errors.some(error => error.includes('unknown category')));
    assert.ok(validation.errors.some(error => error.includes('expected truth is required')));
    assert.ok(validation.errors.some(error => error.includes('primaryCategory must also appear in categories')));
});

test('JSONL parser reports line-level malformed JSON without dropping valid rows', () => {
    const result = parseCorpusJsonl('{"id":"ok","text":"x","expectedIntents":["unknown"]}\nnot-json\n');
    assert.equal(result.rows.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /:2: invalid JSON/);
});

test('local result mapper exposes nested room names as target names', () => {
    const [actual] = localParseResultToRequirements({
        requirementItems: [{
            intent: 'room_requirement',
            object: { kind: 'subject', name: '实验课' },
            parameters: {
                roomName: '实验室',
                roomNames: ['化学实验室'],
                roomRequirement: { roomName: '实验室', roomNames: ['物理实验室'] },
            },
        }],
    });

    assert.deepEqual(actual.targetNames, ['实验课', '化学实验室', '实验室', '物理实验室']);
});

test('unified scorer accepts an explicit unrecognized semantic result as a safe non-timetable input', () => {
    const row = normalizeCorpusRow({
        id: 'unrecognized_1',
        text: '校车下午几点发车（不是排课要求）',
        unrecognized: true,
        expectedIntents: [],
        expectedClauses: [],
    });
    const score = scoreCorpusRow(row, [{ intent: 'unrecognized' }]);

    assert.equal(score.unrecognizedOk, true);
    assert.equal(score.covered, true);
});

test('local result mapper preserves an explicit semantic intent ahead of canonical row type', () => {
    const [actual] = localParseResultToRequirements({
        requirementItems: [{
            intent: 'subject_group',
            type: 'subject.avoid_periods',
            capabilityId: 'subject.avoid_periods',
        }],
    });

    assert.equal(actual.intent, 'subject_group');
    assert.equal(actual.capabilityId, 'subject.avoid_periods');
});

test('unified scorer retains canonical row type as an equivalent intent after preserving semantic intent', () => {
    const [actual] = localParseResultToRequirements({
        draftRows: [{ intent: 'preferred_day_part', type: 'subject_morning' }],
    });
    const score = scoreCorpusRow({
        id: 'dual_intent_1',
        text: '数学尽量上午',
        expectedIntents: ['subject_morning'],
    }, [actual]);

    assert.equal(actual.intent, 'preferred_day_part');
    assert.equal(score.covered, true);
});

test('derived scorer aliases inspect semantic intent and canonical type together', () => {
    const [avoid] = localParseResultToRequirements({
        draftRows: [{
            intent: 'avoid_periods',
            type: 'subject_avoid_periods',
            targetType: 'subject',
            targetName: '体育',
            periods: [1],
            priority: 'soft',
            rawText: '体育避开第一节',
        }],
    });
    const avoidScore = scoreCorpusRow({
        id: 'derived_avoid_1',
        text: '体育避开第一节',
        expectedIntents: ['avoid_first_period'],
        expectedClauses: [{
            intent: 'avoid_first_period',
            targetKind: 'subject',
            targetNames: ['体育'],
            strength: 'soft',
        }],
    }, [avoid]);

    const [golden] = localParseResultToRequirements({
        draftRows: [{
            intent: 'preferred_day_part',
            type: 'subject_morning',
            rawText: '主科尽量排上午黄金时段',
        }],
    });
    const goldenScore = scoreCorpusRow({
        id: 'derived_golden_1',
        text: '主科尽量排上午黄金时段',
        expectedIntents: ['golden_hour_preference'],
    }, [golden]);

    assert.equal(avoidScore.covered, true);
    assert.equal(avoidScore.fields.hits, avoidScore.fields.total);
    assert.equal(goldenScore.covered, true);
});

test('unified scorer measures intent, fields, clarification and source preservation by category', () => {
    const row = normalizeCorpusRow({
        id: 'score_1',
        text: '张老师周一上午不能排课',
        categories: ['colloquial'],
        primaryCategory: 'colloquial',
        expectedIntents: ['teacher_unavailable'],
        expectedClauses: [{
            intent: 'teacher_unavailable',
            targetKind: 'teacher',
            targetNames: ['张老师'],
            time: { days: [1], dayPart: 'morning' },
            strength: 'hard',
        }],
    });
    const actual = [{
        intent: 'teacher_unavailable',
        targetKind: 'teacher',
        targetNames: ['张老师'],
        time: { days: [1], dayPart: 'morning' },
        strength: 'hard',
        sourceId: 'src_1',
        textHash: 'hash_1',
    }];
    const score = scoreCorpusRow(row, actual, {
        sourceRequirements: [{ sourceId: 'src_1', textHash: 'hash_1', rawText: row.text }],
    });
    assert.equal(score.covered, true);
    assert.equal(score.fields.hits, score.fields.total);
    assert.equal(score.sourcePreserved, true);
    assert.equal(score.sourceAligned, true);

    const aggregate = aggregateCorpusScores([score]);
    assert.equal(aggregate.coverage, 1);
    assert.equal(aggregate.fieldAccuracy, 1);
    assert.equal(aggregate.sourcePreservationRate, 1);
    assert.equal(aggregate.categoryMetrics.colloquial.rows, 1);
});
