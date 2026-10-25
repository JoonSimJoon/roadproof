import { inspectVideo, exportVideo, exportFrame, makeDemoFile, drawWatermark, formatRecordingTime, parseRecordingTime } from './media.js';
import { clamp, formatTime, parseTime, formatBytes, presetRange, downloadName } from './editor-utils.js';

const $ = id => document.getElementById(id);
const video = $('video');
const state = { file: null, url: null, info: null, start: 0, end: 0, busy: false, loadId: 0, abort: null, resultUrl: null, demo: false };
let toastTimer;
let animationFrame;
const overlay = document.createElement('canvas');
overlay.setAttribute('aria-hidden', 'true');
overlay.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
$('watermark-preview').append(overlay);
const overlayContext = overlay.getContext('2d');

function validRecordingTime(value) {
  try { return Number.isFinite(parseRecordingTime(value)); }
  catch { return false; }
}

function settings() {
  return {
    start: state.start,
    end: state.end,
    baseDateTime: $('recording-date').value && $('recording-time').value ? `${$('recording-date').value}T${$('recording-time').value}` : '',
    watermarkEnabled: $('watermark-enabled').checked,
    position: $('position').value,
    fontSize: Number($('font-size').value),
    color: $('watermark-color').value,
    background: $('watermark-background').checked,
    quality: $('quality').value,
    mute: $('mute').checked,
  };
}

function notify(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function showError(error) {
  $('error-banner').textContent = error instanceof Error ? error.message : String(error);
  $('error-banner').hidden = false;
  $('error-banner').scrollIntoView({ block: 'nearest', behavior: 'instant' });
}

function clearError() { $('error-banner').hidden = true; }

function updateReadiness() {
  const options = settings();
  const validDate = validRecordingTime(options.baseDateTime);
  const ready = !!state.file && (!options.watermarkEnabled || (validDate && $('time-confirmed').checked));
  let text = '영상을 열면 편집을 시작할 수 있어요.';
  if (state.busy) text = state.abort ? 'MP4를 만들고 있어요. 이 화면을 열어두세요.' : '영상을 준비하고 있어요.';
  else if (state.file) {
    if (options.watermarkEnabled && !validDate) text = '원본이 시작된 실제 촬영 날짜와 시간을 입력하세요.';
    else if (!ready) text = '입력한 시각을 확인하고 확인란을 체크하세요.';
    else if (state.resultUrl) text = '저장 완료. 아래에서 완성된 영상을 다시 받을 수 있어요.';
    else text = options.watermarkEnabled ? '준비 완료. 선택한 구간에 촬영 시각을 넣어 저장합니다.' : '준비 완료. 날짜·시간 표시 없이 저장합니다.';
  }
  $('export-readiness').textContent = text;
  $('export-readiness').dataset.state = state.busy ? 'busy' : ready ? 'ready' : 'pending';
  const steps = [state.file ? 'done' : 'current', state.file ? 'current' : 'pending', state.resultUrl ? 'done' : ready ? 'current' : 'pending'];
  if (ready) steps[1] = 'done';
  for (const [index, id] of ['step-file', 'step-trim', 'step-save'].entries()) {
    $(id).dataset.state = steps[index];
    $(id).removeAttribute('aria-current');
  }
  $(state.file ? ready ? 'step-save' : 'step-trim' : 'step-file').setAttribute('aria-current', 'step');
  for (const id of ['recording-date', 'recording-time', 'time-confirmed', 'position', 'watermark-color', 'font-size', 'watermark-background']) $(id).disabled = state.busy || !options.watermarkEnabled;
  $('mute').disabled = state.busy || !state.info?.hasAudio;
  updateTimestampExample();
}

function updateTimestampExample() {
  const options = settings();
  const valid = validRecordingTime(options.baseDateTime);
  $('timestamp-example-value').textContent = !options.watermarkEnabled ? '날짜·시간 표시 꺼짐' : valid ? formatRecordingTime(options.baseDateTime, state.file ? video.currentTime : 0) : '촬영 시각을 입력해주세요';
  $('timestamp-example-label').textContent = options.watermarkEnabled && valid ? '현재 장면의 표시 시각 · 한국 시간' : '원본 영상 00:00을 기준으로 계산해요';
}

function setBusy(busy, message = '영상을 준비하고 있습니다…') {
  state.busy = busy;
  for (const input of document.querySelectorAll('#settings input, #settings select, #timeline-panel input, #timeline-panel button, #player-controls button, #player-controls select')) input.disabled = busy || (!state.file && !input.closest('#settings'));
  for (const id of ['open-file-button', 'choose-file', 'demo-button', 'export-button', 'snapshot-button']) $(id).disabled = busy || ((!state.file) && ['export-button', 'snapshot-button'].includes(id));
  $('cancel-export').disabled = false;
  $('export-button').textContent = busy ? '처리 중…' : 'MP4로 저장';
  $('drop-zone').setAttribute('aria-busy', String(busy));
  $('load-status').hidden = !busy || !!state.abort;
  $('load-status').textContent = message;
  updateReadiness();
}

function drawPreview() {
  if (state.busy && !state.abort) return;
  if (!state.file || !video.videoWidth) return;
  if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  }
  overlayContext.clearRect(0, 0, overlay.width, overlay.height);
  const options = settings();
  if (options.watermarkEnabled && validRecordingTime(options.baseDateTime)) {
    drawWatermark(overlayContext, overlay.width, overlay.height, video.currentTime, options);
  }
  $('current-time').textContent = formatTime(video.currentTime, true);
  $('seek').value = String(video.currentTime);
  $('timeline-panel').style.setProperty('--playhead', `${video.currentTime / state.info.duration * 100}%`);
  $('seek').setAttribute('aria-valuetext', formatTime(video.currentTime, true));
  updateTimestampExample();
}

function animate() {
  drawPreview();
  if (!video.paused && !video.ended) animationFrame = requestAnimationFrame(animate);
}

function renderRange() {
  if (!state.info) return;
  const duration = state.info.duration;
  $('trim-start-range').value = String(state.start);
  $('trim-end-range').value = String(state.end);
  $('trim-start-input').value = formatTime(state.start, true);
  $('trim-end-input').value = formatTime(state.end, true);
  $('clip-duration').textContent = formatTime(state.end - state.start, true);
  $('timeline-panel').style.setProperty('--trim-start', `${state.start / duration * 100}%`);
  $('timeline-panel').style.setProperty('--trim-end', `${state.end / duration * 100}%`);
  $('export-summary').textContent = `${formatTime(state.start, true)} – ${formatTime(state.end, true)} / ${formatTime(state.end - state.start, true)} 분량`;
  $('trim-start-range').setAttribute('aria-valuetext', formatTime(state.start, true));
  $('trim-end-range').setAttribute('aria-valuetext', formatTime(state.end, true));
}

function setRange(start, end, seekTo) {
  if (!state.info || state.busy) return;
  const minimum = Math.min(0.1, state.info.duration);
  state.start = clamp(start, 0, state.info.duration - minimum);
  state.end = clamp(end, state.start + minimum, state.info.duration);
  clearResult();
  renderRange();
  updateReadiness();
  if (seekTo !== undefined) seek(seekTo);
}

function seek(time) {
  if (!state.info || state.busy) return;
  video.currentTime = clamp(time, 0, state.info.duration);
  drawPreview();
}

async function togglePlay() {
  if (!state.file || state.busy) return;
  if (!video.paused) video.pause();
  else {
    if (video.currentTime < state.start || video.currentTime >= state.end - 0.02) video.currentTime = state.start;
    try { await video.play(); } catch { showError('영상을 재생할 수 없습니다. 이 파일의 코덱을 지원하는 최신 Chrome 또는 Safari에서 다시 열어주세요.'); }
  }
}

video.addEventListener('play', () => {
  $('play-button').innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';
  $('play-button').setAttribute('aria-label', '일시 정지');
  cancelAnimationFrame(animationFrame);
  animate();
});
video.addEventListener('pause', () => {
  $('play-button').innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-play"/></svg>';
  $('play-button').setAttribute('aria-label', '재생');
  cancelAnimationFrame(animationFrame);
  drawPreview();
});
video.addEventListener('timeupdate', () => {
  if (state.file && video.currentTime >= state.end && !video.paused) { video.pause(); video.currentTime = state.end; }
  drawPreview();
});
video.addEventListener('seeked', drawPreview);

function waitForMedia(element, event, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('영상을 읽는 시간이 초과되었습니다. 다른 MP4 파일을 열어주세요.')), timeout);
    const success = () => finish();
    const failure = () => finish(new Error('이 브라우저에서 재생할 수 없는 영상입니다. H.264 MP4 파일이나 최신 Chrome/Safari를 사용해주세요.'));
    function finish(error) {
      clearTimeout(timer);
      element.removeEventListener(event, success);
      element.removeEventListener('error', failure);
      error ? reject(error) : resolve();
    }
    element.addEventListener(event, success, { once: true });
    element.addEventListener('error', failure, { once: true });
  });
}

async function createThumbnails(url, duration, id) {
  const source = document.createElement('video');
  source.muted = true;
  source.playsInline = true;
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const context = canvas.getContext('2d');
  try {
    const ready = waitForMedia(source, 'loadeddata');
    source.src = url;
    await ready;
    for (let i = 0; i < 8; i++) {
      if (id !== state.loadId) return;
      const time = Math.min(duration - 0.02, duration * (i + 0.5) / 8);
      if (Math.abs(source.currentTime - time) > 0.001) {
        const ready = waitForMedia(source, 'seeked');
        source.currentTime = Math.max(0, time);
        await ready;
      }
      if (id !== state.loadId) return;
      const scale = Math.max(canvas.width / source.videoWidth, canvas.height / source.videoHeight);
      const width = source.videoWidth * scale;
      const height = source.videoHeight * scale;
      context.drawImage(source, (160 - width) / 2, (90 - height) / 2, width, height);
      const img = document.createElement('img');
      img.src = canvas.toDataURL('image/jpeg', 0.65);
      img.alt = '';
      $('timeline-thumbnails').append(img);
    }
  } catch { /* Thumbnails are optional; timeline remains fully usable. */ }
  finally { source.removeAttribute('src'); source.load(); }
}

async function loadFile(file, demo = false) {
  if (!file || state.busy) return;
  clearError();
  if (!/\.(mp4|m4v|mov|webm)$/i.test(file.name) && !file.type.startsWith('video/')) { showError('MP4, MOV 또는 WebM 영상 파일을 선택해주세요.'); $('file-input').value = ''; return; }
  const id = ++state.loadId;
  video.pause();
  setBusy(true, `${file.name} 읽는 중…`);
  notify('영상을 읽고 있습니다. 파일은 업로드되지 않습니다.');
  let url;
  try {
    const info = await inspectVideo(file);
    if (!Number.isFinite(info.duration) || info.duration <= 0) throw new Error('영상의 재생 시간을 읽을 수 없습니다. 파일이 손상되지 않았는지 확인해주세요.');
    url = URL.createObjectURL(file);
    const ready = waitForMedia(video, 'loadeddata');
    video.src = url;
    await ready;
    if (id !== state.loadId) return;
    if (state.url) URL.revokeObjectURL(state.url);
    Object.assign(state, { file, url, info, start: 0, end: info.duration, demo });
    $('empty-state').hidden = true;
    $('preview-area').hidden = false;
    $('demo-badge').hidden = !demo;
    $('file-name').textContent = file.name;
    $('file-meta').textContent = `${info.width} × ${info.height} · ${formatBytes(file.size)} · ${info.hasAudio ? '소리 포함' : '소리 없음'}`;
    $('total-time').textContent = formatTime(info.duration, true);
    $('recording-date').value = demo ? '2026-10-21' : '';
    $('recording-time').value = demo ? '09:41:00' : '';
    $('time-confirmed').checked = demo;
    $('zoom').value = '1';
    $('playback-rate').value = '1';
    video.playbackRate = 1;
    video.style.transform = '';
    $('zoom-label').textContent = '';
    $('timeline-thumbnails').replaceChildren();
    for (const name of ['seek', 'trim-start-range', 'trim-end-range']) { $(name).max = String(info.duration); $(name).step = '0.01'; }
    renderRange();
    clearResult();
    notify(demo ? '직접 만든 샘플 영상입니다. 구간과 워터마크를 바꿔 저장해보세요.' : '영상을 열었습니다. 원본의 실제 촬영 시작 시각을 입력해주세요.');
    void createThumbnails(url, info.duration, id);
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    if (state.url && video.src !== state.url) {
      const restored = waitForMedia(video, 'loadeddata');
      video.src = state.url;
      await restored.catch(() => {});
    } else if (!state.url) { video.removeAttribute('src'); video.load(); }
    showError(error);
  } finally {
    setBusy(false);
    drawPreview();
    $('file-input').value = '';
  }
}

for (const id of ['open-file-button', 'choose-file']) $(id).addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => void loadFile(event.target.files[0]));
let dragDepth = 0;
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());
$('drop-zone').addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; if (!state.busy) $('drop-zone').classList.add('drag-over'); });
$('drop-zone').addEventListener('dragleave', () => { dragDepth--; if (dragDepth <= 0) $('drop-zone').classList.remove('drag-over'); });
$('drop-zone').addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('drop-zone').classList.remove('drag-over'); void loadFile(event.dataTransfer.files[0]); });

$('demo-button').addEventListener('click', async () => {
  clearError();
  setBusy(true, '편집 연습용 샘플을 만들고 있습니다…');
  $('demo-button').textContent = '샘플 영상 준비 중…';
  try {
    const file = await makeDemoFile();
    setBusy(false);
    await loadFile(file, true);
  } catch (error) { showError(error); }
  finally { $('demo-button').textContent = '샘플로 둘러보기'; setBusy(false); }
});

$('play-button').addEventListener('click', togglePlay);
$('preview-clip').addEventListener('click', async () => {
  if (!state.file || state.busy) return;
  video.pause();
  seek(state.start);
  await togglePlay();
});
$('back-button').addEventListener('click', () => seek(video.currentTime - 1));
$('forward-button').addEventListener('click', () => seek(video.currentTime + 1));
$('seek').addEventListener('input', event => seek(Number(event.target.value)));
$('playback-rate').addEventListener('change', event => { video.playbackRate = Number(event.target.value); });
$('zoom').addEventListener('change', event => {
  const zoom = Number(event.target.value);
  video.style.transform = `scale(${zoom})`;
  video.style.transformOrigin = '50% 50%';
  $('zoom-label').textContent = zoom > 1 ? `${zoom}× 미리보기 · 화면을 움직여 확인 / 저장은 전체 화면` : '';
});
$('video-viewport').addEventListener('pointermove', event => {
  if (Number($('zoom').value) <= 1) return;
  const rect = event.currentTarget.getBoundingClientRect();
  video.style.transformOrigin = `${clamp((event.clientX - rect.left) / rect.width * 100, 0, 100)}% ${clamp((event.clientY - rect.top) / rect.height * 100, 0, 100)}%`;
});
$('trim-start-range').addEventListener('input', event => { const start = Math.min(Number(event.target.value), state.end - 0.1); setRange(start, state.end, start); });
$('trim-end-range').addEventListener('input', event => { const end = Math.max(Number(event.target.value), state.start + 0.1); setRange(state.start, end, end); });
for (const [id, key] of [['trim-start-input', 'start'], ['trim-end-input', 'end']]) $(id).addEventListener('change', event => {
  const time = parseTime(event.target.value);
  if (!Number.isFinite(time) || time < 0 || time > state.info.duration || (key === 'start' ? time >= state.end : time <= state.start)) {
    notify('원본 영상 안에서 시작보다 뒤에 끝 지점을 지정해주세요. 시간 형식은 00:30.0입니다.');
    renderRange(); return;
  }
  setRange(key === 'start' ? time : state.start, key === 'end' ? time : state.end, time);
});
$('mark-start').addEventListener('click', () => setRange(Math.min(video.currentTime, state.end - 0.1), state.end));
$('mark-end').addEventListener('click', () => setRange(state.start, Math.max(video.currentTime, state.start + 0.1)));
$('reset-trim').addEventListener('click', () => setRange(0, state.info?.duration || 0));
for (const button of document.querySelectorAll('[data-clip-seconds]')) button.addEventListener('click', () => {
  if (!state.info || state.busy) return;
  const range = presetRange(video.currentTime, state.info.duration, Number(button.dataset.clipSeconds));
  setRange(range.start, range.end, range.start);
});
for (const input of document.querySelectorAll('#settings input, #settings select')) input.addEventListener('input', () => {
  if (input.id === 'recording-date' || input.id === 'recording-time') $('time-confirmed').checked = false;
  $('font-size-value').textContent = `${$('font-size').value}`;
  clearResult();
  clearError();
  updateReadiness();
  drawPreview();
});

function validateTimestamp() {
  const options = settings();
  if (options.watermarkEnabled && !validRecordingTime(options.baseDateTime)) {
    $('recording-date').focus();
    throw new Error('원본 영상이 시작된 실제 촬영 날짜와 시간을 입력해주세요. 날짜 표시가 필요 없으면 워터마크를 꺼주세요.');
  }
  if (options.watermarkEnabled && !$('time-confirmed').checked) {
    $('time-confirmed').focus();
    throw new Error('입력한 시각이 원본 영상 00:00의 실제 촬영 시각인지 확인한 뒤 체크해주세요.');
  }
  return options;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function clearResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  $('download-result').hidden = true;
  $('download-result').removeAttribute('href');
  if (!state.abort) $('export-progress-section').hidden = true;
}

$('snapshot-button').addEventListener('click', async () => {
  if (!state.file || state.busy) return;
  clearError();
  try {
    const options = validateTimestamp();
    video.pause();
    if (video.seeking) await waitForMedia(video, 'seeked');
    const blob = await exportFrame(video, options);
    saveBlob(blob, downloadName(state.file.name, video.currentTime, video.currentTime, 'png'));
    notify('현재 장면을 원본 해상도의 PNG로 저장했습니다.');
  } catch (error) { showError(error); }
});

$('export-button').addEventListener('click', async () => {
  if (!state.file || state.busy) return;
  clearError();
  let options;
  try { options = validateTimestamp(); } catch (error) { showError(error); return; }
  video.pause();
  clearResult();
  state.abort = new AbortController();
  setBusy(true);
  $('export-progress-section').hidden = false;
  $('cancel-export').hidden = false;
  $('export-progress').value = 0;
  $('export-status').textContent = '영상을 준비하고 있습니다…';
  let wakeLock;
  try {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* Optional screen wake lock. */ }
    const blob = await exportVideo(state.file, options, {
      signal: state.abort.signal,
      onProgress: progress => {
        const percent = Math.round(clamp(progress, 0, 1) * 100);
        $('export-progress').value = percent;
        $('export-status').textContent = `${percent}% · 이 화면을 열어두세요`;
      },
    });
    if (state.abort.signal.aborted) return;
    state.resultUrl = URL.createObjectURL(blob);
    const link = $('download-result');
    link.href = state.resultUrl;
    link.download = downloadName(state.file.name, state.start, state.end);
    link.textContent = `완성된 MP4 다운로드 · ${formatBytes(blob.size)}`;
    link.hidden = false;
    link.click();
    $('export-progress').value = 100;
    $('export-status').textContent = '편집 완료. 다운로드가 시작되지 않으면 아래 링크를 눌러주세요.';
    notify('MP4 편집이 완료되었습니다. 원본 파일은 변경되지 않았습니다.');
  } catch (error) {
    if (state.abort.signal.aborted || error.name === 'AbortError') notify('저장을 취소했습니다. 편집 설정은 유지됩니다.');
    else showError(error);
    $('export-progress-section').hidden = true;
  } finally {
    await wakeLock?.release().catch(() => {});
    state.abort = null;
    setBusy(false);
    $('cancel-export').disabled = true;
    $('cancel-export').hidden = true;
  }
});
$('cancel-export').addEventListener('click', () => { state.abort?.abort(); $('cancel-export').disabled = true; $('export-status').textContent = '취소하고 있습니다…'; });

function reportText() {
  const options = settings();
  const validDate = validRecordingTime(options.baseDateTime);
  return [
    'joon법정신 · 주행 영상 신고 메모',
    state.demo ? '[샘플 영상 — 실제 신고 자료가 아닙니다]' : '',
    `유형: ${$('incident-type').value || '미입력'}`,
    `장소: ${$('incident-location').value.trim() || '미입력'}`,
    `내용: ${$('incident-note').value.trim() || '미입력'}`,
    '',
    `원본 파일: ${state.file?.name || '미선택'}`,
    `선택 구간: ${formatTime(state.start, true)} ~ ${formatTime(state.end, true)}`,
    `촬영 시작 시각 (직접 입력, 한국 시간): ${validDate ? formatRecordingTime(options.baseDateTime, 0) : '미입력'}`,
    `선택 구간 시작 시각: ${validDate ? formatRecordingTime(options.baseDateTime, state.start) : '미입력'}`,
    `시각 확인: ${$('time-confirmed').checked ? '사용자 확인' : '미확인'}`,
    `편집: 구간 자르기${options.watermarkEnabled ? ', 날짜·시간 표시' : ''}${options.mute ? ', 소리 제외' : ''}`,
    '',
    '이 메모의 시각은 사용자가 입력한 값입니다. 원본 영상과 실제 상황을 함께 확인하세요.',
  ].filter((line, index, array) => line || (index > 0 && array[index - 1])).join('\n');
}
$('copy-report').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(reportText()); notify('신고 메모를 복사했습니다.'); }
  catch { showError('클립보드 권한이 없습니다. 메모 저장 버튼으로 텍스트 파일을 저장해주세요.'); }
});
$('download-report').addEventListener('click', () => { saveBlob(new Blob(['\uFEFF' + reportText()], { type: 'text/plain;charset=utf-8' }), 'joon법정신_신고메모.txt'); });
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('close-help').addEventListener('click', () => $('help-dialog').close());
$('help-dialog').addEventListener('click', event => { if (event.target === $('help-dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
document.addEventListener('keydown', event => {
  if (event.target.closest('input, textarea, select, button, a, dialog') || !state.file || state.busy || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'Space') { event.preventDefault(); void togglePlay(); }
  if (event.code === 'ArrowLeft') { event.preventDefault(); seek(video.currentTime - (event.shiftKey ? 0.1 : 1)); }
  if (event.code === 'ArrowRight') { event.preventDefault(); seek(video.currentTime + (event.shiftKey ? 0.1 : 1)); }
  if (event.code === 'KeyI') $('mark-start').click();
  if (event.code === 'KeyO') $('mark-end').click();
});
window.addEventListener('beforeunload', event => { if (state.busy) { event.preventDefault(); event.returnValue = ''; } });
setBusy(false);
