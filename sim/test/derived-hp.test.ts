/**
 * Max HP and Max SP in the derived totals: the class's server job table,
 * VIT / INT, the HP skills, then gear flat and percent, under the codex caps.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregate, BASE_LEVEL_DEFAULT, bindBaseStatIds, defaultBaseStats, FORMULAS, jobPool, LIVE_HP_FIX, SLOTS,
} from '../src/index.ts';
import type {
  Build, ClassRules, Dataset, Item, JobTables, SetRecord, SlotState, StatDef,
} from '../src/types.ts';

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');
const load = <T>(p: string): T => JSON.parse(readFileSync(resolve(DATA, p), 'utf8')) as T;

const itemList = load<Item[]>('items/all.json');
const stats = load<StatDef[]>('stats.json');
bindBaseStatIds(stats);
const jobs = load<JobTables>('jobs.json');
const dataset: Dataset = {
  items: new Map(itemList.map((i) => [i.id, i])),
  itemList,
  sets: load<SetRecord[]>('sets/all.json'),
  stats,
  statById: new Map(stats.map((s) => [s.id, s])),
  classes: load<string[]>('classes.json'),
  classRules: load<ClassRules>('class-rules.json'),
  rolls: null,
  jobs,
};

function build(className: string, extra: Partial<Record<string, SlotState>> = {}): Build {
  const slots: Record<string, SlotState> = {};
  for (const s of SLOTS) slots[s.key] = { itemId: null, refine: 0, cards: [] };
  return {
    className,
    baseLevel: 135,
    baseStats: { ...defaultBaseStats(), vit: 99, int: 49 },
    slots: { ...slots, ...extra } as Record<string, SlotState>,
  };
}
const byName = (n: string) => itemList.find((i) => i.name === n)!;
const hpOf = (b: Build) => aggregate(b, dataset).derived.find((d) => d.key === 'max_hp');

test('Max HP: the job table, VIT and Improve Defense, before any gear', () => {
  assert.equal(jobs.classes.Kingslayer, 'Shadow_Chaser');
  const hp = hpOf(build('Kingslayer'))!;
  // 4,620 base at 135 x (1 + 99%) x 1.25, + Improve Defense 10 x 135.
  assert.equal(hp.base, jobPool(4620, 99, LIVE_HP_FIX.Shadow_Chaser) + 10 * 135);
  assert.equal(hp.total, hp.base);
});

test('Max HP: Shield Mastery with a shield, then gear percent on top', () => {
  const shield = { itemId: byName('Battle Glory Shield').id, refine: 0, cards: [] };
  const withShield = hpOf(build('Kingslayer', { offhand: shield }))!;
  assert.equal(withShield.base, jobPool(4620, 99, LIVE_HP_FIX.Shadow_Chaser) + 10 * 135 + 25 * 10);

  // Rhyncho Card (Max HP +10%) in an Angel Helm: percent on the whole figure.
  const geared = hpOf(build('Kingslayer', {
    upper: { itemId: byName('Angel Helm').id, refine: 0, cards: [byName('Rhyncho Card').id] },
  }))!;
  assert.ok(geared.percent >= 10, `${geared.percent}`);
  assert.equal(geared.total, Math.floor((geared.base + geared.flat) * (1 + geared.percent / 100)));
});

test('Max HP is capped at 50,000, and raised by two Valhalla Knight Cards', () => {
  const f = FORMULAS.find((x) => x.key === 'max_hp')!;
  const ctx = { skills: {}, shield: false, worn: [] as string[] };
  assert.equal(f.cap!(ctx), 50_000);
  assert.equal(f.cap!({ ...ctx, worn: ['Valhalla Knight Card', 'Valhalla Knight Card'] }), 55_000);
  assert.equal(f.cap!({ ...ctx, worn: ['Valhalla Knight Card', 'Valhalla Knight Card', "Heimdall's Legacy"] }), 65_000);
});

test('Max SP from the job table and INT; a class with no known job shows neither', () => {
  const sp = aggregate(build('Kingslayer'), dataset).derived.find((d) => d.key === 'max_sp')!;
  assert.ok(sp.base > 0);
  const unknown = aggregate(build('Bouncer'), dataset).derived.map((d) => d.key);
  assert.ok(!unknown.includes('max_hp') && !unknown.includes('max_sp'));
});
