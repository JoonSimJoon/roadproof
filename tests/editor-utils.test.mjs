import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, parseTime, presetRange, downloadName } from '../dist/editor-utils.js';

test('timeline preserves fractional seconds and hour-long rides', () => {
  assert.equal(formatTime(3661.2, true), '1:01:01.2');
  assert.equal(parseTime('1:01:01.2'), 3661.2);
  assert.equal(formatTime(59.96, true), '01:00.0');
  assert.equal(parseTime('15.25'), 15.25);
});
test('invalid time edits cannot become clip bounds', () => {
  for (const input of ['', '-1', '00:70', '1:60:00', 'NaN', '1.5:02', '::']) {
    assert.ok(Number.isNaN(parseTime(input)), input);
  }
});
test('presets retain requested duration at both ends of original', () => {
  assert.deepEqual(presetRange(0, 120, 30), { start: 0, end: 30 });
  assert.deepEqual(presetRange(119, 120, 30), { start: 90, end: 120 });
  assert.deepEqual(presetRange(2, 8, 30), { start: 0, end: 8 });
});
test('download name describes original selected range', () => {
  assert.equal(downloadName('ride.mp4', 30, 45), 'ride_편집_00-30.0_00-45.0.mp4');
});
