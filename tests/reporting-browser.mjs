// Start `npm run dev`, then run `node tests/reporting-browser.mjs`.
// Government navigation is intercepted: this test never contacts or submits to the real site.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const baseUrl = new URL(process.env.ROADPROOF_URL || 'http://localhost:4173');
if (!baseUrl.pathname.endsWith('/') && !baseUrl.pathname.endsWith('.html')) baseUrl.pathname += '/';
const officialUrl = 'https://www.safetyreport.go.kr/#safereport/safereport3';
const artifactDirectory = new URL('../artifacts/reporting-qa/', import.meta.url);
await mkdir(artifactDirectory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const governmentRequests = [];
const unexpectedRequests = [];
const results = {};
const fixture = { vehicle: '12가3456', location: '합성 테스트 교차로', note: '자동 신고가 없는 메모 전달 동작을 검증한 합성 자료입니다.' };

async function download(page, name, action) {
  const pending = page.waitForEvent('download', { timeout: 120000 });
  await action();
  const result = await pending;
  assert.equal(await result.failure(), null, `${name} download must complete.`);
  const path = fileURLToPath(new URL(name, artifactDirectory));
  await result.saveAs(path);
  return { bytes: await readFile(path), filename: result.suggestedFilename() };
}

async function exportShortClip(page, name) {
  const result = await download(page, name, () => page.locator('#export-button').click());
  assert.ok(result.bytes.length > 1000, 'The next step must follow a real exported MP4.');
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  assert.equal(await page.locator('#report-next').isVisible(), true);
  assert.equal(await page.locator('#report-handoff-status').getAttribute('data-state'), 'ready');
  assert.ok((await page.locator('#report-handoff-status').textContent()).includes(result.filename));
  const decodedUrl = new URL(`./__qa_${name}`, page.url()).href;
  await page.route(decodedUrl, route => route.fulfill({ contentType: 'video/mp4', body: result.bytes }));
  const duration = await page.evaluate(async ({ url, moduleUrl }) => {
    const { Input, BlobSource, ALL_FORMATS } = await import(moduleUrl);
    const input = new Input({ source: new BlobSource(await (await fetch(url)).blob()), formats: ALL_FORMATS });
    try { return await (await input.getPrimaryVideoTrack()).computeDuration(); }
    finally { input.dispose(); }
  }, { url: decodedUrl, moduleUrl: new URL('./vendor/mediabunny.mjs', page.url()).href });
  assert.equal(duration, 1);
  return { filename: result.filename, bytes: result.bytes.length, duration };
}

async function checkMobileCard(page, width) {
  await page.setViewportSize({ width, height: 844 });
  await page.locator('#report-handoff').scrollIntoViewIfNeeded();
  const layout = await page.locator('#report-handoff').evaluate(card => {
    const box = card.getBoundingClientRect();
    const controls = [...card.querySelectorAll('a, button')];
    return {
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      left: box.left, right: box.right,
      clipped: controls.filter(control => {
        const rect = control.getBoundingClientRect();
        return rect.left < box.left - 1 || rect.right > box.right + 1;
      }).map(control => control.id || control.textContent.trim()),
      unnamed: controls.filter(control => !(control.getAttribute('aria-label') || control.textContent.trim())).map(control => control.id),
    };
  });
  assert.ok(layout.document <= width + 1 && layout.left >= -1 && layout.right <= width + 1, `${width}px report card must fit: ${JSON.stringify(layout)}`);
  assert.deepEqual(layout.clipped, [], `${width}px report actions must not be clipped.`);
  assert.deepEqual(layout.unnamed, [], 'Report actions need accessible names.');
  await page.locator('#report-handoff').screenshot({ path: fileURLToPath(new URL(`reporting-${width}.png`, artifactDirectory)) });
  return layout;
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl.origin });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || url.origin === baseUrl.origin) return route.continue();
    if (url.hostname === 'www.safetyreport.go.kr') {
      governmentRequests.push({ url: request.url(), method: request.method(), body: request.postData(), headers: await request.allHeaders() });
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="ko"><title>Local reporting test stub</title><body>외부로 전송하지 않는 테스트 화면</body></html>' });
    }
    unexpectedRequests.push(request.url());
    await route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.goto(baseUrl.href, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200, 'Start the application server before running this test.');
  assert.equal(await page.locator('#report-next').isVisible(), false);
  assert.equal(await page.locator('#report-handoff-status').getAttribute('data-state'), 'pending');
  assert.equal(await page.locator('#report-site-link').getAttribute('href'), officialUrl);
  assert.equal(await page.locator('#report-site-link').getAttribute('target'), '_blank');
  const rel = (await page.locator('#report-site-link').getAttribute('rel')).split(/\s+/);
  assert.ok(rel.includes('noopener') && rel.includes('noreferrer'));
  assert.equal(await page.locator('#report-site-link').getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(await page.getByLabel('차량번호 (선택)', { exact: true }).count(), 1);

  await page.locator('#demo-button').click();
  await page.locator('#preview-area').waitFor({ state: 'visible', timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  await page.locator('#trim-start-input').fill('00:01.0');
  await page.locator('#trim-start-input').press('Tab');
  await page.locator('#trim-end-input').fill('00:02.0');
  await page.locator('#trim-end-input').press('Tab');
  await page.locator('#incident-vehicle').fill(fixture.vehicle);
  await page.locator('#incident-location').fill(fixture.location);
  await page.locator('#incident-note').fill(fixture.note);
  assert.equal(await page.locator('#report-next').isVisible(), false, 'Loading a sample alone must not claim an exported file is ready.');
  results.export = await exportShortClip(page, 'report-clip.mp4');

  assert.equal(await page.locator('#report-next').getAttribute('href'), '#report-handoff');
  await page.locator('#report-next').click();
  await page.waitForFunction(() => {
    const box = document.getElementById('report-handoff').getBoundingClientRect();
    return location.hash === '#report-handoff' && box.top >= -1 && box.top < innerHeight;
  });
  results.nextScrollsToHandoff = true;

  await page.locator('#copy-report-handoff').click();
  await page.waitForFunction(() => !document.getElementById('toast').hidden && document.getElementById('toast').textContent.includes('복사했습니다'));
  const handoffText = await page.evaluate(() => navigator.clipboard.readText());
  for (const text of [fixture.vehicle, fixture.location, fixture.note, '00:01.0 ~ 00:02.0', '실제 신고 자료가 아닙니다']) assert.ok(handoffText.includes(text), `Copied memo must include ${text}.`);
  await page.locator('#copy-report').click();
  const existingCopyText = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(existingCopyText, handoffText, 'Both copy buttons must produce the same current memo.');
  const memo = await download(page, 'report-memo.txt', () => page.locator('#download-report').click());
  assert.equal(memo.bytes.toString('utf8').replace(/^\uFEFF/, ''), handoffText, 'Downloaded TXT must match the copied memo including vehicle number.');
  results.memoIncludesVehicle = true;
  await page.locator('#report-handoff').screenshot({ path: fileURLToPath(new URL('reporting-1440.png', artifactDirectory)) });

  const opened = context.waitForEvent('page');
  await page.locator('#report-site-link').click();
  const popup = await opened;
  await popup.waitForURL(officialUrl, { waitUntil: 'domcontentloaded' });
  assert.equal(popup.url(), officialUrl);
  const privacy = await popup.evaluate(() => ({ openerIsNull: window.opener === null, referrer: document.referrer }));
  assert.deepEqual(privacy, { openerIsNull: true, referrer: '' });
  assert.ok(governmentRequests.length > 0, 'The test must exercise the intercepted external navigation.');
  for (const request of governmentRequests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.body, null);
    assert.equal(new URL(request.url).search, '');
    assert.equal(request.headers.referer, undefined);
    for (const value of Object.values(fixture)) assert.equal(JSON.stringify(request).includes(value), false);
  }
  results.officialLink = { url: popup.url(), ...privacy, requestsIntercepted: governmentRequests.length, realRequestsSent: 0 };
  await popup.close();
  results.mobile320 = await checkMobileCard(page, 320);
  results.mobile390 = await checkMobileCard(page, 390);

  await page.locator('#quality').selectOption('small');
  assert.equal(await page.locator('#report-next').isVisible(), false, 'Editing export settings must hide the stale next-step shortcut.');
  assert.equal(await page.locator('#report-handoff-status').getAttribute('data-state'), 'pending');
  await exportShortClip(page, 'report-clip-updated.mp4');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#report-next').isVisible(), false, 'Reload must not retain a previous in-memory export.');
  assert.equal(await page.locator('#report-handoff-status').getAttribute('data-state'), 'pending');
  results.readinessResets = true;

  // Exercise a real successful clipboard write, then inject only the permission-denied API result.
  await page.locator('#incident-vehicle').fill(fixture.vehicle);
  await page.locator('#copy-report-handoff').click();
  await page.waitForFunction(() => !document.getElementById('toast').hidden && document.getElementById('toast').textContent.includes('복사했습니다'));
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new DOMException('Clipboard permission denied for this test', 'NotAllowedError'); } });
  });
  await page.locator('#copy-report-handoff').click();
  await page.locator('#error-banner').waitFor({ state: 'visible' });
  assert.match(await page.locator('#error-banner').textContent(), /클립보드.*권한|메모.*저장/);
  assert.equal(await page.locator('#toast').isVisible(), false, 'Denied copy must not leave a success toast visible.');
  assert.equal(await page.locator('#report-handoff-status').getAttribute('data-state'), 'pending');
  results.deniedClipboardHandled = 'Simulated NotAllowedError after a real successful clipboard write';

  assert.deepEqual(errors, [], 'No unhandled browser errors.');
  assert.deepEqual(unexpectedRequests, [], 'No unplanned external requests, including memo uploads.');
  console.log(JSON.stringify({ ...results, errors, unexpectedRequests }, null, 2));
  console.log('PASS: real MP4 handoff readiness, next-step scroll, vehicle memo clipboard/TXT, denied-copy handling, intercepted official new-tab privacy, 320/390px report layout.');
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) if (new URL(page.url()).origin === baseUrl.origin) {
    await page.screenshot({ path: fileURLToPath(new URL('failure.png', artifactDirectory)), fullPage: true }).catch(() => {});
  }
  console.error('Browser errors:', errors);
  throw error;
} finally {
  await browser.close();
}
