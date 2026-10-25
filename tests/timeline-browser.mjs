// Start `npm run dev`, then run `node tests/timeline-browser.mjs`.
// ROADPROOF_URL can point at the deployed GitHub Pages subpath.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const baseUrl = new URL(process.env.ROADPROOF_URL || 'http://localhost:4173');
if (!baseUrl.pathname.endsWith('/') && !baseUrl.pathname.endsWith('.html')) baseUrl.pathname += '/';
const artifactDirectory = new URL('../artifacts/timeline-qa/', import.meta.url);
await mkdir(artifactDirectory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const results = [];
const rangeIds = ['trim-start-range', 'seek', 'trim-end-range'];
const thumbWidth = 16;

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, received ${actual} (tolerance ${tolerance}).`);
}

async function values(page) {
  return page.evaluate(() => ({
    start: Number(document.getElementById('trim-start-range').value),
    end: Number(document.getElementById('trim-end-range').value),
    seek: Number(document.getElementById('seek').value),
  }));
}

async function clickRange(page, id, fraction) {
  const input = page.locator(`#${id}`);
  await input.scrollIntoViewIfNeeded();
  const box = await input.boundingBox();
  assert.ok(box, `${id} must be visible.`);
  // Native range movement is the input width minus its thumb, not the full box.
  const x = box.x + thumbWidth / 2 + fraction * (box.width - thumbWidth);
  await page.mouse.click(x, box.y + box.height / 2);
  await page.waitForFunction(() => !document.getElementById('video').seeking);
  return { x, value: Number(await input.inputValue()) };
}

async function inspectLayout(page, width) {
  const geometry = await page.evaluate(ids => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, width: box.width, top: box.top + scrollY, bottom: box.bottom + scrollY };
    };
    const inputs = Object.fromEntries(ids.map(id => [id, rect(document.getElementById(id))]));
    return {
      inputs,
      timeline: rect(document.querySelector('.timeline-track')),
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      clippedControls: [...document.querySelectorAll('#timeline-panel input, #timeline-panel button')].filter(element => {
        if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return false;
        const box = element.getBoundingClientRect();
        return box.left < -1 || box.right > document.documentElement.clientWidth + 1;
      }).map(element => element.id || element.textContent.trim()),
    };
  }, rangeIds);
  const start = geometry.inputs['trim-start-range'];
  const end = geometry.inputs['trim-end-range'];
  assert.ok(start.bottom <= geometry.timeline.top + 1, `${width}px: start slider must be above the timeline.`);
  assert.ok(end.top >= geometry.timeline.bottom - 1, `${width}px: end slider must be below the timeline.`);
  assert.ok(start.bottom - start.top >= 44 && end.bottom - end.top >= 44, `${width}px: trim sliders need a 44px pointer target.`);
  const seek = geometry.inputs.seek;
  near(seek.bottom - seek.top, geometry.timeline.bottom - geometry.timeline.top, 1, `${width}px seek target must cover the timeline height`);
  for (const id of rangeIds) {
    near(geometry.inputs[id].x, start.x, 1, `${width}px ${id} left alignment`);
    near(geometry.inputs[id].width, start.width, 1, `${width}px ${id} width`);
  }
  near(geometry.timeline.x, start.x, 1, `${width}px timeline left alignment`);
  near(geometry.timeline.width, start.width, 1, `${width}px timeline width`);
  assert.ok(geometry.document <= geometry.viewport + 1, `${width}px: page must not overflow horizontally.`);
  assert.deepEqual(geometry.clippedControls, [], `${width}px: timeline controls must not be clipped.`);
  return geometry;
}

async function assertSelectionAlignment(page) {
  const geometry = await page.evaluate(thumb => {
    const input = document.getElementById('trim-start-range');
    const endInput = document.getElementById('trim-end-range');
    const box = input.getBoundingClientRect();
    const axis = document.querySelector('.timeline-axis');
    const axisBox = axis.getBoundingClientRect();
    const selection = getComputedStyle(axis, '::after');
    const min = Number(input.min), duration = Number(input.max) - min;
    const position = value => box.x + thumb / 2 + (Number(value) - min) / duration * (box.width - thumb);
    return {
      actualLeft: axisBox.x + axis.clientLeft + parseFloat(selection.left),
      actualRight: axisBox.x + axis.clientLeft + axis.clientWidth - parseFloat(selection.right),
      expectedLeft: position(input.value),
      expectedRight: position(endInput.value),
      selectionVisible: selection.content !== 'none' && selection.display !== 'none' && Number(selection.opacity) > 0,
    };
  }, thumbWidth);
  assert.equal(geometry.selectionVisible, true, 'The selected interval must be visible.');
  near(geometry.actualLeft, geometry.expectedLeft, 1, 'Selection start and start thumb center');
  near(geometry.actualRight, geometry.expectedRight, 1, 'Selection end and end thumb center');
  return geometry;
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.goto(baseUrl.href, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200, 'Start the application server before running this test.');
  await page.locator('#demo-button').click();
  await page.locator('#preview-area').waitFor({ state: 'visible', timeout: 120000 });
  await page.waitForFunction(() => !document.getElementById('trim-start-range').disabled);
  // The editor uses the primary video duration; media-element duration may include AAC padding.
  const duration = Number(await page.locator('#seek').getAttribute('max'));
  assert.equal(duration, 12, 'Use only the generated 12-second synthetic sample.');

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1050 : 844 });
    await page.locator('#timeline-panel').scrollIntoViewIfNeeded();
    const layout = await inspectLayout(page, width);
    const clicks = [];
    for (const fraction of [0.25, 0.5, 0.75]) {
      const atPosition = {};
      for (const id of rangeIds) {
        // Start/end limits must not affect this independent coordinate test.
        await page.locator('#reset-trim').click();
        atPosition[id] = await clickRange(page, id, fraction);
        near(atPosition[id].value, duration * fraction, 0.08, `${width}px ${id} at ${fraction * 100}%`);
      }
      for (const id of rangeIds.slice(1)) {
        near(atPosition[id].x, atPosition['trim-start-range'].x, 1, `${width}px ${fraction * 100}% click x`);
        near(atPosition[id].value, atPosition['trim-start-range'].value, 0.08, `${width}px ${fraction * 100}% matching times`);
      }
      clicks.push({ fraction, inputs: atPosition });
    }

    await page.locator('#reset-trim').click();
    const fullSelection = await assertSelectionAlignment(page);
    await clickRange(page, 'trim-start-range', 0.25);
    await clickRange(page, 'trim-end-range', 0.75);
    const partialSelection = await assertSelectionAlignment(page);

    const beforeKeys = await values(page);
    await page.locator('#trim-start-range').focus();
    await page.locator('#trim-start-range').press('ArrowRight');
    await page.locator('#trim-end-range').focus();
    await page.locator('#trim-end-range').press('ArrowLeft');
    const afterKeys = await values(page);
    near(afterKeys.start, beforeKeys.start + 0.01, 0.001, `${width}px start keyboard step`);
    near(afterKeys.end, beforeKeys.end - 0.01, 0.001, `${width}px end keyboard step`);

    await clickRange(page, 'trim-start-range', 1);
    const startCrossing = await values(page);
    near(startCrossing.end - startCrossing.start, 0.1, 0.001, `${width}px start cannot cross end`);
    await clickRange(page, 'trim-end-range', 0);
    const endCrossing = await values(page);
    near(endCrossing.end - endCrossing.start, 0.1, 0.001, `${width}px end cannot cross start`);

    // Leave a 25–75% selection and centered playhead for the visual evidence.
    await page.locator('#reset-trim').click();
    await clickRange(page, 'trim-start-range', 0.25);
    await clickRange(page, 'trim-end-range', 0.75);
    await clickRange(page, 'seek', 0.5);
    await assertSelectionAlignment(page);
    await page.locator('#timeline-panel').screenshot({ path: fileURLToPath(new URL(`timeline-${width}.png`, artifactDirectory)) });
    results.push({ width, layout, clicks, fullSelection, partialSelection, keyboard: afterKeys, crossingClamped: true });
  }
  assert.deepEqual(errors, [], 'No unhandled JavaScript errors during timeline interactions.');
  console.log(JSON.stringify({ results, errors }, null, 2));
  console.log('PASS: start above/end below timeline, aligned native range coordinates and selection borders, pointer + keyboard editing, clamped crossings, 1440/390/320px layouts.');
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.locator('#timeline-panel').screenshot({ path: fileURLToPath(new URL('failure.png', artifactDirectory)) }).catch(() => {});
  }
  console.error('Browser errors:', errors);
  throw error;
} finally {
  await browser.close();
}
