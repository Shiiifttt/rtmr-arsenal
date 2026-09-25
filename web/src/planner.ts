import { useEffect, useState } from 'react';
import type { Build, Suggester } from '@sim';
import { PlanRunner, type PlanMessage, type PlanRequest, type PlanState } from './planjobs';

/**
 * The page's end of the suggestion search: start, pause, and listen.
 *
 * The search runs in a worker when the browser has one, so the page never
 * waits on it; failing that it runs here, a piece per turn, which is slower
 * to finish but still never freezes the page. Either way what has been
 * found is kept per search (see `planKey`), so the overlay can close and
 * reopen onto the same results.
 */

const states = new Map<string, PlanState>();
const listeners = new Map<string, Set<() => void>>();

function receive(msg: PlanMessage) {
  const was = states.get(msg.key);
  states.set(msg.key, msg.type === 'paths'
    ? { paths: msg.paths, done: msg.done }
    : { paths: was?.paths ?? null, done: true });
  if (msg.type === 'error') console.error('suggestion search failed:', msg.message);
  for (const fn of listeners.get(msg.key) ?? []) fn();
}

let worker: Worker | null | undefined;
/** The latest request, to run again on the page if the worker dies. */
let lastRun: { key: string; build: Build; suggester: Suggester } | null = null;
/** Used when there is no worker: the page's own suggester, run here. */
let local: { runner: PlanRunner; suggesters: Map<string, Suggester> } | null = null;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<PlanMessage>) => receive(e.data);
    worker.onerror = () => {
      // A worker that cannot start (a blocked script, an old browser) falls
      // back to the page, for this and every later search.
      worker?.terminate();
      worker = null;
      if (lastRun) runPlan(lastRun.key, lastRun.build, lastRun.suggester);
    };
    worker.postMessage({ type: 'init', base: new URL('./data', document.baseURI).href });
  } catch {
    worker = null;
  }
  return worker;
}

/** Start or resume the search for this build; results arrive through `usePlan`. */
export function runPlan(key: string, build: Build, suggester: Suggester): void {
  lastRun = { key, build, suggester };
  const req: PlanRequest = { key, build, goals: suggester.goals, opts: suggester.options };
  const w = getWorker();
  if (w) {
    w.postMessage({ type: 'run', ...req });
    return;
  }
  if (!local) {
    const suggesters = new Map<string, Suggester>();
    local = { suggesters, runner: new PlanRunner(receive, (r) => suggesters.get(r.key)!) };
  }
  local.suggesters.set(key, suggester);
  // Only read when a search starts, so the old ones need not be kept.
  while (local.suggesters.size > 4) local.suggesters.delete(local.suggesters.keys().next().value!);
  local.runner.run(req);
}

/** Stop searching, keeping what has been found and where it had got to. */
export function pausePlan(): void {
  lastRun = null;
  worker?.postMessage({ type: 'pause' });
  local?.runner.pause();
}

/** What the search for `key` has found so far; re-renders as more comes in. */
export function usePlan(key: string | null): PlanState {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!key) return;
    const fn = () => bump((n) => n + 1);
    let set = listeners.get(key);
    if (!set) listeners.set(key, set = new Set());
    set.add(fn);
    return () => { set!.delete(fn); };
  }, [key]);
  return (key && states.get(key)) || { paths: null, done: false };
}
