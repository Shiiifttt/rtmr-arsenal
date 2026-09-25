import { coveredBy, isOffhandWeapon, isRefineable, SLOTS } from './slots.ts';
import { rollEffects, rollTableFor } from './rolls.ts';
import type {
  BaseStats, Build, Dataset, Effect, ElementClaim, Item, RefineGroup,
  Requirement, StatTotal, Totals,
} from './types.ts';

import { BASE_LEVEL_DEFAULT, BASE_STAT_KEYS, defaultBaseStats } from './types.ts';
import { derivedStats } from './derived.ts';

/** Does the character sheet satisfy this gate? */
export function meetsRequirement(
  req: Requirement, baseStats: BaseStats, baseLevel: number,
): boolean {
  if (req.type === 'base_level') return baseLevel >= req.min;
  const have = baseStats[req.stat.toLowerCase() as keyof BaseStats] ?? 0;
  if (req.min !== undefined && have < req.min) return false;
  if (req.max !== undefined && have > req.max) return false;
  return true;
}

export function describeRequirement(
  req: Requirement, baseStats: BaseStats, baseLevel: number,
): string {
  if (req.type === 'base_level') {
    return `needs base level ${req.min} (have ${baseLevel})`;
  }
  const have = baseStats[req.stat.toLowerCase() as keyof BaseStats] ?? 0;
  if (req.min !== undefined && req.max !== undefined) {
    return `needs base ${req.stat} ${req.min}-${req.max} (have ${have})`;
  }
  if (req.max !== undefined) {
    return `needs base ${req.stat} at most ${req.max} (have ${have})`;
  }
  return `needs base ${req.stat} ${req.min} (have ${have})`;
}

/**
 * Add a build up into stat totals.
 *
 * Two rules keep the result honest:
 *
 * 1. **Flat and percent are never mixed.** "DEF +50" and "Total DEF +10%"
 *    are different numbers with different stacking, so each stat carries
 *    both a flat and a percent running total and the UI shows them apart.
 *
 * 2. **Anything that cannot be added up is reported, not dropped.** A
 *    per-skill modifier, a conditional block, or scaling off a base stat
 *    this sheet does not model all land in `uncounted` with the reason.
 *    Quietly discarding them would make the totals look complete when they
 *    are not.
 */
export function aggregate(build: Build, data: Dataset): Totals {
  const byStat = new Map<number, StatTotal>();
  const skills: Totals['skills'] = new Map();
  const uncounted: Totals['uncounted'] = [];
  const base = build.baseStats ?? defaultBaseStats();
  const level = build.baseLevel ?? BASE_LEVEL_DEFAULT;
  const elementClaims: ElementClaim[] = [];

  // "ATK +1 every 20 flee" cannot be answered until everything else is in,
  // so these are set aside and applied in a second pass below.
  const deferred: {
    eff: Effect; label: string; multiplier: number; halved: Halving;
  }[] = [];

  const rulesById = new Map(data.stats.map((s) => [s.id, s]));
  const ruleFor = (statId: number) => rulesById.get(statId);

  // Set while walking a weapon dual-wielded in the off hand: its race and
  // size damage modifiers count at half, and so does Critical Damage on the
  // cards in it. Everything else on it is whole.
  let halving: Halving = 'none';
  const scaleFor = (statId: number, halved: Halving) => {
    if (halved === 'none') return 1;
    const rule = ruleFor(statId);
    if (HALVED_OFFHAND.has(rule?.category ?? '')) return 0.5;
    return halved === 'card' && HALVED_OFFHAND_CARDS.has(rule?.key ?? '') ? 0.5 : 1;
  };

  const add = (eff: Effect, label: string, multiplier = 1) => {
    // An element override is a property, not a quantity. Collect the claim
    // and let the first one win once everything has been walked.
    if (eff.sets_element) {
      elementClaims.push({ element: eff.sets_element, source: label, applied: false });
      return;
    }
    if (eff.requires && !meetsRequirement(eff.requires, base, level)) {
      uncounted.push({
        label, text: eff.text,
        reason: describeRequirement(eff.requires, base, level),
      });
      return;
    }
    if (!eff.parsed || eff.value === undefined) {
      uncounted.push({ label, text: eff.text, reason: 'not machine-readable' });
      return;
    }
    if (eff.per_stat) {
      deferred.push({ eff, label, multiplier, halved: halving });
      return;
    }
    if (eff.per_base_stat) {
      // "+1 per 10 base STR" counts whole steps of the character's own
      // points. With the sheet left at zero there is nothing to scale, so
      // the effect is reported rather than silently counted as nothing.
      const { per, stat } = eff.per_base_stat;
      const points = base[stat.toLowerCase() as keyof BaseStats] ?? 0;
      const steps = Math.floor(points / per);
      if (steps <= 0) {
        // Below the first step it contributes nothing. Say so rather than
        // adding a zero, so the panel does not imply it is already counted.
        uncounted.push({
          label, text: eff.text,
          reason: `needs ${per} base ${stat} (have ${points})`,
        });
        return;
      }
      multiplier *= steps;
    }
    if ((!eff.stat_ids || eff.stat_ids.length === 0) && eff.skills?.length && eff.skill_metric) {
      // A skill modifier: totalled against the skill, never a global stat.
      const value = eff.value * multiplier;
      if (value === 0) return;
      for (const skill of eff.skills) {
        const key = skillKey(skill, eff.skill_metric);
        let total = skills.get(key);
        if (!total) {
          total = { skill, metric: eff.skill_metric, flat: 0, percent: 0,
            unit: eff.unit === '%' ? null : eff.unit ?? null, sources: [] };
          skills.set(key, total);
        }
        // Two sources of "Auto Guard Lv 10" is still level 10.
        const max = eff.skill_metric === 'level';
        if (eff.unit === '%') total.percent = max ? Math.max(total.percent, value) : total.percent + value;
        else total.flat = max ? Math.max(total.flat, value) : total.flat + value;
        total.sources.push({ label, value, unit: eff.unit ?? null });
      }
      return;
    }
    if (!eff.stat_ids || eff.stat_ids.length === 0) {
      uncounted.push({
        label, text: eff.text,
        reason: eff.skill ? `modifies the ${eff.skill} skill` : 'no stat mapping',
      });
      return;
    }
    if (eff.value * multiplier === 0) return;
    for (const statId of eff.stat_ids) {
      const scale = scaleFor(statId, halving);
      const value = eff.value * multiplier * scale;
      let total = byStat.get(statId);
      if (!total) {
        total = { statId, flat: 0, percent: 0, sources: [] };
        byStat.set(statId, total);
      }
      // A skill level is not cumulative: two sources of Double Attack Lv 5
      // is still Lv 5, not Lv 10. Adding them would overstate damage, so
      // the stat carries its own combining rule in the registry.
      const rule = ruleFor(statId);
      if (eff.unit === '%') {
        total.percent = rule?.combine === 'max'
          ? Math.max(total.percent, value) : total.percent + value;
      } else {
        total.flat = rule?.combine === 'max'
          ? Math.max(total.flat, value) : total.flat + value;
      }
      total.sources.push({
        label: scale === 1 ? label : `${label} (off-hand, half)`,
        value, unit: eff.unit ?? null,
      });
    }
  };

  const addAll = (effects: Effect[] | undefined, label: string, mult = 1) => {
    for (const eff of effects ?? []) add(eff, label, mult);
  };

  /**
   * Effects that may carry their own inline scaling: a gated block's
   * "ASPD +1% per refine", or a set bonus's "Max HP +2% per total set
   * refine". The parser leaves those where the block is, so the refine they
   * count is applied here -- otherwise they would add once, as if at +1.
   * Below the first step they contribute nothing, and say so.
   */
  const addScaling = (effects: Effect[] | undefined, label: string, refine: number) => {
    for (const eff of effects ?? []) {
      const per = eff.per_set_refine ?? eff.per_refine;
      if (per === undefined) { add(eff, label); continue; }
      const steps = Math.floor(refine / per);
      if (steps > 0) add(eff, label, steps);
      else uncounted.push({ label, text: eff.text, reason: `needs refine ${per} (have ${refine})` });
    }
  };

  /** "Per 4 Refines:" at +11 applies twice, not eleven times. */
  const applyScaling = (groups: RefineGroup[], refine: number, label: string) => {
    for (const group of groups) {
      const per = group.per ?? 1;
      const steps = Math.floor(refine / per);
      if (steps > 0) addAll(group.effects, label, steps);
    }
  };

  const applyThresholds = (groups: RefineGroup[], refine: number, label: string) => {
    for (const group of groups) {
      for (const at of group.at ?? []) {
        if (refine >= at) addAll(group.effects, label);
      }
    }
  };

  /**
   * A conditional block only counts when the sheet can answer its gate.
   *
   * "Base STR 99:" is answerable and applies the moment the points are
   * there. "With Bullhorn Armor:" is not, so it stays listed rather than
   * being guessed at in either direction.
   */
  const applyConditionals = (item: Item, label: string, refine: number) => {
    for (const cond of item.conditional ?? []) {
      if (cond.per_stat_count) {
        // "For each base stat over 98: ATK+2%" -- the multiplier is how many
        // of the six clear the bar, so a sheet with three at 99 gets +6%.
        const { min } = cond.per_stat_count;
        const qualifying = BASE_STAT_KEYS.filter((k) => (base[k] ?? 0) >= min).length;
        if (qualifying > 0) {
          addAll(cond.effects, `${label} (${qualifying} stats at ${min}+)`, qualifying);
        } else {
          for (const eff of cond.effects) {
            uncounted.push({
              label, text: eff.text,
              reason: `needs a base stat at ${min}+ (none yet)`,
            });
          }
        }
        continue;
      }
      if (cond.requires) {
        if (meetsRequirement(cond.requires, base, level)) {
          addScaling(cond.effects, `${label} (${cond.condition})`, refine);
        } else {
          for (const eff of cond.effects) {
            uncounted.push({
              label, text: eff.text,
              reason: describeRequirement(cond.requires, base, level),
            });
          }
        }
        continue;
      }
      for (const eff of cond.effects) {
        if (eff.sets_element) {
          elementClaims.push({ element: eff.sets_element, source: label, applied: false });
          continue;
        }
        uncounted.push({
          label, text: eff.text, reason: `conditional: ${cond.condition}`,
        });
      }
    }
  };

  // ---- equipped pieces ---------------------------------------------------
  const wornBySet = new Map<number, number[]>();
  const refineBySet = new Map<number, number>();

  for (const slot of SLOTS) {
    const state = build.slots[slot.key];
    if (!state?.itemId) continue;
    const item = data.items.get(state.itemId);
    if (!item) continue;
    // Taken by a headgear worn in two positions, which counts once, from
    // its own slot -- even when a screenshot recorded it in both.
    if (coveredBy(build, slot.key, data)) continue;

    const refine = isRefineable(item) ? state.refine : 0;
    const label = item.name;
    // Covers the piece, its refine, its rolls and the cards in it -- all of
    // it is carried in that hand. Set bonuses below belong to the set, not
    // the hand, and are left whole.
    const hand: Halving = isOffhandWeapon(slot, item) ? 'hand' : 'none';
    halving = hand;

    addBaseStats(item, byStat, label);
    addAll(item.effects, label);
    addAll(item.piece_bonus, label);
    applyScaling(item.refine.per_refine, refine, `${label} (refine)`);
    applyThresholds(item.refine.thresholds, refine, `${label} (refine)`);

    applyConditionals(item, label, refine);

    // The rolls this particular copy dropped with. They are kept under their
    // own label so the stat panel shows plainly which part of a number came
    // off the item as designed and which came off the dice.
    const table = rollTableFor(data.rolls, slot.key, item);
    if (table) addAll(rollEffects(table, state.rolls), `${label} (roll)`);

    for (const cardId of state.cards) {
      if (!cardId) continue;
      const card = data.items.get(cardId);
      if (!card) continue;
      halving = hand === 'hand' ? 'card' : 'none';
      addBaseStats(card, byStat, card.name);
      addAll(card.effects, card.name);
      addAll(card.piece_bonus, card.name);
      // A card has no refine of its own. "ATK+1 per 2 refines" on a card
      // counts the refine of whatever it is compounded into, so the host's
      // number is what drives it -- reading the card's own (always 0) drops
      // the bonus entirely, which is what used to happen here.
      applyScaling(card.refine.per_refine, refine, `${card.name} (${label} refine)`);
      applyThresholds(card.refine.thresholds, refine, `${card.name} (${label} refine)`);
      // A card is not refined, but it can still carry set membership.
      for (const s of card.sets) {
        push(wornBySet, s, card.id);
      }
      applyConditionals(card, card.name, refine);
    }
    halving = hand;

    for (const s of item.sets) {
      push(wornBySet, s, item.id);
      refineBySet.set(s, (refineBySet.get(s) ?? 0) + refine);
    }
  }
  halving = 'none';

  // ---- set bonuses -------------------------------------------------------
  const setProgress: Totals['setProgress'] = [];

  for (const [setIndex, wornIds] of wornBySet) {
    const set = data.sets[setIndex];
    if (!set) continue;
    const unique = [...new Set(wornIds)];
    const worn = unique.length;
    const complete = worn >= set.member_count;
    const setRefine = refineBySet.get(setIndex) ?? 0;

    setProgress.push({
      set, worn, total: set.member_count, complete, setRefine, wornIds: unique,
    });
    if (!complete) continue;

    const label = `${set.name} set`;
    // Under a set heading, even a bare "per 2 refines" means the set's
    // summed refine, so both kinds of inline scaling read setRefine.
    addScaling(set.set_bonus, label, setRefine);
    // Set scaling counts the summed refine of the whole set, which is why
    // it lives on the set record rather than on any one piece.
    applyScaling(set.set_refine.per_set_refine, setRefine, `${label} (set refine)`);
    applyThresholds(set.set_refine.thresholds, setRefine, `${label} (set refine)`);
  }

  setProgress.sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    return b.worn / b.total - a.worn / a.total;
  });

  // ---- element -----------------------------------------------------------
  // Several pieces can each claim to set the wearer's element. Only one can
  // hold, and the first claim found wins: pieces are walked in slot order,
  // then set bonuses, so the result is at least stable and inspectable
  // rather than depending on map iteration order.
  if (elementClaims.length > 0) elementClaims[0].applied = true;
  const element = elementClaims.length > 0 ? elementClaims[0].element : null;

  // Derived values are worked out last, so the gear totals they fold in are
  // already complete.
  const idByKey = new Map(data.stats.map((s) => [s.key, s.id]));
  const gear = (key: string) => {
    const id = idByKey.get(key);
    return id === undefined ? undefined : byStat.get(id);
  };

  // Caps last, so a stat that several sources push past the ceiling reports
  // the ceiling. The sources are left intact: the panel should still be able
  // to say where the surplus came from, and that it is being wasted.
  for (const total of byStat.values()) {
    const cap = ruleFor(total.statId)?.cap;
    if (cap === undefined) continue;
    total.flat = Math.min(total.flat, cap);
    total.percent = Math.min(total.percent, cap);
  }

  const derived = derivedStats(level, base, gear, build.manual);

  // ---- second pass: effects that scale off a finished total --------------
  // "ATK +1 every 20 flee" needs flee, and flee needs the gear. One pass
  // only: what these produce is deliberately NOT fed back in, because a
  // second round would make the result depend on evaluation order and two
  // such effects could chase each other upward.
  if (deferred.length > 0) {
    const derivedByKey = new Map(derived.map((d) => [d.key, d]));
    for (const { eff, label, multiplier, halved } of deferred) {
      const { per, stat } = eff.per_stat!;
      const source = derivedByKey.get(stat);
      const total = source ? source.total : gear(stat)?.flat ?? 0;
      const steps = Math.floor(total / per);
      if (steps <= 0) {
        uncounted.push({
          label, text: eff.text,
          reason: `needs ${per} ${stat} (have ${total})`,
        });
        continue;
      }
      for (const statId of eff.stat_ids ?? []) {
        const value = (eff.value ?? 0) * multiplier * steps * scaleFor(statId, halved);
        let running = byStat.get(statId);
        if (!running) {
          running = { statId, flat: 0, percent: 0, sources: [] };
          byStat.set(statId, running);
        }
        if (eff.unit === '%') running.percent += value;
        else running.flat += value;
        running.sources.push({
          label: `${label} (${steps}x from ${total} ${stat})`,
          value, unit: eff.unit ?? null,
        });
      }
    }
  }

  return { byStat, skills, uncounted, setProgress, element, elementClaims, derived };
}

/** The key a skill modifier is totalled under: "Backstab|damage". */
export function skillKey(skill: string, metric: string): string {
  return `${skill}|${metric}`;
}

/**
 * Stat categories that a dual-wielded off-hand weapon contributes at half.
 * Resistances are not among them, and neither is anything on a shield.
 */
export const HALVED_OFFHAND = new Set(['race_damage', 'size_damage']);

/**
 * Stats, by key, that count at half only from a card in an off-hand weapon:
 * the weapon's own Critical Damage stays whole. From the project owner, not
 * yet measured.
 */
export const HALVED_OFFHAND_CARDS = new Set(['crit_damage']);

/** What part of an off-hand weapon is being walked, for the halving rules. */
type Halving = 'none' | 'hand' | 'card';

/** ATK/MATK/DEF/MDEF come from columns, not from the description text. */
function addBaseStats(item: Item, byStat: Map<number, StatTotal>, label: string) {
  const pairs: [string, number][] = [
    ['atk', item.atk], ['matk', item.matk], ['def', item.def], ['mdef', item.mdef],
  ];
  for (const [key, value] of pairs) {
    if (!value) continue;
    const statId = BASE_STAT_IDS[key];
    if (statId === undefined) continue;
    let total = byStat.get(statId);
    if (!total) {
      total = { statId, flat: 0, percent: 0, sources: [] };
      byStat.set(statId, total);
    }
    total.flat += value;
    total.sources.push({ label: `${label} (base)`, value, unit: null });
  }
}

/** Filled in once the stat registry is loaded, so ids stay data-driven. */
export const BASE_STAT_IDS: Record<string, number> = {};

export function bindBaseStatIds(stats: { id: number; key: string }[]) {
  for (const s of stats) {
    if (['atk', 'matk', 'def', 'mdef'].includes(s.key)) BASE_STAT_IDS[s.key] = s.id;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
