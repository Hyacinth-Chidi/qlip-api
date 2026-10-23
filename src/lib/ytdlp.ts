import { spawn } from 'node:child_process';
import { extractWorker } from './extract-worker.js';
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
 * WARP proxy, used to get past YouTube's datacenter-IP bot check.
 *
 * It is not free: everything routed through it pays the tunnel's latency and
 * bandwidth, measured at ~1.0s to reach Instagram versus ~0.1s direct. It was
 * applied to every site, so every Instagram, X and Facebook download — tens
 * of megabytes each — went through a tunnel added for YouTube's benefit.
 * See PROXIED_HOSTS for which sites actually get it.
 */
const PROXY_URL =
  process.env.YTDLP_PROXY ??
  (process.env.NODE_ENV === 'production' ? 'http://127.0.0.1:40000' : undefined);

/**
 * Hosts that need the proxy. Only YouTube refuses this server's IP outright;
 * every other supported site serves a datacenter IP perfectly well, so they
 * go direct and keep the bandwidth.
 *
 * Set YTDLP_PROXY_ALL=1 to force the old behaviour of proxying everything,
 * should another site start blocking.
 */
const PROXIED_HOSTS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'ytimg.com',
];

const PROXY_ALL = process.env.YTDLP_PROXY_ALL === '1';

/** The proxy to use for a url, or null when it should go direct. */
export function proxyFor(url: string): string | null {
  return shouldProxy(url) ? PROXY_URL!.trim() : null;
}

/** True when this URL's host is one the proxy exists for. */
export function shouldProxy(url: string): boolean {
  if (!PROXY_URL?.trim()) return false;
  if (PROXY_ALL) return true;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return PROXIED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    // An unparseable URL is yt-dlp's problem to report, not ours to proxy.
    return false;
  }
}
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
function commonArgs(url: string): string[] {
  const args = ['--no-warnings', '--js-runtimes', JS_RUNTIME];
  if (shouldProxy(url)) args.push('--proxy', PROXY_URL!.trim());
  if (existsSync(PLUGIN_DIR)) args.push('--plugin-dirs', PLUGIN_DIR);
  if (YOUTUBE_CLIENTS.trim()) {
    args.push('--extractor-args', `youtube:player_client=${YOUTUBE_CLIENTS}`);
  }
  return [...args, ...cookieArgs()];
}

/** Counts worker misses so a permanently-broken worker is visible in logs. */
let workerFallbacks = 0;

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

/**
 * Caps how long an extraction may run. Trying several player clients means a
 * blocked site can burn 30s+ before every one is exhausted, which leaves the
 * app's sheet spinning. Failing at a predictable point is better than a long
 * wait for the same error.
 */
const EXTRACT_TIMEOUT_MS = Number(process.env.YTDLP_EXTRACT_TIMEOUT_MS ?? 20000);

function runCapture(
  args: string[],
  timeoutMs = EXTRACT_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const bin = resolveYtDlpBin();
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    // Collect as Buffers and decode once. `string += chunk` decodes each
    // chunk independently, which corrupts any multi-byte UTF-8 character
    // split across a chunk boundary — invisible on small payloads, but
    // YouTube's metadata runs to hundreds of KB and reliably breaks.
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new YtDlpError(
          `Failed to start yt-dlp: ${err.message}`,
          Buffer.concat(errChunks).toString('utf8')
        )
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');

      if (timedOut && !stdout.trim()) {
        reject(
          new YtDlpError(
            `Extraction timed out after ${Math.round(timeoutMs / 1000)}s`,
            stderr
          )
        );
        return;
      }
      // With --ignore-errors yt-dlp exits non-zero when any item failed, even
      // though the items that succeeded are on stdout. Trust the output when
      // there is some, and let the caller decide whether it's usable.
      if (code !== 0 && !stdout.trim()) {
        reject(new YtDlpError(`yt-dlp exited with code ${code}`, stderr));
        return;
      }
      resolve({ stdout, stderr });
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
  /** Headers the CDN requires (Referer, User-Agent); 403s without them. */
  http_headers?: Record<string, string>;
  /**
   * yt-dlp's per-format download hints. `http_chunk_size` means the CDN only
   * serves this url in bounded ranges: an open-ended request gets 403.
   */
  downloader_options?: { http_chunk_size?: number };
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
/**
 * The worker equivalents of the CLI flags below. Both paths must behave the
 * same, or a link would resolve differently depending on which one ran.
 */
/**
 * The worker's equivalent of commonArgs(), and it must stay equivalent.
 *
 * These drifted apart: the worker set cookies and player clients but not the
 * plugin dir, the proxy or the js runtime. On YouTube the proxy is the one
 * that decides whether extraction works at all. Measured on the server with
 * the same url and player clients:
 *
 *   no proxy      -> "Sign in to confirm you're not a bot"
 *   plugin only   -> same failure (the bgutil provider registers nothing;
 *                    `_pot_providers` is empty, so it contributes nothing
 *                    today and WARP is what actually gets us past the check)
 *   plugin+proxy  -> 112 formats, heights up to 2160p
 *
 * Without it every worker attempt failed with "yt-dlp returned no data", and
 * each request paid that failure *and* a full fallback spawn: 7-20s per
 * YouTube extraction, and the SD-only format list users were seeing.
 *
 * Takes the url because the proxy is YouTube-only; see shouldProxy.
 */
function workerOpts(url: string): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    noplaylist: false,
    playlistend: 50,
    ignoreerrors: true,
    extractor_args: {
      youtube: { player_client: YOUTUBE_CLIENTS.split(',').filter(Boolean) },
    },
  };
  if (existsSync(COOKIES_FILE)) opts.cookiefile = COOKIES_FILE;

  // yt-dlp reads plugins from this list the same way --plugin-dirs does.
  if (existsSync(PLUGIN_DIR)) opts.plugin_dirs = [PLUGIN_DIR];

  if (shouldProxy(url)) opts.proxy = PROXY_URL!.trim();

  // Needed to decipher YouTube's signatures; the CLI passes --js-runtimes.
  // The library option is a dict of {runtime: {config}}, not the list the
  // CLI flag accepts — passing a list raises ValueError at construction.
  if (JS_RUNTIME.trim()) opts.js_runtimes = { [JS_RUNTIME.trim()]: {} };

  return opts;
}

export async function extractInfo(
  url: string
): Promise<YtDlpInfo | YtDlpPlaylist> {
  // Try the long-lived worker first: it skips yt-dlp's ~1.5s import and
  // reuses HTTP connections. Any failure falls through to spawning the
  // binary, which is slower but always available.
  //
  // Both stages are timed separately. A single `extractMs` can't distinguish
  // "the site was slow" from "the worker burned its whole timeout and then we
  // spawned anyway", and guessing between those has already cost several
  // rounds of wrong diagnosis.
  const tWorker = Date.now();
  try {
    const info = await extractWorker.extract(url, workerOpts(url));
    if (info && typeof info === 'object') {
      return info as YtDlpInfo | YtDlpPlaylist;
    }
    console.warn(
      `[extract] worker returned no usable data in ${Date.now() - tWorker}ms`
    );
  } catch (err) {
    // A genuine extraction failure (private video, bot check) would also
    // fail when spawned, but the retry is cheap relative to a wrong answer
    // and keeps worker problems from looking like site problems.
    workerFallbacks++;
    // Log the first few in full: the previous "1st and every 25th" rule meant
    // a worker that failed on every request reported once and then went
    // quiet, which hid exactly the problem worth seeing.
    if (workerFallbacks <= 5 || workerFallbacks % 25 === 0) {
      console.warn(
        `[extract] worker failed in ${Date.now() - tWorker}ms, spawning yt-dlp (${workerFallbacks}x): ${
          (err as Error).message
        }`
      );
    }
  }

  const workerMs = Date.now() - tWorker;
  const tSpawn = Date.now();

  const { stdout, stderr } = await runCapture([
    '-J',
    '--yes-playlist',
    // Carousels are small; this caps pathological cases like a whole profile.
    '--playlist-end',
    '50',
    // A mixed post (videos + photos) errors on each photo slide, since
    // yt-dlp finds no formats for them. Without this the whole extraction
    // fails and the usable videos are lost too.
    '--ignore-errors',
    ...commonArgs(url),
    url,
  ]);

  // With --ignore-errors yt-dlp can exit non-zero having written something
  // other than a complete JSON document (a partial line, or nothing at all
  // when every item failed). runCapture resolves in that case so partial
  // successes survive, so the parse has to be the thing that fails cleanly —
  // otherwise a SyntaxError escapes as a 500 instead of a handled 422.
  console.warn(
    `[extract] fallback spawn took ${Date.now() - tSpawn}ms (worker stage ${workerMs}ms before it)`
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new YtDlpError('yt-dlp returned no usable data for this link', stderr);
  }

  // With --ignore-errors a total failure prints the literal `null`, which is
  // valid JSON — so the parse succeeds and every caller then dereferences a
  // null. Treat anything that isn't an object as a failed extraction.
  if (parsed === null || typeof parsed !== 'object') {
    throw new YtDlpError('yt-dlp could not extract this link', stderr);
  }

  return parsed as YtDlpInfo | YtDlpPlaylist;
}

export function isPlaylist(
  info: YtDlpInfo | YtDlpPlaylist
): info is YtDlpPlaylist {
  // Null-safe: yt-dlp can hand back `null` for a failed extraction, and a
  // bare property read here turned that into a 500 rather than a handled
  // error.
  return (info as YtDlpPlaylist | null)?._type === 'playlist';
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

/**
 * Formats whose bytes we can't vouch for and so must not stream unchanged.
 *
 * Most sites tell yt-dlp the codecs and container up front, so a direct copy
 * is safe. Facebook reports `vcodec`/`acodec` as undefined — it genuinely
 * doesn't know — yet we still label the result .mp4 and video/mp4. When that
 * guess is wrong the file is rejected by players and editors even though the
 * download succeeded. Passing these through ffmpeg with `-c copy` rebuilds a
 * known-good MP4 container (front-loaded index, correct metadata) in about a
 * second, without re-encoding or touching quality.
 */
export function needsRemux(formatId: string): boolean {
  // Facebook names its formats exactly "sd"/"hd" and reports no codecs at
  // all; every other site we support uses structured ids (http-832,
  // dash-123v, 137+140) and declares what is inside. Rather than re-extract
  // just to inspect codecs — which would cost seconds on the download path —
  // match the bare-label shape that identifies the unverifiable case.
  return formatId
    .split('+')
    .some((id) => /^(sd|hd|hd1080|sd480|source|progressive)$/i.test(id.trim()));
}

function downloadArgs(
  url: string,
  formatId: string,
  playlistItem: number | undefined,
  output: string
): string[] {
  return [
    '-f',
    // Fall back to best H.264 video + AAC audio rather than arbitrary AV1/VP9
    // formats that fail in VLC and video editing software.
    `${formatId}/bestvideo[vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=h264]+bestaudio[ext=m4a]/best[ext=mp4]/best`,
    // Format sort ensures yt-dlp always prioritizes universally compatible
    // H.264 video and AAC audio across all platforms.
    '--format-sort',
    'codec:h264,codec:m4a',
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
    ...commonArgs(url),
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

/** Reads the actual video codec from a file, rather than trusting metadata. */
async function probeVideoCodec(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'default=nw=1:nk=1',
        filePath,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(out.trim().toLowerCase() || null));
  });
}

/** Codecs consumer players and editors reliably refuse. */
/**
 * Only codecs that genuinely fail to play, measured rather than assumed.
 *
 * VP9 was on this list and should not have been: VLC, Android and every
 * modern player handle it, Instagram serves it for everything, and including
 * it put a ~2 minute re-encode in front of every Instagram download. The
 * error that started this was specifically `av01`. HEVC stays because
 * consumer playback for it is genuinely patchy.
 */
const UNPLAYABLE_CODECS = new Set(['av01', 'av1', 'hevc', 'h265']);

/**
 * Transcodes to H.264 only when the file really needs it.
 *
 * Sites that report no codec (Facebook) can serve anything, and a `-c copy`
 * remux faithfully preserves whatever that is — which is how an AV1 file
 * reached VLC and was refused. The metadata can't be trusted, so the finished
 * file is probed and converted only on an actual mismatch. Files that are
 * already H.264 are returned untouched, so the common case costs nothing
 * beyond one fast ffprobe.
 */
async function ensurePlayableCodec(filePath: string): Promise<string> {
  const probeStart = Date.now();
  const codec = await probeVideoCodec(filePath);
  if (!codec || !UNPLAYABLE_CODECS.has(codec)) {
    console.log(
      `[download] codec=${codec ?? 'unknown'} ok, no transcode (probe ${Date.now() - probeStart}ms)`
    );
    return filePath;
  }
  console.log(`[download] codec=${codec} needs transcode to h264 — starting`);
  const transcodeStart = Date.now();

  const outPath = filePath.replace(/\.[^.]+$/, '') + '.h264.mp4';
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(
      'ffmpeg',
      [
        '-v', 'error',
        '-i', filePath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        // Audio is usually already AAC; copy when it is, convert when not.
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-y',
        outPath,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });

  console.log(
    `[download] transcode ${ok ? 'done' : 'FAILED'} in ${Date.now() - transcodeStart}ms`
  );
  // On failure keep the original: an unplayable file beats no file.
  return ok && existsSync(outPath) ? outPath : filePath;
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
    const finalPath = await ensurePlayableCodec(filePath);
    const { size } = await stat(finalPath);

    return { filePath: finalPath, sizeBytes: size, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
