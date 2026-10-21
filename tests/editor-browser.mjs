// Start `npm run dev`, then run `node tests/editor-browser.mjs`.
// Uses a synthetic demo only; artifacts are saved under ignored artifacts/editor-qa/.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const baseUrl = process.env.ROADPROOF_URL || 'http://localhost:4173';
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
  await page.route(`**/__qa_${id}`, route => route.fulfill({
    contentType: id.endsWith('.mp4') ? 'video/mp4' : id.endsWith('.png') ? 'image/png' : 'text/plain',
    body: bytes,
  }));
  return { bytes, filename: download.suggestedFilename(), url: `/__qa_${id}` };
}

async function inspectDownloadedVideo(page, url) {
  return page.evaluate(async path => {
    const { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink } = await import('/vendor/mediabunny.mjs');
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
  }, url);
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
  }));
  assert.ok(layout.document <= layout.viewport + 1, `${label} overflows horizontally: ${JSON.stringify(layout)}`);
  return layout;
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseUrl).origin) externalRequests.push(request.url());
  });
  const response = await page.goto(baseUrl, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200, 'Start the app server and ensure dist/index.html is present.');
  assert.equal(await page.locator('#export-button').isDisabled(), true);
  await page.locator('#help-button').click();
  assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), true);
  await page.locator('#close-help').click();
  assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), false);
  await page.screenshot({ path: fileURLToPath(new URL('desktop-empty.png', artifactDirectory)), fullPage: true });

  await page.locator('#demo-button').click();
  await page.locator('#preview-area').waitFor({ state: 'visible', timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  assert.match(await page.locator('#file-name').textContent(), /sample\.mp4/);
  assert.match(await page.locator('#file-meta').textContent(), /1280 × 720.*소리 포함/);
  assert.equal(await page.locator('#time-confirmed').isChecked(), true);

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
  await page.locator('#export-button').click();
  await page.locator('#error-banner').waitFor({ state: 'visible' });
  assert.match(await page.locator('#error-banner').textContent(), /확인.*체크/);
  assert.equal(await page.locator('#download-result').isVisible(), false);
  assert.equal(downloadCount, 0, 'An unconfirmed timestamp must block export.');

  await page.locator('#recording-date').fill('2026-10-21');
  await page.locator('#recording-time').fill('23:59:58');
  await page.locator('#time-confirmed').check();
  await page.locator('#position').selectOption('top-right');
  const yellow = await page.locator('#watermark-color option').evaluateAll(options => options.find(option => /노랑|노란|yellow/i.test(option.textContent))?.value);
  assert.ok(yellow, 'Watermark color selector must offer yellow.');
  await page.locator('#watermark-color').selectOption(yellow);
  await page.locator('#font-size').press('End');
  assert.equal(await page.locator('#font-size-value').textContent(), await page.locator('#font-size').inputValue());
  await page.locator('#zoom').selectOption('2');
  assert.match(await page.locator('#video').getAttribute('style'), /scale\(2\)/);
  await page.locator('#play-button').click();
  await page.waitForFunction(() => !document.getElementById('video').paused);
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.getElementById('video').paused);

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
  const muted = await downloadedBytes(page, 'muted.mp4', () => page.locator('#export-button').click());
  results.muted = await inspectDownloadedVideo(page, muted.url);
  assert.equal(results.muted.duration, 5);
  assert.equal(results.muted.audioCodec, null, 'The mute checkbox must remove the exported audio track.');
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);

  await page.locator('#reset-trim').click();
  const downloadsBeforeCancel = downloadCount;
  await page.locator('#export-button').click();
  await page.locator('#cancel-export').click();
  await page.waitForFunction(() => !document.getElementById('export-button').disabled);
  assert.match(await page.locator('#toast').textContent(), /취소/);
  assert.equal(await page.locator('#download-result').isVisible(), false);
  assert.equal(downloadCount, downloadsBeforeCancel, 'Cancellation must not save an incomplete MP4.');
  assert.equal(await page.locator('#position').inputValue(), 'top-right');
  results.cancelled = true;

  await page.setViewportSize({ width: 390, height: 844 });
  results.mobile = await assertNoOverflow(page, 'Mobile loaded editor');
  await page.screenshot({ path: fileURLToPath(new URL('mobile-edited.png', artifactDirectory)), fullPage: true });
  await page.locator('#help-button').click();
  assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), true);
  await assertNoOverflow(page, 'Mobile help dialog');
  await page.locator('#close-help').click();
  assert.deepEqual(errors, [], 'No unhandled browser JavaScript errors.');
  assert.deepEqual(externalRequests, [], 'No external requests are needed to edit generated footage.');
  console.log(JSON.stringify({ ...results, errors, externalRequests }, null, 2));
  console.log('PASS: real UI demo, trim, timestamp confirmation, yellow top-right watermark, MP4/audio, PNG, memo, zoom, mute, cancel, help, mobile layout.');
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: fileURLToPath(new URL('failure.png', artifactDirectory)), fullPage: true }).catch(() => {});
  console.error('Browser errors:', errors);
  throw error;
} finally {
  await browser.close();
}
