import type { FastifyInstance } from 'fastify';
import {
  extractInfo,
  isPlaylist,
  YtDlpError,
  type YtDlpInfo,
} from '../lib/ytdlp.js';
import { buildQualityOptions } from '../lib/formats.js';

interface ExtractBody {
  url?: string;
}

/** One selectable item of a multi-media post. */
function toMediaItem(entry: YtDlpInfo, index: number) {
  const qualities = buildQualityOptions(entry);
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
          // yt-dlp indexes photo slides but produces no formats for them
          // (yt-dlp#7569), so an all-photo post yields only null entries.
          return reply.code(422).send({
            error:
              all.length > 0
                ? 'This post only contains photos, which cannot be downloaded yet. Video posts and reels work.'
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
            qualities: buildQualityOptions(only),
          };
        }

        return {
          type: 'multi' as const,
          title: info.title,
          sourceExtractor: info.extractor_key,
          sourceUrl: info.webpage_url,
          items: entries.map(toMediaItem),
        };
      }

      return {
        type: 'single' as const,
        title: info.title,
        thumbnail: info.thumbnail ?? null,
        duration: info.duration ?? null,
        sourceExtractor: info.extractor_key,
        sourceUrl: info.webpage_url,
        qualities: buildQualityOptions(info),
      };
    } catch (err) {
      if (err instanceof YtDlpError) {
        // Log yt-dlp's own stderr — without it the cause (missing Python,
        // bot detection, unsupported site) is invisible in the logs.
        request.log.error({ stderr: err.stderr, url }, err.message);
        return reply.code(422).send({
          error: 'Could not extract this link. It may be unsupported, private, or the site changed.',
        });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Unexpected server error.' });
    }
  });
}
