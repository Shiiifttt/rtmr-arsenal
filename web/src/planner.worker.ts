/// <reference lib="webworker" />
import { Suggester, type Dataset } from '@sim';
import { loadDataset } from './data';
import { PlanRunner, type PlanMessage, type PlanRequest } from './planjobs';

/**
 * The suggestion search, off the page.
 *
 * It keeps its own copy of the dataset, loaded once from the same files the
 * page loads, so a search costs the page nothing but the messages that come
 * back. See planjobs.ts for how the work is paced and kept.
 */

type Inbound =
  | { type: 'init'; base: string }
  | ({ type: 'run' } & PlanRequest)
  | { type: 'pause' };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let dataset: Promise<Dataset> | null = null;

const runner = new PlanRunner(
  (msg: PlanMessage) => scope.postMessage(msg),
  async (req) => new Suggester(await dataset!, req.goals, req.opts),
);

scope.onmessage = (e: MessageEvent<Inbound>) => {
  const msg = e.data;
  if (msg.type === 'init') dataset = loadDataset(msg.base);
  else if (msg.type === 'run') runner.run(msg);
  else runner.pause();
};
