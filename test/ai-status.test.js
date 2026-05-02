import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  checkAiStatus,
  clearAiStatusCache,
  DEFAULT_AI_STATUS_TTL_MS,
} from '../gateway/services/ai-status.js';

test('checkAiStatus returns offline without calling AI when DeepSeek is not configured', async () => {
  clearAiStatusCache();
  let calls = 0;

  const result = await checkAiStatus({
    env: {},
    fetchImpl: async () => {
      calls += 1;
      throw new Error('should not call fetch');
    },
    now: 1_700_000_000_000,
  });

  assert.equal(calls, 0);
  assert.equal(result.online, false);
  assert.equal(result.label, 'ICeCream Offline');
  assert.equal(result.cached, false);
  assert.equal(result.reason, 'not_configured');
});

test('checkAiStatus performs a minimal real AI probe and reports online', async () => {
  clearAiStatusCache();
  const calls = [];

  const result = await checkAiStatus({
    env: {
      DEEPSEEK_API_BASE: 'https://api.example.test/v1',
      DEEPSEEK_API_KEY: 'secret-key',
      DEEPSEEK_CHAT_MODEL: 'deepseek-chat',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    },
    now: 1_700_000_000_000,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/chat/completions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-key');
  assert.equal(JSON.parse(calls[0].options.body).max_tokens, 1);
  assert.equal(result.online, true);
  assert.equal(result.label, 'ICeCream Online');
  assert.equal(result.cached, false);
});

test('checkAiStatus caches probe results within the long TTL', async () => {
  clearAiStatusCache();
  let calls = 0;
  const env = {
    DEEPSEEK_API_BASE: 'https://api.example.test/v1/',
    DEEPSEEK_API_KEY: 'secret-key',
  };

  const first = await checkAiStatus({
    env,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({}) };
    },
    now: 1_700_000_000_000,
  });
  const second = await checkAiStatus({
    env,
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, json: async () => ({}) };
    },
    now: 1_700_000_000_000 + DEFAULT_AI_STATUS_TTL_MS - 1,
  });

  assert.equal(calls, 1);
  assert.equal(first.online, true);
  assert.equal(second.online, true);
  assert.equal(second.cached, true);
});

test('checkAiStatus reports offline when the AI probe fails', async () => {
  clearAiStatusCache();

  const result = await checkAiStatus({
    env: {
      DEEPSEEK_API_BASE: 'https://api.example.test/v1',
      DEEPSEEK_API_KEY: 'secret-key',
    },
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'quota' } }),
    }),
    now: 1_700_000_000_000,
  });

  assert.equal(result.online, false);
  assert.equal(result.label, 'ICeCream Offline');
  assert.equal(result.reason, 'probe_failed');
  assert.equal(result.cached, false);
});

test('main UI exposes a shared ICeCream Online/Offline status without adding one to seating chat', async () => {
  const [html, appSource, launcherSource, mainStyles, toolStyles, seatingSource, routesIndex, aiRoute] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/tools/app-launcher.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/css/main.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/css/tools.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/tools/seating-planner.js', import.meta.url), 'utf8'),
    readFile(new URL('../gateway/routes/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../gateway/routes/ai.js', import.meta.url), 'utf8'),
  ]);

  assert.match(routesIndex, /app\.use\('\/api\/ai', aiRoutes\)/);
  assert.match(aiRoute, /router\.get\('\/status'/);
  assert.match(html, /id="icecream-ai-status"/);
  assert.match(html, /id="icecream-ai-status-label"/);
  assert.match(html, /ICeCream Offline/);
  assert.match(appSource, /\/api\/ai\/status/);
  assert.match(appSource, /setAiStatus/);
  assert.match(launcherSource, /tool-ai-status/);
  assert.match(launcherSource, /ICeCream Offline/);
  assert.match(launcherSource, /<div class="tool-title">[\s\S]*<span>\$\{tool\.title\}<\/span>[\s\S]*\$\{this\._renderToolAiStatus\(\)\}[\s\S]*<\/div>/);
  assert.doesNotMatch(launcherSource, /<div class="tool-header-actions">[\s\S]*\$\{this\._renderToolAiStatus\(\)\}[\s\S]*<\/div>/);
  assert.match(mainStyles, /\.ai-status/);
  assert.match(mainStyles, /\.ai-status--online/);
  assert.match(mainStyles, /\.ai-status--offline/);
  assert.match(toolStyles, /\.tool-ai-status/);
  assert.doesNotMatch(seatingSource, /sp-chat.*Online|sp-chat.*Offline|ICeCream Online|ICeCream Offline/s);
});

test('tool header reuses the home day and night mode toggle', async () => {
  const [launcherSource, mainStyles, toolStyles, seatingSource] = await Promise.all([
    readFile(new URL('../public/js/tools/app-launcher.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/css/main.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/css/tools.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/tools/seating-planner.js', import.meta.url), 'utf8'),
  ]);

  assert.match(launcherSource, /id="tool-theme-toggle"/);
  assert.match(launcherSource, /class="icon-btn tool-theme-toggle"/);
  assert.match(launcherSource, /class="icon-light"/);
  assert.match(launcherSource, /class="icon-dark"/);
  assert.match(launcherSource, /data-lucide="sun"/);
  assert.match(launcherSource, /data-lucide="moon"/);
  assert.match(launcherSource, /tool-theme-toggle'\)\?\.addEventListener\('click', \(\) => this\._toggleTheme\(\)\)/);
  assert.match(launcherSource, /document\.body\.classList\.toggle\('light-mode'\)/);
  assert.match(launcherSource, /localStorage\.setItem\('theme', isLight \? 'light' : 'dark'\)/);
  assert.match(launcherSource, /ThemeManager\?\.updateMobileStatusBar/);
  assert.match(launcherSource, /_syncToolThemeToggle/);
  assert.match(launcherSource, /<div class="tool-header-actions">[\s\S]*id="tool-theme-toggle"[\s\S]*id="tool-back-btn"[\s\S]*<\/div>/);
  assert.match(mainStyles, /#theme-toggle,\s*\.tool-theme-toggle/);
  assert.match(mainStyles, /body\.light-mode #theme-toggle \.icon-light,\s*body\.light-mode \.tool-theme-toggle \.icon-light/);
  assert.match(toolStyles, /\.tool-theme-toggle/);
  assert.match(toolStyles, /@media \(max-width: 480px\)[\s\S]*\.tool-ai-status-label[\s\S]*display: none/);
  assert.doesNotMatch(seatingSource, /tool-theme-toggle|icon-light|icon-dark/);
});
