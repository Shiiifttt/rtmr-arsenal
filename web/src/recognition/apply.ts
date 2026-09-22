/**
 * Turning what was read into a build.
 *
 * The equipment window's grid is not the planner's slot list, and trying to
 * map one onto the other position by position would bake in an assumption
 * about a layout the server is free to change. So placement goes the other
 * way round: each recognised item is put wherever its own equip_slots say it
 * belongs, and the grid position is consulted only to break the ties that
 * leaves -- which hand a weapon was in, and which of the two accessory slots
 * a ring was in.
 */

import {
  clampBaseStat, fitsCard, fitsSlot, maxRefine, rollTableFor, SLOTS,
  type Build, type Dataset, type Item, type SlotDef,
} from '@sim';
import { readName } from './names.ts';
import { matchRolls, picksFrom, type RollMatch } from './rolls.ts';
import type { Reading, ReadSlot } from './types.ts';

export interface Applied {
  build: Build;
  /** One line per slot filled, for the review list. */
  placed: {
    slot: SlotDef;
    item: Item;
    refine: number;
    cards: Item[];
    /**
     * Words in the name that looked like card affixes but did not resolve to
     * one. Worth showing: it is how an undetected card makes itself known,
     * rather than the slot just quietly coming back with fewer cards.
     */
    unread: string[];
  }[];
  /** Rows that were read but could not be placed, and why. */
  skipped: { text: string; reason: string }[];
  /** Rolls read off an item tooltip, whether or not they resolved. */
  rolls: {
    item: Item;
    slot: SlotDef;
    matched: RollMatch[];
  }[];
}

/**
 * The grid positions that mean something, when an item fits more than one slot.
 *
 * The equipment window's weapon rows are laid out as the character faces you,
 * so the left-hand column is the character's right hand -- the main hand --
 * and the right-hand column is the off hand.
 */
const HINTS: Record<string, string[]> = {
  'left-2': ['weapon', 'offhand'],
  'right-2': ['offhand', 'weapon'],
  'left-4': ['acc1', 'acc2'],
  'right-4': ['acc2', 'acc1'],
};

export function applyReadings(
  readings: Reading[], dataset: Dataset, base: Build,
): Applied {
  const build: Build = {
    ...base,
    baseStats: { ...base.baseStats },
    slots: Object.fromEntries(
      Object.entries(base.slots).map(([key, state]) => [key, { ...state }]),
    ),
  };
  const placed: Applied['placed'] = [];
  const skipped: Applied['skipped'] = [];
  const rolls: Applied['rolls'] = [];

  for (const reading of readings) {
    if (reading.stats) {
      for (const [key, value] of Object.entries(reading.stats)) {
        if (key in build.baseStats) {
          build.baseStats[key as keyof Build['baseStats']] = clampBaseStat(value.base);
        }
      }
    }
  }

  const rows = readings
    .flatMap((reading) => reading.slots ?? [])
    .map((slot) => ({ slot, item: resolve(slot, dataset) }));

  const pending = rows.filter((row) => {
    if (!row.item) {
      skipped.push({
        text: row.slot.text,
        reason: row.slot.candidates.length
          ? 'the icon matched several items and the name did not decide between them'
          : 'no icon in the library matched',
      });
      return false;
    }
    return true;
  }) as { slot: ReadSlot; item: Item }[];

  // Slots already filled are out of bounds -- pasting the second tab must not
  // dislodge what the first one placed. A slot holding an item that is in
  // this screenshot too is the exception: that is the same piece being read
  // again, and it should land back where it was rather than be reported as
  // having nowhere to go.
  const incoming = new Set(pending.map((row) => row.item.id));
  const taken = new Set<string>();
  for (const slot of SLOTS) {
    const itemId = build.slots[slot.key]?.itemId;
    if (!itemId) continue;
    // Emptied rather than just freed: the piece may be placed somewhere else
    // this time round, and leaving it here as well would duplicate it.
    if (incoming.has(itemId)) build.slots[slot.key] = { itemId: null, refine: 0, cards: [] };
    else taken.add(slot.key);
  }

  // Items with no choice of slot go first, so that one which could go in
  // two places does not take a slot the other needed. Among equals, the one
  // whose grid position asked for that slot wins -- when dual wielding, both
  // weapons fit both hands, and the column is the only thing that says which
  // was in which.
  pending.sort((a, b) => {
    const byCount = options(a, taken).length - options(b, taken).length;
    return byCount || (hinted(a) ? 0 : 1) - (hinted(b) ? 0 : 1);
  });

  for (const row of pending) {
    const choice = options(row, taken)[0];
    if (!choice) {
      skipped.push({
        text: row.slot.text,
        reason: `nowhere left to put a ${row.item.equip_slots.join(' / ') || 'item'}`,
      });
      continue;
    }
    taken.add(choice.key);

    const cards: (number | null)[] = new Array(row.item.card_slots).fill(null);
    const used: Item[] = [];
    for (const id of row.slot.cards) {
      const card = dataset.items.get(id);
      const free = cards.indexOf(null);
      if (!card || free < 0 || !fitsCard(card, choice, row.item)) continue;
      cards[free] = id;
      used.push(card);
    }

    const refine = Math.max(0, Math.min(maxRefine(row.item), row.slot.refine));
    build.slots[choice.key] = { itemId: row.item.id, refine, cards };
    placed.push({
      slot: choice, item: row.item, refine, cards: used,
      unread: row.slot.unresolvedAffixes,
    });
  }

  // Rolls last: they attach to a slot by the item already in it, so the
  // gear from this same screenshot has to be placed first.
  for (const reading of readings) {
    if (reading.window !== 'tooltip') continue;
    applyTooltip(reading, dataset, build, rolls, skipped);
  }

  return { build, placed, skipped, rolls };
}

/**
 * Attach a tooltip's rolls to whichever slot already holds that item.
 *
 * The tooltip says nothing about where the item is worn, and the rolls mean
 * nothing without knowing: which options exist at all is a property of the
 * slot. So the item has to be in the build already -- read the equipment
 * window first, or pick the piece by hand -- and if it is not, that is worth
 * saying rather than quietly dropping the rolls.
 */
function applyTooltip(
  reading: Reading, dataset: Dataset, build: Build,
  rolls: Applied['rolls'], skipped: Applied['skipped'],
): void {
  const text = reading.title || '(unreadable)';
  if (!reading.rollLines?.length) return;  // nothing rolled; nothing to say

  // Matched against what is worn rather than against the whole catalogue.
  // That is both the accurate way round -- a dozen candidates instead of
  // four thousand, where a short name like "Boots" would otherwise sit
  // inside "Temporal STR Boots" and score perfectly -- and the useful one,
  // since it is the slot, not the item, that decides what can roll.
  const worn = SLOTS
    .map((slot) => ({ slot, item: dataset.items.get(build.slots[slot.key]?.itemId ?? -1) }))
    .filter((w): w is { slot: SlotDef; item: Item } => !!w.item);

  const cards = dataset.itemList.filter((i) => i.card_affix);
  const name = readName(text, worn.map((w) => w.item), cards);
  const match = worn.find((w) => w.item.id === name.itemId);
  if (!match) {
    skipped.push({
      text,
      reason: 'nothing equipped in this build matches this tooltip — read the '
        + 'equipment window first, or set the piece by hand',
    });
    return;
  }
  const { slot, item } = match;

  const table = rollTableFor(dataset.rolls, slot.key, item);
  if (!table) {
    skipped.push({
      text,
      reason: `nothing in ${slot.label} rolls, so these lines have nowhere to go`,
    });
    return;
  }

  const matched = matchRolls(reading.rollLines, table);
  build.slots[slot.key] = {
    ...build.slots[slot.key],
    rolls: { ...build.slots[slot.key].rolls, ...picksFrom(matched, table) },
  };
  rolls.push({ item, slot, matched });
}

function resolve(slot: ReadSlot, dataset: Dataset): Item | null {
  return slot.itemId ? dataset.items.get(slot.itemId) ?? null : null;
}

/** Did this row land in the slot its grid position calls for? */
function hinted(row: { slot: ReadSlot; item: Item }): boolean {
  const hint = HINTS[`${row.slot.column}-${row.slot.row}`];
  const first = options(row, new Set())[0];
  return !!hint && !!first && hint[0] === first.key;
}

/** Where this item could go, best first. */
function options(row: { slot: ReadSlot; item: Item }, taken: Set<string>): SlotDef[] {
  const fits = SLOTS.filter((slot) => !taken.has(slot.key) && fitsSlot(row.item, slot));
  const hint = HINTS[`${row.slot.column}-${row.slot.row}`];
  if (!hint) return fits;
  return [...fits].sort((a, b) => rank(hint, a) - rank(hint, b));
}

function rank(hint: string[], slot: SlotDef): number {
  const at = hint.indexOf(slot.key);
  return at < 0 ? hint.length : at;
}
