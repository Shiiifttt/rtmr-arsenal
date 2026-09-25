/**
 * The background suggestion search: that it hands back what it has as it
 * goes, stops when paused without losing its place, and picks up again on
 * the same request.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PlanRunner, type PlanMessage, type PlanRequest } from '../src/planjobs.ts';
import type { PlanPaths, Suggester } from '@sim';

const empty = { near: [], cards: [], refines: [], rolls: [], far: [], sides: [], farm: [], sets: [] };
/** A stand-in suggester whose search yields `n` snapshots, counting its own progress. */
function fake(n: number) {
  const progress = { made: 0 };
  const s = {
    *paths(): Generator<PlanPaths> {
      for (let i = 1; i <= n; i++) {
        progress.made = i;
        yield { ...empty, steps: Array.from({ length: i }, () => ({}) as never) };
      }
    },
  } as unknown as Suggester;
  return { s, progress };
}
const req = (key: string): PlanRequest => ({ key, build: {} as never, goals: [], opts: {} as never });
const turns = (n = 1) => new Promise((r) => setTimeout(r, n));

test('the search reports each piece as it lands, and finishes', async () => {
  const { s } = fake(3);
  const got: PlanMessage[] = [];
  const runner = new PlanRunner((m) => got.push(m), () => s);
  runner.run(req('a'));
  for (let i = 0; i < 10 && !got.some((m) => m.type === 'paths' && m.done); i++) await turns();
  const paths = got.filter((m): m is Extract<PlanMessage, { type: 'paths' }> => m.type === 'paths');
  assert.deepEqual(paths.map((m) => m.paths.steps.length), [1, 2, 3, 3]);
  assert.equal(paths.at(-1)!.done, true);
});

test('pausing keeps its place, and the same request resumes it', async () => {
  const { s, progress } = fake(50);
  const got: PlanMessage[] = [];
  const runner = new PlanRunner((m) => got.push(m), () => s);
  runner.run(req('a'));
  for (let i = 0; i < 5; i++) await turns();
  runner.pause();
  await turns();
  const stopped = progress.made;
  assert.ok(stopped > 0 && stopped < 50);
  for (let i = 0; i < 5; i++) await turns();
  assert.equal(progress.made, stopped, 'nothing runs while paused');

  got.length = 0;
  runner.run(req('a'));
  // What it had is sent straight back, then it carries on from there.
  assert.equal(got[0].type === 'paths' && got[0].paths.steps.length, stopped);
  await turns(); await turns();
  assert.ok(progress.made > stopped);
});

test('a new request takes over; the old one waits, paused, where it was', async () => {
  const a = fake(50);
  const b = fake(50);
  const runner = new PlanRunner(() => {}, (r) => (r.key === 'a' ? a.s : b.s));
  runner.run(req('a'));
  for (let i = 0; i < 3; i++) await turns();
  runner.run(req('b'));
  const at = a.progress.made;
  for (let i = 0; i < 3; i++) await turns();
  assert.equal(a.progress.made, at);
  assert.ok(b.progress.made > 0);
});
