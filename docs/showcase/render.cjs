/* Run from the repository root with a local static server; see README.zh-CN.md.
 * Resolve Playwright externally so documentation does not add application dependencies.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'assets/showcase');
const base = (process.env.SHOWCASE_BASE_URL || 'http://127.0.0.1:8768').replace(/\/$/, '');
const pngSize = file => {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(1, 4).toString(), 'PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.SHOWCASE_BROWSER_CHANNEL ? { channel: process.env.SHOWCASE_BROWSER_CHANNEL } : {}) });
  const report = { url: base + '/docs/showcase/index.html', errors: [], sizes: {}, checks: {} };
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 1 });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400) report.errors.push(`${r.status()} ${r.url()}`); });
    await page.goto(report.url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    // Remove toolbar before export to keep panel origins at exact integer pixels.
    await page.locator('.toolbar').evaluate(el => { el.style.display = 'none'; });
    const layout = await page.evaluate(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      return {
        images: [...document.images].map(el => ({ src: el.getAttribute('src'), loaded: el.complete && el.naturalWidth > 0, aspectError: Math.abs(el.getBoundingClientRect().width / el.getBoundingClientRect().height - el.naturalWidth / el.naturalHeight) })),
        coverIntroGap: document.querySelector('.cover-shots').getBoundingClientRect().y - document.querySelector('.cover .intro').getBoundingClientRect().bottom,
        panels: [...document.querySelectorAll('.panel')].map(panel => {
          const footer = panel.querySelector('.bottom');
          const children = [...panel.children].filter(el => el !== footer);
          const bounds = rect(panel);
          const contentBottom = Math.max(...children.map(el => rect(el).bottom));
          const footerTop = rect(footer).y;
          const horizontalOverflow = [...panel.querySelectorAll('*')].filter(el => {
            const r = rect(el); return r.width > 0 && (r.x < bounds.x - 1 || r.right > bounds.right + 1);
          }).map(el => el.tagName + '.' + el.className);
          return { id: panel.id, bounds, contentBottom, footerTop, footerGap: footerTop - contentBottom, horizontalOverflow };
        })
      };
    });
    report.layout = layout;
    const outputs = [
      ['#long-poster', 'opengym-features-long.png', 1080, 5280],
      ['#official', 'opengym-official-features.png', 1080, 2640],
      ['#custom', 'opengym-custom-features.png', 1080, 2640],
      ['#cover', 'opengym-cover.png', 1080, 1440]
    ];
    for (const [selector, filename, width, height] of outputs) {
      await page.locator(selector).screenshot({ path: path.join(out, filename), animations: 'disabled' });
      report.sizes[filename] = pngSize(path.join(out, filename));
      assert.deepEqual(report.sizes[filename], [width, height]);
    }
    assert.ok(layout.images.every(el => el.loaded), 'All source images must load');
    assert.ok(layout.images.every(el => el.aspectError < 0.005), 'Screenshot aspect ratios must not be distorted');
    assert.ok(layout.coverIntroGap >= 20, 'Cover phones overlap the introduction');
    for (const panel of layout.panels) {
      assert.ok(panel.footerGap >= 22, `${panel.id}: footer overlap or insufficient gap (${panel.footerGap})`);
      assert.deepEqual(panel.horizontalOverflow, [], `${panel.id}: horizontal overflow`);
    }
    const mobile = [];
    for (const width of [360, 390, 430, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const size = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth, canvas: document.querySelector('.canvas').getBoundingClientRect().width }));
      assert.ok(size.document <= width + 1, `Horizontal scrolling at${width}px`);
      assert.ok(Math.abs(size.canvas - width) <= 1, `Canvas does not fit${width}px`);
      mobile.push({ width, ...size });
    }
    report.checks = { allImagesLoaded: true, noPanelOverflow: true, footerClear: true, mobile };
    assert.deepEqual(report.errors, []);
    console.log('Showcase exports and layout checks passed', JSON.stringify(report.sizes));
  } finally {
    fs.writeFileSync(process.env.SHOWCASE_REPORT || path.join(os.tmpdir(), 'opengym-showcase-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
