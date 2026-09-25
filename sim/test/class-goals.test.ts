/**
 * The per-class starting goals in data/class-goals.json: hand-written, so
 * every goal must name a metric the Goals panel actually offers, or filling
 * a preset would add a row the planner cannot measure.
 *
 * Run with:  node --experimental-strip-types --test sim/test/class-goals.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  aggregate, bindBaseStatIds, defaultBaseStats, goalMetrics, goalsFromPlaystyle, goalStatus,
  rankPlaystyles, SLOTS, type Playstyle,
} from '../src/index.ts';
import type {
  BaseStats, Build, Dataset, Item, RollData, SetRecord, SlotState, StatDef,
} from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '../../data');
const load = <T>(p: string): T => JSON.parse(readFileSync(resolve(DATA, p), 'utf8')) as T;

const itemList = load<Item[]>('items/all.json');
const stats = load<StatDef[]>('stats.json');
bindBaseStatIds(stats);
const classes = load<string[]>('classes.json');
const dataset: Dataset = {
  items: new Map(itemList.map((i) => [i.id, i])),
  itemList,
  sets: load<SetRecord[]>('sets/all.json'),
  stats,
  statById: new Map(stats.map((s) => [s.id, s])),
  classes,
  classRules: null,
  rolls: load<RollData>('rolls.json'),
};

const { presets } = load<{ presets: Record<string, Playstyle[]> }>('class-goals.json');

const stats_ = (points: Partial<BaseStats>): BaseStats => ({ ...defaultBaseStats(), ...points });
const pick = (cls: string, points: Partial<BaseStats>) =>
  rankPlaystyles(presets[cls], stats_(points))[0].style.name;

test('every class has an entry, and nothing else does', () => {
  assert.deepEqual(Object.keys(presets).sort(), [...classes].sort());
});

test('every preset goal is a metric the Goals panel offers', () => {
  const offered = new Set(goalMetrics(dataset).map((m) => `${m.key}:${m.column}`));
  const missing: string[] = [];
  for (const [cls, styles] of Object.entries(presets)) {
    for (const s of styles) {
      for (const g of s.goals) {
        if (!offered.has(`${g.key}:${g.column}`)) missing.push(`${cls} / ${s.name}: ${g.key}:${g.column}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('a playstyle names each goal once, and has a name and a reason', () => {
  for (const [cls, styles] of Object.entries(presets)) {
    const names = new Set<string>();
    for (const s of styles) {
      assert.ok(s.name && s.basis, `${cls}: a playstyle is missing its name or basis`);
      assert.ok(!names.has(s.name), `${cls}: "${s.name}" twice`);
      names.add(s.name);
      assert.ok(s.goals.length > 0, `${cls} / ${s.name}: no goals`);
      const keys = s.goals.map((g) => `${g.key}:${g.column}`);
      assert.equal(new Set(keys).size, keys.length, `${cls} / ${s.name}: a goal repeats`);
    }
  }
});

test('a character with nothing spent is offered the listed default', () => {
  for (const [cls, styles] of Object.entries(presets)) {
    if (styles.length === 0) continue;
    assert.equal(pick(cls, {}), styles[0].name, cls);
  }
});

test('Satsujin: STR over INT is the melee build, INT over STR the magic one', () => {
  assert.equal(pick('Satsujin', { str: 40, int: 20 }), 'Moon (AGI/flee)');
  assert.equal(pick('Satsujin', { agi: 90, str: 20, int: 10 }), 'Moon (AGI/flee)');
  assert.equal(pick('Satsujin', { str: 10, int: 60, dex: 40 }), 'Darkness magic (INT)');
});

test('Night Raven: high STR counters, low STR and high LUK auto-attacks', () => {
  assert.equal(pick('Night Raven', { str: 90, agi: 70, luk: 30 }), 'Counter Slash / Typhoon (STR)');
  assert.equal(pick('Night Raven', { str: 1, agi: 60, luk: 100, dex: 40 }), 'Raven auto-attack (LUK)');
});

test('goals from a playstyle start met, in the playstyle\'s order, bar a set target', () => {
  const slots: Record<string, SlotState> = {};
  for (const s of SLOTS) slots[s.key] = { itemId: null, refine: 0, cards: [] };
  const build: Build = {
    className: 'Satsujin', baseLevel: 100, baseStats: stats_({ agi: 90, str: 30 }), slots,
  };
  const totals = aggregate(build, dataset);
  const style = presets.Satsujin[0];
  const goals = goalsFromPlaystyle(style, build, totals, dataset);
  assert.deepEqual(goals.map((g) => g.key), style.goals.map((g) => g.key));
  const status = goalStatus(goals, totals, build, dataset);
  // Penetration is the one goal with a number of its own, and a naked
  // character is short of it; everything else starts where the build is.
  assert.deepEqual(status.filter((s) => !s.met).map((s) => s.goal.key), ['def_pen']);
  assert.equal(goals.find((g) => g.key === 'def_pen')?.target, 25);
  assert.equal(goals.find((g) => g.key === 'def_pen')?.cap, 70);
  assert.ok(goals.every((g) => g.open), 'a preset target is a starting line, not a stopping point');
  assert.equal(goals.find((g) => g.key === 'agi')?.target, 90);
});

test('every damage playstyle chases penetration to 25 and on to 70, right after its main stat', () => {
  for (const [cls, styles] of Object.entries(presets)) {
    if (cls === 'Orphan') continue;
    for (const s of styles) {
      const at = s.goals.findIndex((g) => g.key === 'def_pen' || g.key === 'mdef_pen');
      // Right after the main stat -- or after the damage chain, where the
      // project owner ranks it above penetration (melee% for a physical
      // Satsujin, 2026-09-25).
      const chained = at === 2 && /_dmg_mult$/.test(s.goals[1].key);
      assert.ok(at === 1 || chained, `${cls} / ${s.name}`);
      assert.equal(s.goals[at].target, 25, `${cls} / ${s.name}`);
      assert.equal(s.goals[at].cap, 70, `${cls} / ${s.name}`);
    }
  }
});

test('Satsujin starts on the stats every piece feeds: STR and AGI, SP cost, no skill lines', () => {
  const [moon, magic] = presets.Satsujin;
  const keys = (s: typeof moon) => s.goals.map((g) => g.key);
  assert.ok(keys(moon).includes('agi') && keys(moon).includes('str'));
  for (const style of [moon, magic]) {
    // Solved at -50%: past that, more is worth nothing, so a plan does not
    // stack one SP cost piece on another.
    assert.ok(style.goals.some((g) => g.key === 'sp_cost' && g.atMost && g.cap === -50), style.name);
    assert.ok(!keys(style).some((k) => k.startsWith('skill:')), style.name);
  }
});
