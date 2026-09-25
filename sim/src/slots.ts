import { reconcileRolls, rollTableFor } from './rolls.ts';
import type { Build, Dataset, Item, SlotState } from './types.ts';

/**
 * The character's equipment slots.
 *
 * `accepts` matches against an item's own `equip_slots`, which is the
 * server's wording. Two of those need translating rather than trusting:
 * shields are filed under "Off-hand" as equipment but cards that go into
 * them say "Shield", and a two-handed weapon occupies the off-hand as well
 * as the weapon slot.
 */
export interface SlotDef {
  key: string;
  label: string;
  group: 'gear' | 'shadow' | 'costume';
  /** Values of item.equip_slots that may go here. */
  accepts: string[];
  /** Values of card.equip_slots that may be compounded into this slot. */
  cardTargets: string[];
  /** Restrict to these item kinds, when the slot wording is ambiguous. */
  kinds?: string[];
  /**
   * Restrict to these item types, for slots the server's `equip_slots`
   * wording cannot tell apart. Manuals and shadow accessories both say
   * "Shadow accessory" but are worn in different places.
   */
  types?: string[];
}

export const SLOTS: SlotDef[] = [
  { key: 'upper', label: 'Upper Headgear', group: 'gear',
    accepts: ['Upper headgear'], cardTargets: ['Upper headgear'],
    kinds: ['Headgear', 'Armor'] },
  { key: 'middle', label: 'Middle Headgear', group: 'gear',
    accepts: ['Middle headgear'], cardTargets: ['Middle headgear'],
    kinds: ['Headgear', 'Armor'] },
  { key: 'lower', label: 'Lower Headgear', group: 'gear',
    accepts: ['Lower headgear'], cardTargets: ['Lower headgear'],
    kinds: ['Headgear', 'Armor'] },
  { key: 'armor', label: 'Armor', group: 'gear',
    accepts: ['Armor'], cardTargets: ['Armor'] },
  { key: 'weapon', label: 'Weapon', group: 'gear',
    accepts: ['Weapon', 'Weapon (two-handed)'],
    cardTargets: ['Weapon', 'Weapon (two-handed)'] },
  { key: 'offhand', label: 'Off-hand', group: 'gear',
    // This server lets you dual wield, so the off hand takes a one-handed
    // weapon as readily as a shield. Two-handed weapons are filed under
    // "Weapon (two-handed)" and so cannot land here, and the slot is blocked
    // outright while one is worn.
    accepts: ['Off-hand', 'Weapon'], cardTargets: ['Shield', 'Weapon'] },
  { key: 'garment', label: 'Garment', group: 'gear',
    accepts: ['Garment'], cardTargets: ['Garment'] },
  { key: 'shoes', label: 'Shoes', group: 'gear',
    accepts: ['Shoes'], cardTargets: ['Shoes'] },
  { key: 'acc1', label: 'Accessory 1', group: 'gear',
    accepts: ['Accessory'], cardTargets: ['Accessory'] },
  { key: 'acc2', label: 'Accessory 2', group: 'gear',
    accepts: ['Accessory'], cardTargets: ['Accessory'] },
  { key: 'ammo', label: 'Ammunition', group: 'gear',
    accepts: ['Ammunition'], cardTargets: [] },
  // One class gem, worn in a slot of its own. The server files every gem
  // under "Gem", so the slot wording alone is enough to tell them apart.
  { key: 'gem', label: 'Class Gem', group: 'gear',
    accepts: ['Gem'], cardTargets: [] },

  { key: 'sh_armor', label: 'Shadow Armor', group: 'shadow',
    accepts: ['Shadow armor'], cardTargets: [] },
  { key: 'sh_shoes', label: 'Shadow Shoes', group: 'shadow',
    accepts: ['Shadow shoes'], cardTargets: [] },
  { key: 'sh_gloves', label: 'Shadow Gloves', group: 'shadow',
    accepts: ['Shadow gloves'], cardTargets: [] },
  // Shadow accessories and manuals both declare "Shadow accessory" but are
  // worn in different places, so the two are told apart by kind and type
  // rather than by the slot wording the server gives them.
  { key: 'sh_acc', label: 'Shadow Accessory', group: 'shadow',
    accepts: ['Shadow accessory'], cardTargets: [], kinds: ['Shadow gear'] },
  { key: 'sh_manual', label: 'Manual', group: 'shadow',
    accepts: ['Shadow accessory'], cardTargets: [], types: ['Manual'] },
  // Runes and orbs are not shadow gear by kind, but they are worn alongside
  // it and roll the same way, so they live under the same heading.
  { key: 'runeorb', label: 'Rune or Orb', group: 'shadow',
    accepts: ['Rune or orb'], cardTargets: [] },

  { key: 'cos_upper', label: 'Costume Upper', group: 'costume',
    accepts: ['Upper headgear', 'Costume'], cardTargets: [], kinds: ['Costume'] },
  { key: 'cos_middle', label: 'Costume Middle', group: 'costume',
    accepts: ['Middle headgear', 'Costume'], cardTargets: [], kinds: ['Costume'] },
  { key: 'cos_lower', label: 'Costume Lower', group: 'costume',
    accepts: ['Lower headgear', 'Costume'], cardTargets: [], kinds: ['Costume'] },
  { key: 'cos_garment', label: 'Costume Garment', group: 'costume',
    accepts: ['Garment', 'Costume'], cardTargets: [], kinds: ['Costume'] },
];

export const SLOT_BY_KEY = new Map(SLOTS.map((s) => [s.key, s]));

export function isTwoHanded(item: Item | null | undefined): boolean {
  return !!item?.equip_slots?.includes('Weapon (two-handed)');
}

/** Can this item be equipped in this slot? */
export function fitsSlot(item: Item, slot: SlotDef): boolean {
  // A card's equip_slots names what it compounds into ("Weapon"), not a
  // place it can be worn, so read literally it would fit the slot itself.
  if (item.kind === 'Card') return false;
  if (slot.kinds && !slot.kinds.includes(item.kind)) return false;
  if (slot.types && !(item.type && slot.types.includes(item.type))) return false;
  // Costume pieces must never land in a real gear slot, and vice versa.
  if (slot.group !== 'costume' && item.kind === 'Costume') return false;
  return item.equip_slots.some((s) => slot.accepts.includes(s));
}

/**
 * Can this card be compounded into this slot?
 *
 * Pass `into` when the slot already holds something. It matters for the off
 * hand, which takes either a shield or a weapon: a card that fits the one
 * does not fit the other, and the slot alone cannot say which is in it.
 */
export function fitsCard(card: Item, slot: SlotDef, into?: Item | null): boolean {
  if (card.kind !== 'Card') return false;
  const targets = into ? cardTargets(into, slot) : slot.cardTargets;
  return card.equip_slots.some((s) => targets.includes(s));
}

/** What a card has to target to go into this particular item. */
function cardTargets(item: Item, slot: SlotDef): string[] {
  // A card calls the shield slot "Shield" where the shield itself says
  // "Off-hand", so the item's own wording needs translating first.
  return item.equip_slots
    .map((s) => (s === 'Off-hand' ? 'Shield' : s))
    .filter((s) => slot.cardTargets.includes(s));
}

export const MAIN_HAND = 'weapon';
export const OFF_HAND = 'offhand';

/**
 * Is this slot locked against suggestions?
 *
 * A lock covers the whole slot -- the piece, its cards and its rolls -- so
 * "settled, work around it" needs one click rather than one per socket.
 * Nothing stops the player from editing a locked slot by hand: the lock is
 * an instruction to the planner, not a catch on the slot.
 */
export function isLocked(build: Build, slotKey: string): boolean {
  return !!build.locked?.includes(slotKey);
}

/** The same build with one slot locked or unlocked. */
export function withLock(build: Build, slotKey: string, locked: boolean): Build {
  const rest = (build.locked ?? []).filter((k) => k !== slotKey);
  return { ...build, locked: locked ? [...rest, slotKey] : rest };
}

/**
 * Swap what is in the two hands, or null if that cannot be done.
 *
 * Worth having a button for because the equipment window is laid out as the
 * character faces you -- its left column is the character's right hand --
 * and that is easy to read the wrong way round, whether by a person or by
 * the screenshot reader. There is nothing in a dual-wielded pair that says
 * which weapon was in which hand, so the answer is a correction, not a
 * detection.
 *
 * Returns null rather than a half-done swap when either piece cannot go
 * where the other one is: a shield has no business in the main hand, and a
 * two-handed weapon occupies both hands anyway.
 */
export function swapHands(build: Build, dataset: Dataset): Build | null {
  const main = build.slots[MAIN_HAND];
  const off = build.slots[OFF_HAND];
  if (!main || !off || (!main.itemId && !off.itemId)) return null;

  const mainSlot = SLOT_BY_KEY.get(MAIN_HAND)!;
  const offSlot = SLOT_BY_KEY.get(OFF_HAND)!;
  const mainItem = main.itemId ? dataset.items.get(main.itemId) ?? null : null;
  const offItem = off.itemId ? dataset.items.get(off.itemId) ?? null : null;

  if (mainItem && !fitsSlot(mainItem, offSlot)) return null;
  if (offItem && !fitsSlot(offItem, mainSlot)) return null;

  return {
    ...build,
    slots: {
      ...build.slots,
      [MAIN_HAND]: moved(off, offItem, mainSlot, dataset),
      [OFF_HAND]: moved(main, mainItem, offSlot, dataset),
    },
  };
}

/** A slot's contents, rehomed -- keeping only the cards the new slot allows. */
function moved(
  state: SlotState, item: Item | null, to: SlotDef, dataset: Dataset,
): SlotState {
  if (!item) return { itemId: null, refine: 0, cards: [] };
  return carryInto(state, item, to, dataset);
}

/**
 * Put an item into a slot, keeping as much of what was already set as fits.
 *
 * Trying a different weapon while planning is a comparison, not a fresh
 * start: the refine, the cards and the rolls were all typed in by hand and
 * mostly still apply. So each is carried across and then cut down to what
 * the new item can actually take -- the refine to its cap, the cards to the
 * sockets it has and the ones that fit, the rolls to the table it rolls on.
 *
 * Clearing the slot is the way to start over, and that stays untouched.
 */
export function carryInto(
  state: SlotState | undefined, item: Item, slot: SlotDef, dataset: Dataset,
): SlotState {
  const kept: (number | null)[] = [];
  for (const id of state?.cards ?? []) {
    if (kept.length >= item.card_slots) break;
    const card = id ? dataset.items.get(id) ?? null : null;
    // A card that does not fit the new piece is dropped rather than shuffled
    // along, so the sockets that do carry over keep their positions.
    kept.push(card && fitsCard(card, slot, item) ? id : null);
  }
  while (kept.length < item.card_slots) kept.push(null);

  const rolls = reconcileRolls(
    state?.rolls, rollTableFor(dataset.rolls, slot.key, item));

  return {
    itemId: item.id,
    refine: Math.max(0, Math.min(maxRefine(item), state?.refine ?? 0)),
    cards: kept,
    // Left off entirely when there is nothing to carry, so a slot that has
    // never rolled does not grow an empty key in the saved build.
    ...(Object.keys(rolls).length > 0 ? { rolls } : {}),
  };
}

/** One card, and every socket of this piece holding a copy of it. */
export interface CardGroup {
  cardId: number;
  count: number;
  /** Socket indices, ascending. The first is what a click acts on. */
  sockets: number[];
}

/**
 * Collapse a piece's sockets into one entry per distinct card.
 *
 * Four of the same card is the ordinary case on this server, and listing
 * the name four times says nothing the count does not. Sockets are not
 * positionally meaningful in Ragnarok, so nothing is lost by grouping them
 * -- but the indices are kept, because the build still stores cards per
 * socket and the screenshot reader still fills them that way.
 *
 * Order is first appearance, so a card does not jump around the row when
 * another copy is added or taken away.
 */
export function groupCards(cards: (number | null)[]): CardGroup[] {
  const byId = new Map<number, CardGroup>();
  cards.forEach((id, socket) => {
    if (!id) return;
    const group = byId.get(id);
    if (group) {
      group.count += 1;
      group.sockets.push(socket);
    } else {
      byId.set(id, { cardId: id, count: 1, sockets: [socket] });
    }
  });
  return [...byId.values()];
}

/** Sockets with nothing in them, ascending. */
export function emptySockets(cards: (number | null)[]): number[] {
  const out: number[] = [];
  cards.forEach((id, socket) => { if (!id) out.push(socket); });
  return out;
}

/**
 * A piece's sockets as a full-length array.
 *
 * A saved build can hold fewer entries than the item has sockets, and a
 * short array would hide the free ones rather than offer them.
 */
export function socketsOf(item: Item, cards: (number | null)[]): (number | null)[] {
  return Array.from({ length: item.card_slots }, (_, i) => cards[i] ?? null);
}

/** This server refines to +10. */
export const MAX_REFINE = 10;

/**
 * Can this item be refined?
 *
 * The server's own column says no for every class gem, yet each one has a
 * "Per Refine:" block and an "If refine is +10:" tier, and some tie a skill
 * level to it ("limited by refine level"). The tooltip is the better
 * witness here, so gems are refineable whatever the column says.
 */
export function isRefineable(item: Item | null | undefined): boolean {
  if (!item) return false;
  return item.refineable || item.type === 'Class Gem';
}

export function maxRefine(item: Item | null | undefined): number {
  return isRefineable(item) ? MAX_REFINE : 0;
}

/**
 * A one-handed weapon carried in the off hand.
 *
 * Race and size damage modifiers on it count at half on this server, so the
 * aggregator needs to tell it apart from a shield, which keeps them whole.
 */
export function isOffhandWeapon(slot: SlotDef, item: Item | null | undefined): boolean {
  return slot.key === OFF_HAND && !!item?.equip_slots.includes('Weapon');
}

// ---- headgear that takes more than one slot ------------------------------

/** The headgear slots, top to bottom, for gear and for costumes. */
const HEADGEAR_ROWS: Record<string, string>[] = [
  { 'Upper headgear': 'upper', 'Middle headgear': 'middle', 'Lower headgear': 'lower' },
  { 'Upper headgear': 'cos_upper', 'Middle headgear': 'cos_middle', 'Lower headgear': 'cos_lower' },
];

function rowOf(slotKey: string): Record<string, string> | undefined {
  return HEADGEAR_ROWS.find((row) => Object.values(row).includes(slotKey));
}

/**
 * The other headgear slots a piece takes up when worn in `slotKey`.
 *
 * A headgear that lists more than one position -- Majestic Helmet is
 * upper and middle, Odin's Mask middle and lower -- is worn in all of them
 * at once, as in the game. The item data says it can go in either; it does
 * not say that wearing it empties the other.
 */
export function coversAlso(item: Item | null | undefined, slotKey: string): string[] {
  const row = rowOf(slotKey);
  if (!item || !row) return [];
  const keys = item.equip_slots.map((s) => row[s]).filter((k): k is string => !!k);
  return keys.includes(slotKey) ? keys.filter((k) => k !== slotKey) : [];
}

/**
 * The slot whose headgear also takes up this one, if any.
 *
 * A screenshot shows a two-position headgear in both of its slots, so the
 * same piece can be recorded twice. It is worn once: the higher of the two
 * slots is where it counts, and the other reads as taken by it.
 */
export function coveredBy(build: Build, slotKey: string, data: Dataset): string | null {
  const row = rowOf(slotKey);
  if (!row) return null;
  const order = Object.values(row);
  for (const other of order) {
    if (other === slotKey) continue;
    const id = build.slots[other]?.itemId;
    if (!coversAlso(data.items.get(id ?? -1), other).includes(slotKey)) continue;
    // The same piece recorded in both: it counts in the higher slot.
    if (build.slots[slotKey]?.itemId === id && order.indexOf(slotKey) < order.indexOf(other)) {
      continue;
    }
    return other;
  }
  return null;
}

const NOTHING: SlotState = { itemId: null, refine: 0, cards: [] };

/**
 * The slots after putting something into `slotKey`, with headgear sorted
 * out: a multi-position piece empties the other slots it takes, and a piece
 * put where one was covering takes the covering one off.
 */
export function settleHeadgear(
  slots: Record<string, SlotState>, slotKey: string, data: Dataset,
): Record<string, SlotState> {
  const row = rowOf(slotKey);
  if (!row) return slots;
  const out = { ...slots };
  const placed = data.items.get(out[slotKey]?.itemId ?? -1);
  for (const k of coversAlso(placed, slotKey)) out[k] = NOTHING;
  if (placed) {
    for (const other of Object.values(row)) {
      if (other === slotKey) continue;
      const item = data.items.get(out[other]?.itemId ?? -1);
      if (coversAlso(item, other).includes(slotKey)) out[other] = NOTHING;
    }
  }
  return out;
}
