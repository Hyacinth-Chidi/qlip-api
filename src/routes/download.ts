import type { FastifyInstance } from 'fastify';
import { streamDownload, requiresMux, isFfmpegAvailable } from '../lib/ytdlp.js';

interface DownloadQuery {
  url?: string;
  format?: string;
  /** 1-based carousel item to fetch; omitted for single media. */
  item?: string;
}

export async function downloadRoute(app: FastifyInstance) {
  app.get<{ Querystring: DownloadQuery }>('/api/download', async (request, reply) => {
    const url = request.query.url?.trim();
    const formatId = request.query.format?.trim();

    if (!url || !formatId) {
      return reply.code(400).send({ error: 'Missing "url" or "format" query parameter.' });
    }

    if (requiresMux(formatId) && !(await isFfmpegAvailable())) {
      request.log.error('Muxed download requested but ffmpeg is not installed');
      return reply.code(503).send({
        error: 'This quality requires merging separate video/audio streams, but ffmpeg is not installed on the server. Install ffmpeg and try again.',
      });
    }

    const itemIndex = request.query.item ? Number(request.query.item) : undefined;
    if (itemIndex !== undefined && (!Number.isInteger(itemIndex) || itemIndex < 1)) {
      return reply.code(400).send({ error: '"item" must be a positive integer.' });
    }

    const handle = streamDownload(url, formatId, itemIndex);

    // If the client disconnects early, stop the yt-dlp process instead of
    // letting it run to completion for nothing.
    request.raw.on('close', () => {
      if (request.raw.destroyed) handle.kill();
    });

    // A streamed response can't change its status code after bytes start
    // flowing, so a yt-dlp failure mid-stream (e.g. ffmpeg missing and a mux
    // was required) is handled by forcibly destroying the connection. That
    // surfaces to the client as a failed/truncated download instead of a
    // corrupt file that looks like a successful 200.
    handle.done.catch((err) => {
      request.log.error(err, 'yt-dlp download stream failed');
      request.raw.destroy();
    });

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', 'attachment; filename="qlip-download"');
    return reply.send(handle.stream);
  });
}
