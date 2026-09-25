import type { BaseStats, StatTotal } from './types.ts';

/**
 * Values the character sheet works out rather than reads off an item.
 *
 * None of this is in the dataset -- the server's formulas are not published
 * anywhere the crawler can reach, so each one here is a stated assumption.
 * They are collected in this file, and each carries its formula as text, so
 * the planner can show its working and a wrong one is a single-line fix
 * rather than a hunt through the aggregator.
 */
export interface DerivedStat {
  key: string;
  label: string;
  /** What the formula gives, before any equipment. */
  base: number;
  /** Flat equipment bonuses to the same stat. */
  flat: number;
  /**
   * Percentage equipment bonuses, applied after the flat ones. For a stat
   * whose percents compound this is the combined figure, not their sum.
   */
  percent: number;
  /** The separate percents, when they compound rather than add. */
  percentParts?: number[];
  /** Anything the planner cannot model yet -- skills, buffs -- typed in. */
  manual: number;
  /** The final figure: (base + flat) scaled by percent, then plus manual. */
  total: number;
  /** The formula as written, shown in the UI so the number is checkable. */
  formula: string;
  /** What the manual box is for on this stat, shown as its tooltip. */
  manualHint?: string;
  /** False until someone has confirmed it against the live server. */
  verified: boolean;
}

/**
 * Combine a derived base with what the gear adds.
 *
 * Flat first, then percent on the sum -- the order Ragnarok applies them,
 * and the reason the two are kept in separate columns everywhere else. A
 * percentage applied to the base alone, or added into the flat pool, gives a
 * different number and would not match the character window.
 *
 * Floored, because the game shows flee as a whole number. That is an
 * assumption like the formulas themselves.
 */
export function combine(base: number, flat: number, percent: number): number {
  return Math.floor((base + flat) * (1 + percent / 100));
}

/**
 * Flee from AGI: one per point, plus one more for every whole ten.
 *
 * The step is whole: 99 AGI is 99 + 9, not 99 + 9.9. Nine points short of a
 * step are worth one flee each and no more, which is the kind of thing that
 * makes a planner disagree with the character window by exactly one.
 */
export function fleeFromAgi(agi: number): number {
  return agi + Math.floor(agi / 10);
}

/**
 * Status ATK, the same shape as flee from AGI: one per point, plus one more
 * for every whole ten. STR for melee, DEX for ranged. From the project owner,
 * who confirms the steps count the total with equipment folded in.
 */
export function statusAtk(stat: number): number {
  return stat + Math.floor(stat / 10);
}

/**
 * Base flee: a flat 100, the base level, and AGI with its per-ten step.
 *
 * Measured in game on a naked character at base level 134 with 70 flee from
 * two maxed passives, which the percent does not touch:
 *
 *   99 AGI -> 412      100 + 134 + 99 + 9  + 70
 *   100 AGI -> 414     100 + 134 + 100 + 10 + 70
 *   110 AGI -> 425     100 + 134 + 110 + 11 + 70
 *
 * Three points, exact on all three, and they pin both halves: the deltas
 * (+2 for one point of AGI, +13 for eleven) only fit a step of one per ten,
 * and the constant then has to be 100 + level rather than level x2.
 *
 * Both were wrong before, in the same direction, which is why the planner
 * read 52 high at level 134: level x2 is 34 too many and a step of three is
 * another 18.
 *
 * `agi` is the total with equipment folded in, not the points column. The
 * readings above are what settle it: base stat points stop at 99, so the
 * "99+1" and "99+11" they were taken at can only be bonus AGI, and flee
 * moved with it -- by two for one point of bonus AGI, which is the raw
 * point plus the ten-step it crossed.
 *
 * The one earlier reading agrees once read this way. At level 132 with 99
 * points, +40 AGI of gear, +16% Total Flee and the same +70 of skills, the
 * reported 531 wants 14 flat flee out of the equipment, which is an
 * ordinary amount for the pieces involved. Reading the points column
 * instead would need 58, which is not.
 *
 * LUK adds one more per whole ten (project owner, later). The readings above
 * were at low LUK, where that is nothing.
 */
export function baseFlee(baseLevel: number, agi: number, luk = 0): number {
  return 100 + baseLevel + fleeFromAgi(agi) + fleeFromLuk(luk);
}

/**
 * Several percentages applied one after another, as one percentage.
 *
 * +6%, +5% and +5% compound to +16.865%, not +16%. Nothing is floored
 * between the steps -- flooring after each one reads two low on the build
 * this was measured against.
 */
export function compoundPercent(parts: number[]): number {
  return (parts.reduce((acc, p) => acc * (1 + p / 100), 1) - 1) * 100;
}

/**
 * Effective pierce, in percent, from the DEF Penetration stat.
 *
 * Not one to one: each point is worth less than the one before, and the
 * curve only reaches 100% at 100 penetration. Measured in the character
 * window, and exact at all five readings once floored:
 *
 *   5 -> 14    15 -> 38    42 -> 80    47 -> 85    53 -> 89
 *
 * which is the complement cubed -- the defence left over is what one point
 * in a hundred leaves, three times over.
 *
 * Unfloored, so a chart can draw the curve; `Math.floor` it for the figure
 * the game shows.
 */
export function effectivePierce(pen: number): number {
  const p = Math.min(100, Math.max(0, pen));
  return 100 * (1 - (1 - p / 100) ** 3);
}

/**
 * The share of a hit that gets through a monster's hard DEF, 0 to 1.
 *
 * Renewal's formula, which this server keeps: damage x (4000 + DEF) /
 * (4000 + DEF x 10). Pierce takes its share of the DEF away first. So 700
 * DEF lets 43% through with no pierce, and 85% at 89% pierce -- and against
 * a monster with no DEF, penetration is worth nothing at all.
 *
 * Soft DEF (the VIT part, subtracted afterwards) is left out: penetration
 * does not touch it, and it is small beside hard DEF on the monsters where
 * penetration matters.
 */
export function defMultiplier(def: number, pierce: number): number {
  const d = Math.max(0, def) * (1 - Math.min(100, Math.max(0, pierce)) / 100);
  return (4000 + d) / (4000 + d * 10);
}

/**
 * The same for magic: renewal's damage x (1000 + MDEF) / (1000 + MDEF x 10).
 *
 * A quarter of the constant, so MDEF bites far harder than DEF does at the
 * same figure -- 700 MDEF lets 21% of a spell through, against 43% for a
 * hit on 700 DEF.
 */
export function mdefMultiplier(mdef: number, pierce: number): number {
  const d = Math.max(0, mdef) * (1 - Math.min(100, Math.max(0, pierce)) / 100);
  return (1000 + d) / (1000 + d * 10);
}

interface Formula {
  key: string;
  label: string;
  formula: string;
  verified: boolean;
  manualHint?: string;
  /**
   * True when each percentage source multiplies the running figure rather
   * than being summed with the others first.
   */
  compounds?: boolean;
  /**
   * The stats the formula reads besides its own gear column, so a goal on
   * the total knows what else moves it: flee from AGI.
   */
  inputs?: string[];
  /**
   * `stats` is the points column; `stat` reads a finished total with
   * equipment folded in. Which one a formula uses is part of the formula,
   * and the difference is large, so both are handed over rather than one
   * being assumed.
   */
  compute: (
    baseLevel: number, stats: BaseStats, stat: (key: string) => number,
  ) => number;
}

export const FORMULAS: Formula[] = [
  {
    key: 'flee',
    label: 'Flee',
    formula: '100 + base level + total AGI + 1 per 10 total AGI + 1 per 10 total LUK',
    // The AGI half is measured; the LUK half is the project owner's word.
    verified: true,
    // Measured at base level 136, 152 AGI, +16% from the three Maiden of
    // Time cards and +70 from skills: 560, 566 and 572 in game across three
    // gear states. Compounding matches all three; summing to 16% reads
    // 3-4 low on each.
    compounds: true,
    inputs: ['agi', 'luk'],
    manualHint: 'Flee from skills — for example Shadow Mastery (+3/level) '
      + 'and Improve Dodge (+4/level), so +70 with both maxed.',
    // The total, so AGI off equipment counts -- see baseFlee. This is the
    // one formula where the two readings differ by a lot, which is why
    // `stat` is handed over at all.
    compute: (level, _stats, stat) => baseFlee(level, stat('agi'), stat('luk')),
  },
  {
    key: 'crit_rate',
    label: 'Critical Rate',
    formula: '2 per total LUK',
    verified: false,
    inputs: ['luk'],
    manualHint: 'Critical Rate from skills and buffs.',
    compute: (_level, _stats, stat) => critFromLuk(stat('luk')),
  },
];

/**
 * LUK's share of critical hits: +2 Critical Rate and +1% Critical Damage a
 * point, counting LUK from any source. From the project owner, not yet
 * measured. So 100 LUK is 200 crit, which dwarfs the +3 to +15 on gear.
 */
export function critFromLuk(luk: number): number {
  return 2 * Math.max(0, luk);
}

export function critDamageFromLuk(luk: number): number {
  return Math.max(0, luk);
}

/** LUK's status ATK, melee and ranged alike: one per whole three. From the project owner. */
export function statusAtkFromLuk(luk: number): number {
  return Math.floor(Math.max(0, luk) / 3);
}

/** LUK's flee: one per whole ten. From the project owner, not yet measured. */
export function fleeFromLuk(luk: number): number {
  return Math.floor(Math.max(0, luk) / 10);
}

/**
 * Every derived stat, with equipment folded in.
 *
 * `gear` looks up the aggregated totals for a stat key; it returns undefined
 * for stats nothing has touched.
 */
export function derivedStats(
  baseLevel: number,
  stats: BaseStats,
  gear: (key: string) => StatTotal | undefined,
  manual: Record<string, number> = {},
): DerivedStat[] {
  // Available to any formula that wants the figure with equipment in it.
  // Flee does not -- see baseFlee -- but the two readings differ by a lot,
  // so the choice stays visible at the call site rather than being baked in.
  const statTotal = (key: string): number => {
    const points = (stats as unknown as Record<string, number>)[key] ?? 0;
    const total = gear(key);
    return combine(points, total?.flat ?? 0, total?.percent ?? 0);
  };

  return FORMULAS.map((f) => {
    const base = f.compute(baseLevel, stats, statTotal);
    const total = gear(f.key);
    const flat = total?.flat ?? 0;
    const parts = (total?.sources ?? []).filter((s) => s.unit === '%').map((s) => s.value);
    const compounded = f.compounds && parts.length > 1;
    const percent = compounded ? compoundPercent(parts) : total?.percent ?? 0;
    const extra = manual[f.key] ?? 0;
    return {
      key: f.key,
      label: f.label,
      base,
      flat,
      percent,
      ...(compounded ? { percentParts: parts } : {}),
      manual: extra,
      // The manual box sits outside the percent: skill flee is added to the
      // finished figure rather than scaled by a Total Flee bonus. Gear flat
      // is still inside it -- see combine.
      total: combine(base, flat, percent) + extra,
      formula: f.formula,
      manualHint: f.manualHint,
      verified: f.verified,
    };
  });
}
