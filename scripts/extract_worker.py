"""Long-lived yt-dlp extraction worker.

Spawning yt-dlp per request costs ~1.5s importing its several thousand site
extractors, and throws away every HTTP connection and session. Keeping one
process alive amortises the import and lets yt-dlp reuse connections, which
measured 2-5x faster depending on the site.

Protocol: line-delimited JSON on stdin/stdout, one object per line.
  in   {"id": 1, "url": "...", "opts": {...}}
  out  {"id": 1, "info": {...}}  |  {"id": 1, "error": "...", "stderr": "..."}

Every reply carries the request id, so concurrent requests can be matched up
and the caller never has to assume ordering.
"""

import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import yt_dlp

# extract_info blocks, so requests run on worker threads. Small pool: these
# are network-bound and a VPS shouldn't hammer a site with parallel requests.
POOL = ThreadPoolExecutor(max_workers=4)

# One lock for stdout — threads must not interleave partial lines.
WRITE_LOCK = threading.Lock()


def reply(payload):
    with WRITE_LOCK:
        sys.stdout.write(json.dumps(payload, default=str) + "\n")
        sys.stdout.flush()


# YoutubeDL instances own the HTTP connection pool and per-site session
# state, so they are cached and reused: building a fresh one per request
# throws away exactly the reuse this worker exists to provide. Keyed by the
# options, since different options need different instances.
_INSTANCES = {}
_INSTANCE_LOCK = threading.Lock()


def get_ydl(opts):
    key = json.dumps(opts, sort_keys=True, default=str)
    with _INSTANCE_LOCK:
        ydl = _INSTANCES.get(key)
        if ydl is None:
            ydl = yt_dlp.YoutubeDL(opts)
            _INSTANCES[key] = ydl
        return ydl


def extract(req):
    req_id = req.get("id")
    url = req.get("url")
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        # Surface errors as exceptions rather than printing and continuing.
        "ignoreerrors": False,
        **(req.get("opts") or {}),
    }

    try:
        ydl = get_ydl(opts)
        info = ydl.extract_info(url, download=False)
        if info is None:
            reply({"id": req_id, "error": "yt-dlp returned no data", "stderr": ""})
            return
        # sanitize_info drops unserialisable internals (cookiejar, functions)
        # that would otherwise break json.dumps.
        reply({"id": req_id, "info": yt_dlp.YoutubeDL.sanitize_info(info)})
    except Exception as exc:  # noqa: BLE001 - any extractor failure is a reply
        reply({"id": req_id, "error": str(exc), "stderr": str(exc)})


def main():
    # Announce readiness so the parent knows the import is done and can start
    # sending work.
    reply({"ready": True, "version": yt_dlp.version.__version__})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        POOL.submit(extract, req)


if __name__ == "__main__":
    main()
