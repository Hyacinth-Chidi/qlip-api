import type { YtDlpFormat, YtDlpInfo } from './ytdlp.js';

export interface QualityOption {
  id: string; // format_id to pass back on /download
  label: string; // e.g. "1080p (Full HD)"
  ext: string;
  approxSizeBytes: number | null;
  kind: 'video' | 'audio' | 'image';
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'gif']);

/**
 * Image posts have no video or audio codec, so the tiered video logic below
 * finds nothing. Pick the largest available image instead.
 */
function buildImageOptions(info: YtDlpInfo): QualityOption[] {
  const images = info.formats.filter(
    (f) =>
      (!f.vcodec || f.vcodec === 'none') &&
      (!f.acodec || f.acodec === 'none') &&
      IMAGE_EXTS.has(f.ext?.toLowerCase())
  );
  if (images.length === 0) return [];

  const best = images.reduce((a, b) => {
    const areaA = (a.height ?? 0) * (Number(a.resolution?.split('x')[0]) || 1);
    const areaB = (b.height ?? 0) * (Number(b.resolution?.split('x')[0]) || 1);
    if (areaA || areaB) return areaB > areaA ? b : a;
    return (b.filesize ?? 0) > (a.filesize ?? 0) ? b : a;
  });

  return [
    {
      id: best.format_id,
      label: best.height ? `Image (${best.height}p)` : 'Image',
      ext: best.ext,
      approxSizeBytes: estimateSize(best),
      kind: 'image',
    },
  ];
}

/**
 * The dimension that describes a format's quality. People say "1080p" for
 * both a 1920x1080 landscape video and a 1080x1920 vertical one, so this is
 * the *shorter* side — using height alone would label a portrait Reel as
 * "4K (2560p)" when it's really 1440p.
 */
function qualityHeight(f: YtDlpFormat): number {
  const [resW, resH] = (f.resolution ?? '').split('x').map(Number);
  const width = f.width ?? (Number.isFinite(resW) ? resW : 0);
  const height = f.height ?? (Number.isFinite(resH) ? resH : 0);
  if (!height) return 0;
  return width && width < height ? width : height;
}

/**
 * Fallback for sites that report no dimensions at all — Facebook labels its
 * formats "sd"/"hd" with no width, height or resolution. Without this the
 * tier logic skips every format and the post looks undownloadable.
 */
function buildUnsizedOptions(
  videos: YtDlpFormat[],
  bestAudio: YtDlpFormat | null,
  info: YtDlpInfo
): QualityOption[] {
  const prettify = (f: YtDlpFormat): string => {
    const id = (f.format_id ?? '').toLowerCase();
    if (id === 'hd' || /\bhd\b/.test(id)) return 'HD';
    if (id === 'sd' || /\bsd\b/.test(id)) return 'SD';
    return f.format_note || f.format_id || 'Video';
  };

  // Best first, like the tiered list. Bitrate decides when it's reported;
  // otherwise fall back to the quality implied by the format name, since
  // Facebook gives literally nothing else to rank by.
  const rank = (f: YtDlpFormat): number => {
    if (f.tbr) return f.tbr;
    const id = (f.format_id ?? '').toLowerCase();
    if (/\bhd\b/.test(id)) return 2;
    if (/\bsd\b/.test(id)) return 1;
    return 0;
  };
  const sorted = [...videos].sort((a, b) => rank(b) - rank(a));

  return sorted.map((f) => {
    const merged = !hasAudio(f) && Boolean(bestAudio);
    return {
      id: merged ? `${f.format_id}+${bestAudio!.format_id}` : f.format_id,
      label: prettify(f),
      ext: merged ? 'mp4' : f.ext,
      approxSizeBytes: estimateSize(f, info.duration),
      kind: 'video' as const,
    };
  });
}

/**
 * Codec fields are three-valued: a codec name, the string 'none' meaning the
 * stream is absent, or undefined meaning yt-dlp didn't report it. X/Twitter's
 * complete progressive MP4s leave both undefined, so treating undefined as
 * "absent" would classify a file that has sound as video-only and download it
 * silently. Unknown therefore means "assume present".
 */
function hasVideo(f: YtDlpFormat): boolean {
  return f.vcodec !== 'none';
}

function hasAudio(f: YtDlpFormat): boolean {
  return f.acodec !== 'none';
}

/** Audio-only: no video stream, but an audio one (known or unreported). */
function isAudioOnly(f: YtDlpFormat): boolean {
  return f.vcodec === 'none' && f.acodec !== 'none';
}

/**
 * A plain HTTP file rather than a streaming manifest. HLS/DASH have to be
 * reassembled by ffmpeg, which is fragile when the output is a pipe.
 */
function isProgressive(f: YtDlpFormat): boolean {
  return f.protocol === 'https' || f.protocol === 'http';
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
  // Image posts (carousel slides) carry no video/audio streams at all.
  const hasPlayableStream = info.formats.some(
    (f) => f.vcodec !== 'none' || f.acodec !== 'none'
  );
  if (!hasPlayableStream) return buildImageOptions(info);

  const byHeight = new Map<number, YtDlpFormat>();
  // Lowest-bitrate variant per height. Sites publish several encodes of the
  // same resolution, and the cheapest is often 6-8x smaller than the richest
  // while still looking fine — that's what the "Compact" tier uses, with no
  // server-side re-encoding.
  const leanByHeight = new Map<number, YtDlpFormat>();
  let bestAudio: YtDlpFormat | null = null;
  let leanAudio: YtDlpFormat | null = null;

  // Ranks a candidate for its resolution tier. Self-contained formats win
  // (no mux step, and they always have sound), and among equals a direct
  // progressive download beats HLS — streaming HLS to stdout is unreliable
  // and produced empty files on X.
  const score = (f: YtDlpFormat): number =>
    (hasAudio(f) ? 2 : 0) + (isProgressive(f) ? 1 : 0);

  for (const f of info.formats) {
    if (hasVideo(f)) {
      const height = qualityHeight(f);
      if (!height) continue;
      const existing = byHeight.get(height);
      if (!existing || score(f) > score(existing)) {
        byHeight.set(height, f);
      }

      // Compact tracks the cheapest encode, but never trades away a
      // progressive URL for an HLS one — a smaller file that won't download
      // is no saving.
      const lean = leanByHeight.get(height);
      const leanOk =
        !lean ||
        (isProgressive(f) === isProgressive(lean)
          ? (f.tbr ?? Infinity) < (lean.tbr ?? Infinity)
          : isProgressive(f));
      if (f.tbr && leanOk) {
        leanByHeight.set(height, f);
      }
    } else if (isAudioOnly(f)) {
      if (!bestAudio || (f.tbr ?? 0) > (bestAudio.tbr ?? 0)) bestAudio = f;
      if (f.tbr && (!leanAudio?.tbr || f.tbr < leanAudio.tbr)) leanAudio = f;
    }
  }

  // Some sites (Facebook) report no dimensions on any format, so nothing
  // landed in the tier map. Fall back to listing what's actually on offer.
  if (byHeight.size === 0) {
    const videos = info.formats.filter(hasVideo);
    if (videos.length > 0) {
      const options = buildUnsizedOptions(videos, bestAudio, info);
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
  const hd = pickInBand(720, 1080) ?? pickInBand(1081, 2159);
  // SD prefers a genuinely watchable small size (360-719). Only when nothing
  // sits in that range does it fall back to the smallest rung available —
  // that covers vertical video whose lowest option is 720p, without picking
  // 144p on a source that offers a full ladder.
  const sd =
    pickInBand(360, 719) ??
    (heights[heights.length - 1] !== hd ? heights[heights.length - 1] : undefined);
  const tiers: { label: string; height: number | undefined }[] = [
    { label: '4K', height: pickInBand(2160, Infinity) },
    { label: 'HD', height: hd },
    { label: 'SD', height: sd !== hd ? sd : undefined },
  ];

  const options: QualityOption[] = tiers
    .filter((t): t is { label: string; height: number } => t.height !== undefined)
    .map(({ label, height }) => {
      const f = byHeight.get(height)!;
      const merged = !hasAudio(f) && Boolean(bestAudio);
      return {
        id: merged ? `${f.format_id}+${bestAudio!.format_id}` : f.format_id,
        label: `${label} (${height}p)`,
        // Merged streams are always muxed to MP4 by the download route,
        // whatever container the source video came in.
        ext: merged ? 'mp4' : f.ext,
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
    const hasOwnAudio = hasAudio(compactFormat);
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
      const merged = !hasOwnAudio && Boolean(compactAudio);
      options.push({
        id: merged
          ? `${compactFormat.format_id}+${compactAudio!.format_id}`
          : compactFormat.format_id,
        label: `Compact (${compactHeight}p)`,
        ext: merged ? 'mp4' : compactFormat.ext,
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
