/**
 * Filling in the rest of a set.
 *
 * Built from stub items rather than the crawled dataset, so the cases stay
 * legible and a change to the data cannot quietly turn a test green.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeSet, fillSet, missingMembers, wornIds } from '../src/sets.ts';
import type { Build, Dataset, Item, SetRecord, SlotState } from '../src/types.ts';

function item(id: number, name: string, kind: string, slots: string[],
              extra: Partial<Item> = {}): Item {
  return {
    id, name, kind, type: null, category: null, equip_slots: slots,
    description: '', required_level: 1, weight: 0, atk: 0, matk: 0, def: 0, mdef: 0,
    card_slots: 0, refineable: true, weapon_level: null, element: null,
    usable_by: null, images: { icon: null, art: null }, card_affix: null,
    sets: [0], effects: [], piece_bonus: [],
    refine: { per_refine: [], thresholds: [] }, conditional: [], lore: null,
    ...extra,
  };
}

const SH_ARMOR = item(101, 'Shadow Armor', 'Shadow gear', ['Shadow armor']);
const SH_SHOES = item(102, 'Shadow Shoes', 'Shadow gear', ['Shadow shoes']);
const SH_GLOVES = item(103, 'Shadow Gloves', 'Shadow gear', ['Shadow gloves']);
const SH_PENDANT = item(104, 'Shadow Pendant', 'Shadow gear', ['Shadow accessory']);
const OTHER_SHOES = item(105, 'Plain Shadow Shoes', 'Shadow gear', ['Shadow shoes'],
  { sets: [] });
const ARMOR = item(106, 'Armor', 'Armor', ['Armor'], { card_slots: 1, sets: [] });
const ARMOR_CARD = item(107, 'Set Card', 'Card', ['Armor']);
const ACC = item(108, 'Accessory', 'Accessory', ['Accessory']);
const ACC2 = item(109, 'Other Accessory', 'Accessory', ['Accessory']);

const ALL = [SH_ARMOR, SH_SHOES, SH_GLOVES, SH_PENDANT, OTHER_SHOES, ARMOR,
  ARMOR_CARD, ACC, ACC2];
const dataset = { items: new Map(ALL.map((i) => [i.id, i])) } as Dataset;

function set(members: Item[], count = members.length): SetRecord {
  return {
    index: 0, key: 'shadow', name: 'Shadow', member_ids: members.map((i) => i.id),
    members: members.map((i) => ({ id: i.id, name: i.name, kind: i.kind })),
    member_count: count, members_text: null, set_bonus: [],
    set_refine: { per_set_refine: [], thresholds: [] }, piece_bonus_note: null,
  };
}

const SHADOW_SET = set([SH_ARMOR, SH_SHOES, SH_GLOVES, SH_PENDANT]);

function build(slots: Record<string, SlotState>, locked?: string[]): Build {
  return {
    className: null, baseLevel: 1,
    baseStats: { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 },
    slots, ...(locked ? { locked } : {}),
  };
}

const held = (item: Item, refine = 0, cards: (number | null)[] = []): SlotState =>
  ({ itemId: item.id, refine, cards });

test('worn ids count cards as well as pieces', () => {
  const b = build({ armor: held(ARMOR, 4, [ARMOR_CARD.id]) });
  assert.deepEqual([...wornIds(b)].sort(), [ARMOR.id, ARMOR_CARD.id].sort());
});

test('one piece on is enough to fill in the other three', () => {
  const b = build({ sh_armor: held(SH_ARMOR) });
  assert.deepEqual(missingMembers(b, SHADOW_SET),
    [SH_SHOES.id, SH_GLOVES.id, SH_PENDANT.id]);

  const fill = completeSet(b, SHADOW_SET, dataset);
  assert.equal(fill.need, 3);
  assert.deepEqual(fill.blocked, []);
  assert.deepEqual(
    Object.fromEntries(fill.changes.map((c) => [c.slot, c.state.itemId])),
    { sh_shoes: SH_SHOES.id, sh_gloves: SH_GLOVES.id, sh_acc: SH_PENDANT.id },
  );
});

test('a piece displaces what is in its slot, keeping the refine already set', () => {
  const b = build({ sh_armor: held(SH_ARMOR), sh_shoes: held(OTHER_SHOES, 7) });
  const fill = completeSet(b, SHADOW_SET, dataset);

  const shoes = fill.changes.find((c) => c.slot === 'sh_shoes')!;
  assert.equal(shoes.state.itemId, SH_SHOES.id);
  assert.equal(shoes.state.refine, 7);
});

test('a locked slot is nowhere: the piece is blocked, not forced in', () => {
  const b = build(
    { sh_armor: held(SH_ARMOR), sh_shoes: held(OTHER_SHOES, 7) },
    ['sh_shoes'],
  );
  const fill = completeSet(b, SHADOW_SET, dataset);

  assert.deepEqual(fill.blocked, [SH_SHOES.id]);
  assert.equal(fill.placed.length, 2);
  // Short of what the set needs, so the caller knows not to offer it.
  assert.ok(fill.placed.length < fill.need);
  assert.ok(!fill.changes.some((c) => c.slot === 'sh_shoes'));
});

test('a set that lists alternatives stops once it has enough', () => {
  // Three accessories named, any two of which count, and two slots to wear
  // them in. Putting on everything missing would be both wrong and impossible.
  const alternatives = set([ACC, ACC2, SH_PENDANT], 2);
  const fill = completeSet(build({}), alternatives, dataset);

  assert.equal(fill.need, 2);
  assert.deepEqual(fill.placed, [ACC.id, ACC2.id]);
  assert.deepEqual(
    Object.fromEntries(fill.changes.map((c) => [c.slot, c.state.itemId])),
    { acc1: ACC.id, acc2: ACC2.id },
  );
});

test('a card member goes into a socket of something already worn', () => {
  const cardSet = set([ARMOR_CARD, SH_ARMOR]);
  const b = build({ armor: held(ARMOR, 0, [null]), sh_armor: held(SH_ARMOR) });
  const fill = completeSet(b, cardSet, dataset);

  assert.deepEqual(fill.blocked, []);
  const armor = fill.changes.find((c) => c.slot === 'armor')!;
  assert.deepEqual(armor.state.cards, [ARMOR_CARD.id]);
});

test('a card with no host to go into is blocked', () => {
  const cardSet = set([ARMOR_CARD, SH_ARMOR]);
  const fill = completeSet(build({ sh_armor: held(SH_ARMOR) }), cardSet, dataset);
  assert.deepEqual(fill.blocked, [ARMOR_CARD.id]);
});

test('a member the options bar is blocked rather than skipped over', () => {
  const b = build({ sh_armor: held(SH_ARMOR) });
  const fill = fillSet(b, SHADOW_SET, missingMembers(b, SHADOW_SET), dataset, {
    allowed: (i) => i.id !== SH_GLOVES.id,
  });

  assert.deepEqual(fill.blocked, [SH_GLOVES.id]);
  assert.deepEqual(fill.placed, [SH_SHOES.id, SH_PENDANT.id]);
});

test('a set already complete asks for nothing', () => {
  const b = build({
    sh_armor: held(SH_ARMOR), sh_shoes: held(SH_SHOES),
    sh_gloves: held(SH_GLOVES), sh_acc: held(SH_PENDANT),
  });
  const fill = completeSet(b, SHADOW_SET, dataset);

  assert.equal(fill.need, 0);
  assert.deepEqual(fill.changes, []);
});
