/**
 * Every combat formula the sim uses, in one file.
 *
 * Sources, in the order they win:
 *   1. The server's own codex (data/raw/codex.json) and readings the project
 *      owner took in game.
 *   2. The server's own source: the returntomorroc/ snapshot (an rAthena
 *      renewal fork of upstream 153a83df1, files up to 2023-12). "RTM" line
 *      references are to returntomorroc/src/map/. The live server has moved
 *      on since, which is why 1 wins; .claude/scratch/formula-audit.md lists
 *      every place the two disagree.
 *   3. Guesses, marked GUESS, which exist so the sim runs at all.
 *
 * Change a number here and every fight changes with it. Constants are in
 * `TUNE` so a calibration run can override them without editing code.
 */
import {
  defMultiplier, effectivePierce, mdefMultiplier,
} from '../../sim/src/derived.ts';
import { resolve } from 'node:path';

import { COMBAT_DATA, readJSON } from './data.ts';
import type { Fighter, MobSkill, Monster, Stats } from './model.ts';
import type { Rng } from './rng.ts';

export const TUNE = {
  /**
   * Your crits (RTM battle.cpp:6303-6308), after DEF and element:
   * x1.2 x (1 + LUK/5 % + Crit Damage/2 %) on a normal attack,
   * x1.2 x (1 + LUK/10 % + Crit Damage/2 %) on a skill.
   */
  critBase: 1.2,
  /** All cast times x0.9 (RTM skill.conf casting_rate 90). */
  castingRate: 0.9,
  /** All after-cast delays x0.9 (RTM skill.conf delay_rate 90), after the AGI cut. */
  delayRate: 0.9,
  /** A monster takes LUK/5 off your crit rate, up to 60 (codex). */
  critShieldPerLuk: 1 / 5,
  critShieldCap: 60,
  /** Double Attack: +10% chance per level of a second auto-attack hit, daggers only (RTM battle.cpp:3750-3760). */
  doubleAttackPerLevel: 10,
  /** Variable cast reaches zero at 2*DEX + INT = this (codex; rAthena default is 530). */
  vctStatScale: 400,
  /** The pause after a skill can't go under this (codex "Delay Floor"). */
  delayFloorMs: 100,
  /** No hit roll goes under this % chance, yours or a monster's (codex; RTM battle.conf min_hitrate 10). */
  mobHitFloor: 10,
  /** Monster ATK rolls 80-120% of its ATK column (RTM status.cpp:3195-3227). */
  mobAtkSpread: [0.8, 1.2] as [number, number],
  /** Monster MATK rolls 70-130% of its Attack2 column; INT + level sit outside the roll (RTM status.cpp:3239). */
  mobMatkSpread: [0.7, 1.3] as [number, number],
  /** A monster crit: max ATK roll x1.4 before DEF, x1.2 after, DEF still applies (RTM battle.cpp:2425, 6317). */
  mobCritPre: 1.4,
  mobCritPost: 1.2,
  /**
   * The off hand's share of a normal attack when dual wielding: 50 + 10 per
   * Left Hand Mastery level (RTM battle.cpp:5768-5793), 100% at 5.
   */
  leftHand: 1,
  /**
   * Status ATK in each hand: twice in the right hand, once in the left, as
   * the 2023 code has it (battle.cpp:2234). The project owner's dummy
   * autos of 2026-09-27 (Murder Knife [3x Chocolate Bear] / Laevateinn +9,
   * Ghost): right 1,401 a hit, left 530 -- the right fits twice status ATK
   * with full cards (within 4%), the left once with none (within 2%).
   */
  statusAtkRight: 2,
  statusAtkLeft: 1,
  /**
   * A skill lands this many times the right hand's ATK. Was 2 ("source
   * unknown") while status counted once and cards half: that stood in for
   * the doubled status ATK and the cards. 1 since 2026-09-27.
   */
  skillAtkFactor: 1,
  /**
   * How race/size/element/boss damage ("cards") enters a hit. 'final': the
   * whole hit x C, the right hand with every card, the left with only its
   * own weapon's (already halved by the planner) -- the owner's reading of
   * 2026-09-27 ("only left hand racials are halved"). 'parts': the 2023
   * code, weapon and equip ATK + (C - 1) x `cardShare` (battle.cpp:6245),
   * status ATK too with `cardOnStatus`.
   */
  cardMode: 'final' as 'parts' | 'final',
  /** ATK% on status and mastery ATK too, not only weapon and equip (see handAtk). */
  atkPercentAll: true,
  /** The off hand crits by the main hand's formula (owner's reading, 2026-09-27), not the code's x1.1 branch. */
  offhandCritSame: true,
  cardShare: 0.5,
  cardOnStatus: false,
  /** Seconds a TAS needs to step out of an area and back, each way. GUESS. */
  walkOutMs: 600,
  /** Reaction to a cast bar: the TAS is perfect, but not psychic. GUESS. */
  reactionMs: 100,
  /**
   * Monster HIT over the crawl's figure: the project owner reads Burning
   * Fury 680 (crawl 655) and Tortured Maiden 732 (707), 2026-09-26.
   */
  mobHitBonus: 25,
  /**
   * Natural regen intervals: RTM conf/battle/player.conf natural_healhp/sp_interval
   * 2000 / 1200 ms (upstream 6000 / 8000). None while hidden (RTM status.cpp:15786).
   */
  hpRegenMs: 2000,
  spRegenMs: 1200,
};

/** Natural HP regen per tick (RTM status.cpp:5413): 1 + VIT/5 + MaxHP/200. */
export const hpRegenTick = (maxHp: number, vit: number) => 1 + Math.floor(vit / 5) + Math.floor(maxHp / 200);
/** Natural SP regen per tick (RTM status.cpp:5422-5424): 1 + INT/6 + MaxSP/100, and (INT-120)/2 + 4 from 120 INT. */
export const spRegenTick = (maxSp: number, int: number) => 1 + Math.floor(int / 6) + Math.floor(maxSp / 100)
  + (int >= 120 ? Math.floor((int - 120) / 2) + 4 : 0);

// ---- elements & sizes ------------------------------------------------------

/**
 * The server's element table, db/import/attr_fix.yml, generated into
 * combat/data/element-table.json by tools/import-server.ts. The project
 * owner's chart differed in 25 cells (Holy vs the Natural four and Dark vs
 * the Corporal four at 90% for levels 1-3); the owner reckons the server is
 * right (2026-09-26).
 */
const ELEMENTS: { order: string[]; levels: Record<string, Record<string, number[]>> } =
  readJSON(resolve(COMBAT_DATA, 'element-table.json'));

/**
 * How much of a hit gets through, as a multiplier: attacking element vs the
 * defender's element and level. A player always defends at level 1.
 */
export function attrFix(atkElement: string, defElement: string, defLevel: number): number {
  const table = ELEMENTS.levels[String(Math.min(4, Math.max(1, defLevel)))];
  const pct = table[atkElement]?.[ELEMENTS.order.indexOf(defElement)];
  return (pct ?? 100) / 100;
}

/**
 * Weapon size penalties, the server's own (RTM db/size_fix.yml + db/re/size_fix.yml,
 * edited 2022-10): upstream's 75% cells became 90%, its 50% cells 70% (axes
 * vs Small) or 75% (dagger, whip, book vs Large). The project owner's patch
 * note said 80/90/100; they reckon the server is right (2026-09-26).
 */
const SIZE_FIX: Record<string, [number, number, number]> = {
  // [Small, Medium, Large]
  'Bare Hands': [100, 100, 100],
  Dagger: [100, 90, 75],
  'One-Handed Sword': [90, 100, 90],
  'Two-Handed Sword': [90, 90, 100],
  'One-Handed Spear': [90, 90, 100],
  'Two-Handed Spear': [90, 90, 100],
  'One-Handed Axe': [70, 90, 100],
  'Two-Handed Axe': [70, 90, 100],
  Mace: [90, 100, 100],
  'Two-Handed Mace': [100, 100, 100],
  Staff: [100, 100, 100],
  'Two-Handed Staff': [100, 100, 100],
  Bow: [100, 100, 90],
  Knuckle: [100, 100, 90],
  Instrument: [90, 100, 90],
  Whip: [90, 100, 75],
  Book: [100, 100, 75],
  Katar: [90, 100, 90],
};

export function sizeFix(weaponType: string | undefined, size: string, noPenalty: boolean): number {
  if (noPenalty) return 1;
  // Types not in the table (scythes, decks, guns, the unique weapons) hit every size fully.
  const row = SIZE_FIX[weaponType ?? 'Bare Hands'] ?? [100, 100, 100];
  const i = size === 'Small' ? 0 : size === 'Large' ? 2 : 1;
  return row[i] / 100;
}

const TABLES: { weaponRefineAtk: Record<string, number[]> } =
  readJSON(resolve(COMBAT_DATA, 'server-tables.json'));

/**
 * ATK a weapon's refine adds: the server's db/re/refine.yml, +0.5 / 1 / 1.5
 * / 2 per refine for weapon levels 1-4, floored. Past +10 the table ends;
 * the last step carries on (GUESS). Weapon level 5+ reads as 4.
 */
export function refineAtk(weaponLevel: number, refine: number): number {
  const t = TABLES.weaponRefineAtk[String(Math.min(4, Math.max(1, weaponLevel)))] ?? [0];
  if (refine < t.length) return t[Math.max(0, refine)];
  const last = t.length - 1;
  const step = (t[last] - t[0]) / last;
  return Math.floor(t[last] + (refine - last) * step);
}

// ---- player sheet ----------------------------------------------------------

/**
 * Status ATK for melee, the server's formula (RTM status.cpp:3153):
 * floor((10 STR + 2 DEX + floor(10 LUK/3) + floor(10 level/4)) / 10)
 * + DEX/20 + STR/10. It includes base level / 4, which the codex leaves out;
 * the project owner's status window (2026-09-26, Lv136, STR 123, DEX 65,
 * LUK 65) reads 206, which this gives exactly.
 */
export function statusAtk(s: Stats, level: number): number {
  return Math.floor((10 * s.str + 2 * s.dex + Math.floor((10 * s.luk) / 3) + Math.floor((10 * level) / 4)) / 10)
    + Math.floor(s.dex / 20) + Math.floor(s.str / 10);
}

/** Status MATK, the middle of its min/max (codex INT/DEX/LUK lines). */
export function statusMatk(s: Stats): number {
  return Math.floor(s.int * 1.5) + 2.5 * Math.floor(s.int / 10)
    + Math.floor(s.dex / 5) + Math.floor(s.luk / 3);
}

/** HIT: base level + 2 DEX + LUK/5 + 175 (codex). Gear and passives are added by the caller. */
export const baseHit = (level: number, s: Stats) => level + 2 * s.dex + Math.floor(s.luk / 5) + 175;

/** Perfect Dodge: 1 + (AGI + LUK)/10 (codex). Gear adds on top. */
export const basePerfectDodge = (s: Stats) => 1 + Math.floor((s.agi + s.luk) / 10);

/**
 * Soft DEF: level + VIT + 5 per 10 VIT (RTM status.cpp:3320; the codex's
 * "the part from VIT and level").
 */
export const playerSoftDef = (s: Stats, level: number) => level + s.vit + 5 * Math.floor(s.vit / 10);

/** Soft MDEF: INT + level/4 + 5 per 10 VIT + (DEX + VIT)/5 (RTM status.cpp:3328). */
export const playerSoftMdef = (s: Stats, level: number) =>
  Math.floor(s.int + level / 4 + 5 * Math.floor(s.vit / 10) + (s.dex + s.vit) / 5);

/** Monster soft DEF: level + VIT/2 (RTM status.cpp:3320; upstream halves both). MDEF: (level + INT)/4. */
export const mobSoftDef = (level: number, vit: number) => level + Math.floor(vit / 2);
export const mobSoftMdef = (level: number, int: number) => Math.floor((level + int) / 4);

/**
 * Attack interval from ASPD: 190 swings every 200 ms, 180 every 400 ms --
 * (200 - ASPD) x 20 ms, the renewal rule. The motion (the part a skill
 * waits on) is half of it.
 */
export const attackIntervalMs = (aspd: number) => Math.max(100, (200 - Math.min(199, aspd)) * 20);
export const attackMotionMs = (aspd: number) => attackIntervalMs(aspd) / 2;

/**
 * Cast time in ms. Variable: scaled by DEX and INT (zero at 2 DEX + INT =
 * 400, codex) and by gear's Variable Cast / Cast Time. Fixed: gear only.
 * rAthena's shape (skill.cpp skill_vfcastfix): VCT x (1 - sqrt(stat/scale)).
 */
export function castTimeMs(
  variableMs: number, fixedMs: number, f: Pick<Fighter, 'stats' | 'cast'>,
): number {
  const statCut = 1 - Math.sqrt(Math.min(1, (2 * f.stats.dex + f.stats.int) / TUNE.vctStatScale));
  const gearV = Math.max(0, 1 + (f.cast.variable + f.cast.all) / 100);
  const gearF = Math.max(0, 1 + f.cast.fixed / 100);
  // casting_rate 90: both parts of every cast start 10% shorter (RTM skill.cpp:17996).
  const v = variableMs * TUNE.castingRate; const fx = fixedMs * TUNE.castingRate;
  return Math.max(0, v * statCut * gearV) + Math.max(0, fx * gearF);
}

/**
 * The pause after a skill (RTM skill.cpp:18256-18312): its own delay x
 * (150 - AGI)/150 (none at 150 AGI), x gear's After Cast Delay, x0.9; then
 * the longer of that, the attack motion and the 0.1s floor.
 */
export function skillDelayMs(acdMs: number, f: Pick<Fighter, 'aspd' | 'afterCastDelay'> & { stats?: Stats }): number {
  const agi = f.stats?.agi ?? 0;
  const agiCut = Math.max(0, (150 - agi) / 150);
  const acd = acdMs * agiCut * Math.max(0, 1 + f.afterCastDelay / 100) * TUNE.delayRate;
  return Math.max(TUNE.delayFloorMs, acd, attackMotionMs(f.aspd));
}

// ---- hitting a monster -----------------------------------------------------

/** Your chance to hit, 0..1: HIT - FLEE on a roll that starts at 0 (codex), never under 10% (RTM battle.cpp:3064). */
export const playerHitChance = (hit: number, flee: number) =>
  Math.min(100, Math.max(TUNE.mobHitFloor, hit - flee)) / 100;

/** Your crit chance on this monster, 0..1, with a skill's bonus. */
export function critChance(f: Fighter, m: Monster, bonus = 0): number {
  const shield = Math.min(TUNE.critShieldCap, m.luk * TUNE.critShieldPerLuk);
  return Math.min(100, Math.max(0, f.critRate + bonus - shield)) / 100;
}

export interface PhysicalHit {
  /** Skill ratio in percent; 100 for a normal attack. */
  ratio: number;
  element: string;
  /** Seven Winds carries the endow into status ATK (battle.cpp:3902); otherwise Neutral. */
  statusElement: string;
  ranged: boolean;
  crit: boolean;
  /** Gear's "<skill> DMG +x%". */
  skillDamage: number;
  ignoreDef?: boolean;
  /** A normal attack rather than a skill: both hands land, and no skill doubling. */
  normal?: boolean;
  /** Times the right hand lands in this swing: 2 on a Double Attack (the left hand still once). */
  rightTimes?: number;
}

/**
 * A boss to gear ("DMG vs boss", "Resistance vs non-boss"): an MVP -- and,
 * with PROTOCOL_BOSS=1 in the environment, a boss-protocol monster too
 * (Jormungandr's Lair, Rachel SS: the small icon). Which is right in game is
 * open (the project owner, 2026-09-27); the switch lets a search try both.
 */
const PROTOCOL_BOSS = process.env.PROTOCOL_BOSS === '1';
export const countsAsBoss = (m: Monster) => m.boss || (PROTOCOL_BOSS && !!m.bossProtocol);

/**
 * The target-type multiplier cards and gear give: race x element x size x
 * boss, multiplied (user, 2026-09-25). `d`: whose cards -- the build's (the
 * right hand's) by default, the left hand's own with f.dmgLeft.
 */
export function physicalCardFix(f: Fighter, m: Monster, d: Fighter['dmg'] = f.dmg): number {
  const race = 1 + ((d[`dmg_vs_race_${raceKey(m.race)}`] ?? 0) + (d.dmg_vs_race_all_races ?? 0)) / 100;
  const ele = 1 + (d[`dmg_vs_${m.element.toLowerCase()}`] ?? 0) / 100;
  const size = 1 + ((d[`dmg_vs_size_${m.size.toLowerCase()}`] ?? 0) + (d.dmg_vs_size_all_sizes ?? 0)) / 100;
  const boss = 1 + (d[countsAsBoss(m) ? 'dmg_vs_race_boss' : 'dmg_vs_race_non_boss'] ?? 0) / 100;
  return race * ele * size * boss;
}

export function magicCardFix(f: Fighter, m: Monster, element: string): number {
  const d = f.dmg;
  const race = 1 + ((d[`magic_vs_race_${raceKey(m.race)}`] ?? 0) + (d.magic_vs_race_all_races ?? 0)) / 100;
  const ele = 1 + (d[`magic_dmg_${element.toLowerCase()}`] ?? 0) / 100;
  const size = 1 + ((d[`magic_vs_size_${m.size.toLowerCase()}`] ?? 0) + (d.magic_vs_size_all_sizes ?? 0)) / 100;
  const boss = 1 + (d[countsAsBoss(m) ? 'magic_vs_race_boss' : 'magic_vs_race_non_boss'] ?? 0) / 100;
  const all = 1 + (d.magic_damage ?? 0) / 100;
  return race * ele * size * boss * all;
}

/**
 * One physical hit on a monster. A hand's ATK:
 *
 *   status ATK x element (x2 in the right hand, x1 in the left: TUNE.statusAtkRight/Left)
 * + weapon ATK (base + refine, ±5% per weapon level, +ATK x STR/200) x size x element
 * + equip ATK x element
 * + ATK% of weapon + equip
 * + mastery ATK
 *
 * then x cards (race x element x size x boss): the right hand every card at
 * full strength, the left only its own weapon's (TUNE.cardMode 'final').
 * A normal attack lands each hand's ATK; a skill lands the right hand's
 * ATK x TUNE.skillAtkFactor, whatever the off hand holds. Then x melee% /
 * ranged%, x skill ratio, x hard DEF (after pierce), - soft DEF, x "<skill>
 * DMG%", x crit (critMultiplier).
 *
 * Returns the damage of one hit, rolled (or its middle, in expect mode).
 */
export function physicalDamage(f: Fighter, m: Monster, h: PhysicalHit, rng: Rng): number {
  const final = TUNE.cardMode === 'final';
  const main = handAtk(f, m, f.weapon, h, rng, false) * (final ? physicalCardFix(f, m) : 1) * (h.rightTimes ?? 1);
  // The project owner's dummy test (2026-09-26): taking the off-hand dagger
  // off leaves New Moon and Full Moon where they were (9,615 -> 9,599,
  // 14,776 -> 15,043), so skills read the right hand only -- as the 2023
  // code has it (battle.cpp:2714).
  const off = h.normal && f.offhand
    ? TUNE.leftHand * handAtk(f, m, f.offhand, h, rng, true) * (final ? physicalCardFix(f, m, f.dmgLeft ?? {}) : 1)
    : 0;
  let dmg = h.normal ? main + off : main * TUNE.skillAtkFactor;

  dmg *= 1 + (h.ranged ? f.dmg.ranged_damage ?? 0 : f.dmg.melee_damage ?? 0) / 100;
  dmg *= h.ratio / 100;
  if (!h.ignoreDef) {
    dmg = dmg * defMultiplier(m.def, effectivePierce(f.defPen)) - m.softDef;
  }
  dmg *= 1 + h.skillDamage / 100;
  if (h.crit) {
    // Each hand crits by its own multiplier; split the hit by their shares.
    const share = h.normal && off > 0 ? main / (main + off) : 1;
    // Both hands by the one formula, each with its own Crit Damage (the
    // right weapon's is not the left's): the owner's crits of 2026-09-27
    // read left 726 / 530 = 1.370 (this: 1.368; the code's off-hand branch
    // 1.20) and right 2,058 / 1,401 = 1.469 (this: 1.428).
    const left = { ...f, critDamage: f.critDamageLeft ?? f.critDamage };
    dmg *= share * critMultiplier(f, h.normal)
      + (1 - share) * (TUNE.offhandCritSame ? critMultiplier(left, true) : offhandCritMultiplier(f));
  }
  return Math.max(1, dmg);
}

/**
 * Your crit, after DEF and element (RTM battle.cpp:6303-6308): x1.2 x (1 +
 * LUK/5 % on a normal attack, LUK/10 % on a skill, + Crit Damage/2 %), as
 * the code has it. Skills: the owner's Shadow Slash (2026-09-26) 1,545 /
 * 1,195 = 1.293 (formula 1.296). Normal attacks: the owner's autos of
 * 2026-09-27 (LUK 62) left 1.370 (1.368), right 1.469 (1.428).
 */
export function critMultiplier(f: Pick<Fighter, 'stats' | 'critDamage'>, normal = false): number {
  const luk = Math.floor(f.stats.luk / (normal ? 5 : 10));
  return TUNE.critBase * (1 + (luk + Math.floor(f.critDamage / 2)) / 100);
}

/**
 * The off hand's crit on a normal attack: the code's other dual-wield
 * branch, x1.1 x (1 + LUK/10 % + Crit Damage/4 %) (RTM battle.cpp:6309-6314).
 * The owner's off-hand crit read 493 / 401 = 1.229; this gives 1.18.
 */
export function offhandCritMultiplier(f: Pick<Fighter, 'stats' | 'critDamage'>): number {
  return 1.1 * (1 + (Math.floor(f.stats.luk / 10) + Math.floor(f.critDamage / 4)) / 100);
}

/** One hand's ATK before cards (in 'final' mode), melee%, the skill ratio and DEF. */
function handAtk(f: Fighter, m: Monster, w: Fighter['weapon'], h: PhysicalHit, rng: Rng, left: boolean): number {
  const s = f.stats;
  const statusPart = statusAtk(s, f.level) * attrFix(h.statusElement, m.element, m.elementLevel)
    * (left ? TUNE.statusAtkLeft : TUNE.statusAtkRight);

  let weaponPart = 0;
  if (w) {
    // Refine ATK sits inside the rolled base; a crit does not take the top
    // of the roll (RTM battle.cpp:2275-2284).
    const base = w.atk + refineAtk(w.level, w.refine);
    const variance = 0.05 * w.atk * w.level;
    const strBonus = (w.atk * s.str) / 200;
    const rolled = rng.between(base - variance, base + variance);
    weaponPart = Math.max(0, rolled + strBonus)
      * sizeFix(w.type, m.size, (f.dmg.no_size_penalty ?? 0) > 0)
      * attrFix(h.element, m.element, m.elementLevel);
  }
  const equipPart = f.equipAtk * attrFix(h.element, m.element, m.elementLevel);

  // cardMode 'parts' only: the 2023 code's half-strength cards on the parts.
  const half = TUNE.cardMode === 'parts' ? 1 + (physicalCardFix(f, m) - 1) * TUNE.cardShare : 1;
  // ATK%: on every part, status and mastery too, with TUNE.atkPercentAll
  // (renewal RE_ALLATK_ADDRATE, RTM battle.cpp:3685-3686); else weapon and equip only.
  const percentPart = (weaponPart + equipPart + (TUNE.atkPercentAll ? statusPart + f.masteryAtk : 0)) * f.atkPercent / 100;
  return statusPart * (TUNE.cardOnStatus ? half : 1) + (weaponPart + equipPart) * half + percentPart + f.masteryAtk;
}

export interface MagicHit {
  ratio: number;
  element: string;
  skillDamage: number;
  /** Extra % from Elemental Focus and the like, additive with each other. */
  bonus: number;
}

/** One magic hit on a monster: MATK x ratio x cards x MDEF curve - soft MDEF x element. */
export function magicDamage(f: Fighter, m: Monster, h: MagicHit, rng: Rng): number {
  const base = statusMatk(f.stats) + rng.between(f.matk.weapon * 0.9, f.matk.weapon * 1.1) + f.matk.equip;
  let dmg = base * (1 + f.matk.percent / 100);
  dmg *= h.ratio / 100;
  dmg *= magicCardFix(f, m, h.element);
  dmg *= 1 + h.bonus / 100;
  dmg = dmg * mdefMultiplier(m.mdef, effectivePierce(f.mdefPen)) - m.softMdef;
  dmg *= 1 + h.skillDamage / 100;
  dmg *= attrFix(h.element, m.element, m.elementLevel);
  return Math.max(1, dmg);
}

// ---- being hit -------------------------------------------------------------

/** A monster's chance to hit you, 0..1: its HIT - your FLEE, floor 10% (codex). */
export const mobHitChance = (mobHit: number, flee: number) =>
  Math.min(100, Math.max(TUNE.mobHitFloor, mobHit - flee)) / 100;

/** Your Perfect Dodge chance against a normal attack, 0..1 (cap 100, codex). */
export const perfectDodgeChance = (pd: number) => Math.min(100, Math.max(0, pd)) / 100;

/** What your gear takes off a hit from this monster, as one multiplier. */
export function resistFix(
  f: Fighter, m: Monster, element: string, kind: 'physical' | 'magic', ranged: boolean,
): number {
  const r = f.res;
  const cut = (pct: number) => Math.max(0, 1 - pct / 100);
  let mult = cut(r[`res_${element.toLowerCase()}`] ?? 0)
    * cut((r[`res_race_${raceKey(m.race)}`] ?? 0) + (r.res_race_all_races ?? 0))
    * cut((r[`def_vs_size_${m.size.toLowerCase()}`] ?? 0) + (r.def_vs_size_all_sizes ?? 0))
    * cut(r[countsAsBoss(m) ? 'res_race_boss' : 'res_race_non_boss'] ?? 0)
    * cut(r.damage_reduction ?? 0);
  if (kind === 'physical') {
    mult *= cut(r[ranged ? 'res_ranged' : 'res_melee'] ?? 0);
    mult *= Math.max(0, 1 + (r.physical_damage_received ?? 0) / 100);
  } else {
    mult *= Math.max(0, 1 + (r.magic_damage_received ?? 0) / 100);
  }
  return mult;
}

/**
 * One application of a monster's hit on you, before flee and dodges are
 * rolled. `hits` multiplies it (rAthena HitCount: one roll, N times the damage).
 *
 * Physical (RTM battle.cpp:2338-2419, 5610, 6214-6404): ATK rolled 80-120%
 * + STR + level, x ratio, x your hard DEF curve - soft DEF, x element,
 * x your resistances. A crit takes the top of the roll x1.4, still goes
 * through DEF, and x1.2 after. `ignoreDef` skips DEF (Critical Slash,
 * Vampire Gift).
 *
 * Magic (RTM battle.cpp:6629-7299): INT + level + Attack2 rolled 70-130%,
 * x ratio, x resistances, x your MDEF curve - soft MDEF, x element.
 *
 * `ranged` decides melee vs ranged resistance: a monster within 3 cells is
 * melee, whatever its reach (skillrange_by_distance).
 */
export function mobDamage(
  m: Monster, f: Fighter,
  skill: Pick<MobSkill, 'type' | 'element' | 'ratio'>
    & { crit?: boolean; hits?: number; ignoreDef?: boolean; flat?: number },
  rng: Rng, ranged = false,
): number {
  if (skill.type === 'status' || skill.type === 'none') return 0;
  const eleFix = attrFix(skill.element, f.element, 1);
  const res = resistFix(f, m, skill.element, skill.type, ranged);
  const hits = Math.max(1, skill.hits ?? 1);
  let dmg: number;
  if (skill.type === 'physical') {
    const [lo, hi] = TUNE.mobAtkSpread;
    const atk = skill.crit ? m.atk * hi * TUNE.mobCritPre : rng.between(m.atk * lo, m.atk * hi);
    dmg = ((atk + m.str + m.level) * (skill.ratio / 100) + (skill.flat ?? 0)) * hits;
    if (!skill.ignoreDef) dmg = dmg * defMultiplier(f.def, 0) - f.softDef;
    dmg = Math.max(1, dmg) * eleFix;
    if (skill.crit) dmg *= TUNE.mobCritPost;
    dmg *= res;
  } else {
    const [lo, hi] = TUNE.mobMatkSpread;
    dmg = ((m.matkBase + rng.between(m.matk * lo, m.matk * hi)) * (skill.ratio / 100) + (skill.flat ?? 0)) * hits * res;
    if (!skill.ignoreDef) dmg = dmg * mdefMultiplier(f.mdef, 0) - f.softMdef;
    dmg = Math.max(1, dmg) * eleFix;
  }
  return Math.max(eleFix > 0 ? 1 : 0, dmg);
}

// ---- status effects on you ---------------------------------------------------

/**
 * The share of a status that gets through your stats, and how much of its
 * duration: RTM status.cpp:9102-9441 (status_get_sc_def). Per effect, a
 * percent cut (sc_def, in 1/100 %) and a flat one (sc_def2), both x0.95 and
 * capped at 95% for players (conf/battle/status.conf); then gear's
 * "resistance to <status>" multiplies. Durations shrink by the percent and a
 * flat LUK term. Effects not listed here cannot be resisted.
 */
export function statusResist(
  f: Pick<Fighter, 'stats' | 'mdef' | 'level' | 'statusRes'>, sc: string, rule: string,
  baseChance: number, mobLevel: number, mobLuk: number,
): { chance: number; duration: number; flatMs: number } {
  const s = f.stats;
  const table: Record<string, { def: number; def2: number; tick?: number; tick2Ms: number }> = {
    stun: { def: s.vit * 50, def2: s.luk * 20, tick2Ms: s.luk * 20 },
    silence: { def: s.int * 75, def2: (s.vit + s.luk) * 5 + (f.level - mobLevel) * 10, tick2Ms: s.luk * 20 },
    bleeding: { def: s.agi * 50, def2: s.luk * 20, tick2Ms: s.luk * 20 },
    sleep: { def: s.agi * 50, def2: s.luk * 20, tick2Ms: s.luk * 20 },
    stone: { def: f.mdef * 100, def2: s.luk * 20, tick: 0, tick2Ms: 0 },
    freeze: { def: f.mdef * 100, def2: s.luk * 20, tick2Ms: -mobLuk * 10 },
    blind: { def: (s.vit + s.int) * 50, def2: s.luk * 20, tick2Ms: s.luk * 10 },
    confusion: { def: (s.str + s.int) * 50, def2: (mobLevel - f.level) * 10 - s.luk * 20, tick2Ms: s.luk * 20 },
    decagi: { def: 0, def2: f.mdef * 100, tick2Ms: 0 },
  };
  const t = table[rule];
  const gear = Math.max(0, 1 - (f.statusRes[`res_status_${sc === 'root' ? 'stun' : sc}`] ?? 0) / 100);
  if (!t) return { chance: Math.min(1, baseChance) * gear, duration: 1, flatMs: 0 };
  const cap = (v: number) => Math.min(9500, Math.max(-9500, v * 0.95));
  const def = cap(t.def);
  const def2 = cap(t.def2);
  // Rates are in 1/10000: rate -= rate*def/10000; rate -= def2.
  const rate = baseChance * 10000 * (1 - def / 10000) - def2;
  const tickDef = cap(t.tick ?? t.def);
  return {
    chance: Math.min(1, Math.max(0, rate / 10000)) * gear,
    duration: Math.max(0, 1 - tickDef / 10000),
    flatMs: t.tick2Ms * 0.95,
  };
}

/** The planner's race keys: "Undead" the race is undead_race, "Demi-Human" demihuman. */
export function raceKey(race: string): string {
  const k = race.toLowerCase().replace(/[^a-z]/g, '');
  return k === 'undead' ? 'undead_race' : k;
}
