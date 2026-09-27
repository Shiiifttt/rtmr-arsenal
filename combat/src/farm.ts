/**
 * Farming: how much of a map a build kills in one or two buttons, rather
 * than whether it survives a boss. Speed over safety (the project owner,
 * 2026-09-28): the skills have long cooldowns, so a monster that takes a
 * third button costs a whole cooldown.
 *
 * For each monster on the chosen maps, weighted by how many spawn there,
 * the expected damage of:
 *   - one Shield Boomerang            -> killed in one button
 *   - Shield Boomerang + King's Chains -> killed in two (the gem's combo)
 *   - one Queen's Gambit              -> the pack around you cleared
 * all read through the kit's own actions on a fresh fight in expected-value
 * mode, so every gear and skill bonus the fight sim knows counts here too.
 * A hit is taken as landing (HIT against the monster's flee is not
 * weighed): the question is whether it kills when it lands.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MOB_GROUPS, REPO } from './data.ts';
import { newFight, type Kit } from './engine.ts';
import type { Fighter, Monster } from './model.ts';
import { Rng } from './rng.ts';
import { priorityPolicy } from './tas.ts';

export interface FarmTarget { m: Monster; weight: number }

interface Places {
  cols: string[]; rows: unknown[][]; mobcols: string[]; mobrows: unknown[][];
}
let places: Places | null = null;

/**
 * How many of each monster spawn on a group's maps, by name (the crawl
 * renumbers some monsters, so ids do not always match the server's), from
 * the site's place pages (data/raw/db-places.json: [monster, floor, count]).
 */
export function spawnCounts(group: string): Map<string, number> {
  places ??= JSON.parse(readFileSync(resolve(REPO, 'data/raw/db-places.json'), 'utf8')) as Places;
  const maps = new Set(MOB_GROUPS[group] ?? [group]);
  const K = (k: string) => places!.cols.indexOf(k);
  const nameOf = (i: number) => String(places!.mobrows[i][places!.mobcols.indexOf('name')]);
  const out = new Map<string, number>();
  for (const row of places.rows) {
    const codes = row[K('codes')] as string[];
    for (const [mob, floor, count] of (row[K('mobs')] ?? []) as number[][]) {
      if (!maps.has(codes[floor])) continue;
      out.set(nameOf(mob), (out.get(nameOf(mob)) ?? 0) + count);
    }
  }
  return out;
}

export interface FarmScore {
  /** Spawn-weighted shares killed by one Shield Boomerang, by it + King's Chains, by one Queen's Gambit. */
  sb: number; sbkc: number; qg: number;
  /** Spawn-weighted mean of min(1, damage / HP): how close the misses come. */
  sbReach: number; qgReach: number;
  value: number;
  per: { name: string; weight: number; hp: number; sb: number; sbkc: number; qg: number }[];
}

/** The damage one action does from a fresh fight at `counters`, expected, every hit landing. */
function actionDamage(f: Fighter, m: Monster, kit: Kit, options: Record<string, unknown>, ids: string[], counters: number): number[] {
  const sure: Fighter = { ...f, hit: 100_000 };
  const fight = newFight(sure, { ...m, flee: 0 }, kit, priorityPolicy, { seed: 1, limitMs: 60_000, options });
  fight.rng = new Rng(0, true);
  kit.prep(fight);
  fight.me.buffs.counters = { until: 1e12, stacks: counters };
  const out: number[] = [];
  for (const id of ids) {
    const before = fight.meter?.actions[id]?.damage ?? 0;
    kit.actions.find((a) => a.id === id)!.resolve(fight);
    out.push((fight.meter?.actions[id]?.damage ?? 0) - before);
  }
  return out;
}

/**
 * The farming score. value = Queen's Gambit clears + 0.6 x one-button kills
 * + 0.3 x two-button kills, plus 0.2 x how close the misses come (so a
 * search has something to climb between thresholds). counters: what you
 * hold when you open on a pack (3: a Rook's Smash).
 */
export function farmScore(f: Fighter, kit: Kit, options: Record<string, unknown>, targets: FarmTarget[], counters = 3): FarmScore {
  const per: FarmScore['per'] = [];
  let w = 0; let sb = 0; let sbkc = 0; let qg = 0; let sbReach = 0; let qgReach = 0;
  for (const { m, weight } of targets) {
    const [dSb, dKc] = actionDamage(f, m, kit, options, ['Shield Boomerang', "King's Chains"], counters);
    const [dQg] = actionDamage(f, m, kit, options, ["Queen's Gambit"], counters);
    per.push({ name: m.name, weight, hp: m.hp, sb: dSb, sbkc: dSb + dKc, qg: dQg });
    w += weight;
    if (dSb >= m.hp) sb += weight;
    if (dSb + dKc >= m.hp) sbkc += weight;
    if (dQg >= m.hp) qg += weight;
    sbReach += weight * Math.min(1, dSb / m.hp);
    qgReach += weight * Math.min(1, dQg / m.hp);
  }
  const n = (x: number) => (w ? x / w : 0);
  const s = { sb: n(sb), sbkc: n(sbkc), qg: n(qg), sbReach: n(sbReach), qgReach: n(qgReach) };
  return { ...s, value: s.qg + 0.6 * s.sb + 0.3 * s.sbkc + 0.1 * (s.sbReach + s.qgReach), per };
}
