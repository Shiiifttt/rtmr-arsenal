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
import { TUNE } from './formulas.ts';
import type { Kit } from './engine.ts';
import type { Fighter } from './model.ts';
import type { Summary } from './sim.ts';

/** Walking to the next pull, seconds (tools/farm.ts on lost_dun03: ~5% of the hour at ~130 kills). */
export const WALK_S = 1.5;
/** A death: the walk back and the rebuff, seconds (farm.ts --death-ms default). */
export const DEATH_S = 30;

export interface Rhythm {
  killsPerHour: number;
  /** Seconds a cycle, and of that sitting. */
  cycleS: number;
  sitS: number;
  /** Deaths an hour. */
  deathsPerHour: number;
  per: { name: string; weight: number; fightS: number; sitS: number; spUsed: number; hpUsed: number; loss: number }[];
}

/** SP and HP a second while sitting. */
export function sitRegen(f: Fighter, kit: Kit, options: Record<string, unknown>): { sp: number; hp: number } {
  const idle = kit.idleRegen?.(f, options) ?? { hpPerSec: 0, spPerSec: 0 };
  return {
    sp: (2 * f.regen.sp) / (TUNE.spRegenMs / 1000) + (f.regen.spSkill ?? 0) / (TUNE.skillRegenMs / 1000) + idle.spPerSec,
    hp: (2 * f.regen.hp) / (TUNE.hpRegenMs / 1000) + idle.hpPerSec,
  };
}

export function rhythm(f: Fighter, kit: Kit, options: Record<string, unknown>, fights: { s: Summary; weight: number }[]): Rhythm {
  const regen = sitRegen(f, kit, options);
  let w = 0; let cycle = 0; let sit = 0; let kills = 0; let deaths = 0;
  const per: Rhythm['per'] = [];
  for (const { s, weight } of fights) {
    const fightS = s.seconds;
    const sitS = Math.max(s.spUsed / Math.max(1e-6, regen.sp), s.hpUsed / Math.max(1e-6, regen.hp));
    const loss = s.losses / Math.max(1, s.iterations);
    // A cycle ends in a kill (win), a death, or a fight given up (stalemate).
    const c = fightS + s.winRate * (sitS + WALK_S) + loss * DEATH_S + (1 - s.winRate - loss) * (sitS + WALK_S);
    w += weight; cycle += weight * c; sit += weight * s.winRate * sitS; kills += weight * s.winRate; deaths += weight * loss;
    per.push({ name: s.monster, weight, fightS, sitS, spUsed: s.spUsed, hpUsed: s.hpUsed, loss });
  }
  const mean = (x: number) => (w ? x / w : 0);
  const cycleS = mean(cycle);
  return {
    killsPerHour: cycleS ? (3600 * mean(kills)) / cycleS : 0,
    cycleS, sitS: mean(sit),
    deathsPerHour: cycleS ? (3600 * mean(deaths)) / cycleS : 0,
    per,
  };
}
