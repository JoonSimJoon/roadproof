export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function formatTime(seconds, precise = false) {
  if (!Number.isFinite(seconds)) return '00:00';
  const units = Math.max(0, Math.round(seconds * (precise ? 10 : 1)));
  const whole = precise ? Math.floor(units / 10) : units;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const text = `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return precise ? `${text}.${units % 10}` : text;
}

export function parseTime(text) {
  const parts = String(text).trim().split(':');
  if (!parts.length || parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  if (parts.slice(0, -1).some(p => p.includes('.'))) return NaN;
  if (parts.length > 1 && Number(parts.at(-1)) >= 60) return NaN;
  if (parts.length === 3 && Number(parts[1]) >= 60) return NaN;
  return parts.reduce((value, part) => value * 60 + Number(part), 0);
}

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function presetRange(current, duration, seconds) {
  const length = Math.min(seconds, duration);
  const start = clamp(current - length / 3, 0, duration - length);
  return { start, end: start + length };
}

export function downloadName(fileName, start, end, extension = 'mp4') {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  const stamp = time => formatTime(time, true).replaceAll(':', '-');
  return `${base}_편집_${stamp(start)}_${stamp(end)}.${extension}`;
}
