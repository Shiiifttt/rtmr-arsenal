import {
  carryInto, fitsCard, fitsSlot, isLocked, SLOTS, socketsOf, type SlotDef,
} from './slots.ts';
import type { Build, Dataset, Item, SetRecord, SlotChange, SlotState } from './types.ts';

const EMPTY: SlotState = { itemId: null, refine: 0, cards: [] };

/** Every item id the build currently has on, pieces and cards alike. */
export function wornIds(build: Build): Set<number> {
  const ids = new Set<number>();
  for (const state of Object.values(build.slots)) {
    if (state?.itemId) ids.add(state.itemId);
    for (const card of state?.cards ?? []) if (card) ids.add(card);
  }
  return ids;
}

/** The set's members this build is not wearing, in the set's own order. */
export function missingMembers(build: Build, set: SetRecord): number[] {
  const worn = wornIds(build);
  return set.member_ids.filter((id) => !worn.has(id));
}

export interface SetFill {
  /** Slot changes that put on every member that had somewhere to go. */
  changes: SlotChange[];
  /** Members this fill puts on, in the order they were placed. */
  placed: number[];
  /**
   * Members with nowhere to go: barred by the options, with no slot that
   * takes them, or with only a locked slot left. A fill that leaves any of
   * these behind may still have put on everything the set needs, so whether
   * it finished is `placed.length` against what was needed, not this.
   */
  blocked: number[];
}

export interface FillOptions {
  /**
   * Reject a member -- the suggester's class and level filters. Asked once
   * without a slot, and again for each slot it could go in: a class may take
   * a piece in one hand and not the other.
   */
  allowed?: (item: Item, slotKey?: string) => boolean;
  /** How a placed piece ends up in its slot. Defaults to a plain swap in. */
  place?: (state: SlotState, item: Item, slot: SlotDef) => SlotState;
  /**
   * Stop after this many pieces go on. Some sets list alternatives -- seven
   * Asgard accessories of which any two count -- so putting on everything
   * missing would be both impossible and wrong. Defaults to all of them.
   */
  need?: number;
}

/**
 * Put on the pieces of a set that are missing.
 *
 * A set is the one thing single swaps cannot find: until the last piece goes
 * on, each piece on its own may be worth nothing, so no one step ever looks
 * like progress. So the whole remainder is worked out at once -- both for
 * the planner, which offers it as a single move, and for the "fill the set"
 * button, which is a player saying the same thing by hand.
 *
 * A locked slot is nowhere. A lock says "work around this", and a fill that
 * quietly replaced a settled piece would be exactly the thing the lock was
 * put there to prevent; the member lands in `blocked` instead.
 */
export function fillSet(
  build: Build, set: SetRecord, missing: number[], data: Dataset,
  opts: FillOptions = {},
): SetFill {
  const place = opts.place
    ?? ((state, item, slot) => carryInto(state, item, slot, data));
  const members = new Set(set.member_ids);
  const states: Record<string, SlotState> = {};
  const stateOf = (key: string) => states[key] ?? build.slots[key] ?? EMPTY;
  const taken = new Set<string>();
  const free = SLOTS.filter((s) => !isLocked(build, s.key));
  const placed: number[] = [];
  const blocked: number[] = [];

  const need = opts.need ?? missing.length;

  for (const id of missing) {
    if (placed.length >= need) break;
    const item = data.items.get(id);
    if (!item || (opts.allowed && !opts.allowed(item))) {
      blocked.push(id);
      continue;
    }

    if (item.kind === 'Card') {
      // Into a socket of something already worn: an empty one first, and
      // never one holding another piece of the same set.
      let into = false;
      for (const slot of free) {
        const state = stateOf(slot.key);
        const host = state.itemId ? data.items.get(state.itemId) : undefined;
        if (!host || !fitsCard(item, slot, host)) continue;
        const sockets = socketsOf(host, state.cards);
        let at = sockets.findIndex((c) => c === null);
        if (at < 0) at = sockets.findIndex((c) => c !== null && !members.has(c));
        if (at < 0) continue;
        sockets[at] = id;
        states[slot.key] = { ...state, cards: sockets };
        into = true;
        break;
      }
      if (into) placed.push(id);
      else blocked.push(id);
      continue;
    }

    // A piece: prefer an empty slot, then any slot not already holding a
    // member of this set or claimed by an earlier piece of it.
    const options = free.filter((s) => fitsSlot(item, s) && !taken.has(s.key)
      && (!opts.allowed || opts.allowed(item, s.key))
      && !members.has(stateOf(s.key).itemId ?? -1));
    const slot = options.find((s) => !stateOf(s.key).itemId) ?? options[0];
    if (!slot) {
      blocked.push(id);
      continue;
    }
    taken.add(slot.key);
    states[slot.key] = place(stateOf(slot.key), item, slot);
    placed.push(id);
  }

  return {
    changes: Object.entries(states).map(([slot, state]) => ({ slot, state })),
    placed,
    blocked,
  };
}

/**
 * Everything a set still needs, worked out and placed in one go.
 *
 * This is the "fill the set" button: one piece on, and the rest follow. It
 * differs from what the planner asks for only in doing its own arithmetic
 * -- which members are missing, and how many of them the set actually
 * counts -- rather than being told.
 */
export function completeSet(
  build: Build, set: SetRecord, data: Dataset, opts: FillOptions = {},
): SetFill & { need: number } {
  const missing = missingMembers(build, set);
  const worn = set.member_ids.length - missing.length;
  const need = Math.max(0, Math.min(set.member_count - worn, missing.length));
  return { ...fillSet(build, set, missing, data, { ...opts, need }), need };
}
