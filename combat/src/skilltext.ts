/**
 * Numbers out of a skill tooltip.
 *
 * The server writes its skill numbers as sentences, and fairly regular ones:
 *
 *   Damage: 250 +50% per level +8% per AGI.
 *   Damage is 200+15% per level +1% per LUK
 *   Explosion: 200 +50% per level +2% per DEX.
 *   Combo Ready adds +5% per STR.
 *   Focus: +10% per level per Focus.
 *   Variable cast time decreases with level: 1s to 0.1s
 *   Base Starting Cooldown is 5 seconds.
 *   Requires extra 10% Current SP per cast.
 *
 * so the sim reads its damage ratios from the dataset rather than having
 * them copied by hand. A kit (see kits/) names which parsed line means
 * what -- which formula is the hit, which bonus needs Combo Ready -- and
 * may override a number, but the numbers themselves start here, and a
 * tooltip that changes in the next crawl changes the sim with it.
 *
 * Anything a line says that this does not recognise is kept in `unread`,
 * so a kit can tell when the tooltip grew a clause nobody modelled.
 */

export type StatKey = 'str' | 'agi' | 'vit' | 'int' | 'dex' | 'luk';
const STATS: StatKey[] = ['str', 'agi', 'vit', 'int', 'dex', 'luk'];

/** A skill ratio as the tooltip writes it: all in percent of ATK. */
export interface Ratio {
  base: number;
  perLevel: number;
  perStat: Partial<Record<StatKey, number>>;
  /** "+10% per level per Focus": perLevel x level x focus stacks. */
  perLevelPerFocus?: number;
  /** "+5% per Focus": x focus stacks. */
  perFocus?: number;
}

export interface SkillText {
  /** Named formulas: "damage", "explosion", "apply damage", ... */
  formulas: Record<string, Ratio>;
  /** Bonuses behind a condition: "combo ready", "soul curse", "focus". */
  when: Record<string, Ratio>;
  /** ms, by skill level (1-based: index 0 is level 1). */
  variableCast: (lv: number) => number;
  fixedCast: (lv: number) => number;
  cooldown: (lv: number) => number;
  /** Extra costs beyond the SP column, as fractions. */
  extraCost: { sp: { current: number; max: number }; hp: { current: number; max: number } };
  /** "Grants Combo Ready for 5 seconds" -> { 'combo ready': 5000 }. */
  grants: Record<string, number>;
  /** Lines nothing here understood. */
  unread: string[];
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const num = (s: string) => Number(s.replace(',', '.'));

/**
 * The terms of a ratio: "250 +50% per level +8% per AGI", "+5% per STR and
 * +2% per DEX", "+10% per level per Focus". Returns null for text that has
 * no ratio terms at all.
 */
export function parseRatio(text: string): Ratio | null {
  const r: Ratio = { base: 0, perLevel: 0, perStat: {} };
  let found = false;
  let rest = text.replace(/\s+/g, ' ');

  // Per level per focus first, so "per level" below does not claim it.
  rest = rest.replace(new RegExp(String.raw`\+?\s*${NUM}%? per level per (?:\w+ )?focus`, 'gi'), (_m, n) => {
    r.perLevelPerFocus = (r.perLevelPerFocus ?? 0) + num(n); found = true; return ' ';
  });
  rest = rest.replace(new RegExp(String.raw`\+?\s*${NUM}%? per (?:\w+ )?focus`, 'gi'), (_m, n) => {
    r.perFocus = (r.perFocus ?? 0) + num(n); found = true; return ' ';
  });
  rest = rest.replace(new RegExp(String.raw`\+?\s*${NUM}%? per (?:skill )?level`, 'gi'), (_m, n) => {
    r.perLevel += num(n); found = true; return ' ';
  });
  rest = rest.replace(new RegExp(String.raw`\+?\s*${NUM}%? per (STR|AGI|VIT|INT|DEX|LUK)\b`, 'gi'), (_m, n, stat) => {
    const k = stat.toLowerCase() as StatKey;
    r.perStat[k] = (r.perStat[k] ?? 0) + num(n); found = true; return ' ';
  });
  // What is left at the front is the base: "250 ", "200+".
  const base = new RegExp(String.raw`^\s*${NUM}%?\s*\+?\s*$|^\s*${NUM}%?\s*\+`).exec(rest);
  if (base) { r.base = num(base[1] ?? base[2]); found = true; }
  return found ? r : null;
}

/** "Xs" or "X seconds", in ms. */
const seconds = (s: string) => Math.round(num(s) * 1000);

/** A value that moves linearly across levels: "decreases with level: 2s to 0.4s". */
function across(from: number, to: number, max: number) {
  return (lv: number) => {
    if (max <= 1) return to;
    const t = (Math.min(max, Math.max(1, lv)) - 1) / (max - 1);
    return Math.round(from + (to - from) * t);
  };
}

const constant = (v: number) => () => v;

export function parseSkillText(desc: string, maxLevel: number): SkillText {
  const out: SkillText = {
    formulas: {},
    when: {},
    variableCast: constant(0),
    fixedCast: constant(0),
    cooldown: constant(0),
    extraCost: { sp: { current: 0, max: 0 }, hp: { current: 0, max: 0 } },
    grants: {},
    unread: [],
  };

  for (const rawLine of desc.split('\n')) {
    const line = rawLine.trim().replace(/\.$/, '');
    if (!line) continue;
    if (readTiming(line, out, maxLevel)) continue;
    if (readCost(line, out)) continue;

    const grant = /^(?:grants|enables) (combo ready|cast ready|finisher ready)(?: for spells)? for (\d+(?:\.\d+)?) ?s(?:econds)?/i.exec(line);
    if (grant) { out.grants[grant[1].toLowerCase()] = seconds(grant[2]); continue; }

    // "Damage: ...", "Damage is ...", "Explosion: ...", "Apply Damage: ..."
    const named = /^([A-Za-z][A-Za-z ]*?)(?::| is)\s+(.+)$/.exec(line);
    if (named) {
      const label = named[1].trim().toLowerCase();
      const ratio = parseRatio(named[2]);
      if (ratio && /damage|explosion|apply|burst|pulse/.test(label)) {
        out.formulas[label] = ratio;
        continue;
      }
      if (ratio && /^focus$/.test(label)) { out.when.focus = ratio; continue; }
    }

    // "Combo Ready adds +5% per STR", "Soul Curse adds another +2% per INT and +2% per DEX"
    const cond = /^(combo ready|soul curse|satsujin's curse|new moon|cast ready)\s+adds(?: another)?\s+(.+)$/i.exec(line);
    if (cond) {
      const ratio = parseRatio(cond[2]);
      if (ratio) { out.when[cond[1].toLowerCase()] = ratio; continue; }
    }

    out.unread.push(line);
  }
  return out;
}

function readTiming(line: string, out: SkillText, max: number): boolean {
  const cast = /^(variable|fixed) cast time (?:is (\S+?)s?$|(?:de|in)creases with level: (\S+?)s? to (\S+?)s?$)/i.exec(line);
  if (cast) {
    const fn = cast[2] !== undefined
      ? constant(seconds(cast[2]))
      : across(seconds(cast[3]), seconds(cast[4]), max);
    if (cast[1].toLowerCase() === 'variable') out.variableCast = fn;
    else out.fixedCast = fn;
    return true;
  }
  // "Base Starting Cooldown is 5 seconds", "Starting cooldown is 0.5s",
  // "Base cooldown is 3 seconds", "Cooldown is 0.5+0.25s per level",
  // "Has a 20s cooldown", "Skill has a 7 second cooldown".
  const cdPer = /cooldown is (\S+?)\s*\+\s*(\S+?)s per level/i.exec(line);
  if (cdPer) {
    const a = seconds(cdPer[1]); const b = seconds(cdPer[2]);
    out.cooldown = (lv) => a + b * lv;
    return true;
  }
  const minutes = /cooldown is (\d+(?:[.,]\d+)?) ?minutes?/i.exec(line);
  if (minutes) {
    out.cooldown = constant(seconds(minutes[1]) * 60);
    return true;
  }
  const cd = /(?:cooldown is|cooldown of) (\d+(?:[.,]\d+)?) ?s(?:econds?)?\b/i.exec(line)
    ?? /has a (\d+(?:[.,]\d+)?) ?(?:s|second) cooldown/i.exec(line);
  if (cd && /cooldown/i.test(line)) {
    out.cooldown = constant(seconds(cd[1]));
    return true;
  }
  return false;
}

function readCost(line: string, out: SkillText): boolean {
  // "Requires 15+5% Max SP to cast": a flat part the SP column already
  // carries, and a percent on top.
  const flatPlus = /^requires\s+\d+\s*\+\s*(\d+(?:\.\d+)?)%\s+(current|max)\s+SP\b/i.exec(line);
  if (flatPlus) {
    out.extraCost.sp[flatPlus[2].toLowerCase() as 'current' | 'max'] += num(flatPlus[1]) / 100;
    return true;
  }
  // "Requires extra 10% Current SP per cast", "Requires an extra 5% Max SP
  // per talisman", "Requires extra 5% Current HP to cast", "Costs extra 10%
  // Max HP/SP per cast", "Requires 5% extra Current SP to cast".
  const m = /^(?:requires|costs)\s+(?:an\s+)?(?:extra\s+)?(\d+(?:\.\d+)?)%\s+(?:extra\s+)?(current|max)\s+(HP\/SP|SP\/HP|HP|SP)\b/i.exec(line);
  if (!m) return false;
  const frac = num(m[1]) / 100;
  const which = m[2].toLowerCase() as 'current' | 'max';
  const pools = m[3].toUpperCase();
  if (pools.includes('SP')) out.extraCost.sp[which] += frac;
  if (pools.includes('HP')) out.extraCost.hp[which] += frac;
  return true;
}

/** The ratio in percent at a level, for the given stats and focus stacks. */
export function ratioAt(
  r: Ratio, lv: number, stats: Record<StatKey, number>, focus = 0,
): number {
  let v = r.base + r.perLevel * lv;
  for (const k of STATS) v += (r.perStat[k] ?? 0) * (stats[k] ?? 0);
  v += (r.perLevelPerFocus ?? 0) * lv * focus;
  v += (r.perFocus ?? 0) * focus;
  return v;
}
