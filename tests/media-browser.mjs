// Run with `node tests/media-browser.mjs`. Requires installed Google Chrome.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const server = http.createServer(async (req, res) => {
  const file = {
    '/media.js': new URL('../dist/media.js', import.meta.url),
    '/vendor/mediabunny.mjs': new URL('../node_modules/mediabunny/dist/bundles/mediabunny.mjs', import.meta.url),
  }[req.url];
  res.setHeader('Content-Type', file ? 'text/javascript' : 'text/html');
  res.end(file ? await readFile(file) : '<!doctype html><html lang="ko"><title>Media integration test</title></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const media = await import('/media.js');
    const { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink } = await import('/vendor/mediabunny.mjs');
    const file = await media.makeDemoFile();
    const before = await media.inspectVideo(file);
    const settings = { start: 3, end: 8, baseDateTime: '2026-10-21T23:59:58', quality: 'high', fontSize: 48, position: 'bottom-left' };
    const progress = [];
    const blob = await media.exportVideo(file, settings, { onProgress: value => progress.push(value) });
    const after = await media.inspectVideo(blob);
    const originalInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const resultInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    const originalFrames = new CanvasSink(await originalInput.getPrimaryVideoTrack());
    const resultFrames = new CanvasSink(await resultInput.getPrimaryVideoTrack());
    const watermark = [];
    try {
      for (const seconds of [0, 3]) {
        const actual = (await resultFrames.getCanvas(seconds)).canvas;
        const original = (await originalFrames.getCanvas(settings.start + seconds)).canvas;
        const expected = new OffscreenCanvas(1280, 720);
        const wrong = new OffscreenCanvas(1280, 720);
        const ctx = expected.getContext('2d');
        const wrongCtx = wrong.getContext('2d');
        ctx.drawImage(original, 0, 0); wrongCtx.drawImage(original, 0, 0);
        media.drawWatermark(ctx, 1280, 720, settings.start + seconds, settings);
        // First test distinguishes an incorrectly reset clock; second a frozen clock.
        media.drawWatermark(wrongCtx, 1280, 720, seconds === 0 ? 0 : settings.start, settings);
        const pixels = actual.getContext('2d').getImageData(15, 650, 420, 60).data;
        const rightPixels = ctx.getImageData(15, 650, 420, 60).data;
        const wrongPixels = wrongCtx.getImageData(15, 650, 420, 60).data;
        let rightError = 0, wrongError = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          for (let channel = 0; channel < 3; channel++) {
            rightError += Math.abs(pixels[i + channel] - rightPixels[i + channel]);
            wrongError += Math.abs(pixels[i + channel] - wrongPixels[i + channel]);
          }
        }
        watermark.push({ seconds, rightError, wrongError });
      }
      const audioTrack = await resultInput.getPrimaryAudioTrack();
      const audio = audioTrack && await new AudioBufferSink(audioTrack).getBuffer(0.2);
      const samples = audio?.buffer.getChannelData(0) || [];
      let energy = 0;
      for (const value of samples) energy += value * value;
      after.audioRms = Math.sqrt(energy / samples.length);
    } finally {
      originalInput.dispose(); resultInput.dispose();
    }
    const controller = new AbortController();
    const cancellation = await media.exportVideo(file, settings, {
      signal: controller.signal,
      onProgress: value => { if (value > 0.1) controller.abort(); },
    }).then(() => 'unexpected success', error => error.name);
    const mutedBlob = await media.exportVideo(file, { start: 4, end: 5, watermarkEnabled: false, mute: true, quality: 'small' });
    const muted = await media.inspectVideo(mutedBlob);
    const video = document.createElement('video');
    video.preload = 'auto'; video.muted = true;
    const url = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; video.src = url; });
      await new Promise(resolve => { video.onseeked = resolve; video.currentTime = 4; });
      const png = await media.exportFrame(video, settings);
      const bitmap = await createImageBitmap(png);
      const frame = { type: png.type, width: bitmap.width, height: bitmap.height, bytes: png.size };
      bitmap.close();
      return { before, after, muted, watermark, cancellation, progress, frame, bytes: blob.size };
    } finally {
      video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
    }
  });
  assert.equal(result.before.duration, 12);
  assert.equal(result.before.hasAudio, true, 'Test fixture must include real audio.');
  assert.equal(result.after.duration, 5);
  assert.equal(result.after.videoCodec, 'avc');
  assert.equal(result.after.audioCodec, 'aac');
  assert.ok(result.after.audioRms > 0.001, 'Exported audio must be audible rather than silent.');
  assert.equal(result.muted.duration, 1);
  assert.equal(result.muted.hasAudio, false);
  assert.equal(result.cancellation, 'AbortError');
  assert.equal(result.progress.at(-1), 1);
  assert.ok(result.progress.every((value, index) => index === 0 || value >= result.progress[index - 1]));
  for (const comparison of result.watermark) {
    assert.ok(comparison.rightError < comparison.wrongError * 0.55, `Decoded watermark at ${comparison.seconds}s must match advancing source time: ${JSON.stringify(comparison)}`);
  }
  assert.deepEqual([result.frame.type, result.frame.width, result.frame.height], ['image/png', 1280, 720]);
  assert.ok(result.frame.bytes > 1000);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...result, progress: `${result.progress.length} monotonic updates` }, null, 2));
  console.log('PASS: real MP4 trim, burned-in advancing KST clock, retained audio, mute, cancellation, PNG frame.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
