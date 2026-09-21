import type { FastifyInstance } from 'fastify';
import {
  extractInfo,
  isPlaylist,
  YtDlpError,
  type YtDlpInfo,
} from '../lib/ytdlp.js';
import { buildQualityOptions } from '../lib/formats.js';
import { fillMissingSizes } from '../lib/probe-size.js';

interface ExtractBody {
  url?: string;
}

/** One selectable item of a multi-media post. */
async function toMediaItem(entry: YtDlpInfo, index: number) {
  const qualities = await fillMissingSizes(
    buildQualityOptions(entry),
    entry.formats
  );
  return {
    // 1-based, matching yt-dlp's --playlist-items indexing.
    index: index + 1,
    title: entry.title,
    thumbnail: entry.thumbnail ?? null,
    duration: entry.duration ?? null,
    // Images have no duration and only a single "format".
    kind: entry.duration ? ('video' as const) : ('image' as const),
    qualities,
  };
}

export async function extractRoute(app: FastifyInstance) {
  app.post<{ Body: ExtractBody }>('/api/extract', async (request, reply) => {
    const url = request.body?.url?.trim();
    if (!url) {
      return reply.code(400).send({ error: 'Missing "url" in request body.' });
    }

    try {
      const info = await extractInfo(url);

      if (isPlaylist(info)) {
        const all = info.entries ?? [];
        const entries = all.filter(Boolean);
        if (entries.length === 0) {
          // yt-dlp's Instagram extractor skips any node that isn't a video
          // (_extract_nodes: `if __typename != 'GraphVideo' ... continue`),
          // so a photo post counts its slides but discards every one — the
          // image URLs never reach us. Our own image handling works; there
          // is simply nothing to hand it. Not fixable server-side.
          return reply.code(422).send({
            error:
              all.length > 0
                ? "This post only contains photos. Instagram doesn't share photo files with downloaders — reels and video posts work."
                : 'Nothing downloadable was found at this link.',
          });
        }

        // A "playlist" of one is just single media wrapped — flatten it so the
        // app doesn't show a one-item picker.
        if (entries.length === 1) {
          const only = entries[0];
          return {
            type: 'single' as const,
            title: only.title,
            thumbnail: only.thumbnail ?? null,
            duration: only.duration ?? null,
            sourceExtractor: only.extractor_key ?? info.extractor_key,
            sourceUrl: only.webpage_url ?? info.webpage_url,
            qualities: await fillMissingSizes(
              buildQualityOptions(only),
              only.formats
            ),
          };
        }

        return {
          type: 'multi' as const,
          title: info.title,
          sourceExtractor: info.extractor_key,
          sourceUrl: info.webpage_url,
          items: await Promise.all(entries.map(toMediaItem)),
        };
      }

      return {
        type: 'single' as const,
        title: info.title,
        thumbnail: info.thumbnail ?? null,
        duration: info.duration ?? null,
        sourceExtractor: info.extractor_key,
        sourceUrl: info.webpage_url,
        qualities: await fillMissingSizes(
          buildQualityOptions(info),
          info.formats
        ),
      };
    } catch (err) {
      if (err instanceof YtDlpError) {
        // Log yt-dlp's own stderr — without it the cause (missing Python,
        // bot detection, unsupported site) is invisible in the logs.
        request.log.error({ stderr: err.stderr, url }, err.message);

        // Name the real cause when the site is refusing the server's IP,
        // rather than implying the link itself is at fault.
        const blocked = /sign in to confirm|not a bot|confirm you'?re/i.test(
          err.stderr
        );
        return reply.code(422).send({
          error: blocked
            ? 'YouTube is blocking this server right now. Other platforms still work.'
            : 'Could not extract this link. It may be unsupported, private, or the site changed.',
        });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Unexpected server error.' });
    }
  });
}
