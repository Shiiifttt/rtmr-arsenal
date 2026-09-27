/**
 * The TAS: play the fight near-perfectly.
 *
 * At every moment the player is free, each usable action is tried in a
 * copy of the fight, which then plays on for `horizonMs` under the kit's
 * written rotation (`Kit.priority`) in expect mode -- no dice, every chance
 * a weight. The action whose copy comes out best is the one taken:
 *
 *   score = damage dealt - hpWeight x HP lost,  death = never,  a kill = sooner is better.
 *
 * So the rotation is only the default the TAS measures against: it will
 * reorder it, skip a filler, or hold a Kawarimi whenever the copies say so.
 * Dodging cast bars is the kit's `react`, which the rolled fight calls as
 * the bar appears; the planner cannot see a cast that has not started.
 *
 * What it does not know: the future dice. It plays on expectations, like a
 * perfect player would, not on a known seed.
 */
import { canUse, playOut, rollout, run, type Action, type Fight, type Policy } from './engine.ts';

export interface TasOptions {
  /** How far ahead each candidate is played. 6s covers a full Moon combo. */
  horizonMs: number;
  /**
   * HP lost, in damage dealt: by default, losing all your HP is worth half
   * the monster's. Higher plays safer.
   */
  hpWeight?: number;
  /**
   * SP spent, as a share of what the rotation deals per SP. SP left unspent
   * at the end of a rollout is worth this much damage later; without it the
   * planner, seeing only a few seconds, spends as if SP were free and runs
   * dry. 0.5 by default; 0 ignores SP.
   */
  spValue?: number;
}

/** Damage per SP the written rotation gets, measured once per fight. */
const perSp = new WeakMap<object, number>();
function damagePerSp(fight: Fight): number {
  const key = fight.me.spent; // one object per real fight, shared by its rollouts
  let v = perSp.get(key);
  if (v === undefined) {
    const copy = run(rollout(fight, fight.kit.priority, fight.t + 15_000));
    const sp = fight.me.sp - copy.me.sp;
    v = sp > 0 ? (fight.mob.hp - copy.mob.hp) / sp : 0;
    perSp.set(key, v);
  }
  return v;
}

export function tasPolicy(o: TasOptions): Policy {
  return (fight: Fight): Action => {
    const kit = fight.kit;
    const fallback = kit.priority(fight);
    const options = kit.actions.filter((a) => !a.reactive && canUse(fight, a));
    if (options.length <= 1) return options[0] ?? fallback;

    const hpWeight = o.hpWeight ?? 0.5 * Math.min(fight.m.hp, 1e9) / fight.f.maxHp;
    const spWeight = (o.spValue ?? 0.5) * damagePerSp(fight);
    const until = fight.t + o.horizonMs;
    let best = fallback;
    let bestScore = -Infinity;
    for (const a of options) {
      const copy = playOut(rollout(fight, kit.priority, until), a);
      let score: number;
      if (copy.result === 'loss') {
        score = -1e18 + copy.t; // dying later beats dying sooner
      } else {
        score = (fight.mob.hp - copy.mob.hp)
          - hpWeight * Math.max(0, fight.me.hp - copy.me.hp)
          - spWeight * Math.max(0, fight.me.sp - copy.me.sp);
        if (copy.result === 'win') score += 1e12 * (until - copy.t + 1);
      }
      // The written rotation wins ties.
      if (a === fallback) score += 1e-6;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  };
}

/** The rotation exactly as written, no lookahead: fast, and a baseline. */
export const priorityPolicy: Policy = (fight) => fight.kit.priority(fight);
