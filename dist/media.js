// Media stays in this browser. Only the bundled codec library is loaded.
let libraryPromise;
const getLibrary = () => libraryPromise ??= import('./vendor/mediabunny.mjs');
const KST_OFFSET = 9 * 60 * 60 * 1000;
const pad = value => String(value).padStart(2, '0');

export function parseRecordingTime(value) {
  if (value instanceof Date || typeof value === 'number') {
    const result = Number(value);
    if (Number.isFinite(result) && !Number.isNaN(new Date(result).getTime())) return result;
  }
  if (typeof value === 'string') {
    const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (local) {
      const [, y, m, d, h, min, sec = '0'] = local;
      const time = Date.parse(`${y}-${m}-${d}T${h}:${min}:${pad(sec)}+09:00`);
      const check = new Date(time + KST_OFFSET);
      if (check.getUTCFullYear() === +y && check.getUTCMonth() + 1 === +m
        && check.getUTCDate() === +d && check.getUTCHours() === +h
        && check.getUTCMinutes() === +min && check.getUTCSeconds() === +sec) return time;
    } else if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      const time = Date.parse(value);
      if (Number.isFinite(time)) return time;
    }
  }
  throw new Error('원본 영상의 촬영 시작 날짜와 시간을 정확히 입력해 주세요.');
}

export function formatRecordingTime(baseDateTime, sourceSeconds = 0) {
  if (!Number.isFinite(sourceSeconds)) throw new Error('영상 시간이 올바르지 않습니다.');
  const date = new Date(parseRecordingTime(baseDateTime) + Math.floor(sourceSeconds * 1000 + 0.001) + KST_OFFSET);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** sourceSeconds is the position in the original file, never the trimmed timeline. */
export function drawWatermark(ctx, width, height, sourceSeconds, settings = {}) {
  if (settings.watermarkEnabled === false) return;
  const text = formatRecordingTime(settings.baseDateTime, sourceSeconds);
  const referenceSize = Number(settings.fontSize) || 32;
  let size = Math.max(1, referenceSize * height / 1080);
  const margin = Math.max(3, Math.min(width, height) * 0.025);
  ctx.save();
  ctx.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const available = width - margin * 2;
  if (ctx.measureText(text).width + size * 0.8 > available) {
    size *= available / (ctx.measureText(text).width + size * 0.8);
    ctx.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  }
  const padding = size * 0.4;
  const boxWidth = ctx.measureText(text).width + padding * 2;
  const boxHeight = size * 1.55;
  const position = settings.position || 'bottom-left';
  const x = position.endsWith('right') ? width - margin - boxWidth : margin;
  const y = position.startsWith('top') ? margin : height - margin - boxHeight;
  if (settings.background !== false && settings.background !== 'none') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(x, y, boxWidth, boxHeight);
  }
  ctx.fillStyle = settings.color || '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = Math.max(1, size * 0.12);
  ctx.fillText(text, x + padding, y + boxHeight / 2);
  ctx.restore();
}

function createCanvas(width, height) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('이 브라우저에서 영상 프레임을 처리할 수 없습니다.');
  return { canvas, ctx };
}

function assertFile(file) {
  if (!(file instanceof Blob) || file.size === 0) throw new Error('비어 있지 않은 영상 파일을 선택해 주세요.');
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('작업을 취소했습니다.', 'AbortError');
}

function requireVideoEncoding() {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    throw new Error('이 브라우저는 영상 내보내기를 지원하지 않습니다. 최신 Chrome 또는 Edge에서 HTTPS나 localhost로 열어 주세요.');
  }
}

async function readInfo(input) {
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('영상 트랙을 찾을 수 없습니다. MP4 영상 파일을 선택해 주세요.');
  const audio = await input.getPrimaryAudioTrack();
  const [duration, width, height, videoCodec, canDecode, audioCodec] = await Promise.all([
    track.computeDuration(), track.getDisplayWidth(), track.getDisplayHeight(),
    track.getCodec(), track.canDecode(), audio ? audio.getCodec() : null,
  ]);
  if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) {
    throw new Error('영상의 길이 또는 해상도를 읽을 수 없습니다. 파일이 완전한지 확인해 주세요.');
  }
  return { duration, width, height, videoCodec, canDecode, hasAudio: !!audio, audioCodec };
}

export async function inspectVideo(file) {
  assertFile(file);
  const { Input, BlobSource, ALL_FORMATS } = await getLibrary();
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    return await readInfo(input);
  } finally {
    input.dispose();
  }
}

function outputSize(info, quality) {
  const limit = quality === 'small' ? 720 : ['medium', 'balanced'].includes(quality) ? 1080 : Infinity;
  const scale = Math.min(1, limit / Math.min(info.width, info.height));
  return { width: Math.max(2, Math.round(info.width * scale / 2) * 2), height: Math.max(2, Math.round(info.height * scale / 2) * 2) };
}

/** Returns a completed MP4 Blob. Progress 1 is emitted only after finalization. */
export async function exportVideo(file, settings, { onProgress, signal } = {}) {
  assertFile(file);
  requireVideoEncoding();
  checkAbort(signal);
  const { Input, BlobSource, ALL_FORMATS, Output, Mp4OutputFormat, BufferTarget, Conversion, Quality, canEncodeVideo } = await getLibrary();
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  let conversion;
  let output;
  const cancel = () => { if (conversion) void conversion.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const info = await readInfo(input);
    checkAbort(signal);
    if (!info.canDecode) throw new Error(`이 브라우저에서 ${info.videoCodec || '이 영상'} 코덱을 읽을 수 없습니다. H.264 MP4 파일 또는 다른 브라우저를 사용해 주세요.`);
    const start = Number(settings.start ?? 0);
    const requestedEnd = Number(settings.end ?? info.duration);
    if (!Number.isFinite(start) || !Number.isFinite(requestedEnd) || start < 0 || requestedEnd <= start || requestedEnd > info.duration + 0.1) {
      throw new Error('저장 구간을 확인해 주세요. 시작은 0초 이상, 끝은 시작 이후이면서 영상 길이 이내여야 합니다.');
    }
    const end = Math.min(requestedEnd, info.duration);
    if (settings.watermarkEnabled !== false) parseRecordingTime(settings.baseDateTime);
    const dimensions = outputSize(info, settings.quality);
    const quality = new Quality(settings.quality === 'small' ? 'medium' : 'high');
    if (!await canEncodeVideo('avc', { ...dimensions, quality })) {
      throw new Error('이 기기에서 H.264 MP4 인코딩을 지원하지 않습니다. Chrome 또는 Edge를 사용하거나 720p 용량 절약 옵션을 선택해 주세요.');
    }
    checkAbort(signal);
    let render;
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    conversion = await Conversion.init({
      input, output, tracks: 'primary', trim: { start, end }, showWarnings: false,
      // Exact frame boundaries and upright, burned-in overlays in every player.
      video: {
        codec: 'avc', quality, ...dimensions, fit: 'contain',
        allowTransformationMetadata: false, forceTranscode: true, keyFrameInterval: 1,
        ...(settings.watermarkEnabled !== false ? { process(sample) {
          render ??= createCanvas(sample.displayWidth, sample.displayHeight);
          sample.draw(render.ctx, 0, 0);
          // Mediabunny shifts samples by -trim.start before invoking process.
          drawWatermark(render.ctx, render.canvas.width, render.canvas.height, start + sample.timestamp, settings);
          return render.canvas;
        } } : {}),
      },
      audio: settings.mute ? { discard: true } : { codec: 'aac' },
    });
    checkAbort(signal);
    const lost = conversion.discardedTracks.filter(item => item.reason !== 'discarded_by_user');
    if (!conversion.isValid || lost.length) {
      if (lost.some(item => item.track.type === 'audio')) {
        throw new Error('이 브라우저에서 원본 소리를 MP4로 저장할 수 없습니다. 다른 브라우저를 사용하거나 직접 ‘소리 제거’를 선택해 주세요.');
      }
      throw new Error('이 영상의 코덱을 MP4로 변환할 수 없습니다. H.264 영상 또는 최신 Chrome·Edge를 사용해 주세요.');
    }
    conversion.onProgress = progress => onProgress?.(Math.min(progress, 0.99));
    onProgress?.(0);
    await conversion.execute();
    checkAbort(signal);
    if (!output.target.buffer?.byteLength) throw new Error('내보낸 영상이 비어 있습니다. 다른 구간으로 다시 시도해 주세요.');
    const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
    onProgress?.(1);
    return blob;
  } catch (error) {
    if (conversion && conversion.state !== 'done') await conversion.cancel().catch(() => {});
    else if (output && output.state !== 'finalized') await output.cancel().catch(() => {});
    if (signal?.aborted || error?.name === 'ConversionCanceledError') throw new DOMException('작업을 취소했습니다.', 'AbortError');
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    input.dispose();
  }
}

export async function exportFrame(video, settings = {}) {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) throw new Error('영상 프레임을 먼저 불러와 주세요.');
  const { canvas, ctx } = createCanvas(video.videoWidth, video.videoHeight);
  ctx.drawImage(video, 0, 0);
  drawWatermark(ctx, canvas.width, canvas.height, video.currentTime, settings);
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('이미지 저장에 실패했습니다.')), 'image/png'));
}

function drawDemoFrame(ctx, width, height, time) {
  const horizon = height * 0.44;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#b8cfda'); sky.addColorStop(1, '#e5eceb');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, width, horizon);
  ctx.fillStyle = '#728878'; ctx.fillRect(0, horizon, width, height - horizon);
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < 9; i++) {
      const x = side ? width * 0.66 + i * width * 0.045 : i * width * 0.044;
      const h = height * (0.11 + (i % 3) * 0.042);
      ctx.fillStyle = ['#929f9e', '#afbab6', '#8c9a97'][i % 3];
      ctx.fillRect(x, horizon - h, width * 0.038, h);
      ctx.fillStyle = '#687e81';
      for (let row = 0; row < 4; row++) ctx.fillRect(x + 8, horizon - h + 12 + row * 21, 12, 8);
    }
  }
  ctx.fillStyle = '#42494a';
  ctx.beginPath(); ctx.moveTo(width * 0.43, horizon); ctx.lineTo(width * 0.57, horizon);
  ctx.lineTo(width * 0.97, height); ctx.lineTo(width * 0.03, height); ctx.fill();
  ctx.strokeStyle = '#edf0df'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(width * 0.43, horizon); ctx.lineTo(width * 0.03, height);
  ctx.moveTo(width * 0.57, horizon); ctx.lineTo(width * 0.97, height); ctx.stroke();
  ctx.fillStyle = '#e0e2d5';
  for (let i = 0; i < 12; i++) {
    const t = ((i / 12 + time * 0.16) % 1) ** 2;
    const y = horizon + (height - horizon) * t;
    const h = 3 + t * 42;
    for (const direction of [-1, 1]) {
      const x = width * 0.5 + direction * (8 + t * width * 0.15);
      ctx.fillRect(x, y, 2 + t * 6, h);
    }
  }
  const carX = width * (0.51 + Math.sin(time * 0.6) * 0.035);
  const carY = height * 0.62;
  ctx.fillStyle = '#253a42'; ctx.fillRect(carX - 43, carY - 28, 86, 55);
  ctx.fillStyle = '#b2c2c6'; ctx.fillRect(carX - 31, carY - 44, 62, 30);
  ctx.fillStyle = '#344a52'; ctx.fillRect(carX - 26, carY - 40, 52, 22);
  ctx.fillStyle = '#ed7560'; ctx.fillRect(carX - 38, carY + 8, 17, 8); ctx.fillRect(carX + 21, carY + 8, 17, 8);
  ctx.fillStyle = '#d9ddce'; ctx.fillRect(carX - 18, carY + 13, 36, 9);
  ctx.fillStyle = '#1b2426';
  ctx.beginPath(); ctx.ellipse(width * 0.5, height * 1.09, width * 0.4, height * 0.2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(20, 30, 34, .76)'; ctx.fillRect(24, 24, 315, 70);
  ctx.fillStyle = '#fff'; ctx.font = '600 22px sans-serif'; ctx.fillText('ROADPROOF · SAMPLE', 42, 53);
  ctx.font = '15px sans-serif'; ctx.fillText('편집 연습용 영상 · 실제 촬영 아님', 42, 78);
}

/** A synthetic clip for trying editing without uploading a personal recording. */
export async function makeDemoFile({ onProgress, signal } = {}) {
  requireVideoEncoding(); checkAbort(signal);
  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, Quality, canEncodeAudio, canEncodeVideo } = await getLibrary();
  const width = 1280, height = 720, frameRate = 24, duration = 12;
  if (!await canEncodeVideo('avc', { width, height })) throw new Error('이 브라우저에서 예시 영상을 만들 수 없습니다. MP4 파일을 직접 열어 주세요.');
  const { canvas, ctx } = createCanvas(width, height);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('medium'), keyFrameInterval: 1 });
  output.addVideoTrack(video, { frameRate });
  const audio = typeof AudioBuffer !== 'undefined' && await canEncodeAudio('aac', { numberOfChannels: 1, sampleRate: 48000 })
    ? new AudioBufferSource({ codec: 'aac', quality: new Quality({ bitrate: 64000 }) }) : null;
  if (audio) output.addAudioTrack(audio);
  const cancel = () => { void output.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    checkAbort(signal); await output.start();
    if (audio) {
      const buffer = new AudioBuffer({ numberOfChannels: 1, sampleRate: 48000, length: duration * 48000 });
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i++) {
        const t = i / 48000;
        channel[i] = 0.012 * Math.sin(2 * Math.PI * 90 * t) + ((t % 3) < 0.12 ? 0.04 * Math.sin(2 * Math.PI * 660 * t) : 0);
      }
      await audio.add(buffer); audio.close();
    }
    for (let frame = 0; frame < frameRate * duration; frame++) {
      checkAbort(signal);
      drawDemoFrame(ctx, width, height, frame / frameRate);
      await video.add(frame / frameRate, 1 / frameRate);
      onProgress?.(Math.min(0.99, (frame + 1) / (frameRate * duration)));
      if (frame % 24 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    video.close(); await output.finalize(); checkAbort(signal);
    onProgress?.(1);
    return new File([output.target.buffer], 'roadproof-sample.mp4', { type: 'video/mp4' });
  } catch (error) {
    await output.cancel().catch(() => {});
    if (signal?.aborted) throw new DOMException('작업을 취소했습니다.', 'AbortError');
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
