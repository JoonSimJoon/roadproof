import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordingTime, formatRecordingTime, drawWatermark } from '../dist/media.js';

test('datetime-local means Korea time regardless of the host time zone', () => {
  assert.equal(parseRecordingTime('2026-10-21T08:15:30'), Date.UTC(2026, 9, 20, 23, 15, 30));
  assert.equal(formatRecordingTime('2026-10-20T23:15:30Z', 0), '2026-10-21 08:15:30');
});

test('recording time advances across Korean midnight and year boundaries', () => {
  assert.equal(formatRecordingTime('2026-12-31T23:59:58', 3.2), '2027-01-01 00:00:01');
  assert.equal(formatRecordingTime('2024-02-28T23:59:59', 1), '2024-02-29 00:00:00');
  assert.equal(formatRecordingTime('2026-10-21T12:00', 59.999), '2026-10-21 12:00:59');
});

test('impossible and missing recording dates are rejected instead of guessed', () => {
  for (const value of ['', undefined, '2026-02-30T12:00', '2026-02-29T12:00', '2026-10-21T25:00', '2026-13-01T12:00']) {
    assert.throws(() => parseRecordingTime(value), /촬영 시작/);
  }
});

test('watermark renders original-file time after trimming rather than restarting clock', () => {
  let rendered;
  const ctx = {
    save() {}, restore() {}, fillRect() {},
    measureText: text => ({ width: text.length * 18 }),
    fillText(text, x, y) { rendered = { text, x, y }; },
  };
  // A frame 2.5 seconds into an export trimmed from original second 14.5.
  drawWatermark(ctx, 1920, 1080, 14.5 + 2.5, {
    baseDateTime: '2026-10-21T23:59:50', position: 'bottom-right', fontSize: 32,
  });
  assert.equal(rendered.text, '2026-10-22 00:00:07');
  assert.ok(rendered.x > 1400 && rendered.x < 1920);
  assert.ok(rendered.y > 1000 && rendered.y < 1080);
  rendered = null;
  drawWatermark(ctx, 1920, 1080, 17, { watermarkEnabled: false });
  assert.equal(rendered, null);
});
