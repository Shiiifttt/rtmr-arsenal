/**
 * A live view of a running search, for the arsenal's dev server (web/: the
 * Live panel, GET /__combat/live).
 *
 * Kept off the sim's path: each worker thread marks which target it is on
 * and how many fights it has finished in a SharedArrayBuffer -- a couple of
 * atomic writes a batch, no messages -- and the main thread, a few times a
 * second, reads those, adds what it already knows (the build, what each
 * worker was sent, the score) and writes it all to one small JSON file under
 * runs/live/. Nothing waits on the file; a reader that catches it half
 * written tries again next poll.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Per worker: [target index (-1: none), fights finished]. */
const FIELDS = 2;

/** The worker side: where this worker marks its progress. */
export class LiveMarks {
  private view: Int32Array | null;
  private base: number;
  constructor(buf: SharedArrayBuffer | undefined, slot: number) {
    this.view = buf ? new Int32Array(buf) : null;
    this.base = slot * FIELDS;
  }
  target(i: number) { if (this.view) Atomics.store(this.view, this.base, i); }
  fought(n: number) { if (this.view) Atomics.add(this.view, this.base + 1, n); }
}

export const LIVE_DIR = resolve(import.meta.dirname, '../runs/live');
/** How often the file is rewritten. */
const EVERY_MS = 250;

/**
 * A worker's candidate: what it changes from the build (key: a slot key,
 * 'stats' or 'options'; ids: the piece, for the page's icon).
 */
export interface LiveWorker { target: string | null; kind: string; fights: number; changes: { key: string; text: string; ids?: number[] }[] }
export interface LiveScore {
  value: number; win: number; loss: number; dps: number;
  killsPerHour?: number; deathsPerHour?: number; sitS?: number;
}

/**
 * The main thread's side. `snapshot` is called on each tick for everything
 * but the counters; the counters are read here.
 */
export class LiveFeed {
  readonly buffer: SharedArrayBuffer;
  private view: Int32Array;
  private file: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = { t: performance.now(), fights: 0 };
  private rate = 0;
  private readonly t0 = Date.now();
  private workers: number;
  private snapshot: () => Record<string, unknown> & { workers: LiveWorker[] };
  private targets: string[];
  constructor(workers: number, snapshot: () => Record<string, unknown> & { workers: LiveWorker[] }, targets: string[]) {
    this.workers = workers; this.snapshot = snapshot; this.targets = targets;
    this.buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * FIELDS * workers);
    this.view = new Int32Array(this.buffer);
    for (let i = 0; i < workers; i++) Atomics.store(this.view, i * FIELDS, -1);
    mkdirSync(LIVE_DIR, { recursive: true });
    this.file = join(LIVE_DIR, `${process.pid}.json`);
    // A day-old file is from a run long gone.
    for (const f of readdirSync(LIVE_DIR)) {
      const p = join(LIVE_DIR, f);
      try { if (Date.now() - statSync(p).mtimeMs > 86_400_000) unlinkSync(p); } catch { /* another run's, mid-write */ }
    }
  }
  start() {
    this.timer = setInterval(() => this.write('running'), EVERY_MS);
    // The search ends when its work does, not when the feed would.
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.write('done');
  }
  private write(status: 'running' | 'done') {
    let fights = 0;
    for (let i = 0; i < this.workers; i++) fights += Atomics.load(this.view, i * FIELDS + 1);
    const now = performance.now();
    const dt = (now - this.last.t) / 1000;
    if (dt > 0) {
      const r = (fights - this.last.fights) / dt;
      // Smoothed over ~2 s: a batch lands in a lump.
      this.rate = this.rate ? 0.8 * this.rate + 0.2 * r : r;
    }
    this.last = { t: now, fights };
    const snap = this.snapshot();
    snap.workers.forEach((w, i) => {
      const at = Atomics.load(this.view, i * FIELDS);
      w.target = status === 'running' && w.kind !== 'idle' && at >= 0 ? this.targets[at] ?? null : null;
    });
    try {
      writeFileSync(this.file, JSON.stringify({
        pid: process.pid, status, startedAt: this.t0, updatedAt: Date.now(),
        fights, fightsPerSec: status === 'running' ? Math.round(this.rate) : 0, ...snap,
      }));
    } catch { /* the reader has it open (Windows): next tick */ }
  }
}
