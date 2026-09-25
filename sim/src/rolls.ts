import type {
  Effect, Item, RollData, RollDef, RollGrant, RollOption, RollTable,
} from './types.ts';

/**
 * The random bonuses an item gets when it drops.
 *
 * Two things separate these from everything else the planner adds up.
 * They are not in the crawled data at all -- the site shows the item as
 * designed, not as any one copy of it rolled -- and they differ per copy, so
 * they are part of the *build*, not part of the item. That is why the values
 * live in the slot state next to the refine level, and why the tables that
 * bound them are a hand-written dataset (crawler/rolls.json).
 *
 * A roll the player has not filled in contributes nothing and says nothing.
 * Only an option they picked produces a line.
 */

/** One roll as the player has set it: which option, and the values read off. */
export interface RollPick {
  option: string | null;
  /** One per grant of the chosen option, in the same order. */
  values: number[];
  /** For a skill-modifier roll: which skill the item names. */
  skill?: string;
}

/**
 * The table defined for a slot, before any per-item condition.
 *
 * Answers "can anything in this slot roll", which is not the same question
 * as whether the piece currently in it does. Use `rollTableFor` for that.
 */
export function tableForSlot(
  data: RollData | null | undefined, slotKey: string,
): RollTable | null {
  if (!data) return null;
  return data.tables.find((t) => t.slots.includes(slotKey) && !t.requires?.types) ?? null;
}

/**
 * Does this particular item roll under this table?
 *
 * Headgear and accessories only roll when they drop off a monster, so the
 * gate reads the crawled drop list rather than asking the player to know.
 * An item with no `drops` field at all -- an older dataset, or one crawled
 * without them -- is treated as not dropped, because inventing rolls is the
 * worse failure of the two: it would silently inflate the totals.
 */
export function rollsApply(table: RollTable, item: Item): boolean {
  if (table.requires?.dropped && !(item.drops && item.drops.length > 0)) {
    return false;
  }
  if (table.requires?.types && !(item.type && table.requires.types.includes(item.type))) {
    return false;
  }
  return true;
}

/**
 * Gear from a place that never hands out rolls: Sky Garden's exchanges, on
 * the project owner's word. Read off where the item is got, so a new Sky
 * Garden piece is covered without being named.
 */
function neverRolls(data: RollData | null | undefined, item: Item): boolean {
  const how = item.raw?.how;
  const where = Array.isArray(how) && typeof how[0] === 'string' ? how[0].toLowerCase() : '';
  return !!where && (data?.never_from ?? []).some((p) => where.includes(p.toLowerCase()));
}

/**
 * Does this item roll this one roll? Only a gated roll can say no, and only
 * by the item's description not naming it: most drops roll stats, and only
 * the few that say "Skill Random Mods" roll a skill modifier as well.
 */
export function rollApplies(roll: RollDef, item: Item): boolean {
  const says = roll.requires?.says;
  if (!says?.length) return true;
  const text = (item.description ?? '').toLowerCase();
  return says.some((s) => text.includes(s.toLowerCase()));
}

/**
 * The table with only the rolls this item gets, per roll gate. The same
 * object for the same rolls, so a slot re-rendered or re-scored is not handed
 * a fresh table every time.
 */
const NARROWED = new WeakMap<RollTable, Map<string, RollTable>>();

/** What this item, in this slot, actually rolls. Null when it rolls nothing. */
export function rollTableFor(
  data: RollData | null | undefined, slotKey: string, item: Item | null | undefined,
): RollTable | null {
  if (!item) return null;
  // A table for this item's type comes first -- an orb rolls its own two,
  // not the rune's -- then the slot's ordinary one.
  const table = data?.tables.find((t) => t.slots.includes(slotKey) && !!t.requires?.types
    && rollsApply(t, item)) ?? tableForSlot(data, slotKey);
  if (!table) return null;
  if (neverRolls(data, item) || !rollsApply(table, item)) return null;
  const rolls = table.rolls.filter((r) => rollApplies(r, item));
  if (rolls.length === table.rolls.length) return table;
  if (rolls.length === 0) return null;
  const sig = rolls.map((r) => r.key).join('|');
  let byRolls = NARROWED.get(table);
  if (!byRolls) NARROWED.set(table, byRolls = new Map());
  let narrowed = byRolls.get(sig);
  if (!narrowed) byRolls.set(sig, narrowed = { ...table, rolls });
  return narrowed;
}

export function optionOf(table: RollTable, rollKey: string, optionKey: string | null) {
  if (!optionKey) return null;
  const roll = table.rolls.find((r) => r.key === rollKey);
  return roll?.options.find((o) => o.key === optionKey) ?? null;
}

/**
 * Keep a typed value inside what the table allows.
 *
 * An open upper bound (`max: null`) means the range is simply not known
 * yet, so anything at or above the minimum is accepted rather than being
 * clipped to a number nobody has confirmed.
 */
export function clampRoll(grant: RollGrant, n: number): number {
  if (!Number.isFinite(n)) return grant.min;
  const step = grant.step ?? 1;
  const rounded = step >= 1 ? Math.trunc(n) : round(n, step);
  if (rounded < grant.min) return grant.min;
  if (grant.max !== null && grant.max !== undefined && rounded > grant.max) {
    return grant.max;
  }
  return rounded;
}

function round(n: number, step: number): number {
  const places = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number(n.toFixed(places));
}

/** The values an option starts at: its minimum, which is always known. */
export function defaultValues(option: RollOption): number[] {
  return option.grants.map((g) => g.min);
}

/**
 * Turn one slot's rolls into effects the aggregator can treat like any other.
 *
 * `sign` is applied here rather than asked of the player: a roll described
 * as "physical damage reduced 5%" is stored against `physical_damage_received`
 * as -5, so it stacks with items that word it the other way round. The
 * player types the magnitude they see on their item.
 */
export function rollEffects(
  table: RollTable, picks: Record<string, RollPick> | undefined,
): Effect[] {
  if (!picks) return [];
  const out: Effect[] = [];

  for (const roll of table.rolls) {
    const pick = picks[roll.key];
    const option = optionOf(table, roll.key, pick?.option ?? null);
    if (!option || !pick) continue;

    option.grants.forEach((grant, i) => {
      const magnitude = clampRoll(grant, pick.values[i] ?? grant.min);
      const value = magnitude * (grant.sign ?? 1);
      const unit = grant.unit ?? null;
      const shown = `${value >= 0 ? '+' : ''}${value}${unit ?? ''}`;

      if (grant.skill) {
        // Totalled against the named skill, the same as a skill modifier
        // on the item itself. With no skill typed in there is nothing to
        // total against, so it stays in the uncounted list with its label.
        const skill = (grant.skill_name ?? pick.skill)?.trim();
        const metric = grant.metric ?? 'damage';
        out.push(skill ? {
          text: `${skill} ${metric} ${shown}`,
          stat: `${skill} ${metric}`, value, unit, parsed: true,
          stat_ids: [], stat_keys: [],
          skill, skill_metric: metric, skills: [skill],
        } : {
          text: `${option.label} ${shown}`,
          parsed: false,
        });
        return;
      }

      out.push({
        text: `${option.label} ${shown}`,
        stat: option.label,
        value,
        unit,
        parsed: true,
        stat_ids: grant.stat_id === null || grant.stat_id === undefined
          ? [] : [grant.stat_id],
        stat_keys: grant.stat ? [grant.stat] : [],
      });
    });
  }

  return out;
}

/** A one-line summary of a slot's rolls, for the tooltip and the slot card. */
export function rollSummary(
  table: RollTable, picks: Record<string, RollPick> | undefined,
): string[] {
  return rollEffects(table, picks).map((e) => e.text);
}

/**
 * Keep only the rolls a table still recognises, with their values re-clamped.
 *
 * Used when a saved build is loaded and when a slot's item changes. Both
 * face the same problem: the picks were made against a table that may no
 * longer apply -- the tables are hand-written and expected to change, and
 * the new item may be gated out of rolling at all. Values are re-clamped
 * rather than trusted, because a range can tighten as it is verified.
 */
export function reconcileRolls(
  saved: Record<string, RollPick> | undefined, table: RollTable | null,
): Record<string, RollPick> {
  const out: Record<string, RollPick> = {};
  if (!table || !saved) return out;

  for (const roll of table.rolls) {
    const pick = saved[roll.key];
    const option = optionOf(table, roll.key, pick?.option ?? null);
    if (!option || !pick) continue;
    const fallback = defaultValues(option);
    out[roll.key] = {
      option: option.key,
      values: option.grants.map(
        (g, i) => clampRoll(g, pick.values?.[i] ?? fallback[i])),
      ...(pick.skill ? { skill: pick.skill } : {}),
    };
  }
  return out;
}

/** How many of this slot's rolls the player has filled in. */
export function rollsFilled(
  table: RollTable, picks: Record<string, RollPick> | undefined,
): number {
  if (!picks) return 0;
  return table.rolls.filter((r) => picks[r.key]?.option).length;
}
