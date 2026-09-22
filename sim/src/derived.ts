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
  /** Percentage equipment bonuses, applied after the flat ones. */
  percent: number;
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
 * Flee from AGI: one per point, plus three more for every whole ten.
 *
 * The step is whole: 99 AGI is 99 + 27, not 99 + 29.7. Nine points short of a
 * step are worth one flee each and no more, which is the kind of thing that
 * makes a planner disagree with the character window by exactly three.
 */
export function fleeFromAgi(agi: number): number {
  return agi + Math.floor(agi / 10) * 3;
}

/**
 * Base flee, as stated by the server owner.
 *
 * `agi` is the points on the character sheet, not the total with equipment.
 * That reading is what the one reported figure supports: at level 132 with
 * 99 points, +40 AGI from gear, +16% Total Flee from the Maiden of Time set
 * and +70 flee from two maxed skills that the percent does not touch, the
 * reported 531 needs 461 out of the percent, so a pre-percent subtotal of
 * 398. The points column gives 264 + 126 = 390, leaving 8 flat flee to come
 * from equipment. Reading the *total* AGI instead gives 442 before the
 * percent and 582 after the skills are added, far past the target with no
 * gear flee counted at all, so it cannot be what the server does.
 *
 * Still unverified: one data point cannot separate this from a formula that
 * happens to agree at these numbers.
 */
export function baseFlee(baseLevel: number, agi: number): number {
  return baseLevel * 2 + fleeFromAgi(agi);
}

interface Formula {
  key: string;
  label: string;
  formula: string;
  verified: boolean;
  manualHint?: string;
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
    formula: 'base level x2 + AGI + 3 per 10 AGI',
    verified: false,
    manualHint: 'Flee from skills — for example Shadow Mastery (+3/level) '
      + 'and Improve Dodge (+4/level), so +70 with both maxed.',
    compute: (level, stats) => baseFlee(level, stats.agi),
  },
];

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
    const percent = total?.percent ?? 0;
    const extra = manual[f.key] ?? 0;
    return {
      key: f.key,
      label: f.label,
      base,
      flat,
      percent,
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
