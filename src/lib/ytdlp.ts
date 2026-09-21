import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const BIN_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const LOCAL_BIN = path.join(REPO_ROOT, 'bin', BIN_NAME);
const COOKIES_FILE = path.join(REPO_ROOT, 'cookies', 'youtube.txt');
const PLUGIN_DIR = path.join(REPO_ROOT, 'plugins');
const JS_RUNTIME = process.env.YTDLP_JS_RUNTIME ?? 'node';
/**
 * Parallel fragment downloads per request. Higher isn't automatically better:
 * it multiplies per-request load on a shared VPS and can trip rate limiting.
 * 4 is a safe default; tune with YTDLP_CONCURRENT_FRAGMENTS.
 */
const CONCURRENT_FRAGMENTS = Number(process.env.YTDLP_CONCURRENT_FRAGMENTS ?? 4);

/**
 * YouTube player clients to try, highest quality first.
 *
 * From a datacenter IP the default `web` client is refused outright ("Sign in
 * to confirm you're not a bot") — and because that happens on the initial
 * player request, a PO token can't help: tokens authorise the media URLs,
 * which are never reached. Listing alternates lets yt-dlp fall through to one
 * the IP isn't blocked on. Override with YTDLP_YOUTUBE_CLIENTS (comma list),
 * or set it empty to restore yt-dlp's own default.
 */
const YOUTUBE_CLIENTS =
  process.env.YTDLP_YOUTUBE_CLIENTS ?? 'tv_simply,web_embedded,android_vr,default';

/**
 * Resolves which yt-dlp executable to invoke. Prefers the pinned binary in
 * ./bin (managed by scripts/update-ytdlp.sh) so updates never depend on a
 * system-wide install drifting out from under the server.
 */
export function resolveYtDlpBin(): string {
  if (existsSync(LOCAL_BIN)) return LOCAL_BIN;
  return BIN_NAME; // fall back to PATH (e.g. local dev via `pip install yt-dlp` / brew)
}

/**
 * Sites like YouTube block requests from datacenter IPs with "Sign in to
 * confirm you're not a bot" unless a real logged-in session's cookies are
 * attached. If ./cookies/youtube.txt exists (exported from a browser, never
 * committed to git), pass it along; otherwise omit the flag entirely so
 * sites that don't need cookies keep working without one.
 */
function cookieArgs(): string[] {
  return existsSync(COOKIES_FILE) ? ['--cookies', COOKIES_FILE] : [];
}

/**
 * Args every yt-dlp invocation needs for YouTube to work from a server:
 *
 * - `--js-runtimes`: yt-dlp must run JavaScript to solve YouTube's signature
 *   challenges, but only `deno` is enabled out of the box. The VPS has Node,
 *   so opt it in explicitly — without this, YouTube extraction fails even
 *   when the bot check passes.
 * - `--plugin-dirs`: loads the bgutil PO-token plugin from ./plugins (installed
 *   by scripts/setup.sh). It talks to the `qlip-pot` PM2 process on
 *   127.0.0.1:4416 to mint the "proof of origin" tokens YouTube needs for
 *   media URLs. Note this does NOT bypass the bot check on the initial player
 *   request — see YOUTUBE_CLIENTS for that.
 * - `--extractor-args`: the player-client fallback order (YOUTUBE_CLIENTS).
 */
function commonArgs(): string[] {
  const args = ['--no-warnings', '--js-runtimes', JS_RUNTIME];
  if (existsSync(PLUGIN_DIR)) args.push('--plugin-dirs', PLUGIN_DIR);
  if (YOUTUBE_CLIENTS.trim()) {
    args.push('--extractor-args', `youtube:player_client=${YOUTUBE_CLIENTS}`);
  }
  return [...args, ...cookieArgs()];
}

let ffmpegAvailable: boolean | null = null;

/** Checks once (then caches) whether ffmpeg is on PATH. */

export async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  const result = await new Promise<boolean>((resolve) => {
    const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  ffmpegAvailable = result;
  return result;
}

export class YtDlpError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = 'YtDlpError';
  }
}

function runCapture(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = resolveYtDlpBin();
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (err) => {
      reject(new YtDlpError(`Failed to start yt-dlp: ${err.message}`, stderr));
    });

    child.on('close', (code) => {
      // With --ignore-errors yt-dlp exits non-zero when any item failed, even
      // though the items that succeeded are on stdout. Trust the output when
      // there is some, and let the caller decide whether it's usable.
      if (code !== 0 && !stdout.trim()) {
        reject(new YtDlpError(`yt-dlp exited with code ${code}`, stderr));
        return;
      }
      resolve(stdout);
    });
  });
}

export interface YtDlpFormat {
  format_id: string;
  ext: string;
  resolution?: string;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number | null;
  filesize_approx?: number | null;
  tbr?: number | null; // total bitrate, kbps — used to estimate size when filesize is absent
  format_note?: string;
  /** 'https'/'http' for a direct file; 'm3u8_native'/'dash' for manifests. */
  protocol?: string;
  /** Direct media URL, present for progressive formats. */
  url?: string;
}

/**
 * `-J` returns a playlist wrapper when a URL holds several items (an
 * Instagram/TikTok image carousel, for example) and a plain info object
 * otherwise, so one call covers both shapes.
 */
export interface YtDlpPlaylist {
  _type: 'playlist';
  id: string;
  title: string;
  webpage_url: string;
  extractor_key: string;
  entries: YtDlpInfo[];
}

export interface YtDlpInfo {
  id: string;
  title: string;
  thumbnail?: string;
  duration?: number; // seconds
  webpage_url: string;
  extractor_key: string;
  formats: YtDlpFormat[];
}

/**
 * Extracts metadata without downloading. Uses `-J` with playlists allowed so
 * multi-item posts (image carousels) come back as a playlist of entries;
 * single media still comes back as one info object.
 */
export async function extractInfo(
  url: string
): Promise<YtDlpInfo | YtDlpPlaylist> {
  const stdout = await runCapture([
    '-J',
    '--yes-playlist',
    // Carousels are small; this caps pathological cases like a whole profile.
    '--playlist-end',
    '50',
    // A mixed post (videos + photos) errors on each photo slide, since
    // yt-dlp finds no formats for them. Without this the whole extraction
    // fails and the usable videos are lost too.
    '--ignore-errors',
    ...commonArgs(),
    url,
  ]);
  return JSON.parse(stdout) as YtDlpInfo | YtDlpPlaylist;
}

export function isPlaylist(
  info: YtDlpInfo | YtDlpPlaylist
): info is YtDlpPlaylist {
  return (info as YtDlpPlaylist)._type === 'playlist';
}

export interface DownloadHandle {
  /** Readable stream of the requested media, already muxed if necessary. */
  stream: NodeJS.ReadableStream;
  /** Resolves once the underlying process exits; rejects on non-zero exit. */
  done: Promise<void>;
  /** Kills the yt-dlp process (e.g. if the client disconnects mid-stream). */
  kill: () => void;
}

/**
 * Whether producing this format involves ffmpeg: either two streams to merge
 * ("137+140") or a manifest (HLS/DASH) to reassemble. Everything else is a
 * single file yt-dlp copies byte-for-byte.
 */
export function needsAssembly(formatId: string): boolean {
  return (
    formatId.includes('+') ||
    formatId.split('+').some((id) => /^(hls|dash|m3u8|http-dash)[-_]/i.test(id))
  );
}

function downloadArgs(
  url: string,
  formatId: string,
  playlistItem: number | undefined,
  output: string
): string[] {
  return [
    '-f',
    // Sites like Facebook can hand back different format ids on the second
    // extraction than on the first, so a bare id can fail with "Requested
    // format is not available" even though the video is fine. Fall back to
    // the best single file rather than failing the download outright.
    `${formatId}/best`,
    '--no-part',
    // Pull fragments in parallel. Most targets here (YouTube DASH/HLS) are
    // fragmented, and a single connection rarely saturates the link — this is
    // where real download speedup comes from, not from anything client-side.
    '--concurrent-fragments',
    String(CONCURRENT_FRAGMENTS),
    // Retry lost fragments instead of failing the whole stream on one blip.
    '--fragment-retries',
    '10',
    // A download always targets exactly one item: either the single media at
    // this URL, or one specific entry of a carousel.
    ...(playlistItem
      ? ['--yes-playlist', '--playlist-items', String(playlistItem)]
      : ['--no-playlist']),
    ...commonArgs(),
    '-o',
    output,
    url,
  ];
}

/**
 * Streams a single, self-contained format straight to stdout (`-o -`): the
 * bytes are copied from the source unchanged, so the file keeps its own
 * container, index and duration, and nothing touches the server's disk.
 *
 * Only for formats where `needsAssembly` is false. Muxing to a pipe can't
 * produce a valid MP4 — the header goes out before the total length is known,
 * so the duration reads as 0:00 in the gallery — which is why assembled
 * formats go through `downloadToTemp` instead.
 */
export function streamDownload(
  url: string,
  formatId: string,
  /** 1-based index of a carousel item; omitted for single media. */
  playlistItem?: number
): DownloadHandle {
  const bin = resolveYtDlpBin();
  const args = downloadArgs(url, formatId, playlistItem, '-');

  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (err) => reject(new YtDlpError(`Failed to start yt-dlp: ${err.message}`, stderr)));
    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new YtDlpError(`yt-dlp exited with code ${code}`, stderr));
        return;
      }
      resolve();
    });
  });

  return {
    stream: child.stdout,
    done,
    kill: () => child.kill('SIGKILL'),
  };
}

const TEMP_PREFIX = 'qlip-';

/**
 * Deletes temp download directories left behind by a previous process. Each
 * request removes its own on completion, so anything still here belongs to a
 * request that was cut off by a crash or restart.
 */
export async function sweepOrphanedTempFiles(): Promise<number> {
  const base = os.tmpdir();
  let removed = 0;
  try {
    for (const name of await readdir(base)) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      await rm(path.join(base, name), { recursive: true, force: true });
      removed++;
    }
  } catch {
    // /tmp unreadable is not worth failing startup over.
  }
  return removed;
}

export interface TempDownload {
  /** Absolute path of the finished file. */
  filePath: string;
  sizeBytes: number;
  /** Removes the file and its directory. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Downloads a format that needs assembling (a video+audio merge, or an
 * HLS/DASH manifest) into a private temp directory, muxed by ffmpeg as a
 * regular MP4 — with a real index and duration, unlike anything muxed to a
 * pipe. The caller streams the file back and MUST call `cleanup`; the file
 * exists only for the length of one request and is never kept.
 */
export async function downloadToTemp(
  url: string,
  formatId: string,
  playlistItem?: number
): Promise<TempDownload> {
  const dir = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  const cleanup = () => rm(dir, { recursive: true, force: true });

  try {
    const args = [
      ...downloadArgs(url, formatId, playlistItem, path.join(dir, 'media.%(ext)s')),
      // Always land on MP4 regardless of the source containers — VP9, H.264,
      // AAC and Opus all fit, and it's what the app expects to save.
      '--merge-output-format',
      'mp4',
      // Move the index to the front so the file can start playing before it
      // has fully transferred to the phone.
      '--postprocessor-args',
      'Merger+ffmpeg_o:-movflags +faststart',
    ];

    const stderr = await new Promise<string>((resolve, reject) => {
      const child = spawn(resolveYtDlpBin(), args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (chunk) => (err += chunk));
      child.on('error', (e) =>
        reject(new YtDlpError(`Failed to start yt-dlp: ${e.message}`, err))
      );
      child.on('close', (code) => {
        if (code !== 0) reject(new YtDlpError(`yt-dlp exited with code ${code}`, err));
        else resolve(err);
      });
    });

    const files = (await readdir(dir)).filter((f) => f.startsWith('media.'));
    if (files.length === 0) {
      throw new YtDlpError('yt-dlp finished but produced no file', stderr);
    }
    const filePath = path.join(dir, files[0]);
    const { size } = await stat(filePath);

    return { filePath, sizeBytes: size, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
