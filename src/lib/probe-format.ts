import { spawn } from 'node:child_process';
import {
  isPlaylist,
  proxyFor,
  type YtDlpFormat,
  type YtDlpInfo,
  type YtDlpPlaylist,
} from './ytdlp.js';

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'gif']);

interface Probed {
  width?: number;
  height?: number;
  vcodec: string;
  acodec: string;
}

/** Reads the codecs and dimensions of a media url from its headers. */
function ffprobe(
  url: string,
  headers: Record<string, string>,
  proxy: string | null,
  timeoutMs = 4000
): Promise<Probed | null> {
  const hdr = Object.entries(headers);
  const args = [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,width,height',
    '-of', 'json',
    ...(hdr.length ? ['-headers', hdr.map(([k, v]) => `${k}: ${v}\r\n`).join('')] : []),
    ...(proxy ? ['-http_proxy', proxy] : []),
    url,
  ];

  return new Promise((resolve) => {
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const streams: Array<Record<string, unknown>> = JSON.parse(out).streams ?? [];
        const video = streams.find((s) => s.codec_type === 'video');
        const audio = streams.find((s) => s.codec_type === 'audio');
        if (!video && !audio) return resolve(null);
        resolve({
          width: video?.width as number | undefined,
          height: video?.height as number | undefined,
          // 'none' is yt-dlp's own marker for an absent stream, so a file
          // without audio is correctly paired with an audio track later.
          vcodec: (video?.codec_name as string | undefined) ?? 'none',
          acodec: (audio?.codec_name as string | undefined) ?? 'none',
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * A plain file yt-dlp described with nothing at all — no size, no codecs —
 * sitting among formats it did describe.
 *
 * That is Instagram's shape: the DASH tracks are fully labelled (and all
 * VP9), while its complete MP4s come through as bare ids "1", "2", "3".
 * Those MP4s are H.264 + AAC with the audio already in, the only Instagram
 * files WhatsApp accepts, and without a size the quality builder skipped
 * them, so every download was VP9 — "unsupported format" in WhatsApp.
 *
 * Requiring labelled siblings keeps this off sites that label nothing
 * (Facebook), whose formats have their own handling.
 */
function unlabelled(formats: YtDlpFormat[]): YtDlpFormat[] {
  if (!formats.some((f) => f.height || f.width)) return [];
  return formats.filter(
    (f) =>
      f.url &&
      (f.protocol === 'https' || f.protocol === 'http') &&
      !f.height &&
      !f.width &&
      !f.vcodec &&
      !f.acodec &&
      !IMAGE_EXTS.has((f.ext ?? '').toLowerCase())
  );
}

/**
 * Fills in codecs and dimensions for unlabelled formats by probing them,
 * mutating the info in place so a cached extraction keeps the result.
 *
 * Runs the probes in parallel; each reads only the file's header, which for
 * Instagram's faststart MP4s is a few hundred milliseconds. A probe that
 * fails leaves its format untouched, exactly as it was before.
 */
export async function fillUnlabelledFormats(
  sourceUrl: string,
  info: YtDlpInfo | YtDlpPlaylist
): Promise<number> {
  const infos = isPlaylist(info)
    ? (info.entries ?? []).filter((e): e is YtDlpInfo => Boolean(e?.formats))
    : [info];
  const targets = infos.flatMap((i) => unlabelled(i.formats)).slice(0, 12);
  if (targets.length === 0) return 0;

  const proxy = proxyFor(sourceUrl);
  const results = await Promise.all(
    targets.map((f) => ffprobe(f.url!, f.http_headers ?? {}, proxy))
  );

  let filled = 0;
  results.forEach((p, i) => {
    if (!p) return;
    const f = targets[i];
    f.width = p.width;
    f.height = p.height;
    f.vcodec = p.vcodec;
    f.acodec = p.acodec;
    filled++;
  });
  return filled;
}
