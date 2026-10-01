/**
 * A build, reduced to the numbers a fight reads.
 *
 * The gear side is the planner's own `aggregate`, so the sim and the arsenal
 * can never disagree about what a set of items adds up to. What the planner
 * does not model -- HP, SP, ASPD, skill passives -- comes from the profile
 * (measured in game where possible) and from the class kit.
 */
import { aggregate, combine, derivedStats, jobPool, LIVE_HP_FIX } from '../../sim/src/index.ts';
import type { Build, Dataset, SlotState, Totals } from '../../sim/src/types.ts';
import { SLOTS } from '../../sim/src/slots.ts';
import { plannerDataset } from './data.ts';
import {
  baseHit, basePerfectDodge, hpRegenTick, playerSoftDef, playerSoftMdef, refineAtk, spRegenTick, statusAtk,
} from './formulas.ts';
import type { Fighter, PercentBag, Stats, Weapon } from './model.ts';

/**
 * A profile: the build plus what a character window shows that the planner
 * cannot work out. Written by hand as JSON; see combat/profiles/.
 */
export interface Profile {
  name?: string;
  /** A share link, its payload, a planner Build, or slots by item name. */
  build: string | Build | NamedBuild;
  /** Readings from the game. Each one, when given, beats the model. */
  /** The character's base level, over the link's. */
  baseLevel?: number;
  /**
   * The main-hand weapon is swapped per monster for one carded for its race
   * (the project owner's Satsujin, 2026-09-28): the weapon's best
   * race-specific bonus counts against whatever race is fought.
   */
  weaponRaceMatch?: boolean;
  /**
   * ASPD from stats and gear instead of a fixed reading (the renewal formula,
   * RTM status.cpp:3035-3072): base = the job's weapon delay plus the shield's
   * (Shadow_Chaser one-handed sword 63 + shield 1 = 64); mastery = the
   * skill ASPD value (x AGI/190); offset calibrates it to a reading. Gear
   * "ASPD +x%" shortens the attack delay, flat "ASPD +x" adds.
   */
  aspdModel?: { base: number; mastery?: number; offset?: number };
  measured?: {
    /** Max HP without Moonlight Stance (or the class's stance). */
    maxHp?: number;
    maxSp?: number;
    aspd?: number;
    flee?: number;
    hit?: number;
    /** The status window's ATK and MATK, "173 + 83": what damage over time reads, when given. */
    windowAtk?: [number, number];
    windowMatk?: [number, number];
    /** Hard MDEF: the status window's RIGHT number ("107 + 50" is soft + hard). */
    mdef?: number;
    /**
     * What the window reads over the model, kept when gear changes (a search):
     * flee 691 read vs 718 modelled -> fleeOffset -27. Used when flee / mdef
     * themselves are not pinned.
     */
    fleeOffset?: number;
    mdefOffset?: number;
    /** Max HP read / modelled for the same build, kept when gear changes (instead of pinning maxHp). */
    hpScale?: number;
  };
  /** Consumables carried, by item name. Default: Green Potion. */
  consumables?: string[];
  /** Carry the healing items too (White/Blue Potion, Yggdrasil Berry). */
  healing?: boolean;
  /** Kit options: which fillers the TAS may use, and so on. */
  options?: Record<string, unknown>;
  /** Skills below max, by name: { "Rook's Smash": 1 }. Everything else is maxed. */
  skills?: Record<string, number>;
}

export interface NamedBuild {
  className: string;
  baseLevel: number;
  baseStats: Stats;
  slots: Record<string, { item: string; refine?: number; cards?: string[] }>;
  manual?: Record<string, number>;
}

/** What a class kit adds from its passives, with the levels known. */
export interface Passives {
  masteryAtk: number;
  hit: number;
  flee: number;
  /** Flat Max HP / SP before the percent (Improve Defense / Wisdom). */
  hpFlat: number;
  spFlat: number;
  /** Max HP % from a stance held the whole fight (Moonlight Stance). */
  hpPercent: number;
  /** Extra SP per regen tick: flat, and a share of Max SP (Increase SP Recovery). */
  spRegen: { flat: number; maxShare: number };
  /** Base stat points from skills (Gadget Mastery's INT). */
  stats?: Partial<Record<keyof Stats, number>>;
  /** Defense Penetration % from a buff kept up all fight (Magic Pierce). */
  defPen?: number;
  /** Crit rate and Perfect Dodge from passives (Scythe Mastery, Advanced Scythe Mastery). */
  crit?: number;
  perfectDodge?: number;
  notes: string[];
}

/**
 * Max HP when nothing was read off the character window: a reasonable
 * geared figure, 10k for most classes and 25k for the HP classes (the
 * project owner, 2026-09-26, until the job base HP tables are dug up). Like a
 * reading, it is the build's Max HP as given: gear HP does not move it until
 * job base HP is modelled, which comparing gear swaps will need.
 */
const DEFAULT_MAX_HP: Record<string, number> = { Kingslayer: 25_000, Dracomancer: 25_000 };
const DEFAULT_MAX_HP_ANY = 10_000;

/** Job base SP at a level. A GUESS; `measured.maxSp` replaces it. */
const JOB_BASE_SP: Record<string, (lv: number) => number> = {
  Satsujin: (lv) => 600 * (lv / 136),
};

/**
 * The class's server job and its base HP / SP at this level, from
 * data/jobs.json (combat/tools/import-server.ts: the job whose own skill
 * tree holds the class's skills -- Kingslayer is Shadow_Chaser).
 */
function jobBase(data: Dataset, className: string | null, level: number): { job: string; hp: number; sp: number } | null {
  const job = data.jobs?.classes[className ?? ''];
  const t = job ? data.jobs?.jobs[job] : undefined;
  const hp = t?.hp[level]; const sp = t?.sp[level];
  return job && hp && sp ? { job, hp, sp } : null;
}

/**
 * Max HP / SP the server's way (RTM status.cpp:4031-4037), as the arsenal
 * shows it (sim/src/derived.ts jobPool): + flat, x (1 + gear %); stances'
 * % go on top. Checked against the Satsujin reading (8,500 before stance,
 * Lv136 VIT 31, +18% gear): this gives 8,851.
 */
function poolFromJob(base: number, stat: number, flatBonus: number, gearPct: number, fix = 1): number {
  return (jobPool(base, stat, fix) + flatBonus) * (1 + gearPct / 100);
}
const HP_CAP = 50_000;
/** Kafra Elixirs a life on a boss (the project owner, 2026-09-26). */
const KAFRA_ELIXIRS = 2;
const SP_CAP = 25_000;

export interface FighterOptions {
  /** The class kit's passive bonuses. */
  passives: (levels: Record<string, number>, weaponType: string | null, baseLevel: number) => Passives;
  /** Gear names for a sim skill: "Full Moon" is "Full Moon Blades" on gear. */
  aliases: Record<string, string[]>;
  /** Every skill's max level: what the fighter knows. */
  maxLevels: Record<string, number>;
}

export async function buildFighter(profile: Profile, opts: FighterOptions): Promise<Fighter> {
  const data = plannerDataset();
  const read = await resolveBuild(profile.build, data);
  // A link saved at the wrong level (the owner's of 2026-09-28: 130, played at 136).
  const build = profile.baseLevel ? { ...read, baseLevel: profile.baseLevel } : read;
  const totals = aggregate(build, data);
  const notes: string[] = [];

  const byKey = new Map(data.stats.map((s) => [s.key, s.id]));
  const gear = (key: string) => {
    const id = byKey.get(key);
    return id === undefined ? undefined : totals.byStat.get(id);
  };
  const flat = (key: string) => gear(key)?.flat ?? 0;
  const pct = (key: string) => gear(key)?.percent ?? 0;
  // A percent-natured stat can arrive in either column ("Melee Damage +5"
  // without a sign), so both are read.
  const either = (key: string) => flat(key) + pct(key);

  // Every skill maxed, always (the project owner, 2026-09-26).
  const levels: Record<string, number> = { ...opts.maxLevels, ...(profile.skills ?? {}) };
  const extras = gearExtras(build, data, totals);
  for (const [n, l] of Object.entries(extras.grants)) levels[n] = Math.max(levels[n] ?? 0, l);
  notes.push(...extras.notes);
  const below = Object.entries(profile.skills ?? {}).filter(([n, l]) => l < (opts.maxLevels[n] ?? Infinity));
  if (below.length) notes.push(`skills below max: ${below.map(([n, l]) => `${n} ${l}`).join(', ')}`);
  const weapon = weaponOf(build, data);
  const passives = opts.passives(levels, weapon?.type ?? null, build.baseLevel);
  notes.push(...passives.notes);

  // A passive's stat points count as base points, under gear's percent
  // (Gadget Mastery's INT: RTM status.cpp:4656 adds it to base_status).
  const points = build.baseStats;
  const stats = Object.fromEntries((['str', 'agi', 'vit', 'int', 'dex', 'luk'] as const)
    .map((k) => [k, combine(points[k] + (passives.stats?.[k] ?? 0), flat(k), pct(k))])) as Stats;

  const offhand = itemIn(build, data, 'offhand');
  const leftWeapon = weaponOf(build, data, 'offhand');

  const derived = derivedStats(build.baseLevel, points, gear, build.manual ?? {});
  const total = (key: string) => derived.find((d) => d.key === key)?.total ?? 0;

  // ---- HP / SP --------------------------------------------------------------
  const measuredHp = profile.measured?.maxHp;
  const job = jobBase(data, build.className, build.baseLevel);
  // "HP-2% per VIT" / "SP-2% per INT" (Opera Mask): the parser leaves them;
  // read literally, per point of the stat's total. GUESS until confirmed.
  const perStat = (pool: 'HP' | 'SP', stat: 'vit' | 'int') => gearLines(build, data)
    .reduce((n, l) => n + Number(new RegExp(String.raw`^\s*${pool}\s*-\s*(\d+)%\s*per\s*${stat}\s*$`, 'i').exec(l)?.[1] ?? 0), 0) * stats[stat];
  const hpStatCut = perStat('HP', 'vit');
  const spStatCut = perStat('SP', 'int');
  if (hpStatCut) notes.push(`Max HP -${hpStatCut}% from "HP -n% per VIT" (read literally)`);
  const modelHp = job
    ? poolFromJob(job.hp, stats.vit, flat('max_hp') + passives.hpFlat, pct('max_hp') - hpStatCut, LIVE_HP_FIX[job.job] ?? 1)
      * (profile.measured?.hpScale ?? 1) : null;
  const readHp = measuredHp ?? modelHp ?? DEFAULT_MAX_HP[build.className ?? ''] ?? DEFAULT_MAX_HP_ANY;
  if (measuredHp) notes.push(`Max HP ${measuredHp} as measured (before stance)`);
  else if (modelHp) notes.push(`Max HP ${Math.floor(modelHp)} before stance from the ${job!.job} job table -- a reading confirms it`);
  else notes.push(`Max HP assumed ${readHp} before stance -- give a reading for real numbers`);
  const maxHp = Math.max(1, Math.min(HP_CAP, Math.floor(readHp * (1 + passives.hpPercent / 100))));

  const spModel = (base: number) => (base * (1 + stats.int / 100) + flat('max_sp') + passives.spFlat)
    * (1 + pct('max_sp') / 100);
  const jobSp = (JOB_BASE_SP[build.className ?? ''] ?? JOB_BASE_SP.Satsujin)(build.baseLevel);
  const modelSp = job ? poolFromJob(job.sp, stats.int, flat('max_sp') + passives.spFlat, pct('max_sp') - spStatCut) : spModel(jobSp);
  const maxSp = Math.min(SP_CAP, Math.floor(profile.measured?.maxSp ?? modelSp));
  if (!profile.measured?.maxSp) {
    notes.push(job ? `Max SP ${maxSp} from the job table -- a reading confirms it` : `Max SP ${maxSp} from a guessed job base -- give measured.maxSp`);
  }

  // ---- offence --------------------------------------------------------------
  const weaponAtk = weapon?.atk ?? 0;
  const weaponMatk = itemIn(build, data, 'weapon')?.matk ?? 0;
  const gearEquipAtk = flat('atk') - weaponAtk - (offhand?.kind === 'Weapon' ? offhand.atk : 0);

  // The shadow sets' conversions (gearExtras): End of Kings' DEF and soft DEF
  // +1% a set refine, then ATK from its total DEF -- hard + soft, the status
  // window's 'a + b' (a reading would settle which); Heir to the King's DEF
  // from total ATK -- the window's ATK: status + weapon (with refine) + equip.
  const softDef = Math.floor(playerSoftDef(stats, build.baseLevel) * (1 + extras.defPct / 100));
  const hardDef = Math.floor(Math.floor(flat('def') * (1 + pct('def') / 100)) * (1 + extras.defPct / 100));
  const equipAtk = gearEquipAtk + Math.floor(extras.atkFromDef * (hardDef + softDef));
  const windowAtk = statusAtk(stats, build.baseLevel) + (weapon ? weapon.atk + refineAtk(weapon.level, weapon.refine) : 0) + equipAtk;
  const def = hardDef + Math.floor(extras.defFromAtk * windowAtk);
  if (extras.atkFromDef) notes.push(`ATK +${equipAtk - gearEquipAtk} from DEF (set bonus)`);
  if (extras.defFromAtk) notes.push(`DEF +${def - hardDef} from ATK ${windowAtk} (set bonus)`);

  const hit = profile.measured?.hit
    ?? Math.floor((baseHit(build.baseLevel, stats) + flat('hit')) * (1 + pct('hit') / 100)) + passives.hit;
  // The planner's flee already carries the build's manual box; the kit's
  // passives stand in only when that box is empty.
  const manualFlee = build.manual?.flee;
  const flee = profile.measured?.flee ?? total('flee') + (manualFlee ? 0 : passives.flee) + (profile.measured?.fleeOffset ?? 0);

  // The limit, not a flat 180: +1 per 40 AGI and gear's ASPD Limit, up to
  // 190 (the planner's derived total). An AGI build is assumed to reach it.
  const aspdLimit = total('aspd_limit');
  const am = profile.aspdModel;
  const modelAspd = am ? (() => {
    const { agi, dex } = stats;
    const raw = 196 + Math.sqrt((dex * dex) / 9 + 0.7 * agi * agi) * 0.25 + ((am.mastery ?? 0) * agi) / 190
      - Math.min(am.base - Math.floor(agi / 10), 200);
    // ASPD +x% shortens the delay (amotion = 2000 - 10 ASPD); flat ASPD adds.
    const delay = (2000 - 10 * raw) * (1 - pct('aspd') / 100) - 10 * flat('aspd');
    return Math.min(aspdLimit, Math.floor((2000 - delay) / 10 + (am.offset ?? 0)));
  })() : null;
  const aspd = modelAspd ?? profile.measured?.aspd ?? aspdLimit;
  if (modelAspd !== null) notes.push(`ASPD ${aspd} from stats and gear (aspdModel)`);
  else if (!profile.measured?.aspd) notes.push(`ASPD taken as ${aspd}, the build's ASPD limit; give a reading if it falls short`);

  const dmg: PercentBag = {};
  const res: PercentBag = {};
  const statusRes: PercentBag = {};
  for (const s of data.stats) {
    const v = either(s.key);
    if (!v) continue;
    if (['element_damage', 'race_damage', 'size_damage'].includes(s.category)
      || ['melee_damage', 'ranged_damage', 'magic_damage', 'no_size_penalty',
        'potion_healing'].includes(s.key)) dmg[s.key] = v;
    if (['element_resist', 'race_resist', 'size_defence'].includes(s.category)
      || ['damage_reduction', 'physical_damage_received', 'magic_damage_received',
        'res_melee', 'res_ranged'].includes(s.key)) res[s.key] = v;
    if (s.category === 'status_resist') statusRes[s.key] = v;
  }
  if (extras.ranged) dmg.ranged_damage = (dmg.ranged_damage ?? 0) + extras.ranged;

  // The left hand's swing takes only its own weapon's target-type cards
  // (the planner halves them there); every other card is the right hand's.
  const dmgLeft: PercentBag = {};
  let critDamageLeft = either('crit_damage');
  if (leftWeapon && build.slots.weapon) {
    const cd = data.stats.find((s) => s.key === 'crit_damage');
    const t = cd && aggregate({ ...build, slots: { weapon: build.slots.weapon } }, data).byStat.get(cd.id);
    critDamageLeft -= (t?.flat ?? 0) + (t?.percent ?? 0);
  }
  // Perfect Hit: a hit that ignores flee. Never from the left-hand weapon (RTM
  // pc.cpp:3465-3470, lr_flag != 2), the rest add up (status.cpp:4605).
  let perfectHit = either('perfect_hit');
  if (leftWeapon && build.slots.offhand) {
    const ph = data.stats.find((s) => s.key === 'perfect_hit');
    const t = ph && aggregate({ ...build, slots: { offhand: build.slots.offhand } }, data).byStat.get(ph.id);
    perfectHit -= (t?.flat ?? 0) + (t?.percent ?? 0);
  }
  // weaponRaceMatch: the right weapon's own best race card total, for any race.
  let anyRace = 0;
  if (profile.weaponRaceMatch && build.slots.weapon) {
    const own = aggregate({ ...build, slots: { weapon: build.slots.weapon } }, data);
    for (const s of data.stats) {
      if (!s.key.startsWith('dmg_vs_race_') || /_(boss|non_boss|all_races)$/.test(s.key)) continue;
      const t = own.byStat.get(s.id);
      anyRace = Math.max(anyRace, (t?.flat ?? 0) + (t?.percent ?? 0));
    }
    if (anyRace) notes.push(`weapon swapped per race: +${anyRace}% against any race`);
  }
  if (leftWeapon && build.slots.offhand) {
    const own = aggregate({ ...build, slots: { offhand: build.slots.offhand } }, data);
    for (const s of data.stats) {
      if (!['element_damage', 'race_damage', 'size_damage'].includes(s.category)) continue;
      const t = own.byStat.get(s.id);
      const v = (t?.flat ?? 0) + (t?.percent ?? 0);
      if (v) dmgLeft[s.key] = v;
    }
  }

  const tg = trueGoddessPart(extras.trueGoddess, build, data, notes);
  const fighter: Fighter = {
    name: profile.name ?? build.className ?? 'player',
    className: build.className ?? 'unknown',
    level: build.baseLevel,
    stats,
    maxHp,
    maxSp,
    weapon,
    offhand: leftWeapon,
    ...(offhand && offhand.kind === 'Shield' ? {
      shield: { name: offhand.name, type: offhand.type ?? 'Shield', weight: offhand.weight ?? 0, refine: build.slots.offhand?.refine ?? 0 },
    } : {}),
    gearText: Object.values(build.slots).flatMap((s) => [s?.itemId, ...(s?.cards ?? [])])
      .map((id) => (id ? data.items.get(id)?.description ?? '' : '')).filter(Boolean).join(' | '),
    equipAtk,
    atkPercent: pct('atk'),
    masteryAtk: passives.masteryAtk,
    matk: { weapon: weaponMatk, equip: flat('matk') - weaponMatk, percent: pct('matk') },
    hit,
    flee,
    perfectDodge: basePerfectDodge(stats) + flat('perfect_dodge') + (passives.perfectDodge ?? 0),
    critRate: total('crit_rate') + (passives.crit ?? 0),
    critDamage: either('crit_damage'),
    critDamageLeft,
    perfectHit: Math.max(0, Math.min(100, perfectHit)),
    aspd,
    moveSpeed: either('move_speed') + (tg.tgMoveSpeed ?? 0),
    defPen: flat('def_pen') + (passives.defPen ?? 0),
    mdefPen: flat('mdef_pen'),
    def,
    softDef,
    mdef: profile.measured?.mdef ?? Math.floor(flat('mdef') * (1 + pct('mdef') / 100)) + (profile.measured?.mdefOffset ?? 0),
    softMdef: playerSoftMdef(stats, build.baseLevel),
    element: totals.element ?? 'Neutral',
    dmg,
    dmgLeft,
    ...(anyRace ? { anyRace } : {}),
    res,
    cast: { variable: pct('variable_cast') + (tg.tgCast?.variable ?? 0), fixed: pct('fixed_cast') + (tg.tgCast?.fixed ?? 0), all: pct('cast_time'),
      // "Fixed Cast Time -0.2s" lands in the flat column, in seconds.
      fixedFlatMs: Math.round(flat('fixed_cast') * 1000) },
    afterCastDelay: pct('after_cast_delay'),
    spCost: pct('sp_cost'),
    leech: {
      hpRate: either('leech_hp_rate'), hpPower: either('leech_hp_power'),
      spRate: either('leech_sp_rate'), spPower: either('leech_sp_power'),
      hpPerHit: flat('hp_per_hit'), spPerHit: flat('sp_per_hit'),
    },
    regen: {
      // Never below nothing: Eastern Sky Armor's HP Regen -95% with Dry Goblin's -50% stops regen, it does not drain.
      hp: Math.max(0, Math.floor(hpRegenTick(maxHp, stats.vit) * (1 + either('hp_regen') / 100))),
      sp: Math.max(0, Math.floor(spRegenTick(maxSp, stats.int) * (1 + either('sp_regen') / 100))),
      // Increase SP Recovery is the server's skill regen (MG_SRECOVERY:
      // 2/lv + Max SP/1000 per lv), its own 4 s tick, no gear % (status.cpp:5456).
      spSkill: Math.floor(passives.spRegen.flat + passives.spRegen.maxShare * maxSp),
    },
    kafraElixirs: KAFRA_ELIXIRS + Object.values(build.slots).reduce((n, s) => {
      const d = s?.itemId ? data.items.get(s.itemId)?.description ?? '' : '';
      return n + Number(/kafra elixir refill limit by \+(\d+)/i.exec(d)?.[1] ?? 0);
    }, 0),
    doubleAttack: flat('double_attack'),
    statusRes,
    autocastWhenHit: autocastsWhenHit(build, data),
    healReceived: either('healing_received'),
    healPower: either('healing_power'),
    reflectReduce: either('ignores_reflect') > 0 ? 100 : reflectReduceFromText(build, data),
    ...guardFromText(build, data, totals.skills.get('Auto Guard|level')?.flat ?? 0),
    ...(profile.measured?.windowAtk || profile.measured?.windowMatk ? {
      window: { atk: profile.measured.windowAtk, matk: profile.measured.windowMatk },
    } : {}),
    ...(Number.isFinite(extras.backSlideMs) ? { backSlideMs: extras.backSlideMs } : {}),
    ...(tg.trueGoddess ? { trueGoddess: true } : {}),
    skillLevels: levels,
    skillMods: skillModLookup(totals, opts.aliases, extras.skillDamage),
    notes,
  };
  return fighter;
}

function skillModLookup(totals: Totals, aliases: Record<string, string[]>, extraDamage: Record<string, number> = {}) {
  // Asked on every hit: worked out once per skill and metric (nested maps: no key string built per call).
  const memo = new Map<string, Map<string, { flat: number; percent: number }>>();
  return (skill: string, metric: string) => {
    let bySkill = memo.get(skill);
    if (!bySkill) memo.set(skill, bySkill = new Map());
    let hit = bySkill.get(metric);
    if (!hit) bySkill.set(metric, hit = look(skill, metric));
    return hit;
  };
  function look(skill: string, metric: string) {
    let f = 0; let p = metric === 'damage' ? extraDamage[skill] ?? 0 : 0;
    for (const name of new Set([skill, ...(aliases[skill] ?? [])])) {
      const t = totals.skills.get(`${name}|${metric}`);
      if (t) { f += t.flat; p += t.percent; }
    }
    return { flat: f, percent: p };
  }
}

/**
 * What the planner leaves uncounted but a fight needs:
 *   - skills gear grants: "Grants Dragon Breath Lv5" on a piece, "Grants
 *     Dragon Breath Lv10" as a set bonus (only with the set complete). The
 *     best level counts.
 *   - a set's paired refines, Old Dragon's "Armor + Shield refine: Long Range
 *     Attack +1%": read as +1% per refine of the two pieces together (an
 *     assumption -- the wording gives no "per").
 */
function gearExtras(build: Build, data: Dataset, totals: Totals): {
  grants: Record<string, number>; ranged: number; skillDamage: Record<string, number>; notes: string[];
  /** End of Kings: DEF and soft DEF +% (1 a set refine); ATK from total DEF. Heir to the King: DEF from total ATK. */
  defPct: number; atkFromDef: number; defFromAtk: number;
  /** Back Slide's cooldown from gear, ms (Infinity: none). */
  backSlideMs: number;
  /** The True Goddess set is complete. */
  trueGoddess: boolean;
} {
  const grants: Record<string, number> = {};
  const skillDamage: Record<string, number> = {};
  const notes: string[] = [];
  let ranged = 0; let defPct = 0; let atkFromDef = 0; let defFromAtk = 0; let backSlideMs = Infinity; let trueGoddess = false;
  const grant = (text: string) => {
    const m = /^Grants (.+?) Lv\.?\s*(\d+)\.?$/i.exec(text.trim());
    if (m) grants[m[1]] = Math.max(grants[m[1]] ?? 0, Number(m[2]));
  };
  const refineOf = new Map<number, number>();
  for (const st of Object.values(build.slots)) if (st?.itemId) refineOf.set(st.itemId, st.refine ?? 0);
  for (const id of refineOf.keys()) for (const b of data.items.get(id)?.piece_bonus ?? []) grant(b.text);
  // Back Slide from gear, as the tooltips word it: "Backslide Lv1" (Celestial
  // Tome), "Back Slide Lv1" (Evasion Manual), "Enables Backslide" (Surt
  // Shoes, Galaxy Garment, River Gem), "Enables Backslide with a reduced
  // cooldown of 1 second" (Slider Armguard). Not the autocast ones ("when
  // using Flying Knife"). Cooldown 3 s (server TF_BACKSLIDING), the shortest
  // a piece gives.
  for (const s of Object.values(build.slots)) {
    for (const id of [s?.itemId, ...(s?.cards ?? [])]) {
      for (const line of (id ? data.items.get(id)?.description ?? '' : '').split('\n')) {
        if (!/^\s*(Enables\s+)?Back\s?slid(e|ing)\b/i.test(line) || /\bwhen\b|autocast/i.test(line)) continue;
        grants['Back Slide'] = 1;
        const cd = /cooldown of (\d+(?:\.\d+)?) second/i.exec(line);
        backSlideMs = Math.min(backSlideMs, cd ? Number(cd[1]) * 1000 : 3000);
      }
    }
  }
  for (const p of totals.setProgress) {
    if (!p.complete) continue;
    if (p.set.name === 'True Goddess') trueGoddess = true;
    for (const b of p.set.set_bonus) {
      grant(b.text);
      // The shadow sets' unparsed lines (End of Kings, Heir to the King).
      const from = /^Adds (ATK|DEF) equal to (\d+)% of your total (DEF|ATK)$/i.exec(b.text.trim());
      if (from && from[1].toUpperCase() === 'ATK') atkFromDef += Number(from[2]) / 100;
      if (from && from[1].toUpperCase() === 'DEF') defFromAtk += Number(from[2]) / 100;
    }
    for (const r of p.set.set_refine?.per_set_refine ?? []) {
      for (const e of r.effects) {
        const m = /^DEF \+(\d+)% and Soft DEF \+\d+%$/i.exec(e.text.trim());
        if (!m) continue;
        const total = p.set.member_ids.reduce((sum, id) => sum + (refineOf.get(id) ?? 0), 0);
        defPct += (Number(m[1]) * total) / (r.per || 1);
        notes.push(`${p.set.name}: DEF and soft DEF +${defPct}% (set refine ${total})`);
      }
    }
    const members = p.set.member_ids.map((id) => ({ name: data.items.get(id)?.name ?? '', refine: refineOf.get(id) ?? 0 }));
    const piece = (word: string) => members.find((x) => new RegExp(`\\b${word === 'Shoes' ? '(Shoes|Boots)' : word}$`, 'i').test(x.name));
    const seen = new Set<string>();
    for (const id of p.set.member_ids) {
      for (const c of data.items.get(id)?.conditional ?? []) {
        const m = /^(\w+) \+ (\w+) refine$/i.exec(c.condition);
        if (!m || seen.has(c.condition)) continue;
        seen.add(c.condition);
        const refines = (piece(m[1])?.refine ?? 0) + (piece(m[2])?.refine ?? 0);
        for (const e of c.effects) {
          if (!e.parsed || !e.value) continue;
          const v = e.value * refines;
          if (e.stat_keys?.includes('ranged_damage')) ranged += v;
          else if (e.skill && e.skill_metric === 'damage') skillDamage[e.skill] = (skillDamage[e.skill] ?? 0) + v;
          else continue;
          notes.push(`${p.set.name}: ${e.text} x ${refines} (${c.condition}, read per refine)`);
        }
      }
    }
  }
  if (Object.keys(grants).length) notes.push(`skills from gear: ${Object.entries(grants).map(([n, l]) => `${n} ${l}`).join(', ')}`);
  return { grants, ranged, skillDamage, notes, defPct, atkFromDef, defFromAtk, backSlideMs, trueGoddess };
}

/**
 * Autocasts on being hit, from each worn item's text: "1% chance to
 * Autocast Shield Boomerang and King's Chains when hit". Under a "Per
 * Refine:" heading (up to the next blank line) the chance is per refine of
 * that piece (the project owner, 2026-09-27: Bulwark Gem of the Weak).
 */
function autocastsWhenHit(build: Build, data: Dataset): { skills: string[]; chance: number }[] {
  const out: { skills: string[]; chance: number }[] = [];
  for (const st of Object.values(build.slots)) {
    for (const id of [st?.itemId, ...(st?.cards ?? [])]) {
      const d = id ? data.items.get(id)?.description ?? '' : '';
      if (!/autocast/i.test(d)) continue;
      for (const block of d.split(/\n\s*\n/)) {
        const perRefine = /^\s*Per Refine/i.test(block);
        const re = /(\d+(?:\.\d+)?)%\s+chance\s+to\s+Autocast\s+(.+?)\s+when\s+hit/gis;
        for (const m of block.matchAll(re)) {
          const skills = m[2].replace(/\s+/g, ' ').split(/\s+and\s+|,\s*/).map((x) => x.trim()).filter(Boolean);
          const chance = (Number(m[1]) / 100) * (perRefine && id === st?.itemId ? st!.refine ?? 0 : 1);
          if (chance > 0) out.push({ skills, chance });
        }
      }
    }
  }
  return out;
}

/**
 * Reflect cut read straight from item and card text: the parser only knows
 * two of the seven wordings ("Ignore Weapon Size Penalty and Reflected
 * Damage", "Ignores all reflected damage", "Reduces reflect damage taken by
 * 90%"...). Stops at a set bonus, which needs the other pieces.
 */
function reflectReduceFromText(build: Build, data: Dataset): number {
  let total = 0;
  for (const s of Object.values(build.slots)) {
    for (const id of [s?.itemId, ...(s?.cards ?? [])]) {
      const d = id ? data.items.get(id)?.description ?? '' : '';
      for (const line of d.split('\n')) {
        if (/\bset\b|combo|equipped with/i.test(line)) break;
        if (/ignores? (all )?(weapon size penalty and )?reflect/i.test(line)) total += 100;
        const cut = /reduces? reflect\w* damage[^\d]*(\d+)%/i.exec(line);
        if (cut) total += Number(cut[1]);
      }
    }
  }
  return Math.min(100, total);
}

/**
 * Auto Guard and Endure, as the item text words them and the parser leaves
 * alone: "Auto Guard Lv: 1" (counted as a skill level), "Enables Auto Guard
 * Lv. 10 while using Two-handed Shield" (Bulwark Gem: a Colossal Shield,
 * which sits in the two-handed weapon slot), "Enables Auto-Guard Lv10"
 * (cards), "Permanent Endure". The best level counts; they do not add.
 */
function guardFromText(build: Build, data: Dataset, fromTotals: number): { autoGuard?: number; endure?: boolean } {
  const items = Object.values(build.slots).flatMap((s) => [s?.itemId, ...(s?.cards ?? [])])
    .map((id) => (id ? data.items.get(id) : undefined));
  const twoHandedShield = items.some((i) => i?.type === 'Colossal Shield');
  let autoGuard = fromTotals;
  let endure = false;
  for (const i of items) {
    const d = i?.description ?? '';
    const gem = /Enables Auto Guard Lv\.?\s*(\d+) while using Two-handed Shield/i.exec(d);
    if (gem && twoHandedShield) autoGuard = Math.max(autoGuard, Number(gem[1]));
    // Cards: "Enables Auto-Guard Lv10" (Tower Eater), "Enables Auto-Guard Lv7" (Cornutus).
    const card = /Enables Auto-Guard Lv\.?\s*(\d+)\s*$/im.exec(d);
    if (card) autoGuard = Math.max(autoGuard, Number(card[1]));
    if (/Permanent Endure/i.test(d)) endure = true;
  }
  return { ...(autoGuard > 0 ? { autoGuard: Math.min(10, autoGuard) } : {}), ...(endure ? { endure } : {}) };
}

/**
 * True Goddess (all four pieces), EXPERIMENTAL -- only with TRUE_GODDESS=1 in
 * the environment. Each piece's "Max HP -99%" stacks (the planner's totals
 * already floor HP at 1); the set: every skill cast starts a 10 s cooldown
 * on that skill and grants Kaupe Lv3 for 2 s (engine.ts). Readings the
 * project owner gave (2026-09-28): the penalty stacks, "spellcast" is any
 * skill, the cooldown is per skill. The pieces' per-refine lines the parser
 * loses are added here: Move Speed +3% (armour), Variable Cast -5%
 * (gloves), Fixed Cast -3% (shoes) per refine; the set's Variable and
 * Fixed Cast -1% per 2 total refines. ASPD +2% (pendant) is left out: the
 * sim reads ASPD as the build's limit.
 */
function trueGoddessPart(complete: boolean, build: Build, data: Dataset, notes: string[]):
  { trueGoddess?: boolean; tgMoveSpeed?: number; tgCast?: { variable: number; fixed: number } } {
  if (!complete || process.env.TRUE_GODDESS !== '1') return {};
  const refineOf = (name: string) => Object.values(build.slots)
    .find((st) => st?.itemId && data.items.get(st.itemId)?.name === name)?.refine ?? 0;
  const [a, g, sh, pe] = ['Armor', 'Gloves', 'Shoes', 'Pendant'].map((w) => refineOf(`True Goddess ${w}`));
  const set = Math.floor((a + g + sh + pe) / 2);
  notes.push(`True Goddess: 10 s cooldown on every skill, Kaupe 2 s after each cast (experimental)`);
  return { trueGoddess: true, tgMoveSpeed: 3 * a, tgCast: { variable: -5 * g - set, fixed: -3 * sh - set } };
}

/** Every line of every worn item's and card's description. */
function gearLines(build: Build, data: Dataset): string[] {
  return Object.values(build.slots).flatMap((s) => [s?.itemId, ...(s?.cards ?? [])])
    .flatMap((id) => (id ? (data.items.get(id)?.description ?? '').split('\n') : []));
}

function itemIn(build: Build, data: Dataset, slot: string) {
  const id = build.slots[slot]?.itemId;
  return id ? data.items.get(id) ?? null : null;
}

function weaponOf(build: Build, data: Dataset, slot = 'weapon'): Weapon | null {
  const item = itemIn(build, data, slot);
  if (!item || item.kind !== 'Weapon') return null;
  return {
    name: item.name,
    type: item.type ?? 'Bare Hands',
    atk: item.atk,
    level: item.weapon_level ?? 1,
    refine: build.slots[slot]?.refine ?? 0,
    // A card in it can make it an element ("Holy Element Weapon.": Sarah Irine
    // Card) -- the planner's parser leaves that line unread (2026-10-01).
    element: cardElement(build, data, slot) ?? item.element,
  };
}

const ELEMENTS = ['Neutral', 'Water', 'Earth', 'Fire', 'Wind', 'Poison', 'Holy', 'Dark', 'Ghost', 'Undead'];
function cardElement(build: Build, data: Dataset, slot: string): string | null {
  for (const id of build.slots[slot]?.cards ?? []) {
    const m = id ? /\b(\w+) Element Weapon\b/.exec(data.items.get(id)?.description ?? '') : null;
    if (m && ELEMENTS.includes(m[1])) return m[1];
  }
  return null;
}

// ---- reading a build -------------------------------------------------------

/** A share URL, a bare payload, a Build, or a build written with item names. */
export async function resolveBuild(src: Profile['build'], data: Dataset): Promise<Build> {
  if (typeof src === 'string') {
    const payload = src.includes('#') ? new URLSearchParams(src.split('#')[1]).get('b') ?? '' : src;
    // The web app's own codec, so every link format it ever wrote still reads.
    // It imports '@sim', which combat/register.mjs resolves.
    const { decodeBuild } = await import('../../web/src/share.ts');
    const build = await decodeBuild(payload);
    if (!build) throw new Error('could not read that build link');
    return withEmptySlots(build);
  }
  if ('slots' in src && Object.values(src.slots).some((s: any) => s && 'item' in s)) {
    return withEmptySlots(fromNames(src as NamedBuild, data));
  }
  return withEmptySlots(src as Build);
}

function fromNames(b: NamedBuild, data: Dataset): Build {
  const idOf = (name: string) => {
    const hits = data.itemList.filter((i) => i.name.toLowerCase() === name.toLowerCase());
    if (hits.length === 0) throw new Error(`no item named "${name}"`);
    return hits[0].id;
  };
  const slots: Record<string, SlotState> = {};
  for (const [slot, s] of Object.entries(b.slots)) {
    slots[slot] = {
      itemId: idOf(s.item), refine: s.refine ?? 0, cards: (s.cards ?? []).map(idOf),
    };
  }
  return {
    className: b.className, baseLevel: b.baseLevel, baseStats: b.baseStats, slots, manual: b.manual,
  };
}

function withEmptySlots(build: Build): Build {
  const slots = { ...build.slots };
  for (const s of SLOTS) slots[s.key] ??= { itemId: null, refine: 0, cards: [] };
  return { ...build, slots };
}
