import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexPath = new URL('../public/index.html', import.meta.url);
const mainStylePath = new URL('../public/css/main.css', import.meta.url);
const mobileStylePath = new URL('../public/css/mobile.css', import.meta.url);
const messageHandlerPath = new URL('../public/js/core/message-handler.js', import.meta.url);
const imageUploaderPath = new URL('../public/js/core/image-uploader.js', import.meta.url);

test('main chat uses workbench composer DOM contract', async () => {
  const source = await readFile(indexPath, 'utf8');
  const header = source.slice(source.indexOf('<header class="header-bar">'), source.indexOf('</header>'));
  const composer = source.slice(source.indexOf('<div class="input-area">'), source.indexOf('</main>'));

  assert.doesNotMatch(header, /id="mode-switcher"/);
  assert.match(composer, /class="composer-shell"/);
  assert.match(composer, /class="composer-topbar"[\s\S]*id="mode-switcher"/);
  assert.match(composer, /id="mode-hint"/);
  assert.match(composer, /id="attachment-preview"/);
  assert.match(composer, /id="attachment-remove"/);
  assert.match(composer, /class="composer-body"[\s\S]*<textarea[^>]+id="chat-input"[\s\S]*<\/textarea>/);
  assert.match(composer, /class="composer-footer"/);
  assert.match(composer, /id="send-btn"/);
  assert.match(composer, /id="upload-btn"/);
});

test('main chat composer supports multiline input and staged attachments', async () => {
  const [messageHandlerSource, imageUploaderSource] = await Promise.all([
    readFile(messageHandlerPath, 'utf8'),
    readFile(imageUploaderPath, 'utf8'),
  ]);
  const croppedHandler = imageUploaderSource.slice(
    imageUploaderSource.indexOf('sendWithCroppedImage()'),
    imageUploaderSource.indexOf('sendWithOriginalImage()')
  );

  assert.match(messageHandlerSource, /attachmentPreview/);
  assert.match(messageHandlerSource, /attachmentRemove/);
  assert.match(messageHandlerSource, /_autoResizeInput/);
  assert.match(messageHandlerSource, /scrollHeight/);
  assert.match(messageHandlerSource, /e\.key === 'Enter' && !e\.shiftKey/);
  assert.match(messageHandlerSource, /this\._renderAttachmentPreview\(\)/);
  assert.match(messageHandlerSource, /this\._autoResizeInput\(\)/);

  assert.match(croppedHandler, /messageHandler\.setPendingImage\(croppedBase64\)/);
  assert.match(croppedHandler, /messageHandler\.renderAttachmentPreview\(\)/);
  assert.doesNotMatch(croppedHandler, /this\.sendInternal\(\)/);
});

test('main chat styles define quiet workbench layout without animated avatar distraction', async () => {
  const [mainStyles, mobileStyles] = await Promise.all([
    readFile(mainStylePath, 'utf8'),
    readFile(mobileStylePath, 'utf8'),
  ]);

  assert.match(mainStyles, /\.composer-shell\s*{/);
  assert.match(mainStyles, /\.composer-topbar\s*{/);
  assert.match(mainStyles, /\.composer-body\s*{/);
  assert.match(mainStyles, /\.composer-footer\s*{/);
  assert.match(mainStyles, /#chat-input\s*{[^}]*max-height:\s*160px/s);
  assert.match(mainStyles, /#attachment-preview\s*{/);
  assert.doesNotMatch(mainStyles, /\.message-avatar:hover\s*{[^}]*scale/s);
  assert.doesNotMatch(mainStyles, /animation:\s*breath/);

  assert.match(mobileStyles, /\.composer-shell\s*{/);
  assert.match(mobileStyles, /\.mode-switcher\s*{[^}]*overflow-x: auto/s);
  assert.match(mobileStyles, /#chat-input\s*{[^}]*max-height:\s*140px/s);
  assert.match(mobileStyles, /\.input-area\s*{[^}]*padding-bottom: calc\(12px \+ env\(safe-area-inset-bottom, 0\)\)/s);
});
