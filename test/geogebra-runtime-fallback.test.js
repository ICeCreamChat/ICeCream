import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canvasPath = new URL('../public/js/core/geogebra-canvas.js', import.meta.url);

test('GeoGebra canvas includes iframe fallback and bridge messaging', async () => {
  const canvasSource = await readFile(canvasPath, 'utf8');

  assert.match(canvasSource, /mountIframeFallback/);
  assert.match(canvasSource, /postMessage/);
  assert.match(canvasSource, /geogebra-iframe-fallback/);
  assert.match(canvasSource, /geogebraRuntimeMode/);
  assert.match(canvasSource, /direct/);
  assert.match(canvasSource, /iframe/);
});

test('GeoGebra canvas exposes ggb base64 save and restore APIs', async () => {
  const canvasSource = await readFile(canvasPath, 'utf8');

  assert.match(canvasSource, /getBase64/);
  assert.match(canvasSource, /setBase64/);
  assert.match(canvasSource, /exportGgbBase64/);
});
