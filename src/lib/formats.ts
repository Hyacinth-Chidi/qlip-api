import type { YtDlpFormat, YtDlpInfo } from './ytdlp.js';

export interface QualityOption {
  id: string; // format_id to pass back on /download
  label: string; // e.g. "1080p (Full HD)"
  ext: string;
  approxSizeBytes: number | null;
  kind: 'video' | 'audio';
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
  // Lowest-bitrate variant per height. Sites publish several encodes of the
  // same resolution, and the cheapest is often 6-8x smaller than the richest
  // while still looking fine — that's what the "Compact" tier uses, with no
  // server-side re-encoding.
  const leanByHeight = new Map<number, YtDlpFormat>();
  let bestAudio: YtDlpFormat | null = null;
  let leanAudio: YtDlpFormat | null = null;

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

      const lean = leanByHeight.get(height);
      if (f.tbr && (!lean?.tbr || f.tbr < lean.tbr)) {
        leanByHeight.set(height, f);
      }
    } else if (f.acodec && f.acodec !== 'none') {
      if (!bestAudio || (f.tbr ?? 0) > (bestAudio.tbr ?? 0)) bestAudio = f;
      if (f.tbr && (!leanAudio?.tbr || f.tbr < leanAudio.tbr)) leanAudio = f;
    }
  }

  // Three video choices rather than every resolution the source offers: a
  // long list of near-identical options is harder to choose from than one
  // per meaningful tier. Each tier takes the best format within its band, so
  // a source without 4K simply yields fewer options instead of a bad match.
  const heights = [...byHeight.keys()].sort((a, b) => b - a);

  const pickInBand = (min: number, max: number): number | undefined =>
    heights.find((h) => h >= min && h <= max);

  // HD caps at 1080p: it's the middle "good quality" choice, so letting it
  // resolve to 1440p would put it within a hair of the 4K option's size.
  const tiers: { label: string; height: number | undefined }[] = [
    { label: '4K', height: pickInBand(2160, Infinity) },
    // Falls back into 1081–2159 only when nothing at/below 1080p exists, so a
    // 1440p-only source still offers an HD choice.
    { label: 'HD', height: pickInBand(720, 1080) ?? pickInBand(1081, 2159) },
    { label: 'SD', height: pickInBand(0, 719) },
  ];

  const options: QualityOption[] = tiers
    .filter((t): t is { label: string; height: number } => t.height !== undefined)
    .map(({ label, height }) => {
      const f = byHeight.get(height)!;
      return {
        id:
          f.acodec && f.acodec !== 'none'
            ? f.format_id
            : bestAudio
              ? `${f.format_id}+${bestAudio.format_id}`
              : f.format_id,
        label: `${label} (${height}p)`,
        ext: f.ext,
        approxSizeBytes: estimateSize(f, info.duration),
        kind: 'video' as const,
      };
    });

  // Compact: the cheapest encode of a still-watchable resolution, paired with
  // the leanest audio so the saving isn't spent on the audio track. This
  // selects a different source stream rather than re-encoding, so it stays a
  // pure pass-through and nothing is written on the server. Offered only when
  // meaningfully smaller than SD, otherwise it's a confusing near-duplicate.
  const compactHeight =
    heights.find((h) => h >= 360 && h <= 480) ?? heights.find((h) => h <= 359);
  const compactFormat = compactHeight ? leanByHeight.get(compactHeight) : undefined;

  if (compactFormat && compactHeight) {
    const compactAudio = leanAudio ?? bestAudio;
    const hasOwnAudio = compactFormat.acodec && compactFormat.acodec !== 'none';
    const videoBytes = estimateSize(compactFormat, info.duration);
    const audioBytes = hasOwnAudio
      ? 0
      : (compactAudio ? estimateSize(compactAudio, info.duration) : 0) ?? 0;
    const totalBytes = videoBytes === null ? null : videoBytes + audioBytes;

    // Compare against video options only — the audio-only entry is a
    // different kind of choice and would skew the threshold.
    const smallestExisting = options
      .filter((o) => o.kind === 'video')
      .map((o) => o.approxSizeBytes)
      .filter((b): b is number => b !== null)
      .sort((a, b) => a - b)[0];

    const worthOffering =
      totalBytes === null ||
      smallestExisting === undefined ||
      totalBytes < smallestExisting * 0.7;

    if (worthOffering) {
      options.push({
        id: hasOwnAudio
          ? compactFormat.format_id
          : compactAudio
            ? `${compactFormat.format_id}+${compactAudio.format_id}`
            : compactFormat.format_id,
        label: `Compact (${compactHeight}p)`,
        ext: compactFormat.ext,
        approxSizeBytes: totalBytes,
        kind: 'video',
      });
    }
  }

  if (bestAudio) {
    options.push({
      id: bestAudio.format_id,
      label: 'Audio only',
      ext: bestAudio.ext,
      approxSizeBytes: estimateSize(bestAudio, info.duration),
      kind: 'audio',
    });
  }

  return options;
}
