/**
 * A skill's ratio, term by term, from its tooltip (the project owner,
 * 2026-10-02: "all of the scaling bonuses ... and the total skill ratio from
 * the description"), for the web Rotation overlay's skill tooltips.
 *
 *   "Damage is 150+15% per level +2% per LUK"   -> the main formula: base,
 *                                                  per level, per stat
 *   "Extra 5% scaling per level of Improve Dodge" -> added to it (a skill level)
 *   "Combo Ready adds +1% per DEX", "Night Wound: +50% and +1% per Dex",
 *   "Damage increases by 5% per Improve Dodge level while under Hallucination Walk"
 *                                                -> a condition of its own
 *   "Extra 5% per Overslash Stack", "Extra 25% Damage per Duel Counter"
 *                                                -> per stack, of its own
 *   "Extra 1% per Soft DEF and Hard DEF"         -> said, not worked out
 *
 * Levels are worked out here (the build's skill levels); stat terms are left
 * to the page, on the viewer's own stats. Buffs that add to other skills'
 * ratios (Darkside Shadow, True Sight, King's Fortress Lv3, Shield Mastery)
 * come from BUFF_TERMS, each where the kit applies it.
 */

type Stat = 'STR' | 'AGI' | 'VIT' | 'INT' | 'DEX' | 'LUK';
const STATS: Stat[] = ['STR', 'AGI', 'VIT', 'INT', 'DEX', 'LUK'];

export interface Term {
  /** As the tooltip says it, tidied: "+15% per level". */
  text: string;
  /** Worked out here: a flat %, or per level x the level. */
  value?: number;
  /** Per stat: the page multiplies by its stats (summed when several), / every. */
  stats?: Stat[]; per?: number; every?: number;
  /** The buff it comes from, when it is not the skill's own. */
  from?: string;
  /** Situational and not worked out (Soft DEF). */
  said?: boolean;
}
export interface Group {
  /** "Damage", "Explosion", or the condition: "Combo Ready", "Per Overslash stack". */
  label: string;
  /** The main formula (its terms make the total); otherwise on top, when it applies. */
  main: boolean;
  terms: Term[];
}

const N = String.raw`(\d+(?:\.\d+)?)`;
const STAT_RE = String.raw`(STR|AGI|VIT|INT|DEX|LUK)`;
const statOf = (s: string) => s.toUpperCase() as Stat;

/** The terms of one expression: "150+15% per level +2% per LUK", "+50% and +1% per Dex". */
function parseExpr(expr: string, ownLevel: number, levels: Record<string, number>): Term[] {
  const out: Term[] = [];
  let rest = ` ${expr.replace(/\s+/g, ' ')} `;
  const take = (re: RegExp, f: (...m: string[]) => Term | null) => {
    rest = rest.replace(re, (...m) => { const t = f(...(m as string[])); if (t) out.push(t); return ' '; });
  };
  // A stat, one or two, maybe "per 2 LUK and INT".
  take(new RegExp(String.raw`\+?\s*${N}%\s*(?:scaling\s*)?per\s*(\d+\s+)?${STAT_RE}\b(?:\s*(?:and|/|&)\s*${STAT_RE}\b)?`, 'gi'),
    (_m, per, every, a, b) => {
      const stats = [statOf(a), ...(b ? [statOf(b)] : [])];
      const ev = every ? Number(every) : 1;
      return { text: `+${per}% per ${ev > 1 ? `${ev} ` : ''}${stats.join(ev > 1 ? ' + ' : '/')}`, stats, per: Number(per), every: ev };
    });
  // Another skill's level: "per Improve Dodge level", "per level of Improve Dodge".
  const NAME = String.raw`([A-Z][\w']*(?: [A-Z][\w']*)*)`;
  take(new RegExp(String.raw`\+?\s*${N}%\s*(?:scaling\s*)?per\s*(?:level of ${NAME}|${NAME} level)\b`, 'g'), (m, per, a, b) => {
    const skill = (a ?? b).trim();
    if (!(skill in levels)) return { text: m.trim(), said: true };
    const lv = levels[skill] ?? 0;
    return { text: `+${per}% per ${skill} level (${lv})`, value: Number(per) * lv };
  });
  take(new RegExp(String.raw`\+?\s*${N}%\s*per\s*(?:skill\s*)?level\b`, 'gi'), (_m, per) =>
    ({ text: `+${per}% per level (${ownLevel})`, value: Number(per) * ownLevel }));
  // The base or a flat bonus: "150+", "+50%", "Damage +25%".
  take(new RegExp(String.raw`^\s*${N}%?\s*(?=\+|$|\s)`), (_m, n) => ({ text: `${n}%`, value: Number(n) }));
  take(new RegExp(String.raw`\+\s*${N}%(?!\s*per)`, 'g'), (_m, n) => ({ text: `+${n}%`, value: Number(n) }));
  // Anything still saying "N% per ..." is situational: kept as said.
  const left = /(\d+(?:\.\d+)?)%\s*per\s*([^,.;]+)/i.exec(rest);
  if (left) out.push({ text: `+${left[1]}% per ${left[2].trim()}`, said: true });
  return out;
}

/** Counters and stacks a term can be "per": a group of its own, worked out per stack. */
const STACKS: [RegExp, string][] = [
  [/per (?:Overslash|Roaring) Stack/i, 'Per Overslash stack'],
  [/per Duel Counter/i, 'Per Duel Counter'],
  [/per Rolling Counter/i, 'Per Rolling Counter'],
  [/per missing HP ?%/i, 'Per 1% HP missing'],
];

export function ratioGroups(desc: string, ownLevel: number, levels: Record<string, number>): Group[] {
  const groups: Group[] = [];
  const group = (label: string, main: boolean) => {
    let g = groups.find((x) => x.label === label);
    if (!g) { g = { label, main, terms: [] }; groups.push(g); }
    return g;
  };
  const lines = desc.split('\n').map((l) => l.trim().replace(/\.$/, '')).filter(Boolean);
  for (const line of lines) {
    if (!/\d%/.test(line) || /\b(?:SP|HP to cast|HP per cast|Max HP to cast|chance|cast time|cooldown)\b/i.test(line) && !/missing HP/i.test(line)) continue;
    // The main formulas.
    const main = /^(Damage|Apply Damage|Explosion)\s*(?:is|:)\s*(?!\s*boosted)(.+)$/i.exec(line);
    if (main) {
      const label = main[1][0].toUpperCase() + main[1].slice(1).toLowerCase();
      group(label, true).terms.push(...parseExpr(main[2].replace(/\bper hit\b/i, ''), ownLevel, levels));
      continue;
    }
    // Conditions: "Night Wound: ...", "Focus: ...", "Finisher Ready: ...", "Combo Ready adds ...".
    const cond = /^(Night Wound|Focus|Finisher Ready|Combo Ready)\s*(?::|adds)\s*(.+)$/i.exec(line)
      ?? /^Damage is (boosted with dual swords)\s*:\s*(.+)$/i.exec(line);
    const under = /^(?:Damage increases by|Extra)\s+(.+?)\s+while under (.+)$/i.exec(line);
    const stack = STACKS.find(([re]) => re.test(line));
    if (stack) {
      const expr = line.replace(/^.*?(?=\d+(?:\.\d+)?%)/, '').replace(stack[0], '').replace(/\bDamage\b/i, '');
      group(cond ? `${cond[1]}, ${stack[1][0].toLowerCase()}${stack[1].slice(1)}` : stack[1], false).terms.push(...parseExpr(`+${expr}`, ownLevel, levels));
    } else if (cond) {
      const focus = /^focus$/i.test(cond[1]) && /per Focus/i.test(cond[2]);
      const label = /dual swords/i.test(cond[1]) ? 'With dual swords' : focus ? 'Per Focus stack' : cond[1].replace(/\b\w/g, (c) => c.toUpperCase());
      group(label, false).terms.push(...parseExpr(cond[2].replace(/^Damage\s*/i, '').replace(/\s*per (?:\w+ )?Focus\b/i, ''), ownLevel, levels));
    } else if (under) {
      group(`Under ${under[2]}`, false).terms.push(...parseExpr(`+${under[1]}`, ownLevel, levels));
    } else if (/^(?:Extra|\+)/i.test(line) && /% (?:scaling )?per /i.test(line)) {
      // On top of the main formula, always (a buff's own "Extra ..." line is not a formula: King's Fortress).
      const g = groups.find((x) => x.main);
      if (g) g.terms.push(...parseExpr(`+${line.replace(/^Extra\s*\+?/i, '')}`, ownLevel, levels));
    }
  }
  // The base first, then per level, other skills' levels, stats, then what is only said.
  const rank = (t: Term) => (t.said ? 5 : t.stats ? 3 : /per level/.test(t.text) ? 1 : /per /.test(t.text) ? 2 : 0);
  for (const g of groups) g.terms.sort((a, b) => rank(a) - rank(b));
  return groups.filter((g) => g.terms.length > 0);
}

/**
 * Buffs that add to other skills' ratios, where the kit applies them
 * (combat/src/kits). A term only shows when its buff is learned.
 */
const BUFF_TERMS: Record<string, { buff: string; skills: string[]; term: (lv: number) => Term }[]> = {
  Revenant: [
    // "Adds 2% per DEX Scaling to all Physical skills; Underworld Rainstorm bonus is halved" (revenant.ts shadowDex).
    { buff: 'Darkside Shadow', skills: ['Scythe Reap', 'Sweeping Slash', 'Hellraiser', 'Reaping Slash', 'Roaring Overslash', 'Phantom Slice'],
      term: () => ({ text: '+2% per DEX', stats: ['DEX'], per: 2, every: 1 }) },
    { buff: 'Darkside Shadow', skills: ['Underworld Rainstorm'], term: () => ({ text: '+1% per DEX (halved)', stats: ['DEX'], per: 1, every: 1 }) },
    // +2% a level on weapon attacks, unsaid by the tooltip (revenant.ts trueSightRatio, battle.cpp:3885).
    { buff: 'True Sight', skills: ['Scythe Reap', 'Sweeping Slash', 'Hellraiser', 'Reaping Slash', 'Roaring Overslash', 'Underworld Rainstorm', 'Phantom Slice', 'Haunting Slice'],
      term: (lv) => ({ text: `+2% per True Sight level (${lv})`, value: 2 * lv }) },
  ],
  Kingslayer: [
    // kingslayer.ts shieldBonus: Shield Mastery +20% a level (the owner's reading), King's Fortress Lv3 +1% per STR and 2% per VIT.
    { buff: 'Shield Mastery', skills: ["King's Chains", 'Shield Boomerang'], term: (lv) => ({ text: `+20% per Shield Mastery level (${lv})`, value: 20 * lv }) },
    { buff: "King's Fortress", skills: ["King's Chains", 'Shield Boomerang'], term: () => ({ text: '+1% per STR', stats: ['STR'], per: 1, every: 1 }) },
    { buff: "King's Fortress", skills: ["King's Chains", 'Shield Boomerang'], term: () => ({ text: '+2% per VIT', stats: ['VIT'], per: 2, every: 1 }) },
  ],
};

/** The skill's groups with the buffs' terms added to its main formula. */
export function skillRatio(className: string, skill: string, desc: string, levels: Record<string, number>): Group[] | null {
  const groups = ratioGroups(desc, levels[skill] ?? 0, levels);
  const main = groups.find((g) => g.main);
  if (!main) return null;
  for (const b of BUFF_TERMS[className] ?? []) {
    const lv = levels[b.buff] ?? 0;
    if (lv > 0 && b.skills.includes(skill)) main.terms.push({ ...b.term(lv), from: b.buff });
  }
  return groups;
}

export { STATS };
