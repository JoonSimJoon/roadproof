// Start `npm run dev`, then run `node tests/editor-browser.mjs`.
// Uses a synthetic demo only; artifacts are saved under ignored artifacts/editor-qa/.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const baseUrl = new URL(process.env.ROADPROOF_URL || 'http://localhost:4173');
if (!baseUrl.pathname.endsWith('/') && !baseUrl.pathname.endsWith('.html')) baseUrl.pathname += '/';
const artifactDirectory = new URL('../artifacts/editor-qa/', import.meta.url);
await mkdir(artifactDirectory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const externalRequests = [];
const results = {};

async function downloadedBytes(page, id, action) {
  const pending = page.waitForEvent('download', { timeout: 120000 });
  await action();
  const download = await pending;
  assert.equal(await download.failure(), null, `${id} download must complete.`);
  const path = new URL(id, artifactDirectory);
  await download.saveAs(fileURLToPath(path));
  const bytes = await readFile(path);
  assert.ok(bytes.length > 100, `${id} must contain actual data.`);
  const url = new URL(`./__qa_${id}`, page.url()).href;
  await page.route(url, route => route.fulfill({
    contentType: id.endsWith('.mp4') ? 'video/mp4' : id.endsWith('.png') ? 'image/png' : 'text/plain',
    body: bytes,
  }));
  return { bytes, filename: download.suggestedFilename(), path: fileURLToPath(path), url };
}

async function inspectDownloadedVideo(page, url) {
  return page.evaluate(async ({ path, moduleUrl }) => {
    const { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink } = await import(moduleUrl);
    const blob = await (await fetch(path)).blob();
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    try {
      const track = await input.getPrimaryVideoTrack();
      const audio = await input.getPrimaryAudioTrack();
      let audioRms = null;
      if (audio) {
        const decoded = await new AudioBufferSink(audio).getBuffer(0.2);
        const samples = decoded.buffer.getChannelData(0);
        audioRms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      }
      const canvas = (await new CanvasSink(track).getCanvas(0)).canvas;
      const ctx = canvas.getContext('2d');
      const countYellow = (x, y, width, height) => {
        const pixels = ctx.getImageData(x, y, width, height).data;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] > 180 && pixels[i + 1] > 130 && pixels[i + 2] < 150) count++;
        }
        return count;
      };
      return {
        duration: await track.computeDuration(),
        width: await track.getDisplayWidth(), height: await track.getDisplayHeight(),
        videoCodec: await track.getCodec(), audioCodec: audio && await audio.getCodec(),
        audioRms,
        topRightYellowPixels: countYellow(canvas.width / 2, 0, canvas.width / 2, 110),
        bottomLeftYellowPixels: countYellow(0, canvas.height - 110, canvas.width / 2, 110),
      };
    } finally { input.dispose(); }
  }, { path: url, moduleUrl: new URL('./vendor/mediabunny.mjs', page.url()).href });
}

async function assertNoOverflow(page, label) {
  const layout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('body *')].filter(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.position !== 'fixed' && style.display !== 'none' && rect.width > 0
        && (rect.right > document.documentElement.clientWidth + 1 || rect.left < -1);
    }).slice(0, 10).map(element => `${element.tagName}#${element.id}.${element.className}`),
    clippedControls: [...document.querySelectorAll('button, input, select, textarea')].filter(element => {
      if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.right > document.documentElement.clientWidth + 1 || rect.left < -1);
    }).map(element => `${element.tagName}#${element.id}`),
  }));
  assert.ok(layout.document <= layout.viewport + 1, `${label} overflows horizontally: ${JSON.stringify(layout)}`);
  assert.deepEqual(layout.clippedControls, [], `${label} must not hide overflowing controls with clipped containers.`);
  return layout;
}

async function assertAccessibleControls(page) {
  const unnamed = await page.locator('input, select, textarea, button').evaluateAll(controls => controls.filter(control => {
    if (!control.getClientRects().length || getComputedStyle(control).visibility === 'hidden') return false;
    const labelledBy = (control.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
    const label = control.getAttribute('aria-label') || labelledBy.trim()
      || [...(control.labels || [])].map(element => element.textContent).join(' ').trim()
      || (control.tagName === 'BUTTON' ? control.textContent.trim() : '') || control.getAttribute('title');
    return !label;
  }).map(control => `${control.tagName}#${control.id}`));
  assert.deepEqual(unnamed, [], 'Visible editing controls must have accessible names.');
}

async function assertMobileOrder(page, width) {
  await page.setViewportSize({ width, height: 844 });
  const layout = await assertNoOverflow(page, `${width}px mobile editor`);
  const positions = await page.evaluate(() => ['.video-panel', '#timeline-panel', '#settings', '#memo-panel'].map(selector => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return { selector, top: Math.round(rect.top + scrollY), bottom: Math.round(rect.bottom + scrollY) };
  }));
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i].top >= positions[i - 1].bottom - 1,
    `Mobile editing order must be video → trim → settings → memo: ${JSON.stringify(positions)}`);
  await assertAccessibleControls(page);
  return { ...layout, positions };
}

async function assertLiveTimestamp(page) {
  const expected = await page.locator('#video').evaluate(video => {
    const date = document.querySelector('#recording-date').value;
    const time = document.querySelector('#recording-time').value;
    // Interpret the entered civil time directly; no local-machine timezone or app helper.
    return new Date(Date.parse(`${date}T${time}Z`) + Math.floor(video.currentTime) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  });
  assert.equal((await page.locator('#timestamp-example-value').textContent()).trim(), expected,
    'Timestamp example must reflect the entered date plus the current original-video position.');
  return expected;
}

async function assertSteps(page, expected, current) {
  const actual = await page.locator('#step-file, #step-trim, #step-save').evaluateAll(steps => steps.map(step => step.dataset.state));
  assert.deepEqual(actual, expected, 'Workflow steps must describe the current editing state.');
  assert.equal(await page.locator(`#step-${current}`).getAttribute('aria-current'), 'step');
  assert.equal(await page.locator('#step-file[aria-current="step"], #step-trim[aria-current="step"], #step-save[aria-current="step"]').count(), 1);
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseUrl).origin) externalRequests.push(request.url());
  });
  const response = await page.goto(baseUrl.href, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200, 'Start the app server and ensure dist/index.html is present.');
  assert.match((await page.title()).normalize('NFC'), /joon법정신/);
  assert.equal((await page.locator('.brand-name').textContent()).normalize('NFC').trim(), 'joon법정신');
  assert.equal(await page.locator('#export-button').isDisabled(), true);
  assert.equal(await page.locator('#preview-clip').isDisabled(), true);
  assert.match(await page.locator('#export-readiness').textContent(), /영상.*(열|선택)/);
  await assertSteps(page, ['current', 'pending', 'pending'], 'file');
  await assertAccessibleControls(page);
  await page.locator('#help-button').click();
  assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), true);
  await page.locator('#close-help').click();
  assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), false);
  results.emptyMobile320 = await assertMobileOrder(page, 320);
  results.emptyMobile390 = await assertMobileOrder(page, 390);
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.screenshot({ path: fileURLToPath(new URL('desktop-empty.png', artifactDirectory)), fullPage: true });

  await page.locator('#demo-button').click();
  await page.locator('#preview-area').waitFor({ state: 'visible', timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  assert.match(await page.locator('#file-name').textContent(), /sample\.mp4/);
  assert.match(await page.locator('#file-meta').textContent(), /1280 × 720.*소리 포함/);
  assert.equal(await page.locator('#time-confirmed').isChecked(), true);
  await assertSteps(page, ['done', 'done', 'current'], 'save');

  await page.locator('#trim-start-input').fill('00:03.0');
  await page.locator('#trim-start-input').press('Tab');
  await page.locator('#trim-end-input').fill('00:08.0');
  await page.locator('#trim-end-input').press('Tab');
  assert.equal(await page.locator('#clip-duration').textContent(), '00:05.0');
  assert.match(await page.locator('#export-summary').textContent(), /00:03.0.*00:08.0.*00:05.0/);

  let downloadCount = 0;
  page.on('download', () => downloadCount++);
  await page.locator('#recording-date').fill('2026-10-20');
  assert.equal(await page.locator('#time-confirmed').isChecked(), false, 'Editing the date must invalidate source-time confirmation.');
  assert.match(await page.locator('#export-readiness').textContent(), /시각.*확인|확인.*시각/);
  await assertSteps(page, ['done', 'current', 'pending'], 'trim');
  await page.locator('#export-button').click();
  await page.locator('#error-banner').waitFor({ state: 'visible' });
  assert.match(await page.locator('#error-banner').textContent(), /확인.*체크/);
  assert.equal(await page.locator('#download-result').isVisible(), false);
  assert.equal(downloadCount, 0, 'An unconfirmed timestamp must block export.');

  await page.locator('#recording-date').fill('2026-10-21');
  await page.locator('#recording-time').fill('23:59:58');
  await page.locator('#time-confirmed').check();
  await assertSteps(page, ['done', 'done', 'current'], 'save');
  assert.equal(await page.locator('#export-readiness').getAttribute('data-state'), 'ready');
  results.timestampAtEnd = await assertLiveTimestamp(page);
  assert.equal(results.timestampAtEnd, '2026-10-22 00:00:06');
  await page.locator('#position').selectOption('top-right');
  const yellow = await page.locator('#watermark-color option').evaluateAll(options => options.find(option => /노랑|노란|yellow/i.test(option.textContent))?.value);
  assert.ok(yellow, 'Watermark color selector must offer yellow.');
  await page.locator('#watermark-color').selectOption(yellow);
  await page.locator('#font-size').press('End');
  assert.equal(await page.locator('#font-size-value').textContent(), await page.locator('#font-size').inputValue());
  await page.locator('#zoom').selectOption('2');
  assert.match(await page.locator('#video').getAttribute('style'), /scale\(2\)/);
  await page.locator('#preview-clip').click();
  await page.waitForFunction(() => {
    const video = document.getElementById('video');
    return !video.paused && video.currentTime >= 3 && video.currentTime < 4;
  });
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.getElementById('video').paused);
  results.timestampAtPreview = await assertLiveTimestamp(page);
  assert.equal(results.timestampAtPreview, '2026-10-22 00:00:01', 'Selected-clip preview must restart at source time 3 seconds.');

  const mp4 = await downloadedBytes(page, 'clip.mp4', () => page.locator('#export-button').click());
  results.mp4 = { ...await inspectDownloadedVideo(page, mp4.url), bytes: mp4.bytes.length, filename: mp4.filename };
  assert.equal(results.mp4.duration, 5, 'UI trim boundaries must produce exactly five seconds.');
  assert.deepEqual([results.mp4.width, results.mp4.height], [1280, 720], 'Preview zoom must preserve output resolution.');
  assert.equal(results.mp4.videoCodec, 'avc');
  assert.equal(results.mp4.audioCodec, 'aac');
  assert.ok(results.mp4.audioRms > 0.001, 'Downloaded MP4 must retain audible source audio.');
  assert.ok(results.mp4.topRightYellowPixels > 100, 'The downloaded MP4 must burn yellow text into the selected top-right position.');
  assert.ok(results.mp4.bottomLeftYellowPixels < results.mp4.topRightYellowPixels / 2);
  assert.match(mp4.filename, /00-03\.0_00-08\.0\.mp4$/);
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  assert.equal(await page.locator('#export-progress').evaluate(progress => progress.value), 100);
  assert.equal(await page.locator('#download-result').isVisible(), true);
  await assertSteps(page, ['done', 'done', 'done'], 'save');

  const png = await downloadedBytes(page, 'frame.png', () => page.locator('#snapshot-button').click());
  results.png = await page.evaluate(async url => {
    const blob = await (await fetch(url)).blob();
    const bitmap = await createImageBitmap(blob);
    const value = { width: bitmap.width, height: bitmap.height, bytes: blob.size };
    bitmap.close();
    return value;
  }, png.url);
  assert.deepEqual([results.png.width, results.png.height], [1280, 720]);
  assert.deepEqual([...png.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  await page.locator('#incident-location').fill('테스트 교차로');
  await page.locator('#incident-note').fill('합성 샘플로 편집 동작을 검증했습니다.');
  const memo = await downloadedBytes(page, 'memo.txt', () => page.locator('#download-report').click());
  const text = memo.bytes.toString('utf8');
  for (const expected of ['테스트 교차로', '합성 샘플로 편집 동작을 검증했습니다.', '00:03.0 ~ 00:08.0', '2026-10-21 23:59:58', '2026-10-22 00:00:01', '사용자 확인', '실제 신고 자료가 아닙니다']) assert.ok(text.includes(expected), `Memo must include ${expected}`);
  results.memo = text;
  results.desktop = await assertNoOverflow(page, 'Desktop');
  await page.screenshot({ path: fileURLToPath(new URL('desktop-edited.png', artifactDirectory)), fullPage: true });

  await page.locator('#mute').check();
  assert.equal(await page.locator('#download-result').isVisible(), false, 'Changing export options must clear a stale completed result.');
  await assertSteps(page, ['done', 'done', 'current'], 'save');
  const muted = await downloadedBytes(page, 'muted.mp4', () => page.locator('#export-button').click());
  results.muted = await inspectDownloadedVideo(page, muted.url);
  assert.equal(results.muted.duration, 5);
  assert.equal(results.muted.audioCodec, null, 'The mute checkbox must remove the exported audio track.');
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);

  await page.locator('#reset-trim').click();
  assert.equal(await page.locator('#download-result').isVisible(), false, 'Changing the selected range must clear a stale completed result.');
  assert.equal(await page.locator('#export-progress-section').isVisible(), false);
  await assertSteps(page, ['done', 'done', 'current'], 'save');
  const downloadsBeforeCancel = downloadCount;
  await page.locator('#export-button').click();
  await page.locator('#cancel-export').click();
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  assert.match(await page.locator('#toast').textContent(), /취소/);
  assert.equal(await page.locator('#download-result').isVisible(), false);
  assert.equal(downloadCount, downloadsBeforeCancel, 'Cancellation must not save an incomplete MP4.');
  assert.equal(await page.locator('#position').inputValue(), 'top-right');
  results.cancelled = true;

  results.mobile320 = await assertMobileOrder(page, 320);
  await page.screenshot({ path: fileURLToPath(new URL('mobile-320-edited.png', artifactDirectory)), fullPage: true });
  results.mobile = await assertMobileOrder(page, 390);
  await page.screenshot({ path: fileURLToPath(new URL('mobile-edited.png', artifactDirectory)), fullPage: true });
  await page.locator('#help-button').click();
  assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), true);
  await assertNoOverflow(page, 'Mobile help dialog');
  await page.locator('#close-help').click();

  // A real input-file workflow must reset metadata entered for the previous video.
  await page.locator('#file-input').setInputFiles(mp4.path);
  await page.waitForFunction(() => document.querySelector('#file-name').textContent === 'clip.mp4'
    && !document.querySelector('#open-file-button').disabled);
  assert.equal(await page.locator('#recording-date').inputValue(), '');
  assert.equal(await page.locator('#recording-time').inputValue(), '');
  assert.equal(await page.locator('#time-confirmed').isChecked(), false);
  assert.equal(await page.locator('#demo-badge').isVisible(), false);
  assert.equal(await page.locator('#download-result').isVisible(), false);
  assert.equal(await page.locator('#trim-start-input').inputValue(), '00:00.0');
  assert.equal(await page.locator('#trim-end-input').inputValue(), '00:05.0');
  assert.equal(await page.locator('#play-button').isEnabled(), true);
  assert.equal(await page.locator('#preview-clip').isEnabled(), true);
  assert.equal(await page.locator('#file-input').inputValue(), '');
  assert.match(await page.locator('#export-readiness').textContent(), /시각.*입력|날짜.*입력/);
  await assertSteps(page, ['done', 'current', 'pending'], 'trim');
  const downloadsBeforeInvalidInput = downloadCount;
  await page.locator('#export-button').click();
  await page.locator('#error-banner').waitFor({ state: 'visible' });
  assert.match(await page.locator('#error-banner').textContent(), /촬영.*(날짜|시각)/);
  assert.equal(downloadCount, downloadsBeforeInvalidInput, 'Opening a new file must require its own recording date.');

  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('#file-input').setInputFiles({ name: 'not-video.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic non-video fixture') });
    await page.locator('#error-banner').waitFor({ state: 'visible' });
    assert.match(await page.locator('#error-banner').textContent(), /MP4|영상 파일/);
    assert.equal(await page.locator('#file-input').inputValue(), '', 'Rejected files must reset the picker so the same file can be selected again.');
    assert.equal(await page.locator('#file-name').textContent(), 'clip.mp4');
    assert.equal(await page.locator('#open-file-button').isEnabled(), true);
  }
  await page.locator('#file-input').setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('Not a valid MP4 container') });
  await page.waitForFunction(() => !document.querySelector('#open-file-button').disabled && !document.querySelector('#error-banner').hidden);
  assert.equal(await page.locator('#file-name').textContent(), 'clip.mp4', 'A failed replacement must preserve the last usable video.');
  assert.equal(await page.locator('#file-input').inputValue(), '');
  assert.equal(await page.locator('#play-button').isEnabled(), true);
  await page.locator('#watermark-enabled').uncheck();
  await assertSteps(page, ['done', 'done', 'current'], 'save');
  assert.equal(await page.locator('#export-readiness').getAttribute('data-state'), 'ready');
  await page.locator('#preview-clip').click();
  await page.waitForFunction(() => !document.querySelector('#video').paused);
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.querySelector('#video').paused);
  results.fileInput = { reloaded: 'clip.mp4', dateReset: true, invalidTypeRejected: true, corruptVideoRejected: true, previousVideoStillPlayable: true };

  assert.deepEqual(errors, [], 'No unhandled browser JavaScript errors.');
  assert.deepEqual(externalRequests, [], 'No external requests are needed to edit generated footage.');
  console.log(JSON.stringify({ ...results, errors, externalRequests }, null, 2));
  console.log('PASS: joon법정신 brand, real UI demo, selected-clip preview, live source timestamp, trim, confirmation, MP4/audio/watermark, PNG, memo, zoom, mute, cancel, help, accessible labels, 320/390px mobile flow, real file loading and invalid-file recovery.');
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: fileURLToPath(new URL('failure.png', artifactDirectory)), fullPage: true }).catch(() => {});
  console.error('Browser errors:', errors);
  throw error;
} finally {
  await browser.close();
}
