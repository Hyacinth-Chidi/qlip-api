import type { YtDlpFormat, YtDlpInfo } from './ytdlp.js';

export interface QualityOption {
  id: string; // format_id to pass back on /download
  label: string; // e.g. "1080p (Full HD)"
  ext: string;
  approxSizeBytes: number | null;
  kind: 'video' | 'audio';
}

function humanQualityLabel(f: YtDlpFormat): string {
  if (f.vcodec === 'none') {
    return `Audio only (${f.ext.toUpperCase()})`;
  }
  const height = f.height ?? Number(f.resolution?.split('x')[1]);
  if (!height) return f.format_note ?? f.format_id;
  if (height >= 4320) return `${height}p (8K)`;
  if (height >= 2160) return `${height}p (4K)`;
  if (height >= 1440) return `${height}p (2K)`;
  if (height >= 1080) return `${height}p (Full HD)`;
  if (height >= 720) return `${height}p (HD)`;
  if (height >= 360) return `${height}p (SD)`;
  return `${height}p (Low)`;
}

function estimateSize(f: YtDlpFormat, durationSec?: number): number | null {
  if (f.filesize) return f.filesize;
  if (f.filesize_approx) return f.filesize_approx;
  if (f.tbr && durationSec) return Math.round((f.tbr * 1000 * durationSec) / 8);
  return null;
}

/**
 * Collapses yt-dlp's raw (often huge, split video/audio) format list into a
 * short list of user-facing quality choices, picking one representative
 * format per resolution tier and preferring formats that already include
 * audio to avoid a mux step where possible.
 */
export function buildQualityOptions(info: YtDlpInfo): QualityOption[] {
  const byHeight = new Map<number, YtDlpFormat>();
  let bestAudio: YtDlpFormat | null = null;

  for (const f of info.formats) {
    if (f.vcodec && f.vcodec !== 'none') {
      const height = f.height ?? Number(f.resolution?.split('x')[1]) ?? 0;
      if (!height) continue;
      const existing = byHeight.get(height);
      const hasAudio = f.acodec && f.acodec !== 'none';
      const existingHasAudio = existing?.acodec && existing.acodec !== 'none';
      // Prefer progressive (video+audio) formats over video-only at the same height.
      if (!existing || (hasAudio && !existingHasAudio)) {
        byHeight.set(height, f);
      }
    } else if (f.acodec && f.acodec !== 'none') {
      if (!bestAudio || (f.tbr ?? 0) > (bestAudio.tbr ?? 0)) bestAudio = f;
    }
  }

  const options: QualityOption[] = [...byHeight.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, f]) => ({
      id:
        f.acodec && f.acodec !== 'none'
          ? f.format_id
          : bestAudio
            ? `${f.format_id}+${bestAudio.format_id}`
            : f.format_id,
      label: humanQualityLabel(f),
      ext: f.ext,
      approxSizeBytes: estimateSize(f, info.duration),
      kind: 'video' as const,
    }));

  if (bestAudio) {
    options.push({
      id: bestAudio.format_id,
      label: humanQualityLabel(bestAudio),
      ext: bestAudio.ext,
      approxSizeBytes: estimateSize(bestAudio, info.duration),
      kind: 'audio',
    });
  }

  return options;
}
