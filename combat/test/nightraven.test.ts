/**
 * The Night Raven kit (2026-10-01, tooltips + patch notes + the 2023 code,
 * no owner readings yet) and what it brought into the engine: Weapon
 * Blocking's block -> Counter state, dual-wield ASPD by weapon type, the
 * auto Blitz Beat, Night Wound, Rolling Counters.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFighter, type Profile } from '../src/character.ts';
import { findMobs } from '../src/data.ts';
import { newFight, run, stacks } from '../src/engine.ts';
import { sizeFix } from '../src/formulas.ts';
import type { MobSkill } from '../src/model.ts';
import { buildMonster, dummyMonster } from '../src/monster.ts';
import { priorityPolicy } from '../src/tas.ts';
import { autoBlitzChance, maxLevels, nightraven, passives } from '../src/kits/nightraven.ts';

const ASPD = { base: 64, mastery: 26, byType: { Dagger: 64, Sword: 69 } };
const profile = (offhand: string, stats = { str: 90, agi: 99, vit: 35, int: 1, dex: 87, luk: 1 }): Profile => ({
  build: {
    className: 'Night Raven', baseLevel: 130, baseStats: stats,
    slots: { weapon: { item: 'Knife' }, offhand: { item: offhand } },
  },
  aspdModel: ASPD,
});
const fighter = (p: Profile) => buildFighter(p, { passives, aliases: {}, maxLevels: maxLevels() });

test('swords take their size penalty: "Sword" is the server 1hSword', () => {
  assert.equal(sizeFix('Sword', 'Small', false), 0.9);
  assert.equal(sizeFix('Sword', 'Medium', false), 1);
  assert.equal(sizeFix('Axe', 'Small', false), 0.7);
});

test('dual-wield ASPD: the right weapon\'s delay plus a quarter of the left\'s, less AGI/20', async () => {
  const dd = await fighter(profile('Knife'));
  const ds = await fighter(profile('Sword'));
  // 64 + 64/4 = 80 against 64 + 69/4 = 81: one more delay point, the sword pair is slower.
  assert.ok(ds.aspd <= dd.aspd, `${ds.aspd} vs ${dd.aspd}`);
  assert.ok(dd.aspd > 150 && dd.aspd < 180, `${dd.aspd}`);
});

test('the auto Blitz Beat: 1% per 5 LUK with Dagger + Sword only, x4 under Rising Wings', async () => {
  const luk = { str: 1, agi: 90, vit: 25, int: 1, dex: 92, luk: 99 };
  const ds = await fighter(profile('Sword', luk));
  const dd = await fighter(profile('Knife', luk));
  assert.equal(autoBlitzChance(dd, true), 0);
  assert.ok(Math.abs(autoBlitzChance(ds, false) - (2 * ds.stats.luk + 2) / 1000) < 1e-9);
  assert.ok(Math.abs(autoBlitzChance(ds, true) - Math.min(1, 4 * (2 * ds.stats.luk + 2) / 1000)) < 1e-9);
});

test('Counter state: Counter Slash climbs a hit a cast to 6 and the stacks stop at 5', async () => {
  const f = await fighter(profile('Knife'));
  const fight = newFight(f, dummyMonster(), nightraven, priorityPolicy, {
    seed: 1, limitMs: 8_000, log: true,
    options: { order: ['Counter Slash', 'Attack'], weaponBlock: false, risingWings: false, hallucination: false },
  });
  fight.me.buffs.counter = { until: 1e9, stacks: 1 };
  run(fight);
  const casts = fight.log!.filter((l) => /Counter Slash →/.test(l));
  assert.ok(casts.length >= 6, `${casts.length} casts`);
  const shown = casts.map((l) => Number(/\((\d+) hits/.exec(l)?.[1] ?? 1));
  assert.deepEqual(shown.slice(0, 6), [1, 2, 3, 4, 5, 6]);
  assert.equal(stacks(fight, 'rolling'), 5);
});

test('Weapon Blocking cancels normal attacks and puts you in Counter state', async () => {
  const f = await fighter(profile('Knife'));
  const m = { ...buildMonster(findMobs('Angel of Genesis')[0]), skills: [] as MobSkill[], hit: 5000 };
  const fight = newFight(f, m, nightraven, priorityPolicy, {
    seed: 2, limitMs: 8_000, log: true,
    options: { order: ['Weapon Blocking', 'Wait'], defense: 'none' },
  });
  run(fight);
  assert.ok(fight.log!.some((l) => /Weapon Blocking\)/.test(l)), 'a hit was blocked');
  assert.ok((fight.me.buffs.counter?.until ?? -1) > 0, 'Counter state came from it');
});

test('Definitive Dagger: 45% a level with two daggers, Night Wound +50% +1% per DEX', async () => {
  const f = await fighter(profile('Knife'));
  const one = (wound: boolean) => {
    const fight = newFight(f, dummyMonster(), nightraven, priorityPolicy, {
      seed: 3, limitMs: 400, log: true,
      options: { order: ['Definitive Dagger'], weaponBlock: false, risingWings: false, hallucination: false, enchantPoison: false },
    });
    fight.rng.expect = true;
    if (wound) fight.mob.debuffs.nightWound = { until: 1e9, stacks: 1, value: 10 };
    run(fight);
    return fight.meter!.actions['Definitive Dagger'].damage;
  };
  const base = 100 + 45 * 10 + 2 * f.stats.agi;
  const ratio = one(true) / one(false);
  assert.ok(Math.abs(ratio - (base + 50 + f.stats.dex) / base) < 0.01, `${ratio}`);
});

test('Typhoon Edge triples on a target that cannot be knocked back', async () => {
  const f = await fighter(profile('Knife'));
  const one = (knockback: boolean) => {
    const fight = newFight(f, dummyMonster(), nightraven, priorityPolicy, {
      seed: 4, limitMs: 400,
      options: { order: ['Typhoon Edge'], knockback, typhoonPush: true, weaponBlock: false, risingWings: false, hallucination: false },
    });
    fight.rng.expect = true;
    run(fight);
    return fight.meter!.actions['Typhoon Edge'].damage;
  };
  assert.ok(Math.abs(one(false) / one(true) - 3) < 0.01);
});

test('gear data the Night Raven searches need: the Sin Daggers set, Gravewhisper + Skull Mask, the Revenant-only card', async () => {
  const { plannerDataset } = await import('../src/data.ts');
  const { canEquip } = await import('../../sim/src/index.ts');
  const d = plannerDataset();
  const sin = d.sets.find((s) => s.name === 'Sin Daggers');
  assert.ok(sin && sin.member_count === 2, 'Sin Daggers set exists (crawler/overrides.json)');
  assert.ok(sin!.set_bonus.some((b) => b.text === 'Definitive Dagger Cooldown -0.5s' && b.parsed));
  assert.ok(d.sets.some((s) => s.name === 'Skull Mask (Gravewhisper)'));
  const ebel = d.itemList.find((i) => i.name === 'Revenant Ebel Card')!;
  assert.equal(canEquip(ebel, 'Night Raven', d.classRules), false);
  assert.equal(canEquip(ebel, 'Revenant', d.classRules), true);
});

test("Ogretooth's ASPD Limit +2 is its own line (crawler/overrides.json)", async () => {
  const { plannerDataset } = await import('../src/data.ts');
  const o = plannerDataset().itemList.find((i) => i.name === 'Ogretooth') as { effects?: { text: string; stat_keys?: string[] | null }[] };
  assert.ok(o.effects?.some((e) => e.text === 'ASPD Limit +2' && e.stat_keys?.includes('aspd_limit')));
});
