/**
 * Autocasts from gear: "10% chance to autocast Fire Ball Lv7 when attacking",
 * "...when hit", "Shadow Slash autocasts Wind Slash Lv3".
 *
 * What a build has comes from three places, in this order:
 *   1. the live crawl's structured column (item `on_cast`: skill, level,
 *      chance %, trigger, triggering skill) -- the item list, levels and
 *      chances as the live server shows them;
 *   2. the item's tooltip, for what that column leaves out: chances that
 *      scale ("3% +0.2% per refine", "1% chance per base LUK"), the whole
 *      autocast on items newer than the column (the class gems), "on the
 *      User", "close range";
 *   3. the 2023 server scripts (combat/data/server-autocasts.json,
 *      tools/import-autocasts.ts), for what neither says: bonus5's trigger
 *      mask, the target / random-level / pays-SP flag bits, a chance formula.
 *
 * How they fire is the server's (RTM skill.cpp; the project owner: code
 * first, tooltips where they say otherwise):
 *   - when attacking (skill_additional_effect, skill.cpp:2451): a hit that
 *     lands -- a block counts, a miss does not -- on a target it leaves
 *     alive, matching the bonus's BF_ mask on all three of weapon/magic/misc,
 *     short/long, normal/skill. A plain bonus3 bAutoSpell fills to normal
 *     weapon attacks only (pc.cpp:2560-2568). Arrow and bullet attacks roll
 *     half the chance (skill.cpp:2474). Rolled once per hit target, not per
 *     hit of a multi-hit.
 *   - when hit (skill_counter_additional_effect, skill.cpp:2833): a hit that
 *     damages you and leaves you standing; bonus3 fills to weapon hits,
 *     normal or skill, any range -- never magic. RTM dropped the ranged
 *     halving here (only its comment is left, skill.cpp:2850).
 *   - on a skill (skill_onskillusage, skill.cpp:2561): the named skill going
 *     off -- a damage skill only when it dealt damage.
 *   - Every one: no SP (skill.cpp:17495) unless an OnSkill bonus has RTM's
 *     flag bit 4 (skill.cpp:2608); HP costs still paid; no cast time; fires
 *     even while that skill is on cooldown (the live server, per the project
 *     owner 2026-10-03; the 2023 code blocked it, skill.cpp:819 -- profile
 *     option autocastCooldown true brings that back), and it starts no
 *     cooldown. Attack and when-hit autocasts hold you for the skill's
 *     after-cast delay (skill.cpp:2516, 2886); on-skill ones do not.
 *     An autocast can set off further autocasts (no guard on the server but
 *     the dice; here CHAIN_DEPTH).
 *
 * Who casts the skill: the kit if it has the skill (Kit.castAutocast, or
 * its action of that name), else a generic cast from the skill's tooltip
 * ratio and its skill_db row: weapon or magic damage, or Heal. Anything else
 * (buffs, debuffs, traps) goes off with no effect and is listed in the
 * fighter's notes.
 */
import { resolve } from 'node:path';

import type { Dataset } from '../../sim/src/types.ts';
import { COMBAT_DATA, readJSON, REPO, skillRows, type SkillRow } from './data.ts';
import {
  actionById, heal_, noteProc, say, strike, targetNow, type Action, type Fight,
} from './engine.ts';
import { healAmount, magicDamage, physicalDamage, skillDelayMs } from './formulas.ts';
import type { Stats } from './model.ts';
import { parseRatio, parseSkillText, ratioAt } from './skilltext.ts';

// ---- the server's trigger masks (battle.hpp:36-48) ---------------------------

export const BF = { WEAPON: 0x1, MAGIC: 0x2, MISC: 0x4, SHORT: 0x10, LONG: 0x40, SKILL: 0x100, NORMAL: 0x200 } as const;
const WEAPONMASK = 0x7;
const RANGEMASK = 0x50;
const SKILLMASK = 0x300;

/** pc_bonus_autospell's defaults for the parts of a mask left out (pc.cpp:2560-2568). */
export function fillMask(bf: number): number {
  if (!(bf & RANGEMASK)) bf |= BF.SHORT | BF.LONG;
  if (!(bf & WEAPONMASK)) bf |= BF.WEAPON;
  if (!(bf & SKILLMASK)) {
    if (bf & (BF.MAGIC | BF.MISC)) bf |= BF.SKILL;
    if (bf & BF.WEAPON) bf |= BF.NORMAL;
  }
  return bf;
}

/** An attack matches a bonus when it shares a bit with it in each of the three groups (skill.cpp:2455-2458). */
export const maskMatches = (bf: number, attack: number) =>
  !!(bf & attack & WEAPONMASK) && !!(bf & attack & RANGEMASK) && !!(bf & attack & SKILLMASK);

/** bonus3 bAutoSpell: normal weapon attacks only. bAutoSpellWhenHit: weapon hits, normal or skill. */
const DEFAULT_MASK = { attack: fillMask(0), hit: fillMask(BF.NORMAL | BF.SKILL) };

// ---- what a build has ------------------------------------------------------

export type AutocastTrigger = 'attack' | 'hit' | 'skill';

export interface Autocast {
  /** The item or card it is on. */
  source: string;
  /** Cast in this order on one roll ("Shield Boomerang and King's Chains"). */
  skills: string[];
  /** The level cast (the learned level already folded in where the text says so). */
  level: number;
  /** rnd(1..level) on each cast (AUTOSPELL_FORCE_RANDOM_LEVEL). */
  randomLevel?: boolean;
  /** 0..1 per roll. */
  chance: number;
  trigger: AutocastTrigger;
  /** trigger 'skill': the skill whose use sets it off. */
  onSkill?: string;
  /** attack / hit: the BF_ mask an attack must match. */
  mask: number;
  /** Lands on you (a heal, a buff), not the enemy. */
  self?: boolean;
  /** RTM's OnSkill flag 4: cast as a normal skill, SP paid (skill.cpp:2608). */
  paysSp?: boolean;
  /** Where the numbers came from: "crawl", "tooltip", "server", joined. */
  from: string;
}

/** One worn piece: an item in a slot, or a card in it (`refine` is the host's: getrefine() in a card reads it). */
export interface WornPiece { itemId: number; refine: number; card: boolean }

interface OnCast { skill: string; raw: number[] }
interface ServerSpell {
  bonus: 'bAutoSpell' | 'bAutoSpellWhenHit' | 'bAutoSpellOnSkill'; arity: number; skill: string; onSkill?: string;
  lv: string; rate: string; bf?: string; flag?: string; cond: string[];
}
interface ServerSkill {
  id: number; name: string; type: 'Weapon' | 'Magic' | 'Misc' | 'None'; target: string;
  element: string | string[]; hitCount: number | number[]; acd: number | number[]; range: number | number[];
  splash: number | number[]; damageFlags: string[]; inf2: string[];
}
interface ServerData {
  items: Record<string, { vars: Record<string, string>; spells: ServerSpell[] }>;
  skills: Record<string, ServerSkill>;
}

let server: ServerData | null = null;
const serverData = () => (server ??= readJSON<ServerData>(resolve(COMBAT_DATA, 'server-autocasts.json')));
let castNames: string[] | null = null;
/** The crawl's on_cast skill column indexes this list (data/lookups.json skill_casts). */
const castName = (i: number) => (castNames ??= readJSON<{ skill_casts: string[] }>(resolve(REPO, 'data/lookups.json')).skill_casts)[i];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Tooltip spellings of skill names that differ from the skill list. */
const ALIASES: Record<string, string> = {
  vampiresgift: 'Vampire Gift', snaretrap: 'Ankle Snare', frozenwind: 'Frozen Winds', flipcoin: 'Coin Flip',
  colluceoheal: 'Coluceo Heal', darkmessage: 'Dark Messenger',
};

let nameIndex: { norm: string; name: string }[] | null = null;
/** Every skill name, longest first: the tooltip reader takes the longest that fits. */
function names() {
  if (nameIndex) return nameIndex;
  const seen = new Map<string, string>();
  // "Sonic Blow+" (a stronger version) normalises like "Sonic Blow": the plain name wins.
  for (const r of skillRows()) if (r.name && !(seen.has(norm(r.name)) && /\+$/.test(r.name))) seen.set(norm(r.name), r.name);
  for (const [k, v] of Object.entries(ALIASES)) seen.set(k, v);
  nameIndex = [...seen].map(([n, name]) => ({ norm: n, name })).sort((a, b) => b.norm.length - a.norm.length);
  return nameIndex;
}

/** The skill named at the start of `text` ("Wind Slash Lv3 when..."), and how much of `text` it took. */
function skillAt(text: string): { name: string; len: number } | null {
  const t = text.replace(/^\s*(?:the\s+)?/i, '');
  const skipped = text.length - t.length;
  // Walk the text a character at a time against the normalised names.
  const n = norm(t.slice(0, 60));
  for (const x of names()) {
    if (x.norm.length < 3 || !n.startsWith(x.norm)) continue;
    // Map the normalised length back onto the raw text.
    let used = 0; let i = 0;
    while (i < t.length && used < x.norm.length) { if (/[a-z0-9]/i.test(t[i])) used++; i++; }
    // A word cut in half is not a name ("Heal" in "Healing").
    if (/[a-z]/i.test(t[i] ?? '') && /[a-z]/i.test(t[i - 1] ?? '')) continue;
    return { name: x.name, len: skipped + i };
  }
  return null;
}

/** A list of skills: "Flaming Petals, Freezing Spear and Wind Blade". */
function skillList(text: string): { names: string[]; len: number } {
  const out: string[] = []; let pos = 0;
  for (;;) {
    const lead = /^\s*(?:Lv\.?\s*\d+\s+)?/i.exec(text.slice(pos))![0];
    const s = skillAt(text.slice(pos + lead.length));
    if (!s) break;
    out.push(s.name); pos += lead.length + s.len;
    const sep = /^\s*(?:Lv\.?\s*\d+\s*)?(?:,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+)/i.exec(text.slice(pos));
    if (!sep) break;
    pos += sep[0].length;
  }
  return { names: out, len: pos };
}

/** What one autocast clause of a tooltip says. */
interface TextCast {
  skills: string[];
  level?: number;
  learned?: boolean;
  maxLevel?: boolean;
  rate?: { flat: number; perRefine: number; perBaseLuk: number; cap?: number };
  trigger: AutocastTrigger;
  /** trigger 'skill': the skills that set it off (one autocast each). */
  onSkills?: string[];
  self?: boolean;
  short?: boolean;
  /** Held under a "Per Refine:" heading: a bare chance is per refine. */
  perRefineBlock: boolean;
}

/** A heading that starts what a single piece does not give: a set bonus, a conditional state. */
const SET_LINE = /\bset\b.*:\s*$|set bonus|^\s*dragon soul:/i;
/** A line ending on one of these runs on into the next. */
const DANGLING = /(?:^|\s)(?:to|auto-?\s?casts?|chance|per|the|and|or|of|a|an|at|when|on|has|with|using|casting|cast|will|that|if|Lv\.?|\+|-)\s*$/i;

/**
 * A block's lines put back into sentences. The tooltips wrap mid-sentence
 * (old items at ~25 characters) but also list one effect a line with no
 * full stops (the class gems), so a line runs on only when it plainly does:
 * the next starts lower case, this one ends on a dangling word, a chance
 * follows a "Skill Lv3:" line, or a skill name was cut ("autocast Flaming"
 * / "Petals Lv3").
 */
function sentences(lines: string[]): string[] {
  const out: string[] = []; let cur = '';
  const joins = (prev: string, next: string) => {
    if (/(?<!Lv)\.\s*$/.test(prev)) return false;
    if (/^[a-z(]/.test(next) || DANGLING.test(prev)) return true;
    if (/:\s*$/.test(prev) && /^[\d.]+%/.test(next)) return true;
    const m = /auto-?\s?casts?\s+(.*)$/i.exec(prev);
    if (!m) return false;
    const alone = skillList(m[1]); const joined = skillList(`${m[1]} ${next}`);
    return joined.names.join('|') !== alone.names.join('|') && joined.len > m[1].length;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (cur && joins(cur, line)) cur += ` ${line}`;
    else { if (cur) out.push(cur); cur = line; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The skills a clause ends on: "Heavy Stab, Spear Boomerang and Wind Cutter"
 * in "... Wind Cutter autocast Crescent Dive", "First Hand" in "10% chance
 * that First Hand will autocast". The chance words and "will" / "has ...
 * chance to" are stripped first.
 */
function skillsBefore(before: string): string[] {
  let t = before;
  for (let i = 0; i < 2; i++) {
    t = t.replace(/\s*(?:has\s+(?:a\s+)?(?:separate\s+)?)?(?:[\d.]+%\s*(?:\+\s*[\d.]+%\s*)?(?:chance\s+)?(?:per\s+refine\s+)?)?(?:chance\s+)?(?:to\s+)?$/i, '')
      .replace(/\s*\b(?:will|always|also|can)\s*$/i, '').replace(/[,:]\s*$/, '');
  }
  const out: string[] = [];
  const pieces = t.split(/,\s*|\s+and\s+/);
  for (let p = pieces.length - 1; p >= 0; p--) {
    const words = pieces[p].trim().split(/\s+/);
    let hit: string | null = null;
    for (let n = Math.min(5, words.length); n >= 1 && !hit; n--) {
      const cand = words.slice(-n).join(' ');
      const s = skillAt(cand);
      if (s && s.len >= cand.trim().length) hit = s.name;
      // Only the last piece may carry words in front ("50% chance that Flaming Petals").
      if (!hit && p < pieces.length - 1 && n === words.length) break;
    }
    if (!hit) break;
    out.unshift(hit);
    if (words.length > 3) break;
  }
  return out;
}

/**
 * Every autocast clause in a tooltip, a sentence at a time: the skills just
 * after "autocast", the chance and the trigger in the same sentence. Set
 * bonuses and conditional states ("Dragon Soul:") are cut off: they need
 * more than the piece.
 */
export function readTooltip(desc: string): { casts: TextCast[]; unread: string[] } {
  const casts: TextCast[] = []; const unread: string[] = [];
  for (const rawBlock of desc.split(/\n\s*\n/)) {
    const lines = rawBlock.split('\n');
    const cut = lines.findIndex((l) => SET_LINE.test(l));
    const kept = cut >= 0 ? lines.slice(0, cut) : lines;
    const perRefineBlock = /^\s*per refine/i.test(lines[0]);
    for (const sentence of sentences(kept)) {
      const hits = [...sentence.matchAll(/auto-?\s?casts?\b/gi)];
      hits.forEach((h, k) => {
        const at = h.index!;
        const prevEnd = k > 0 ? hits[k - 1].index! + hits[k - 1][0].length : 0;
        const before = sentence.slice(prevEnd, at);
        const after = sentence.slice(at + h[0].length, k + 1 < hits.length ? hits[k + 1].index : undefined);
        const lvBefore = /^\s*Lv\.?\s*(\d+)\s+/i.exec(after);
        const list = skillList(after.slice(lvBefore?.[0].length ?? 0));
        if (!list.names.length) { unread.push(sentence); return; }
        const tail = after.slice((lvBefore?.[0].length ?? 0) + list.len);
        const lv = lvBefore ? Number(lvBefore[1]) : Number(/^\s*\(?Lv\.?\s*(\d+)/i.exec(tail)?.[1] ?? NaN);
        const clause = `${before} ${h[0]} ${after}`;
        const c: TextCast = { skills: list.names, trigger: 'attack', perRefineBlock };
        if (Number.isFinite(lv)) c.level = lv;
        if (/learned/i.test(clause)) c.learned = true;
        if (/max(?:imum)? level/i.test(clause)) c.maxLevel = true;
        if (/on the user|on self|on yourself/i.test(clause)) c.self = true;
        if (/close range|short[- ]range/i.test(clause)) c.short = true;
        // The trigger: hit; "when using X" / "on X" after; "X autocasts Y" before.
        const using = /(?:when|on)\s+(?:using|casting)\s+(.+)$/i.exec(tail) ?? /(?:when|on)\s+(?:using|casting)\s+(.+?),/i.exec(before);
        const onX = /^\s*(?:Lv\.?\s*\d+\s*)?(?:on|after)\s+(?!attacks?\b|hit\b|getting|every|all\b|enemies|the\b|self|yourself)(.+)$/i.exec(tail);
        const subj = skillsBefore(before);
        if (/when hit|when attacked|getting hit|being hit|hit with (?:close|short)|attacked with/i.test(clause)) c.trigger = 'hit';
        else if (using && skillAt(using[1])) { c.trigger = 'skill'; c.onSkills = [skillAt(using[1])!.name]; }
        else if (onX && skillAt(onX[1])) { c.trigger = 'skill'; c.onSkills = [skillAt(onX[1])!.name]; }
        else if (subj.length) { c.trigger = 'skill'; c.onSkills = subj; }
        c.rate = readRate(clause, perRefineBlock);
        // "X autocasts Y" with no chance: every time.
        if (!c.rate && c.trigger === 'skill' && !/chance/i.test(clause)) c.rate = { flat: 100, perRefine: 0, perBaseLuk: 0 };
        // "Each spell rolls independently": one autocast a skill.
        if (c.skills.length > 1 && /independently/i.test(rawBlock)) for (const one of c.skills) casts.push({ ...c, skills: [one] });
        else casts.push(c);
      });
    }
  }
  return { casts, unread };
}

/** "3% +0.2% per refine", "1% chance per base LUK", "30% per refine (max 100%)", "always". */
function readRate(clause: string, perRefineBlock: boolean): TextCast['rate'] | undefined {
  const r = { flat: 0, perRefine: 0, perBaseLuk: 0 } as NonNullable<TextCast['rate']>;
  let found = false;
  let rest = clause;
  const cap = /\(max\s+([\d.]+)%\)/i.exec(rest);
  if (cap) { r.cap = Number(cap[1]); rest = rest.replace(cap[0], ' '); }
  rest = rest.replace(/\+?\s*([\d.]+)%\s*(?:chance\s*)?per\s+(?:base\s+)?luk\b/gi, (_m, n) => { r.perBaseLuk += Number(n); found = true; return ' '; });
  rest = rest.replace(/\+?\s*([\d.]+)%\s*(?:\w+\s+){0,2}?per\s+(?:\w+\s+)?refine\b/gi, (_m, n) => { r.perRefine += Number(n); found = true; return ' '; });
  const flats = [...rest.matchAll(/([\d.]+)%/g)];
  for (const m of flats) { r.flat += Number(m[1]); found = true; }
  // "1% Chance to auto cast Double Strafe on attacks per refine": one chance, "per refine" further on.
  if (!r.perRefine && flats.length === 1 && /per\s+refine/i.test(rest)) { r.perRefine = r.flat; r.flat = 0; }
  if (!found && /\balways\b/i.test(clause)) { r.flat = 100; found = true; }
  if (perRefineBlock && r.flat && !r.perRefine) { r.perRefine = r.flat; r.flat = 0; }
  return found ? r : undefined;
}

/** A server script expression for this build: getrefine(), readparam(bLuk), .@vars, getskilllv. */
function evalScript(expr: string, ctx: { refine: number; stats: Stats; levels: Record<string, number>; vars: Record<string, string> }, depth = 0): number {
  if (depth > 4) return NaN;
  const statKey = (s: string) => ({ bstr: 'str', bagi: 'agi', bvit: 'vit', bint: 'int', bdex: 'dex', bluk: 'luk' } as Record<string, keyof Stats>)[s.toLowerCase()];
  const aegisName = (a: string) => serverData().skills[a]?.name ?? a;
  let js = expr
    .replace(/getrefine\(\)/g, String(ctx.refine))
    .replace(/readparam\((b\w+)\)/g, (_m, s) => String(ctx.stats[statKey(s)] ?? 0))
    .replace(/getskilllv\("(\w+)"\)/g, (_m, a) => String(ctx.levels[aegisName(a)] ?? 0))
    .replace(/\.@(\w+)/g, (_m, v) => (ctx.vars[v] !== undefined ? `(${evalScript(ctx.vars[v], ctx, depth + 1)})` : '0'))
    .replace(/\bmax\(/g, 'Math.max(').replace(/\bmin\(/g, 'Math.min(');
  // Anything else (Class, checkfalcon(), getequipid) is not knowable here.
  if (/[A-Za-z_]\w*\s*\(|\bClass\b|Job_|\bb[A-Z]\w+/.test(js.replace(/Math\.(max|min)\(/g, ''))) return NaN;
  if (!/^[\d\s+\-*/%().?:<>=!&|,Mathaxin]*$/.test(js)) return NaN;
  try { return Number(new Function(`return (${js});`)()); } catch { return NaN; }
}

/**
 * The autocasts a set of worn pieces gives, with what could not be read
 * listed in `notes`.
 */
export function readAutocasts(
  pieces: WornPiece[], data: Dataset,
  ctx: { stats: Stats; baseStats: Stats; levels: Record<string, number>; maxLevel: (skill: string) => number },
  notes: string[],
): Autocast[] {
  const out: Autocast[] = [];
  const sv = serverData();
  for (const p of pieces) {
    const item = data.items.get(p.itemId) as (ReturnType<Dataset['items']['get']> & { on_cast?: OnCast[] }) | undefined;
    if (!item) continue;
    const text = readTooltip(item.description ?? '');
    const onCast = item.on_cast ?? [];
    for (const u of text.unread) notes.push(`autocast not read: ${item.name}: "${u.slice(0, 80)}"`);
    if (!onCast.length && !text.casts.length) continue;
    const srv = sv.items[String(p.itemId)];
    const used = new Set<TextCast>();
    const entries: { skills: string[]; level: number; ratePct: number; trigger: AutocastTrigger; onSkill?: string; from: string; tc?: TextCast }[] = [];

    for (const c of onCast) {
      const [, lv, rate, trig, on] = c.raw;
      const trigger = (['skill', 'hit', 'attack'] as const)[trig] ?? 'attack';
      const onSkill = trigger === 'skill' && on >= 0 ? castName(on) : undefined;
      const same = (t: TextCast) => !used.has(t) && t.skills.some((s) => norm(s) === norm(c.skill));
      // The clause for this skill and trigger; a skill trigger matched on its skill too.
      const tc = text.casts.find((t) => same(t) && t.trigger === trigger && (!onSkill || !t.onSkills || t.onSkills.includes(onSkill)))
        ?? text.casts.find((t) => same(t) && trigger !== 'skill' && t.trigger !== 'skill')
        ?? text.casts.find(same);
      if (tc) used.add(tc);
      entries.push({ skills: [c.skill], level: lv || tc?.level || 0, ratePct: rate, trigger, ...(onSkill ? { onSkill } : {}), from: 'crawl', ...(tc ? { tc } : {}) });
    }
    // Tooltip clauses the column does not have (newer items, the class gems).
    for (const t of text.casts) {
      if (used.has(t)) continue;
      if (onCast.some((c) => t.skills.some((s) => norm(s) === norm(c.skill)))) continue;
      for (const onSkill of t.onSkills ?? [undefined]) {
        entries.push({ skills: t.skills, level: t.level ?? 0, ratePct: 0, trigger: t.trigger, ...(onSkill ? { onSkill } : {}), from: 'tooltip', tc: t });
      }
    }

    for (const e of entries) {
      const tc = e.tc;
      const trigger = tc && e.from === 'crawl' && e.trigger !== 'skill' && tc.trigger === 'hit' ? 'hit' : e.trigger;
      // The server's line for the same skill and trigger, if the snapshot has the item.
      const aegis = iconOf(e.skills[0]);
      const bonus = trigger === 'attack' ? 'bAutoSpell' : trigger === 'hit' ? 'bAutoSpellWhenHit' : 'bAutoSpellOnSkill';
      const spell = srv?.spells.find((s) => s.bonus === bonus && s.skill === aegis);
      const sctx = { refine: p.refine, stats: ctx.stats, levels: ctx.levels, vars: srv?.vars ?? {} };
      if (spell && spell.cond.length && spell.cond.some((c) => evalScript(c, sctx) === 0)) continue;
      let from = e.from;
      // The chance: the column, else the tooltip's formula, else the server's.
      let chance = e.ratePct / 100;
      if (!(chance > 0) && tc?.rate) {
        const r = tc.rate;
        chance = (r.flat + r.perRefine * p.refine + r.perBaseLuk * (ctx.baseStats.luk ?? 0)) / 100;
        if (r.cap !== undefined) chance = Math.min(chance, r.cap / 100);
        from += '+tooltip';
      }
      if (!(chance > 0) && spell) {
        const v = evalScript(spell.rate, sctx);
        if (Number.isFinite(v) && v > 0) { chance = v / 1000; from += '+server'; }
      }
      if (!(chance > 0)) {
        notes.push(`autocast not read: ${item.name}: ${e.skills.join(', ')} (no chance${p.refine === 0 && tc?.rate?.perRefine ? ' at +0' : ''})`);
        continue;
      }
      // The level: the column's (0 = learned), the tooltip's "learned" / "max level", the server's.
      let level = e.level;
      if (!level && spell) {
        const v = evalScript(spell.lv, sctx);
        if (Number.isFinite(v) && v !== 0) level = v;
      }
      const learned = ctx.levels[e.skills[0]] ?? 0;
      if (tc?.maxLevel) level = ctx.maxLevel(e.skills[0]);
      if (!level || tc?.learned) level = Math.max(level || 1, learned);
      // Flags: bonus5's mask; the flag bits; the tooltip's range and "on the User".
      const bf = spell?.bf ? evalMask(spell.bf) : 0;
      let mask = trigger === 'skill' ? 0 : bf ? fillMask(bf) : DEFAULT_MASK[trigger];
      if (tc?.short && mask) mask = (mask & ~RANGEMASK) | BF.SHORT;
      const flag = spell?.flag !== undefined ? evalScript(spell.flag, sctx) : NaN;
      const sk = sv.skills[aegis ?? ''];
      // bonus3 picks the target from the skill (pc.cpp:4504); bonus4/5 say it (bit 1 = enemy).
      // OnSkill's bit 1 is inverted: set = yourself (skill.cpp:2583). A damage skill
      // aimed at yourself still hits around you (Wind Cutter): only a no-damage one is "on self".
      const onYou = Number.isFinite(flag) ? (trigger === 'skill' ? !!(flag & 1) : !(flag & 1)) : !!sk && /^(Self|Support)$/.test(sk.target);
      const self = !!tc?.self || (onYou && (!sk || sk.type === 'None'));
      if (spell) from += '+server';
      out.push({
        source: item.name,
        skills: e.skills,
        level,
        ...(Number.isFinite(flag) && flag & 2 ? { randomLevel: true } : {}),
        chance: Math.min(1, chance),
        trigger,
        ...(e.onSkill ? { onSkill: e.onSkill } : {}),
        mask,
        ...(self ? { self } : {}),
        ...(trigger === 'skill' && Number.isFinite(flag) && flag & 4 ? { paysSp: true } : {}),
        from: [...new Set(from.split('+'))].join('+'),
      });
    }
  }
  return out;
}

/** "BF_WEAPON|BF_MAGIC" -> the mask. */
function evalMask(s: string): number {
  let m = 0;
  for (const part of s.split('|')) {
    const k = part.trim().replace(/^BF_/, '') as keyof typeof BF;
    if (k in BF) m |= BF[k]; else if (/^\d+$/.test(part.trim())) m |= Number(part.trim());
  }
  return m;
}

/** A skill's Aegis name (the crawl's icon column). */
let icons: Map<string, string> | null = null;
function iconOf(name: string): string | undefined {
  if (!icons) {
    icons = new Map();
    const raw = readJSON<{ cols: string[]; rows: unknown[][] }>(resolve(REPO, 'data/raw/db-skills.json'));
    const n = raw.cols.indexOf('name'); const ic = raw.cols.indexOf('icon');
    for (const r of raw.rows) if (r[ic] && !icons.has(String(r[n]))) icons.set(String(r[n]), String(r[ic]));
  }
  return icons.get(name);
}

// ---- in a fight ------------------------------------------------------------

/** How deep autocasts may set off autocasts. The server has no guard; the dice end it. */
export const CHAIN_DEPTH = 3;

/** A skill's skill_db value at a level (arrays are per level). */
const atLevel = <T>(v: T | T[], lv: number): T => (Array.isArray(v) ? v[Math.max(0, Math.min(v.length, lv) - 1)] : v);

const ARROWS = /^(?:Heavy )?Bow$|^Revolver$/;

/** The mask of one of your hits: what it is, from where, normal or skill. */
export function attackMask(kind: 'melee' | 'ranged' | 'magic', skill: boolean, misc = false): number {
  const type = kind === 'magic' ? BF.MAGIC : misc ? BF.MISC : BF.WEAPON;
  // Magic is long range from a skill's range of 5+ (battle_range_type); nearly every spell is.
  const range = kind === 'melee' ? BF.SHORT : BF.LONG;
  return type | range | (skill ? BF.SKILL : BF.NORMAL);
}

/**
 * One of your hits landed (share: 1 when rolled, its landing chance in a
 * rollout) and the target still stands: the when-attacking autocasts roll.
 */
export function procOnAttack(fight: Fight, mask: number, share: number) {
  const list = fight.f.autocasts;
  if (!list?.length || fight.result || share <= 0 || (fight.procDepth ?? 0) >= CHAIN_DEPTH) return;
  const arrows = !(mask & BF.MAGIC) && !!(mask & BF.LONG) && ARROWS.test(fight.f.weapon?.type ?? '');
  for (const a of list) {
    if (a.trigger !== 'attack' || !maskMatches(a.mask, mask) || fight.kit.ownsAutocast?.(a)) continue;
    roll(fight, a, (arrows ? a.chance / 2 : a.chance) * share, true);
    if (fight.result) return;
  }
}

/** A monster's hit damaged you and you still stand: the when-hit autocasts roll. */
export function procWhenHit(fight: Fight, mask: number) {
  const list = fight.f.autocasts;
  if (!list?.length || fight.result || (fight.procDepth ?? 0) >= CHAIN_DEPTH) return;
  for (const a of list) {
    if (a.trigger !== 'hit' || !maskMatches(a.mask, mask) || fight.kit.ownsAutocast?.(a)) continue;
    roll(fight, a, a.chance, true);
    if (fight.result) return;
  }
}

/** A skill went off (and dealt damage, if it is a damage skill): the autocasts that follow it roll. */
export function procOnSkill(fight: Fight, skill: string, share = 1) {
  const list = fight.f.autocasts;
  if (!list?.length || fight.result || share <= 0 || (fight.procDepth ?? 0) >= CHAIN_DEPTH) return;
  for (const a of list) {
    if (a.trigger !== 'skill' || a.onSkill !== skill || fight.kit.ownsAutocast?.(a)) continue;
    if (fight.procLock?.has(a)) continue; // skill.cpp:2577 it.lock
    roll(fight, a, a.chance * share, false);
    if (fight.result) return;
  }
}

/** Roll an autocast (or weigh it in, in a rollout) and cast it. */
function roll(fight: Fight, a: Autocast, p: number, delay: boolean) {
  if (p <= 0) return;
  if (fight.rng.expect) fireAutocast(fight, a, Math.min(1, p), delay);
  else if (fight.rng.chance(Math.min(1, p))) fireAutocast(fight, a, 1, delay);
}

/**
 * Cast an autocast's skills, `share` of it (1 rolled; its chance in a
 * rollout). Also for a kit forcing one (Kingslayer's gemFirstHit).
 */
export function fireAutocast(fight: Fight, a: Autocast, share = 1, delay = a.trigger !== 'skill') {
  const me = fight.me;
  (fight.procLock ??= new Set()).add(a);
  fight.procDepth = (fight.procDepth ?? 0) + 1;
  try {
    for (const skill of a.skills) {
      if (fight.result) return;
      // The live server casts it even while that skill is on cooldown (the project owner,
      // 2026-10-03: changed since the 2023 code, whose skill_isNotOk -> skill_blockpc_get,
      // skill.cpp:819, blocked it). Option autocastCooldown true: the 2023 rule.
      if (fight.options.autocastCooldown === true && (me.cds[skill] ?? 0) > fight.t) continue;
      const level = a.randomLevel && !fight.rng.expect ? 1 + Math.floor(fight.rng.next() * a.level) : a.level;
      fight.log && say(fight, `${a.source} autocasts ${skill} Lv${level}${share < 1 ? ` (x${share.toFixed(2)})` : ''}`);
      noteProc(fight, skill);
      const before = fight.mob.hp;
      const did = castOne(fight, a, skill, level, share);
      if (!did) continue;
      // Its own followers (an OnSkill bonus on the autocast skill).
      if (did === 'support' || fight.mob.hp < before) procOnSkill(fight, skill, share);
      if (delay) holdFor(fight, skill, level);
    }
  } finally {
    fight.procDepth = (fight.procDepth ?? 1) - 1;
    fight.procLock.delete(a);
  }
}

/** The after-cast delay an attack or when-hit autocast holds you for (skill.cpp:2516-2526). */
function holdFor(fight: Fight, skill: string, level: number) {
  const sk = serverData().skills[iconOf(skill) ?? ''];
  const until = fight.t + skillDelayMs(sk ? atLevel(sk.acd, level) : 0, fight.f);
  fight.me.canActAt = Math.max(fight.me.canActAt ?? 0, until);
  if (!fight.me.cast) fight.me.busyUntil = Math.max(fight.me.busyUntil, until);
}

/** Pay what an autocast still costs: HP always; SP only with RTM's flag 4. */
function pay(fight: Fight, a: Autocast, act: Action | null, skill: string, level: number) {
  if (act?.hpCost) fight.me.hp = Math.max(1, fight.me.hp - act.hpCost(fight));
  if (!a.paysSp) return;
  const sp = act ? act.spCost(fight) : (skillRows().find((r) => r.name === skill)?.sp ?? [])[level - 1] ?? 0;
  fight.me.sp = Math.max(0, fight.me.sp - sp);
}

/**
 * Cast one skill: the kit's own (Kit.castAutocast, then its action of that
 * name), else the generic cast. 'hit' / 'support' when something happened,
 * false when nothing could be cast.
 */
function castOne(fight: Fight, a: Autocast, skill: string, level: number, share: number): 'hit' | 'support' | false {
  if (fight.kit.castAutocast?.(fight, skill, level, share)) { pay(fight, a, null, skill, level); return 'hit'; }
  const act = kitAction(fight, skill);
  // A kit action changes state as it goes (King's Chains spends the counters):
  // a rollout cannot run a share of one, so it runs whole at an even chance
  // or better, else not at all (the Revenant kit's Scythe Reap rule).
  if (act && share < 1 && share < 0.5) return false;
  const prev = fight.procShare ?? 1;
  fight.procShare = act ? prev : prev * share;
  try {
    if (act) {
      pay(fight, a, act, skill, level);
      act.resolve(fight);
      return act.offensive ? 'hit' : 'support';
    }
    const g = generic(skill);
    if (!g) return false;
    pay(fight, a, null, skill, level);
    return g(fight, level, a.self ?? false);
  } finally {
    fight.procShare = prev;
  }
}

function kitAction(fight: Fight, skill: string): Action | null {
  try { return actionById(fight, skill); } catch { return null; }
}

type GenericCast = (fight: Fight, level: number, self: boolean) => 'hit' | 'support' | false;
const genericCache = new Map<string, GenericCast | null>();

/**
 * A skill no kit wrote, cast from its tooltip ratio and its skill_db row:
 * Heal, or one weapon / magic hit (multi-hit skills as the server does them,
 * one roll times the hit count). Null for what this cannot do (buffs,
 * debuffs, traps, misc damage).
 */
function generic(skill: string): GenericCast | null {
  if (genericCache.has(skill)) return genericCache.get(skill)!;
  const g = makeGeneric(skill);
  genericCache.set(skill, g);
  return g;
}

/** Skills a generic cast cannot do: noted once per fighter in the report. */
export function genericGap(skill: string): string | null {
  if (generic(skill)) return null;
  const sk = serverData().skills[iconOf(skill) ?? ''];
  return sk ? `${sk.type === 'None' ? 'no damage' : sk.type} skill, no ratio read` : 'not in the server skill list';
}

function makeGeneric(skill: string): GenericCast | null {
  const aegis = iconOf(skill);
  const sk = serverData().skills[aegis ?? ''];
  const row = skillRows().find((r) => r.name === skill);
  if (aegis === 'AL_HEAL' || skill === 'Heal') {
    return (fight, level) => {
      const f = fight.f;
      heal_(fight, healAmount(f, level) * (1 + (f.healPower ?? 0) / 100) * Math.max(0, 1 + (f.healReceived ?? 0) / 100));
      return 'support';
    };
  }
  if (!sk || !row || (sk.type !== 'Weapon' && sk.type !== 'Magic')) return null;
  const ratio = ratioOf(row);
  if (!ratio) return null;
  return (fight, level) => {
    const f = fight.f; const m = targetNow(fight);
    const hitsRaw = atLevel(sk.hitCount, level) || 1;
    const hits = Math.abs(hitsRaw);
    const pct = ratioAt(ratio.r, level, f.stats) * (ratio.perHit ? hits : 1);
    const elSrv = atLevel(sk.element, level);
    const weaponEl = fight.kit.weaponElement?.(fight) ?? f.weapon?.element ?? 'Neutral';
    const element = elSrv === 'Weapon' || /weapon/i.test(row.element ?? '') ? weaponEl : (row.element ?? elSrv);
    const skillDamage = f.skillMods(skill, 'damage').percent;
    const id = `${skill} (autocast)`;
    const aoe = (atLevel(sk.splash, level) ?? 0) > 0;
    if (sk.type === 'Magic') {
      strike(fight, id, { hits, split: true, canMiss: false, critBonus: null, kind: 'magic', skill: true, aoe,
        damage: () => magicDamage(f, m, { ratio: pct, element, skillDamage, bonus: 0 }, fight.rng) });
      return 'hit';
    }
    const ranged = (atLevel(sk.range, level) ?? 0) >= 5;
    strike(fight, id, { hits, split: true, canMiss: !sk.damageFlags.includes('IgnoreFlee'), critBonus: null,
      kind: ranged ? 'ranged' : 'melee', skill: true, aoe,
      damage: (crit) => physicalDamage(f, m, { ratio: pct, element, statusElement: element, ranged, crit, skillDamage,
        ...(sk.damageFlags.includes('IgnoreDefense') ? { ignoreDef: true } : {}) }, fight.rng) });
    return 'hit';
  };
}

/**
 * A skill's damage ratio from its tooltip: a "Damage: ..." formula, or the
 * older wordings ("Inflicts 100% MATK ... Damage dealt increases by 20% per
 * level", "Damage per hit is 5% per level. Extra 1% damage per INT").
 */
function ratioOf(row: SkillRow): { r: ReturnType<typeof parseRatio> & object; perHit: boolean } | null {
  const desc = row.desc ?? '';
  const perHit = /per hit/i.test(desc);
  const t = parseSkillText(desc, row.max);
  const named = t.formulas.damage ?? t.formulas['damage per hit'] ?? Object.values(t.formulas)[0];
  if (named) return { r: named, perHit };
  const r = { base: 0, perLevel: 0, perStat: {} } as NonNullable<ReturnType<typeof parseRatio>>;
  let found = false;
  const inflict = /inflicts\s+([\d.]+)%\s+(?:MATK|ATK)/i.exec(desc);
  if (inflict) { r.base += Number(inflict[1]); found = true; }
  const perLv = /(?:damage(?: dealt)?(?: per hit)?\s+(?:increases\s+by|is)\s+)([\d.]+)%\s+per\s+level/i.exec(desc);
  if (perLv) { r.perLevel += Number(perLv[1]); found = true; }
  for (const m of desc.matchAll(/(?:extra|additional|\+)\s*([\d.]+)%\s+(?:damage\s+)?per\s+(STR|AGI|VIT|INT|DEX|LUK)\b/gi)) {
    const k = m[2].toLowerCase() as keyof Stats;
    r.perStat[k] = (r.perStat[k] ?? 0) + Number(m[1]); found = true;
  }
  return found ? { r, perHit } : null;
}

/** For a fighter's notes: what each autocast does in words. */
export function describeAutocast(a: Autocast): string {
  const when = a.trigger === 'attack' ? 'when attacking' : a.trigger === 'hit' ? 'when hit' : `on ${a.onSkill}`;
  return `${a.source}: ${(a.chance * 100).toFixed(a.chance < 0.1 ? 1 : 0)}% ${a.skills.join(' + ')} Lv${a.level}${a.randomLevel ? ' (random)' : ''} ${when}${a.self ? ', on self' : ''}${a.paysSp ? ', pays SP' : ''} [${a.from}]`;
}
