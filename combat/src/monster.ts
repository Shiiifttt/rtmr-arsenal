/**
 * A monster: its crawled row, plus what the server snapshot knows and the
 * crawl does not -- MATK, DamageTaken, class and modes, and its skill AI.
 *
 * Three files meet here:
 *   - data/raw/db-mobs.json (the crawl): stats. Newer than the snapshot, so it wins.
 *   - combat/data/server-mobs.json (tools/import-server.ts): the server's
 *     mob_db and mob_skill_db rows -- when and how often each skill is tried.
 *   - combat/data/skill-effects.json: what each skill does, read from the
 *     server's battle.cpp / skill.cpp / status.cpp.
 * and combat/data/mob-skills.json lays the project owner's in-game findings
 * over the top.
 */
import { resolve } from 'node:path';

import { BOSS_PROTOCOL_MAPS, COMBAT_DATA, NOT_BOSS_PROTOCOL, PROTOCOL_COUNTS_AS_BOSS_MAPS, readJSON, type MobRow } from './data.ts';
import { mobSoftDef, mobSoftMdef, TUNE } from './formulas.ts';
import type { MobSkill, Monster, SelfBuff, Stats, StatusEffect } from './model.ts';

// ---- the files -------------------------------------------------------------

interface ServerMob {
  id: number; name: string; level: number; hp: number; attack: number; attack2: number;
  def: number; mdef: number; stats: Stats; attackRange: number; size: string; race: string;
  element: string; elementLevel: number; attackDelay: number; damageTaken: number;
  class: string; modes: string[]; skills: AiRow[];
}
interface AiRow {
  skill: string; skillId: number; level: number; state: string; rate: number; castMs: number;
  delayMs: number; cancelable: boolean; target: string; cond: string; condValue: string; vals: string[];
}

type Ratio = number | ({ base?: number; lv?: number; baseLvScale?: boolean } & Partial<Stats>);
interface Effect {
  kind: MobSkill['kind'];
  element?: string;
  ratio?: Ratio;
  ratioAfterFirst?: number;
  flat?: number;
  flatCasterHpDiv?: number;
  hits?: number;
  ticks?: number;
  tickMs?: number;
  area?: 'single' | 'splash' | 'ground' | 'self';
  radius?: number;
  centeredOnSelf?: boolean;
  ignoreFlee?: boolean;
  ignoreDef?: boolean;
  alwaysCrit?: boolean;
  hitBonus?: number;
  drain?: boolean;
  hiddenImmune?: boolean;
  hideBlocks?: boolean;
  status?: StatusEffect[];
  self?: SelfBuff;
  /**
   * flat / pctMaxHp, or Heal's level formula: floor(floor((base + lv x Level
   * + int x INT)/div) x mul), plus the caster's MATK (plusMatk).
   */
  heal?: {
    flat?: number; pctMaxHp?: number;
    base?: number; lv?: number; int?: number; div?: number; mul?: number; plusMatk?: unknown;
  };
  summon?: { mobIds?: number[]; count?: number };
  note?: string;
}

/**
 * How much a monster heals: a flat amount, a share, or Heal's formula. For
 * a monster the MATK part averages INT + level + 2 x Attack2 (base MATK and
 * weapon MATK both come from Attack2; RTM status.cpp:3232-3265, skill.cpp:686-712).
 */
function healOf(h: Effect['heal'], mob: { stats: Stats; level: number; matk: number }): MobSkill['heal'] {
  if (!h) return undefined;
  if (h.flat !== undefined || h.pctMaxHp !== undefined) return { flat: h.flat, pctMaxHp: h.pctMaxHp };
  if (h.base === undefined) return undefined;
  const raw = Math.floor((h.base + (h.lv ?? 0) * mob.level + (h.int ?? 0) * mob.stats.int) / (h.div ?? 1));
  const matk = h.plusMatk ? mob.stats.int + mob.level + 2 * mob.matk : 0;
  return { flat: Math.floor(raw * (h.mul ?? 1)) + matk };
}

type ServerFile = { mobs: Record<string, ServerMob>; skillNames: Record<string, string> };
type EffectFile = Record<string, { name: string; levels: Record<string, Effect> }>;
type OverrideFile = {
  skills: Record<string, Partial<MobSkill>>;
  mobs: Record<string, Record<string, Partial<MobSkill>>>;
  notes: Record<string, string>;
};
let server: ServerFile | undefined;
let effects: EffectFile | undefined;
let overrides: OverrideFile | undefined;

const serverData = (): ServerFile => (server ??= readJSON<ServerFile>(resolve(COMBAT_DATA, 'server-mobs.json')));
const effectData = (): EffectFile => (effects ??= readJSON<EffectFile>(resolve(COMBAT_DATA, 'skill-effects.json')));
const overrideData = (): OverrideFile => (overrides ??= readJSON<OverrideFile>(resolve(COMBAT_DATA, 'mob-skills.json')));

/**
 * The server row for a crawled monster. The live server renumbered some
 * (Njord Zealot is 21606 in the crawl, 2655 in the snapshot), so the name
 * decides, then the nearest level; the same id wins a tie.
 */
export function serverMobFor(row: Pick<MobRow, 'id' | 'name' | 'level'>): ServerMob | null {
  const all = Object.values(serverData().mobs).filter((m) => m.name === row.name);
  if (all.length === 0) return null;
  return all.sort((a, b) => (Math.abs(a.level - row.level) - Math.abs(b.level - row.level))
    || (a.id === row.id ? -1 : b.id === row.id ? 1 : 0))[0];
}

export const serverMobById = (id: number): ServerMob | null => serverData().mobs[id] ?? null;

// ---- skills ----------------------------------------------------------------

/** base + coef x stat + lv x level, then x level/100 if it scales with base level. */
function ratioOf(r: Ratio | undefined, stats: Stats, level: number): number {
  if (r === undefined) return 100;
  if (typeof r === 'number') return r;
  let v = r.base ?? 0;
  for (const k of ['str', 'agi', 'vit', 'int', 'dex', 'luk'] as const) v += (r[k] ?? 0) * stats[k];
  v += (r.lv ?? 0) * level;
  return r.baseLvScale ? (v * level) / 100 : v;
}

/** The effect at this level, or the nearest level researched below it (then above). */
function effectAt(skill: string, level: number): { e: Effect; name: string; exact: boolean } | null {
  const entry = effectData()[skill];
  if (!entry) return null;
  const lvls = Object.keys(entry.levels).map(Number).sort((a, b) => a - b);
  if (entry.levels[level]) return { e: entry.levels[level], name: entry.name, exact: true };
  const below = lvls.filter((l) => l <= level).pop() ?? lvls[0];
  return below === undefined ? null : { e: entry.levels[below], name: entry.name, exact: false };
}

/**
 * One AI row made into something the engine runs. The server scales every
 * rate by mob_skill_rate 95% and every delay by mob_skill_delay 75%
 * (conf/battle/monster.conf; mob.cpp:5680-5833).
 */
export function resolveSkill(
  row: AiRow, mob: { name: string; stats: Stats; level: number; matk: number },
): MobSkill {
  const found = effectAt(row.skill, row.level);
  // Manhole digs a hole the player may step into (engine.ts enterManhole):
  // nothing lands on anyone when it is cast.
  const e: Effect = row.skill === 'SC_MANHOLE' ? { kind: 'none', area: 'self' } : found?.e ?? { kind: 'unknown' };
  const name = found?.name ?? serverData().skillNames[row.skill] ?? row.skill;
  const kind = e.kind ?? 'unknown';
  const type: MobSkill['type'] = kind === 'physical' || kind === 'magic' || kind === 'status' ? kind : 'none';
  const area = e.area ?? (kind === 'self' || kind === 'heal' || kind === 'summon' ? 'self' : 'single');
  const targets: MobSkill['targets'] = area === 'self' ? 'self' : area === 'single' ? 'single' : 'aoe';
  const ticks = Math.max(1, e.ticks ?? 1);
  const tickMs = e.tickMs ?? 0;

  // Hiding dodges monster skills on the live server (the project owner,
  // 2026-09-26), though the 2023 code let Boss/Detector monsters and the
  // status-only splashes through; skill-effects.json records that older
  // rule, so it is not read here. mob-skills.json can switch one off.
  const hideBlocks = true;
  // Walking out works on an area left on the ground, or a burst around the
  // monster small enough to step out of; a splash centred on you follows
  // you. The TAS still checks the cast bar leaves time to do it.
  const walkable = targets === 'aoe'
    && (area === 'ground' || (!!e.centeredOnSelf && (e.radius ?? 3) <= 4));
  const avoid: MobSkill['avoid'] = [];
  if (hideBlocks) avoid.push('hide');
  if (walkable) avoid.push('walk');
  if (type === 'physical') avoid.push('kawarimi');
  // A cast aimed at you needs a line to you when it ends (RTM skill_castend_id):
  // the single-target spells, and a splash aimed at you (Adoramus), not one
  // centred on the caster.
  const aimed = targets === 'single' || (area === 'splash' && !e.centeredOnSelf);
  if (type === 'magic' && aimed) avoid.push('los');
  // Magic Rod eats any magic the caster lands itself (src == dsrc, RTM
  // skill.cpp skill_attack): single and splash, not a ground unit's waves.
  if (type === 'magic' && (area === 'single' || area === 'splash')) avoid.push('rod');

  const perm = row.rate > 0 ? Math.max(1, Math.min(10000, Math.floor((row.rate * 95) / 100))) : 0;
  const notes: string[] = [];
  if (!found) notes.push('no effect data: it only costs the monster its cast');
  else if (!found.exact) notes.push(`effect read at a nearby level, not ${row.level}`);
  if (e.note) notes.push(e.note);

  const skill: MobSkill = {
    name,
    skill: row.skill,
    skillId: row.skillId,
    level: row.level,
    kind,
    type,
    element: e.element ?? 'Neutral',
    targets,
    ratio: ratioOf(e.ratio, mob.stats, mob.level),
    ratioAfterFirst: e.ratioAfterFirst,
    flat: e.flat,
    flatCasterHpDiv: e.flatCasterHpDiv,
    hits: Math.max(1, e.hits ?? 1),
    ticks,
    tickMs,
    durationMs: ticks > 1 ? ticks * tickMs : 0,
    castMs: row.castMs,
    ai: {
      state: row.state,
      rate: perm / 10000,
      delayMs: Math.floor((row.delayMs * 75) / 100),
      cancelable: row.cancelable,
      cond: row.cond,
      condValue: row.condValue,
      target: row.target,
    },
    ignoresFlee: e.ignoreFlee,
    ignoreDef: e.ignoreDef,
    crit: e.alwaysCrit,
    hitBonus: e.hitBonus,
    drain: e.drain,
    hiddenImmune: e.hiddenImmune,
    hideBlocks,
    statuses: e.status ?? [],
    self: e.self,
    heal: healOf(e.heal, mob),
    summon: kind === 'summon' && /SUMMONSLAVE|SUMMONMONSTER/.test(row.skill)
      ? { mobIds: row.vals.map(Number).filter((n) => n > 0), count: e.summon?.count ?? row.level }
      : undefined,
    avoid,
    radius: e.radius,
    centeredOnSelf: e.centeredOnSelf,
    verified: false,
    note: notes.join(' ') || undefined,
  };
  const o = overrideData();
  return { ...skill, ...o.skills[row.skill], ...o.mobs[mob.name]?.[row.skill] };
}

// ---- monsters --------------------------------------------------------------

/**
 * A training dummy for pure DPS tests (the project owner, 2026-09-26):
 * Formless, Neutral 1, Medium, no DEF, MDEF, flee or LUK, never attacks
 * and never dies. Fights against it run to their time limit (DUMMY_SECONDS).
 */
export const DUMMY_ID = 0;
/** The dummy's DPS window (the project owner, 2026-09-27: 10 seconds). */
export const DUMMY_SECONDS = 10;
export function dummyMonster(): Monster {
  const zero = { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 };
  return {
    id: DUMMY_ID, name: 'Training Dummy', level: 1, hp: Number.MAX_SAFE_INTEGER,
    size: 'Medium', race: 'Formless', element: 'Neutral', elementLevel: 1, boss: false,
    atk: 0, matk: 0, matkBase: 0, def: 0, softDef: 0, mdef: 0, softMdef: 0, hit: 0, flee: 0,
    str: 0, luk: 0, stats: zero, reach: 1, adelay: Infinity, statusImmune: true, damageTaken: 1,
    dummy: true, skills: [], notes: ['training dummy: cannot die, does not attack, no defences'],
  };
}

const IGNORES: Record<string, NonNullable<Monster['ignores']>[number]> = {
  IgnoreMelee: 'melee', IgnoreRanged: 'ranged', IgnoreMagic: 'magic', IgnoreMisc: 'misc',
};

export function buildMonster(row: MobRow): Monster {
  const notes: string[] = [];
  const srv = serverMobFor(row);
  const bossProtocol = row.maps.some((c) => BOSS_PROTOCOL_MAPS.includes(c)) && !NOT_BOSS_PROTOCOL.includes(row.name);
  const protocolBoss = bossProtocol && row.maps.some((c) => PROTOCOL_COUNTS_AS_BOSS_MAPS.includes(c));
  const stats = row.stats;
  const matk = srv?.attack2 ?? row.atk;
  const skills = (srv?.skills ?? []).map((r) => resolveSkill(r, { name: row.name, stats, level: row.level, matk }));

  if (!srv) notes.push('not in the server snapshot: normal attacks only, MATK taken from ATK');
  else {
    if (skills.length === 0) notes.push('no skills on the server: normal attacks only');
    const unknown = skills.filter((s) => s.kind === 'unknown').length;
    if (unknown) notes.push(`${unknown} of ${skills.length} skills have no effect data yet (cast only)`);
    // Most monsters' HP went up by exactly a fifth since the snapshot (Rachel
    // SS kept theirs), a blanket change; anything else is worth a line.
    const hpRatio = row.hp / srv.hp;
    if (srv.attack !== row.atk || (Math.abs(hpRatio - 1) > 1e-3 && Math.abs(hpRatio - 1.2) > 1e-3)) {
      notes.push(`changed since the 2023 snapshot: ATK ${srv.attack}→${row.atk}, HP ${srv.hp}→${row.hp}`);
    }
  }
  const extra = overrideData().notes[row.name];
  if (extra) notes.push(extra);

  // Every monster takes its server DamageTaken share (battle.cpp:1832-1836):
  // Rachel SS 80%, the jor_nest three 90%, MVPs 50%, Jormungandr 5%. The
  // owner's readings on the Maiden and the Godly Seeker (2026-09-26) fit 80%
  // once skills read the right hand only; the 50% believed before only fit
  // while both hands were summed.
  const damageTaken = (srv?.damageTaken ?? 100) / 100;
  if (damageTaken !== 1) notes.push(`takes ${Math.round(damageTaken * 100)}% of every hit (server DamageTaken)`);
  if (bossProtocol) notes.push('boss protocol: its normal attacks break your Hiding, its skills do not reach you in it');
  const ignores = (srv?.modes ?? []).map((m) => IGNORES[m]).filter(Boolean);
  if (ignores.length) notes.push(`immune to ${ignores.join(', ')} damage (server modes)`);

  return {
    id: row.id,
    name: row.name,
    level: row.level,
    hp: row.hp,
    size: row.size,
    race: row.race,
    element: row.element,
    elementLevel: row.elementLevel,
    boss: row.mvp,
    atk: row.atk,
    matk,
    matkBase: stats.int + row.level,
    def: row.def,
    softDef: mobSoftDef(row.level, stats.vit),
    mdef: row.mdef,
    softMdef: mobSoftMdef(row.level, stats.int),
    hit: row.hit + TUNE.mobHitBonus,
    bossProtocol,
    ...(protocolBoss ? { protocolBoss } : {}),
    flee: row.flee,
    str: stats.str,
    luk: stats.luk,
    stats,
    reach: row.reach,
    adelay: row.adelay,
    statusImmune: row.traits.includes('nostatus'),
    damageTaken,
    bossClass: srv?.class === 'Boss',
    detector: row.traits.includes('detector') || !!srv?.modes.includes('Detector'),
    noKnockback: !!srv?.modes.includes('KnockBackImmune') || srv?.class === 'Boss',
    ignores: ignores.length ? ignores : undefined,
    serverId: srv?.id,
    skills,
    notes,
  };
}

/**
 * A monster the crawl may not have (a summon such as Autumn Blood): the
 * crawl's row by name if there is one, else the server's own numbers.
 */
export function buildAdd(serverId: number, crawl: MobRow[]): Monster | null {
  const srv = serverMobById(serverId);
  if (!srv) return null;
  const row = crawl.filter((r) => r.name === srv.name)
    .sort((a, b) => Math.abs(a.level - srv.level) - Math.abs(b.level - srv.level))[0];
  if (row) return { ...buildMonster({ ...row, maps: [] }), bossProtocol: false };
  // HIT/FLEE as the crawl works them out: level + DEX + 150 / level + AGI + 100 (status.cpp:3309-3313).
  return buildMonster({
    id: srv.id, name: srv.name, level: srv.level, hp: srv.hp, size: srv.size, race: srv.race,
    element: srv.element, elementLevel: srv.elementLevel, mvp: srv.modes.includes('Mvp'),
    atk: srv.attack, def: srv.def, mdef: srv.mdef,
    hit: srv.level + srv.stats.dex + 150, flee: srv.level + srv.stats.agi + 100,
    reach: srv.attackRange, walk: 150, adelay: srv.attackDelay, stats: srv.stats,
    traits: [...(srv.modes.includes('Detector') ? ['detector'] : []), ...(srv.modes.includes('StatusImmune') ? ['nostatus'] : [])],
    maps: [],
  });
}
