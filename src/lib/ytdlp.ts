import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const BIN_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const LOCAL_BIN = path.join(REPO_ROOT, 'bin', BIN_NAME);
const COOKIES_FILE = path.join(REPO_ROOT, 'cookies', 'youtube.txt');

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
      if (code !== 0) {
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
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number | null;
  filesize_approx?: number | null;
  tbr?: number | null; // total bitrate, kbps — used to estimate size when filesize is absent
  format_note?: string;
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
 * Runs `yt-dlp -j <url>` to extract metadata + available formats without
 * downloading anything.
 */
export async function extractInfo(url: string): Promise<YtDlpInfo> {
  const stdout = await runCapture([
    '-j',
    '--no-warnings',
    '--no-playlist',
    ...cookieArgs(),
    url,
  ]);
  return JSON.parse(stdout) as YtDlpInfo;
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
export function streamDownload(url: string, formatId: string): DownloadHandle {
  const bin = resolveYtDlpBin();
  const args = [
    '-f',
    formatId,
    '--no-warnings',
    '--no-playlist',
    '--no-part',
    ...cookieArgs(),
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
