/**
 * Reads the Return to Morroc server files (an rAthena renewal fork, the
 * returntomorroc/ snapshot) into combat/data/server-mobs.json: every
 * monster's server stats and its mob_skill_db AI rows, untouched apart from
 * parsing. What each skill *does* lives in combat/data/skill-effects.json
 * and is joined at load time (monster.ts), so that file can be edited
 * without re-running this.
 *
 *   node --experimental-strip-types tools/import-server.ts [path/to/returntomorroc]
 *
 * The snapshot is from 2023-12; the crawl is newer. Where both have a
 * monster, monster.ts keeps the crawl's stats and takes from here only what
 * the crawl lacks: MATK (Attack2), DamageTaken, class and modes, and the AI.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(process.argv[2] ?? resolve(HERE, '../../returntomorroc'));
const OUT = resolve(HERE, '../data/server-mobs.json');

const read = (p: string) => {
  try { return readFileSync(resolve(SERVER, p), 'utf8'); } catch { return ''; }
};

// ---- mob_db.yml ------------------------------------------------------------

export interface ServerMob {
  id: number;
  aegis: string;
  name: string;
  level: number;
  hp: number;
  /** Physical ATK column; rolled 80-120% (status.cpp:3195-3227). */
  attack: number;
  /** MATK column in renewal (mob.cpp:4466-4467). */
  attack2: number;
  def: number;
  mdef: number;
  stats: { str: number; agi: number; vit: number; int: number; dex: number; luk: number };
  attackRange: number;
  /** View range: an aggressive monster notices you this close (mob.cpp:1710, range2). */
  skillRange: number;
  /** It gives up the chase past this (range3). */
  chaseRange: number;
  /**
   * Aegis AI type as a mode mask (mob.hpp e_aegis_monstertype): 0x1 can
   * move, 0x4 aggressive. Ai 06 (0) when absent.
   */
  aiMode: number;
  size: string;
  race: string;
  element: string;
  elementLevel: number;
  walkSpeed: number;
  attackDelay: number;
  attackMotion: number;
  /** Share of every hit it takes, percent (battle.cpp:1832-1836). 100 when absent. */
  damageTaken: number;
  /** "Boss" class ignores Hiding outright (status.cpp:2916-2937). */
  class: string;
  modes: string[];
  skills: AiRow[];
}

/** One mob_skill_db row. Rate and Delay are raw: monster.ts applies the server's 95% / 75%. */
export interface AiRow {
  skill: string;
  skillId: number;
  level: number;
  /** attack, chase, any, idle, follow, angry, walk, dead, loot, anytarget. */
  state: string;
  /** Out of 10000. */
  rate: number;
  castMs: number;
  delayMs: number;
  cancelable: boolean;
  /** target, self, friend, master, randomtarget, around1..8, ... */
  target: string;
  cond: string;
  condValue: string;
  vals: string[];
}

/** Aegis AI types (mob.hpp e_aegis_monstertype). */
const AI_MODES: Record<string, number> = {
  '01': 0x81, '02': 0x83, '03': 0x1089, '04': 0x3885, '05': 0x2085, '06': 0, '07': 0x108B, '08': 0x7085,
  '09': 0x3095, '10': 0x84, '11': 0x84, '12': 0x2085, '13': 0x308D, '17': 0x91, '19': 0x3095, '20': 0x3295,
  '21': 0x3695, '24': 0xA1, '25': 0x1, '26': 0xB695, '27': 0x8084,
};

/**
 * mob_db.yml, read line by line: two-space "- Id:" entries, four-space
 * scalar keys, and the Modes / RaceGroups maps below them. Drops are skipped.
 */
function parseMobDb(text: string): Map<number, ServerMob> {
  const out = new Map<number, ServerMob>();
  let cur: Record<string, any> | null = null;
  let section: string | null = null;
  const flush = () => {
    if (!cur || cur.Id === undefined) return;
    const n = (k: string, d = 0) => (cur![k] === undefined ? d : Number(cur![k]));
    const mob: ServerMob = {
      id: n('Id'),
      aegis: cur.AegisName ?? '',
      name: cur.Name ?? '',
      level: n('Level', 1),
      hp: n('Hp', 1),
      attack: n('Attack'),
      attack2: n('Attack2'),
      def: n('Defense'),
      mdef: n('MagicDefense'),
      // A missing stat is 1 (mob.cpp:4533-4535).
      stats: {
        str: n('Str', 1), agi: n('Agi', 1), vit: n('Vit', 1),
        int: n('Int', 1), dex: n('Dex', 1), luk: n('Luk', 1),
      },
      attackRange: n('AttackRange'),
      skillRange: n('SkillRange'),
      chaseRange: n('ChaseRange'),
      aiMode: AI_MODES[cur.Ai ?? '06'] ?? 0,
      size: cur.Size ?? 'Small',
      race: cur.Race ?? 'Formless',
      element: cur.Element ?? 'Neutral',
      elementLevel: n('ElementLevel', 1),
      walkSpeed: n('WalkSpeed', 150),
      attackDelay: n('AttackDelay'),
      attackMotion: n('AttackMotion'),
      damageTaken: n('DamageTaken', 100),
      class: cur.Class ?? 'Normal',
      modes: cur.Modes ?? [],
      skills: [],
    };
    out.set(mob.id, mob);
  };
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    let m = /^ {2}- Id: (\d+)/.exec(raw);
    if (m) { flush(); cur = { Id: m[1] }; section = null; continue; }
    if (!cur) continue;
    m = /^ {4}(\w+):\s*(.*)$/.exec(raw);
    if (m) {
      section = m[2] === '' ? m[1] : null;
      if (m[2] !== '') cur[m[1]] = m[2].replace(/^"|"$/g, '');
      continue;
    }
    m = /^ {6}(\w+): true/.exec(raw);
    if (m && section === 'Modes') (cur.Modes ??= []).push(m[1]);
  }
  flush();
  return out;
}

// ---- mob_skill_db.txt ------------------------------------------------------

/**
 * The server runs a row by its skill id, not its label: Ifrit's
 * "Ifrit@SA_LANDPROTECTOR" row is id 2299, SC_MANHOLE. Rows are named by
 * the id where skill_db knows it, and each mismatch is listed.
 */
const relabelled: string[] = [];
function parseMobSkills(text: string, mobs: Map<number, ServerMob>, idNames: Record<number, string>) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('//')) continue;
    const c = line.split(',');
    if (c.length < 12) continue;
    const mob = mobs.get(Number(c[0]));
    if (!mob) continue;
    const label = c[1].replace(/^.*@/, '');
    const skill = idNames[Number(c[3])] ?? label;
    if (skill !== label) relabelled.push(`${mob.name || c[0]} (${c[0]}): ${label} -> ${skill} (id ${c[3]})`);
    mob.skills.push({
      skill,
      skillId: Number(c[3]),
      level: Number(c[4]),
      state: c[2],
      rate: Number(c[5]),
      castMs: Number(c[6]),
      delayMs: Number(c[7]),
      cancelable: c[8] === 'yes',
      target: c[9],
      cond: c[10],
      condValue: c[11] ?? '',
      vals: c.slice(12, 17).filter((v) => v !== ''),
    });
  }
}

// ---- skill_db.yml: readable names ------------------------------------------

/** skill_db.yml: id -> aegis name. */
function parseSkillIds(text: string): Record<number, string> {
  const ids: Record<number, string> = {};
  let id: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    let m = /^ {2}- Id: (\d+)/.exec(raw);
    if (m) { id = Number(m[1]); continue; }
    m = /^ {4}Name: (\S+)/.exec(raw);
    if (m && id !== null) { ids[id] = m[1]; id = null; }
  }
  return ids;
}

function parseSkillNames(text: string): Record<string, string> {
  const names: Record<string, string> = {};
  let aegis: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    let m = /^ {2}- Id: /.exec(raw);
    if (m) { aegis = null; continue; }
    m = /^ {4}Name: (\S+)/.exec(raw);
    if (m) { aegis = m[1]; continue; }
    m = /^ {4}Description: (.+)$/.exec(raw);
    if (m && aegis) names[aegis] = m[1].replace(/^"|"$/g, '');
  }
  return names;
}

// ---- attr_fix.yml: the element table ---------------------------------------

const ELEMENT_ORDER = ['Neutral', 'Poison', 'Ghost', 'Undead', 'Fire', 'Earth', 'Wind', 'Water', 'Holy', 'Dark'];

/** Level -> attacker -> [percent vs each defender in ELEMENT_ORDER]. */
function parseAttrFix(text: string): Record<string, Record<string, number[]>> {
  const out: Record<string, Record<string, number[]>> = {};
  let level: string | null = null;
  let atk: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    let m = /^ {2}- Level: (\d+)/.exec(raw);
    if (m) { level = m[1]; out[level] = {}; atk = null; continue; }
    m = /^ {4}(\w+):\s*$/.exec(raw);
    if (m && level) { atk = m[1]; out[level][atk] = ELEMENT_ORDER.map(() => 100); continue; }
    m = /^ {6}(\w+):\s*(-?\d+)/.exec(raw);
    if (m && level && atk) {
      const i = ELEMENT_ORDER.indexOf(m[1]);
      if (i >= 0) out[level][atk][i] = Number(m[2]);
    }
  }
  return out;
}

// ---- refine.yml: weapon ATK per refine -------------------------------------

/** Weapon level -> ATK added at each refine (index = refine), in whole ATK (Bonus/100, floored). */
function parseWeaponRefine(text: string): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  let group: string | null = null;
  let wlv: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    let m = /^ {2}- Group: (\w+)/.exec(raw);
    if (m) { group = m[1]; wlv = null; continue; }
    if (group !== 'Weapon') continue;
    m = /^ {6}- Level: (\d+)/.exec(raw);
    if (m) { wlv = m[1]; out[wlv] = [0]; continue; }
    m = /^ {10}- Level: (\d+)/.exec(raw);
    if (m && wlv) { out[wlv][Number(m[1])] = out[wlv][Number(m[1]) - 1] ?? 0; continue; }
    m = /^ {12}Bonus: (\d+)/.exec(raw);
    if (m && wlv) { const a = out[wlv]; a[a.length - 1] = Math.floor(Number(m[1]) / 100); }
  }
  return out;
}

// ---- job_basepoints.yml: base HP / SP per level ------------------------------

/** Job -> { hp: [by base level], sp: [...] } (index = level). A job can sit in several blocks. */
function parseJobBase(text: string): Record<string, { hp: number[]; sp: number[] }> {
  const out: Record<string, { hp: number[]; sp: number[] }> = {};
  let jobs: string[] = [];
  let section: 'jobs' | 'hp' | 'sp' | null = null;
  let level = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (/^ {2}- Jobs:/.test(raw)) { jobs = []; section = 'jobs'; continue; }
    let m = /^ {4}(\w+):/.exec(raw);
    if (m) { section = m[1] === 'BaseHp' ? 'hp' : m[1] === 'BaseSp' ? 'sp' : null; continue; }
    if (section === 'jobs') {
      m = /^ {6}(\w+): true/.exec(raw);
      if (m) { jobs.push(m[1]); for (const j of jobs) out[j] ??= { hp: [], sp: [] }; }
      continue;
    }
    if (!section) continue;
    m = /^ {6}- Level: (\d+)/.exec(raw);
    if (m) { level = Number(m[1]); continue; }
    m = /^ {8}(Hp|Sp): (\d+)/.exec(raw);
    if (m) for (const j of jobs) out[j][section][level] = Number(m[2]);
  }
  return out;
}

// ---- skill_tree.yml: which server job each RTM class is ----------------------

/** Server job -> the skills its own tree lists (not inherited). */
function parseSkillTree(text: string): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  let job: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    let m = /^ {2}- Job: (\w+)/.exec(raw);
    if (m) { job = m[1]; out[job] ??= new Set(); continue; }
    m = /^ {6}- Name: (\w+)/.exec(raw);
    if (m && job) out[job].add(m[1]);
  }
  return out;
}

/**
 * RTM renames every job; the server keeps rAthena's. A class is the server
 * job whose own tree holds most of the skills the crawl files under that
 * class (the crawl's skill icon is the server's aegis name). Kingslayer ->
 * Shadow_Chaser, Satsujin -> Warlock, Duelist -> Stalker.
 */
function classJobs(tree: Record<string, Set<string>>): Record<string, string> {
  const raw = JSON.parse(readFileSync(resolve(HERE, '../../data/raw/db-skills.json'), 'utf8'));
  const col = (k: string) => raw.cols.indexOf(k);
  const own = new Map<string, Set<string>>();
  for (const r of raw.rows) {
    const cls = raw.classes[r[col('cls')]]; const icon = r[col('icon')];
    if (!cls || !icon) continue;
    (own.get(cls) ?? own.set(cls, new Set()).get(cls)!).add(icon);
  }
  const out: Record<string, string> = {};
  for (const [cls, skills] of own) {
    let best = ''; let score = 0;
    for (const [job, t] of Object.entries(tree)) {
      let n = 0;
      for (const s of skills) if (t.has(s)) n++;
      if (n > score) { score = n; best = job; }
    }
    // Two shared skills are not a job: most of a class's own skills must be there.
    if (best && score >= Math.max(2, skills.size / 3)) out[cls] = best;
  }
  return out;
}

// ---- accessory sides -------------------------------------------------------------

/**
 * item_db Locations for everything worn as an accessory, cards included:
 * Left_Accessory / Right_Accessory / Both_Accessory as the files spell them.
 * The client shows them mirrored, like the weapon hands: Megingjard and
 * Despero Card are Right_Accessory here and left-only in game, drawn on the
 * left of the equipment window (the project owner, 2026-09-28). A one-side
 * card goes only into an accessory worn on that side alone, never into a
 * both-sides one like Arch Ring (the owner, same day).
 */
function parseAccessorySides(texts: string[]): Record<string, 'left' | 'right' | 'both'> {
  const out: Record<string, 'left' | 'right' | 'both'> = {};
  for (const text of texts) {
    let id: number | null = null; let inLoc = false; let locs: string[] = [];
    const flush = () => {
      if (id === null || !locs.some((l) => l.endsWith('_Accessory'))) return;
      const both = locs.includes('Both_Accessory') || (locs.includes('Left_Accessory') && locs.includes('Right_Accessory'));
      out[id] = both ? 'both' : locs.includes('Right_Accessory') ? 'left' : 'right';
    };
    for (const raw of text.split(/\r?\n/)) {
      const m = /^ {2}- Id: (\d+)/.exec(raw);
      if (m) { flush(); id = Number(m[1]); locs = []; inLoc = false; continue; }
      if (/^ {4}Locations:/.test(raw)) { inLoc = true; continue; }
      if (inLoc) {
        const l = /^ {6}(\w+): true/.exec(raw);
        if (l) { locs.push(l[1]); continue; }
        inLoc = false;
      }
    }
    flush();
  }
  return out;
}

// ---- out -------------------------------------------------------------------

const mobs = parseMobDb(read('db/re/mob_db.yml'));
for (const [id, m] of parseMobDb(read('db/import/mob_db.yml'))) mobs.set(id, m);
const skillIds = parseSkillIds(read('db/re/skill_db.yml'));
parseMobSkills(read('db/re/mob_skill_db.txt'), mobs, skillIds);
parseMobSkills(read('db/import/mob_skill_db.txt'), mobs, skillIds);
if (relabelled.length) console.log(`rows named by skill id, not label (${relabelled.length}):\n  ${relabelled.join('\n  ')}`);
const skillNames = parseSkillNames(read('db/re/skill_db.yml'));

if (mobs.size === 0) throw new Error(`no monsters read from ${SERVER}`);

const used = new Set([...mobs.values()].flatMap((m) => m.skills.map((s) => s.skill)));
const doc = {
  _about: [
    'Generated by combat/tools/import-server.ts from the returntomorroc/ server snapshot (rAthena fork, files up to 2023-12). Do not edit by hand: re-run the tool.',
    'Stats are the snapshot\'s; the live server has changed some since (Heartless HP, the Jormungandr set). monster.ts prefers the crawl for anything the crawl has.',
    'skills are raw mob_skill_db rows: rate out of 10000 and delay before the server\'s mob_skill_rate 95 / mob_skill_delay 75.',
  ],
  mobs: Object.fromEntries([...mobs.values()].map((m) => [m.id, m])),
  skillNames: Object.fromEntries(Object.entries(skillNames).filter(([k]) => used.has(k))),
};
writeFileSync(OUT, `${JSON.stringify(doc)}\n`);

const sides = parseAccessorySides(['db/re/item_db_etc.yml', 'db/re/item_db_equip.yml', 'db/import/item_db.yml']
  .map((f) => { try { return read(f); } catch { return ''; } }));
const sidesOut = resolve(HERE, '../data/accessory-sides.json');
writeFileSync(sidesOut, `${JSON.stringify({
  _about: 'Generated by combat/tools/import-server.ts from the server item_db Locations: which accessory side an item or card goes on, in the CLIENT\'s words (the files spell them mirrored). A one-side card goes only into an accessory of that side alone. Items missing here are newer than the 2023 snapshot.',
  sides,
})}\n`);
console.log(`${Object.keys(sides).length} accessories and accessory cards -> ${sidesOut}`);
console.log(`${mobs.size} monsters, ${[...mobs.values()].reduce((n, m) => n + m.skills.length, 0)} skill rows -> ${OUT}`);

// The element table: db/import/attr_fix.yml overrides db/re/ (the server's own, 2023-03).
const attr = parseAttrFix(read('db/import/attr_fix.yml') || read('db/re/attr_fix.yml'));
if (Object.keys(attr).length !== 4) throw new Error('attr_fix.yml: expected levels 1-4');
const attrOut = resolve(HERE, '../data/element-table.json');
writeFileSync(attrOut, `${JSON.stringify({
  _about: [
    'Generated by combat/tools/import-server.ts from the server\'s db/import/attr_fix.yml. Rows attack, columns defend (in `order`), percent of the hit.',
    'Every level has its own table. Monsters defend at their own element level; a player always defends at level 1.',
    'The project owner (2026-09-26): the server is likely right where it differs from the chart they had.',
  ],
  order: ELEMENT_ORDER,
  levels: attr,
}, null, 1)}\n`);

const refine = parseWeaponRefine(read('db/re/refine.yml'));
const jobBase = parseJobBase(read('db/re/job_basepoints.yml'));
for (const [j, v] of Object.entries(parseJobBase(read('db/import/job_basepoints.yml')))) {
  jobBase[j] = { hp: v.hp.length ? v.hp : jobBase[j]?.hp ?? [], sp: v.sp.length ? v.sp : jobBase[j]?.sp ?? [] };
}
const tablesOut = resolve(HERE, '../data/server-tables.json');
writeFileSync(tablesOut, `${JSON.stringify({
  _about: [
    'Generated by combat/tools/import-server.ts from the server\'s db/re/refine.yml.',
    'weaponRefineAtk[weapon level][refine] = ATK the refine adds (Bonus/100, floored; RTM status.cpp:4354).',
    'Job HP / SP tables are in data/jobs.json, shared with the arsenal.',
  ],
  weaponRefineAtk: refine,
})}\n`);
console.log(`element table (4 levels) -> ${attrOut}; weapon refine (levels ${Object.keys(refine).join(',')}) -> ${tablesOut}`);

// The planner's copy: each class's job and that job's HP / SP tables, for
// Max HP and Max SP in the arsenal (sim/src/derived.ts).
const classes = classJobs(parseSkillTree(read('db/re/skill_tree.yml')));
const usedJobs = new Set(Object.values(classes));
const jobsOut = resolve(HERE, '../../data/jobs.json');
writeFileSync(jobsOut, `${JSON.stringify({
  _about: [
    'Generated by combat/tools/import-server.ts from the server snapshot (returntomorroc/, 2023-12).',
    'classes: RTM class -> the server job it is built on (the job whose own skill tree holds the class\'s skills).',
    'jobs[job].hp / .sp [base level]: base HP / SP before VIT / INT (RTM status.cpp:4031, 4040).',
  ],
  classes,
  jobs: Object.fromEntries(Object.entries(jobBase).filter(([j]) => usedJobs.has(j))),
})}\n`);
console.log(`${Object.keys(classes).length} classes -> server jobs -> ${jobsOut}`);
