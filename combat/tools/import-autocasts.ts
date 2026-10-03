/**
 * Reads what the server says about autocasts into combat/data/server-autocasts.json:
 *
 *   - items: every bAutoSpell / bAutoSpellWhenHit / bAutoSpellOnSkill line in
 *     the item scripts (db/re/item_db_*.yml, db/import/item_db.yml), with the
 *     script's own variables (`.@r = getrefine();`) and the `if` it sits under,
 *     as raw script expressions -- autocast.ts evaluates them for a build.
 *   - skills: the skill_db rows the sim needs to cast a skill nobody wrote a
 *     kit action for -- type (Weapon / Magic / Misc), target, element, hit
 *     count, after-cast delay and damage flags, per level where they vary.
 *
 *   node --experimental-strip-types tools/import-autocasts.ts [path/to/returntomorroc]
 *
 * The snapshot is 2023-12 and the crawl is newer, so autocast.ts takes the
 * live crawl's item list, levels and chances first and reads this for what
 * the crawl has no column for: the trigger flags (bonus5's BF_ mask), the
 * target / random-level / pays-SP flag bits and chance formulas.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(process.argv[2] ?? resolve(HERE, '../../returntomorroc'));
const OUT = resolve(HERE, '../data/server-autocasts.json');

const read = (p: string) => {
  try { return readFileSync(resolve(SERVER, p), 'utf8'); } catch { return ''; }
};

// ---- item scripts ----------------------------------------------------------

/** One autospell bonus as the script writes it: expressions are the script's own text. */
export interface ServerAutospell {
  /** bAutoSpell (when attacking), bAutoSpellWhenHit, bAutoSpellOnSkill. */
  bonus: 'bAutoSpell' | 'bAutoSpellWhenHit' | 'bAutoSpellOnSkill';
  /** bonus3 / bonus4 / bonus5: which arguments there are (pc.cpp:4501-4896). */
  arity: number;
  skill: string;
  /** OnSkill: the skill whose use triggers it. */
  onSkill?: string;
  lv: string;
  /** Per 1000 (skill.cpp:2474 rnd()%1000). */
  rate: string;
  /** bonus5 bAutoSpell / WhenHit: the BF_ mask. */
  bf?: string;
  /** bonus4 / bonus5: AUTOSPELL_FORCE_* bits (and RTM's 4: OnSkill pays SP). */
  flag?: string;
  /** The `if` conditions it sits under, outermost first. */
  cond: string[];
}

/** One item's autospells and the script variables they read. */
interface ItemAutospells { vars: Record<string, string>; spells: ServerAutospell[] }

/** Split a bonus's argument list at top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = []; let depth = 0; let cur = ''; let q = false;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && depth === 0 && ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const unquote = (s: string) => s.replace(/^"|"$/g, '');

function parseStatement(stmt: string, cond: string[]): ServerAutospell | null {
  const m = /^bonus([345])\s+(bAutoSpell(?:WhenHit|OnSkill)?)\s*,(.*)$/.exec(stmt.trim().replace(/;$/, ''));
  if (!m) return null;
  const arity = Number(m[1]);
  const bonus = m[2] as ServerAutospell['bonus'];
  const a = splitArgs(m[3]);
  if (bonus === 'bAutoSpellOnSkill') {
    // bonus4 src,sk,lv,rate / bonus5 src,sk,lv,rate,flag (pc.cpp:4775, 4893).
    return { bonus, arity, onSkill: unquote(a[0]), skill: unquote(a[1]), lv: a[2], rate: a[3], ...(arity === 5 ? { flag: a[4] } : {}), cond };
  }
  // bonus3 sk,lv,rate / bonus4 sk,lv,rate,flag / bonus5 sk,lv,rate,bf,flag.
  return {
    bonus, arity, skill: unquote(a[0]), lv: a[1], rate: a[2],
    ...(arity === 4 ? { flag: a[3] } : {}), ...(arity === 5 ? { bf: a[3], flag: a[4] } : {}), cond,
  };
}

/**
 * The autospells in one item's Script block. Conditions are tracked for
 * one-line `if (c) bonus...;` and for `if (c) {` blocks (an `else` block gets
 * the negation); anything fancier is read as unconditional.
 */
function parseScript(lines: string[]): ItemAutospells {
  const vars: Record<string, string> = {};
  const spells: ServerAutospell[] = [];
  const stack: string[] = [];
  let last = '';
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    for (const v of line.matchAll(/\.@(\w+)\s*=\s*([^;=][^;]*);/g)) vars[v[1]] ??= v[2].trim();
    const closes = (line.match(/}/g) ?? []).length;
    const elseBlock = /^}\s*else\s*{/.test(line);
    if (elseBlock) { stack.pop(); stack.push(`!(${last})`); continue; }
    for (let i = 0; i < closes && !/{\s*$/.test(line); i++) stack.pop();
    const ifBlock = /^(?:}\s*else\s+)?if\s*\((.*)\)\s*{\s*$/.exec(line);
    if (ifBlock) { if (/^}/.test(line)) stack.pop(); stack.push(ifBlock[1]); last = ifBlock[1]; continue; }
    const oneLine = /^if\s*\((.*?)\)\s*(bonus[345]\s+bAutoSpell.*)$/.exec(line);
    const stmts = oneLine ? [oneLine[2]] : line.split(/;\s*/).filter((s) => /^bonus[345]\s+bAutoSpell/.test(s.trim()));
    for (const s of stmts) {
      const sp = parseStatement(s, oneLine ? [...stack, oneLine[1]] : [...stack]);
      if (sp) spells.push(sp);
    }
  }
  return { vars, spells };
}

function parseItems(text: string, out: Record<number, ItemAutospells>) {
  let id: number | null = null;
  let script: string[] | null = null;
  const flush = () => {
    if (id !== null && script && script.some((l) => /bAutoSpell/.test(l))) {
      const p = parseScript(script);
      if (p.spells.length) out[id] = p;
    }
    script = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const m = /^ {2}- Id: (\d+)/.exec(raw);
    if (m) { flush(); id = Number(m[1]); continue; }
    if (/^ {4}Script: \|/.test(raw)) { script = []; continue; }
    if (script) {
      if (/^ {6}/.test(raw) || raw.trim() === '') script.push(raw);
      else flush();
    }
  }
  flush();
}

// ---- skill_db.yml ------------------------------------------------------------

/** What casting a skill does, server side, per level where it varies (index 0 = Lv1). */
export interface ServerSkill {
  id: number;
  name: string;
  type: 'Weapon' | 'Magic' | 'Misc' | 'None';
  target: string;
  element: string | string[];
  hitCount: number | number[];
  /** After-cast delay, ms: an autocast still pays it (skill.cpp:2516-2526). */
  acd: number | number[];
  range: number | number[];
  damageFlags: string[];
  splash: number | number[];
  /** Self-targeted (Self) or a support skill: an autocast lands on the caster (pc.cpp:4504). */
  inf2: string[];
}

function parseSkillDb(text: string): Record<string, ServerSkill> {
  const out: Record<string, ServerSkill> = {};
  type Raw = Record<string, unknown>;
  let cur: Raw | null = null;
  let key: string | null = null; // a 4-space key whose value is a list or map below it
  let entry: Record<string, string> | null = null;
  const flush = () => {
    if (!cur || !cur.Name) return;
    const levels = (v: unknown, field: string, dflt: number | string) => {
      if (Array.isArray(v)) {
        const max = Number(cur!.MaxLevel ?? v.length);
        const arr: (number | string)[] = [];
        let prev: number | string = dflt;
        const byLv = new Map(v.map((e: Record<string, string>) => [Number(e.Level), e[field]]));
        for (let l = 1; l <= max; l++) {
          const x = byLv.get(l);
          if (x !== undefined) prev = typeof dflt === 'number' ? Number(x) : x;
          arr.push(prev);
        }
        return arr;
      }
      if (v === undefined) return dflt;
      return typeof dflt === 'number' ? Number(v) : String(v);
    };
    out[String(cur.Name)] = {
      id: Number(cur.Id),
      name: String(cur.Description ?? cur.Name).replace(/^"|"$/g, ''),
      type: (cur.Type as ServerSkill['type']) ?? 'None',
      target: String(cur.TargetType ?? 'Passive'),
      element: levels(cur.Element, 'Element', 'Neutral') as string | string[],
      hitCount: levels(cur.HitCount, 'Count', 1) as number | number[],
      acd: levels(cur.AfterCastActDelay, 'Time', 0) as number | number[],
      range: levels(cur.Range, 'Size', 0) as number | number[],
      splash: levels(cur.SplashArea, 'Area', 0) as number | number[],
      damageFlags: Object.keys((cur.DamageFlags as Raw) ?? {}),
      inf2: Object.keys((cur.Flags as Raw) ?? {}),
    };
  };
  for (const line of text.split(/\r?\n/)) {
    let m = /^ {2}- Id: (\d+)/.exec(line);
    if (m) { flush(); cur = { Id: m[1] }; key = null; entry = null; continue; }
    if (!cur) continue;
    m = /^ {4}(\w+):\s*(.*)$/.exec(line);
    if (m) {
      if (m[2] === '') { key = m[1]; cur[key] = undefined; entry = null; } else { key = null; cur[m[1]] = m[2].trim(); }
      continue;
    }
    if (!key) continue;
    m = /^ {6}- (\w+):\s*(.*)$/.exec(line);
    if (m) {
      entry = { [m[1]]: m[2].trim() };
      cur[key] = [...((cur[key] as unknown[]) ?? []), entry];
      continue;
    }
    m = /^ {8}(\w+):\s*(.*)$/.exec(line);
    if (m && entry) { entry[m[1]] = m[2].trim(); continue; }
    m = /^ {6}(\w+):\s*(.*)$/.exec(line);
    if (m) {
      const map = (cur[key] && !Array.isArray(cur[key]) ? cur[key] : {}) as Raw;
      map[m[1]] = m[2].trim();
      cur[key] = map;
    }
  }
  flush();
  return out;
}

// ---- out -------------------------------------------------------------------

const items: Record<number, ItemAutospells> = {};
for (const f of ['db/re/item_db_equip.yml', 'db/re/item_db_etc.yml', 'db/re/item_db_usable.yml', 'db/import/item_db.yml']) {
  parseItems(read(f), items);
}
const skills = { ...parseSkillDb(read('db/re/skill_db.yml')), ...parseSkillDb(read('db/import/skill_db.yml')) };
if (!Object.keys(skills).length) throw new Error(`no skills read from ${SERVER}`);

// Only the skills a player could be made to cast: the crawl's (icon = Aegis
// name) and every one an item script names.
const crawl = JSON.parse(readFileSync(resolve(HERE, '../../data/raw/db-skills.json'), 'utf8'));
const iconCol = crawl.cols.indexOf('icon');
const wanted = new Set<string>(crawl.rows.map((r: unknown[]) => r[iconCol]).filter(Boolean));
for (const it of Object.values(items)) for (const s of it.spells) { wanted.add(s.skill); if (s.onSkill) wanted.add(s.onSkill); }

writeFileSync(OUT, `${JSON.stringify({
  _about: [
    'Generated by combat/tools/import-autocasts.ts from the returntomorroc/ server snapshot (2023-12). Do not edit by hand: re-run the tool.',
    'items: each item\'s bAutoSpell / bAutoSpellWhenHit / bAutoSpellOnSkill bonuses as raw script expressions (rate per 1000), the script variables and the if conditions they sit under. autocast.ts evaluates them per build.',
    'skills: skill_db rows (type, target, element, hit count, after-cast delay, damage flags; arrays are per level) for every skill the crawl lists and every skill an item script names.',
  ],
  items,
  skills: Object.fromEntries(Object.entries(skills).filter(([k]) => wanted.has(k))),
})}\n`);
console.log(`${Object.keys(items).length} items with autospells, ${[...wanted].filter((k) => skills[k]).length} skills -> ${OUT}`);
