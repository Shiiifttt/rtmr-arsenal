import {
  BASE_LEVEL_DEFAULT, carryInto, clampBaseLevel, clampBaseStat, defaultBaseStats,
  fitsSlot, goalMetrics, SLOT_BY_KEY, SLOTS,
  type BaseStats, type Build, type Dataset, type Goal, type SlotState,
} from '@sim';

// Bumped when the saved shape changes, so an older save is discarded rather
// than half-restored into a build that no longer has the same fields.
// Rolls were added as an optional field, so a v3 save still reconciles
// cleanly and there is no reason to throw one away.
export const STORAGE_KEY = 'rtmr.build.v3';

export function emptyBuild(): Build {
  const slots: Record<string, SlotState> = {};
  for (const slot of SLOTS) slots[slot.key] = { itemId: null, refine: 0, cards: [] };
  return {
    className: null,
    baseLevel: BASE_LEVEL_DEFAULT,
    baseStats: defaultBaseStats(),
    slots,
  };
}

/**
 * Drop anything in a saved build that the current dataset no longer has.
 *
 * Builds outlive crawls, and an item that has been renamed or removed would
 * otherwise sit in a slot as a blank that cannot be cleared. Everything that
 * arrives from outside the app -- the autosave, an exported file, a shared
 * link -- comes through here, so a hand-edited or stale one cannot put a
 * number the rest of the app does not expect into a total.
 */
export function reconcile(saved: Build, dataset: Dataset): Build {
  const fresh = emptyBuild();
  fresh.className = saved.className && dataset.classes.includes(saved.className)
    ? saved.className : null;
  if (typeof saved.baseLevel === 'number') {
    fresh.baseLevel = clampBaseLevel(saved.baseLevel);
  }
  // Only finite numbers, so a corrupt save cannot put NaN into a total.
  if (saved.manual) {
    fresh.manual = Object.fromEntries(
      Object.entries(saved.manual).filter(([, v]) => Number.isFinite(v)));
  }

  // Locks are slot keys, so only ones this version still has a slot for.
  if (Array.isArray(saved.locked)) {
    fresh.locked = saved.locked.filter((key) => SLOT_BY_KEY.has(key));
  }

  // Only goals on a number this dataset still has, with a usable target.
  const metrics = goalMetrics(dataset);
  const usable = (g: Goal) => Number.isFinite(g?.target)
    && metrics.some((m) => m.key === g.key && m.column === g.column);
  if (Array.isArray(saved.goals)) fresh.goals = saved.goals.filter(usable);
  // Guards are kept only when the save actually has them. Absent means the
  // defaults, and a build from before guards existed should get them rather
  // than be pinned to having none; an empty array is a real answer and is
  // carried through as one.
  if (Array.isArray(saved.guards)) {
    fresh.guards = saved.guards.filter(usable).map((g) => ({ ...g, guard: true }));
  }

  for (const key of Object.keys(fresh.baseStats) as (keyof BaseStats)[]) {
    const value = saved.baseStats?.[key];
    if (typeof value === 'number') fresh.baseStats[key] = clampBaseStat(value);
  }

  // Accessories learned their sides after builds were saved with Gleipnir
  // in the right hand. Swapping the two keeps the piece rather than
  // dropping it for being on the wrong side -- when the swap is what fits.
  const savedSlots = { ...(saved.slots ?? {}) };
  const fits = (key: string, into: string) => {
    const item = dataset.items.get(savedSlots[key]?.itemId ?? -1);
    return !item || fitsSlot(item, SLOT_BY_KEY.get(into)!);
  };
  if ((!fits('acc1', 'acc1') || !fits('acc2', 'acc2')) && fits('acc1', 'acc2') && fits('acc2', 'acc1')) {
    [savedSlots.acc1, savedSlots.acc2] = [savedSlots.acc2, savedSlots.acc1];
  }

  // The orb had no slot of its own until runes and orbs were split, so an
  // orb saved in the old shared one moves across.
  if (!savedSlots.orb?.itemId && !fits('runeorb', 'runeorb') && fits('runeorb', 'orb')) {
    [savedSlots.orb, savedSlots.runeorb] = [savedSlots.runeorb, undefined as never];
  }

  for (const slot of SLOTS) {
    const state = savedSlots[slot.key];
    if (!state?.itemId) continue;
    const item = dataset.items.get(state.itemId);
    if (!item || !fitsSlot(item, slot)) continue;

    // The same narrowing a swap does: a refine over the current cap, a card
    // that no longer fits, a roll whose option has gone.
    fresh.slots[slot.key] = carryInto(state, item, slot, dataset);
  }
  return fresh;
}
