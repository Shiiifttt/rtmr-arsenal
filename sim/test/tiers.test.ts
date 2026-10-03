/**
 * The tier path (presets.ts tierGoals / goalProgress / tierStanding): a
 * playstyle's goals aimed at the combat sim's budget, baseline and maxed
 * builds, and where a build stands on the way (the project owner,
 * 2026-10-02: start at budget values, build up to baseline, then maxed).
 *
 * Run with:  node --experimental-strip-types --test sim/test/tiers.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  aggregate, bindBaseStatIds, defaultBaseStats, goalProgress, measure, tierGoals, tierStanding, TIER_REACHED, type Playstyle,
} from '../src/index.ts';
import type { Build, Dataset, Item, RollData, SetRecord, StatDef } from '../src/types.ts';

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

// Base stats only: the goals here read STR and AGI totals, which need no gear.
const style: Playstyle = {
  name: 'test', confidence: 'guess', basis: '',
  goals: [{ key: 'str', column: 'total' }, { key: 'agi', column: 'total' }, { key: 'skill:Counter Slash|damage', column: 'percent' }],
};
const at = (str: number, agi: number): Build => ({
  className: 'Night Raven', baseLevel: 130, baseStats: { ...defaultBaseStats(), str, agi }, slots: {},
});
const tiers = { budget: at(60, 60), baseline: at(80, 90), maxed: at(99, 120) };

test("a tier's targets are what its build has; a goal it has none of is left out", () => {
  const goals = tierGoals(style, tiers.baseline, dataset);
  assert.deepEqual(goals.map((g) => g.key), ['str', 'agi']);
  const totals = aggregate(tiers.baseline, dataset);
  for (const g of goals) assert.equal(g.target, measure(g, totals, tiers.baseline, dataset));
});

test("a build is all the way to its own tier, and partway to a richer one", () => {
  const b = tiers.budget;
  const totals = aggregate(b, dataset);
  assert.equal(goalProgress(tierGoals(style, b, dataset), totals, b, dataset), 1);
  const toMaxed = goalProgress(tierGoals(style, tiers.maxed, dataset), totals, b, dataset);
  assert.ok(toMaxed > 0.3 && toMaxed < TIER_REACHED, `${toMaxed}`);
});

test('the next tier is the first not reached: budget for a fresh character, then baseline, then maxed', () => {
  const next = (b: Build) => tierStanding(style, tiers, b, aggregate(b, dataset), dataset).next;
  assert.equal(next(at(20, 20)), 'budget');
  assert.equal(next(tiers.budget), 'baseline');
  assert.equal(next(tiers.baseline), 'maxed');
  // Past every tier, still aimed at maxed: nothing beyond it.
  assert.equal(next(at(99, 130)), 'maxed');
});
