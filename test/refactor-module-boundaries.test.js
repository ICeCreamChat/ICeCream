import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const moduleContracts = [
    ['timetable-rule-parser-cache.js', [
        'parseCacheKey', 'getParseCache', 'setParseCache', 'parseWithPersistentCache',
        'determinismMetadata', 'withParseMetadata', 'parseResultPassesCacheAdmission',
        'persistentParseCacheEnabled',
    ]],
    ['timetable-rule-parser-sources.js', [
        'sourceRowsForParse', 'prepareSourceInputs', 'parserActors',
    ]],
    ['timetable-rule-parser-artifacts.js', [
        'artifactProvenance', 'constraintArtifactFromRow', 'semanticConstraintArtifact',
        'fallbackConstraintArtifact', 'aggregateSourceWarnings', 'buildWarningItems',
    ]],
    ['timetable-rule-parser-ir.js', [
        'mergeConstraintIR', 'compactCapabilityIRs', 'warningsForConstraintExecution',
    ]],
    ['seating-arrange-spec.js', [
        'normalizeArrangeRequest', 'normalizeArrangementSpec', 'normalizeLayoutPlan',
        'validateLayoutPlan', 'shouldAllowUnassigned', 'strategyOverrideWarnings',
        'appliedStrategiesFor',
    ]],
    ['seating-arrange-layout.js', [
        'runAiLayoutPreview', 'buildPreviewLayoutFromSpec', 'buildLocalArrangement',
        'buildArrangeMessages', 'parseAiJson', 'isAiJsonParseError',
        'buildArrangeRepairPrompt',
    ]],
    ['seating-arrange-assignment.js', [
        'assignStudentsToLayout', 'assignLocalSeats', 'chooseGuardians',
        'optimizeSeatingScore', 'refineSeatingAssignments',
        'buildArrangementInterpretation', 'validateAiArrangement',
    ]],
    ['timetable-local-scheduler.js', [
        'runTimetableScheduler', 'buildSchedulingUnits',
    ]],
    ['timetable-ai-extraction-validator.js', [
        'validateExtractionPayload', 'resolveEntityRefs',
    ]],
];

const facadeLineLimits = [
    ['timetable-rule-parser.js', 2_000],
    ['seating-arrange.js', 300],
    ['timetable-diagnostic-scheduler.js', 800],
    ['timetable-ai-extractor.js', 1_200],
];

const facadeContracts = [
    ['timetable-rule-parser.js', [
        'TimetableRuleParseError', 'applyTimetableRequirementActions',
        'continueTimetableRuleConversation', 'continueTimetableRequirementClarification',
        'diagnoseTimetableRules', 'normalizeTimetableRuleDraftRows',
        'rebindTimetableRuleResult', 'recompileTimetableSourceRequirement',
        'parserShadowTextWithTrace', 'applyAiReviewToParseResult', 'parseTimetableRules',
    ]],
    ['seating-arrange.js', [
        'normalizeArrangeRequest', 'shouldAllowUnassigned', 'validateAiArrangement',
        'buildArrangeRepairPrompt', 'buildArrangeMessages', 'parseAiJson',
        'isAiJsonParseError', 'optimizeSeatingScore', 'runAiLayoutPreview',
        'runAiDrivenArrangement', 'requestAiArrangement', 'requestArrangementSpec',
    ]],
    ['timetable-diagnostic-scheduler.js', [
        'analyzeTimetableFeasibility', 'buildConflictComponent',
        'buildSchedulingUnits', 'runTimetableScheduler',
    ]],
    ['timetable-ai-extractor.js', [
        'TimetableAiExtractionError', 'resetTimetableAiExtractionCache',
        'getTimetableAiExtractionCacheStats', 'buildAiExtractionPromptProjectForTests',
        'validateExtractionPayload', 'resolveEntityRefs', 'extractRequirementsWithAI',
    ]],
];

const definitionContracts = [
    ['timetable-rule-parser.js', facadeContracts[0][1].filter(name => name !== 'TimetableRuleParseError')],
    ['timetable-rule-parser-cache.js', moduleContracts[0][1]],
    ['timetable-rule-parser-sources.js', moduleContracts[1][1]],
    ['timetable-rule-parser-artifacts.js', moduleContracts[2][1]],
    ['timetable-rule-parser-ir.js', moduleContracts[3][1]],
    ['timetable-local-scheduler.js', moduleContracts[7][1]],
    ['timetable-ai-extraction-validator.js', moduleContracts[8][1]],
];

test('refactored service modules expose their focused contracts', async () => {
    for (const [fileName, exportNames] of moduleContracts) {
        const serviceModule = await import(`../gateway/services/${fileName}`);
        for (const exportName of exportNames) {
            assert.equal(
                typeof serviceModule[exportName],
                'function',
                `${fileName} must export ${exportName}`,
            );
        }
    }
});

test('legacy service facades stay below the refactor size limits', async () => {
    for (const [fileName, limit] of facadeLineLimits) {
        const source = await readFile(new URL(`../gateway/services/${fileName}`, import.meta.url), 'utf8');
        assert.ok(
            source.split(/\r?\n/).length < limit,
            `${fileName} must stay below ${limit} lines`,
        );
    }
});

test('legacy service facades preserve their complete export surfaces', async () => {
    for (const [fileName, exportNames] of facadeContracts) {
        const serviceModule = await import(`../gateway/services/${fileName}`);
        assert.deepEqual(
            Object.keys(serviceModule).sort(),
            [...exportNames].sort(),
            `${fileName} export surface changed`,
        );
    }
});

test('named responsibilities are defined in their target modules', async () => {
    for (const [fileName, functionNames] of definitionContracts) {
        const source = await readFile(new URL(`../gateway/services/${fileName}`, import.meta.url), 'utf8');
        for (const functionName of functionNames) {
            assert.match(
                source,
                new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`),
                `${fileName} must contain the ${functionName} function body`,
            );
        }
    }
});

test('rule parser no longer relies on the removed monolithic core', async () => {
    await assert.rejects(
        access(new URL('../gateway/services/timetable-rule-parser-core.js', import.meta.url)),
    );
    const serviceFiles = [
        'timetable-rule-parser.js',
        'timetable-rule-parser-cache.js',
        'timetable-rule-parser-sources.js',
        'timetable-rule-parser-artifacts.js',
        'timetable-rule-parser-ir.js',
    ];
    for (const fileName of serviceFiles) {
        const source = await readFile(new URL(`../gateway/services/${fileName}`, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /timetable-rule-parser-core\.js/);
    }
});
