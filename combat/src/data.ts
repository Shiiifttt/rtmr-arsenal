/**
 * Everything the combat sim reads from disk, loaded once.
 *
 * The planner's dataset (items, sets, stat registry) comes in exactly as the
 * web app loads it, so a build here totals to the same numbers the arsenal
 * shows. Skills and monsters come from the crawled site payloads in
 * data/raw, which are columnar; they are turned into plain objects here so
 * nothing downstream has to know the column order.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindBaseStatIds } from '../../sim/src/index.ts';
import type {
  ClassRules, Dataset, Item, JobTables, RollData, SetRecord, StatDef,
} from '../../sim/src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../..');
const DATA = resolve(REPO, 'data');
export const COMBAT_DATA = resolve(HERE, '../data');

export const readJSON = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const load = <T>(p: string): T => readJSON<T>(resolve(DATA, p));
const tryLoad = <T>(p: string): T | null => {
  try { return load<T>(p); } catch { return null; }
};

// ---- planner dataset -------------------------------------------------------

let dataset: Dataset | null = null;

export function plannerDataset(): Dataset {
  if (dataset) return dataset;
  const itemList = load<Item[]>('items/all.json');
  const stats = load<StatDef[]>('stats.json');
  bindBaseStatIds(stats);
  dataset = {
    items: new Map(itemList.map((i) => [i.id, i])),
    itemList,
    sets: load<SetRecord[]>('sets/all.json'),
    stats,
    statById: new Map(stats.map((s) => [s.id, s])),
    classes: load<string[]>('classes.json'),
    classRules: tryLoad<ClassRules>('class-rules.json'),
    rolls: tryLoad<RollData>('rolls.json'),
    jobs: tryLoad<JobTables>('jobs.json'),
  };
  return dataset;
}

// ---- skills ----------------------------------------------------------------

export interface SkillRow {
  key: string;
  name: string;
  className: string;
  type: string;
  max: number;
  /** The server's tooltip: the source of truth (the project owner, 2026-09-26). */
  desc: string;
  /** The site's secondary block. Often stale; kept only for reference. */
  numbers: string;
  sp: number[];
  range: number[];
  element: string | null;
  kind: string | null;
  hits: number;
  traits: string[];
  weapons: string[];
}

let skills: SkillRow[] | null = null;

export function skillRows(): SkillRow[] {
  if (skills) return skills;
  const raw = load<any>('raw/db-skills.json');
  const col = (name: string) => raw.cols.indexOf(name);
  const at = (r: unknown[], name: string) => r[col(name)] as any;
  skills = (raw.rows as unknown[][]).map((r) => ({
    key: at(r, 'key'),
    name: at(r, 'name'),
    className: raw.classes[at(r, 'cls')],
    type: raw.types[at(r, 'type')],
    max: at(r, 'max'),
    desc: at(r, 'desc') ?? '',
    numbers: at(r, 'numbers') ?? '',
    sp: at(r, 'sp') ?? [],
    range: at(r, 'range') ?? [],
    element: at(r, 'elem') >= 0 ? raw.elements[at(r, 'elem')] : null,
    kind: at(r, 'kind') >= 0 ? raw.kinds[at(r, 'kind')] : null,
    hits: at(r, 'hits') ?? 0,
    traits: (at(r, 'traits') ?? []).map((t: number) => raw.traitNames[t]),
    weapons: (at(r, 'wep') ?? []).map((w: number) => raw.weapons[w]),
  }));
  return skills;
}

/**
 * A skill by name, preferring the given classes in order: several classes
 * share a name (Shadow Slash is Assassin's and Unchained Thief's) and the
 * tooltips can differ between them.
 */
export function skillRow(name: string, classes: string[]): SkillRow {
  const rows = skillRows().filter((s) => s.name === name);
  for (const c of classes) {
    const hit = rows.find((r) => r.className === c);
    if (hit) return hit;
  }
  if (rows[0]) return rows[0];
  throw new Error(`no skill named "${name}" in data/raw/db-skills.json`);
}

// ---- monsters --------------------------------------------------------------

export interface MobRow {
  id: number;
  name: string;
  level: number;
  hp: number;
  size: string;
  race: string;
  element: string;
  elementLevel: number;
  mvp: boolean;
  atk: number;
  def: number;
  mdef: number;
  hit: number;
  flee: number;
  /** Attack range in cells. */
  reach: number;
  /** Walk speed: ms per cell. */
  walk: number;
  /** Attack delay in ms: the gap between two normal attacks. */
  adelay: number;
  stats: { str: number; agi: number; vit: number; int: number; dex: number; luk: number };
  traits: string[];
  maps: string[];
}

// The element table is not read from here: the crawl's differs from the
// server's, which lives in combat/data/element-table.json (see formulas.attrFix).
let mobs: { rows: MobRow[] } | null = null;

function mobData() {
  if (mobs) return mobs;
  const raw = load<any>('raw/db-mobs.json');
  const col = (name: string) => raw.cols.indexOf(name);
  const at = (r: unknown[], name: string) => r[col(name)] as any;
  const rows: MobRow[] = (raw.rows as unknown[][]).map((r) => {
    const [str, agi, vit, int, dex, luk] = at(r, 'stats') ?? [0, 0, 0, 0, 0, 0];
    return {
      id: at(r, 'id'),
      name: at(r, 'name'),
      level: at(r, 'lv'),
      hp: at(r, 'hp'),
      size: raw.sizes[at(r, 'size')],
      race: raw.races[at(r, 'race')],
      element: raw.elements[at(r, 'element')],
      elementLevel: at(r, 'elv'),
      mvp: !!at(r, 'mvp'),
      atk: at(r, 'atk'),
      def: at(r, 'def'),
      mdef: at(r, 'mdef'),
      hit: at(r, 'hit'),
      flee: at(r, 'flee'),
      reach: at(r, 'reach'),
      walk: at(r, 'walk'),
      adelay: at(r, 'adelay'),
      stats: { str, agi, vit, int, dex, luk },
      traits: (at(r, 'traits') ?? []).map((t: number) => raw.traitnames[t]),
      maps: at(r, 'codes') ?? [],
    };
  });
  mobs = { rows };
  return mobs;
}

export const mobRows = (): MobRow[] => mobData().rows;

/**
 * Monster groups the sim knows by name. Map codes, not zone names: the
 * crawl's codes are what the monster rows carry.
 */
export const MOB_GROUPS: Record<string, string[]> = {
  // "rachel_ss" to the project owner; the server's code is rachelnm_e.
  rachel_ss: ['rachelnm_e'],
  jorm: ['jor_core', 'jor_nest01', 'jor_nest02'],
  // The distortions, by the server's own warp script (npc/re/warps/distortiontemp.txt):
  // "Gorge Distortion" -> moc_fild20, the Dimensional Gorge.
  gorge: ['moc_fild20', 'moc_fild21', 'moc_fild22'],
  // "Paradise Distortion" -> tha_para01: Thanatos Paradise up to its summit.
  thanatos: ['tha_para01', 'tha_para02', 'tha_para03', 'tha_para04', 'tha_para05', 'tha_para06', 'tha_para07', 'tha_para08'],
  // "Rachel Distortion" (from Freya's Sacred Precinct) -> ra_dun00: the Hidden Temple and Goddess Freya's chambers.
  freya: ['ra_dun00', 'ra_dun01', 'ra_dun02'],
  // Tomb of Kings: Lost Island Tomb, King Schmidt and the five Knights (the project owner, 2026-09-26).
  tomb: ['lost_dun03'],
  // The guild dungeon: Ymir's War Castle (Guild Master, Soul of Ymir).
  guild: ['guild_falld'],
  // Farming areas (the project owner, 2026-09-28): Rachel Sanctuary (the
  // non-distortion one, "Freya's Sacred Precinct"), Varmundt's mansion
  // (codexes, cavaliers), the orcs.
  rachel_sanctuary: ['ra_san01', 'ra_san02', 'ra_san03', 'ra_san04', 'ra_san05'],
  varmundt: ['va_dun01', 'va_dun02', 'va_dun03', 'va_dun04'],
  orcs: ['orcsdun01', 'orcsdun02', 'gef_fild14'],
  // Newer than the 2023 server snapshot: no AI for these yet, normal attacks only.
  ama_ss: ['ama_ss'],
  valhalla: ['val_dun01', 'val_dun02'],
};

/**
 * Monsters on those maps that do not (no boss-protocol icon in game): the
 * project owner, 2026-09-27.
 */
export const NOT_BOSS_PROTOCOL = ['Heartless'];

/** Maps whose monsters run the boss protocol (the project owner, 2026-09-26). */
export const BOSS_PROTOCOL_MAPS = [...MOB_GROUPS.rachel_ss, ...MOB_GROUPS.jorm];

/** Monsters matching an id, a name, or a group ("rachel_ss", "jorm"). */
export function findMobs(query: string): MobRow[] {
  const rows = mobRows();
  const q = query.trim().toLowerCase();
  const group = MOB_GROUPS[q];
  // Shadow placeholders ("Rank S Shadow", 50 HP, level 1) sit on every map.
  const real = (m: MobRow) => m.hp > 1000;
  if (group) return rows.filter((m) => real(m) && m.maps.some((c) => group.includes(c)));
  if (/^\d+$/.test(q)) return rows.filter((m) => m.id === Number(q));
  const exact = rows.filter((m) => m.name.toLowerCase() === q);
  return exact.length ? exact : rows.filter((m) => m.name.toLowerCase().includes(q));
}
