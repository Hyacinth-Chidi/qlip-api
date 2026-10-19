import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKER_SCRIPT = path.join(REPO_ROOT, 'scripts', 'extract_worker.py');
const VENV_PYTHON = path.join(REPO_ROOT, '.venv', 'bin', 'python3');

/** Per-request ceiling; a wedged extractor must not hold a slot forever. */
const REQUEST_TIMEOUT_MS = Number(
  process.env.YTDLP_EXTRACT_TIMEOUT_MS ?? 20000
);

interface Pending {
  resolve: (info: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Keeps one Python process alive and talks to it in line-delimited JSON.
 *
 * Importing yt-dlp costs ~1.5s and spawning per request discards every HTTP
 * connection; holding the process open avoids both. The worker is strictly an
 * optimisation — when it can't start, callers fall back to spawning the
 * yt-dlp binary, which is slower but identical in behaviour.
 */
class ExtractWorker {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private starting: Promise<boolean> | null = null;
  private unavailable = false;
  /** yt-dlp version inside the worker, logged so drift is visible. */
  version: string | null = null;

  /** False when no usable Python/yt_dlp is present. */
  async ensureStarted(): Promise<boolean> {
    if (this.unavailable) return false;
    if (this.child && !this.child.killed) return true;
    if (this.starting) return this.starting;

    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private resolvePython(): string | null {
    if (existsSync(VENV_PYTHON)) return VENV_PYTHON;
    // Windows venv layout, for local development.
    const winVenv = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
    if (existsSync(winVenv)) return winVenv;
    return process.env.YTDLP_PYTHON ?? null;
  }

  private start(): Promise<boolean> {
    const python = this.resolvePython();
    if (!python || !existsSync(WORKER_SCRIPT)) {
      this.unavailable = true;
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(python, [WORKER_SCRIPT], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        this.unavailable = true;
        resolve(false);
        return;
      }

      // Importing yt-dlp takes a couple of seconds; if the ready line never
      // arrives, treat the worker as unavailable rather than hanging.
      const readyTimer = setTimeout(() => {
        child.kill('SIGKILL');
        this.unavailable = true;
        resolve(false);
      }, 30000);

      const rl = readline.createInterface({ input: child.stdout! });
      rl.on('line', (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }

        if (msg.ready) {
          clearTimeout(readyTimer);
          this.version = (msg.version as string) ?? null;
          this.child = child;
          resolve(true);
          return;
        }

        const id = msg.id as number | undefined;
        if (id === undefined) return;
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        clearTimeout(waiter.timer);

        if (msg.error) waiter.reject(new Error(String(msg.error)));
        else waiter.resolve(msg.info);
      });

      child.on('exit', () => {
        clearTimeout(readyTimer);
        this.child = null;
        // Fail anything in flight; the next call starts a fresh process.
        for (const [, waiter] of this.pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('extract worker exited'));
        }
        this.pending.clear();
        resolve(false);
      });

      child.on('error', () => {
        clearTimeout(readyTimer);
        this.unavailable = true;
        resolve(false);
      });
    });
  }

  /** Rejects if the worker is unavailable, errors, or times out. */
  async extract(url: string, opts?: Record<string, unknown>): Promise<unknown> {
    if (!(await this.ensureStarted()) || !this.child) {
      throw new Error('extract worker unavailable');
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A wedged extractor can't be cancelled individually, so drop the
        // whole process — the next request gets a clean one.
        this.child?.kill('SIGKILL');
        reject(new Error(`extract timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify({ id, url, opts }) + '\n');
    });
  }

  stop(): void {
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}

export const extractWorker = new ExtractWorker();
