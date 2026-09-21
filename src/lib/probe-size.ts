import type { YtDlpFormat } from './ytdlp.js';
import type { QualityOption } from './formats.js';

/**
 * Asks the CDN for a format's real byte size with a HEAD request.
 *
 * Some sites (Instagram notably) report neither `filesize` nor `duration`, so
 * there's nothing to estimate from and every option shows "unknown". Their
 * media is served as plain HTTP files though, so Content-Length gives an
 * exact answer.
 */
async function headContentLength(
  url: string,
  timeoutMs: number
): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length'));
    return Number.isFinite(length) && length > 0 ? length : null;
  } catch {
    // Expired URL, CDN refusing HEAD, timeout — size just stays unknown.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fills in `approxSizeBytes` for options that lack one, by probing the
 * underlying format's URL. Runs the probes in parallel and leaves the option
 * untouched when the size can't be determined.
 *
 * `formatIndex` maps an option id back to the formats it was built from; an
 * id like "137+140" is a merge, so the parts are summed.
 */
export async function fillMissingSizes(
  options: QualityOption[],
  formats: YtDlpFormat[],
  timeoutMs = 4000
): Promise<QualityOption[]> {
  const byId = new Map(formats.map((f) => [f.format_id, f]));

  // A missing size is cosmetic, so nothing in here may fail the request:
  // every probe is individually guarded and the whole pass falls back to the
  // original options if anything unexpected throws.
  try {
    const results = await Promise.allSettled(
      options.map(async (option) => {
        if (option.approxSizeBytes) return option;

        const parts = option.id.split('+').map((id) => byId.get(id));
        if (parts.some((p) => !p?.url)) return option;

        const sizes = await Promise.all(
          parts.map((p) => headContentLength(p!.url!, timeoutMs))
        );
        if (sizes.some((s) => s === null)) return option;

        return {
          ...option,
          approxSizeBytes: sizes.reduce<number>((sum, s) => sum + s!, 0),
        };
      })
    );

    return results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : options[i]
    );
  } catch {
    return options;
  }
}
