import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const propertiesUrl = new URL('../solver/src/main/resources/application.properties', import.meta.url);

test('timetable solver keeps optimizing soft score after reaching zero hard score', () => {
    const properties = readFileSync(propertiesUrl, 'utf8');

    assert.match(
        properties,
        /^quarkus\.timefold\.solver\."timetable"\.environment-mode=no-assert$/m,
    );
    assert.doesNotMatch(
        properties,
        /^(?:%test\.)?quarkus\.timefold\.solver\."timetable"\.termination\.best-score-limit=/m,
    );
    assert.match(
        properties,
        /^quarkus\.timefold\.solver\."timetable"\.termination\.unimproved-spent-limit=\$\{TIMETABLE_SOLVER_UNIMPROVED_SPENT_LIMIT:20s\}$/m,
    );
    assert.match(
        properties,
        /^%test\.quarkus\.timefold\.solver\."timetable"\.termination\.unimproved-spent-limit=1s$/m,
    );
});

test('timetable solver uses focused change and compatible placement swaps for hard-first search', () => {
    const configUrl = new URL('../solver/src/main/resources/timetableSolverConfig.xml', import.meta.url);
    const config = readFileSync(configUrl, 'utf8');

    assert.match(config, /<acceptorType>ENTITY_TABU<\/acceptorType>/);
    assert.match(config, /<acceptorType>LATE_ACCEPTANCE<\/acceptorType>/);
    assert.match(config, /<bestScoreFeasible>true<\/bestScoreFeasible>/);
    assert.match(
        config,
        /<moveIteratorFactoryClass>com\.icecream\.timetable\.solver\.CompatiblePlacementSwapMoveIteratorFactory<\/moveIteratorFactoryClass>/,
    );
    assert.match(
        config,
        /<moveIteratorFactory>[\s\S]*?<fixedProbabilityWeight>100\.0<\/fixedProbabilityWeight>[\s\S]*?<moveIteratorFactoryClass>com\.icecream\.timetable\.solver\.CompatiblePlacementChainMoveIteratorFactory<\/moveIteratorFactoryClass>[\s\S]*?<\/moveIteratorFactory>/,
    );
    const hardFirstPhase = config.match(/<localSearch>[\s\S]*?<\/localSearch>/)?.[0] || '';
    assert.match(hardFirstPhase, /<changeMoveSelector>/);
    assert.doesNotMatch(hardFirstPhase, /<swapMoveSelector>|<ruinRecreateMoveSelector>/);
    assert.doesNotMatch(config, /SingleLessonAssignmentSelectionFilter|ConsecutiveBlockMoveIteratorFactory/);
});
