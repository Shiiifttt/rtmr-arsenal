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
  aggregate, applyChanges, bindBaseStatIds, brokenGoals, defaultBaseStats, diffTotals,
  effectTone, fitsSlot, goalMetrics,
  goalScore, goalStatus, isTwoHanded, measure, priorityWeight, SLOTS, Suggester, tableForSlot,
  type Move, type SuggestOptions,
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
  const metric = goalMetrics(dataset).find((m) => m.key === 'skill:Backstab|damage');
  assert.ok(metric, 'expected Backstab damage to be offered as a goal');
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
  // Melee damage already at its target, so there is no plan left to make --
  // which is exactly when "just give me more of this" is the question.
  const melee: Goal = { key: 'melee_damage', column: 'percent', target: 0 };
  const flee: Goal = { key: 'flee', column: 'total', target: 0 };
  const s = new Suggester(dataset, [melee, flee], OPEN);
  const build = emptyBuild();
  assert.ok(goalStatus([melee, flee], aggregate(build, dataset), build, dataset)
    .every((g) => g.met), 'both goals start met');
  assert.equal(s.plan(build).length, 0, 'nothing left to plan');

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
  const auto: SuggestOptions = { className: null, maxLevel: null, refine: 'auto' };
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
  assert.deepEqual(move.changes[0].state.rolls?.stat, { option: 'dex', values: [2] });
  assert.match(move.label, /DEX \+2/);
});

test('a skill-damage roll is aimed at a skill the goals name', () => {
  const acc = itemList.find((i) => i.equip_slots.includes('Accessory') && i.kind === 'Accessory'
    && (i.drops?.length ?? 0) > 0)!;
  const build = emptyBuild();
  build.slots.acc1 = { itemId: acc.id, refine: 0, cards: [] };
  const goal: Goal = { key: 'skill:Backstab|damage', column: 'percent', target: 50 };
  const [move] = new Suggester(dataset, [goal], OPEN).rollMoves(build, 'acc1');
  assert.equal(move.changes[0].state.rolls?.skill?.skill, 'Backstab');
  assert.equal(move.after[0], 5);
});

test('no goals means no opinion', () => {
  const s = new Suggester(dataset, [], OPEN);
  assert.equal(s.active, false);
  assert.deepEqual(s.plan(emptyBuild()), []);
  assert.equal(s.rank(emptyBuild(), 'armor', null, itemList).size, 0);
});
