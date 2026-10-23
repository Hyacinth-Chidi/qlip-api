import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, type Writable } from 'node:stream';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lookupTarget } from './direct-stream.js';
import { proxyFor, type TempDownload } from './ytdlp.js';

type Parts = {
  video: string;
  audio: string;
  headers: Record<string, string>;
  /** Largest range the CDN will serve per request; unset = no limit. */
  chunkSize?: number;
};

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
): Parts | null {
  const ids = formatId.split('+');
  if (ids.length !== 2) return null;

  const [video, audio] = ids.map((id) => lookupTarget(sourceUrl, id));
  if (!video || !audio) return null;

  // Both parts come from the same extraction, so their headers match; the
  // CDN rejects the request without the site's Referer/User-Agent.
  return {
    video: video.url,
    audio: audio.url,
    headers: video.headers,
    chunkSize: video.chunkSize ?? audio.chunkSize,
  };
}

/** Renders ffmpeg's `-headers` argument: CRLF-separated, trailing CRLF. */
function headerArg(headers: Record<string, string>): string[] {
  const entries = Object.entries(headers);
  if (entries.length === 0) return [];
  return ['-headers', entries.map(([k, v]) => `${k}: ${v}\r\n`).join('')];
}

/** The same headers as repeated curl `-H` flags. */
function curlHeaders(headers: Record<string, string>): string[] {
  return Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
}

/**
 * Total size of a media url, from the Content-Range of a one-byte request.
 *
 * A ranged GET rather than HEAD: some CDNs refuse HEAD, and YouTube refuses
 * any request that isn't a bounded range. Uses curl because the request has
 * to take the same route the media will — the CDN signs urls to the
 * requesting IP — and curl takes the proxy directly. Null on any failure.
 */
async function contentLength(
  url: string,
  headers: Record<string, string>,
  proxy: string | null,
  timeoutMs = 4000
): Promise<number | null> {
  const args = [
    '-s', '-o', '/dev/null',
    '-r', '0-0',
    '-D', '-',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    ...curlHeaders(headers),
    ...(proxy ? ['-x', proxy] : []),
    url,
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
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Writes a url's bytes into `sink` as a sequence of bounded ranges.
 *
 * YouTube serves some clients' urls (VISIONOS, measured) only in ranges of at
 * most `http_chunk_size`: a 0-1000 or 0-10MB request gets 206, while an
 * open-ended or unranged one gets 403. ffmpeg always opens with an open
 * range, so it was refused on every such download however the proxy was
 * passed. This does what yt-dlp does — fetch in chunks — and hands ffmpeg the
 * bytes over a pipe.
 *
 * One curl process with `--next` between ranges, so the connection through
 * the proxy is reused instead of paying a fresh TLS handshake per chunk.
 * The sink is only ended on success: on failure ffmpeg must not see a clean
 * EOF, or it would finalise a truncated file as if it were complete.
 */
async function feedChunked(
  url: string,
  headers: Record<string, string>,
  proxy: string | null,
  chunkSize: number,
  sink: Writable,
  track: (child: ChildProcess) => void
): Promise<void> {
  const total = await contentLength(url, headers, proxy);
  if (!total) throw new Error('could not determine media length for chunked fetch');

  const perTransfer = ['-s', '-f', ...curlHeaders(headers), ...(proxy ? ['-x', proxy] : [])];
  const args = ['--fail-early'];
  for (let start = 0; start < total; start += chunkSize) {
    const end = Math.min(start + chunkSize, total) - 1;
    if (start > 0) args.push('--next');
    args.push(...perTransfer, '-r', `${start}-${end}`, url);
  }

  const curl = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  track(curl);
  let err = '';
  curl.stderr.on('data', (c) => (err += c));

  // ffmpeg dying closes this pipe; stop fetching rather than block forever.
  let sinkErr: Error | null = null;
  sink.on('error', (e) => {
    sinkErr = e;
    curl.kill('SIGKILL');
  });
  curl.stdout.pipe(sink, { end: false });

  await new Promise<void>((resolve, reject) => {
    curl.on('error', (e) => reject(new Error(`Failed to start curl: ${e.message}`)));
    curl.on('close', (code) => {
      if (sinkErr) reject(sinkErr);
      else if (code === 0) resolve();
      else reject(new Error(`chunked fetch failed (curl exit ${code}) ${err.slice(0, 200)}`));
    });
  });
  sink.end();
}

/**
 * Starts ffmpeg muxing both parts with the given output arguments.
 *
 * Without a chunk size ffmpeg opens the urls itself, with the proxy passed as
 * `-http_proxy`. With one, Node feeds it bounded ranges on fds 3 and 4.
 *
 * `done` resolves when the mux finished cleanly or was stopped through
 * `kill()`, and rejects with the most specific cause otherwise — including a
 * failed chunk fetch, which must fail the download even if ffmpeg itself
 * would have exited cleanly on the truncated input.
 */
function spawnMux(
  sourceUrl: string,
  parts: Parts,
  outputArgs: string[],
  stdout: 'pipe' | 'ignore'
): { child: ChildProcess; done: Promise<void>; kill: () => void } {
  const proxy = proxyFor(sourceUrl);
  const chunked = Boolean(parts.chunkSize);

  let inputs: string[];
  if (chunked) {
    inputs = ['-i', 'pipe:3', '-i', 'pipe:4'];
  } else {
    const perInput = [
      // Let a transient CDN hiccup retry rather than failing the download.
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      ...headerArg(parts.headers),
      // Google signs media urls to the requesting IP, so a url resolved
      // through WARP has to be fetched through it too.
      ...(proxy ? ['-http_proxy', proxy] : []),
    ];
    inputs = [...perInput, '-i', parts.video, ...perInput, '-i', parts.audio];
  }

  const child = spawn(
    'ffmpeg',
    ['-nostdin', '-loglevel', 'error', ...inputs, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', ...outputArgs],
    {
      stdio: chunked
        ? ['ignore', stdout, 'pipe', 'pipe', 'pipe']
        : ['ignore', stdout, 'pipe'],
    }
  );

  const feeders: ChildProcess[] = [];
  let intentional = false;
  let feedErr: Error | null = null;
  const kill = () => {
    intentional = true;
    child.kill('SIGKILL');
    for (const f of feeders) f.kill('SIGKILL');
  };

  if (chunked) {
    const track = (c: ChildProcess) => feeders.push(c);
    const feed = (url: string, fd: number) =>
      feedChunked(url, parts.headers, proxy, parts.chunkSize!, child.stdio[fd] as Writable, track)
        .catch((e: Error) => {
          if (intentional) return;
          feedErr ??= e;
          child.kill('SIGKILL');
          for (const f of feeders) f.kill('SIGKILL');
        });
    void feed(parts.video, 3);
    void feed(parts.audio, 4);
  }

  let err = '';
  child.stderr!.on('data', (c) => (err += c));

  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`Failed to start ffmpeg: ${e.message}`)));
    child.on('close', (code) => {
      if (intentional) resolve();
      else if (feedErr) reject(feedErr);
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 400)}`));
    });
  });
  // Observed by the callers; never let it surface as unhandled.
  done.catch(() => {});

  return { child, done, kill };
}

/**
 * Muxes both parts into a faststart MP4 temp file.
 *
 * `-c copy` means no re-encoding: this is a container remux, so it costs
 * roughly what the bytes take to transfer. The timeout only guards against a
 * hung read; it is sized for a large file at the speeds measured here, since
 * this path still serves big files whenever the size probe fails.
 */
export async function assembleFromCache(
  sourceUrl: string,
  parts: Parts,
  timeoutMs = 10 * 60_000
): Promise<TempDownload> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qlip-fast-'));
  const filePath = path.join(dir, 'media.mp4');
  const cleanup = () => rm(dir, { recursive: true, force: true });

  // Index at the front so the phone can play before the transfer finishes.
  const mux = spawnMux(sourceUrl, parts, ['-movflags', '+faststart', '-y', filePath], 'ignore');
  const timer = setTimeout(mux.kill, timeoutMs);

  try {
    await mux.done;
    clearTimeout(timer);

    const { size } = await stat(filePath);
    // A zero-byte result means ffmpeg "succeeded" on nothing usable — and a
    // timeout kill resolves `done` too — so check before serving anything.
    if (size === 0) throw new Error('ffmpeg produced an empty file');
    if (mux.child.exitCode !== 0) {
      throw new Error(`ffmpeg assemble timed out after ${timeoutMs}ms`);
    }

    return { filePath, sizeBytes: size, cleanup };
  } catch (err) {
    clearTimeout(timer);
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
 * Resolves only once ffmpeg has produced its first bytes. With empty_moov
 * ffmpeg writes nothing until both inputs have opened, so a first byte means
 * the CDN accepted us. Committing to a 200 any earlier turned a refused input
 * into a "successful" 0-byte download the caller could no longer fall back
 * from. Rejects, with the underlying error, when it exits before writing.
 */
export async function streamFromCache(
  sourceUrl: string,
  parts: Parts,
  firstByteTimeoutMs = 30_000
): Promise<{ stream: Readable; done: Promise<void>; kill: () => void }> {
  const mux = spawnMux(
    sourceUrl,
    parts,
    [
      // empty_moov makes the file valid before any media is written;
      // frag_keyframe starts a new fragment at each keyframe; and
      // default_base_moof is what Safari and Chrome expect for playback.
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      // A pipe has no extension to infer the container from.
      '-f', 'mp4',
      'pipe:1',
    ],
    'pipe'
  );

  const it: AsyncIterator<Buffer> = mux.child.stdout![Symbol.asyncIterator]();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    mux.kill();
  }, firstByteTimeoutMs);

  let first: IteratorResult<Buffer>;
  try {
    first = await it.next();
  } finally {
    clearTimeout(timer);
  }

  if (first.done) {
    if (timedOut) {
      throw new Error(`ffmpeg produced no output within ${firstByteTimeoutMs}ms`);
    }
    await mux.done; // rejects with ffmpeg's or the fetch's own error
    throw new Error('ffmpeg exited without producing output');
  }

  // Hand back a stream that replays the chunk already read, then the rest.
  const firstChunk = first.value;
  const stream = Readable.from(
    (async function* () {
      yield firstChunk;
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        yield next.value;
      }
    })()
  );

  return { stream, done: mux.done, kill: mux.kill };
}

/**
 * Whether the video part is larger than `limit` bytes.
 *
 * Decides between streaming and the temp-file path, so it must be cheap and
 * must never block the download: anything unexpected returns false, which
 * keeps the temp-file behaviour. Only the video part is measured; the audio
 * track is a small fraction of the total and the threshold need not be exact.
 */
export async function partsExceed(
  sourceUrl: string,
  parts: Parts,
  limit: number
): Promise<boolean> {
  const len = await contentLength(parts.video, parts.headers, proxyFor(sourceUrl));
  return len !== null && len > limit;
}
