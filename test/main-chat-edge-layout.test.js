import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mainCssPath = new URL('../public/css/main.css', import.meta.url);
const mobileCssPath = new URL('../public/css/mobile.css', import.meta.url);

function getBlocks(css, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, 'g'))].map(match => match[0]);
}

test('main chat messages and input use an edge-aligned rail instead of centered padding', async () => {
  const mainStyles = await readFile(mainCssPath, 'utf8');
  const mobileStyles = await readFile(mobileCssPath, 'utf8');
  const messageBlocks = getBlocks(mainStyles, '.messages');
  const inputBlocks = getBlocks(mainStyles, '.input-area');

  assert.match(mainStyles, /--chat-edge-gutter:\s*clamp\(28px,\s*4vw,\s*72px\)/);
  assert.match(mainStyles, /--chat-edge-gutter:\s*clamp\(12px,\s*4vw,\s*20px\)/);
  assert.ok(messageBlocks.length > 0);
  assert.ok(inputBlocks.length > 0);

  assert.ok(messageBlocks.every(block => !block.includes('chat-rail-width')));
  assert.ok(inputBlocks.every(block => !block.includes('chat-rail-width')));

  assert.match(messageBlocks.at(-1), /padding-inline:\s*var\(--chat-edge-gutter\)/);
  assert.match(inputBlocks.at(-1), /padding-inline:\s*var\(--chat-edge-gutter\)/);
  assert.ok(mainStyles.lastIndexOf('.messages') > mainStyles.lastIndexOf('@media (min-width: 1440px)'));
  assert.ok(mainStyles.lastIndexOf('.input-area') > mainStyles.lastIndexOf('@media (min-width: 1440px)'));

  assert.match(mainStyles, /\.message\.bot\s*{[^}]*margin-right:\s*auto/s);
  assert.match(mainStyles, /\.message\.user\s*{[^}]*margin-left:\s*auto/s);
  assert.match(mobileStyles, /\.input-area\s*{[^}]*padding-bottom: calc\(12px \+ env\(safe-area-inset-bottom, 0\)\)/s);
  assert.match(mobileStyles, /\.messages\s*{[^}]*overflow-x:\s*hidden/s);
});
