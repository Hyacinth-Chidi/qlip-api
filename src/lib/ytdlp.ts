import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

/**
 * Checks once (then caches) whether ffmpeg is on PATH. A format id containing
 * "+" (e.g. "229+140") tells yt-dlp to merge separate video/audio streams,
 * which requires ffmpeg — without it yt-dlp fails mid-stream after headers
 * are already sent, so callers should check this before starting a muxed
 * download rather than let that happen.
 */
export function requiresMux(formatId: string): boolean {
  return formatId.includes('+');
}

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
 * Streams a single format straight to stdout (`-o -`) so the server never
 * writes the final file to disk. When yt-dlp needs to merge separate
 * video+audio streams it still uses ffmpeg under the hood with short-lived
 * temp files of its own choosing (typically /tmp), which it cleans up itself
 * once the muxed output has been written to stdout.
 */
export function streamDownload(
  url: string,
  formatId: string,
  /** 1-based index of a carousel item; omitted for single media. */
  playlistItem?: number
): DownloadHandle {
  const bin = resolveYtDlpBin();
  const args = [
    '-f',
    formatId,
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
    // When ffmpeg muxes to stdout, yt-dlp hardcodes the container to MPEG-TS
    // (downloader/external.py, `ext == 'mp4' and tmpfilename == '-'`). TS
    // cannot carry VP9, which Instagram uses for every format and YouTube for
    // its 4K/2K tiers — the result plays audio over a black picture. These
    // output args are appended after that default, and ffmpeg honours the
    // last `-f`, so this switches to fragmented MP4: streamable without a
    // seekable output, and it carries VP9, H.264, AAC and Opus. Ignored
    // entirely for direct (non-ffmpeg) downloads.
    '--downloader-args',
    'ffmpeg_o:-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof',
    ...commonArgs(),
    '-o',
    '-',
    url,
  ];

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
