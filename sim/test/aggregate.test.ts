/**
 * Checks on the parts of the aggregation that are easy to get quietly wrong:
 * per-N refine steps, set completion, and set refine being summed across the
 * set rather than read off one piece.
 *
 * Run with:  node --experimental-strip-types --test sim/test/aggregate.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  aggregate, BASE_LEVEL_DEFAULT, BASE_STAT_MAX, BASE_STAT_MIN, bindBaseStatIds,
  BASE_STAT_KEYS, baseFlee, clampBaseStat, combine, compoundPercent, defaultBaseStats,
  derivedStats, fleeFromAgi,
  fitsSlot, maxRefine, MAX_REFINE, SLOTS,
} from '../src/index.ts';
import type {
  Build, Dataset, Item, RollData, SetRecord, SlotState, StatDef, StatTotal,
} from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '../../data');

function load<T>(p: string): T {
  return JSON.parse(readFileSync(resolve(DATA, p), 'utf8')) as T;
}

const itemList = load<Item[]>('items/all.json');
const sets = load<SetRecord[]>('sets/all.json');
const stats = load<StatDef[]>('stats.json');
bindBaseStatIds(stats);

const dataset: Dataset = {
  items: new Map(itemList.map((i) => [i.id, i])),
  itemList,
  sets,
  stats,
  statById: new Map(stats.map((s) => [s.id, s])),
  classes: load<string[]>('classes.json'),
  classRules: null,
  rolls: load<RollData>('rolls.json'),
};

const statId = (key: string) => stats.find((s) => s.key === key)!.id;

function emptyBuild(): Build {
  const slots: Record<string, SlotState> = {};
  for (const s of SLOTS) slots[s.key] = { itemId: null, refine: 0, cards: [] };
  return {
    className: null,
    baseLevel: BASE_LEVEL_DEFAULT,
    baseStats: defaultBaseStats(),
    slots,
  };
}

test('a card in a weapon contributes its effect', () => {
  const weapon = itemList.find((i) => i.kind === 'Weapon' && i.card_slots > 0)!;
  // Abysmal Knight Card: DMG vs Bosses +10%
  const card = dataset.items.get(4140)!;

  const build = emptyBuild();
  build.slots.weapon = { itemId: weapon.id, refine: 0, cards: [card.id] };

  const totals = aggregate(build, dataset);
  const boss = totals.byStat.get(statId('dmg_vs_race_boss'));
  assert.ok(boss, 'expected a DMG vs Boss total');
  assert.equal(boss!.percent, 10);
});

test('per-N refine scales in whole steps, not linearly', () => {
  // Any step size the data still has, rather than a fixed 4: which N an item
  // carries is a fact about the tooltips, and one that moves. Most of the
  // per-4 and per-8 blocks turned out to be set refine written under a set
  // heading, and pinning the fixture to a number the data had that day is
  // what made this test fail when they moved.
  const item = itemList.find((i) =>
    i.refineable && i.refine.per_refine.some((g) => (g.per ?? 1) >= 2)
    && i.refine.per_refine.every((g) => g.effects.every((e) => e.parsed && e.stat_ids?.length)))!;
  assert.ok(item, 'need an item with per-N-refine scaling');

  const group = item.refine.per_refine.find((g) => (g.per ?? 1) >= 2)!;
  const per = group.per ?? 1;
  const eff = group.effects.find((e) => e.parsed && e.stat_ids?.length)!;
  const id = eff.stat_ids![0];
  const slot = SLOTS.find((s) => s.accepts.some((a) => item.equip_slots.includes(a)))!;

  const at = (refine: number) => {
    const build = emptyBuild();
    build.slots[slot.key] = { itemId: item.id, refine, cards: [] };
    const t = aggregate(build, dataset).byStat.get(id);
    return t ? t.flat + t.percent : 0;
  };

  const base = at(0);
  // Kept inside the server's +10 cap so these are reachable builds.
  assert.ok(per * 2 <= MAX_REFINE, `per-${per} needs two steps inside the cap`);
  assert.equal(at(per - 1) - base, 0, `+${per - 1} should not reach a step`);
  assert.equal(at(per) - base, eff.value!, `+${per} is exactly one step`);
  assert.equal(at(per * 2 - 1) - base, eff.value!,
    `+${per * 2 - 1} is still one step`);
  assert.equal(at(per * 2) - base, eff.value! * 2,
    `+${per * 2} is two steps, not ${per * 2}`);
});

test('set bonus applies only when every piece is worn', () => {
  const set = sets.find((s) =>
    s.member_count >= 2 && s.set_bonus.some((e) => e.parsed && e.stat_ids?.length)
    && s.members.every((m) =>
      SLOTS.some((slot) => slot.accepts.some((a) =>
        dataset.items.get(m.id)!.equip_slots.includes(a)))))!;
  assert.ok(set, 'need a wearable multi-piece set');

  const eff = set.set_bonus.find((e) => e.parsed && e.stat_ids?.length)!;
  const id = eff.stat_ids![0];

  const wear = (n: number) => {
    const build = emptyBuild();
    const used = new Set<string>();
    for (const member of set.members.slice(0, n)) {
      const item = dataset.items.get(member.id)!;
      const slot = SLOTS.find((s) =>
        !used.has(s.key) && s.accepts.some((a) => item.equip_slots.includes(a)));
      if (!slot) continue;
      used.add(slot.key);
      build.slots[slot.key] = { itemId: item.id, refine: 0, cards: [] };
    }
    return aggregate(build, dataset);
  };

  const partial = wear(set.member_count - 1);
  const full = wear(set.member_count);

  const progress = partial.setProgress.find((p) => p.set.index === set.index);
  assert.ok(progress && !progress.complete, 'partial set must not read as complete');

  const fullTotal = full.byStat.get(id);
  const partialTotal = partial.byStat.get(id)?.flat ?? 0;
  assert.ok(fullTotal, 'full set should grant the bonus');
  assert.notEqual(
    (fullTotal.flat + fullTotal.percent),
    partialTotal,
    'the full set must add something the partial set does not',
  );
});

test('set refine sums across the worn pieces', () => {
  const set = sets.find((s) =>
    (s.set_refine.thresholds.length > 0 || s.set_refine.per_set_refine.length > 0)
    && s.members.every((m) => dataset.items.get(m.id)?.refineable))!;
  if (!set) return; // nothing to assert against in this dataset

  const build = emptyBuild();
  const used = new Set<string>();
  for (const member of set.members) {
    const item = dataset.items.get(member.id)!;
    const slot = SLOTS.find((s) =>
      !used.has(s.key) && s.accepts.some((a) => item.equip_slots.includes(a)));
    if (!slot) continue;
    used.add(slot.key);
    build.slots[slot.key] = { itemId: item.id, refine: 5, cards: [] };
  }

  const totals = aggregate(build, dataset);
  const progress = totals.setProgress.find((p) => p.set.index === set.index)!;
  assert.equal(
    progress.setRefine, 5 * progress.worn,
    'set refine is the sum of the worn pieces, not one piece',
  );
});

test('base-stat scaling counts whole steps of the points column', () => {
  const item = itemList.find((i) =>
    i.equip_slots.length > 0
    && i.effects.some((e) => e.per_base_stat && e.parsed && e.stat_ids?.length))!;
  assert.ok(item, 'need an item that scales off a base stat');

  const eff = item.effects.find((e) =>
    e.per_base_stat && e.parsed && e.stat_ids?.length)!;
  const { per, stat } = eff.per_base_stat!;
  const key = stat.toLowerCase() as 'str' | 'agi' | 'vit' | 'int' | 'dex' | 'luk';
  const id = eff.stat_ids![0];
  const slot = SLOTS.find((s) => s.accepts.some((a) => item.equip_slots.includes(a)))!;

  const at = (points: number) => {
    const build = emptyBuild();
    build.baseStats[key] = points;
    build.slots[slot.key] = { itemId: item.id, refine: 0, cards: [] };
    const totals = aggregate(build, dataset);
    const t = totals.byStat.get(id);
    return { value: t ? t.flat + t.percent : 0, totals };
  };

  if (per < 2) return; // nothing to say about steps when every point is one

  // Measured as deltas: the same item may feed this stat by other means,
  // and what is under test is only what the scaling adds.
  const below = at(per - 1);
  assert.equal(
    below.totals.uncounted.some((u) => u.reason.includes(`base ${stat}`)), true,
    'an effect below its first step should say what it needs',
  );

  const base = below.value;
  assert.equal(at(per).value - base, eff.value!, 'one full step applies once');
  assert.equal(at(per * 2 - 1).value - base, eff.value!,
    'a partial step does not round up');
  assert.equal(at(per * 2).value - base, eff.value! * 2, 'two full steps apply twice');
});

test('base stat points clamp to 1-99, totals do not', () => {
  assert.equal(BASE_STAT_MIN, 1);
  assert.equal(BASE_STAT_MAX, 99);
  assert.equal(clampBaseStat(0), 1, 'below the floor clamps up');
  assert.equal(clampBaseStat(-20), 1);
  assert.equal(clampBaseStat(150), 99, 'above the cap clamps down');
  assert.equal(clampBaseStat(63.7), 63, 'fractions are truncated');
  assert.equal(clampBaseStat(Number.NaN), 1, 'a blank box is not NaN');
  for (const v of Object.values(defaultBaseStats())) assert.equal(v, 1);

  // Gear is free to push a stat past 99; only the input is capped.
  const strId = statId('str');
  const item = itemList.find((i) =>
    i.equip_slots.length > 0
    && i.effects.some((e) => e.parsed && e.stat_ids?.includes(strId) && !e.unit))!;
  if (!item) return;
  const slot = SLOTS.find((s) => s.accepts.some((a) => item.equip_slots.includes(a)))!;

  const build = emptyBuild();
  build.baseStats.str = BASE_STAT_MAX;
  build.slots[slot.key] = { itemId: item.id, refine: 0, cards: [] };

  const gear = aggregate(build, dataset).byStat.get(strId)?.flat ?? 0;
  assert.ok(gear > 0, 'the item should add flat STR');
  assert.ok(BASE_STAT_MAX + gear > BASE_STAT_MAX, 'the total is not capped at 99');
});

test('refine is capped at this server\'s +10', () => {
  const item = itemList.find((i) => i.refineable)!;
  assert.equal(MAX_REFINE, 10);
  assert.equal(maxRefine(item), 10);
  assert.equal(maxRefine(itemList.find((i) => !i.refineable)!), 0);
});

test('a leech sentence becomes a separate rate and power, and they stack', () => {
  const rateId = statId('leech_hp_rate');
  const powerId = statId('leech_hp_power');

  const leechers = itemList.filter((i) =>
    i.equip_slots.length > 0
    && i.effects.some((e) => e.stat_ids?.includes(rateId))
    && i.effects.some((e) => e.stat_ids?.includes(powerId)));
  assert.ok(leechers.length > 0, 'expected items that leech');

  const item = leechers[0];
  const slot = SLOTS.find((s) => s.accepts.some((a) => item.equip_slots.includes(a)))!;
  const build = emptyBuild();
  build.slots[slot.key] = { itemId: item.id, refine: 0, cards: [] };

  const totals = aggregate(build, dataset);
  const rate = totals.byStat.get(rateId);
  const power = totals.byStat.get(powerId);
  assert.ok(rate && rate.percent > 0, 'the chance is its own stat');
  assert.ok(power && power.percent > 0, 'the amount is its own stat');
  assert.notEqual(rate!.percent, 0);

  // Two different sources of the same half must add up.
  const second = leechers.find((i) =>
    i.id !== item.id
    && SLOTS.some((s) => s.key !== slot.key && !s.kinds
      && s.accepts.some((a) => i.equip_slots.includes(a))));
  if (second) {
    const other = SLOTS.find((s) =>
      s.key !== slot.key && s.accepts.some((a) => second.equip_slots.includes(a)))!;
    build.slots[other.key] = { itemId: second.id, refine: 0, cards: [] };
    const both = aggregate(build, dataset);
    assert.ok(
      (both.byStat.get(rateId)?.percent ?? 0) > rate!.percent,
      'a second leech source adds to the rate',
    );
  }
});

test('one element wins, and the losing claims are still reported', () => {
  const setters = itemList.filter((i) =>
    i.equip_slots.length > 0 && i.effects.some((e) => e.sets_element));
  assert.ok(setters.length >= 2, 'expected several element-setting pieces');

  const first = setters[0];
  const firstElement = first.effects.find((e) => e.sets_element)!.sets_element!;
  const slotA = SLOTS.find((s) => s.accepts.some((a) => first.equip_slots.includes(a)))!;

  const build = emptyBuild();
  build.slots[slotA.key] = { itemId: first.id, refine: 0, cards: [] };

  let totals = aggregate(build, dataset);
  assert.equal(totals.element, firstElement);
  assert.equal(totals.elementClaims.length, 1);
  assert.equal(totals.elementClaims[0].applied, true);

  // A second claim must not silently replace or merge with the first.
  const second = setters.find((i) => {
    const s = SLOTS.find((x) => x.key !== slotA.key
      && x.accepts.some((a) => i.equip_slots.includes(a)));
    return !!s;
  });
  if (!second) return;
  const slotB = SLOTS.find((s) => s.key !== slotA.key
    && s.accepts.some((a) => second.equip_slots.includes(a)))!;
  build.slots[slotB.key] = { itemId: second.id, refine: 0, cards: [] };

  totals = aggregate(build, dataset);
  assert.equal(totals.elementClaims.length, 2, 'both claims are recorded');
  assert.equal(
    totals.elementClaims.filter((c) => c.applied).length, 1,
    'exactly one claim applies',
  );
  assert.equal(totals.element, totals.elementClaims[0].element, 'the first wins');
});

test('a base-stat condition applies only once the points are there', () => {
  // Crescent Helm: "Base STR 99: Melee Attack +5%"
  const item = itemList.find((i) =>
    i.conditional.some((c) => c.requires?.type === 'base_stat'))!;
  assert.ok(item, 'expected an item gated on a base stat');

  const cond = item.conditional.find((c) => c.requires?.type === 'base_stat')!;
  const req = cond.requires as { type: 'base_stat'; stat: string; min: number };
  const eff = cond.effects.find((e) => e.parsed && e.stat_ids?.length)!;
  if (!eff) return;
  const id = eff.stat_ids![0];
  const key = req.stat.toLowerCase() as 'str' | 'agi' | 'vit' | 'int' | 'dex' | 'luk';
  const slot = SLOTS.find((s) => s.accepts.some((a) => item.equip_slots.includes(a)))!;

  const at = (points: number) => {
    const build = emptyBuild();
    build.baseStats[key] = points;
    build.slots[slot.key] = { itemId: item.id, refine: 0, cards: [] };
    return aggregate(build, dataset);
  };

  const below = at(req.min - 1);
  assert.equal(below.byStat.get(id)?.flat ?? 0, 0);
  assert.equal(below.byStat.get(id)?.percent ?? 0, 0);
  assert.ok(
    below.uncounted.some((u) => u.reason.includes(`base ${req.stat} ${req.min}`)),
    'under the gate it should say what it needs',
  );

  const met = at(req.min);
  const total = met.byStat.get(id);
  assert.ok(total && (total.flat !== 0 || total.percent !== 0),
    'at the threshold the bonus applies');
});

test('a base-level condition reads the level, not the stats', () => {
  const item = itemList.find((i) =>
    i.conditional.some((c) => c.requires?.type === 'base_level'
      && c.effects.some((e) => e.parsed && e.stat_ids?.length)))!;
  if (!item) return;

  const cond = item.conditional.find((c) => c.requires?.type === 'base_level')!;
  const req = cond.requires as { type: 'base_level'; min: number };
  const eff = cond.effects.find((e) => e.parsed && e.stat_ids?.length)!;
  const id = eff.stat_ids![0];
  const slot = SLOTS.find((s) => s.accepts.some((a) => item.equip_slots.includes(a)))
    ?? SLOTS.find((s) => s.cardTargets.some((t) => item.equip_slots.includes(t)));
  if (!slot) return;

  const at = (level: number) => {
    const build = emptyBuild();
    build.baseLevel = level;
    if (item.kind === 'Card') {
      const host = itemList.find((h) =>
        h.card_slots > 0 && SLOTS.some((s) => s.key === slot.key
          && s.accepts.some((a) => h.equip_slots.includes(a))));
      if (!host) return null;
      build.slots[slot.key] = { itemId: host.id, refine: 0, cards: [item.id] };
    } else {
      build.slots[slot.key] = { itemId: item.id, refine: 0, cards: [] };
    }
    return aggregate(build, dataset);
  };

  const below = at(req.min - 1);
  const met = at(req.min);
  if (!below || !met) return;

  const valueOf = (t: typeof below) =>
    (t.byStat.get(id)?.flat ?? 0) + (t.byStat.get(id)?.percent ?? 0);
  assert.ok(valueOf(met) > valueOf(below), 'reaching the level grants the bonus');
});

test('a hand-corrected set applies its correction once, and says it is corrected', () => {
  const set = sets.find((s) => s.override);
  if (!set) return; // no corrections in this dataset

  assert.ok(set.override!.reason.length > 0, 'a correction must explain itself');
  assert.ok(
    set.override!.status === 'verified' || set.override!.status === 'unverified',
    'status must be one of the two known values',
  );

  const build = emptyBuild();
  const used: string[] = [];
  for (const m of set.members) {
    const item = dataset.items.get(m.id)!;
    const slot = SLOTS.find((s) => !used.includes(s.key)
      && s.accepts.some((a) => item.equip_slots.includes(a)));
    if (!slot) continue;
    used.push(slot.key);
    build.slots[slot.key] = { itemId: item.id, refine: 0, cards: [] };
  }

  const highest = Math.max(...set.set_refine.thresholds.flatMap((t) => t.at ?? [0]));
  const eff = set.set_refine.thresholds
    .flatMap((t) => t.effects)
    .find((e) => e.parsed && e.stat_ids?.length);
  if (!eff) return;
  const id = eff.stat_ids![0];

  // Well past every threshold, the bonus must still be a single application.
  for (const k of used) build.slots[k].refine = MAX_REFINE;
  const totals = aggregate(build, dataset);
  const progress = totals.setProgress.find((p) => p.set.index === set.index)!;
  assert.ok(progress.setRefine > highest, 'the test build clears every threshold');

  const hits = (totals.byStat.get(id)?.sources ?? [])
    .filter((s) => s.label.includes('set refine'));
  assert.equal(hits.length, 1, 'the corrected bonus is granted exactly once');
});

test('"Every 9 base AGI gives you 1 extra AGI" scales off the points', () => {
  // Gleipnir and friends write the per-base-stat rule back to front.
  const item = itemList.find((i) => i.name === 'Gleipnir')!;
  assert.ok(item, 'expected Gleipnir in the dataset');
  const eff = item.effects.find((e) => e.per_base_stat)!;
  assert.ok(eff, 'the "every N base" line should carry per_base_stat');
  assert.equal(eff.per_base_stat!.per, 9);
  assert.equal(eff.per_base_stat!.stat, 'AGI');

  const agiId = statId('agi');
  const slot = SLOTS.find((s) => s.accepts.some((a) => item.equip_slots.includes(a)))!;
  const at = (agi: number) => {
    const build = emptyBuild();
    build.baseStats.agi = agi;
    build.slots[slot.key] = { itemId: item.id, refine: 0, cards: [] };
    return aggregate(build, dataset).byStat.get(agiId)?.flat ?? 0;
  };

  assert.equal(at(8), 0, 'under 9 AGI it gives nothing');
  assert.equal(at(9), 1, '9 AGI is one step');
  assert.equal(at(89), 9, '89 AGI is nine steps');
  assert.equal(at(90), 10, '90 AGI is ten steps');
});

test('a "for each base stat over N" block multiplies by how many qualify', () => {
  const item = itemList.find((i) =>
    i.conditional.some((c) => c.per_stat_count
      && c.effects.some((e) => e.parsed && e.stat_ids?.length)))!;
  assert.ok(item, 'expected a per-stat-count item');

  const cond = item.conditional.find((c) => c.per_stat_count)!;
  const min = cond.per_stat_count!.min;
  const eff = cond.effects.find((e) => e.parsed && e.stat_ids?.length)!;
  const id = eff.stat_ids![0];
  const slot = SLOTS.find((s) => s.accepts.some((a) => item.equip_slots.includes(a)))
    ?? SLOTS.find((s) => s.cardTargets.some((t) => item.equip_slots.includes(t)))!;

  const withStats = (howMany: number) => {
    const build = emptyBuild();
    BASE_STAT_KEYS.slice(0, howMany).forEach((k) => { build.baseStats[k] = min; });
    if (item.kind === 'Card') {
      const host = itemList.find((h) => h.card_slots > 0
        && slot.accepts.some((a) => h.equip_slots.includes(a)));
      if (!host) return null;
      build.slots[slot.key] = { itemId: host.id, refine: 0, cards: [item.id] };
    } else {
      build.slots[slot.key] = { itemId: item.id, refine: 0, cards: [] };
    }
    const t = aggregate(build, dataset);
    return (t.byStat.get(id)?.flat ?? 0) + (t.byStat.get(id)?.percent ?? 0);
  };

  const none = withStats(0);
  const one = withStats(1);
  const three = withStats(3);
  if (none === null || one === null || three === null) return;

  // Deltas again: the host the card sits in has stats of its own.
  assert.equal(one - none, eff.value!, 'one qualifying stat applies once');
  assert.equal(three - none, eff.value! * 3,
    'three qualifying stats apply three times');
});

test('an enchant note is an item property, not an effect', () => {
  const item = itemList.find((i) => i.name === 'Gleipnir')!;
  assert.ok(item.enchant, 'Gleipnir accepts Dream enchants');
  assert.equal(item.enchant!.system, 'Dream');
  assert.equal(item.enchant!.refining, false);

  // It must not also be sitting in the effects as unreadable noise.
  assert.equal(
    item.effects.some((e) => /enchant/i.test(e.text)), false,
    'the enchant note should not remain an effect',
  );

  const slot = SLOTS.find((s) => s.accepts.some((a) => item.equip_slots.includes(a)))!;
  const build = emptyBuild();
  build.slots[slot.key] = { itemId: item.id, refine: 0, cards: [] };
  const totals = aggregate(build, dataset);
  assert.equal(
    totals.uncounted.some((u) => /enchant/i.test(u.text)), false,
    'and it should not clutter the not-counted panel',
  );
});

test('derived flee follows the stated formula and shows its working', () => {
  const build = emptyBuild();
  build.baseLevel = 100;
  build.baseStats.agi = 50;

  const totals = aggregate(build, dataset);
  const flee = totals.derived.find((d) => d.key === 'flee')!;
  assert.ok(flee, 'flee should be derived');
  // AGI 50 gives 50 + 5 = 55, over the flat 100 and the level.
  assert.equal(flee.base, 100 + 100 + 55, '100 + base level + AGI + 1 per 10 AGI');
  assert.equal(flee.total, flee.base, 'with no gear the total is the base');
  assert.ok(flee.formula.length > 0, 'it must show its working');
});

test('flee applies flat gear first and percent afterwards', () => {
  // The order is the whole point: (base + flat) x percent, never
  // base x percent + flat, and never percent added into the flat pool.
  assert.equal(combine(300, 7, 0), 307);
  assert.equal(combine(300, 0, 10), 330);
  assert.equal(combine(300, 7, 10), 337, '(300 + 7) x 1.10, floored');

  // Chosen so the two orderings actually diverge: with a small flat bonus
  // the difference is under 1 and the floor hides it.
  assert.equal(combine(300, 100, 50), 600, '(300 + 100) x 1.50');
  assert.equal(Math.floor(300 * 1.5) + 100, 550, 'the wrong order gives 550');

  assert.equal(combine(300, -7, -10), 263, 'negatives combine the same way');
  assert.equal(combine(100, 1, 33), 134, 'floored, not rounded');
});

test('flee adds up real gear in the right order', () => {
  const fleeId = statId('flee');
  // Backwak carries a flat "Flee +7".
  const flat = itemList.find((i) =>
    i.name === 'Backwak' && i.effects.some((e) => e.stat_ids?.includes(fleeId)))!;
  if (!flat) return;
  const slot = SLOTS.find((s) => s.accepts.some((a) => flat.equip_slots.includes(a)))!;

  const build = emptyBuild();
  build.baseLevel = 100;
  build.baseStats.agi = 50;
  build.slots[slot.key] = { itemId: flat.id, refine: 0, cards: [] };

  const flee = aggregate(build, dataset).derived.find((d) => d.key === 'flee')!;
  // The formula reads the points column, so gear AGI must not move it.
  assert.equal(flee.base, 255, '100 + level 100 + AGI 50 + 5');
  assert.ok(flee.flat >= 7, `expected at least the +7 from ${flat.name}`);
  assert.equal(
    flee.total, Math.floor((flee.base + flee.flat) * (1 + flee.percent / 100)),
    'the reported total matches the stated order of operations',
  );
});

test('a skill modifier is totalled against its skill, never a global stat', () => {
  // Pilfer Gem: "Comet Damage -60%".
  const gem = itemList.find((i) => i.name === 'Pilfer Gem of Stolen Spells')!;
  const build = emptyBuild();
  build.slots.gem = { itemId: gem.id, refine: 0, cards: [] };
  const totals = aggregate(build, dataset);
  assert.equal(totals.skills.get('Comet|damage')?.percent, -60);
  assert.ok(!totals.uncounted.some((u) => u.text.startsWith('Comet Damage')));
});

test('a skill line naming several skills counts for each of them', () => {
  const item = itemList.find((i) => i.refine.per_refine.some((g) =>
    g.effects.some((e) => (e.skills?.length ?? 0) > 1)))!;
  const eff = item.refine.per_refine.flatMap((g) => g.effects)
    .find((e) => (e.skills?.length ?? 0) > 1)!;
  const slot = SLOTS.find((s) => fitsSlot(item, s))!;
  const build = emptyBuild();
  build.slots[slot.key] = { itemId: item.id, refine: 1, cards: [] };
  const totals = aggregate(build, dataset);
  for (const skill of eff.skills!) {
    assert.ok(totals.skills.get(`${skill}|${eff.skill_metric}`), `${skill} in ${eff.text}`);
  }
});

test('effects that cannot be summed are reported, not dropped', () => {
  // "All 4 skills Damage -40%" names no one skill, so it has nowhere to go.
  const gem = itemList.find((i) => i.name === 'Deft Gem of Precision')!;
  const build = emptyBuild();
  build.slots.gem = { itemId: gem.id, refine: 0, cards: [] };
  const totals = aggregate(build, dataset);
  assert.ok(
    totals.uncounted.some((u) => u.text.startsWith('All 4 skills')),
    'a skill modifier naming no skill should surface in uncounted',
  );
});

// ---- things the descriptions said badly -----------------------------------

test('a card per-refine bonus counts the host piece refine, not the card', () => {
  // A card has no refine of its own, so reading it gives zero and the bonus
  // vanishes. This used to be dropped silently, which is the worst outcome:
  // the tooltip promised it and the totals did not have it.
  const card = itemList.find((i) =>
    i.kind === 'Card'
    && i.refine.per_refine.some((g) =>
      g.effects.some((e) => e.parsed && e.stat_ids?.length)))!;
  assert.ok(card, 'need a card that scales off refine');

  const group = card.refine.per_refine.find((g) =>
    g.effects.some((e) => e.parsed && e.stat_ids?.length))!;
  const eff = group.effects.find((e) => e.parsed && e.stat_ids?.length)!;
  const per = group.per ?? 1;
  const id = eff.stat_ids![0];

  const host = itemList.find((i) =>
    i.refineable && i.card_slots > 0 && i.kind !== 'Card'
    && card.equip_slots.some((s) => i.equip_slots.includes(s)))!;
  assert.ok(host, 'need a refinable host with a socket');
  const slot = SLOTS.find((s) => s.accepts.some((a) => host.equip_slots.includes(a)))!;

  const at = (refine: number) => {
    const build = emptyBuild();
    build.slots[slot.key] = { itemId: host.id, refine, cards: [card.id] };
    const t = aggregate(build, dataset).byStat.get(id);
    return t ? t.flat + t.percent : 0;
  };

  assert.equal(at(per * 2) - at(0), eff.value! * 2,
    'two steps of the host refine, counted on the card');
});

test('a flag is a property, not a number to add up', () => {
  const flagStat = stats.find((s) => s.category === 'flag')!;
  assert.ok(flagStat, 'the registry should carry flag stats');
  const item = itemList.find((i) =>
    i.equip_slots.length > 0
    && i.effects.some((e) => e.flag && e.stat_ids?.includes(flagStat.id)))!;
  if (!item) return;

  const slot = SLOTS.find((s) => s.accepts.some((a) => item.equip_slots.includes(a)))!;
  const build = emptyBuild();
  build.slots[slot.key] = { itemId: item.id, refine: 0, cards: [] };
  const total = aggregate(build, dataset).byStat.get(flagStat.id)!;
  assert.equal(total.flat, 1, 'present counts as one, and is never a percent');
  assert.equal(total.percent, 0);
});

test('"ATK +1 every 20 flee" scales off the finished flee total', () => {
  const set = sets.find((s) =>
    s.set_bonus.some((e) => e.per_stat?.stat === 'flee'))!;
  assert.ok(set, 'need a set that scales off flee (Maiden of Time)');
  const eff = set.set_bonus.find((e) => e.per_stat?.stat === 'flee')!;
  const per = eff.per_stat!.per;
  const id = eff.stat_ids![0];

  const build = emptyBuild();
  const used = new Set<string>();
  for (const member of set.members) {
    const card = dataset.items.get(member.id)!;
    const slot = SLOTS.find((s) =>
      !used.has(s.key) && card.equip_slots.some((e) => s.cardTargets.includes(e)));
    if (!slot) continue;
    const host = itemList.find((i) =>
      i.kind !== 'Card' && i.card_slots > 0
      && i.equip_slots.some((e) => slot.accepts.includes(e)))!;
    if (!host) continue;
    used.add(slot.key);
    build.slots[slot.key] = { itemId: host.id, refine: 0, cards: [card.id] };
  }

  const measure = (agi: number) => {
    const b = { ...build, baseLevel: 130, baseStats: { ...build.baseStats, agi } };
    const totals = aggregate(b, dataset);
    const flee = totals.derived.find((d) => d.key === 'flee')!;
    const atk = totals.byStat.get(id);
    const fromFlee = atk?.sources.find((s) => s.label.includes('flee'));
    return { flee: flee.total, atk: fromFlee?.value ?? 0 };
  };

  const low = measure(1);
  const high = measure(99);
  assert.ok(high.flee > low.flee, 'more AGI is more flee');
  assert.equal(high.atk, eff.value! * Math.floor(high.flee / per),
    'one step per full 20 of the flee actually reached');
  assert.ok(high.atk > low.atk, 'and more flee is more ATK');
});

test('a base-stat gate reads "over N" as N+1, not N', () => {
  // Hell Poodle Card: "If Base AGI is over 98" pays out at 99, not at 98.
  const card = dataset.items.get(4437)!;
  assert.ok(card, 'Hell Poodle Card should be in the dataset');
  const cond = card.conditional[0];
  assert.deepEqual(cond.requires, { type: 'base_stat', stat: 'AGI', min: 99 });

  const host = itemList.find((i) =>
    i.card_slots > 0 && i.kind !== 'Card'
    && card.equip_slots.some((s) => i.equip_slots.includes(s)))!;
  const slot = SLOTS.find((s) => s.accepts.some((a) => host.equip_slots.includes(a)))!;

  const agiAt = (points: number) => {
    const build = emptyBuild();
    build.baseStats.agi = points;
    build.slots[slot.key] = { itemId: host.id, refine: 0, cards: [card.id] };
    const t = aggregate(build, dataset).byStat.get(statId('agi'));
    return t?.flat ?? 0;
  };

  assert.equal(agiAt(99) - agiAt(98), 5, 'the +5 lands at 99 and not before');
});

test('flee matches the character window, at three AGI values', () => {
  // Read off a naked character at base level 134 with 70 flee from two
  // maxed passives. Three points rather than one, because the pair of them
  // is what pins the formula: the deltas fix the per-ten step at one, and
  // the step then fixes the constant at 100 + level.
  const measured: [number, number][] = [[99, 412], [100, 414], [110, 425]];
  for (const [agi, ingame] of measured) {
    const build = emptyBuild();
    build.baseLevel = 134;
    build.baseStats.agi = agi;
    build.manual = { flee: 70 };
    const flee = aggregate(build, dataset).derived.find((d) => d.key === 'flee')!;
    assert.equal(flee.total, ingame, `${agi} AGI should read ${ingame} in game`);
  }

  assert.equal(fleeFromAgi(99), 108, '99 + 9 whole steps of 1');
  assert.equal(fleeFromAgi(9), 9, 'under the first step, one flee per point');
  assert.equal(baseFlee(134, 99), 234 + 108);
});

test('flee counts AGI off equipment, and the skills box sits outside the percent', () => {
  // Both halves are pinned because both were once wrong the other way:
  // gear AGI feeds the formula, and skills land on the finished figure
  // rather than being scaled by a Total Flee bonus.
  // Flat AGI and no flee of its own, so the only thing that can move the
  // base figure is the AGI.
  const agiSlot = SLOTS.find((s) => s.key === 'shoes')!;
  const agiGear = itemList.find((i) => fitsSlot(i, agiSlot)
    && i.effects.some((e) => e.parsed && e.unit !== '%' && (e.value ?? 0) > 0
      && e.stat_keys?.length === 1 && e.stat_keys[0] === 'agi')
    && !i.effects.some((e) => e.stat_keys?.includes('flee'))
    && i.refine.per_refine.length === 0 && i.refine.thresholds.length === 0);
  assert.ok(agiGear, 'need a piece granting flat AGI and no flee');

  const bonus = agiGear.effects.find((e) => e.stat_keys?.[0] === 'agi')!.value!;
  const build = emptyBuild();
  build.baseLevel = 134;
  build.baseStats.agi = 99;
  build.slots.shoes = { itemId: agiGear.id, refine: 0, cards: [] };

  const totals = aggregate(build, dataset);
  assert.equal(totals.byStat.get(statId('agi'))!.flat, bonus);
  const flee = totals.derived.find((d) => d.key === 'flee')!;
  const agi = 99 + bonus;
  assert.equal(flee.base, 100 + 134 + agi + Math.floor(agi / 10),
    'the gear AGI moves the base figure, step included');

  // Skills land on the finished figure, not inside the percent. Worked
  // against the earlier live reading: level 132, 99 points, +40 gear AGI,
  // +16% Total Flee and 14 flat gear flee gives the reported 531. Folding
  // the 70 in before the percent instead would give 542.
  assert.equal(combine(baseFlee(132, 139), 14, 16) + 70, 531);
});

test('Total Flee percents compound rather than add', () => {
  // Base level 136, 99 points of AGI, the three Maiden of Time cards
  // (+6%, +5%, +5%) and +70 from skills, read in game in three gear states.
  // Summed to 16% these come out 563, 557 and 568 -- low by 3, 3 and 4, and
  // the level was checked in game. Compounded, all three are exact.
  const pct = compoundPercent([6, 5, 5]);
  assert.ok(Math.abs(pct - 16.865) < 1e-9, '1.06 x 1.05 x 1.05');
  const measured: [agi: number, flat: number, ingame: number][] = [
    [152, 22, 566], [148, 22, 560], [152, 27, 572],
  ];
  for (const [agi, flat, ingame] of measured) {
    assert.equal(combine(baseFlee(136, agi), flat, pct) + 70, ingame, `${agi} AGI, +${flat}`);
  }

  // And derivedStats does it from the gear's own sources.
  const fleeTotal: StatTotal = {
    statId: statId('flee'), flat: 27, percent: 16,
    sources: [
      { label: 'Wind Weaver', value: 15, unit: null },
      { label: 'Yoyo Card', value: 12, unit: null },
      { label: 'Maiden of Past Card', value: 6, unit: '%' },
      { label: 'Maiden of Present Card', value: 5, unit: '%' },
      { label: 'Maiden of Future Card', value: 5, unit: '%' },
    ],
  };
  const flee = derivedStats(136, { ...defaultBaseStats(), agi: 99 },
    (k) => (k === 'flee' ? fleeTotal : k === 'agi'
      ? { statId: statId('agi'), flat: 53, percent: 0, sources: [] } : undefined),
    { flee: 70 }).find((d) => d.key === 'flee')!;
  assert.deepEqual(flee.percentParts, [6, 5, 5]);
  assert.equal(flee.total, 572);
});

test('Double Attack takes the highest level, never the sum, and caps at 10', () => {
  const id = statId('double_attack');
  const def = stats.find((s) => s.id === id)!;
  assert.equal(def.combine, 'max', 'the rule must travel with the dataset');
  assert.equal(def.cap, 10);

  // Two sources at once: a weapon and a card in it. Adding them would read
  // as a higher skill level than either grants, and inflate damage.
  // A level is written with no unit, so it lands in the flat column. The
  // chance is a percent and is a different stat entirely -- see below.
  const levelled = itemList.filter((i) =>
    i.effects.some((e) => e.stat_ids?.includes(id) && e.value && !e.unit));
  const weapon = levelled.find((i) => i.kind === 'Weapon' && i.card_slots > 0);
  const card = levelled.find((i) =>
    i.kind === 'Card' && weapon && i.equip_slots.some((s) => weapon.equip_slots.includes(s)));
  if (!weapon || !card) return;

  const levelOn = (item: Item) =>
    item.effects.find((e) => e.stat_ids?.includes(id) && !e.unit)!.value!;

  const build = emptyBuild();
  build.slots.weapon = { itemId: weapon.id, refine: 0, cards: [card.id] };
  const total = aggregate(build, dataset).byStat.get(id)!;

  const best = Math.max(levelOn(weapon), levelOn(card));
  assert.equal(total.flat, Math.min(10, best), 'the better of the two, capped');
  assert.notEqual(total.flat, levelOn(weapon) + levelOn(card),
    'the two levels must never be added together');
  assert.ok(total.sources.length >= 2,
    'both sources stay listed even though only one counts');
});

test('Double Attack rate is a separate stat from the level', () => {
  // "Double Attack Rate +10%" is a chance, not a skill level: rates add up
  // and are not capped at 10, levels do neither. An alias folded both onto
  // the level for a while, which capped a 25% chance at 10%.
  const level = stats.find((s) => s.key === 'double_attack')!;
  const rate = stats.find((s) => s.key === 'double_attack_rate')!;
  assert.notEqual(level.id, rate.id);
  assert.equal(rate.combine, undefined, 'rates add up');
  assert.equal(rate.cap, undefined, 'and are not capped at the level ceiling');

  const item = itemList.find((i) =>
    i.effects.some((e) => /double attack (rate|chance)/i.test(e.text)))!;
  assert.ok(item, 'the dataset has items wording it as a rate');
  const eff = item.effects.find((e) => /double attack (rate|chance)/i.test(e.text))!;
  assert.deepEqual(eff.stat_keys, ['double_attack_rate']);
});

test('the Metal set is the ring plus one pair of boots', () => {
  // The tooltip says "Ring and Boots" but only the boots declare the set,
  // and the three marks are alternatives rather than three pieces.
  const set = sets.find((s) => s.key === 'metal')!;
  assert.ok(set, 'the Metal set should exist');
  assert.equal(set.member_count, 2, 'two worn pieces complete it');
  assert.ok(
    set.members.some((m) => m.name === 'Strange Metal Ring'),
    'the ring is a member even though its text never says so',
  );
  assert.equal(set.override?.status, 'unverified');

  const ring = itemList.find((i) => i.name === 'Strange Metal Ring')!;
  const boots = itemList.find((i) => i.name === 'Metal Boots MK I')!;
  assert.ok(ring.sets.includes(set.index), 'and the ring points back at it');
  assert.equal(
    ring.effects.some((e) => /slots/i.test(e.text)), false,
    '"Two Slots" is in the item data already and should not be an effect',
  );

  const build = emptyBuild();
  build.slots.acc1 = { itemId: ring.id, refine: 0, cards: [] };
  build.slots.shoes = { itemId: boots.id, refine: 0, cards: [] };
  const progress = aggregate(build, dataset).setProgress
    .find((p) => p.set.index === set.index)!;
  assert.equal(progress.complete, true, 'ring + one boots completes it');
});

test('the Memory set is five cards, not one card with itself', () => {
  // Only Memory of Thanatos declares the set, so it grouped alone and paid
  // out from a single card. Its own text names all five.
  const memory = sets.find((s) => s.key === 'memory')!;
  assert.equal(memory.member_count, 5);
  assert.match(memory.members_text ?? '', /Memory of Thanatos/);

  const named = memory.members.map((m) => m.name);
  assert.ok(named.includes('Memory of Thanatos Card'));
  for (const part of ['Odium', 'Dolor', 'Despero', 'Maero']) {
    assert.ok(named.some((n) => n.includes(part)), `${part} should be a member`);
  }

  // The four Thanatos cards belong to both sets at once, which is the thing
  // the single-set assumption would have hidden.
  const odium = itemList.find((i) => i.name === 'Thanatos Odium Card')!;
  assert.ok(odium.sets.length >= 2, 'a card can be in more than one set');

  // Wearing all five completes both, and one card short completes neither.
  const wear = (cards: string[]) => {
    const build = emptyBuild();
    const used = new Set<string>();
    for (const name of cards) {
      const card = itemList.find((i) => i.name === name)!;
      const slot = SLOTS.find((s) =>
        !used.has(s.key) && card.equip_slots.some((e) => s.cardTargets.includes(e)));
      if (!slot) continue;
      const host = itemList.find((i) =>
        i.kind !== 'Card' && i.card_slots > 0
        && i.equip_slots.some((e) => slot.accepts.includes(e)));
      if (!host) continue;
      used.add(slot.key);
      build.slots[slot.key] = { itemId: host.id, refine: 0, cards: [card.id] };
    }
    const totals = aggregate(build, dataset);
    return totals.setProgress.find((p) => p.set.index === memory.index);
  };

  const full = wear(named);
  assert.ok(full && full.complete, `expected 5/5, got ${full?.worn}/${full?.total}`);
  const short = wear(named.slice(0, 4));
  assert.equal(short?.complete, false, 'four of five must not pay out');
});

test('a padded zero in the tooltip stat block is not an effect', () => {
  // Descriptions pad the stats an item does not have: "HP Bonus: +00%",
  // "Perfect Dodge: 000". They parse perfectly, and rendering them promises
  // a bonus of zero, which reads as a bonus.
  const offenders: string[] = [];
  for (const item of itemList) {
    for (const eff of [...item.effects, ...item.piece_bonus]) {
      if (eff.parsed && eff.value === 0 && !eff.flag) {
        offenders.push(`${item.name}: ${eff.text}`);
      }
    }
  }
  assert.deepEqual(offenders.slice(0, 5), [], 'these render as "+0"');

  // The line is dropped, not the item: Darkness Armor keeps its real bonus.
  const armor = itemList.find((i) => i.name === 'Darkness Armor')!;
  assert.deepEqual(armor.effects.map((e) => e.text), ['ATK+10']);
});

test('the Valkyries set is Randgris plus Reginleif', () => {
  // Only Reginleif declares it, so it grouped as a set containing itself
  // and paid out ATK+5% from one card.
  const set = sets.find((s) => s.key === 'valkyries')!;
  assert.equal(set.member_count, 2);
  assert.deepEqual(
    set.members.map((m) => m.name).sort(),
    ['Reginleif Card', 'Valkyrie Randgris Card'],
  );

  const wear = (names: string[]) => {
    const build = emptyBuild();
    const used = new Set<string>();
    for (const name of names) {
      const card = itemList.find((i) => i.name === name)!;
      const slot = SLOTS.find((s) =>
        !used.has(s.key) && card.equip_slots.some((e) => s.cardTargets.includes(e)));
      if (!slot) continue;
      const host = itemList.find((i) =>
        i.kind !== 'Card' && i.card_slots > 0
        && i.equip_slots.some((e) => slot.accepts.includes(e)));
      if (!host) continue;
      used.add(slot.key);
      build.slots[slot.key] = { itemId: host.id, refine: 0, cards: [card.id] };
    }
    return aggregate(build, dataset).setProgress.find((p) => p.set.index === set.index);
  };

  assert.equal(wear(['Reginleif Card'])?.complete, false,
    'one card alone must not pay out the set bonus');
  assert.equal(wear(['Reginleif Card', 'Valkyrie Randgris Card'])?.complete, true);
});


// ---- class gems -----------------------------------------------------------

test('a class gem fits the gem slot and nowhere else', () => {
  const gem = itemList.find((i) => i.type === 'Class Gem')!;
  const fits = SLOTS.filter((s) => fitsSlot(gem, s)).map((s) => s.key);
  assert.deepEqual(fits, ['gem']);
});

test('a piece bonus that scales with refine counts every step', () => {
  // Tower Shoes: "Piece Bonus: ATK +1% per Refine". Once counted as +1%
  // whatever the refine, because the scaling was never read.
  const shoes = itemList.find((i) => i.name === 'Tower Shoes')!;
  const build = emptyBuild();
  build.slots.shoes = { itemId: shoes.id, refine: 10, cards: [] };
  const atk = aggregate(build, dataset).byStat.get(statId('atk'))!;
  assert.equal(atk.percent, 10);
});

test('a set bonus written "per total set refine" scales with the set', () => {
  const set = sets.find((s) => s.set_bonus.some((e) => e.per_set_refine
    && e.stat_keys?.length === 1 && e.unit === '%'))!;
  const eff = set.set_bonus.find((e) => e.per_set_refine && e.stat_keys?.length === 1)!;
  const build = emptyBuild();
  let refine = 0;
  for (const id of set.member_ids) {
    const item = dataset.items.get(id)!;
    const slot = SLOTS.find((s) => fitsSlot(item, s) && !build.slots[s.key].itemId)!;
    build.slots[slot.key] = { itemId: id, refine: maxRefine(item), cards: [] };
    refine += maxRefine(item);
  }
  const total = aggregate(build, dataset).byStat.get(eff.stat_ids![0])!;
  const fromSet = total.sources.filter((s) => s.label === `${set.name} set`)
    .reduce((n, s) => n + s.value, 0);
  assert.equal(fromSet, eff.value! * Math.floor(refine / eff.per_set_refine!));
});

test('a card is never offered as the item for a slot', () => {
  // Bloody Murderer says "Weapon", meaning what it compounds into.
  const card = itemList.find((i) => i.name === 'Bloody Murderer Card')!;
  assert.deepEqual(SLOTS.filter((s) => fitsSlot(card, s)).map((s) => s.key), []);
});

test('a class gem refines despite the server calling it unrefineable', () => {
  // Pilfer Gem of Stolen Spells: "Per Refine: MATK +5", "If refine is +10:
  // All Stats +5". The data column says refineable: false for every gem.
  const gem = itemList.find((i) => i.name === 'Pilfer Gem of Stolen Spells')!;
  assert.equal(gem.refineable, false);
  assert.equal(maxRefine(gem), MAX_REFINE);

  const build = emptyBuild();
  build.slots.gem = { itemId: gem.id, refine: 10, cards: [] };
  const totals = aggregate(build, dataset);
  // MATK -50 on the gem itself, +5 per refine for ten refines.
  assert.equal(totals.byStat.get(statId('matk'))!.flat, 0);
  // All Stats -5 base, +5 at +10: they cancel.
  assert.equal(totals.byStat.get(statId('str'))!.flat, 0);
});

// ---- off-hand weapon halving ----------------------------------------------

const oneHander = itemList.find((i) =>
  i.kind === 'Weapon' && i.card_slots > 0 && i.equip_slots.includes('Weapon')
  && !i.equip_slots.includes('Weapon (two-handed)'))!;
const raceCard = itemList.find((i) => i.name === 'Bloody Murderer Card')!;

test('race damage on a dual-wielded off-hand weapon counts at half', () => {
  const build = emptyBuild();
  build.slots.offhand = { itemId: oneHander.id, refine: 0, cards: [raceCard.id] };
  const total = aggregate(build, dataset).byStat.get(statId('dmg_vs_race_demihuman'))!;
  assert.equal(total.percent, 9);
  assert.match(total.sources[0].label, /off-hand, half/);
});

test('the same card in the main hand counts in full', () => {
  const build = emptyBuild();
  build.slots.weapon = { itemId: oneHander.id, refine: 0, cards: [raceCard.id] };
  assert.equal(
    aggregate(build, dataset).byStat.get(statId('dmg_vs_race_demihuman'))!.percent, 18);
});

test('a shield in the off hand keeps its race and size bonuses whole', () => {
  // No shield in the data carries one today, so give a real shield one.
  const real = itemList.find((i) => i.kind === 'Shield')!;
  const id = statId('dmg_vs_race_demihuman');
  const shield: Item = {
    ...real, id: -1,
    effects: [{ text: 'DMG vs Demi-Humans+10%', parsed: true, value: 10,
      unit: '%', stat_ids: [id], stat_keys: ['dmg_vs_race_demihuman'] }],
  };
  const withShield: Dataset = {
    ...dataset, items: new Map([...dataset.items, [shield.id, shield]]),
  };
  const build = emptyBuild();
  build.slots.offhand = { itemId: shield.id, refine: 0, cards: [] };
  assert.equal(aggregate(build, withShield).byStat.get(id)!.percent, 10);
});

test('off-hand halving leaves stats outside race and size alone', () => {
  // Abysmal Knight is DMG vs Boss, which is filed as a race modifier; pick a
  // card on a plain stat instead to show the rest of the piece stays whole.
  const atkCard = itemList.find((i) => i.kind === 'Card'
    && i.equip_slots.includes('Weapon')
    && i.effects.length === 1 && i.effects[0].stat_keys?.[0] === 'atk'
    && i.effects[0].unit === null)!;
  const build = emptyBuild();
  build.slots.offhand = { itemId: oneHander.id, refine: 0, cards: [atkCard.id] };
  const atk = aggregate(build, dataset).byStat.get(statId('atk'))!;
  assert.equal(atk.flat, oneHander.atk + atkCard.effects[0].value!);
});

test('"at 9+ and again at 18+" pays out twice, and only the line it governs', () => {
  // Aggressive Orphan, confirmed in game. The tooltip wraps as
  //
  //   All Stats +4
  //   At set refine 9+ and again at 18+:
  //   Damage against all races +10%, Max HP/SP -10%
  //
  // which reads at a glance as though the repeated step belonged to All
  // Stats. It does not: the heading governs the two lines under it, and it
  // is the racial damage that lands twice. This was hand-corrected the
  // other way once, on a misreading, so the numbers are pinned here.
  const set = sets.find((s) => s.name === 'Aggressive Orphan')!;
  assert.ok(set, 'expected the Aggressive Orphan set in the dataset');

  const build = emptyBuild();
  const slots = ['sh_armor', 'sh_gloves', 'sh_shoes', 'sh_acc'];
  const place = (refine: number) => {
    set.members.forEach((m, i) => {
      build.slots[slots[i]] = { itemId: m.id, refine, cards: [] };
    });
    return aggregate(build, dataset);
  };
  const dmg = (t: ReturnType<typeof aggregate>) =>
    t.byStat.get(statId('dmg_vs_race_all_races'))?.percent ?? 0;
  const agi = (t: ReturnType<typeof aggregate>) =>
    t.byStat.get(statId('agi'))?.flat ?? 0;

  // Four pieces, so each +N gives a combined set refine of 4N.
  const under = place(2);   // set refine 8 -- under the first step
  const once = place(3);    // set refine 12 -- past 9, short of 18
  const twice = place(5);   // set refine 20 -- past both

  assert.equal(dmg(under), 0, 'nothing before set refine 9');
  assert.equal(dmg(once), 10, 'one step at set refine 9');
  assert.equal(dmg(twice), 20, 'and again at 18, so twice over');

  // All Stats is the set's flat bonus and does not repeat with refine.
  assert.equal(agi(under), agi(once), 'All Stats must not gain a step at 9');
  assert.equal(agi(once), agi(twice), 'nor another at 18');
});
