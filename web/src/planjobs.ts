import type { Build, Goal, PlanPaths, Suggester, SuggestOptions } from '@sim';

/**
 * Suggestions worked out a little at a time, and kept.
 *
 * A full "Suggest changes" is seconds of work -- a plan step alone scores
 * every piece and card for every slot -- and done in one go it froze the
 * page until it was all there. So the search is a generator
 * (`Suggester.paths`) that hands back what it has after each section, and
 * this steps it one piece at a time, giving the page (or the worker's
 * message queue) a turn between pieces. Whatever has been found shows at
 * once, and more appears the longer the overlay stays open.
 *
 * Jobs are kept by what they were asked -- the build, its goals, the options
 * -- so closing the overlay pauses the search rather than throwing it away,
 * and opening it again on the same build picks up where it stopped. Only in
 * memory: a reload starts over, which is a second or two, not worth storing.
 */

/** A search to run: which build, judged how. */
export interface PlanRequest {
  key: string;
  build: Build;
  goals: Goal[];
  opts: SuggestOptions;
}

/** What a search has found so far. */
export interface PlanState {
  paths: PlanPaths | null;
  done: boolean;
}

export type PlanMessage =
  | { type: 'paths'; key: string; paths: PlanPaths; done: boolean }
  | { type: 'error'; key: string; message: string };

/**
 * The identity of a search: everything that changes what it would find.
 * Two requests with the same key are the same search, so the second
 * resumes the first rather than starting again.
 */
export function planKey(build: Build, suggester: Suggester): string {
  const { className, baseLevel, baseStats, slots, locked } = build;
  return JSON.stringify({
    build: { className, baseLevel, baseStats, slots, locked },
    goals: suggester.goals,
    opts: suggester.options,
  });
}

/** How many searches are kept to resume; the oldest are dropped first. */
const KEPT = 4;

interface Job {
  gen: Iterator<PlanPaths> | null;
  pending: Promise<void> | null;
  latest: PlanPaths | null;
  done: boolean;
}

/**
 * Runs searches one piece per turn, for the worker or for the page itself.
 *
 * `suggesterFor` builds the suggester a request needs -- in the worker from
 * its own copy of the dataset, on the page from the one already there.
 * Only the most recent request runs; the others wait, paused, in case their
 * build comes back.
 */
export class PlanRunner {
  private readonly jobs = new Map<string, Job>();
  private active: string | null = null;
  private scheduled = false;
  private readonly post: (msg: PlanMessage) => void;
  private readonly suggesterFor: (req: PlanRequest) => Suggester | Promise<Suggester>;

  constructor(
    post: (msg: PlanMessage) => void,
    suggesterFor: (req: PlanRequest) => Suggester | Promise<Suggester>,
  ) {
    this.post = post;
    this.suggesterFor = suggesterFor;
  }

  run(req: PlanRequest): void {
    this.active = req.key;
    let job = this.jobs.get(req.key);
    if (job) {
      // Most recently used last, so the oldest is the one dropped.
      this.jobs.delete(req.key);
      this.jobs.set(req.key, job);
      if (job.latest) this.post({ type: 'paths', key: req.key, paths: job.latest, done: job.done });
    } else {
      job = { gen: null, pending: null, latest: null, done: false };
      this.jobs.set(req.key, job);
      const made = job;
      made.pending = Promise.resolve(this.suggesterFor(req)).then((s) => {
        made.gen = s.paths(req.build);
        made.pending = null;
        this.schedule();
      }, (e: unknown) => {
        made.done = true;
        this.post({ type: 'error', key: req.key, message: String(e) });
      });
      while (this.jobs.size > KEPT) this.jobs.delete(this.jobs.keys().next().value!);
    }
    this.schedule();
  }

  /** Stop working, keeping everything found so far and where it had got to. */
  pause(): void {
    this.active = null;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    // A macrotask, not a microtask: the point is to let the page, or the
    // worker's inbox, have its turn before the next piece of work.
    setTimeout(() => {
      this.scheduled = false;
      this.tick();
    }, 0);
  }

  private tick(): void {
    const key = this.active;
    const job = key ? this.jobs.get(key) : undefined;
    if (!key || !job || job.done || !job.gen) return;
    try {
      const step = job.gen.next();
      if (step.done) job.done = true;
      else job.latest = step.value;
    } catch (e) {
      job.done = true;
      this.post({ type: 'error', key, message: String(e) });
      return;
    }
    if (job.latest) this.post({ type: 'paths', key, paths: job.latest, done: job.done });
    if (!job.done) this.schedule();
  }
}
