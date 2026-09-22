import type { Effect } from './types.ts';

/**
 * One effect as a line of text.
 *
 * The parsed fields are preferred over the raw text because only they can be
 * multiplied by a refine step. Anything the crawler could not read falls back
 * to what the database said, verbatim.
 *
 * `inScaledSection` suppresses the per-refine suffix for callers that render
 * these inside a heading which already says it ("Per 4 refines").
 */
export function effectLine(eff: Effect, multiplier = 1, inScaledSection = false): string {
  if (!eff.parsed || eff.value === undefined || !eff.stat) return eff.text;
  // A flag has no number worth printing: "Unbreakable Weapon +1" is noise,
  // and multiplying it is meaningless.
  if (eff.flag) return eff.stat;
  const value = Math.round(eff.value * multiplier * 100) / 100;
  const sign = value >= 0 ? '+' : '';
  return `${eff.stat} ${sign}${value}${eff.unit ?? ''}`
    + effectQualifier(eff, inScaledSection);
}

/**
 * Stats where a smaller number is the better one. "SP Cost -10%" is a bonus,
 * "SP Cost +10%" a penalty, the opposite of how every other stat reads.
 */
export const LOWER_IS_BETTER = new Set([
  'sp_cost', 'attack_sp_cost', 'cast_time', 'variable_cast', 'fixed_cast',
  'after_cast_delay', 'cooldown', 'magic_damage_received', 'physical_damage_received',
]);

/** The same, for a skill modifier's metric: "Heal cooldown -2 s" is good. */
export const LOWER_IS_BETTER_METRICS = new Set(['cooldown', 'cast time', 'sp cost']);

export type Tone = 'good' | 'bad' | null;

/** Is this change to a stat good or bad for the wearer? */
export function statTone(statKey: string, value: number): Tone {
  if (!value) return null;
  const lower = LOWER_IS_BETTER.has(statKey);
  return (value > 0) !== lower ? 'good' : 'bad';
}

export function skillTone(metric: string, value: number): Tone {
  if (!value) return null;
  const lower = LOWER_IS_BETTER_METRICS.has(metric);
  return (value > 0) !== lower ? 'good' : 'bad';
}

/**
 * Whether one effect line reads as a bonus or a penalty, for colouring.
 *
 * Null for anything with no direction to it: unread prose, a flag, an
 * element override. A line naming several stats takes its tone from the
 * first; those groups ("HP/SP", "ATK/MATK") never mix directions.
 */
export function effectTone(eff: Effect): Tone {
  if (!eff.parsed || eff.value === undefined || eff.flag || eff.sets_element) return null;
  if (eff.stat_keys?.length) return statTone(eff.stat_keys[0], eff.value);
  if (eff.skill_metric) return skillTone(eff.skill_metric, eff.value);
  return null;
}

/**
 * The part of an effect that is not the number.
 *
 * "Every 9 base AGI gives you 1 extra AGI" parses to AGI +1, and printing
 * only that would promise a flat bonus the item does not give. Whatever
 * gates or scales the value has to travel with it -- except where a section
 * heading already says it.
 */
export function effectQualifier(eff: Effect, inScaledSection = false): string {
  const parts: string[] = [];

  if (eff.per_base_stat) {
    const { per, stat } = eff.per_base_stat;
    parts.push(per > 1 ? `per ${per} base ${stat}` : `per base ${stat}`);
  }
  if (eff.per_set_refine) {
    parts.push(eff.per_set_refine > 1
      ? `per ${eff.per_set_refine} set refines` : 'per set refine');
  }
  if (eff.per_refine && !inScaledSection) {
    parts.push(eff.per_refine > 1 ? `per ${eff.per_refine} refines` : 'per refine');
  }
  if (eff.per_stat) {
    const { per, stat } = eff.per_stat;
    parts.push(per > 1 ? `per ${per} ${stat}` : `per ${stat}`);
  }

  let out = parts.length > 0 ? ` ${parts.join(', ')}` : '';

  if (eff.requires) {
    const req = eff.requires;
    if (req.type === 'base_level') {
      out += ` (needs base level ${req.min})`;
    } else if (req.min !== undefined && req.max !== undefined) {
      out += ` (needs base ${req.stat} ${req.min}-${req.max})`;
    } else if (req.max !== undefined) {
      out += ` (needs base ${req.stat} at most ${req.max})`;
    } else {
      out += ` (needs base ${req.stat} ${req.min})`;
    }
  }
  return out;
}
