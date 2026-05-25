import AdmZip from 'adm-zip';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function withApp(run) {
  const server = createGatewayApp({ isDev: false }).listen(0, '127.0.0.1');
  const baseUrl = await new Promise(resolve => {
    server.on('listening', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  try {
    await run(baseUrl);
  } finally {
    await close(server);
  }
}

test('POST /api/geogebra/export/courseware returns a GGBTool-style offline package', async () => {
  await withApp(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/geogebra/export/courseware`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '【例1】、已知圆 $C$ 是以 $C(0,3)$ 为圆心、$3$ 为半径的圆。过原点 $O$ 作圆 $C$ 的任意弦 $OP$，求 $OP$ 的中点 $M$ 的轨迹方程。',
        base64: 'R0dCVEVTVA==',
        problemText: '【例1】、已知圆 $C$ 是以 $C(0,3)$ 为圆心、$3$ 为半径的圆。过原点 $O$ 作圆 $C$ 的任意弦 $OP$，求 $OP$ 的中点 $M$ 的轨迹方程。',
        summary: '轨迹方程为 x^2 + (y - 1.5)^2 = 2.25。',
        viewport: { xmin: -4, ymin: -1, xmax: 4, ymax: 7, equalScale: true },
        demo: {
          type: 'timeline',
          autoPlay: true,
          clearBeforePlay: true,
          preserveAfterFinish: true,
          durationMs: 8000,
          tracks: [{
            kind: 'path-trace',
            movingObject: 'P',
            tracedObject: 'M',
            samples: 240,
            path: {
              type: 'circle',
              center: { x: 0, y: 3 },
              radius: 3,
              startAngle: -90,
              endAngle: 270,
            },
          }],
        },
        pages: [
          { title: '草稿页', base64: 'UEFHRUdHQg==' },
          { title: '空页会被忽略', base64: '' },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/zip/);
    assert.match(response.headers.get('content-disposition') || '', /icecream-geogebra-courseware.*\.zip/);

    const buffer = Buffer.from(await response.arrayBuffer());
    const zip = new AdmZip(buffer);
    const entries = new Set(zip.getEntries().map(entry => entry.entryName));

    assert.equal(entries.has('index.html'), true);
    assert.equal(entries.has('config/config.js'), true);
    assert.equal(entries.has('config/ggbs.js'), true);
    assert.equal(entries.has('assets/courseware.js'), true);
    assert.equal(entries.has('assets/courseware.css'), true);
    assert.equal(entries.has('README-PPT.md'), true);
    assert.equal(entries.has('lib/GeoGebra/deployggb.js'), true);
    assert.equal(entries.has('lib/GeoGebra/HTML5/5.0/GeoGebra.html'), true);

    const ggbs = zip.readAsText('config/ggbs.js');
    assert.match(ggbs, /window\.ICeCreamGeoGebraCourseware/);
    assert.match(ggbs, /pages/);
    assert.match(ggbs, /problemText/);
    assert.match(ggbs, /summary/);
    assert.match(ggbs, /viewport/);
    assert.match(ggbs, /demo/);
    assert.match(ggbs, /timeline/);
    assert.match(ggbs, /path-trace/);
    assert.match(ggbs, /轨迹方程为 x\^2 \+ \(y - 1\.5\)\^2 = 2\.25/);
    assert.doesNotMatch(ggbs, /\$C\$/);
    assert.doesNotMatch(ggbs, /\$OP\$/);
    assert.match(ggbs, /R0dCVEVTVA==/);
    assert.match(ggbs, /草稿页/);
    assert.match(ggbs, /UEFHRUdHQg==/);

    const index = zip.readAsText('index.html');
    assert.match(index, /assets\/courseware\.js/);
    assert.match(index, /config\/ggbs\.js/);
    assert.match(index, /courseware-problem/);
    assert.match(index, /data-action="play-demo"/);
    assert.match(index, /演示轨迹/);
    assert.match(index, /暂停演示/);
    assert.match(index, /清除轨迹/);
    assert.match(index, /重播/);
    assert.doesNotMatch(index, /<h1[^>]*>[\s\S]*\$C\$/);

    const script = zip.readAsText('assets/courseware.js');
    assert.match(script, /function normalizeTimelineDemo/);
    assert.match(script, /function runTimelineDemo/);
    assert.match(script, /function stopDemo/);
    assert.match(script, /function clearTrace/);
    assert.match(script, /requestAnimationFrame/);
    assert.match(script, /SetValue/);
    assert.match(script, /currentPage\(\)\.demo/);

    const styles = zip.readAsText('assets/courseware.css');
    assert.match(styles, /\.courseware-problem/);
    assert.match(styles, /\.courseware-demo/);

    const readme = zip.readAsText('README-PPT.md');
    assert.match(readme, /PowerPoint|PPT/);
    assert.match(readme, /index\.html/);
    assert.match(readme, /演示轨迹/);
  });
});

test('POST /api/geogebra/export/courseware rejects requests without current base64', async () => {
  await withApp(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/geogebra/export/courseware`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '空课件' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
    assert.match(payload.error, /base64|GGB|画布/);
  });
});
