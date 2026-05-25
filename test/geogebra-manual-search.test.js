import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getGeoGebraManualIndexStatus,
  normalizeManualSearchLimit,
  searchGeoGebraManual,
} from '../services/geogebra/manual-search.js';

test('GeoGebra manual index exposes compact reference status', () => {
  const status = getGeoGebraManualIndexStatus();

  assert.equal(status.ready, true);
  assert.ok(status.entryCount >= 20);
  assert.ok(status.types.includes('command'));
  assert.ok(status.types.includes('api'));
});

test('GeoGebra manual search returns command syntax and examples', () => {
  const matches = searchGeoGebraManual('locus midpoint circle', 5);

  assert.ok(matches.length > 0);
  assert.ok(matches.some(match => match.title === 'Locus'));
  assert.ok(matches.some(match => match.title === 'Circle'));
  assert.ok(matches.every(match => Array.isArray(match.examples)));
  assert.ok(matches.every(match => typeof match.summary === 'string'));
});

test('GeoGebra manual search covers API save and restore references', () => {
  const matches = searchGeoGebraManual('base64 save restore ggb', 10);

  assert.ok(matches.some(match => match.title === 'getBase64'));
  assert.ok(matches.some(match => match.title === 'setBase64'));
});

test('GeoGebra manual search clamps invalid limits', () => {
  assert.equal(normalizeManualSearchLimit('999'), 10);
  assert.equal(normalizeManualSearchLimit('-1'), 5);
  assert.equal(searchGeoGebraManual('', 5).length, 0);
});
