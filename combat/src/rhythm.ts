/**
 * Rhythm: kills an hour when you fight, sit back to full, and fight again
 * (the project owner's Tomb of Kings plan, 2026-09-29) -- worked out from a
 * batch of fights instead of walking a map (tools/farm.ts), so a gear search
 * can afford it.
 *
 * One cycle is the fight, the sit that wins back the SP and HP it spent,
 * and a short walk to the next pull. Sitting regen is the server's (natural
 * SP every 1.2 s and HP every 2 s, doubled sitting; skill SP regen every 4 s)
 * plus the class's own out-of-combat regen (Knight's Regen, King's Fortress).
 * A death costs the fight, a return and a rebuff (DEATH_S). Targets are
 * weighted by how many of them spawn.
 */
import { TUNE, walkCellMs } from './formulas.ts';
import type { Kit } from './engine.ts';
import type { Fighter } from './model.ts';
import type { Summary } from './sim.ts';

/** Walking to the next pull, seconds at the standing pace (tools/farm.ts on lost_dun03: ~5% of the hour at ~130 kills). */
export const WALK_S = 1.5;
/** The walk to the next pull at this build's pace: move speed (and its penalties) counts. */
export const walkFor = (f: Fighter) => (WALK_S * walkCellMs(f)) / TUNE.walkCellMs;
/** A death: the walk back and the rebuff, seconds (farm.ts --death-ms default). */
export const DEATH_S = 30;
/**
 * The longest sit, seconds. With regen near nothing (Dry Goblin Card's HP
 * Regen -50% on a low-VIT build) the sit ran to ~10^9 s: kills and deaths an
 * hour both fell to zero and a build that never fights again outscored one
 * that sometimes dies (a Night Raven search took it, 2026-10-01). A player
 * drinks or moves on long before. GUESS: 120 s, a fight's time limit.
 */
export const MAX_SIT_S = 120;
/** Seconds sitting to win back what a fight spent, at most MAX_SIT_S. */
export const sitFor = (sp: number, hp: number, regen: { sp: number; hp: number }) =>
  Math.min(MAX_SIT_S, Math.max(sp / Math.max(1e-6, regen.sp), hp / Math.max(1e-6, regen.hp)));

export interface Rhythm {
  killsPerHour: number;
  /** Seconds a cycle, and of that sitting. */
  cycleS: number;
  sitS: number;
  /** Deaths an hour. */
  deathsPerHour: number;
  /** Deaths an hour as a search scores them: those to `lossScale`'s monsters scaled (the two worst at half). */
  scoredDeathsPerHour: number;
  /** Fights given up an hour (stalemates: the monster lived out the time limit). */
  stallsPerHour: number;
  per: { name: string; weight: number; fightS: number; sitS: number; spUsed: number; hpUsed: number; loss: number }[];
}

/**
 * HP between fights comes back by healing, not sitting (the project owner,
 * 2026-10-02: "health regen is overrated stat, leech is better, or just
 * casting heal"): at least this share of Max HP a second -- a Heal or a
 * potion every few seconds. GUESS: 3%, about Orphan Heal's on a ~15k-HP
 * build; it leaves HP regen gear next to worthless, as the owner says.
 */
export const HEAL_HP_SHARE = 0.03;

/** SP and HP a second while sitting. */
export function sitRegen(f: Fighter, kit: Kit, options: Record<string, unknown>): { sp: number; hp: number } {
  const idle = kit.idleRegen?.(f, options) ?? { hpPerSec: 0, spPerSec: 0 };
  return {
    sp: (2 * f.regen.sp) / (TUNE.spRegenMs / 1000) + (f.regen.spSkill ?? 0) / (TUNE.skillRegenMs / 1000) + idle.spPerSec,
    hp: Math.max(HEAL_HP_SHARE * f.maxHp, (2 * f.regen.hp) / (TUNE.hpRegenMs / 1000) + idle.hpPerSec),
  };
}

/** lossScale: deaths to these monsters (by name) count this much in scoredDeathsPerHour (gear-search's worst two at half). */
export function rhythm(f: Fighter, kit: Kit, options: Record<string, unknown>, fights: { s: Summary; weight: number }[],
  lossScale: Map<string, number> = new Map()): Rhythm {
  const regen = sitRegen(f, kit, options);
  const walk = walkFor(f);
  let w = 0; let cycle = 0; let sit = 0; let kills = 0; let deaths = 0; let stalls = 0; let scored = 0;
  const per: Rhythm['per'] = [];
  for (const { s, weight } of fights) {
    const fightS = s.seconds;
    const plain = sitFor(s.spUsed, s.hpUsed, regen);
    const sitS = kit.recoverFor ? kit.recoverFor(f, options, { sp: s.spUsed, hp: s.hpUsed }, regen, plain, fightS + walk) : plain;
    const loss = s.losses / Math.max(1, s.iterations);
    // A cycle ends in a kill (win), a death, or a fight given up (stalemate).
    const c = fightS + s.winRate * (sitS + walk) + loss * DEATH_S + (1 - s.winRate - loss) * (sitS + walk);
    w += weight; cycle += weight * c; sit += weight * s.winRate * sitS; kills += weight * s.winRate; deaths += weight * loss; stalls += weight * Math.max(0, 1 - s.winRate - loss);
    scored += weight * loss * (lossScale.get(s.monster) ?? 1);
    per.push({ name: s.monster, weight, fightS, sitS, spUsed: s.spUsed, hpUsed: s.hpUsed, loss });
  }
  const mean = (x: number) => (w ? x / w : 0);
  const cycleS = mean(cycle);
  return {
    killsPerHour: cycleS ? (3600 * mean(kills)) / cycleS : 0,
    cycleS, sitS: mean(sit),
    deathsPerHour: cycleS ? (3600 * mean(deaths)) / cycleS : 0,
    scoredDeathsPerHour: cycleS ? (3600 * mean(scored)) / cycleS : 0,
    stallsPerHour: cycleS ? (3600 * mean(stalls)) / cycleS : 0,
    per,
  };
}
