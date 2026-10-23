import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lookupTarget } from './direct-stream.js';
import { proxyFor, type TempDownload } from './ytdlp.js';

/**
 * Muxes a DASH video+audio pair straight from the CDN, without yt-dlp.
 *
 * The assemble path used to hand the page URL to yt-dlp, which re-fetched and
 * re-parsed it before downloading a byte — about 4.5s of rework on every
 * download. Extraction already resolved both component URLs and cached them,
 * so ffmpeg can read them directly: a 2.1 MB reel that took 9.3s this way
 * spends almost all of it waiting on that redundant page fetch.
 *
 * Returns null when this isn't a two-part format or either URL is missing
 * from the cache, so the caller falls back to yt-dlp unchanged.
 */
export function cachedAssembleParts(
  sourceUrl: string,
  formatId: string
): { video: string; audio: string; headers: Record<string, string> } | null {
  const ids = formatId.split('+');
  if (ids.length !== 2) return null;

  const [video, audio] = ids.map((id) => lookupTarget(sourceUrl, id));
  if (!video || !audio) return null;

  // Both parts come from the same extraction, so their headers match; the
  // CDN rejects the request without the site's Referer/User-Agent.
  return { video: video.url, audio: audio.url, headers: video.headers };
}

/** Renders ffmpeg's `-headers` argument: CRLF-separated, trailing CRLF. */
function headerArg(headers: Record<string, string>): string[] {
  const entries = Object.entries(headers);
  if (entries.length === 0) return [];
  return ['-headers', entries.map(([k, v]) => `${k}: ${v}\r\n`).join('')];
}

/**
 * Streams both parts into a faststart MP4.
 *
 * `-c copy` means no re-encoding: this is a container remux, so it costs
 * roughly what the bytes take to transfer. The headers have to be repeated
 * before each input — ffmpeg applies them to the next `-i` only.
 */
export async function assembleFromCache(
  sourceUrl: string,
  parts: { video: string; audio: string; headers: Record<string, string> },
  timeoutMs = 120_000
): Promise<TempDownload> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qlip-fast-'));
  const filePath = path.join(dir, 'media.mp4');
  const cleanup = () => rm(dir, { recursive: true, force: true });

  const hdr = headerArg(parts.headers);
  const args = [
    '-nostdin',
    '-loglevel', 'error',
    // Let a transient CDN hiccup retry rather than failing the download.
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    ...hdr, '-i', parts.video,
    ...hdr, '-i', parts.audio,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c', 'copy',
    // Index at the front so the phone can play before the transfer finishes.
    '-movflags', '+faststart',
    '-y', filePath,
  ];

  // Google signs its media urls to the IP that requested them, so a url
  // yt-dlp resolved through WARP returns 403 when ffmpeg fetches it directly
  // from the server's own IP. ffmpeg has no --proxy flag; it reads the
  // standard proxy environment variables instead.
  const proxy = proxyFor(sourceUrl);
  const env = proxy
    ? { ...process.env, http_proxy: proxy, https_proxy: proxy }
    : process.env;

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env,
      });
      let err = '';
      child.stderr.on('data', (c) => (err += c));

      // A hung CDN read would otherwise keep the request open indefinitely.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`ffmpeg assemble timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Failed to start ffmpeg: ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 400)}`));
      });
    });

    const { size } = await stat(filePath);
    // A zero-byte result means ffmpeg "succeeded" on nothing usable; treat it
    // as a failure so the caller falls back rather than serving an empty file.
    if (size === 0) throw new Error('ffmpeg produced an empty file');

    return { filePath, sizeBytes: size, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Muxes both parts straight to a stream, so bytes reach the phone as they
 * arrive instead of after the whole file is built.
 *
 * A normal MP4 puts its index at the end, and `+faststart` moves it to the
 * front with a second pass — neither can start before the mux finishes. For a
 * 600 MB YouTube download at the measured ~4.8 MB/s that is about two minutes
 * during which the browser shows nothing at all, which reads as a hang.
 *
 * A fragmented MP4 carries its index per fragment, so it is valid from the
 * first byte and plays in browsers, on iOS and on Android. Two costs come
 * with it: the file is a few percent larger, and there is no Content-Length
 * up front, so the progress bar has no total. Starting immediately is the
 * better trade for a large file.
 *
 * Returns the ffmpeg stdout stream plus a kill handle; the caller pipes it.
 */
export function streamFromCache(
  sourceUrl: string,
  parts: { video: string; audio: string; headers: Record<string, string> }
): { stream: Readable; done: Promise<void>; kill: () => void } {
  const hdr = headerArg(parts.headers);
  const args = [
    '-nostdin',
    '-loglevel', 'error',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    ...hdr, '-i', parts.video,
    ...hdr, '-i', parts.audio,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c', 'copy',
    // empty_moov makes the file valid before any media is written;
    // frag_keyframe starts a new fragment at each keyframe; and
    // default_base_moof is what Safari and Chrome expect for playback.
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    // The container has to be named explicitly: a pipe has no extension to
    // infer it from.
    '-f', 'mp4',
    'pipe:1',
  ];

  const proxy = proxyFor(sourceUrl);
  const child = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: proxy
      ? { ...process.env, http_proxy: proxy, https_proxy: proxy }
      : process.env,
  });

  let err = '';
  child.stderr.on('data', (c) => (err += c));

  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) =>
      reject(new Error(`Failed to start ffmpeg: ${e.message}`))
    );
    child.on('close', (code) => {
      // 255 is ffmpeg's exit code when it is killed, which is what happens
      // whenever the phone disconnects early — not an error worth reporting.
      if (code === 0 || code === 255) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 400)}`));
    });
  });

  return {
    stream: child.stdout!,
    done,
    kill: () => child.kill('SIGKILL'),
  };
}

/**
 * Whether the video part is larger than `limit` bytes.
 *
 * Decides between streaming and the temp-file path, so it must be cheap and
 * must never block the download: anything unexpected returns false, which
 * keeps the existing temp-file behaviour.
 *
 * Uses curl rather than fetch because the request has to take the same route
 * the media will — the CDN signs urls to the requesting IP — and curl accepts
 * the proxy directly. Only the video part is measured; the audio track is a
 * small fraction of the total and the threshold does not need to be exact.
 */
export async function partsExceed(
  sourceUrl: string,
  parts: { video: string; audio: string; headers: Record<string, string> },
  limit: number,
  timeoutMs = 4000
): Promise<boolean> {
  const proxy = proxyFor(sourceUrl);
  const args = [
    '-s', '-o', '/dev/null',
    '-w', '%{size_download}',
    // A ranged GET of one byte: some CDNs refuse HEAD but always answer this,
    // and Content-Range carries the full length.
    '-r', '0-0',
    '-D', '-',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    ...Object.entries(parts.headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]),
    ...(proxy ? ['-x', proxy] : []),
    parts.video,
  ];

  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      child.stdout.on('data', (c) => (buf += c));
      child.on('error', reject);
      child.on('close', () => resolve(buf));
    });

    // "Content-Range: bytes 0-0/12345678" — the total is after the slash.
    const m = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(out);
    if (!m) return false;
    return Number(m[1]) > limit;
  } catch {
    return false;
  }
}
