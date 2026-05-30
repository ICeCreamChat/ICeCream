import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sessionManagerPath = new URL('../public/js/core/session-manager.js', import.meta.url);
const messageHandlerPath = new URL('../public/js/core/message-handler.js', import.meta.url);

test('session manager exposes current chat context with assistant role mapping', async () => {
  const source = await readFile(sessionManagerPath, 'utf8');

  assert.match(source, /getChatContext\s*\(/);
  assert.match(source, /sourceRole\s*===\s*['"]bot['"]\s*\?\s*['"]assistant['"]/);
  assert.match(source, /slice\(-40\)/);
  assert.match(source, /role\s*===\s*['"]user['"]\s*\|\|\s*role\s*===\s*['"]assistant['"]/);
});

test('message handler sends chat context only for text chat requests', async () => {
  const source = await readFile(messageHandlerPath, 'utf8');

  assert.match(source, /const\s+chatContext\s*=/);
  assert.match(source, /sendToServer\(message,\s*imageForServer,\s*mode,\s*chatContext\)/);
  assert.match(source, /formData\.append\(['"]messages['"],\s*JSON\.stringify\(chatContext\)\)/);
  assert.match(source, /mode\s*===\s*['"]chat['"]\s*\|\|\s*mode\s*===\s*['"]auto['"]/);
  assert.match(source, /!imageBase64/);
});

test('message handler preserves solver solution and warns when solver metadata is incomplete', async () => {
  const source = await readFile(messageHandlerPath, 'utf8');

  assert.match(source, /case\s+['"]solver['"]/);
  assert.match(source, /data\.solution\s*\|\|\s*['"]解题完成['"]/);
  assert.match(source, /solverMeta/);
  assert.match(source, /completed\s*===\s*false/);
  assert.match(source, /本次回答可能仍未完整/);
});
