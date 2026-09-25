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
  /**
   * The skills this playstyle deals its damage with, and how each scales off
   * base stats, read from the skill descriptions at max level: Full Moon is
   * "250 +50% per level +8% per AGI", so base 500 and { agi: 8 }. Feeds the
   * skill-ratio link of a damage chain (`skill_ratio_phys` / `_magic`), so a
   * point of AGI counts as the damage it adds, not only as AGI.
   */
  scaling?: { kind: 'physical' | 'magic'; skills: SkillScaling[] };
}

/** One skill's damage ratio: `base`% plus `per[stat]`% per point of that stat. */
export interface SkillScaling {
  skill: string;
  /** Which damage line, where there are several: "Explosion" for Dragon Omamori. */
  part?: string;
  base: number;
  per: Partial<Record<keyof BaseStats, number>>;
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
 * penetration at 25 is close to a must for any damage build -- which keeps
 * that target: short until the build reaches it, and a floor, not the
 * build's own figure, once it is past. Every goal is open: its target is a
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
      // A target the file gives is the line that matters, above or below it:
      // penetration at 55 that falls to 34 is still past 25, and holding it
      // at 55 called every trade for melee cards a broken goal.
      goal.target = g.target === undefined ? now : g.target;
      return goal;
    });
}

/**
 * A skill's damage scaling, read off its description at max level: the line
 * "Damage is 200+20% per level +5% per Agi." at level 5 is base 300 and
 * { agi: 5 }. `part` picks another line ("Explosion: 200 +50% per level").
 *
 * Reads the wordings the server's descriptions use: a stat shared ("+1% per
 * DEX and STR", "+1% per VIT/STR"), a second clause ("+2% per Str and 2% per
 * Dex"), no base ("80% per level"), and "10% ATK per level". Null when the
 * line names no base stat -- a skill that does not scale off one.
 */
export function scalingFromDescription(
  desc: string, maxLevel: number, part?: string,
): { part?: string; base: number; per: SkillScaling['per'] } | null {
  for (const raw of desc.split('\n')) {
    const line = raw.trim();
    const head = /^([\w ]*?)(?: is|:)\s*/i.exec(line);
    if (!head) continue;
    const name = head[1].trim();
    if (part ? name.toLowerCase() !== part.toLowerCase() : !/damage$/i.test(name)) continue;
    const rest = line.slice(head[0].length);
    const both = /^(\d+)\s*%?\s*\+\s*(\d+)\s*%\s*(?:atk\s*)?per level/i.exec(rest);
    const levelOnly = /^(\d+)\s*%\s*(?:atk\s*)?per level/i.exec(rest);
    const baseOnly = /^(\d+)\s*%?\s*\+/.exec(rest);
    let base = 0;
    let perLevel = 0;
    if (both) { base = Number(both[1]); perLevel = Number(both[2]); }
    else if (levelOnly) perLevel = Number(levelOnly[1]);
    else if (baseOnly) base = Number(baseOnly[1]);
    else continue;
    const per: SkillScaling['per'] = {};
    const stats = /(?:\+|\band)\s*(\d+)\s*%\s*per\s+(str|agi|vit|int|dex|luk)\b(?:\s*(?:\/|and)\s*(str|agi|vit|int|dex|luk)\b)?/gi;
    const read = (text: string, add: boolean) => {
      for (const m of text.matchAll(stats)) {
        for (const s of [m[2], m[3]]) {
          const key = s?.toLowerCase() as keyof BaseStats | undefined;
          if (!key) continue;
          if (per[key] === undefined) per[key] = Number(m[1]);
          else if (add) per[key] = per[key]! + Number(m[1]);
        }
      }
    };
    read(rest, false);
    // "Combo Ready adds +1% per DEX." -- a Satsujin's rotation hands Combo
    // Ready out every Full Moon, so it is part of how the skill scales.
    for (const other of desc.split('\n')) {
      if (/^combo ready adds/i.test(other.trim())) read(other, true);
    }
    if (Object.keys(per).length === 0) continue;
    return { ...(part ? { part: name } : {}), base: base + perLevel * maxLevel, per };
  }
  return null;
}
