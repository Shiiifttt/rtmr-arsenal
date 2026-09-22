/**
 * Slot rules: what fits where, and swapping the two hands.
 *
 * Built from stub items rather than the crawled dataset, so the cases stay
 * legible and a change to the data cannot quietly turn a test green.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  carryInto, emptySockets, fitsCard, fitsSlot, groupCards, SLOT_BY_KEY,
  socketsOf, swapHands,
} from '../src/slots.ts';
import type { Build, Dataset, Item, SlotState } from '../src/types.ts';

function item(id: number, name: string, kind: string, slots: string[],
              extra: Partial<Item> = {}): Item {
  return {
    id, name, kind, type: null, category: null, equip_slots: slots,
    description: '', required_level: 1, weight: 0, atk: 0, matk: 0, def: 0, mdef: 0,
    card_slots: 1, refineable: true, weapon_level: null, element: null,
    usable_by: null, images: { icon: null, art: null }, card_affix: null,
    sets: [], effects: [], piece_bonus: [],
    refine: { per_refine: [], thresholds: [] }, conditional: [], lore: null,
    ...extra,
  };
}

const DAGGER = item(1, 'Dagger', 'Weapon', ['Weapon']);
const SWORD = item(2, 'Sword', 'Weapon', ['Weapon']);
const GREATSWORD = item(3, 'Greatsword', 'Weapon', ['Weapon (two-handed)']);
const SHIELD = item(4, 'Shield', 'Shield', ['Off-hand']);
const WEAPON_CARD = item(5, 'Weapon Card', 'Card', ['Weapon'], { card_slots: 0 });
const SHIELD_CARD = item(6, 'Shield Card', 'Card', ['Shield'], { card_slots: 0 });

const ALL = [DAGGER, SWORD, GREATSWORD, SHIELD, WEAPON_CARD, SHIELD_CARD];
const dataset = { items: new Map(ALL.map((i) => [i.id, i])) } as Dataset;

const MAIN = SLOT_BY_KEY.get('weapon')!;
const OFF = SLOT_BY_KEY.get('offhand')!;

function build(main: SlotState | null, off: SlotState | null): Build {
  const empty = { itemId: null, refine: 0, cards: [] };
  return {
    className: null, baseLevel: 1,
    baseStats: { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 },
    slots: { weapon: main ?? { ...empty }, offhand: off ?? { ...empty } },
  };
}

const held = (item: Item, refine = 0, cards: (number | null)[] = [null]): SlotState =>
  ({ itemId: item.id, refine, cards });

test('the off hand takes a one-handed weapon but not a two-handed one', () => {
  assert.equal(fitsSlot(DAGGER, OFF), true);
  assert.equal(fitsSlot(SHIELD, OFF), true);
  assert.equal(fitsSlot(GREATSWORD, OFF), false);
});

test('a shield never goes in the main hand', () => {
  assert.equal(fitsSlot(SHIELD, MAIN), false);
  assert.equal(fitsSlot(GREATSWORD, MAIN), true);
});

test('which cards fit the off hand depends on what is in it', () => {
  assert.equal(fitsCard(WEAPON_CARD, OFF, DAGGER), true);
  assert.equal(fitsCard(SHIELD_CARD, OFF, DAGGER), false);
  assert.equal(fitsCard(SHIELD_CARD, OFF, SHIELD), true);
  assert.equal(fitsCard(WEAPON_CARD, OFF, SHIELD), false);
});

test('swapping hands moves both weapons, with their refines and cards', () => {
  const before = build(held(SWORD, 8, [WEAPON_CARD.id]), held(DAGGER, 7, [null]));
  const after = swapHands(before, dataset)!;

  assert.notEqual(after, null);
  assert.deepEqual(after.slots.weapon, { itemId: DAGGER.id, refine: 7, cards: [null] });
  assert.deepEqual(after.slots.offhand,
    { itemId: SWORD.id, refine: 8, cards: [WEAPON_CARD.id] });

  // And back again, to the build it started as.
  assert.deepEqual(swapHands(after, dataset), before);
});

test('swapping a lone weapon moves it to the other hand', () => {
  const after = swapHands(build(held(SWORD, 4), null), dataset)!;
  assert.equal(after.slots.weapon.itemId, null);
  assert.deepEqual(after.slots.offhand, { itemId: SWORD.id, refine: 4, cards: [null] });
});

test('a shield alone in the off hand has nowhere to swap to', () => {
  assert.equal(swapHands(build(null, held(SHIELD, 0, [SHIELD_CARD.id])), dataset), null);
});

test('refuses swaps that would put something where it cannot go', () => {
  // A shield has no business in the main hand.
  assert.equal(swapHands(build(held(SWORD), held(SHIELD)), dataset), null);
  // A two-handed weapon occupies both hands already.
  assert.equal(swapHands(build(held(GREATSWORD), null), dataset), null);
  // Nothing in either hand.
  assert.equal(swapHands(build(null, null), dataset), null);
});

// ---- cards in sockets -----------------------------------------------------

test('the same card four times is one entry with a count', () => {
  const groups = groupCards([7, 7, 7, 7]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], { cardId: 7, count: 4, sockets: [0, 1, 2, 3] });
});

test('different cards stay apart, in the order they first appear', () => {
  const groups = groupCards([9, 7, 9, null]);
  assert.deepEqual(groups.map((g) => [g.cardId, g.count]), [[9, 2], [7, 1]]);
  assert.deepEqual(groups[0].sockets, [0, 2], 'the sockets it actually occupies');
});

test('empty sockets are reported separately from the cards', () => {
  assert.deepEqual(groupCards([null, null]), []);
  assert.deepEqual(emptySockets([7, null, 7, null]), [1, 3]);
});

test('a short saved build still offers every socket the item has', () => {
  // Builds outlive the dataset, and a card added to an item later would
  // otherwise leave a socket that cannot be filled because it is not drawn.
  const twoSlot = item(20, 'Twin Socket', 'Armor', ['Armor'], { card_slots: 2 });
  assert.deepEqual(socketsOf(twoSlot, [7]), [7, null]);
  assert.deepEqual(emptySockets(socketsOf(twoSlot, [7])), [1]);
  // And an over-long one is cut to what the item can hold.
  assert.deepEqual(socketsOf(twoSlot, [7, 8, 9]), [7, 8]);
});

test('removing one copy leaves the rest where they were', () => {
  // The UI clears the last socket of a group, so the remaining copies keep
  // their indices and the row does not reshuffle under the cursor.
  const sockets: (number | null)[] = [7, 7, 7, null];
  const group = groupCards(sockets)[0];
  const after = [...sockets];
  after[group.sockets[group.count - 1]] = null;
  assert.deepEqual(after, [7, 7, null, null]);
  assert.equal(groupCards(after)[0].count, 2);
});

// ---- swapping the item in a slot -----------------------------------------

test('trying a different item keeps the refine and the cards that still fit', () => {
  // Planning is comparison: the refine and cards were typed in by hand and
  // mostly still apply to whatever is being tried next.
  const twoSlot = item(30, 'Two Socket', 'Weapon', ['Weapon'], { card_slots: 2 });
  const before: SlotState = {
    itemId: DAGGER.id, refine: 7, cards: [WEAPON_CARD.id, WEAPON_CARD.id],
  };
  const after = carryInto(before, twoSlot, MAIN, {
    ...dataset, items: new Map([...dataset.items, [twoSlot.id, twoSlot]]),
  } as Dataset);

  assert.equal(after.itemId, twoSlot.id);
  assert.equal(after.refine, 7, 'the refine carries');
  assert.deepEqual(after.cards, [WEAPON_CARD.id, WEAPON_CARD.id]);
});

test('carrying over drops what the new item cannot take', () => {
  const oneSlot = item(31, 'One Socket', 'Weapon', ['Weapon'], { card_slots: 1 });
  const unrefinable = item(32, 'Fixed', 'Weapon', ['Weapon'],
    { card_slots: 0, refineable: false });
  const full: SlotState = {
    itemId: DAGGER.id, refine: 9,
    cards: [WEAPON_CARD.id, SHIELD_CARD.id, WEAPON_CARD.id],
  };
  const items = new Map([...dataset.items,
    [oneSlot.id, oneSlot], [unrefinable.id, unrefinable]]);
  const ds = { ...dataset, items } as Dataset;

  const narrowed = carryInto(full, oneSlot, MAIN, ds);
  assert.deepEqual(narrowed.cards, [WEAPON_CARD.id], 'cut to the sockets it has');

  const fixed = carryInto(full, unrefinable, MAIN, ds);
  assert.equal(fixed.refine, 0, 'an unrefinable piece cannot keep a +9');
  assert.deepEqual(fixed.cards, [], 'and has nowhere to put the cards');
});

test('a card that does not fit leaves its socket empty rather than shifting', () => {
  // Shuffling the survivors down would move cards the player deliberately
  // placed, and positions are how the screenshot reader writes them.
  const twoSlot = item(33, 'Two Socket', 'Weapon', ['Weapon'], { card_slots: 2 });
  const before: SlotState = {
    itemId: DAGGER.id, refine: 0, cards: [SHIELD_CARD.id, WEAPON_CARD.id],
  };
  const after = carryInto(before, twoSlot, MAIN, {
    ...dataset, items: new Map([...dataset.items, [twoSlot.id, twoSlot]]),
  } as Dataset);
  assert.deepEqual(after.cards, [null, WEAPON_CARD.id]);
});
