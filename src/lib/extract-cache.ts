import type { YtDlpInfo, YtDlpPlaylist } from './ytdlp.js';

/**
 * Short-lived cache of extraction results, keyed by source URL.
 *
 * The app extracts a link when the user pastes it, and the logs show the same
 * link extracted repeatedly across a session — each time paying the full cost
 * of fetching and parsing the page. Instagram also rate-limits by IP, so
 * repeated hits from one server are measurably slower than the first, which
 * made the same reel resolve in 1.3s standalone and 14s under load.
 *
 * The TTL is deliberately shorter than the CDN URL cache in direct-stream.ts:
 * this holds whole format lists, and serving a stale one would show the user
 * sizes and qualities that no longer match what they'd receive.
 */
interface Entry {
  info: YtDlpInfo | YtDlpPlaylist;
  expiresAt: number;
}

const TTL_MS = Number(process.env.QLIP_EXTRACT_CACHE_TTL_MS ?? 5 * 60 * 1000);
/** Bounded; each entry holds a full format list, which is tens of KB. */
const MAX_ENTRIES = 200;

const cache = new Map<string, Entry>();

/** Returns the cached extraction for a URL, or null when absent/expired. */
export function lookupExtract(url: string): YtDlpInfo | YtDlpPlaylist | null {
  const hit = cache.get(url);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(url);
    return null;
  }
  // Refresh recency so a link in active use isn't evicted under pressure.
  cache.delete(url);
  cache.set(url, hit);
  return hit.info;
}

export function rememberExtract(
  url: string,
  info: YtDlpInfo | YtDlpPlaylist
): void {
  const now = Date.now();

  if (cache.size >= MAX_ENTRIES) {
    for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    // Map iterates in insertion order, and lookupExtract re-inserts on hit,
    // so the front of the map is genuinely the least recently used.
    while (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  cache.set(url, { info, expiresAt: now + TTL_MS });
}
