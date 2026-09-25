/**
 * Goal-driven suggestions: that goals measure the number the panel shows,
 * that ranking agrees with the aggregator, and that a plan only ever names
 * changes that help.
 *
 * Run with:  node --experimental-strip-types --test sim/test/suggest.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  aggregate, allGoals, applyChanges, bindBaseStatIds, brokenGoals, brokenSets, defaultBaseStats,
  diffTotals,
  effectTone, farmFor, fitsSlot, rollTableFor, goalMetrics, goalsFromBuild, reachOf, REACH_EFFORT_FACTOR,
  REACH_KILL_FACTOR, REACH_REFINE_FLOOR, REFINE_MOVE_CAP, statsThatMatter,
  goalScore, goalStatus, isTwoHanded, measure, priorityWeight, SLOTS, Suggester, tableForSlot,
  tradeValue, coveredBy, type Move, type SuggestOptions,
  collateralCost, COLLATERAL_WEIGHT, relevanceOf, statTone, type TotalsChange, sideGoals,
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

const OPEN: SuggestOptions = { className: null, maxLevel: null, refine: null };
const byName = (name: string) => itemList.find((i) => i.name === name)!;

function emptyBuild(): Build {
  const slots: Record<string, SlotState> = {};
  for (const s of SLOTS) slots[s.key] = { itemId: null, refine: 0, cards: [] };
  return { className: null, baseLevel: 150, baseStats: defaultBaseStats(), slots };
}

const oneHander = itemList.find((i) => i.kind === 'Weapon' && i.card_slots >= 3
  && i.equip_slots.includes('Weapon') && !isTwoHanded(i))!;
const demihuman: Goal = { key: 'dmg_vs_race_demihuman', column: 'percent', target: 36 };

test('goals are offered only on columns some gear actually feeds', () => {
  const metrics = goalMetrics(dataset);
  const has = (key: string, column: Goal['column']) =>
    metrics.some((m) => m.key === key && m.column === column);
  assert.ok(has('flee', 'total'));
  assert.ok(has('str', 'total'));
  // STR only ever comes flat, and its flat row is the total above.
  assert.ok(!has('str', 'percent'));
  assert.ok(!has('str', 'flat'));
  // Perfect Dodge is never a percent; race damage is never flat.
  assert.ok(has('perfect_dodge', 'flat') && !has('perfect_dodge', 'percent'));
  assert.ok(has('dmg_vs_race_demihuman', 'percent') && !has('dmg_vs_race_demihuman', 'flat'));
  // Both ways: named with the unit so the two rows can be told apart.
  assert.equal(metrics.find((m) => m.key === 'atk' && m.column === 'flat')?.label, 'ATK (flat)');
  assert.equal(metrics.find((m) => m.key === 'atk' && m.column === 'percent')?.label, 'ATK %');
  assert.ok(!metrics.some((m) => m.category === 'flag'));
  // Double Attack is a skill level that combines by max: no percent column.
  assert.ok(!has('double_attack', 'percent'));
});

test('race, size and "damage taken" wordings reach the right stats', () => {
  // By id where a name is shared: there are two Morroc Guardian Shields.
  const keys = (name: string | number, text: RegExp) => {
    const item = typeof name === 'number' ? dataset.items.get(name)! : byName(name);
    const all = [...item.effects, ...item.refine.per_refine.flatMap((g) => g.effects)];
    return all.find((e) => text.test(e.text))?.stat_keys ?? [];
  };
  // "Undead Race" is the race, not the element.
  assert.deepEqual(keys('Megalodon Card', /Undead Race/), ['dmg_vs_race_undead_race']);
  assert.deepEqual(keys('Belena', /vs Small/), ['dmg_vs_size_small']);
  assert.deepEqual(keys('Maladeilan', /Boss/), ['dmg_vs_race_boss']);
  assert.deepEqual(keys(28281, /Demon/),
    ['dmg_vs_race_demon', 'magic_vs_race_demon']);
  assert.deepEqual(keys('Waste Stove Card', /Formless/), ['res_race_formless']);
  // A rune's "Innate:" block is its bonus, and "per Upgrade" is its refine.
  const uruz = byName('Uruz Rune of Freedom');
  assert.equal(uruz.conditional.length, 0);
  assert.deepEqual(uruz.refine.per_refine[0].effects.map((e) => e.stat_keys),
    [['flee'], ['perfect_dodge']]);
  // "Fire Damage Taken -2%" is Fire Resistance +2%.
  const kenaz = byName('Kenaz Rune of Flames').refine.per_refine[0].effects
    .find((e) => /Taken/.test(e.text))!;
  assert.deepEqual(kenaz.stat_keys, ['res_fire']);
  assert.equal(kenaz.value, 2);
});

test('a base stat goal reads points plus gear, as the character window does', () => {
  const build = emptyBuild();
  build.baseStats.str = 90;
  build.slots.gem = { itemId: byName('Pilfer Gem of Stolen Spells').id, refine: 0, cards: [] };
  const totals = aggregate(build, dataset);
  // All Stats -5 on the gem, unrefined.
  assert.equal(measure({ key: 'str', column: 'total', target: 0 }, totals, build, dataset), 85);
});

test('a ceiling goal is met by staying under it', () => {
  const build = emptyBuild();
  const totals = aggregate(build, dataset);
  const [under] = goalStatus([{ key: 'fixed_cast', column: 'percent', target: 0, atMost: true }],
    totals, build, dataset);
  assert.equal(under.met, true);
  const [over] = goalStatus([{ key: 'fixed_cast', column: 'percent', target: -10, atMost: true }],
    totals, build, dataset);
  assert.equal(over.met, false);
});

test('ranking puts the card that serves the goal first', () => {
  const build = emptyBuild();
  build.slots.weapon = { itemId: oneHander.id, refine: 0, cards: [] };
  const s = new Suggester(dataset, [demihuman], OPEN);
  const cards = itemList.filter((i) => i.kind === 'Card' && i.equip_slots.includes('Weapon'));
  const scores = s.rank(build, 'weapon', 0, cards);
  const best = [...scores].sort((a, b) => b[1].gain - a[1].gain)[0];
  // Bloody Murderer is the only weapon card that says Demi-Human outright.
  assert.equal(dataset.items.get(best[0])!.name, 'Bloody Murderer Card');
  assert.equal(best[1].after[0], 18);
});

test('ranking an off-hand weapon sees the halving', () => {
  const build = emptyBuild();
  build.slots.weapon = { itemId: oneHander.id, refine: 0, cards: [] };
  build.slots.offhand = { itemId: oneHander.id, refine: 0, cards: [] };
  const s = new Suggester(dataset, [demihuman], OPEN);
  const scores = s.rank(build, 'offhand', 0, [byName('Bloody Murderer Card')]);
  assert.equal([...scores.values()][0].after[0], 9);
});

test('a slot recommendation can fill every socket with the right card', () => {
  const build = emptyBuild();
  build.slots.weapon = { itemId: oneHander.id, refine: 0, cards: [] };
  const s = new Suggester(dataset, [demihuman], OPEN);
  const moves = s.slotMoves(build, 'weapon');
  const recard = moves.find((m) => m.kind === 'cards');
  assert.ok(recard, 'expected a re-card of the worn weapon');
  const murderer = byName('Bloody Murderer Card').id;
  assert.ok(recard!.changes[0].state.cards.filter((c) => c === murderer).length >= 2);
});

test('an empty slot is offered a plain socketed piece full of goal cards', () => {
  // No weapon says Demi-Human itself, so without trying socketed weapons as
  // hosts the best answer -- a weapon full of Bloody Murderers -- is missed.
  const s = new Suggester(dataset, [demihuman], OPEN);
  const moves = s.slotMoves(emptyBuild(), 'weapon');
  const murderer = byName('Bloody Murderer Card').id;
  const best = moves.find((m) => m.kind === 'item'
    && m.changes[0].state.cards.filter((c) => c === murderer).length >= 2);
  assert.ok(best, `expected a weapon with Bloody Murderers, got ${moves.map((m) => m.label)}`);
});

test('auto refine raises a piece exactly as far as the goal needs', () => {
  // Pilfer Gem: "Per Refine: SP +20". Max SP 100 is reached at +5; anything
  // higher helps no further, so +5 is the answer.
  const s = new Suggester(dataset, [{ key: 'max_sp', column: 'flat', target: 100 }],
    { ...OPEN, refine: 'auto' });
  const pilfer = byName('Pilfer Gem of Stolen Spells');
  const move = s.slotMoves(emptyBuild(), 'gem', 200)
    .find((m) => m.changes[0].state.itemId === pilfer.id);
  assert.ok(move, 'expected the Pilfer Gem to be suggested');
  assert.equal(move!.changes[0].state.refine, 5);
  assert.match(move!.label, /^\+5 Pilfer Gem/);
});

test('auto refine leaves a piece at +0 when refine cannot reach the goal', () => {
  const s = new Suggester(dataset, [demihuman], { ...OPEN, refine: 'auto' });
  for (const move of s.slotMoves(emptyBuild(), 'weapon')) {
    if (move.maxed) continue;  // the +10 sibling, by design
    const item = dataset.items.get(move.changes[0].state.itemId!)!;
    const scales = [...item.refine.per_refine, ...item.refine.thresholds]
      .some((g) => g.effects.some((e) => e.stat_keys?.includes('dmg_vs_race_demihuman')));
    if (!scales) assert.equal(move.changes[0].state.refine, 0, item.name);
  }
});

test('each suggestion is followed by the same at full refine, but the plan is not', () => {
  const s = new Suggester(dataset, [{ key: 'max_sp', column: 'flat', target: 100 }],
    { ...OPEN, refine: 'auto' });
  const moves = s.slotMoves(emptyBuild(), 'gem', 200);
  const pilfer = byName('Pilfer Gem of Stolen Spells');
  const at = moves.findIndex((m) => m.changes[0].state.itemId === pilfer.id);
  assert.equal(moves[at].changes[0].state.refine, 5, 'the least that does it');
  const next = moves[at + 1];
  assert.ok(next.maxed, 'directly after it');
  assert.equal(next.changes[0].state.itemId, pilfer.id);
  assert.equal(next.changes[0].state.refine, 10);
  assert.match(next.label, /^\+10 Pilfer Gem/);
  // Full refine gives more SP than the goal needs, and says so.
  assert.ok(next.after[0] > moves[at].after[0]);
  assert.ok(s.plan(emptyBuild()).every((m) => !m.maxed));
});

test('no full-refine variant for gear already worn or already at the cap', () => {
  const build = emptyBuild();
  build.slots.weapon = { itemId: oneHander.id, refine: 3, cards: [] };
  const s = new Suggester(dataset, [demihuman], { ...OPEN, refine: 10 });
  const moves = s.slotMoves(build, 'weapon');
  // A fixed +10 already puts new pieces at the cap; re-carding the worn
  // weapon must not quietly refine it.
  assert.ok(moves.every((m) => !m.maxed));
});

test('auto refine never re-refines what is already worn', () => {
  const build = emptyBuild();
  build.slots.weapon = { itemId: oneHander.id, refine: 3, cards: [] };
  const s = new Suggester(dataset, [demihuman], { ...OPEN, refine: 'auto' });
  const recard = s.slotMoves(build, 'weapon').find((m) => m.kind === 'cards')!;
  assert.equal(recard.changes[0].state.refine, 3);
});

test('a plan only takes steps that help, and ends at the goal', () => {
  const build = emptyBuild();
  build.slots.weapon = { itemId: oneHander.id, refine: 0, cards: [] };
  const s = new Suggester(dataset, [demihuman], OPEN);
  const steps = s.plan(build);
  assert.ok(steps.length > 0);
  assert.ok(steps.every((m) => m.gain > 0));
  const after = steps.reduce((b, m) => applyChanges(b, m.changes, dataset), build);
  const [status] = goalStatus([demihuman], aggregate(after, dataset), after, dataset);
  assert.equal(status.met, true);
});

/**
 * A real level 136 Satsujin, from a player's share link: dagger and shield,
 * stacked AGI and flee, the three Maiden of Time cards, shadow gear.
 */
function satsujin(): Build {
  const build = emptyBuild();
  build.className = 'Satsujin';
  build.baseLevel = 136;
  build.baseStats = { str: 99, agi: 99, vit: 49, int: 49, dex: 49, luk: 1 };
  build.manual = { flee: 70 };
  const put = (slot: string, itemId: number, refine: number, cards: number[] = [],
    rolls: [string, string, number[]][] = []) => {
    build.slots[slot] = { itemId, refine, cards,
      ...(rolls.length ? { rolls: Object.fromEntries(
        rolls.map(([k, option, values]) => [k, { option, values }])) } : {}) };
  };
  put('upper', 18827, 6);
  put('middle', 5068, 0, [13571]);
  put('lower', 5928, 5, [4437, 4046], [['stat', 'str', [1]]]);
  put('armor', 2375, 0, [13589, 4051], [['stat', 'agi', [2]], ['resource', 'max_hp', [3]]]);
  put('weapon', 1533, 9, [4136]);
  put('offhand', 13063, 7, [4413]);
  put('garment', 15435, 6, [13590, 4092], [['stat', 'agi', [2]], ['evasion', 'perfect_dodge', [1]]]);
  put('shoes', 22000, 6, [13591], [['stat', 'agi', [1]], ['speed', 'move_speed', [9]]]);
  put('acc1', 2633, 0);
  put('acc2', 15424, 0, [13743], [['stat', 'agi', [1]]]);
  // The full Aggressive Orphan shadow set, a manual and a rune.
  put('sh_armor', 29928, 4, [], [['stat', 'agi', [1]]]);
  put('sh_shoes', 29930, 4, [], [['stat', 'agi', [1]]]);
  put('sh_gloves', 29929, 4, [], [['stat', 'agi', [1]]]);
  put('sh_acc', 29931, 6, [], [['stat', 'agi', [1]]]);
  put('sh_manual', 24021, 0, [], [['stat', 'agi', [1]]]);
  put('runeorb', 24173, 6, [], [['stat', 'agi', [1]]]);
  return build;
}

test('goals read off a build are what its gear stacks, all met as it stands', () => {
  const build = satsujin();
  const totals = aggregate(build, dataset);
  const goals = goalsFromBuild(build, totals, dataset);
  const keys = goals.map((g) => g.key);

  for (const k of ['agi', 'flee', 'def_pen']) assert.ok(keys.includes(k), `expected ${k}: ${keys}`);
  // Every piece has DEF and the weapons have MATK; wearing them is not a choice.
  assert.ok(!keys.includes('def') && !keys.includes('matk'), `base values leaked in: ${keys}`);
  // "All stats +N" alone does not make LUK a goal.
  assert.ok(!keys.includes('luk'));
  assert.ok(keys.indexOf('agi') < keys.indexOf('def_pen'), 'the most stacked stat first');
  assert.ok(goalStatus(goals, totals, build, dataset).every((s) => s.met), 'all start met');
  const cost = goals.find((g) => g.key === 'sp_cost');
  if (cost) assert.equal(cost.atMost, true, 'a cost is a ceiling');
});

test('with every goal met, the plan finds upgrades that lower nothing', () => {
  const build = satsujin();
  const goals = [...goalsFromBuild(build, aggregate(build, dataset), dataset)];
  const s = new Suggester(dataset, goals, { className: 'Satsujin', maxLevel: 136, refine: null });
  const steps = s.plan(build, 2);
  assert.ok(steps.length > 0, 'a mid-game build has something to improve');
  let at = build;
  for (const step of steps) {
    assert.ok(step.gain > 0);
    at = applyChanges(at, step.changes, dataset);
  }
  const before = s.values(build);
  const after = s.values(at);
  goals.forEach((g, i) => {
    const d = after[i] - before[i];
    assert.ok(g.atMost ? d <= 1e-9 : d >= -1e-9, `${g.key} got worse: ${before[i]} -> ${after[i]}`);
  });
  assert.ok(goals.some((g, i) => (g.atMost ? after[i] < before[i] : after[i] > before[i])));
});

/** The dataset with item effort, which is what turns the reach on. */
const withEffort: Dataset = {
  ...dataset,
  effort: new Map(Object.entries(load<Record<string, [number, number, number]>>('items/effort.json'))
    .map(([id, [effort, kill, via]]) => [Number(id), { effort, kill, via }])),
};

test('reach is read off the second-best piece, not the best', () => {
  const build = satsujin();
  const reach = reachOf(build, withEffort);
  // A +9 weapon, then +7, +6, +6, +6, +5: one +9 is not a habit of +9s.
  assert.equal(reach.refine, 7);
  // Wind Weaver is the hardest piece worn; the Venus Cape after it sets the bar.
  assert.equal(reach.effort, withEffort.effort!.get(15435)!.effort * REACH_EFFORT_FACTOR);
  assert.equal(reach.kill, withEffort.effort!.get(15435)!.kill * REACH_KILL_FACTOR);

  const fresh = reachOf(emptyBuild(), withEffort);
  assert.equal(fresh.refine, REACH_REFINE_FLOOR, 'nothing refined still assumes the safe range');
  assert.equal(fresh.effort, null, 'and nothing worn sets no bar at all');
  assert.equal(fresh.kill, null);
});

test('whole-build suggestions stay within reach; browsing a slot does not', () => {
  const build = satsujin();
  const goals = goalsFromBuild(build, aggregate(build, withEffort), withEffort);
  const opts: SuggestOptions = { className: 'Satsujin', maxLevel: 136, refine: 'auto' };
  const reach = reachOf(build, withEffort);

  // A sun helmet: a +9 moon helmet and a thousand Star Pieces away.
  const sun = byName('Apus of the Sun');
  const held = new Suggester(withEffort, goals, { ...opts, reach });
  assert.equal(held.allowed(sun), false, 'not offered to a build with one +9');
  assert.equal(new Suggester(withEffort, goals, opts).allowed(sun), true,
    'but there to be found when browsing the slot');
  // A Valhalla drop: a short enough grind, but off a 1.5 million HP Knight.
  assert.equal(held.allowed(byName('Veidistafur')), false, 'not while farming mid-level maps');
  assert.equal(held.allowed(byName('Mistress Card')), false, 'nor an MVP card');

  for (const step of new Suggester(withEffort, goals, opts).plan(build, 3)) {
    for (const c of step.changes) {
      const item = withEffort.items.get(c.state.itemId ?? -1);
      if (!item || item.id === build.slots[c.slot]?.itemId) continue;
      assert.ok(c.state.refine <= reach.refine, `${step.label} assumes +${c.state.refine}`);
      const e = withEffort.effort!.get(item.id);
      assert.ok(!e || (e.effort <= reach.effort! && e.kill <= reach.kill!),
        `${item.name} is out of reach`);
    }
  }
});

test('longer-term goals are only what reach turned away, each with something to farm', () => {
  const build = satsujin();
  const goals = goalsFromBuild(build, aggregate(build, withEffort), withEffort);
  const opts: SuggestOptions = { className: 'Satsujin', maxLevel: 136, refine: 'auto' };
  const reach = reachOf(build, withEffort);
  const near = new Suggester(withEffort, goals, { ...opts, reach });
  const stretch = new Suggester(withEffort, goals, opts).stretchMoves(build);
  assert.ok(stretch.length > 0, 'there is always something further to aim for');
  for (const m of stretch) {
    const beyond = m.changes.some((c) => [c.state.itemId, ...c.state.cards]
      .some((id) => { const i = id ? withEffort.items.get(id) : undefined; return !!i && !near.allowed(i); }));
    assert.ok(beyond, `${m.label} was within reach, so it belongs in the plan`);
    for (const c of m.changes) assert.ok(c.state.refine <= REFINE_MOVE_CAP, `${m.label} at +10`);
  }

  // A Sage piece is not farmed; its thousand essences are.
  const target = farmFor(byName('Sage Robe').id, withEffort)!;
  assert.equal(withEffort.items.get(target.itemId)!.name, 'Distortion Essence');
  assert.equal(target.qty, 1000);
  assert.ok(target.chance > 0 && target.mob.length > 0);
});

test('better-rolled copies aim at a typical roll, not the perfect one', () => {
  const build = satsujin();
  const goals = goalsFromBuild(build, aggregate(build, withEffort), withEffort);
  const s = new Suggester(withEffort, goals, { className: 'Satsujin', maxLevel: 136, refine: 'auto' });
  const rolls = s.rollUpgrades(build);
  assert.ok(rolls.length > 0, 'some worn piece rolls, and could roll better for this build');
  for (const m of rolls) {
    assert.equal(m.kind, 'rolls');
    assert.match(m.label, /^Farm another /);
    const [c] = m.changes;
    assert.equal(c.state.itemId, build.slots[c.slot].itemId, 'a copy of what is worn');
    const table = rollTableFor(withEffort.rolls, c.slot, withEffort.items.get(c.state.itemId!));
    for (const [key, pick] of Object.entries(c.state.rolls ?? {})) {
      // Rolls the worn piece already has, and nothing beat, are kept as they are.
      if (JSON.stringify(build.slots[c.slot].rolls?.[key]) === JSON.stringify(pick)) continue;
      const option = table?.rolls.find((r) => r.key === key)?.options.find((o) => o.key === pick.option);
      option?.grants.forEach((g, i) => {
        if (g.max !== null) assert.ok(pick.values[i] <= Math.ceil((g.min + g.max) / 2), `${m.label}: ${key} aims past the middle`);
      });
    }
  }
});

test('a complete set is not broken by a plan', () => {
  const build = satsujin();
  // Aggressive Orphan armour, boots, gloves and pendant: the full shadow set.
  const worn = aggregate(build, dataset).setProgress.find((p) => p.set.name.startsWith('Aggressive Orphan'));
  assert.ok(worn?.complete, 'the fixture wears the whole set');

  // Swapping one piece out is seen to break it.
  const other = itemList.find((i) => i.equip_slots.includes('Shadow armor')
    && !i.sets.includes(worn!.set.index))!;
  const swap = applyChanges(build, [{ slot: 'sh_armor', state: { itemId: other.id, refine: 0, cards: [] } }], dataset);
  assert.deepEqual(brokenSets(aggregate(build, dataset), aggregate(swap, dataset)).map((s) => s.index),
    [worn!.set.index]);

  const goals = goalsFromBuild(build, aggregate(build, withEffort), withEffort);
  const s = new Suggester(withEffort, goals, { className: 'Satsujin', maxLevel: 136, refine: 'auto' });
  let at = build;
  for (const step of s.plan(build, 4)) {
    const next = applyChanges(at, step.changes, withEffort);
    assert.deepEqual(brokenSets(aggregate(at, withEffort), aggregate(next, withEffort)), [],
      `${step.label} breaks a set`);
    at = next;
  }
});

test('class gems with no job sentence are held to their class', () => {
  const rules: Dataset = { ...dataset, classRules: load('class-rules.json') };
  const s = new Suggester(rules, [{ key: 'agi', column: 'total', target: 1 }],
    { className: 'Satsujin', maxLevel: null, refine: null });
  assert.equal(s.allowed(byName('Unbound Gem of Full Power')), false, 'a Phantom Thief gem');
  const thief = new Suggester(rules, [{ key: 'agi', column: 'total', target: 1 }],
    { className: 'Phantom Thief', maxLevel: null, refine: null });
  assert.equal(thief.allowed(byName('Unbound Gem of Full Power')), true);
});

test('upgrade paths lower nothing the build has, and show every kind of way forward', () => {
  const build = satsujin();
  const goals = allGoals({ ...build, goals: goalsFromBuild(build, aggregate(build, withEffort), withEffort) });
  const s = new Suggester(withEffort, goals, { className: 'Satsujin', maxLevel: 136, refine: 'auto' });
  const paths = s.upgradePaths(build);
  const now = s.values(build);

  for (const m of [...paths.near, ...paths.refines, ...paths.rolls, ...paths.far]) {
    const after = s.values(applyChanges(build, m.changes, withEffort));
    goals.forEach((g, i) => {
      const worse = g.atMost ? after[i] > now[i] + 1e-9 : after[i] < now[i] - 1e-9;
      // SP efficiency and HP included: a met goal is not a surplus to spend.
      assert.ok(!worse, `${m.label} lowers ${g.key}: ${now[i]} -> ${after[i]}`);
    });
  }
  assert.ok(paths.near.length > 0, 'something within reach');
  assert.ok(paths.refines.some((m) => /Valkyrie Circlet/.test(m.label)),
    'the circlet refine is not crowded out by the swaps');
  assert.ok(paths.far.length > 0, 'and something to work towards');
  const slots = paths.near.map((m) => m.changes.map((c) => c.slot).join());
  assert.equal(new Set(slots).size, slots.length, 'one per slot, not the same slot three ways');
});

test('refines are offered on their own, for the goals a player actually set', () => {
  const build = satsujin();
  const opts: SuggestOptions = { className: 'Satsujin', maxLevel: 136, refine: 'auto' };
  // The goals on the player's own share link, all already met.
  const theirs: Goal[] = [
    { key: 'flee', column: 'flat', target: 22 },
    { key: 'melee_damage', column: 'percent', target: 10 },
    { key: 'def_pen', column: 'flat', target: 42 },
  ];
  const refines = new Suggester(withEffort, theirs, opts).refineUpgrades(build);
  assert.ok(refines.some((m) => /Wind Weaver/.test(m.label)),
    `flee per refine on Wind Weaver serves the flee goal: ${refines.map((m) => m.label)}`);

  // A flee total goal counts AGI as well, so the circlet's all-stats refine
  // serves it.
  const flee: Goal = { key: 'flee', column: 'total', target: 1 };
  const circlet = new Suggester(withEffort, [flee], opts).refineUpgrades(build);
  assert.ok(circlet.some((m) => /Valkyrie Circlet/.test(m.label)),
    `AGI feeds flee: ${circlet.map((m) => m.label)}`);
});

test('refining what is worn is offered up to +9, never +10', () => {
  const build = satsujin();
  const goals = goalsFromBuild(build, aggregate(build, dataset), dataset);
  const s = new Suggester(dataset, goals, { className: 'Satsujin', maxLevel: 136, refine: 'auto' });
  const moves = s.refineMoves(build);
  assert.ok(moves.length > 0, 'a +6 circlet giving all stats per refine has room to go');
  for (const m of moves) {
    const [c] = m.changes;
    assert.equal(c.state.itemId, build.slots[c.slot].itemId, 'the same piece, refined');
    assert.ok(c.state.refine > build.slots[c.slot].refine && c.state.refine <= REFINE_MOVE_CAP,
      `${m.label} goes to +${c.state.refine}`);
  }
  assert.ok(!moves.some((m) => m.changes[0].slot === 'weapon'), 'the +9 weapon is left alone');
});

test('a loss only counts on a stat the build uses, or its class always wants', () => {
  const build = satsujin();
  const totals = aggregate(build, dataset);
  const used = statsThatMatter(build, totals, dataset);
  assert.ok(used.has('flee') && used.has('def_pen'));
  assert.ok(!used.has('crit_rate'), 'this Satsujin has no crit to lose');

  const legend = { ...build, className: 'Legend' };
  assert.ok(statsThatMatter(legend, totals, dataset).has('crit_rate'),
    'a Legend always wants crit');
});

test('suggestions respect the class and level limits', () => {
  const build = emptyBuild();
  const opts: SuggestOptions = { className: 'Assassin', maxLevel: 50, refine: null };
  const s = new Suggester(dataset, [{ key: 'crit_rate', column: 'flat', target: 50 }], opts);
  for (const move of s.plan(build)) {
    for (const change of move.changes) {
      const item = dataset.items.get(change.state.itemId!)!;
      assert.ok(item.required_level <= 50, `${item.name} needs Lv ${item.required_level}`);
      assert.ok(s.allowed(item), `${item.name} is not for Assassins`);
    }
  }
});

test('a set whose bonus serves a goal is offered as one move', () => {
  // Find a two-piece set whose bonus names a stat neither piece names.
  const s0 = dataset.sets.find((set) => set.member_count === 2
    && set.members.every((m) => m.kind !== 'Card')
    && set.set_bonus.some((e) => e.stat_ids?.length === 1 && e.unit === null && (e.value ?? 0) > 0
      && set.member_ids.every((id) => !(dataset.items.get(id)?.effects ?? [])
        .some((x) => x.stat_ids?.includes(e.stat_ids![0])))))!;
  assert.ok(s0, 'expected at least one such set in the data');
  const eff = s0.set_bonus.find((e) => e.stat_ids?.length === 1 && e.unit === null)!;
  const key = stats.find((st) => st.id === eff.stat_ids![0])!.key;
  const s = new Suggester(dataset, [{ key, column: 'flat', target: 10_000 }], OPEN);
  const moves = s.setMoves(emptyBuild());
  assert.ok(moves.some((m) => m.label.includes(s0.name)), `expected ${s0.name} to be offered`);
});

test('putting on a two-handed weapon clears the off hand', () => {
  const twoHander = itemList.find((i) => isTwoHanded(i))!;
  const shield = itemList.find((i) => i.kind === 'Shield')!;
  const build = emptyBuild();
  build.slots.offhand = { itemId: shield.id, refine: 0, cards: [] };
  const next = applyChanges(build,
    [{ slot: 'weapon', state: { itemId: twoHander.id, refine: 0, cards: [] } }], dataset);
  assert.equal(next.slots.offhand.itemId, null);
});

test('a skill modifier can be a goal, and suggestions chase it', () => {
  // "Back Stab" as the server's own skill list spells it. The tooltips
  // write it both ways; the parser snaps both onto the official name.
  const metric = goalMetrics(dataset).find((m) => m.key === 'skill:Back Stab|damage');
  assert.ok(metric, 'expected Back Stab damage to be offered as a goal');
  assert.equal(metric!.column, 'percent');
  const goal: Goal = { key: metric!.key, column: 'percent', target: 30 };
  const s = new Suggester(dataset, [goal], OPEN);
  const steps = s.plan(emptyBuild());
  assert.ok(steps.length > 0 && steps.every((m) => m.gain > 0));
  const after = steps.reduce((b, m) => applyChanges(b, m.changes, dataset), emptyBuild());
  assert.ok(measure(goal, aggregate(after, dataset), after, dataset) > 0);
});

test('pieces with more card slots are offered, carrying the worn cards', () => {
  const card = itemList.find((i) => i.kind === 'Card' && i.equip_slots.includes('Lower headgear'))!;
  const oneSlot = itemList.find((i) => i.card_slots === 1
    && fitsSlot(i, SLOTS.find((x) => x.key === 'lower')!))!;
  const build = emptyBuild();
  build.slots.lower = { itemId: oneSlot.id, refine: 0, cards: [card.id] };
  // No goals at all: still offered.
  const s = new Suggester(dataset, [], OPEN);
  const moves = s.socketMoves(build, 'lower');
  assert.ok(moves.length > 0);
  for (const move of moves) {
    const item = dataset.items.get(move.changes[0].state.itemId!)!;
    assert.ok(item.card_slots > 1);
    // Every socket holds a copy of the card that was worn.
    assert.deepEqual(move.changes[0].state.cards, Array(item.card_slots).fill(card.id));
  }
  // Most sockets first.
  const counts = moves.map((m) => dataset.items.get(m.changes[0].state.itemId!)!.card_slots);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
});

test('melee and ranged are one stat under every name', () => {
  const keysOf = (name: string) => byName(name).effects.flatMap((e) => e.stat_keys ?? []);
  assert.ok(keysOf('Siegfried Avatar Card').includes('melee_damage'), 'Short Range DMG');
  const cats = byName('School of Cats Pendant');
  assert.ok([...cats.effects, ...cats.piece_bonus]
    .some((e) => /Ranged ATK/.test(e.text) && e.stat_keys?.includes('ranged_damage')), 'Ranged ATK');
  assert.ok(keysOf('Horn Card').includes('res_ranged'), 'Ranged Damage Reduction');
  assert.ok(keysOf('Chain Mail').includes('reflect_melee'), 'Reflects 2% Melee Damage');
});

test('a goal already met still pulls, at lower priority', () => {
  // Leech already past its target: more leech is still a (small) gain, so
  // Lord of the Dead is recommended for the middle headgear.
  const build = emptyBuild();
  const middle = itemList.find((i) => i.card_slots > 0
    && fitsSlot(i, SLOTS.find((s) => s.key === 'middle')!))!;
  build.slots.middle = { itemId: middle.id, refine: 0, cards: [] };
  const rate: Goal = { key: 'leech_hp_rate', column: 'percent', target: 0 };
  const s = new Suggester(dataset, [rate], OPEN);
  const lord = byName('Lord of The Dead Card');
  const scores = s.rank(build, 'middle', 0, [lord]);
  assert.ok(scores.get(lord.id)!.gain > 0, 'more of a met goal is still better');

  // ...but never outbids the same progress on a goal still short: 15 more
  // past a met target of 15 is worth less than 15 towards an unmet 30.
  const gainOf = (target: number, from: number, to: number) => {
    const g: Goal[] = [{ ...rate, target }];
    return goalScore(g, [from]) - goalScore(g, [to]);
  };
  const beyond = gainOf(15, 15, 30);
  const closing = gainOf(30, 0, 15);
  assert.ok(beyond > 0, 'still a gain');
  assert.ok(closing > beyond, 'but less than closing a gap');
});

test('the order of the goals is a priority, and it can be reordered', () => {
  const atk: Goal = { key: 'atk', column: 'flat', target: 100 };
  const matk: Goal = { key: 'matk', column: 'flat', target: 100 };

  // Both met, one beaten by 100. The same two numbers score better with the
  // beaten goal on top, which is what makes reordering worth doing.
  assert.ok(goalScore([atk, matk], [200, 100]) < goalScore([matk, atk], [100, 200]));
  // A lean, not a veto: a goal far short of its target still outranks a
  // surplus on the goal above it.
  assert.ok(goalScore([atk, matk], [200, 0]) > goalScore([atk, matk], [100, 100]));
  assert.ok(priorityWeight(0) === 1 && priorityWeight(1) < 1 && priorityWeight(2) < priorityWeight(1));

  // And it shows in what gets suggested. Melee and ranged are both met from
  // the start and gear rarely feeds both, so the order is the only thing
  // left to choose by: whichever is on top gets the weapon.
  const melee: Goal = { key: 'melee_damage', column: 'percent', target: 0 };
  const ranged: Goal = { key: 'ranged_damage', column: 'percent', target: 0 };
  const build = emptyBuild();
  /** The best move for this order, as [melee gained, ranged gained]. */
  const topOf = (goals: Goal[]) => {
    const best = new Suggester(dataset, goals, OPEN)
      .slotMoves(build, 'weapon', 12, true, false)
      .sort((a, b) => b.gain - a.gain)[0];
    const at = (g: Goal) => {
      const i = goals.indexOf(g);
      return best.after[i] - best.before[i];
    };
    return { melee: at(goals.find((g) => g.key === melee.key)!),
      ranged: at(goals.find((g) => g.key === ranged.key)!) };
  };
  const meleeFirst = topOf([melee, ranged]);
  const rangedFirst = topOf([ranged, melee]);
  assert.ok(meleeFirst.melee > rangedFirst.melee, 'melee on top buys more melee');
  assert.ok(rangedFirst.ranged > meleeFirst.ranged, 'ranged on top buys more ranged');
});

test('asking about one goal does not promote the goals under it', () => {
  // Melee is second of three. The cost of a move is judged with the third
  // goal still third, not shuffled up into melee's place.
  const first: Goal = { key: 'max_hp', column: 'flat', target: 10000 };
  const melee: Goal = { key: 'melee_damage', column: 'percent', target: 20 };
  const third: Goal = { key: 'crit_rate', column: 'flat', target: 50 };
  const s = new Suggester(dataset, [first, melee, third], OPEN);
  const moves = s.focusMoves(emptyBuild(), melee);
  assert.ok(moves.length > 0);
  // Whatever it flags as a trade must really cost one of the other two.
  for (const move of moves.filter((m) => m.sidegrade)) {
    const worse = (i: number) => move.after[i] < move.before[i] - 1e-9;
    assert.ok(worse(0) || worse(2), `${move.label} costs another goal`);
  }
});

test('sidegrades are listed after the upgrades, and never planned', () => {
  // Two goals that pull against each other on the same slot.
  const goals: Goal[] = [
    { key: 'atk', column: 'flat', target: 400 },
    { key: 'matk', column: 'flat', target: 400 },
  ];
  const s = new Suggester(dataset, goals, OPEN);
  // Wearing the hardest-hitting physical weapon, so a MATK weapon is a trade.
  const build = emptyBuild();
  const brute = itemList.filter((i) => i.kind === 'Weapon' && !i.matk && !isTwoHanded(i))
    .sort((a, b) => b.atk - a.atk)[0];
  build.slots.weapon = { itemId: brute.id, refine: 0, cards: [] };
  const moves = s.slotMoves(build, 'weapon', 12);
  const firstSide = moves.findIndex((m) => m.sidegrade);
  assert.ok(firstSide >= 0, 'expected at least one trade between ATK and MATK');
  assert.ok(moves.slice(firstSide).every((m) => m.sidegrade), 'sidegrades come last');
  assert.ok(moves.filter((m) => m.sidegrade).every((m) => m.gain <= 1e-9));
  assert.ok(s.plan(emptyBuild()).every((m) => !m.sidegrade && m.gain > 0));
});

test('clicking one goal finds more of it even when every goal is met', () => {
  // Melee damage already at its target, so the plan has no gap to close --
  // which is exactly when "just give me more of this" is the question.
  const melee: Goal = { key: 'melee_damage', column: 'percent', target: 0 };
  const flee: Goal = { key: 'flee', column: 'total', target: 0 };
  const s = new Suggester(dataset, [melee, flee], OPEN);
  const build = emptyBuild();
  assert.ok(goalStatus([melee, flee], aggregate(build, dataset), build, dataset)
    .every((g) => g.met), 'both goals start met');
  // The plan then looks for upgrades rather than stopping, and none of them
  // may take a goal below its target.
  for (const step of s.plan(build)) {
    assert.equal(s.breaks(step).length, 0, `${step.label} breaks a goal`);
  }

  const moves = s.focusMoves(build, melee);
  assert.ok(moves.length > 0, 'but there is still more melee damage to be had');
  for (const move of moves) {
    assert.ok(move.after[0] > move.before[0], `${move.label} gives more melee damage`);
    // The numbers a move reports must be the ones the aggregator gives for
    // the build it describes, or the panel and the list would disagree.
    const after = applyChanges(build, move.changes, dataset);
    assert.equal(
      measure(melee, aggregate(after, dataset), after, dataset),
      move.after[0],
    );
  }
});

test('free swaps come first, and a trade says which goal it costs', () => {
  // Melee and ranged pull against each other: gear feeds one or the other,
  // so pushing melee past its target has to cost the ranged goal somewhere.
  const melee: Goal = { key: 'melee_damage', column: 'percent', target: 0 };
  const ranged: Goal = { key: 'ranged_damage', column: 'percent', target: 60 };
  const s = new Suggester(dataset, [melee, ranged], OPEN);
  const build = emptyBuild();
  const moves = s.focusMoves(build, melee).filter((m) => !m.maxed);
  assert.ok(moves.length > 1);

  const costs = (m: typeof moves[number]) => m.after[1] < m.before[1] - 1e-9;
  // Whatever is flagged a trade costs the other goal, and whatever is not
  // costs it nothing. That is the whole claim the flag makes.
  for (const move of moves) assert.equal(!!move.sidegrade, costs(move), move.label);
  const firstTrade = moves.findIndex((m) => m.sidegrade);
  if (firstTrade >= 0) {
    assert.ok(moves.slice(firstTrade).every((m) => m.sidegrade), 'free swaps first');
  }

  // Within the free ones, most of the wanted stat first.
  const free = moves.filter((m) => !m.sidegrade).map((m) => m.after[0] - m.before[0]);
  for (let i = 1; i < free.length; i++) {
    assert.ok(free[i] <= free[i - 1] + 1e-9, 'ordered by how much melee damage they add');
  }
});

test('pushing a goal that wants less asks for less', () => {
  // Variable cast is a ceiling: "more of it" means further down.
  const cast: Goal = { key: 'variable_cast', column: 'percent', target: 0, atMost: true };
  const s = new Suggester(dataset, [cast], OPEN);
  const build = emptyBuild();
  const moves = s.focusMoves(build, cast);
  assert.ok(moves.length > 0);
  for (const move of moves) {
    assert.ok(move.after[0] < move.before[0], `${move.label} cuts variable cast`);
  }
});

test('a goal the suggester does not hold is not answered', () => {
  const s = new Suggester(dataset, [demihuman], OPEN);
  const other: Goal = { key: 'max_hp', column: 'flat', target: 1000 };
  assert.deepEqual(s.focusMoves(emptyBuild(), other), []);
  // The same goal by value rather than by identity is still that goal.
  assert.ok(s.focusMoves(emptyBuild(), { ...demihuman }).length > 0);
});

test('pushing a met goal still refines, where plain planning would not', () => {
  // A weapon whose refine only feeds a goal that is already met: tuning on
  // shortfall would tie at every refine and leave it at +0.
  const melee: Goal = { key: 'melee_damage', column: 'percent', target: 0 };
  // No reach: an empty build could only be assumed to reach +4, and this is
  // about how refine is tuned, not how far.
  const auto: SuggestOptions = { className: null, maxLevel: null, refine: 'auto', reach: null };
  const s = new Suggester(dataset, [melee], auto);
  const moves = s.focusMoves(emptyBuild(), melee).filter((m) => !m.maxed);
  assert.ok(moves.some((m) => m.changes.some((c) => c.state.refine > 0)),
    'at least one suggestion is refined to get more out of the piece');
});

test('falling below a met goal is its own category, worse than any trade', () => {
  // Chasing defence penetration with a Max HP target already met: more pen is
  // wanted, but not at the price of the HP target.
  const pen: Goal = { key: 'def_pen', column: 'flat', target: 10 };
  const build = emptyBuild();
  const armor = itemList.filter((i) => i.kind === 'Armor'
    && i.effects.some((e) => e.stat_keys?.includes('max_hp')))
    .sort((a, b) => b.required_level - a.required_level)[0];
  build.slots.armor = { itemId: armor.id, refine: 0, cards: [] };
  // Targeted at exactly what the build has, so it is met and any loss of it
  // is a goal going short rather than a surplus being spent.
  const hp: Goal = { key: 'max_hp', column: 'percent', target: 0 };
  hp.target = measure(hp, aggregate(build, dataset), build, dataset);
  assert.ok(hp.target > 0, 'the armour gives HP to lose');
  const s = new Suggester(dataset, [pen, hp], OPEN);
  assert.ok(goalStatus([hp], aggregate(build, dataset), build, dataset)[0].met,
    'the HP goal starts met');

  const moves = s.focusMoves(build, pen);
  assert.ok(moves.length > 0, 'there is more pen to be had');
  const breaks = (m: Move) => brokenGoals([pen, hp], m.before, m.after).length > 0;
  const firstBad = moves.findIndex(breaks);
  if (firstBad >= 0) {
    assert.ok(moves.slice(firstBad).every(breaks),
      'once the list drops below a target it never comes back up');
    assert.ok(firstBad > 0, 'something that keeps every goal met is offered first');
  }
  // Every one of them still gives more pen: it is the order that changes,
  // not the answer to the question.
  for (const move of moves) assert.ok(move.after[0] > move.before[0]);
});

test('a plan never takes a step that costs a goal its target', () => {
  // Two goals in tension, the second met from the start: reaching the first
  // must not be done by giving up the second.
  const goals: Goal[] = [
    { key: 'dmg_vs_race_demihuman', column: 'percent', target: 60 },
    { key: 'max_hp', column: 'flat', target: 500 },
  ];
  const s = new Suggester(dataset, goals, OPEN);
  const build = emptyBuild();
  build.baseStats.vit = 60;
  for (const move of s.plan(build)) {
    assert.deepEqual(brokenGoals(goals, move.before, move.after), [],
      `${move.label} keeps every met goal met`);
  }
});

test('only the crossing counts as breaking a goal', () => {
  const goal: Goal = { key: 'max_hp', column: 'flat', target: 100 };
  // Met, then short: broken.
  assert.equal(brokenGoals([goal], [120], [90]).length, 1);
  // Short, then shorter: a loss the score already charges for, not a break.
  assert.equal(brokenGoals([goal], [90], [50]).length, 0);
  // Met, then less surplus but still met: not a break.
  assert.equal(brokenGoals([goal], [200], [110]).length, 0);
  // Exactly on target counts as met, either side of the change.
  assert.equal(brokenGoals([goal], [100], [100]).length, 0);
  assert.equal(brokenGoals([goal], [100], [99]).length, 1);
  // A ceiling works the same way round.
  const cap: Goal = { key: 'fixed_cast', column: 'percent', target: -10, atMost: true };
  assert.equal(brokenGoals([cap], [-20], [-5]).length, 1);
  assert.equal(brokenGoals([cap], [-20], [-15]).length, 0);
});

test('a locked slot is never suggested for', () => {
  const s = new Suggester(dataset, [demihuman], OPEN);
  const build = emptyBuild();
  const open = s.plan(build);
  assert.ok(open.length > 0, 'there is something to suggest to begin with');
  const busy = open.flatMap((m) => m.changes.map((c) => c.slot));

  // Lock every slot the open plan wanted to touch: none of them may come
  // back, by any route -- the plan, the slot's own list, its sockets, or a
  // set that would have used it.
  const locked: Build = { ...build, locked: [...new Set(busy)] };
  for (const key of locked.locked!) {
    assert.deepEqual(s.slotMoves(locked, key), [], `${key} offers nothing`);
    assert.deepEqual(s.socketMoves(locked, key), [], `${key} offers no sockets`);
    assert.deepEqual(s.rollMoves(locked, key), [], `${key} offers no rolls`);
  }
  for (const move of s.plan(locked)) {
    for (const c of move.changes) {
      assert.ok(!locked.locked!.includes(c.slot), `${move.label} keeps off ${c.slot}`);
    }
  }
  for (const move of s.setMoves(locked)) {
    for (const c of move.changes) {
      assert.ok(!locked.locked!.includes(c.slot), `${move.label} keeps off ${c.slot}`);
    }
  }
  // And the rest of the build is still worked on, rather than the lock
  // quietly stopping everything.
  assert.ok(s.plan(locked).length > 0, 'the other slots are still planned for');
});

test('a locked off hand is not emptied by a two-handed weapon', () => {
  // The one change that reaches past the slot it names: applyChanges clears
  // the off hand for a two-hander, which would undo a lock from outside.
  const shield = itemList.find((i) => i.kind === 'Shield'
    && i.equip_slots.includes('Off-hand') && i.def > 0)!;
  const goals: Goal[] = [{ key: 'atk', column: 'flat', target: 2000 }];
  const s = new Suggester(dataset, goals, OPEN);
  const build = emptyBuild();
  build.slots.offhand = { itemId: shield.id, refine: 0, cards: [] };

  const twoHanded = (move: Move) => move.changes.some((c) =>
    c.slot === 'weapon' && isTwoHanded(dataset.items.get(c.state.itemId ?? -1)));
  assert.ok(s.slotMoves(build, 'weapon', 30).some(twoHanded),
    'a two-hander is on the table while the off hand is free to go');

  const locked: Build = { ...build, locked: ['offhand'] };
  assert.equal(s.slotMoves(locked, 'weapon', 30).some(twoHanded), false);
  assert.equal(s.plan(locked).some(twoHanded), false);
  // Still suggests one-handers for the weapon slot: the lock is on the other
  // hand, not on this one.
  assert.ok(s.slotMoves(locked, 'weapon', 30).length > 0);
});

test('an empty slot can be locked too, and stays empty', () => {
  const s = new Suggester(dataset, [demihuman], OPEN);
  const build: Build = { ...emptyBuild(), locked: ['garment'] };
  assert.deepEqual(s.slotMoves(build, 'garment'), []);
  for (const move of s.plan(build)) {
    assert.ok(move.changes.every((c) => c.slot !== 'garment'));
  }
});

test('bonuses are coloured by what they do, not by their sign', () => {
  const eff = (stat_keys: string[], value: number, extra = {}) =>
    ({ text: '', parsed: true, value, stat_keys, stat_ids: [1], ...extra });
  assert.equal(effectTone(eff(['str'], -5)), 'bad');
  assert.equal(effectTone(eff(['str'], 5)), 'good');
  assert.equal(effectTone(eff(['sp_cost'], -10)), 'good');
  assert.equal(effectTone(eff(['variable_cast'], 20)), 'bad');
  assert.equal(effectTone({ text: '', parsed: true, value: -2, stat_keys: [],
    skill: 'Heal', skill_metric: 'cooldown' }), 'good');
  assert.equal(effectTone({ text: '', parsed: true, value: -60, stat_keys: [],
    skill: 'Comet', skill_metric: 'damage' }), 'bad');
  assert.equal(effectTone({ text: 'prose', parsed: false }), null);
});

test('a suggestion reports everything it changes, losses included', () => {
  // Pilfer Gem: SP up per refine, MATK -50, All Stats -5, Comet -60%.
  const build = emptyBuild();
  const gem = byName('Pilfer Gem of Stolen Spells');
  const after = applyChanges(build,
    [{ slot: 'gem', state: { itemId: gem.id, refine: 0, cards: [] } }], dataset);
  const diff = diffTotals(aggregate(build, dataset), aggregate(after, dataset), dataset);
  const find = (label: string) => diff.find((c) => c.label === label);
  assert.equal(find('MATK')?.delta, -50);
  assert.equal(find('MATK')?.tone, 'bad');
  assert.equal(find('STR')?.delta, -5);
  assert.equal(find('Comet damage')?.delta, -60);
  // Gains before losses.
  const firstBad = diff.findIndex((c) => c.tone === 'bad');
  assert.ok(diff.slice(firstBad).every((c) => c.tone === 'bad'));
});

test('accessories roll ATK %, MATK % and flat ASPD on top of the base stats', () => {
  const acc = tableForSlot(dataset.rolls, 'acc1')!;
  const head = tableForSlot(dataset.rolls, 'upper')!;
  const keys = (t: typeof acc) => t.rolls.find((r) => r.key === 'stat')!.options.map((o) => o.key);
  for (const k of ['atk_pct', 'matk_pct', 'aspd_flat']) {
    assert.ok(keys(acc).includes(k), `accessory ${k}`);
    assert.ok(!keys(head).includes(k), `headgear must not roll ${k}`);
  }
  const aspd = acc.rolls[0].options.find((o) => o.key === 'aspd_flat')!.grants[0];
  assert.equal(aspd.stat, 'aspd');
  assert.equal(aspd.unit, null, 'flat, not the percent shoes roll');
});

test('roll advice picks the option that serves the goals, at the top of its range', () => {
  const acc = itemList.find((i) => i.equip_slots.includes('Accessory') && i.kind === 'Accessory'
    && (i.drops?.length ?? 0) > 0)!;
  const build = emptyBuild();
  build.slots.acc1 = { itemId: acc.id, refine: 0, cards: [] };
  const s = new Suggester(dataset, [{ key: 'dex', column: 'total', target: 99 }], OPEN);
  const [move] = s.rollMoves(build, 'acc1');
  assert.ok(move, 'expected roll advice');
  // Accessories roll a stat +1 at most; +2 is armour, garment and shoes.
  assert.deepEqual(move.changes[0].state.rolls?.stat, { option: 'dex', values: [1] });
  assert.match(move.label, /DEX \+1/);
});

test('a skill-damage roll is aimed at a skill the goals name', () => {
  // One that says it rolls skill mods; a plain drop only rolls stats.
  const acc = byName('Vesper Core01');
  const build = emptyBuild();
  build.slots.acc1 = { itemId: acc.id, refine: 0, cards: [] };
  const goal: Goal = { key: 'skill:Back Stab|damage', column: 'percent', target: 50 };
  const [move] = new Suggester(dataset, [goal], OPEN).rollMoves(build, 'acc1');
  assert.equal(move.changes[0].state.rolls?.skill?.skill, 'Back Stab');
  assert.equal(move.after[0], 5);
});

test('no goals means no opinion', () => {
  const s = new Suggester(dataset, [], OPEN);
  assert.equal(s.active, false);
  assert.deepEqual(s.plan(emptyBuild()), []);
  assert.equal(s.rank(emptyBuild(), 'armor', null, itemList).size, 0);
});

test('a race or size goal counts the "all" line too, and "any" goals take the weakest', () => {
  const build = emptyBuild();
  const g = (key: string): Goal => ({ key, column: 'percent', target: 0 });
  const at = (b: Build, key: string) => measure(g(key), aggregate(b, dataset), b, dataset);
  // Ifrit Card: Damage vs All Sizes +6%. A Large goal used to read none of it.
  build.slots.acc1 = { itemId: byName('Invoker\'s Ring').id, refine: 0, cards: [byName('Ifrit Card').id] };
  assert.equal(at(build, 'dmg_vs_size_large'), 6);
  assert.equal(at(build, 'any_size_dmg'), 6);
  // Vesper Card: "all elements" is written onto each of the ten.
  const robe = itemList.find((i) => i.equip_slots.includes('Armor') && i.card_slots === 1
    && i.effects.every((e) => !e.stat_keys?.some((k) => k.startsWith('dmg_vs'))))!;
  build.slots.armor = { itemId: robe.id, refine: 0, cards: [byName('Vesper Card').id] };
  assert.equal(at(build, 'any_element_dmg'), 4);
  // One race is not any race.
  const demi = itemList.find((i) => i.kind === 'Card' && i.effects.length === 1
    && i.effects[0].stat_keys?.length === 1 && i.effects[0].stat_keys[0] === 'dmg_vs_race_demihuman')!;
  build.slots.weapon = { itemId: oneHander.id, refine: 0, cards: [demi.id] };
  assert.ok(at(build, 'dmg_vs_race_demihuman') > 0);
  assert.equal(at(build, 'any_race_dmg'), 0);
  // Race, size and element multiply: 1.06 x 1.04.
  assert.ok(Math.abs(at(build, 'any_target_dmg') - (1.06 * 1.04 - 1) * 100) < 1e-9);

  // And the suggester looks at both cards for it.
  const s = new Suggester(dataset, [{ ...g('any_target_dmg'), target: 20 }], OPEN);
  assert.ok(s.mayMatter(byName('Ifrit Card')) && s.mayMatter(byName('Vesper Card')));
  const bare = emptyBuild();
  bare.slots.weapon = { itemId: oneHander.id, refine: 0, cards: [] };
  const ranked = s.rank(bare, 'weapon', 0, [demi, byName('Vesper Card')]);
  assert.equal(ranked.get(demi.id)?.gain ?? 0, 0, 'a one-race card does nothing against any target');
});

test('Invoker\'s Ring drops from Necromancer too, which is what brings it within reach', () => {
  const ring = byName('Invoker\'s Ring');
  const necro = ring.drops.find((d) => d.mob === 'Necromancer');
  assert.equal(necro?.chance_percent, 0.5);
  assert.equal(withEffort.effort!.get(ring.id)!.via, necro!.mob_id, 'the cheapest route is now the normal monster');
});

/** A leech build whose accessories carry other goals: the Invoker's Ring is a trade. */
function leecher(): Build {
  const build = emptyBuild();
  build.baseLevel = 130;
  const put = (slot: string, name: string, refine = 0) => {
    build.slots[slot] = { itemId: byName(name).id, refine, cards: [] };
  };
  put('middle', 'Evil Wing Ears'); put('armor', 'Jiangshi Clothes', 6);
  put('acc1', 'Vesper Core03'); put('acc2', 'Vesper Core01');
  put('weapon', 'Green Mantis', 6); put('shoes', 'Metal Boots MK I', 6);
  return build;
}

test('sidegrades are trades that come out ahead, high effort included but marked', () => {
  const build = leecher();
  const goals = [
    { key: 'leech_hp_rate', column: 'percent' as const, target: 23 },
    ...goalsFromBuild(build, aggregate(build, withEffort), withEffort),
  ];
  // As it was before the Necromancer drop: an MVP ring, far past this build
  // -- ten times its reach, inside the twenty the longer-term lists look to.
  const mvpOnly: Dataset = { ...withEffort, effort: new Map(withEffort.effort) };
  mvpOnly.effort!.set(byName('Invoker\'s Ring').id,
    { effort: reachOf(build, withEffort).effort! * 10, kill: 254458, via: 1871 });
  const s = new Suggester(mvpOnly, [...goals, ...allGoals({ ...build, goals: [] })],
    { className: null, maxLevel: 130, refine: 'auto' });
  const paths = s.upgradePaths(build);
  const ring = paths.sides.find((m) => m.label.startsWith('Invoker\'s Ring'));
  assert.ok(ring, 'the ring is offered for an accessory that gave something else');
  assert.equal(ring!.highEffort, true, 'and said to be a long way off');
  for (const m of paths.sides) {
    assert.ok(tradeValueOf(s, m) > 0, `${m.label} does not come out ahead`);
    assert.ok(!brokenGoals(s.goals, m.before, m.after).some((g) => g.guard), `${m.label} crosses a guard`);
  }
  assert.ok(paths.far.every((m) => m.highEffort));

  // Here something close by is worth nearly as much, so nothing is called out.
  assert.equal(paths.farm.length, 0);
  // With only the one accessory free, and leech the one goal -- nothing close
  // by gives any -- the ring is worth farming on purpose, off the MVP it drops from.
  const alone: Build = { ...build, locked: SLOTS.map((x) => x.key).filter((k) => k !== 'acc1') };
  const leechOnly = new Suggester(mvpOnly, [goals[0], ...allGoals({ ...build, goals: [] })],
    { className: null, maxLevel: 130, refine: 'auto' });
  const far = leechOnly.upgradePaths(alone).far;
  const { farm } = leechOnly.tradeOffs(alone, [], far);
  const called = farm.find((m) => m.label.startsWith("Invoker's Ring"));
  assert.ok(called?.standout && called.highEffort);
  assert.equal(farmFor(byName("Invoker's Ring").id, mvpOnly)?.mob, 'Fallen Bishop');
});

function tradeValueOf(s: Suggester, m: Move): number {
  return tradeValue(s.goals.map((g, i) => ({ ...g, target: m.before[i] })), m.before, m.after);
}

test('more of one goal looks past reach too, marked and ranked lower, off hand included', () => {
  const build = emptyBuild();
  build.baseLevel = 130;
  const put = (slot: string, name: string, refine = 0) => {
    build.slots[slot] = { itemId: byName(name).id, refine, cards: [] };
  };
  put('weapon', 'Main Gauche', 6); put('armor', 'Jiangshi Clothes', 6);
  put('shoes', 'Metal Boots MK I', 6); put('middle', 'Evil Wing Ears');
  const goal: Goal = { key: 'dmg_vs_race_demihuman', column: 'percent', target: 10 };
  const s = new Suggester(withEffort, [goal, ...allGoals({ ...build, goals: [] })],
    { className: null, maxLevel: 130, refine: 'auto' });
  const moves = s.focusMoves(build, goal);
  const reach = reachOf(build, withEffort);
  const near = new Suggester(withEffort, [goal], { className: null, maxLevel: 130, refine: 'auto', reach });
  const far = moves.filter((m) => m.highEffort);
  assert.ok(far.length > 0, 'a Bloody Murderer weapon is a long grind, and still offered');
  for (const m of moves) {
    const beyond = m.changes.some((c) => [c.state.itemId, ...c.state.cards].some((id) => {
      const i = id ? withEffort.items.get(id) : undefined;
      return !!i && id !== build.slots[c.slot]?.itemId && !build.slots[c.slot]?.cards.includes(id)
        && !near.allowed(i);
    }));
    assert.equal(!!m.highEffort, beyond, `${m.label} is marked by whether it is past reach`);
    for (const c of m.changes) {
      if (c.state.itemId !== build.slots[c.slot]?.itemId) {
        assert.ok(c.state.refine <= reach.refine, `${m.label} assumes more refine than the build has`);
      }
    }
  }
  assert.ok(moves.some((m) => m.changes.some((c) => c.slot === 'offhand')),
    'an off-hand weapon counts at half, and half is still worth listing');
});

test('a loss on a stat no goal covers is charged to a trade, per 100% lost', () => {
  const rel = relevanceOf([{ key: 'crit_rate', column: 'flat', target: 10 }], dataset);
  const change = (key: string, column: 'flat' | 'percent', delta: number): TotalsChange => ({
    key, column, label: key, delta, unit: column === 'percent' ? '%' : '', tone: statTone(key, delta),
  });
  // -160% HP and SP regen: the case that read as a free sidegrade. Charged,
  // at a fifth of the rate -- regeneration's percentages run large.
  assert.ok(Math.abs(collateralCost([change('hp_regen', 'percent', -80), change('sp_regen', 'percent', -80)],
    rel, dataset) - COLLATERAL_WEIGHT * 0.2 * 1.6) < 1e-9);
  // Any other stat at the full rate.
  assert.equal(collateralCost([change('healing_received', 'percent', -40)], rel, dataset),
    COLLATERAL_WEIGHT * 0.4);
  // The goal's own stat is the goals' business, flat columns have no shared
  // scale, and gains are no reason to trade.
  assert.equal(collateralCost([change('crit_rate', 'percent', -50), change('max_hp', 'flat', -500),
    change('hp_regen', 'percent', 40)], rel, dataset), 0);
});

/** With the per-level floor under the reach, too. */
const withLevels: Dataset = {
  ...withEffort,
  levelReach: new Map(Object.entries(load<Record<string, [number, number]>>('mobs/level-reach.json'))
    .map(([level, [effort, kill]]) => [Number(level), { effort, kill }])),
};

/** A fresh level 100 in starter gear: nothing worn says anything about reach. */
function fresh100(): Build {
  const build = emptyBuild();
  build.baseLevel = 100;
  build.className = 'Satsujin';
  build.slots.weapon = { itemId: byName('Main Gauche').id, refine: 4, cards: [] };
  build.slots.offhand = { itemId: byName('Buckler').id, refine: 4, cards: [] };
  return build;
}

test('a fresh character is held to what its level farms, not to nothing', () => {
  const build = fresh100();
  const floor = withLevels.levelReach!.get(100)!;
  const reach = reachOf(build, withLevels);
  assert.equal(reach.kill, floor.kill * REACH_KILL_FACTOR);
  assert.equal(reach.effort, floor.effort * REACH_EFFORT_FACTOR);
  const held = new Suggester(withLevels, [demihuman], { ...OPEN, reach });
  // Off a level 149 monster with 120,000 HP.
  assert.equal(held.allowed(byName('Conquest Incarnate Card')), false);
  // A shadow set farmed at level 65 is well within it.
  assert.equal(held.allowed(byName('Fallen Civilization Armor')), true);

  // A build whose gear says more than its level keeps its gear's reach.
  const geared = satsujin();
  const gearOnly = reachOf(geared, withEffort);
  const both = reachOf(geared, withLevels);
  assert.ok(both.kill! >= gearOnly.kill! && both.effort! >= gearOnly.effort!);
});

test('a set whose pieces all go into empty slots is offered, however many there are', () => {
  const build = fresh100();
  const goals: Goal[] = [
    { key: 'str', column: 'total', target: 0 },
    { key: 'sp_cost', column: 'percent', target: 0, atMost: true },
  ];
  const s = new Suggester(withLevels, goals,
    { className: 'Satsujin', maxLevel: 100, refine: 'auto', reach: reachOf(build, withLevels) });
  const civ = s.setMoves(build).find((m) => m.label.startsWith('Complete Fallen Civilization set'));
  assert.ok(civ, 'four shadow pieces into four empty shadow slots');
  assert.equal(civ!.changes.length, 4);
  assert.ok(civ!.changes.every((c) => !build.slots[c.slot]?.itemId), 'nothing is taken off for it');
});

test('an open goal keeps counting past its target, in full, and stops at its cap', () => {
  const pen: Goal = { key: 'def_pen', column: 'flat', target: 25, cap: 70, open: true };
  const hit: Goal = { key: 'hit', column: 'flat', target: 25, cap: 70, open: true };
  const closed: Goal = { ...hit, open: false, cap: undefined };
  const at = (g: Goal, v: number) => goalScore([g], [v]);
  // Past the target an open goal is worth as much per point as short of it.
  assert.ok(Math.abs((at(hit, 25) - at(hit, 35)) - (at(hit, 15) - at(hit, 25))) < 1e-9);
  // An ordinary goal's surplus is a token by comparison.
  assert.ok(at(closed, 25) - at(closed, 35) < (at(hit, 25) - at(hit, 35)) / 4);
  // Penetration keeps counting past 25 too, but each point for the damage it
  // adds, which is less the further up the pierce curve it is.
  assert.ok(at(pen, 35) < at(pen, 25));
  assert.ok(at(pen, 25) - at(pen, 35) < at(pen, 15) - at(pen, 25));
  // And nothing past the cap.
  assert.equal(at(pen, 70), at(pen, 90));
  assert.ok(at(pen, 69) > at(pen, 70));
  // Read off the build, every goal is open.
  const build = satsujin();
  assert.ok(goalsFromBuild(build, aggregate(build, withEffort), withEffort).every((g) => g.open));
});

test('other sets are the runners-up, not the one the plan already took', () => {
  const build = fresh100();
  const goals: Goal[] = [
    { key: 'str', column: 'total', target: 0, open: true },
    { key: 'sp_cost', column: 'percent', target: 0, atMost: true, open: true },
  ];
  const s = new Suggester(withLevels, goals, { className: 'Satsujin', maxLevel: 100, refine: 'auto' });
  const steps = s.plan(build, 2);
  const sets = s.setAlternatives(build, steps);
  assert.ok(sets.length > 1, 'more than one set is worth finishing on an empty shadow row');
  assert.ok(sets.every((m) => m.kind === 'set' && m.gain > 0));
  assert.ok(!sets.some((m) => steps.some((t) => t.label === m.label)));
  for (let i = 1; i < sets.length; i++) assert.ok(sets[i - 1].gain >= sets[i].gain);
});

test('the overlay\'s search comes a section at a time, and ends where the one-shot calls do', () => {
  const build = fresh100();
  const goals: Goal[] = [
    { key: 'str', column: 'total', target: 0, open: true },
    { key: 'sp_cost', column: 'percent', target: -5, atMost: true, open: true },
  ];
  const s = new Suggester(withLevels, goals, { className: 'Satsujin', maxLevel: 100, refine: 'auto' });
  const snaps = [...s.paths(build)];
  assert.ok(snaps.length > 3, 'more than one snapshot');
  // Each snapshot is the one before with more filled in: no list empties
  // once it has something.
  for (let i = 1; i < snaps.length; i++) {
    for (const k of ['near', 'cards', 'refines', 'rolls', 'far'] as const) {
      if (snaps[i - 1][k].length) assert.ok(snaps[i][k].length > 0, `${k} emptied`);
    }
  }
  // Recommendations, not a chain: the same lists as the one-shot call, goal
  // short or met, and every row measured from the build as it is.
  const end = snaps[snaps.length - 1];
  assert.deepEqual(end.near.map((m) => m.label), s.upgradePaths(build).near.map((m) => m.label));
  const before = s.values(build);
  for (const m of end.near) assert.deepEqual(m.before, before);
  const met = new Suggester(withLevels, goals.map((g) => ({ ...g, target: 0 })),
    { className: 'Satsujin', maxLevel: 100, refine: 'auto' });
  const up = [...met.paths(build)].pop()!;
  assert.deepEqual(up.near.map((m) => m.label), met.upgradePaths(build).near.map((m) => m.label));
});

test('a damage chain multiplies its links, so a +6% size card beats +3% ATK in the main hand', () => {
  const build = fresh100();
  build.slots.offhand = { itemId: byName('Main Gauche').id, refine: 4, cards: [] };
  const chain: Goal = { key: 'melee_dmg_mult', column: 'percent', target: 0, open: true };
  const s = new Suggester(withLevels, [chain], OPEN);
  const cards = [byName('Pasana Card'), byName('Khalitzburg Card')];
  const main = s.rank(build, 'weapon', 0, cards);
  assert.ok(main.get(cards[1].id)!.gain > main.get(cards[0].id)!.gain * 1.5);
  // In the off hand the size card counts at half, and the two are level.
  const off = s.rank(build, 'offhand', 0, cards);
  assert.ok(Math.abs(off.get(cards[1].id)!.gain - off.get(cards[0].id)!.gain) < 1e-9);
  // The product, not the sum: ATK +3% and size +6% together.
  const both = applyChanges(build, [{ slot: 'weapon',
    state: { ...build.slots.weapon, cards: [cards[0].id, cards[1].id] } }], withLevels);
  const at = measure(chain, aggregate(both, withLevels), both, withLevels);
  assert.ok(Math.abs(at - (1.03 * 1.06 - 1) * 100) < 1e-9);
});

test('a headgear worn in two positions takes both, counts once, and is charged for what it moves', () => {
  const majestic = byName('Majestic Helmet');
  assert.deepEqual([...majestic.equip_slots].sort(), ['Middle headgear', 'Upper headgear']);
  const hat = itemList.find((i) => i.equip_slots.length === 1 && i.equip_slots[0] === 'Upper headgear'
    && i.kind !== 'Costume' && i.kind !== 'Card')!;
  const build = emptyBuild();
  build.slots.upper = { itemId: hat.id, refine: 0, cards: [] };

  // Put in the middle, it takes the upper hat off.
  const worn = applyChanges(build, [{ slot: 'middle', state: { itemId: majestic.id, refine: 0, cards: [] } }], dataset);
  assert.equal(worn.slots.upper.itemId, null);
  assert.equal(coveredBy(worn, 'upper', dataset), 'middle');
  // And a hat put back on top takes the helmet off.
  const back = applyChanges(worn, [{ slot: 'upper', state: { itemId: hat.id, refine: 0, cards: [] } }], dataset);
  assert.equal(back.slots.middle.itemId, null);

  // Recorded in both slots, as a screenshot shows it, it counts once.
  const twice = emptyBuild();
  twice.slots.upper = { itemId: majestic.id, refine: 0, cards: [] };
  twice.slots.middle = { itemId: majestic.id, refine: 0, cards: [] };
  const once = emptyBuild();
  once.slots.upper = { itemId: majestic.id, refine: 0, cards: [] };
  const atk = (b: Build) => aggregate(b, dataset).byStat.get(stats.find((x) => x.key === 'atk')!.id)?.percent ?? 0;
  assert.equal(atk(twice), atk(once));

  // A locked upper hat is not taken off by a suggestion for the middle.
  const locked: Build = { ...build, locked: ['upper'] };
  const s = new Suggester(dataset, [{ key: 'atk', column: 'percent', target: 50 }], OPEN);
  for (const m of s.slotMoves(locked, 'middle')) {
    assert.equal(applyChanges(locked, m.changes, dataset).slots.upper.itemId, hat.id, m.label);
  }
});

test('movement speed below -10% is a guard rail from the start', () => {
  const g = allGoals(emptyBuild()).find((x) => x.key === 'move_speed');
  assert.ok(g?.guard);
  assert.equal(g!.target, -10);
});

test('SP cost past -50% counts for nothing, even on a goal saved without a cap', () => {
  const g: Goal = { key: 'sp_cost', column: 'percent', target: 0, atMost: true, open: true };
  assert.equal(goalScore([g], [-50]), goalScore([g], [-80]));
  assert.ok(goalScore([g], [-40]) > goalScore([g], [-50]));
  // A goal that asks for more than the default keeps its own target.
  const deep: Goal = { ...g, target: -70 };
  assert.ok(goalScore([deep], [-70]) < goalScore([deep], [-60]));
  // Penetration stops at 70 the same way.
  const pen: Goal = { key: 'def_pen', column: 'flat', target: 25, open: true };
  assert.equal(goalScore([pen], [70]), goalScore([pen], [90]));
});

test('a percent goal is weighed out of 100, so +1% from nothing is not a whole target', () => {
  const atk: Goal = { key: 'atk', column: 'percent', target: 0, open: true };
  const agi: Goal = { key: 'agi', column: 'total', target: 74, open: true };
  // +14% ATK is 0.14 of a target, where it used to be fourteen of them.
  assert.ok(Math.abs((goalScore([atk], [0]) - goalScore([atk], [14])) - 0.14) < 1e-9);
  // So +3 AGI on a 74 AGI build is no longer a rounding error beside it.
  const agiGain = goalScore([agi], [74]) - goalScore([agi], [77]);
  assert.ok(agiGain > (goalScore([atk], [0]) - goalScore([atk], [3])));
  // Penetration is weighed as the damage it lets through, out of 100: from
  // 5 to 25 is some +17% against a level 130 monster's DEF, and from 36 to
  // 57 -- three Hodremlin Cards -- only about +10%, less than three +3%
  // melee cards give on every hit.
  const pen: Goal = { key: 'def_pen', column: 'flat', target: 25, open: true };
  const gain = (a: number, b: number) => goalScore([pen], [a]) - goalScore([pen], [b]);
  assert.ok(Math.abs(gain(5, 25) - 0.167) < 0.005);
  assert.ok(gain(36, 57) < 0.11 && gain(36, 57) > 0.09);
});

test('Max HP % counts both ways, Max SP % only when lost', () => {
  const build = satsujin();
  const goals = allGoals(build, dataset);
  const side = goals.filter((g) => g.side);
  assert.deepEqual(side.slice(0, 2).map((g) => g.key), ['max_hp', 'max_sp']);
  // Without the dataset there is nothing to anchor them to, so none.
  assert.ok(!allGoals(build).some((g) => g.side));
  const [hp, sp] = side;
  const at = (g: Goal, v: number) => goalScore([g], [v]);
  assert.ok(at(hp, hp.target - 50) > at(hp, hp.target));
  // More HP is worth having -- the project owner: it was valued too little.
  assert.ok(at(hp, hp.target + 50) < at(hp, hp.target));
  assert.ok(at(sp, sp.target - 50) > at(sp, sp.target));
  assert.equal(at(sp, sp.target + 50), at(sp, sp.target));
  // A far-off MVP card is not a longer-term goal for a mid-level character.
  assert.ok(withEffort.effort!.get(byName('Vesper Card').id)!.effort
    > 20 * reachOf(build, withEffort).effort!);
  // A loss is weighed, not ruled out: it never reads as a broken goal.
  assert.deepEqual(brokenGoals([hp], [hp.target], [hp.target - 50]), []);
  // A player's own goal on the stat is left to do the job.
  const own = { ...build, goals: [{ key: 'max_hp', column: 'percent' as const, target: 10 }] };
  assert.ok(!allGoals(own, dataset).some((g) => g.side && g.key === 'max_hp'));
  // And neither is ever "not used by this build".
  const bare = emptyBuild();
  const matters = statsThatMatter(bare, aggregate(bare, dataset), dataset);
  assert.ok(matters.has('max_hp') && matters.has('max_sp'));
});

/** A level 100 Satsujin with most sockets empty, as shared by the project owner. */
function socketsEmpty(): Build {
  const build = emptyBuild();
  build.className = 'Satsujin';
  build.baseLevel = 100;
  build.baseStats = { str: 99, agi: 74, vit: 49, int: 1, dex: 21, luk: 1 };
  build.manual = { flee: 70 };
  const put = (slot: string, itemId: number, cards: number[] = []) => {
    build.slots[slot] = { itemId, refine: 0, cards };
  };
  put('upper', 2299); // Orc Helm
  put('middle', 5068); // Evil Wing Ears
  put('lower', 5445);
  put('armor', 15448);
  put('weapon', 13031); // Senbonzakura
  put('garment', 2544);
  put('shoes', 15450);
  put('acc1', 15454);
  put('acc2', 2671, [13743]);
  build.locked = ['weapon'];
  build.goals = [
    { key: 'agi', column: 'total', target: 74, open: true },
    { key: 'def_pen', column: 'flat', target: 25, open: true },
    { key: 'str', column: 'total', target: 100, open: true },
    { key: 'flee', column: 'total', target: 351, open: true },
    { key: 'atk', column: 'percent', target: 0, open: true },
    { key: 'sp_cost', column: 'percent', target: 0, atMost: true, open: true },
    { key: 'any_target_dmg', column: 'percent', target: 0, open: true },
    { key: 'melee_damage', column: 'percent', target: 7, open: true },
  ];
  return build;
}

test('empty sockets get cards of their own, and HP is not sold for a little ATK', () => {
  const build = socketsEmpty();
  const s = new Suggester(withEffort, allGoals(build, withEffort),
    { className: 'Satsujin', maxLevel: 100, refine: 'auto' });
  const found = [...s.paths(build)].at(-1)!;
  // A short goal counts for more, and the best swap per slot is still listed.
  assert.ok(found.near.length > 0);
  assert.ok(found.cards.some((m) => m.label === 'Veins Ghoul Card in Evil Wing Ears'));
  // Everything a card move does happens in a piece already worn.
  for (const m of found.cards) {
    assert.equal(m.kind, 'cards');
    assert.equal(m.changes[0].state.itemId, build.slots[m.changes[0].slot].itemId);
  }
  // Black Acidus (HP -50%) and Pasana (SP -15%) used to lead the plan.
  const named = [...found.near, ...found.cards].map((m) => m.label).join(' | ');
  assert.doesNotMatch(named, /Black Acidus|Pasana/);
});

test('resistance, sustain on kill and ASPD Limit are read off the tooltips', () => {
  const keysOf = (name: string, text: RegExp) => {
    const item = byName(name);
    const all = [...item.effects, ...item.refine.per_refine.flatMap((g) => g.effects)];
    return all.filter((e) => text.test(e.text)).map((e) => [e.stat_keys, e.value]);
  };
  // Asprika: every element but Neutral, which the parser used to drop.
  const [[asprika]] = keysOf('Asprika', /non-neutral/) as [[string[], number]][];
  assert.equal((asprika as unknown as string[]).length, 9);
  assert.ok(!(asprika as unknown as string[]).includes('res_neutral'));
  // Wyrdbrand: HP and SP per kill, and more of both per refine.
  assert.deepEqual(keysOf('Wyrdbrand', /killing/), [[['hp_on_kill'], 500], [['sp_on_kill'], 20]]);
  assert.deepEqual(keysOf('Wyrdbrand', /Amount increases/), [[['hp_on_kill'], 100], [['sp_on_kill'], 5]]);
  // "Final Damage Taken -5%" is Final Damage Reduction +5%.
  assert.deepEqual(keysOf('Valkyrie Shield', /Final Damage Taken/), [[['damage_reduction'], 5]]);
  // Dream Manteau costs 50 Distortion Essence, which is more than Asprika's souls.
  const effort = (name: string) => withEffort.effort!.get(byName(name).id)!.effort;
  assert.ok(effort('Dream Manteau') > effort('Asprika'));
  assert.equal(effort('Dream Ring'), effort('Dream Manteau'));
  // Natural elements are the four of the world, corporal the four of body and spirit.
  assert.deepEqual(keysOf('Ragged Manteau', /Natural/),
    [[['res_fire', 'res_water', 'res_wind', 'res_earth'], -20]]);
  assert.deepEqual(keysOf('Ragged Manteau', /Corporal/),
    [[['res_ghost', 'res_poison', 'res_holy', 'res_dark'], 15]]);
});

test('side goals: resistances both ways, a negative one double, ASPD Limit only for hitting', () => {
  const build = socketsEmpty();
  const totals = aggregate(build, dataset);
  const side = sideGoals(build, totals, dataset);
  const keys = side.map((g) => g.key);
  for (const k of ['res_elements', 'res_races', 'res_damage', 'kill_sustain', 'aspd_limit', 'perfect_dodge',
    'vit', 'int']) {
    assert.ok(keys.includes(k), k);
  }
  // A caster's goals leave ASPD Limit out.
  const caster = { ...build, goals: [{ key: 'matk', column: 'percent' as const, target: 0 }] };
  assert.ok(!sideGoals(caster, totals, dataset).some((g) => g.key === 'aspd_limit'));

  const goals = allGoals(build, dataset);
  const s = new Suggester(dataset, goals, { className: 'Satsujin', maxLevel: null, refine: null });
  const put = (slot: string, name: string) =>
    applyChanges(build, [{ slot, state: { itemId: byName(name).id, refine: 0, cards: [] } }], dataset);
  const at = (b: Build) => s.values(b)[keys.indexOf('res_races') + goals.length - side.length];
  // Godslayer's -50% against every race counts as -100.
  let god = build;
  for (const [slot, name] of [['sh_armor', 'Godslayer Armor'], ['sh_gloves', 'Godslayer Gloves'],
    ['sh_shoes', 'Godslayer Shoes'], ['sh_acc', 'Godslayer Pendant']]) {
    god = applyChanges(god, [{ slot, state: { itemId: byName(name).id, refine: 0, cards: [] } }], dataset);
  }
  assert.equal(at(god) - at(build), -100);
  // Asprika is worth something for its resistances alone; the same
  // resistances taken away cost as much.
  const res = side.find((g) => g.key === 'res_elements')!;
  assert.ok(goalScore([res], [res.target + 18]) < goalScore([res], [res.target]));
  assert.ok(Math.abs((goalScore([res], [res.target - 18]) - goalScore([res], [res.target]))
    - (goalScore([res], [res.target]) - goalScore([res], [res.target + 18]))) < 1e-9);
  // And it is no longer something the build cannot use.
  assert.ok(s.score(put('garment', 'Asprika')) < s.score(build));
});

test('left and right accessories go on their own side; Sky Garden gear never rolls', () => {
  const acc1 = SLOTS.find((s) => s.key === 'acc1')!;
  const acc2 = SLOTS.find((s) => s.key === 'acc2')!;
  // Accessory 1 is the left one, 2 the right. Gleipnir is left-only.
  assert.ok(fitsSlot(byName('Gleipnir'), acc1) && !fitsSlot(byName('Gleipnir'), acc2));
  assert.ok(!fitsSlot(byName('Andvarinaut'), acc1) && fitsSlot(byName('Andvarinaut'), acc2));
  assert.ok(fitsSlot(byName('Arch Ring'), acc1) && fitsSlot(byName('Arch Ring'), acc2));
  // Armor, garments and shoes roll whether dropped or not -- but not from Sky Garden.
  for (const [slot, name] of [['garment', 'Asprika'], ['armor', 'Brynhild'], ['shoes', 'Sleipnir']]) {
    assert.equal(rollTableFor(dataset.rolls, slot, byName(name)), null, name);
  }
  assert.ok(rollTableFor(dataset.rolls, 'garment', byName('Tendrillion Skin')));
});

test('quest-chain gear and lone-spawn drops are a long way off, Sky Garden is not', () => {
  const effort = (name: string) => withEffort.effort!.get(byName(name).id)!.effort;
  for (const name of ['Equilibrium Tome', 'Celestial Tome', 'Unleashed Manual']) {
    assert.ok(effort(name) > 10 * effort('Laevateinn'), name);
  }
  // Rachel Jewel is 1% off a monster that spawns one to a map: rarer than
  // 400 souls off maps full of avatars.
  assert.ok(effort('Rachel Jewel') > 2 * effort('Laevateinn'));
  // And a build in three Sky Garden pieces is not thereby within its reach.
  const build = socketsEmpty();
  for (const [slot, name] of [['upper', 'Wyrdbrand'], ['garment', 'Asprika'], ['acc1', 'Gleipnir']]) {
    build.slots[slot] = { itemId: byName(name).id, refine: 0, cards: [] };
  }
  assert.ok(reachOf(build, withEffort).effort! < effort('Rachel Jewel'));
});

test('the longer-term lists stop short of MVP cards and endgame monsters', () => {
  const build = socketsEmpty();
  const reach = reachOf(build, withEffort);
  const e = (name: string) => withEffort.effort!.get(byName(name).id)!;
  // Dedicated Scarf: 3% off a level 170 with millions of HP. Not a goal yet.
  assert.ok(e('Dedicated Scarf').kill > 5 * reach.kill!);
  assert.ok(e('Goblin King Card').effort > 20 * reach.effort!);
  const s = new Suggester(withEffort, allGoals(build, withEffort),
    { className: 'Satsujin', maxLevel: 175, refine: 'auto' });
  const paths = s.upgradePaths(build);
  const named = [...paths.far, ...paths.farm, ...paths.sides].map((m) => m.label).join(' | ');
  assert.doesNotMatch(named, /Dedicated Scarf|Goblin King Card|Vesper Card/);
  // And a +6 refine is assumed within reach from the start.
  assert.ok(reach.refine >= 6);
});

test('a whole shadow set can be traded for another, with one change to win back what it cost', () => {
  const build = socketsEmpty();
  for (const [slot, name] of [['sh_armor', 'Fallen Civilization Armor'], ['sh_shoes', 'Fallen Civilization Shoes'],
    ['sh_gloves', 'Fallen Civilization Gloves'], ['sh_acc', 'Fallen Civilization Pendant']]) {
    build.slots[slot] = { itemId: byName(name).id, refine: 0, cards: [] };
  }
  build.goals = [
    { key: 'agi', column: 'total', target: 74, open: true },
    { key: 'melee_dmg_mult', column: 'percent', target: 7, open: true },
    { key: 'def_pen', column: 'flat', target: 25, open: true },
    { key: 'sp_cost', column: 'percent', target: -50, atMost: true, open: true },
  ];
  const s = new Suggester(withEffort, allGoals(build, withEffort),
    { className: 'Satsujin', maxLevel: 100, refine: 'auto' });
  const { sides } = s.upgradePaths(build);
  // Fallen Civilization carries the SP cost; another set gives it up, and
  // the pair wins it back somewhere the set does not reach.
  const pair = sides.find((m) => m.kind === 'set' && / \+ /.test(m.label));
  assert.ok(pair, `no paired set swap among: ${sides.map((m) => m.label).join(' | ')}`);
  const slots = pair!.changes.map((c) => c.slot);
  assert.ok(slots.includes('sh_armor') && slots.some((k) => !k.startsWith('sh_')));
  // Each set once, paired or not.
  const names = sides.filter((m) => m.kind === 'set').map((m) => /^Complete (.+?) set\b/.exec(m.label)?.[1]);
  assert.equal(new Set(names).size, names.length);
  // No combination crosses a guard -- one that wins SP back at -25% move
  // speed is not a fix -- and adds at most two changes.
  const paths = s.upgradePaths(build);
  for (const m of [...paths.sides, ...paths.near]) {
    assert.ok(!brokenGoals(s.goals, m.before, m.after).some((g) => g.guard), m.label);
    assert.ok(m.label.split(' + ').length <= 3, m.label);
  }
  // What is recommended is within reach, combinations included.
  const reach = reachOf(build, withEffort);
  for (const m of paths.near) {
    for (const c of m.changes) {
      const e = withEffort.effort!.get(c.state.itemId ?? -1)?.effort ?? 0;
      assert.ok(c.state.itemId === build.slots[c.slot]?.itemId || e <= reach.effort!, m.label);
    }
  }
});

test('a set is refined together, to reach a set refine no one piece can', () => {
  // Aggressive Orphan pays +10% against every race at set refine 9, and again
  // at 18 -- a sum over four pieces. Tuned one piece at a time, none of them
  // ever moved off +0.
  const build = socketsEmpty();
  const goals: Goal[] = [{ key: 'any_race_dmg', column: 'percent', target: 0, open: true }];
  const s = new Suggester(withEffort, goals, { className: 'Satsujin', maxLevel: 100, refine: 'auto',
    reach: { effort: null, kill: null, refine: 6 } });
  const move = s.setMoves(build).find((m) => m.label.startsWith('Complete Aggressive Orphan set'));
  assert.ok(move, 'the set is offered');
  const setRefine = move!.changes.reduce((n, c) => n + c.state.refine, 0);
  assert.ok(setRefine >= 18, `set refine ${setRefine}`);
  // The least that does it: past 18 there is nothing more to get.
  assert.ok(setRefine < 24, `set refine ${setRefine}`);
});
