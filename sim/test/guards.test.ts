/**
 * Guard rails: the floors a suggestion may not drop a build below.
 *
 * These exist because the scoring used to be happy to trade most of a
 * character's HP or SP for a few points of whatever was being chased. The
 * tests are about the two halves of that: that crossing a line costs a
 * suggestion more than the gain is worth, and that a guard which holds
 * costs the goals above it nothing at all.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  aggregate, allGoals, bindBaseStatIds, brokenGoals, DEFAULT_GUARDS, defaultBaseStats,
  goalMetrics, goalScore, goalStatus, guardsOf, measure, SLOTS, SP_SUSTAIN,
} from '../src/index.ts';
import type {
  Build, Dataset, Goal, Item, RollData, SetRecord, SlotState, StatDef,
} from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '../../data');
const load = <T>(p: string): T => JSON.parse(readFileSync(resolve(DATA, p), 'utf8')) as T;

const itemList = load<Item[]>('items/all.json');
const stats = load<StatDef[]>('stats.json');
bindBaseStatIds(stats);
const dataset: Dataset = {
  items: new Map(itemList.map((i) => [i.id, i])),
  itemList,
  sets: load<SetRecord[]>('sets/all.json'),
  stats,
  statById: new Map(stats.map((s) => [s.id, s])),
  classes: load<string[]>('classes.json'),
  classRules: null,
  rolls: load<RollData>('rolls.json'),
};

function emptyBuild(): Build {
  const slots: Record<string, SlotState> = {};
  for (const s of SLOTS) slots[s.key] = { itemId: null, refine: 0, cards: [] };
  return { className: null, baseLevel: 150, baseStats: defaultBaseStats(), slots };
}

const HP_GUARD: Goal = { key: 'max_hp', column: 'percent', target: -50, guard: true };
const SP_GUARD: Goal = { key: SP_SUSTAIN, column: 'total', target: -50, guard: true };
const CRIT: Goal = { key: 'crit', column: 'flat', target: 40 };

test('a fresh build is guarded, and every guard is a real metric', () => {
  const guards = guardsOf(emptyBuild());
  assert.deepEqual(guards, DEFAULT_GUARDS);
  assert.ok(guards.every((g) => g.guard));

  const metrics = goalMetrics(dataset);
  for (const g of guards) {
    assert.ok(metrics.some((m) => m.key === g.key && m.column === g.column),
      `${g.key} should be offerable as a goal too`);
  }
});

test('a build that has said so keeps its own guards, empty included', () => {
  assert.deepEqual(guardsOf({ ...emptyBuild(), guards: [] }), []);
  const mine: Goal[] = [{ key: 'max_hp', column: 'percent', target: -20 }];
  assert.deepEqual(guardsOf({ ...emptyBuild(), guards: mine }), [{ ...mine[0], guard: true }]);
});

test('guards go after the goals, so they cannot shift a priority', () => {
  const build = { ...emptyBuild(), goals: [CRIT] };
  const all = allGoals(build);
  assert.equal(all[0], CRIT);
  assert.deepEqual(all.slice(1), DEFAULT_GUARDS);
});

test('a guard that holds counts for nothing, however far clear it is', () => {
  const goals = [CRIT, HP_GUARD];
  // Same crit, wildly different HP -- both comfortably above the floor.
  const barely = goalScore(goals, [40, -49]);
  const clear = goalScore(goals, [40, 0]);
  const rich = goalScore(goals, [40, 300]);
  assert.equal(barely, clear);
  assert.equal(clear, rich);

  // So a guard never outbids a goal: more HP is not a reason to take a
  // piece, where an ordinary goal on the same stat would be.
  const asGoal: Goal[] = [CRIT, { key: 'max_hp', column: 'percent', target: -50 }];
  assert.ok(goalScore(asGoal, [40, 300]) < goalScore(asGoal, [40, 0]));
});

test('going well past a guard costs more than the best goal is worth', () => {
  const goals = [CRIT, HP_GUARD];
  // The crit never taken, and the HP left alone.
  const kept = goalScore(goals, [0, 0]);
  // The whole crit goal, bought by gutting Max HP.
  const traded = goalScore(goals, [40, -90]);
  assert.ok(traded > kept,
    `-90% HP for the whole crit goal should score worse (${traded} vs ${kept})`);

  // The exchange rate, stated: at twice a top goal's weight, going past the
  // floor by half its own scale is worth exactly one whole goal. Below that
  // the score can be talked round; above it, it cannot.
  assert.equal(goalScore(goals, [40, -75]), kept);
});

test('a guard breach is reported as a broken goal, so a plan will not do it', () => {
  const goals = [CRIT, HP_GUARD];
  assert.deepEqual(brokenGoals(goals, [0, -10], [40, -60]), [HP_GUARD]);
  // Still above the line: not broken, whatever it cost.
  assert.deepEqual(brokenGoals(goals, [0, -10], [40, -49]), []);
});

test('SP sustain weighs the pool against what a cast costs', () => {
  const build = emptyBuild();
  const read = (sp: number, cost: number) => {
    const totals = aggregate(build, dataset);
    const id = (key: string) => stats.find((s) => s.key === key)!.id;
    totals.byStat.set(id('max_sp'),
      { statId: id('max_sp'), flat: 0, percent: sp, sources: [] });
    totals.byStat.set(id('sp_cost'),
      { statId: id('sp_cost'), flat: 0, percent: cost, sources: [] });
    return measure(SP_GUARD, totals, build, dataset);
  };

  assert.equal(Math.round(read(0, 0)), 0);
  // Half the pool is half the casts.
  assert.equal(Math.round(read(-50, 0)), -50);
  // Half the pool at half the cost is the same number of casts as before,
  // which is the whole reason this is guarded instead of Max SP itself.
  assert.equal(Math.round(read(-50, -50)), 0);
  // Cheaper casts on their own are a gain.
  assert.equal(Math.round(read(0, -50)), 100);
  // And a cost increase eats into the pool.
  assert.ok(read(0, 100) < -49);
});

test('the guards read off a real build, and a shadow set moves them', () => {
  const build = emptyBuild();
  const pendant = itemList.find((i) => i.name === 'Fallen Gods Pendant')!;
  build.slots.sh_acc = { itemId: pendant.id, refine: 10, cards: [] };

  const [hp] = goalStatus([HP_GUARD], aggregate(build, dataset), build, dataset);
  // -2% Max HP per refine, so +10 is -20%: still inside the floor, and the
  // guard should say so rather than reading as a failure.
  assert.equal(hp.value, -20);
  assert.equal(hp.met, true);
});
