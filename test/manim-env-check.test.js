import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('Manim dependency checker rebuilds the virtualenv when pip is broken', () => {
  const events = [];
  let probeAttempts = 0;
  let rebuilt = false;

  const ensureDependencies = createDependencyEnsurer({
    readPreviousHash: () => 'same-hash',
    installDependencies: options => {
      events.push(['install', options.force]);
      if (options.force && !rebuilt) {
        throw new Error('pip is broken');
      }
    },
    runImportProbe: () => {
      events.push(['probe']);
      probeAttempts += 1;
      if (probeAttempts === 1) {
        throw new Error('broken imports');
      }
    },
    rebuildEnvironment: () => {
      events.push(['rebuild']);
      rebuilt = true;
    },
    writeCurrentHash: hash => events.push(['write', hash]),
    log: () => {},
    warn: () => {},
  });

  ensureDependencies('same-hash');

  assert.deepEqual(events, [
    ['probe'],
    ['install', true],
    ['rebuild'],
    ['install', true],
    ['probe'],
    ['write', 'same-hash'],
  ]);
});

test('Manim dependency checker rebuilds the virtualenv when required install fails', () => {
  const events = [];
  let rebuilt = false;

  const ensureDependencies = createDependencyEnsurer({
    readPreviousHash: () => 'old-hash',
    installDependencies: options => {
      events.push(['install', options.force]);
      if (!rebuilt) {
        throw new Error('pip cannot install');
      }
    },
    runImportProbe: () => events.push(['probe']),
    rebuildEnvironment: () => {
      events.push(['rebuild']);
      rebuilt = true;
    },
    writeCurrentHash: hash => events.push(['write', hash]),
    log: () => {},
    warn: () => {},
  });

  ensureDependencies('new-hash');

  assert.deepEqual(events, [
    ['install', false],
    ['rebuild'],
    ['install', true],
    ['probe'],
    ['write', 'new-hash'],
  ]);
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

  assert.match(probeScript, /sys\.version_info\[:2\] != \(3, 12\)/);
  assert.match(probeScript, /PYTHON_VERSION_MISMATCH/);
  assert.match(probeScript, /from openai import AsyncOpenAI/);
  assert.match(probeScript, /from openai\.types\.shared import OAuthErrorCode/);
});

test('Manim environment checker is pinned to Python 3.12 virtualenvs', async () => {
  const checker = await readFile(new URL('../scripts/check-manim-env.js', import.meta.url), 'utf8');

  assert.match(checker, /requiredPythonVersion = '3\.12'/);
  assert.match(checker, /py', args: \['-3\.12'\]/);
  assert.match(checker, /\.python-version/);
  assert.match(checker, /rebuilding with Python/);
});

test('Manim startup entry points run the environment checker before service launch', async () => {
  const [devBatch, runManim, rootMain, agentRoutes] = await Promise.all([
    readFile(new URL('../dev.bat', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/run-manim.js', import.meta.url), 'utf8'),
    readFile(new URL('../manim-service/main.py', import.meta.url), 'utf8'),
    readFile(new URL('../manim-service/app/agent/routes.py', import.meta.url), 'utf8'),
  ]);

  assert.match(devBatch, /node scripts\\check-manim-env\.js/);
  assert.match(runManim, /check-manim-env\.js/);
  assert.match(runManim, /spawnSync/);
  assert.match(devBatch, /python\.exe main\.py/);
  assert.match(runManim, /\['main\.py'\]/);
  assert.match(rootMain, /from app\.main import app, run/);
  assert.doesNotMatch(rootMain, /FastAPI/);
  assert.doesNotMatch(rootMain, /register_agent_routes/);
  assert.match(agentRoutes, /\/agent\/stream/);
});

test('dev.bat rebuilds Timefold when solver sources are newer than the packaged jar', async () => {
  const devBatch = await readFile(new URL('../dev.bat', import.meta.url), 'utf8');

  assert.match(devBatch, /TIMEFOLD_REBUILD/);
  assert.match(devBatch, /quarkus-run\.jar/);
  assert.match(devBatch, /LastWriteTimeUtc/);
  assert.match(devBatch, /solver\\src\\main/);
  assert.match(devBatch, /solver\\pom\.xml/);
});

test('dev.bat exposes timetable solver timeout defaults without overwriting user settings', async () => {
  const devBatch = await readFile(new URL('../dev.bat', import.meta.url), 'utf8');
  const solverProperties = await readFile(new URL('../solver/src/main/resources/application.properties', import.meta.url), 'utf8');

  assert.match(devBatch, /if not defined TIMETABLE_SOLVER_TIMEOUT set "TIMETABLE_SOLVER_TIMEOUT=210"/);
  assert.match(devBatch, /if not defined TIMETABLE_SOLVER_SPENT_LIMIT set "TIMETABLE_SOLVER_SPENT_LIMIT=180s"/);
  assert.match(devBatch, /Timetable solver timeout:/);
  assert.match(solverProperties, /quarkus\.timefold\.solver\."timetable"\.termination\.spent-limit=\$\{TIMETABLE_SOLVER_SPENT_LIMIT:180s\}/);
});
