/**
 * Starting goals for a class, for a player who has none yet.
 *
 * Hand-maintained in data/class-goals.json: per class, a few playstyles,
 * each an ordered list of goals with no targets. A new player rarely knows
 * which of a class's builds they are on, but their base stats usually do --
 * a Satsujin with more STR than INT is not casting -- so the playstyles are
 * ranked by how well they fit the points already spent, and the best fit is
 * the one offered first.
 */

import { goalMetrics, measure, priorityWeight } from './suggest.ts';
import {
  BASE_STAT_KEYS, BASE_STAT_MIN,
  type BaseStats, type Build, type Dataset, type Goal, type Totals,
} from './types.ts';

export interface Playstyle {
  name: string;
  /** "from play", "stated", "guess" or "weak guess": how far to trust it. */
  confidence: string;
  /** Why these goals, in the skills' own terms. */
  basis: string;
  /**
   * How much each point spent in a base stat says "this build". Absent means
   * the playstyle's own base-stat goals, ranked -- see `playstyleLeans`.
   */
  leans?: Partial<Record<keyof BaseStats, number>>;
  /**
   * In priority order, like the Goals panel. A `target` is a number worth
   * reaching whatever the build has now -- 25 penetration -- and is kept
   * only while the build is short of it; a `cap` is where more stops
   * counting (penetration, 70).
   */
  goals: (Omit<Goal, 'target'> & { target?: number })[];
}

/** data/class-goals.json's `presets`: an empty list is a class with no combat. */
export type ClassGoals = Record<string, Playstyle[]>;

/**
 * The weight each base stat carries towards this playstyle.
 *
 * Read off the goals when the file does not say: a base stat the playstyle
 * aims for is one its players put points in, and the higher it ranks the more
 * it says. Written out where the goals alone would misread a build -- a
 * Satsujin's melee side takes STR as well as the AGI it lists.
 */
export function playstyleLeans(style: Playstyle): Partial<Record<keyof BaseStats, number>> {
  if (style.leans) return style.leans;
  const out: Partial<Record<keyof BaseStats, number>> = {};
  let rank = 0;
  for (const g of style.goals) {
    const key = g.key as keyof BaseStats;
    if (g.column !== 'total' || !BASE_STAT_KEYS.includes(key) || key in out) continue;
    out[key] = priorityWeight(rank++);
  }
  return out;
}

/**
 * The class's playstyles, best fit for these base stats first.
 *
 * `fit` is the points spent beyond the minimum, weighed by each stat's lean.
 * Ties keep the file's order, so a character with nothing spent yet -- every
 * fit 0 -- is offered the playstyle listed first, which is the default.
 */
export function rankPlaystyles(
  styles: Playstyle[], stats: BaseStats,
): { style: Playstyle; fit: number }[] {
  return styles
    .map((style, i) => {
      let fit = 0;
      for (const [key, lean] of Object.entries(playstyleLeans(style))) {
        const spent = Math.max(0, (stats[key as keyof BaseStats] ?? BASE_STAT_MIN) - BASE_STAT_MIN);
        fit += (lean ?? 0) * spent;
      }
      return { style, fit, i };
    })
    .sort((a, b) => b.fit - a.fit || a.i - b.i)
    .map(({ style, fit }) => ({ style, fit }));
}

/**
 * A playstyle as goals, each starting where the build already is.
 *
 * Nobody chose the numbers, so none are invented: a goal reads as met, and
 * the planner looks for upgrades along the playstyle's priorities rather
 * than chasing a target the player never set. Rounded towards "met", as
 * `goalsFromBuild` does. The exception is a goal the file gives a target --
 * penetration at 25 is close to a must for any damage build -- which starts
 * short until the build reaches it. Every goal is open: its target is a
 * starting line, not a point past which the stat stops mattering, so more
 * keeps counting in full up to the goal's cap. A goal on a metric this dataset no
 * longer offers is left out rather than added as a row nothing can move.
 */
export function goalsFromPlaystyle(
  style: Playstyle, build: Build, totals: Totals, data: Dataset,
): Goal[] {
  const offered = new Set(goalMetrics(data).map((m) => `${m.key}:${m.column}`));
  return style.goals
    .filter((g) => offered.has(`${g.key}:${g.column}`))
    .map((g) => {
      const goal: Goal = { ...g, target: 0, open: true };
      const value = measure(goal, totals, build, data);
      const now = (g.atMost ? Math.ceil(value * 100 - 1e-9) : Math.floor(value * 100 + 1e-9)) / 100;
      goal.target = g.target === undefined ? now
        : g.atMost ? Math.min(g.target, now) : Math.max(g.target, now);
      return goal;
    });
}
