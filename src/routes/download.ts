import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  streamDownload,
  downloadToTemp,
  needsAssembly,
  isFfmpegAvailable,
  YtDlpError,
} from '../lib/ytdlp.js';

interface DownloadQuery {
  url?: string;
  format?: string;
  /** 1-based carousel item to fetch; omitted for single media. */
  item?: string;
  /** Container the client expects, e.g. "mp4" — shapes the filename/type. */
  ext?: string;
  /** Suggested download name, without extension. */
  name?: string;
}

/** Content types for the containers this server can return. */
const MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * Builds the response headers that tell a client what it is receiving.
 *
 * Without a real extension and content type, a browser saves the file with no
 * suffix and the OS can't associate it with a player — the user has to rename
 * it by hand before anything will open it.
 */
function contentHeaders(ext: string | undefined, name: string | undefined) {
  const safeExt = (ext ?? 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '');
  // Strip anything that would break the header or escape the filename.
  const base = (name ?? 'qlip-download')
    .replace(/[\r\n"\\/]/g, '')
    .trim()
    .slice(0, 80);

  return {
    type: MIME_TYPES[safeExt] ?? 'application/octet-stream',
    filename: `${base || 'qlip-download'}.${safeExt}`,
  };
}

export async function downloadRoute(app: FastifyInstance) {
  app.get<{ Querystring: DownloadQuery }>('/api/download', async (request, reply) => {
    const url = request.query.url?.trim();
    const formatId = request.query.format?.trim();

    if (!url || !formatId) {
      return reply.code(400).send({ error: 'Missing "url" or "format" query parameter.' });
    }

    const itemIndex = request.query.item ? Number(request.query.item) : undefined;
    if (itemIndex !== undefined && (!Number.isInteger(itemIndex) || itemIndex < 1)) {
      return reply.code(400).send({ error: '"item" must be a positive integer.' });
    }

    // Applied only just before media is sent: setting a media Content-Type
    // up front makes Fastify refuse to serialise a JSON error body on the
    // failure paths below.
    const applyMediaHeaders = () => {
      // Assembled downloads are always muxed to MP4, whatever the sources were.
      const { type, filename } = contentHeaders(
        needsAssembly(formatId) ? 'mp4' : request.query.ext,
        request.query.name
      );
      reply.header('Content-Type', type);
      reply.header(
        'Content-Disposition',
        // RFC 5987 filename* carries non-ASCII names; plain filename is the
        // fallback for clients that don't understand it.
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      );
    };

    // Plain single-file formats stream straight through: no ffmpeg, no disk,
    // and the file arrives byte-for-byte as the site served it.
    if (!needsAssembly(formatId)) {
      const handle = streamDownload(url, formatId, itemIndex);

      // If the client disconnects early, stop the yt-dlp process instead of
      // letting it run to completion for nothing.
      request.raw.on('close', () => {
        if (request.raw.destroyed) handle.kill();
      });

      // A streamed response can't change its status code after bytes start
      // flowing, so a failure mid-stream is handled by forcibly destroying the
      // connection. That surfaces to the client as a failed/truncated download
      // instead of a corrupt file that looks like a successful 200.
      handle.done.catch((err) => {
        request.log.error(err, 'yt-dlp download stream failed');
        request.raw.destroy();
      });

      applyMediaHeaders();
      return reply.send(handle.stream);
    }

    // Anything ffmpeg has to assemble is muxed to a temp file first. Muxing
    // to a pipe can't write a valid MP4 header (the duration ends up 0:00),
    // and yt-dlp's pipe fallback is MPEG-TS, which can't carry VP9 at all.
    if (!(await isFfmpegAvailable())) {
      request.log.error('Assembled download requested but ffmpeg is not installed');
      return reply.code(503).send({
        error: 'This quality needs ffmpeg to assemble, but it is not installed on the server.',
      });
    }

    let temp;
    try {
      temp = await downloadToTemp(url, formatId, itemIndex);
    } catch (err) {
      if (err instanceof YtDlpError) {
        request.log.error({ stderr: err.stderr, url, formatId }, err.message);
        return reply.code(422).send({
          error: 'The download could not be prepared. The video may be unavailable or the site changed.',
        });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Unexpected server error.' });
    }

    // Known up front now, so the app gets real progress instead of an
    // estimate.
    reply.header('Content-Length', String(temp.sizeBytes));

    const file = createReadStream(temp.filePath);
    const cleanup = () => {
      temp.cleanup().catch((err) => request.log.warn(err, 'temp cleanup failed'));
    };
    // Whether the transfer completes, errors, or the phone disconnects, the
    // file must not outlive the request.
    file.on('close', cleanup);
    request.raw.on('close', () => {
      if (request.raw.destroyed) file.destroy();
    });

    applyMediaHeaders();
    return reply.send(file);
  });
}
