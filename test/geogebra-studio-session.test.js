import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const studioUrl = new URL('../public/js/core/geogebra-studio.js', import.meta.url);
const studioShellUrl = new URL('../public/js/core/geogebra-studio-shell.js', import.meta.url);

test('GeoGebra Studio starts new opens without restoring stale problem review state', async () => {
  const previousWindow = global.window;
  const previousLocalStorage = global.localStorage;
  const previousDocument = global.document;

  const staleSession = {
    commandHistory: [{ command: 'A = (0, 0)', success: true }],
    pendingProblemPlan: {
      summary: 'stale plan',
      commands: ['A = (0, 0)'],
    },
    problemReviewText: '旧题目不应该在新打开时显示',
    problemExtractedText: '旧 OCR',
    problemImageDescription: '旧图像描述',
    problemParseStatus: '旧解析状态',
    latestSummary: '旧摘要',
    latestFollowUp: '旧建议',
    studioNotes: '旧说明',
    latestError: '旧错误',
  };
  const localStorageStub = {
    getItem: key => (key === 'icecream_geogebra_studio_v2' ? JSON.stringify(staleSession) : null),
    setItem: () => {},
  };

  global.window = { localStorage: localStorageStub };
  global.localStorage = localStorageStub;
  global.document = {
    createElement: () => {
      const element = {
        _textContent: '',
        set textContent(value) {
          this._textContent = String(value || '');
          this.innerHTML = this._textContent
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
        },
        get textContent() {
          return this._textContent;
        },
        innerHTML: '',
      };
      return element;
    },
  };
  try {
    const { geogebraStudio } = await import(`${studioUrl.href}?session=${Date.now()}`);
    const html = geogebraStudio.render();

    assert.doesNotMatch(html, /题目解析复核/);
    assert.doesNotMatch(html, /旧题目不应该在新打开时显示/);
    assert.doesNotMatch(html, /旧解析状态/);
    assert.doesNotMatch(html, /旧摘要/);
    assert.deepEqual(geogebraStudio.commandHistory.map(item => item.command), ['A = (0, 0)']);
  } finally {
    global.window = previousWindow;
    global.localStorage = previousLocalStorage;
    global.document = previousDocument;
  }
});

test('GeoGebra reset clears transient uploaded-problem state as well as canvas state', async () => {
  const source = await readFile(studioUrl, 'utf8');

  assert.match(source, /icecream_geogebra_studio_v2/);
  assert.doesNotMatch(source, /icecream_geogebra_studio_v1/);
  assert.match(source, /clearTransientProblemState/);
  assert.match(source, /resetCanvas\(\)[\s\S]*this\.clearTransientProblemState\(\)/);
  assert.doesNotMatch(source, /pendingProblemPlan:\s*this\.pendingProblemPlan/);
  assert.doesNotMatch(source, /problemReviewText:\s*this\.problemReviewText/);
});

test('GeoGebra Studio shell clears transient problem state on each open', async () => {
  const source = await readFile(studioShellUrl, 'utf8');

  assert.match(source, /open\(\)[\s\S]*geogebraWorkbench\.clearTransientProblemState\(\)/);
});
