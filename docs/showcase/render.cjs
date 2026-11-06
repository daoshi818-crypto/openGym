/* Export nine independent 3:4 cards. Never export a combined long screenshot.
 * Run from the repository root with a static server; see README.zh-CN.md.
 * Resolve Playwright externally; no application dependency changes are needed.
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
    await page.locator('.toolbar').evaluate(el => { el.style.display = 'none'; });
    const layout = await page.evaluate(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      return {
        images: [...document.images].map(el => ({ src: el.getAttribute('src'), loaded: el.complete && el.naturalWidth > 0, aspectError: Math.abs(el.getBoundingClientRect().width / el.getBoundingClientRect().height - el.naturalWidth / el.naturalHeight) })),
        panels: [...document.querySelectorAll('.panel')].map(panel => {
          const footer = panel.querySelector('.bottom');
          const content = panel.querySelector('.content');
          const bounds = rect(panel);
          const overflow = [...content.querySelectorAll('*')].filter(el => {
            const r = rect(el); return r.width > 0 && (r.x < bounds.x + 48 || r.right > bounds.right - 48);
          }).map(el => el.tagName + '.' + el.className);
          const textOverflow = [...panel.querySelectorAll('p,h1,h2,h3,.quote,.note,.bottom,.repo span')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.tagName + '.' + el.className);
          return { id: panel.id, filename: panel.dataset.file, bounds, footerGap: rect(footer).y - rect(content).bottom, horizontalOverflow: overflow, textOverflow };
        })
      };
    });
    report.layout = layout;
    assert.equal(layout.panels.length, 9, 'Exactly nine independent short cards');
    assert.equal(new Set(layout.panels.map(p => p.filename)).size, 9);
    assert.ok(layout.images.every(el => el.loaded), 'All source images must load');
    assert.ok(layout.images.every(el => el.aspectError < 0.005), 'Screenshot aspect ratios must not be distorted');
    for (const panel of layout.panels) {
      assert.ok(panel.footerGap >= 22, `${panel.id}: footer overlap or insufficient gap (${panel.footerGap})`);
      assert.deepEqual(panel.horizontalOverflow, [], `${panel.id}: horizontal overflow`);
      assert.deepEqual(panel.textOverflow, [], `${panel.id}: text overflow`);
      await page.locator(`#${panel.id}`).screenshot({ path: path.join(out, panel.filename), animations: 'disabled' });
      report.sizes[panel.filename] = pngSize(path.join(out, panel.filename));
      assert.deepEqual(report.sizes[panel.filename], [1080, 1440]);
    }
    const mobile = [];
    for (const width of [360, 390, 430, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const size = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth, cards: [...document.querySelectorAll('.panel')].map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })) }));
      assert.ok(size.document <= width + 1, `Horizontal scrolling at ${width}px`);
      assert.ok(size.cards.every(card => Math.abs(card.width - width) <= 1 && Math.abs(card.height / card.width - 4 / 3) < 0.005), `Cards do not fit ${width}px`);
      mobile.push({ width, ...size });
    }
    report.checks = { nineShortCards: true, allImagesLoaded: true, noPanelOverflow: true, footerClear: true, mobile };
    assert.deepEqual(report.errors, []);
    console.log('Nine short-card exports and layout checks passed', JSON.stringify(report.sizes));
  } finally {
    fs.writeFileSync(process.env.SHOWCASE_REPORT || path.join(os.tmpdir(), 'opengym-showcase-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
