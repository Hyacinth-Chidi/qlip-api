import type { YtDlpFormat } from './ytdlp.js';

/**
 * A short-lived note of where a format's bytes actually live.
 *
 * Extraction already resolves the real media URL, but the download endpoint
 * used to throw that away and make yt-dlp resolve the page again — about 4.5s
 * of re-work before the first byte, which reads as the app hanging after the
 * user taps Download. Caching the URL from the extract lets a plain
 * progressive file stream straight from the CDN instead.
 *
 * Entries expire because these URLs are signed and short-lived; a stale one
 * would 403. On a miss the download falls back to spawning yt-dlp, which is
 * slow but always correct.
 */
interface CachedTarget {
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
/** Bounded so a busy server can't grow this without limit. */
const MAX_ENTRIES = 500;

const cache = new Map<string, CachedTarget>();

function key(sourceUrl: string, formatId: string): string {
  return `${sourceUrl}\u0000${formatId}`;
}

/** Only plain HTTP files can be proxied; manifests need yt-dlp to assemble. */
export function isDirectlyStreamable(f: YtDlpFormat): boolean {
  return (
    Boolean(f.url) &&
    (f.protocol === 'https' || f.protocol === 'http') &&
    f.vcodec !== 'none'
  );
}

export function rememberTargets(sourceUrl: string, formats: YtDlpFormat[]): void {
  const now = Date.now();

  // Opportunistically drop expired entries, then oldest-first if still full.
  if (cache.size >= MAX_ENTRIES) {
    for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    while (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  for (const f of formats) {
    if (!isDirectlyStreamable(f)) continue;
    cache.set(key(sourceUrl, f.format_id), {
      url: f.url!,
      // The site's own headers (Referer, User-Agent) are often required;
      // without them the CDN returns 403.
      headers: (f.http_headers as Record<string, string>) ?? {},
      expiresAt: now + TTL_MS,
    });
  }
}

export function lookupTarget(
  sourceUrl: string,
  formatId: string
): CachedTarget | null {
  const hit = cache.get(key(sourceUrl, formatId));
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key(sourceUrl, formatId));
    return null;
  }
  return hit;
}
