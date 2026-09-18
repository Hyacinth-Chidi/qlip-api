import type { FastifyInstance } from 'fastify';
import { extractInfo, YtDlpError } from '../lib/ytdlp.js';
import { buildQualityOptions } from '../lib/formats.js';

interface ExtractBody {
  url?: string;
}

export async function extractRoute(app: FastifyInstance) {
  app.post<{ Body: ExtractBody }>('/api/extract', async (request, reply) => {
    const url = request.body?.url?.trim();
    if (!url) {
      return reply.code(400).send({ error: 'Missing "url" in request body.' });
    }

    try {
      const info = await extractInfo(url);
      const qualities = buildQualityOptions(info);

      return {
        title: info.title,
        thumbnail: info.thumbnail ?? null,
        duration: info.duration ?? null,
        sourceExtractor: info.extractor_key,
        sourceUrl: info.webpage_url,
        qualities,
      };
    } catch (err) {
      request.log.error(err);
      if (err instanceof YtDlpError) {
        return reply.code(422).send({
          error: 'Could not extract this link. It may be unsupported, private, or the site changed.',
        });
      }
      return reply.code(500).send({ error: 'Unexpected server error.' });
    }
  });
}
