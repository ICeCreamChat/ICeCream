import AdmZip from 'adm-zip';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GEOGEBRA_COURSEWARE_MIME = 'application/zip';

const DEFAULT_TITLE = 'ICeCream GeoGebra 互动课件';
const MAX_TITLE_LENGTH = 80;
const MAX_SHORT_TITLE_LENGTH = 36;
const MAX_TEXT_LENGTH = 5000;
const MAX_SUMMARY_LENGTH = 1400;
const MAX_PAGES = 20;
const MAX_BASE64_LENGTH = 16 * 1024 * 1024;
const serviceDir = dirname(fileURLToPath(import.meta.url));
const GEOGEBRA_VENDOR_DIR = join(serviceDir, '..', '..', 'public', 'vendor', 'geogebra');

function createHttpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function cleanControlCharacters(value) {
    return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ');
}

export function formatCoursewareText(value, max = MAX_TEXT_LENGTH) {
    return cleanControlCharacters(value)
        .normalize('NFKC')
        .replace(/\\\(([\s\S]*?)\\\)/g, '$1')
        .replace(/\\\[([\s\S]*?)\\\]/g, '$1')
        .replace(/\$+([^$]+)\$+/g, '$1')
        .replace(/\s*([，。；：、,.!?！？])\s*/g, '$1')
        .replace(/[ \t\r\f\v]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, max);
}

function cleanText(value, max = MAX_TITLE_LENGTH) {
    return formatCoursewareText(value, max).replace(/\s+/g, ' ').trim();
}

function cleanShortTitle(value) {
    const title = cleanText(value, MAX_TITLE_LENGTH);
    if (!title) return DEFAULT_TITLE;
    if (title.length <= MAX_SHORT_TITLE_LENGTH) return title;
    return `${title.slice(0, MAX_SHORT_TITLE_LENGTH - 1)}...`;
}

function normalizeBase64(value) {
    const text = String(value || '').trim();
    if (!text || text.length > MAX_BASE64_LENGTH) return '';
    if (!/^[A-Za-z0-9+/=\s_-]+$/.test(text)) return '';
    return text.replace(/\s+/g, '');
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeViewport(value = {}) {
    if (!value || typeof value !== 'object') return null;
    const xmin = finiteNumber(value.xmin);
    const ymin = finiteNumber(value.ymin);
    const xmax = finiteNumber(value.xmax);
    const ymax = finiteNumber(value.ymax);
    if ([xmin, ymin, xmax, ymax].some(item => item === null) || xmin >= xmax || ymin >= ymax) return null;
    return {
        xmin,
        ymin,
        xmax,
        ymax,
        equalScale: value.equalScale !== false,
    };
}

function normalizeDemoPoint(value = {}) {
    const x = finiteNumber(value.x);
    const y = finiteNumber(value.y);
    return x === null || y === null ? null : { x, y };
}

function normalizeParametricExpression(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 120) return '';
    const normalized = text
        .replace(/\b(sin|cos|tan|asin|acos|atan|sqrt|abs|min|max|pow)\b/g, 'Math.$1')
        .replace(/\bPI\b/g, 'Math.PI')
        .replace(/\bE\b/g, 'Math.E');
    if (!/^[0-9t+\-*/().,\sMathPIEinscoqrtabmpw]+$/.test(normalized)) return '';
    const identifiers = normalized.match(/[A-Za-z_$][\w$]*/g) || [];
    const allowed = new Set(['t', 'Math', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sqrt', 'abs', 'min', 'max', 'pow', 'PI', 'E']);
    return identifiers.some(identifier => !allowed.has(identifier)) ? '' : normalized;
}

function normalizeDemoPath(path = {}) {
    if (!path || typeof path !== 'object') return null;
    if (path.type === 'circle') {
        const center = normalizeDemoPoint(path.center);
        const radius = finiteNumber(path.radius);
        if (!center || radius === null || radius <= 0) return null;
        return {
            type: 'circle',
            center,
            radius,
            startAngle: finiteNumber(path.startAngle) ?? -90,
            endAngle: finiteNumber(path.endAngle) ?? 270,
        };
    }
    if (path.type === 'segment') {
        const from = normalizeDemoPoint(path.from);
        const to = normalizeDemoPoint(path.to);
        return from && to ? { type: 'segment', from, to } : null;
    }
    if (path.type === 'polyline') {
        const points = Array.isArray(path.points)
            ? path.points.map(normalizeDemoPoint).filter(Boolean).slice(0, 80)
            : [];
        return points.length >= 2 ? { type: 'polyline', points } : null;
    }
    if (path.type === 'parametric') {
        const xExpression = normalizeParametricExpression(path.xExpression);
        const yExpression = normalizeParametricExpression(path.yExpression);
        return xExpression && yExpression ? { type: 'parametric', xExpression, yExpression } : null;
    }
    return null;
}

function normalizeCommands(value) {
    const items = Array.isArray(value) ? value : [value];
    return items.map(item => String(item || '').trim()).filter(Boolean).slice(0, 24);
}

function normalizeTimelineTrack(track = {}, durationMs = 8000) {
    if (!track || typeof track !== 'object') return null;
    if (track.kind === 'path-trace') {
        const movingObject = cleanText(track.movingObject, 40);
        const tracedObject = cleanText(track.tracedObject, 40);
        const path = normalizeDemoPath(track.path);
        if (!movingObject || !tracedObject || !path) return null;
        return {
            kind: 'path-trace',
            movingObject,
            tracedObject,
            path,
            startMs: Math.min(Math.max(finiteNumber(track.startMs) ?? 0, 0), durationMs),
            endMs: Math.min(Math.max(finiteNumber(track.endMs) ?? durationMs, 0), durationMs),
            samples: Math.round(Math.min(Math.max(finiteNumber(track.samples) ?? 240, 24), 600)),
        };
    }
    if (track.kind === 'command-at') {
        const commands = normalizeCommands(track.commands || track.command);
        if (!commands.length) return null;
        return {
            kind: 'command-at',
            timeMs: Math.min(Math.max(finiteNumber(track.timeMs) ?? 0, 0), durationMs),
            commands,
        };
    }
    if (track.kind === 'set-visible') {
        const objects = (Array.isArray(track.objects) ? track.objects : [track.object])
            .map(item => cleanText(item, 40))
            .filter(Boolean)
            .slice(0, 20);
        if (!objects.length) return null;
        return {
            kind: 'set-visible',
            timeMs: Math.min(Math.max(finiteNumber(track.timeMs) ?? 0, 0), durationMs),
            objects,
            visible: track.visible !== false,
        };
    }
    return null;
}

function normalizeDemo(rawDemo = {}) {
    if (!rawDemo || typeof rawDemo !== 'object') return null;
    const durationMs = Math.min(Math.max(finiteNumber(rawDemo.durationMs) ?? 8000, 1200), 30000);
    if (rawDemo.type === 'trace') {
        const track = normalizeTimelineTrack({
            kind: 'path-trace',
            movingObject: rawDemo.movingObject,
            tracedObject: rawDemo.tracedObject,
            path: rawDemo.path,
            samples: rawDemo.samples || rawDemo.frameCount || 240,
        }, durationMs);
        if (!track) return null;
        return {
            type: 'timeline',
            autoPlay: rawDemo.autoPlay !== false,
            clearBeforePlay: true,
            preserveAfterFinish: true,
            durationMs,
            tracks: [track],
        };
    }
    if (rawDemo.type !== 'timeline') return null;
    const tracks = Array.isArray(rawDemo.tracks)
        ? rawDemo.tracks.map(track => normalizeTimelineTrack(track, durationMs)).filter(Boolean).slice(0, 12)
        : [];
    if (!tracks.length) return null;
    return {
        type: 'timeline',
        autoPlay: rawDemo.autoPlay !== false,
        clearBeforePlay: rawDemo.clearBeforePlay !== false,
        preserveAfterFinish: rawDemo.preserveAfterFinish !== false,
        durationMs,
        tracks,
    };
}

function normalizePage(rawPage, fallbackTitle, inherited = {}) {
    const base64 = normalizeBase64(rawPage?.base64);
    if (!base64) return null;
    const problemText = formatCoursewareText(rawPage?.problemText ?? inherited.problemText ?? '');
    const summary = formatCoursewareText(rawPage?.summary ?? inherited.summary ?? '', MAX_SUMMARY_LENGTH);
    const titleSource = rawPage?.title || problemText || fallbackTitle;
    return {
        title: cleanShortTitle(titleSource),
        base64,
        problemText,
        summary,
        viewport: normalizeViewport(rawPage?.viewport ?? inherited.viewport),
        demo: normalizeDemo(rawPage?.demo ?? inherited.demo),
    };
}

export function normalizeGeoGebraCoursewarePayload(payload = {}) {
    const problemText = formatCoursewareText(payload.problemText || payload.title || '');
    const summary = formatCoursewareText(payload.summary || '', MAX_SUMMARY_LENGTH);
    const title = cleanShortTitle(payload.coursewareTitle || payload.title || summary || problemText || DEFAULT_TITLE);
    const currentBase64 = normalizeBase64(payload.base64 || payload.ggbBase64);
    if (!currentBase64) {
        throw createHttpError(400, '当前 GeoGebra 画布缺少可导出的 GGB base64。');
    }

    const inherited = {
        problemText,
        summary,
        viewport: normalizeViewport(payload.viewport),
        demo: normalizeDemo(payload.demo),
    };
    const pages = [{
        title,
        base64: currentBase64,
        ...inherited,
    }];

    if (Array.isArray(payload.pages)) {
        payload.pages.forEach((page, index) => {
            const normalizedPage = normalizePage(page, `GeoGebra 页面 ${index + 2}`);
            if (normalizedPage) {
                pages.push(normalizedPage);
            }
        });
    }

    return {
        title,
        problemText,
        summary,
        pages: pages.slice(0, MAX_PAGES),
        createdAt: new Date().toISOString(),
    };
}

function html(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildIndexHtml(title) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${html(title)}</title>
  <link rel="stylesheet" href="./assets/courseware.css">
  <script src="./config/config.js"></script>
  <script src="./config/ggbs.js"></script>
  <script src="./lib/GeoGebra/deployggb.js"></script>
</head>
<body>
  <header class="courseware-header">
    <div>
      <small>ICeCream GeoGebra Courseware</small>
      <h1 id="courseware-title">${html(title)}</h1>
    </div>
    <div class="courseware-status" id="courseware-status">正在加载 GeoGebra...</div>
  </header>
  <section class="courseware-problem" id="courseware-problem" hidden></section>
  <section class="courseware-summary" id="courseware-summary" hidden></section>
  <main class="courseware-shell">
    <nav class="courseware-pages" id="courseware-pages" aria-label="课件页面"></nav>
    <section class="courseware-stage" aria-label="GeoGebra 互动课件">
      <div id="ggb-element" class="courseware-applet"></div>
    </section>
  </main>
  <footer class="courseware-toolbar" id="courseware-toolbar">
    <button type="button" data-action="prev-page">上一页</button>
    <button type="button" data-action="next-page">下一页</button>
    <button type="button" data-action="reset-page">重置当前页</button>
    <button type="button" data-action="play-demo">演示轨迹</button>
    <button type="button" data-action="pause-demo">暂停演示</button>
    <button type="button" data-action="clear-trace">清除轨迹</button>
    <button type="button" data-action="replay-demo">重播</button>
    <button type="button" data-action="toggle-toolbar">隐藏工具栏</button>
    <button type="button" data-action="fullscreen">全屏</button>
  </footer>
  <script src="./assets/courseware.js"></script>
</body>
</html>
`;
}

function buildConfigJs(courseware) {
    return `window.ICeCreamGeoGebraConfig = ${JSON.stringify({
        title: courseware.title,
        author: 'ICeCream',
        createdAt: courseware.createdAt,
        language: 'zh',
    }, null, 2)};
`;
}

function buildGgbsJs(courseware) {
    return `window.ICeCreamGeoGebraCourseware = ${JSON.stringify({
        titles: courseware.pages.map(page => page.title),
        base64s: courseware.pages.map(page => page.base64),
        pages: courseware.pages,
    }, null, 2)};
`;
}

function buildCoursewareJs() {
    return String.raw`(() => {
  const state = {
    activePage: 0,
    api: null,
    applet: null,
    toolbarHidden: false,
    demoFrameId: 0,
    demoPlaying: false,
    demoRunId: 0,
  };

  const courseware = window.ICeCreamGeoGebraCourseware || { titles: [], base64s: [], pages: [] };
  const config = window.ICeCreamGeoGebraConfig || {};
  const rawPages = Array.isArray(courseware.pages) && courseware.pages.length
    ? courseware.pages
    : (courseware.base64s || []).map(function(base64, index) {
      return {
        title: courseware.titles && courseware.titles[index] || 'GeoGebra 页面 ' + (index + 1),
        base64: base64,
      };
    });
  const pages = rawPages.map(function(page, index) {
    return {
      title: String(page.title || 'GeoGebra 页面 ' + (index + 1)),
      base64: String(page.base64 || ''),
      problemText: String(page.problemText || ''),
      summary: String(page.summary || ''),
      viewport: page.viewport || null,
      demo: normalizeTimelineDemo(page.demo),
    };
  }).filter(function(page) {
    return page.base64;
  });

  function getElement(id) {
    return document.getElementById(id);
  }

  function currentPage() {
    return pages[state.activePage] || null;
  }

  function setStatus(message) {
    const status = getElement('courseware-status');
    if (status) status.textContent = message;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cleanMathText(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/\\\(([\s\S]*?)\\\)/g, '$1')
      .replace(/\\\[([\s\S]*?)\\\]/g, '$1')
      .replace(/\$+([^$]+)\$+/g, '$1')
      .replace(/\s*([，。；：、,.!?！？])\s*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function renderMathLite(value) {
    return escapeHtml(cleanMathText(value))
      .replace(/\^(\d+)/g, '<sup>$1</sup>');
  }

  function renderPageMeta(page) {
    const title = getElement('courseware-title');
    const problem = getElement('courseware-problem');
    const summary = getElement('courseware-summary');
    if (title) title.textContent = page.title || config.title || 'GeoGebra 互动课件';
    if (problem) {
      problem.hidden = !page.problemText;
      problem.innerHTML = page.problemText ? '<strong>题目</strong><p>' + renderMathLite(page.problemText) + '</p>' : '';
    }
    if (summary) {
      summary.hidden = !page.summary;
      summary.innerHTML = page.summary ? '<strong>结果</strong><p>' + renderMathLite(page.summary) + '</p>' : '';
    }
  }

  function renderPageButtons() {
    const host = getElement('courseware-pages');
    if (!host) return;
    host.innerHTML = pages.map(function(page, index) {
      return '<button type="button" class="' + (index === state.activePage ? 'active' : '') + '" data-page-index="' + index + '">'
        + '<span>' + (index + 1) + '</span>'
        + '<strong>' + escapeHtml(page.title) + '</strong>'
        + '</button>';
    }).join('');
    host.querySelectorAll('[data-page-index]').forEach(function(button) {
      button.addEventListener('click', function() {
        loadPage(Number(button.dataset.pageIndex || 0));
      });
    });
  }

  function readFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizePathPoint(value) {
    const x = readFiniteNumber(value && value.x);
    const y = readFiniteNumber(value && value.y);
    return x === null || y === null ? null : { x: x, y: y };
  }

  function normalizeDemoPath(path) {
    if (!path || typeof path !== 'object') return null;
    if (path.type === 'circle') {
      const center = normalizePathPoint(path.center);
      const radius = readFiniteNumber(path.radius);
      if (!center || radius === null || radius <= 0) return null;
      return {
        type: 'circle',
        center: center,
        radius: radius,
        startAngle: readFiniteNumber(path.startAngle) ?? -90,
        endAngle: readFiniteNumber(path.endAngle) ?? 270,
      };
    }
    if (path.type === 'segment') {
      const from = normalizePathPoint(path.from);
      const to = normalizePathPoint(path.to);
      return from && to ? { type: 'segment', from: from, to: to } : null;
    }
    if (path.type === 'polyline') {
      const points = Array.isArray(path.points)
        ? path.points.map(normalizePathPoint).filter(Boolean).slice(0, 80)
        : [];
      return points.length >= 2 ? { type: 'polyline', points: points } : null;
    }
    if (path.type === 'parametric') {
      const xExpression = normalizeParametricExpression(path.xExpression);
      const yExpression = normalizeParametricExpression(path.yExpression);
      return xExpression && yExpression ? { type: 'parametric', xExpression: xExpression, yExpression: yExpression } : null;
    }
    return null;
  }

  function normalizeTimelineNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(Math.max(number, min), max);
  }

  function normalizeTimelineTrack(track, durationMs) {
    if (!track || typeof track !== 'object') return null;
    if (track.kind === 'path-trace') {
      const movingObject = String(track.movingObject || '').trim();
      const tracedObject = String(track.tracedObject || '').trim();
      const path = normalizeDemoPath(track.path);
      if (!movingObject || !tracedObject || !path) return null;
      return {
        kind: 'path-trace',
        movingObject: movingObject,
        tracedObject: tracedObject,
        path: path,
        startMs: normalizeTimelineNumber(track.startMs, 0, 0, durationMs),
        endMs: normalizeTimelineNumber(track.endMs, durationMs, 0, durationMs),
        samples: Math.round(normalizeTimelineNumber(track.samples, 240, 24, 600)),
      };
    }
    if (track.kind === 'command-at') {
      const commands = Array.isArray(track.commands) ? track.commands : [track.command];
      const safeCommands = commands.map(function(command) {
        return String(command || '').trim();
      }).filter(Boolean).slice(0, 24);
      return safeCommands.length ? { kind: 'command-at', timeMs: normalizeTimelineNumber(track.timeMs, 0, 0, durationMs), commands: safeCommands } : null;
    }
    if (track.kind === 'set-visible') {
      const objects = (Array.isArray(track.objects) ? track.objects : [track.object])
        .map(function(objectName) { return String(objectName || '').trim(); })
        .filter(Boolean)
        .slice(0, 20);
      return objects.length ? { kind: 'set-visible', timeMs: normalizeTimelineNumber(track.timeMs, 0, 0, durationMs), objects: objects, visible: track.visible !== false } : null;
    }
    return null;
  }

  function normalizeTimelineDemo(demo) {
    if (!demo || typeof demo !== 'object') return null;
    const durationMs = normalizeTimelineNumber(demo.durationMs, 8000, 1200, 30000);
    if (demo.type === 'trace') {
      const track = normalizeTimelineTrack({
        kind: 'path-trace',
        movingObject: demo.movingObject,
        tracedObject: demo.tracedObject,
        path: demo.path,
        samples: demo.samples || demo.frameCount || 240,
      }, durationMs);
      if (!track) return null;
      return { type: 'timeline', autoPlay: demo.autoPlay !== false, clearBeforePlay: true, preserveAfterFinish: true, durationMs: durationMs, tracks: [track] };
    }
    if (demo.type !== 'timeline') return null;
    const tracks = Array.isArray(demo.tracks)
      ? demo.tracks.map(function(track) { return normalizeTimelineTrack(track, durationMs); }).filter(Boolean).slice(0, 12)
      : [];
    return tracks.length ? {
      type: 'timeline',
      autoPlay: demo.autoPlay !== false,
      clearBeforePlay: demo.clearBeforePlay !== false,
      preserveAfterFinish: demo.preserveAfterFinish !== false,
      durationMs: durationMs,
      tracks: tracks,
    } : null;
  }

  function normalizeParametricExpression(expression) {
    const text = String(expression || '').trim();
    if (!text || text.length > 120) return '';
    const normalized = text
      .replace(/\b(sin|cos|tan|asin|acos|atan|sqrt|abs|min|max|pow)\b/g, 'Math.$1')
      .replace(/\bPI\b/g, 'Math.PI')
      .replace(/\bE\b/g, 'Math.E');
    if (!/^[0-9t+\-*/().,\sMathPIEinscoqrtabmpw]+$/.test(normalized)) return '';
    const identifiers = normalized.match(/[A-Za-z_$][\w$]*/g) || [];
    const allowed = new Set(['t', 'Math', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sqrt', 'abs', 'min', 'max', 'pow', 'PI', 'E']);
    return identifiers.some(function(identifier) { return !allowed.has(identifier); }) ? '' : normalized;
  }

  function evaluateParametricExpression(expression, t) {
    try {
      const evaluator = new Function('t', 'Math', '"use strict"; return Number(' + expression + ');');
      const value = evaluator(t, Math);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) return '0';
    return String(Number(value.toFixed(8)));
  }

  function pointOnPath(path, progress) {
    const clampedProgress = Math.min(Math.max(progress, 0), 1);
    if (path.type === 'circle') {
      const start = path.startAngle * Math.PI / 180;
      const end = path.endAngle * Math.PI / 180;
      const angle = start + (end - start) * clampedProgress;
      return {
        x: path.center.x + path.radius * Math.cos(angle),
        y: path.center.y + path.radius * Math.sin(angle),
      };
    }
    if (path.type === 'segment') {
      return {
        x: path.from.x + (path.to.x - path.from.x) * clampedProgress,
        y: path.from.y + (path.to.y - path.from.y) * clampedProgress,
      };
    }
    if (path.type === 'polyline') {
      const scaled = clampedProgress * (path.points.length - 1);
      const index = Math.min(Math.floor(scaled), path.points.length - 2);
      const localProgress = scaled - index;
      const from = path.points[index];
      const to = path.points[index + 1];
      return {
        x: from.x + (to.x - from.x) * localProgress,
        y: from.y + (to.y - from.y) * localProgress,
      };
    }
    if (path.type === 'parametric') {
      return {
        x: evaluateParametricExpression(path.xExpression, clampedProgress),
        y: evaluateParametricExpression(path.yExpression, clampedProgress),
      };
    }
    return null;
  }

  function evalCommand(command) {
    if (!state.api || !command) return false;
    try {
      if (typeof state.api.evalCommand === 'function') {
        return state.api.evalCommand(command) !== false;
      }
      if (typeof state.api.asyncEvalCommandGetLabels === 'function') {
        state.api.asyncEvalCommandGetLabels(command);
        return true;
      }
    } catch (error) {
      console.error('[ICeCream Courseware] command failed', command, error);
    }
    return false;
  }

  function setBase64(api, base64) {
    return new Promise(function(resolve) {
      try {
        if (typeof api.setBase64 === 'function' && api.setBase64.length >= 2) {
          api.setBase64(base64, function() { resolve(true); });
          return;
        }
        resolve(api.setBase64(base64) !== false);
      } catch (error) {
        console.error('[ICeCream Courseware] setBase64 failed', error);
        resolve(false);
      }
    });
  }

  function expandBoundsToAspect(viewport) {
    const stage = document.querySelector('.courseware-stage');
    const width = Math.max(stage && stage.clientWidth || window.innerWidth || 320, 320);
    const height = Math.max(stage && stage.clientHeight || window.innerHeight - 160 || 320, 320);
    const viewportWidth = Math.max(viewport.xmax - viewport.xmin, 1);
    const viewportHeight = Math.max(viewport.ymax - viewport.ymin, 1);
    const viewportAspect = viewportWidth / viewportHeight;
    const hostAspect = width / height;
    if (Math.abs(viewportAspect - hostAspect) < 0.001) return viewport;
    const centerX = (viewport.xmin + viewport.xmax) / 2;
    const centerY = (viewport.ymin + viewport.ymax) / 2;
    if (hostAspect > viewportAspect) {
      const nextWidth = viewportHeight * hostAspect;
      return { xmin: centerX - nextWidth / 2, xmax: centerX + nextWidth / 2, ymin: viewport.ymin, ymax: viewport.ymax };
    }
    const nextHeight = viewportWidth / hostAspect;
    return { xmin: viewport.xmin, xmax: viewport.xmax, ymin: centerY - nextHeight / 2, ymax: centerY + nextHeight / 2 };
  }

  function applyViewport(viewport) {
    if (!state.api || !viewport || viewport.equalScale === false) return;
    const values = [viewport.xmin, viewport.ymin, viewport.xmax, viewport.ymax].map(Number);
    if (values.some(function(value) { return !Number.isFinite(value); })) return;
    const fitted = expandBoundsToAspect({ xmin: values[0], ymin: values[1], xmax: values[2], ymax: values[3] });
    try {
      if (typeof state.api.setCoordSystem === 'function') {
        state.api.setCoordSystem(fitted.xmin, fitted.xmax, fitted.ymin, fitted.ymax);
      } else {
        evalCommand('ZoomIn(' + fitted.xmin + ', ' + fitted.ymin + ', ' + fitted.xmax + ', ' + fitted.ymax + ')');
      }
      evalCommand('SetAxesRatio(1, 1)');
    } catch (error) {
      console.error('[ICeCream Courseware] viewport failed', error);
    }
  }

  async function loadPage(index) {
    if (!pages.length || !state.api) return;
    await stopDemo({ silent: true });
    const safeIndex = Math.max(0, Math.min(index, pages.length - 1));
    state.activePage = safeIndex;
    const page = pages[safeIndex];
    setStatus('正在打开：' + page.title);
    const ok = await setBase64(state.api, page.base64);
    renderPageButtons();
    renderPageMeta(page);
    applyViewport(page.viewport);
    try {
      state.api.setSize(window.innerWidth, Math.max(window.innerHeight - 160, 360));
    } catch {
      state.api.refreshViews?.();
    }
    setStatus(ok ? '已打开：' + page.title : '当前页面打开失败，请检查课件包是否完整。');
    if (ok && page.demo && page.demo.autoPlay) {
      window.setTimeout(function() {
        if (currentPage() === page) runTimelineDemo(page.demo);
      }, 500);
    }
  }

  function tracedObjectsFromDemo(demo) {
    return normalizeTimelineDemo(demo)?.tracks
      .filter(function(track) { return track.kind === 'path-trace'; })
      .map(function(track) { return track.tracedObject; }) || [];
  }

  function prepareTrace(demo, reenable) {
    tracedObjectsFromDemo(demo).forEach(function(objectName) {
      evalCommand('SetTrace(' + objectName + ', false)');
    });
    evalCommand('ZoomIn(1)');
    applyViewport(currentPage()?.viewport);
    if (reenable) {
      tracedObjectsFromDemo(demo).forEach(function(objectName) {
        evalCommand('SetTrace(' + objectName + ', true)');
      });
    }
  }

  function runTimelineTrack(track, elapsedMs, trackState) {
    if (track.kind === 'path-trace') {
      const duration = Math.max(track.endMs - track.startMs, 1);
      const localElapsed = Math.min(Math.max(elapsedMs - track.startMs, 0), duration);
      const progress = localElapsed / duration;
      const frame = Math.min(track.samples, Math.floor(progress * track.samples));
      if (trackState.lastFrame === frame && progress < 1) return;
      trackState.lastFrame = frame;
      const point = pointOnPath(track.path, frame / track.samples);
      if (!point) return;
      evalCommand('SetValue(' + track.movingObject + ', (' + formatNumber(point.x) + ', ' + formatNumber(point.y) + '))');
      return;
    }
    if (track.kind === 'command-at') {
      if (trackState.done || elapsedMs < track.timeMs) return;
      track.commands.forEach(evalCommand);
      trackState.done = true;
      return;
    }
    if (track.kind === 'set-visible') {
      if (trackState.done || elapsedMs < track.timeMs) return;
      track.objects.forEach(function(objectName) {
        evalCommand('SetVisibleInView(' + objectName + ', 1, ' + (track.visible ? 'true' : 'false') + ')');
      });
      trackState.done = true;
    }
  }

  function runTimelineDemo(demo = currentPage() && currentPage().demo) {
    const timeline = normalizeTimelineDemo(demo);
    if (!timeline || !state.api) {
      setStatus('当前页面没有可播放的轨迹动画。');
      return false;
    }
    stopDemo({ silent: true });
    state.demoRunId += 1;
    const runId = state.demoRunId;
    const trackStates = new Map(timeline.tracks.map(function(track) {
      return [track, { lastFrame: -1, done: false }];
    }));
    if (timeline.clearBeforePlay) {
      prepareTrace(timeline, true);
    }
    state.demoPlaying = true;
    setStatus('正在演示轨迹过程...');
    let firstTimestamp = 0;
    const finish = function() {
      if (runId !== state.demoRunId) return;
      timeline.tracks.filter(function(track) { return track.kind === 'path-trace'; }).forEach(function(track) {
        runTimelineTrack(track, timeline.durationMs, trackStates.get(track));
      });
      state.demoPlaying = false;
      state.demoFrameId = 0;
      setStatus(timeline.preserveAfterFinish ? '演示完成，轨迹已保留。' : '演示完成。');
    };
    const step = function(timestamp) {
      if (!state.demoPlaying || runId !== state.demoRunId) return;
      if (!firstTimestamp) firstTimestamp = timestamp;
      const elapsedMs = Math.min(Math.max(timestamp - firstTimestamp, 0), timeline.durationMs);
      timeline.tracks.forEach(function(track) {
        runTimelineTrack(track, elapsedMs, trackStates.get(track));
      });
      if (elapsedMs >= timeline.durationMs) {
        finish();
        return;
      }
      state.demoFrameId = window.requestAnimationFrame(step);
    };
    state.demoFrameId = window.requestAnimationFrame(step);
    return true;
  }

  function stopDemo(options = {}) {
    if (state.demoFrameId) {
      window.cancelAnimationFrame(state.demoFrameId);
      state.demoFrameId = 0;
    }
    state.demoRunId += 1;
    state.demoPlaying = false;
    if (!options.silent) setStatus(options.status || '演示已暂停。');
  }

  function clearTrace() {
    const page = currentPage();
    stopDemo({ silent: true });
    if (page?.demo) {
      prepareTrace(page.demo, false);
      setStatus('轨迹已清除。');
    }
  }

  function initApplet() {
    if (!pages.length) {
      setStatus('课件包中没有可用的 GeoGebra 页面。');
      return;
    }
    const params = {
      appName: 'classic',
      width: '100%',
      height: '100%',
      showToolBar: true,
      showMenuBar: true,
      showAlgebraInput: false,
      enableUndoRedo: true,
      language: config.language || 'zh',
      scaleContainerClass: 'courseware-stage',
      appletOnLoad: function(api) {
        state.api = api;
        window.ggbApplet = api;
        loadPage(0);
      },
    };
    state.applet = new GGBApplet(params, true);
    state.applet.setHTML5Codebase('lib/GeoGebra/HTML5/5.0/web3d/');
    state.applet.inject('ggb-element');
  }

  function bindToolbar() {
    document.querySelectorAll('[data-action]').forEach(function(button) {
      button.addEventListener('click', function() {
        const action = button.dataset.action;
        if (action === 'prev-page') loadPage(state.activePage - 1);
        if (action === 'next-page') loadPage(state.activePage + 1);
        if (action === 'reset-page') loadPage(state.activePage);
        if (action === 'play-demo' || action === 'replay-demo') runTimelineDemo(currentPage() && currentPage().demo);
        if (action === 'pause-demo') stopDemo({ status: '演示已暂停。' });
        if (action === 'clear-trace') clearTrace();
        if (action === 'fullscreen') document.documentElement.requestFullscreen?.();
        if (action === 'toggle-toolbar') {
          state.toolbarHidden = !state.toolbarHidden;
          document.body.classList.toggle('courseware-toolbar-hidden', state.toolbarHidden);
          button.textContent = state.toolbarHidden ? '显示工具栏' : '隐藏工具栏';
        }
      });
    });
  }

  window.addEventListener('resize', function() {
    if (!state.api) return;
    try {
      state.api.setSize(window.innerWidth, Math.max(window.innerHeight - 160, 360));
    } catch {
      state.api.refreshViews?.();
    }
    applyViewport(currentPage()?.viewport);
  });

  renderPageButtons();
  bindToolbar();
  initApplet();
})();`;
}

function buildCoursewareCss() {
    return String.raw`:root {
  color-scheme: light;
  font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif;
  background: #eef5fb;
  color: #1f2a3d;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto auto auto 1fr auto;
}

.courseware-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 20px;
  border-bottom: 1px solid #d6e2ee;
  background: #f8fbff;
}

.courseware-header small {
  display: block;
  color: #0ea5e9;
  font-weight: 700;
}

.courseware-header h1 {
  margin: 2px 0 0;
  font-size: 20px;
  line-height: 1.25;
}

.courseware-status {
  max-width: 420px;
  color: #53657d;
  text-align: right;
  overflow-wrap: anywhere;
}

.courseware-problem,
.courseware-summary {
  margin: 8px 16px 0;
  padding: 10px 14px;
  border: 1px solid #cfe1ef;
  border-radius: 8px;
  background: #ffffff;
}

.courseware-problem strong,
.courseware-summary strong {
  color: #0f6f9f;
}

.courseware-problem p,
.courseware-summary p {
  margin: 4px 0 0;
  line-height: 1.65;
  overflow-wrap: anywhere;
  white-space: normal;
}

.courseware-summary {
  background: #effdf7;
  border-color: #b8ead6;
}

.courseware-shell {
  min-height: 0;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
}

.courseware-pages {
  overflow: auto;
  padding: 14px;
  border-right: 1px solid #d6e2ee;
  background: #f7fbff;
}

.courseware-pages button {
  width: 100%;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 10px;
  border: 1px solid #d6e2ee;
  border-radius: 8px;
  background: #ffffff;
  color: #1f2a3d;
  text-align: left;
  cursor: pointer;
}

.courseware-pages button.active {
  border-color: #0ea5e9;
  background: #e0f2fe;
}

.courseware-pages span {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: #dbeafe;
  color: #0369a1;
  font-weight: 700;
}

.courseware-pages strong {
  overflow-wrap: anywhere;
}

.courseware-stage {
  min-width: 0;
  min-height: 0;
  background: #ffffff;
}

.courseware-applet {
  width: 100%;
  height: 100%;
  min-height: calc(100vh - 230px);
}

.courseware-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 20px;
  border-top: 1px solid #d6e2ee;
  background: #f8fbff;
}

.courseware-toolbar button,
.courseware-demo button {
  border: 0;
  border-radius: 999px;
  padding: 10px 16px;
  background: #dff4ff;
  color: #0369a1;
  font-weight: 700;
  cursor: pointer;
}

.courseware-toolbar [data-action="play-demo"],
.courseware-toolbar [data-action="replay-demo"] {
  background: #0ea5e9;
  color: #ffffff;
}

.courseware-toolbar-hidden .courseware-pages,
.courseware-toolbar-hidden .courseware-header,
.courseware-toolbar-hidden .courseware-problem,
.courseware-toolbar-hidden .courseware-summary {
  display: none;
}

.courseware-toolbar-hidden .courseware-shell {
  grid-template-columns: minmax(0, 1fr);
}

@media (max-width: 800px) {
  .courseware-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .courseware-status {
    max-width: none;
    text-align: left;
  }

  .courseware-shell {
    grid-template-columns: 1fr;
  }

  .courseware-pages {
    max-height: 180px;
    border-right: 0;
    border-bottom: 1px solid #d6e2ee;
  }
}`;
}

function buildReadme(courseware) {
    return `# ${courseware.title}

这是 ICeCream 导出的 GeoGebra 互动课件包，结构参考 GGBTool 离线包方式。

## 在 PowerPoint / PPT 中使用

1. 解压整个 zip 文件夹，不要只复制其中的 \`index.html\`。
2. 在 PPT 中插入一张 GeoGebra 截图、形状按钮或文字。
3. 给该对象添加超链接，链接到本文件夹中的 \`index.html\`。
4. 放映 PPT 时点击该对象，会在浏览器中打开可互动 GeoGebra 课件。

## 动画演示

- 如果课件页带有轨迹动画，打开 \`index.html\` 后会自动演示一次。
- 也可以点击 \`演示轨迹\` 或 \`重播\` 再次播放，点击 \`暂停演示\` 停止，点击 \`清除轨迹\` 清掉上一轮痕迹。
- PPT 内部仍通过超链接打开浏览器页面，动画不会被直接嵌入到 \`.pptx\` 文件内部。

## 注意

- 请保持 \`config/\`、\`assets/\`、\`lib/GeoGebra/\` 和 \`index.html\` 的相对位置不变。
- 如果学校电脑拦截本地 HTML，请用 Microsoft Edge 或 Chrome 打开。
- GeoGebra 离线运行时遵循 GeoGebra 自身授权；ICeCream 自有代码仍按 MIT 授权。
`;
}

function buildFilename() {
    const stamp = new Date().toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, '')
        .replace('T', '-');
    return `icecream-geogebra-courseware-${stamp}.zip`;
}

async function assertVendorAssetsAvailable(vendorDir = GEOGEBRA_VENDOR_DIR) {
    await access(join(vendorDir, 'deployggb.js'));
    await access(join(vendorDir, 'HTML5', '5.0', 'GeoGebra.html'));
}

export async function createGeoGebraCoursewarePackage(payload = {}, options = {}) {
    const courseware = normalizeGeoGebraCoursewarePayload(payload);
    const vendorDir = options.vendorDir || GEOGEBRA_VENDOR_DIR;
    await assertVendorAssetsAvailable(vendorDir);

    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from(buildIndexHtml(courseware.title), 'utf8'));
    zip.addFile('config/config.js', Buffer.from(buildConfigJs(courseware), 'utf8'));
    zip.addFile('config/ggbs.js', Buffer.from(buildGgbsJs(courseware), 'utf8'));
    zip.addFile('assets/courseware.js', Buffer.from(buildCoursewareJs(), 'utf8'));
    zip.addFile('assets/courseware.css', Buffer.from(buildCoursewareCss(), 'utf8'));
    zip.addFile('README-PPT.md', Buffer.from(buildReadme(courseware), 'utf8'));
    zip.addLocalFolder(vendorDir, 'lib/GeoGebra');

    return {
        buffer: zip.toBuffer(),
        filename: buildFilename(),
        pageCount: courseware.pages.length,
    };
}
