import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getGeoGebraCommandIndexStatus,
  searchGeoGebraCommands,
} from '../services/geogebra/command-search.js';

test('GeoGebra command index loads once and exposes status', () => {
  const status = getGeoGebraCommandIndexStatus();

  assert.equal(status.ready, true);
  assert.ok(status.commandCount > 100);
});

test('GeoGebra command search returns stable command overloads', () => {
  const matches = searchGeoGebraCommands('Circle', 5);

  assert.ok(matches.length > 0);
  assert.equal(matches[0].commandBase, 'Circle');
  assert.ok(matches[0].overloads.length > 0);
  assert.equal(typeof matches[0].overloads[0].signature, 'string');
});

test('GeoGebra command search clamps empty and excessive limits', () => {
  assert.deepEqual(searchGeoGebraCommands('', 5), []);
  assert.ok(searchGeoGebraCommands('Point', 99).length <= 10);
  assert.ok(searchGeoGebraCommands('Point', -1).length <= 5);
});
