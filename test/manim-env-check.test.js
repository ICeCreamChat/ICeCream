import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildImportProbeScript,
  createDependencyEnsurer,
} from '../scripts/check-manim-env.js';

test('Manim dependency checker repairs a hashed environment with broken imports', () => {
  const installs = [];
  const writes = [];
  const messages = [];
  let probeAttempts = 0;

  const ensureDependencies = createDependencyEnsurer({
    readPreviousHash: () => 'same-hash',
    installDependencies: options => installs.push(options),
    runImportProbe: () => {
      probeAttempts += 1;
      if (probeAttempts === 1) {
        throw new Error('broken openai import');
      }
    },
    writeCurrentHash: hash => writes.push(hash),
    log: message => messages.push(message),
    warn: message => messages.push(message),
  });

  ensureDependencies('same-hash');

  assert.deepEqual(installs, [{ force: true }]);
  assert.equal(probeAttempts, 2);
  assert.deepEqual(writes, ['same-hash']);
  assert.match(messages.join('\n'), /Import probe failed/);
});

test('Manim dependency checker validates new installs before writing hash marker', () => {
  const events = [];

  const ensureDependencies = createDependencyEnsurer({
    readPreviousHash: () => 'old-hash',
    installDependencies: options => events.push(['install', options.force]),
    runImportProbe: () => events.push(['probe']),
    writeCurrentHash: hash => events.push(['write', hash]),
    log: () => {},
    warn: () => {},
  });

  ensureDependencies('new-hash');

  assert.deepEqual(events, [
    ['install', false],
    ['probe'],
    ['write', 'new-hash'],
  ]);
});

test('Manim import probe covers the OpenAI client and shared OAuth export', () => {
  const probeScript = buildImportProbeScript();

  assert.match(probeScript, /from openai import AsyncOpenAI/);
  assert.match(probeScript, /from openai\.types\.shared import OAuthErrorCode/);
});
