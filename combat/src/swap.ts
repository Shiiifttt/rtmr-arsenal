/**
 * Smart swap: come prepared with spares and change them for each monster
 * (the project owner, 2026-09-26: "it's not unreasonable to come prepared
 * with several weapons or armors").
 *
 *   - Racial damage cards: whatever the build's weapon cards add against
 *     particular races (not "all races", not boss / non-boss) is aimed at
 *     the race being fought instead -- the same cards, for its race.
 *   - Racial resistance cards: the same for "resistance to <race>".
 *   - Armour element: the one the threat list says does best
 *     (advise.ts bestArmourElement), if it beats the build's own.
 *
 * It swaps like for like: it never adds a card the build does not have the
 * slot and the total for, and it does not model what the armour card being
 * replaced was giving.
 */
import { bestArmourElement } from './advise.ts';
import type { Fighter, Monster } from './model.ts';
import { raceKey } from './formulas.ts';
import type { ThreatEntry } from './threats.ts';

const GENERIC = new Set(['boss', 'non_boss', 'all_races']);

/** Move every race-specific value under `prefix` onto `race`. */
function retarget(bag: Record<string, number>, prefix: string, race: string): { bag: Record<string, number>; from: string[]; total: number } {
  const out = { ...bag };
  const from: string[] = [];
  let total = 0;
  for (const [key, v] of Object.entries(bag)) {
    if (!key.startsWith(prefix) || !v) continue;
    const r = key.slice(prefix.length);
    if (GENERIC.has(r)) continue;
    total += v;
    if (r !== race) from.push(r);
    delete out[key];
  }
  if (total) out[`${prefix}${race}`] = total;
  return { bag: out, from, total };
}

const label = (key: string) => key.replace('undead_race', 'undead').replace(/_/g, '-');

export function smartSwap(f: Fighter, m: Monster, entry: ThreatEntry | null): { f: Fighter; notes: string[] } {
  if (m.dummy) return { f, notes: [] };
  const race = raceKey(m.race);
  const notes: string[] = [];

  const phys = retarget(f.dmg, 'dmg_vs_race_', race);
  const magic = retarget(phys.bag, 'magic_vs_race_', race);
  const res = retarget(f.res, 'res_race_', race);
  let g: Fighter = { ...f, dmg: magic.bag, res: res.bag };
  if (phys.from.length) notes.push(`swap: race cards for ${m.race} (+${phys.total}% damage, was vs ${phys.from.map(label).join(', ')})`);
  if (magic.from.length) notes.push(`swap: magic race cards for ${m.race} (+${magic.total}%, was vs ${magic.from.map(label).join(', ')})`);
  if (res.from.length) notes.push(`swap: race resistance for ${m.race} (${res.total}%, was vs ${res.from.map(label).join(', ')})`);

  if (entry) {
    const el = bestArmourElement(g, m, entry);
    if (el) {
      notes.push(`swap: ${el} armour (was ${f.element})`);
      g = { ...g, element: el };
    }
  } else {
    notes.push('swap: armour element kept -- not in the threat list');
  }
  return { f: g, notes };
}
