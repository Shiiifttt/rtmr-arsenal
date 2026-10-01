/**
 * Night Raven: the Assassin line's Blade Dancer final job (server job slot
 * Guillotine_Cross; its tree is Thief + Assassin + Blade Dancer + Night
 * Raven, as the live tooltips list it -- the 2023 tree file wires the slot to
 * High_Priest, an artefact). Daggers, swords, axes and katars; dual wields.
 *
 * Built 2026-10-01 from the tooltips, the patch notes and the 2023 code, with
 * no owner readings yet. The rule for every kit: the live tooltip
 * (data/raw/db-skills.json, identical to rtm-database.pages.dev that day)
 * wins, then the patch notes, and the code fills only what a tooltip leaves
 * unsaid. Research: .claude/scratch/nightraven-server.md (code, every
 * disagreement) and nightraven-live.md (live text, patches, items).
 *
 * Four builds (the project owner, 2026-10-01):
 *   - pure auto-attack: crit damage and racials, the weapon element from cards;
 *   - raven auto-attack: LUK / DEX / long range, for the auto Blitz Beat that
 *     a Dagger + Sword swing fires (Neutral, but for the Hrafnsmal pair);
 *   - Definitive Dagger: cast it as fast as it comes back;
 *   - Counter Slash: get into Counter state and stay there; the Quarry Gem's
 *     Typhoon Edge autocast for monsters that cannot be knocked back.
 * The last two run short of SP and may use Night Wound / Dark Claw.
 *
 * How the pieces work:
 *   - Night Wound (SC_JYUMONJIKIRI, on the target): Southern Cross 5 s, Blitz
 *     Beat (manual and auto) 3 s, on a hit it survives; a lower level does not
 *     replace a higher one. Read by Definitive Dagger, Northern Cross, Soul
 *     Destroyer, Southern Cross, Bloody Fangs; never consumed.
 *   - Counter state (SC_WEAPONBLOCK_ON): 5 s from a Weapon Blocking block
 *     (15 + 2%/lv, engine landMobHit), 1 s a level from Midnight Eye while
 *     Weapon Blocking is up. Counter Slash needs it and does not spend it.
 *   - Rolling Counters (SC_ROLLINGCUTTER): +1 a Counter Slash, 5 at most,
 *     3 s. Counter Slash hits stacks + 1 times; Typhoon Edge +10% a stack.
 *   - Skills use the right hand only and cannot crit (no Night Raven or Blade
 *     Dancer skill has the Critical flag); normal attacks use both hands.
 *
 * Class Gems (Patch 19) are gear in the gem slot; the kit reads the lines
 * the parser leaves as prose (gemOf).
 */
import type { Passives } from '../character.ts';
import { defMultiplier, effectivePierce } from '../../../sim/src/derived.ts';
import { attrFix, countsAsBoss, escapeCells, magicDamage, physicalDamage, skillDelayMs, attackIntervalMs, TUNE } from '../formulas.ts';
import type { Fighter, MobSkill, Monster } from '../model.ts';
import {
  canUse, dot, grant, has, heal_, mobHas, noteProc, readMarks, readyAt, say, stacks, strike, targetNow,
  type Action, type Fight, type Kit,
} from '../engine.ts';
import {
  assessThreat, awayFor, backSlide, breakSight, cellMs, escapeMs, hidingAction, lv, morrocsMark, optionOn, orphanHeal, pullOffWard, reactionMs,
  returnMs, stayHidden, swingWait, toolkit, waitAction, walkOut, weaveMs,
} from './common.ts';
import {
  COMMON_TOOLS, heldForSnap, isPreempt, moveTool, predictActions, priorityWith, reactWith, snapThreatDue, stayReadyAction, type DefenseTool,
} from './defense.ts';

const TREE = ['Night Raven', 'Blade Dancer', 'Assassin', 'Thief', 'Orphan'];

/** Enchant Poison makes every physical attack Poison; else the right weapon's element. */
const element = (fight: Fight) => (has(fight, 'poisonEndow') ? 'Poison' : fight.f.weapon?.element ?? 'Neutral');
const T = toolkit(TREE, element);
const { cast, spCost, learned } = T;

export const ALIASES: Record<string, string[]> = {};

const SKILLS = [
  // Night Raven
  'Advanced Blade Mastery', 'Blitz Beat', 'Bloody Fangs', 'Definitive Dagger', 'Midnight Eye', 'Night Hunt',
  'Northern Cross', 'Raven Pact', 'Raven Steps', 'Rising Wings', 'Sky Assault', 'Steel Wings', 'Typhoon Edge',
  // Blade Dancer
  'Counter Slash', 'Dark Claw', 'Soul Destroyer', 'Southern Cross', 'Weapon Blocking',
  // Assassin
  'Blade Mastery', 'Katar Mastery', 'Left Hand Mastery', 'Right Hand Mastery', 'Shadow Mastery', 'Shadow Slash', 'Quickening', 'Fury',
  'Hallucination Walk', 'Magic Pierce',
  // Thief
  'Back Stab', 'Enchant Poison', 'Improve Dodge', 'Improve Defense', 'Improve Wisdom', 'Increase SP Recovery',
  // Orphan
  'Hiding', 'Heal', "Morroc's Mark",
];

export function maxLevels(): Record<string, number> {
  return Object.fromEntries(SKILLS.map((n) => [n, T.sk(n).row.max]));
}

const BLADES = new Set(['Dagger', 'Sword', 'Long Sword']);
const isSword = (t: string | null | undefined) => t === 'Sword' || t === 'Long Sword';

export function passives(levels: Record<string, number>, weaponType: string | null, baseLevel: number): Passives {
  const L = (n: string) => levels[n] ?? 0;
  const blade = BLADES.has(weaponType ?? '');
  const katar = weaponType === 'Katar';
  return {
    // Blade Mastery "3 Atk per level", Advanced Blade Mastery "3 Atk and 5 hit
    // per level" (Patch 18 fixed it from 2 to 3): daggers and swords.
    masteryAtk: blade ? 3 * L('Blade Mastery') + 3 * L('Advanced Blade Mastery') : katar ? 3 * L('Katar Mastery') : 0,
    // Katar Mastery "3 ATK and 1 CRIT per level" (Patch 18: the crit now works).
    crit: katar ? L('Katar Mastery') : 0,
    hit: blade ? 5 * L('Advanced Blade Mastery') : 0,
    // Improve Dodge 4/lv, Shadow Mastery 3/lv.
    flee: 4 * L('Improve Dodge') + 3 * L('Shadow Mastery'),
    hpFlat: L('Improve Defense') * baseLevel,
    spFlat: Math.floor((L('Improve Wisdom') * 2 * baseLevel) / 3),
    hpPercent: 0,
    spRegen: { flat: 2 * L('Increase SP Recovery'), maxShare: 0.001 * L('Increase SP Recovery') },
    // Magic Pierce "Defense Penetration is 1 per level", self-cast before the pull.
    defPen: L('Magic Pierce'),
    notes: [
      'passives: Blade Masteries (ATK/HIT), Improve Dodge + Shadow Mastery (flee), Improve Defense/Wisdom, '
        + 'Increase SP Recovery, Magic Pierce (DEF pen, up before the pull); Left/Right Hand Mastery 5 (both hands whole)',
    ],
  };
}

// ---- the build's shape -------------------------------------------------------------

const L = (fight: Fight, n: string) => lv(fight.f, n);
const dualDaggers = (f: Fighter) => f.weapon?.type === 'Dagger' && f.offhand?.type === 'Dagger';
const dualSwords = (f: Fighter) => isSword(f.weapon?.type) && isSword(f.offhand?.type);
/** Dagger + Sword, either hand: the auto Blitz Beat's pair (server W_DOUBLE_DS). */
const daggerSword = (f: Fighter) => (f.weapon?.type === 'Dagger' && isSword(f.offhand?.type))
  || (isSword(f.weapon?.type) && f.offhand?.type === 'Dagger');
const dual = (f: Fighter) => !!f.weapon && !!f.offhand;

/**
 * The Hrafnsmal pair (Hrafnsax + Sigrsverd), as Patch 21 (2026-09-27) left
 * it: Blitz Beat and Sky Assault take the main hand's element (Endows too),
 * and each Blitz Beat may cast Sky Assault Lv3: 5%, 10% from a combined
 * refine of +12, 15% from +18. The local crawl still has the old set text.
 */
function hrafnsmal(f: Fighter): { on: boolean; skyChance: number } {
  const names = new Set([f.weapon?.name, f.offhand?.name]);
  if (!names.has('Hrafnsax') || !names.has('Sigrsverd')) return { on: false, skyChance: 0 };
  const r = (f.weapon?.refine ?? 0) + (f.offhand?.refine ?? 0);
  return { on: true, skyChance: r >= 18 ? 0.15 : r >= 12 ? 0.1 : 0.05 };
}

/** A line on the gear worn the parser leaves as prose, cached per fighter. */
const saidCache = new WeakMap<Fighter, Map<string, boolean>>();
function gearSays(f: Fighter, rx: RegExp): boolean {
  let m = saidCache.get(f);
  if (!m) saidCache.set(f, m = new Map());
  let v = m.get(rx.source);
  if (v === undefined) m.set(rx.source, v = rx.test(f.gearText ?? ''));
  return v;
}
const crow = (f: Fighter) => f.weapon?.name === 'Crow of Destiny';

/**
 * "ASPD +1 per Steel Wings Level": the Twin Crows pair (Hugin + Muninn) and
 * the Hrafnsmal pair at a combined refine of +6 -- flat ASPD, up to the limit.
 */
function steelWingsAspd(f: Fighter): number {
  const names = new Set([f.weapon?.name, f.offhand?.name]);
  const twin = names.has('Hugin') && names.has('Muninn');
  const hraf = names.has('Hrafnsax') && names.has('Sigrsverd') && (f.weapon?.refine ?? 0) + (f.offhand?.refine ?? 0) >= 6;
  return twin || hraf ? f.skillLevels['Steel Wings'] ?? 0 : 0;
}

// ---- the Class Gems (the gem slot) ------------------------------------------------

/**
 * The Night Raven gems (Patch 19) are in the item data with their numbers
 * parsed -- All Stats -5, skill damage and cooldowns, ASPD, SP cost, HP --
 * so the planner counts those. The kit reads only their prose lines.
 */
type Gem = 'quarry' | 'omen' | 'armory' | 'hawk' | 'eclipse';
const GEMS: Record<string, Gem> = {
  'Quarry Gem of Endless Tracking': 'quarry', 'Omen Gem of a Thousand Blades': 'omen', 'Armory Gem of Mastery': 'armory',
  'Hawk Gem of Night Skies': 'hawk', 'Eclipse Gem of Covered Skies': 'eclipse',
};
const gemOf = (fight: Fight): Gem | null => GEMS[fight.f.classGem?.name ?? ''] ?? null;
const gemRefine = (fight: Fight) => fight.f.classGem?.refine ?? 0;

/**
 * A gem's skill damage % the parser leaves: the Hawk Gem's Blitz Beat +1% a
 * DEX -- "per total DEX" since Patch 21 (the local crawl still says "base").
 */
function gemDamage(fight: Fight, name: string): number {
  if (gemOf(fight) === 'hawk' && name === 'Blitz Beat') return fight.f.stats.dex;
  return 0;
}

// ---- timing -----------------------------------------------------------------------

/** After-cast delays the tooltips leave out, from the 2023 skill_db (ms). */
const ACD: Record<string, number> = {
  'Definitive Dagger': 1000, 'Northern Cross': 500, 'Southern Cross': 500, 'Midnight Eye': 500, 'Typhoon Edge': 1000,
  'Counter Slash': 250, 'Blitz Beat': 1000, 'Sky Assault': 1000, 'Bloody Fangs': 500, 'Soul Destroyer': 500,
  'Weapon Blocking': 1000, 'Back Stab': 500,
};
const delay = (id: string) => (fight: Fight) => skillDelayMs(ACD[id] ?? 0, fight.f);

/**
 * Cooldowns: the tooltip's ("Base starting cooldown is 1 second"), its "per
 * level" parts read here where the parser leaves them (Southern Cross
 * "2.5s-0.1s per level", Blitz Beat "3 seconds -0.5 per level", Sky Assault
 * "15 seconds, decreases by 1 second per level"), gear's cuts and the gem's.
 */
const BASE_CD: Record<string, (l: number) => number> = {
  'Southern Cross': (l) => 2500 - 100 * l,
  'Blitz Beat': (l) => 3000 - 500 * l,
  'Sky Assault': (l) => 15000 - 1000 * l,
  // Rising Wings: no cooldown in the tooltip; the Hawk Gem "Removes" one -- the 2023 code's 120 s.
  'Rising Wings': () => 120_000,
  // Raven Steps: "Cooldown is 2s per level(Max 10s)".
  'Raven Steps': (l) => 2000 * l,
};
const cooldown = (name: string) => (fight: Fight) => {
  const l = L(fight, name);
  const base = BASE_CD[name]?.(l) ?? T.sk(name).text.cooldown(l);
  if (name === 'Rising Wings' && gemOf(fight) === 'hawk') return 0;
  if (name === 'Dark Claw' && gemOf(fight) === 'eclipse') return 0;
  return Math.max(0, base + fight.f.skillMods(name, 'cooldown').flat * 1000);
};
const cost = (name: string) => spCost(name);

// ---- the states ------------------------------------------------------------------

/** Night Wound on the target: its level, 0 when none. */
const nightWound = (fight: Fight) => (mobHas(fight, 'nightWound') ? fight.mob.debuffs.nightWound.value ?? 1 : 0);
const nightWoundLeft = (fight: Fight) => (mobHas(fight, 'nightWound') ? fight.mob.debuffs.nightWound.until - fight.t : 0);
/** A lower level does nothing while a higher one lasts (RTM status.cpp:10709). */
function woundTarget(fight: Fight, ms: number, level: number) {
  if (nightWound(fight) > level) return;
  // Uptime for the report: the time this adds past what was already covered.
  const was = Math.max(fight.t, fight.mob.debuffs.nightWound?.until ?? -1);
  if (fight.meter && fight.t + ms > was) (fight.meter.uptime ??= {})['Night Wound'] = (fight.meter.uptime['Night Wound'] ?? 0) + fight.t + ms - was;
  fight.mob.debuffs.nightWound = { until: fight.t + ms, stacks: 1, value: level };
}
const landedAlive = (fight: Fight, dealt: number) => dealt > 0 && !fight.result;

const counter = (fight: Fight) => has(fight, 'counter');
const counterLeft = (fight: Fight) => (counter(fight) ? fight.me.buffs.counter.until - fight.t : 0);
function grantCounter(fight: Fight, ms: number) {
  fight.me.buffs.counter = { until: Math.max(fight.me.buffs.counter?.until ?? -1, fight.t + ms), stacks: 1 };
}
const rolling = (fight: Fight) => stacks(fight, 'rolling');
const MAX_ROLLING = 5;

/** Rising Wings: "Overall Attack Bonus is 1% per level" -- the code's +lv on the ratio of weapon skills and normal attacks. */
const wings = (fight: Fight) => (has(fight, 'risingWings') ? L(fight, 'Rising Wings') : 0);
/** Fury: "CRIT bonus is 1 per level", doubled with a katar. */
const furyCrit = (fight: Fight) => (has(fight, 'fury') ? L(fight, 'Fury') * (fight.f.weapon?.type === 'Katar' ? 2 : 1) : 0);
/**
 * Dark Claw: the target takes "2% per level more damage from melee physical
 * attacks" for 5 s; half against a boss (2023 code, battle.cpp:1502-1511).
 */
const clawMult = (fight: Fight) => (mobHas(fight, 'darkClaw')
  ? 1 + ((fight.mob.debuffs.darkClaw.value ?? 0) * (countsAsBoss(fight.m) ? 0.5 : 1)) / 100 : 1);

/** Can the target be knocked back? Option knockback (true / false) overrides the monster's mode. */
function knockable(fight: Fight): boolean {
  const o = fight.options.knockback;
  if (typeof o === 'boolean') return o;
  const m = fight.m;
  return !m.noKnockback && !m.boss && !m.bossClass;
}

// ---- damage -----------------------------------------------------------------------

/**
 * A weapon skill's hit: right hand, the weapon's (or Enchant Poison's)
 * element, no crit. `flat`: added per hit after the ratio, through DEF
 * (Steel Wings on Counter Slash, the Armory Gem's Max HP on Northern Cross).
 */
function hit(fight: Fight, name: string, ratio: number, o: { ranged?: boolean; flat?: number } = {}) {
  const f = fight.f; const m = targetNow(fight);
  const skillDamage = f.skillMods(name, 'damage').percent + gemDamage(fight, name);
  const ele = element(fight);
  const claw = o.ranged ? 1 : clawMult(fight);
  return (crit: boolean) => {
    let d = physicalDamage(f, m, { ratio, element: ele, statusElement: 'Neutral', ranged: !!o.ranged, crit, skillDamage }, fight.rng);
    if (o.flat) d += o.flat * defMultiplier(m.def, effectivePierce(f.defPen)) * attrFix(ele, m.element, m.elementLevel) * (1 + skillDamage / 100);
    return d * claw;
  };
}

/** A skill learned, held in a usable hand, off cooldown: the common gate. */
const blade = (fight: Fight) => BLADES.has(fight.f.weapon?.type ?? '');

// ---- the Raven -----------------------------------------------------------------------

/**
 * Blitz Beat's damage: "Base 50 per level + Luk", "Luk bonus is multiplied
 * by Steel Wings Lv" -- for the whole cast, one roll shown as 3 (the 2023
 * code: the tooltip never says "per hit", and the project owner's rule,
 * 2026-10-01, is the server code first, the crawl only where it says
 * otherwise). Option blitzDamage 'hit': per hit instead, the hit count
 * "random based on job Lv" for the auto ones. "Ranged Damage bonuses apply", ignores DEF,
 * never misses; Neutral unless the Hrafnsmal pair gives the main hand's
 * element. Steel Wings' "extra damage multiplier" has no number: left out.
 */
function blitzDamage(fight: Fight, level: number, hits: number): number {
  const f = fight.f; const m = targetNow(fight);
  const per = 50 * level + f.stats.luk * L(fight, 'Steel Wings');
  const ele = hrafnsmal(f).on ? element(fight) : 'Neutral';
  const skillDamage = f.skillMods('Blitz Beat', 'damage').percent + gemDamage(fight, 'Blitz Beat');
  const n = fight.options.blitzDamage === 'hit' ? hits : 1;
  return per * n * (1 + (f.dmg.ranged_damage ?? 0) / 100) * (1 + skillDamage / 100) * attrFix(ele, m.element, m.elementLevel);
}

/** One Blitz Beat landing: 3x3, Night Wound 3 s, and the item procs of Sky Assault. */
function blitz(fight: Fight, id: string, level: number, hits: number, share = 1) {
  const dealt = strike(fight, id, { hits, split: true, canMiss: false, critBonus: null, kind: 'ranged', aoe: true, skill: true,
    damage: () => blitzDamage(fight, level, hits) * share });
  if (landedAlive(fight, dealt) && share >= 0.5) woundTarget(fight, 3000, level);
  if (fight.result) return;
  // Sky Assault off a Blitz Beat: the Hrafnsmal pair (Lv3), the Hawk Gem (0.5% a refine), at their own level.
  const h = hrafnsmal(fight.f);
  const p = (h.skyChance + (gemOf(fight) === 'hawk' ? 0.005 * gemRefine(fight) : 0)) * share;
  if (p > 0) {
    if (fight.rng.expect) skyAssault(fight, 3, 'Sky Assault (autocast)', p);
    else if (fight.rng.chance(p)) skyAssault(fight, 3, 'Sky Assault (autocast)');
  }
  // Crow of Destiny: "Blitz Beat autocasts Sky Assault, 1% chance per refine", at the learned level.
  const c = crow(fight.f) ? Math.min(1, 0.01 * (fight.f.weapon?.refine ?? 0)) * share : 0;
  if (c > 0 && L(fight, 'Sky Assault') > 0 && !fight.result) {
    if (fight.rng.expect) skyAssault(fight, L(fight, 'Sky Assault'), 'Sky Assault (autocast)', c);
    else if (fight.rng.chance(c)) skyAssault(fight, L(fight, 'Sky Assault'), 'Sky Assault (autocast)');
  }
}

/**
 * The auto Blitz Beat on a normal attack (2023 code, skill.cpp:1306-1326,
 * tooltips the same): Dagger + Sword, "1% per 5 Luk" a swing that lands and
 * leaves the target standing, x4 under Rising Wings; at the learned level
 * (Job 41+), free. The hits: "random based on job Lv" -- 1 to 5 (job 70,
 * capped by the level), 3 on average. A rollout weighs it in at its chance.
 */
function autoBlitz(fight: Fight) {
  const f = fight.f;
  if (!daggerSword(f) || L(fight, 'Blitz Beat') <= 0 || fight.result || optionOn(fight, 'raven') === false) return;
  const p = Math.min(1, ((2 * f.stats.luk + 2) / 1000) * (has(fight, 'risingWings') ? 4 : 1));
  const level = L(fight, 'Blitz Beat');
  if (fight.rng.expect) { blitz(fight, 'Blitz Beat (auto)', level, 3, p); return; }
  if (!fight.rng.chance(p)) return;
  fight.log && say(fight, 'the Raven strikes (auto Blitz Beat)');
  blitz(fight, 'Blitz Beat (auto)', level, 1 + Math.floor(fight.rng.next() * level));
}

const blitzBeat: Action = {
  id: 'Blitz Beat',
  isSkill: true,
  offensive: true,
  findsCloaked: true,
  ready: (fight) => learned('Blitz Beat')(fight),
  castMs: cast('Blitz Beat'),
  delayMs: delay('Blitz Beat'),
  cooldownMs: cooldown('Blitz Beat'),
  spCost: cost('Blitz Beat'),
  // "Hit amount if fixed for manual cast": the 3 the skill's data shows.
  resolve(fight) { blitz(fight, 'Blitz Beat', L(fight, 'Blitz Beat'), 3); },
};

/**
 * Sky Assault: "50 per level plus 2xLuk+Dex", "Luk+Dex bonus is multiplied
 * by 2x Steel Wings Lv" -- 50 lv + (2 LUK + DEX) x 2 x Steel Wings. Never
 * misses, ignores DEF, leech applies, long range bonuses apply (the project
 * owner, 2026-10-01: the Raven counts as long range on this server). Neutral
 * but for the Hrafnsmal pair.
 */
function skyAssault(fight: Fight, level: number, id = 'Sky Assault', share = 1) {
  const f = fight.f; const m = targetNow(fight);
  const ele = hrafnsmal(f).on ? element(fight) : 'Neutral';
  const skillDamage = f.skillMods('Sky Assault', 'damage').percent;
  const dmg = (50 * level + (2 * f.stats.luk + f.stats.dex) * 2 * L(fight, 'Steel Wings'))
    * (1 + (f.dmg.ranged_damage ?? 0) / 100) * (1 + skillDamage / 100) * attrFix(ele, m.element, m.elementLevel) * share;
  strike(fight, id, { hits: 1, canMiss: false, critBonus: null, kind: 'ranged', skill: true, damage: () => dmg });
}
const skyAssaultAction: Action = {
  id: 'Sky Assault',
  isSkill: true,
  offensive: true,
  ready: learned('Sky Assault'),
  castMs: cast('Sky Assault'),
  delayMs: delay('Sky Assault'),
  cooldownMs: cooldown('Sky Assault'),
  spCost: cost('Sky Assault'),
  resolve(fight) { skyAssault(fight, L(fight, 'Sky Assault')); },
};

// ---- the swing ------------------------------------------------------------------------

/**
 * Night Hunt (PA_SACRIFICE), tooltip: each normal attack becomes "100 per
 * level + 3 x all stats" x "10% per level" (x2 at Lv10), "unaffected by %
 * effects", ignores DEF, no Double Attack, x1.25 "at red health" (read as
 * under 25%), 2 x level attacks, each costing 7% Max HP. Element and cards
 * do not touch it. No auto Blitz Beat on its swings (code: a skill hit).
 */
function nightHuntSwing(fight: Fight) {
  const f = fight.f; const s = f.stats; const l = L(fight, 'Night Hunt');
  const red = fight.me.hp < 0.25 * f.maxHp ? 1.25 : 1;
  const dmg = (100 * l + 3 * (s.str + s.agi + s.vit + s.int + s.dex + s.luk)) * (1 + (10 * l) / 100) * red;
  fight.me.hp -= Math.floor(0.07 * f.maxHp);
  const b = fight.me.buffs.nightHunt;
  if (--b.stacks <= 0) delete fight.me.buffs.nightHunt;
  strike(fight, 'Night Hunt', { hits: 1, canMiss: true, critBonus: null, damage: () => dmg });
  if (fight.me.hp <= 0 && !fight.result) { fight.result = 'loss'; fight.cause = 'Night Hunt (its HP cost)'; }
}
/**
 * No swing woven in between skill casts (the project owner, 2026-10-02: "aa
 * windows have to be 1 second+"): the swing only while no skill the order
 * plays comes up within option swingGapMs (1000; 0 weaves again).
 */
function swingGap(fight: Fight): boolean {
  const gap = typeof fight.options.swingGapMs === 'number' ? fight.options.swingGapMs : 1000;
  if (gap <= 0) return true;
  for (const id of orderOf(fight)) {
    const a = BY_ID.get(id);
    if (!a || !a.isSkill || !a.offensive || a.reactive) continue;
    if (readyAt(fight, a.id) - fight.t >= gap || a.spCost(fight) > fight.me.sp) continue;
    if (a.ready?.(fight) ?? true) return false;
  }
  return true;
}

/** Night Hunt's HP cost would leave too little: hold the swing (Bloody Fangs ends it). */
const nightHuntHolds = (fight: Fight) => has(fight, 'nightHunt') && fight.me.hp <= 0.2 * fight.f.maxHp;

/**
 * The swing: both hands (Left/Right Hand Mastery 5: whole), Double Attack on
 * a right-hand dagger, Rising Wings' +lv, Fury's crit, Dark Claw's melee
 * share. Then the Raven.
 */
const attack: Action = {
  id: 'Attack',
  isSkill: false,
  offensive: true,
  ready: (fight) => optionOn(fight, 'autoAttack') && !nightHuntHolds(fight) && swingGap(fight),
  castMs: () => 0,
  delayMs: (fight) => weaveMs(fight) ?? attackIntervalMs(fight.f.aspd),
  cooldownMs: (fight) => (weaveMs(fight) === null ? 0 : attackIntervalMs(fight.f.aspd)),
  spCost: () => 0,
  resolve(fight) {
    if (has(fight, 'nightHunt')) { nightHuntSwing(fight); return; }
    const f = fight.f;
    const dagger = f.weapon?.type === 'Dagger';
    const pDouble = dagger ? Math.min(1, f.doubleAttack * TUNE.doubleAttackPerLevel / 100) : 0;
    const expect = fight.rng.expect;
    const double = !expect && fight.rng.chance(pDouble);
    const ele = element(fight); const claw = clawMult(fight);
    const dealt = strike(fight, 'Attack', {
      // Katars: "double critical rate" (the Assassin's class note).
      hits: double ? 2 : 1, split: true, canMiss: true, critBonus: furyCrit(fight) + (f.weapon?.type === 'Katar' ? f.critRate : 0),
      damage: (crit) => claw * physicalDamage(f, targetNow(fight), {
        ratio: 100 + wings(fight), rightTimes: expect ? 1 + pDouble : double ? 2 : 1, element: ele,
        statusElement: 'Neutral', ranged: false, crit, skillDamage: 0, normal: true,
      }, fight.rng),
    });
    if (landedAlive(fight, dealt)) { autoBlitz(fight); attackProcs(fight); }
  },
};

/**
 * Autocasts on a normal attack read from the gear's prose:
 *   - Crow of Destiny: "Autocast Blitz Beat Lv1 at 1% chance per base LUK";
 *   - Returned Samurai Card: "On attack, 5% chance to autocast Soul Destroyer Lv5".
 * A rollout weighs them in at their chance.
 */
function attackProcs(fight: Fight) {
  const f = fight.f;
  const proc = (p: number, go: (share: number) => void) => {
    if (p <= 0 || fight.result) return;
    if (fight.rng.expect) go(p);
    else if (fight.rng.chance(p)) go(1);
  };
  if (crow(f) && L(fight, 'Blitz Beat') > 0) {
    proc(Math.min(1, 0.01 * (f.baseStats?.luk ?? f.stats.luk)), (share) => blitz(fight, 'Blitz Beat (Crow of Destiny)', 1, 3, share));
  }
  if (gearSays(f, /On attack, 5% chance to autocast Soul Destroyer/i)) {
    proc(0.05, (share) => soulDestroyerHit(fight, 5, 'Soul Destroyer (autocast)', share));
  }
}

// ---- the dagger skills ------------------------------------------------------------------

/**
 * Definitive Dagger: "100+30% per level +2% per Agi" (the pre-launch note:
 * base 200 -> 100), "boosted with dual daggers" -- 45% a level with two (the
 * code's number), "Night Wound: +50%+1% per Dex", "Hit bonus is 5 per
 * level", +3% current SP, 1 s cooldown. One roll shown as 4, no crit, 1 s
 * after-cast delay (code). The Omen Gem's 3x3 area only matters on packs.
 */
const definitiveDagger: Action = {
  id: 'Definitive Dagger',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Definitive Dagger')(fight) && blade(fight),
  castMs: () => 0,
  delayMs: delay('Definitive Dagger'),
  cooldownMs: cooldown('Definitive Dagger'),
  spCost: cost('Definitive Dagger'),
  resolve(fight) {
    const l = L(fight, 'Definitive Dagger'); const s = fight.f.stats;
    const ratio = 100 + (dualDaggers(fight.f) ? 45 : 30) * l + 2 * s.agi + (nightWound(fight) ? 50 + s.dex : 0) + wings(fight);
    strike(fight, 'Definitive Dagger', { hits: 4, split: true, canMiss: true, critBonus: null, hitBonus: 5 * l, aoe: gemOf(fight) === 'omen',
      damage: hit(fight, 'Definitive Dagger', ratio) });
  },
};

/**
 * Northern Cross: "200+30% per level +2% per Agi", "boosted with dual
 * swords: +15% per level", "Night Wound: +50% and +1% per Dex", 3% of
 * current HP, 1 s cooldown; one roll shown as 2, 0.5 s delay (code). The
 * Armory Gem adds a fifth of Max HP to it.
 */
const northernCross: Action = {
  id: 'Northern Cross',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Northern Cross')(fight),
  castMs: () => 0,
  delayMs: delay('Northern Cross'),
  cooldownMs: cooldown('Northern Cross'),
  spCost: cost('Northern Cross'),
  hpCost: T.hpCost('Northern Cross'),
  resolve(fight) {
    const l = L(fight, 'Northern Cross'); const s = fight.f.stats;
    const ratio = 200 + 30 * l + (dualSwords(fight.f) ? 15 * l : 0) + 2 * s.agi + (nightWound(fight) ? 50 + s.dex : 0) + wings(fight);
    const flat = gemOf(fight) === 'armory' ? fight.f.maxHp / 5 : 0;
    strike(fight, 'Northern Cross', { hits: 2, split: true, canMiss: true, critBonus: null,
      damage: hit(fight, 'Northern Cross', ratio, { flat }) });
  },
};

/**
 * Southern Cross: "200+30% per level +1% per Agi", "Night Wound: Damage
 * +25% per level", puts Night Wound on for 5 s, "2.5s-0.1s per level"
 * cooldown, both hands equipped. One roll shown as 2, 0.5 s delay (code).
 * Option southernRefreshMs (1000): cast when the Night Wound has less than
 * that left; option southernFiller: whenever it is up.
 */
const southernCross: Action = {
  id: 'Southern Cross',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Southern Cross')(fight) && dual(fight.f)
    && (fight.options.southernFiller === true
      || nightWoundLeft(fight) < (typeof fight.options.southernRefreshMs === 'number' ? fight.options.southernRefreshMs : 1000)),
  castMs: () => 0,
  delayMs: delay('Southern Cross'),
  cooldownMs: cooldown('Southern Cross'),
  spCost: cost('Southern Cross'),
  resolve(fight) {
    const l = L(fight, 'Southern Cross'); const s = fight.f.stats;
    const ratio = 200 + 30 * l + s.agi + (nightWound(fight) ? 25 * l : 0) + wings(fight);
    const dealt = strike(fight, 'Southern Cross', { hits: 2, split: true, canMiss: true, critBonus: null,
      damage: hit(fight, 'Southern Cross', ratio) });
    if (landedAlive(fight, dealt)) woundTarget(fight, 5000, l);
  },
};

/**
 * Soul Destroyer: "250+25% per level +5% per INT", "Night Wound: +50%+2% per
 * Dex", 0.5 s + 0.5 s cast, 3 s cooldown, from range (long range %).
 */
const soulDestroyer: Action = {
  id: 'Soul Destroyer',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Soul Destroyer')(fight),
  castMs: cast('Soul Destroyer'),
  delayMs: delay('Soul Destroyer'),
  cooldownMs: cooldown('Soul Destroyer'),
  spCost: cost('Soul Destroyer'),
  resolve(fight) { soulDestroyerHit(fight, L(fight, 'Soul Destroyer'), 'Soul Destroyer'); },
};
/**
 * Royal Dreams' "Soul Destroyer receives 2% additional scaling on AGI" is
 * skill damage, read by the parser (the 2023 code's bSkillAtk; the owner,
 * 2026-10-01) -- no longer added to the ratio here.
 */
function soulDestroyerHit(fight: Fight, l: number, id: string, share = 1) {
  const s = fight.f.stats;
  const ratio = 250 + 25 * l + 5 * s.int + (nightWound(fight) ? 50 + 2 * s.dex : 0) + wings(fight);
  const one = hit(fight, 'Soul Destroyer', ratio, { ranged: true });
  strike(fight, id, { hits: 1, canMiss: true, critBonus: null, kind: 'ranged', skill: true, damage: (crit) => one(crit) * share });
}

/** Shadow Slash (Assassin): "200+15% per level +1% per LUK", crit +5 +5/lv, right hand, one roll shown as 3, 4 s. */
const shadowSlash: Action = {
  id: 'Shadow Slash',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Shadow Slash')(fight) && blade(fight),
  castMs: () => 0,
  cooldownMs: cooldown('Shadow Slash'),
  spCost: cost('Shadow Slash'),
  resolve(fight) {
    const l = L(fight, 'Shadow Slash');
    // Limitless Legacy Gloves' "+6% per Blade Mastery level" is skill damage
    // from the parser now (2026-10-01), not ratio.
    const ratio = 200 + 15 * l + fight.f.stats.luk + wings(fight);
    strike(fight, 'Shadow Slash', { hits: 3, split: true, canMiss: true, critBonus: 5 + 5 * l + furyCrit(fight),
      damage: hit(fight, 'Shadow Slash', ratio) });
  },
};

/** Back Stab (Thief): "150+5% per level +1% per AGI" (dual wielding never gets the single-dagger tripling), 3 s, +5% current SP. */
const backStab: Action = {
  id: 'Back Stab',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Back Stab')(fight) && blade(fight),
  castMs: () => 0,
  delayMs: delay('Back Stab'),
  cooldownMs: cooldown('Back Stab'),
  spCost: cost('Back Stab'),
  resolve(fight) {
    const single = fight.f.weapon?.type === 'Dagger' && !fight.f.offhand;
    const l = L(fight, 'Back Stab'); const s = fight.f.stats;
    const ratio = single ? 150 + 15 * l + 3 * s.agi + 5 * L(fight, 'Improve Dodge') : 150 + 5 * l + s.agi;
    strike(fight, 'Back Stab', { hits: 2, split: true, canMiss: true, critBonus: null,
      damage: hit(fight, 'Back Stab', ratio + wings(fight)) });
  },
};

// ---- Counter state ------------------------------------------------------------------------

/**
 * A block (engine landMobHit) puts you in Counter state for 5 s. A rollout
 * hears of blocks by their chance: they add up, a whole one is a window.
 */
function onBlock(fight: Fight, share: number) {
  if (share >= 1) { blocked(fight); return; }
  const meter = (fight.me.buffs.blockMeter ??= { until: 1e12, stacks: 1, value: 0 });
  meter.value = (meter.value ?? 0) + share;
  if (meter.value >= 1) { meter.value -= 1; blocked(fight); }
}
/** A block: 5 s of Counter state, shown in the rotation as Weapon Blocking going off (the project owner, 2026-10-02). */
function blocked(fight: Fight) {
  grantCounter(fight, 5000);
  noteProc(fight, 'Weapon Blocking');
}

/**
 * Midnight Eye: "200+20% per level +5% per INT", "Enters Counter State for
 * 1s per level if Weapon Blocking is active" (on a hit the target survives:
 * code), 0.25 s + 0.25 s cast, 15 s cooldown (the Quarry Gem -5 s); its
 * buff removal is left out, and so is its "Chance is 50+5% per level": what
 * it is for is unclear, so not counted (the project owner, 2026-10-02). Option eyeForCounter (default on): only when
 * Counter state is down or about to be.
 */
const midnightEye: Action = {
  id: 'Midnight Eye',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Midnight Eye')(fight)
    && (!optionOn(fight, 'eyeForCounter') || counterLeft(fight) < 500)
    // Option counterBait: never open the window while the monster is casting -- bait the dangerous
    // skill, dodge it, then commit (the project owner, 2026-10-02).
    && !(fight.options.counterBait === true && !!fight.mob.cast),
  castMs: cast('Midnight Eye'),
  delayMs: delay('Midnight Eye'),
  cooldownMs: cooldown('Midnight Eye'),
  spCost: cost('Midnight Eye'),
  resolve(fight) {
    const l = L(fight, 'Midnight Eye');
    const ratio = 200 + 20 * l + 5 * fight.f.stats.int + wings(fight);
    // Range 5 in the skill's data: long range.
    const dealt = strike(fight, 'Midnight Eye', { hits: 1, canMiss: true, critBonus: null, kind: 'ranged',
      damage: hit(fight, 'Midnight Eye', ratio, { ranged: true }) });
    if (landedAlive(fight, dealt) && has(fight, 'weaponBlock')) grantCounter(fight, 1000 * l);
  },
};

/**
 * Typhoon Edge: "110+15% per level +1% per STR", "Extra 10% per Rolling
 * Counter", all around you, "Triple damage if knocked into a wall", knockback
 * 5 cells from Lv6. A target that cannot be knocked back stands as at a
 * wall (the code's second hit fires on it): x3. One that can be is pushed 5
 * cells and walked back to (option knockbackWalk, default on).
 */
function typhoon(fight: Fight, id: string) {
  const l = L(fight, 'Typhoon Edge'); const s = fight.f.stats;
  const ratio = 110 + 15 * l + s.str + 10 * rolling(fight) + wings(fight);
  const pushed = l >= 6 && knockable(fight);
  const wall = !pushed && l >= 6 && fight.options.typhoonWall !== false ? 3 : 1;
  const one = hit(fight, 'Typhoon Edge', ratio);
  strike(fight, id, { hits: 1, canMiss: true, critBonus: null, aoe: true, damage: (crit) => one(crit) * wall });
  if (pushed && !fight.result && optionOn(fight, 'knockbackWalk')) {
    fight.me.busyUntil = Math.max(fight.me.busyUntil, fight.t) + 5 * cellMs(fight);
    fight.log && say(fight, `${fight.m.name} is knocked back 5 cells`);
  }
}
const typhoonEdge: Action = {
  id: 'Typhoon Edge',
  isSkill: true,
  offensive: true,
  findsCloaked: true,
  // Option typhoonAt: the Rolling Counters it waits for; option typhoonPush: also on targets it knocks back.
  ready: (fight) => learned('Typhoon Edge')(fight)
    && rolling(fight) >= (typeof fight.options.typhoonAt === 'number' ? fight.options.typhoonAt : 0)
    && (fight.options.typhoonPush === true || !(L(fight, 'Typhoon Edge') >= 6 && knockable(fight)))
    // Option typhoonAfterCounter (the project owner's rotation, 2026-10-01): once Counter state is
    // over, with the Rolling Counters it built still up.
    && (fight.options.typhoonAfterCounter !== true || (!counter(fight) && rolling(fight) > 0)),
  castMs: () => 0,
  delayMs: delay('Typhoon Edge'),
  cooldownMs: cooldown('Typhoon Edge'),
  spCost: cost('Typhoon Edge'),
  resolve(fight) { typhoon(fight, 'Typhoon Edge'); },
};

/**
 * Counter Slash: "Can only be used in Counter state", around you, "200+10%
 * per level +1% per AGI", "an extra hit per stack, up to 6 hits" (each hit
 * whole: the code's damage x (stacks + 1)), then a Rolling Counter (5 at
 * most, 3 s). Steel Wings: "AGI x level as flat damage" a hit (Patch 18).
 * +10% current SP, 0.6 s cooldown, 0.25 s delay (code). The Quarry Gem then
 * fires Typhoon Edge at its learned level.
 */
const counterSlash: Action = {
  id: 'Counter Slash',
  isSkill: true,
  offensive: true,
  findsCloaked: true,
  ready: (fight) => learned('Counter Slash')(fight) && counter(fight),
  castMs: () => 0,
  delayMs: delay('Counter Slash'),
  cooldownMs: cooldown('Counter Slash'),
  spCost: cost('Counter Slash'),
  resolve(fight) {
    const l = L(fight, 'Counter Slash'); const s = fight.f.stats;
    const n = rolling(fight) + 1;
    const ratio = 200 + 10 * l + s.agi + wings(fight);
    const one = hit(fight, 'Counter Slash', ratio, { flat: s.agi * L(fight, 'Steel Wings') });
    strike(fight, 'Counter Slash', { hits: n, split: true, canMiss: true, critBonus: null, aoe: true, damage: (crit) => n * one(crit) });
    fight.me.buffs.rolling = { until: fight.t + 3000, stacks: Math.min(MAX_ROLLING, rolling(fight) + 1) };
    if (gemOf(fight) === 'quarry' && L(fight, 'Typhoon Edge') > 0 && !fight.result) typhoon(fight, 'Typhoon Edge (Quarry Gem)');
  },
};

// ---- buffs kept up ------------------------------------------------------------------------

/** A self buff recast when it has run out (or is about to), from the rotation. */
function upkeep(id: string, buff: string, ms: (fight: Fight) => number, o: {
  ok?: (fight: Fight) => boolean; apply?: (fight: Fight) => void; hpCost?: (fight: Fight) => number;
} = {}): Action {
  return {
    id,
    isSkill: true,
    offensive: false,
    ready: (fight) => learned(id)(fight) && optionOn(fight, buff) && (o.ok?.(fight) ?? true)
      && (fight.me.buffs[buff]?.until ?? -1) <= fight.t + 500,
    castMs: cast(id),
    delayMs: delay(id),
    cooldownMs: cooldown(id),
    spCost: cost(id),
    ...(o.hpCost ? { hpCost: o.hpCost } : {}),
    resolve(fight) { grant(fight, buff, ms(fight)); o.apply?.(fight); },
  };
}

/** Weapon Blocking: "Blocking Chance is 15%+2% per level", 120 s, dual wielding; a recast clears Rolling Counters (code). */
const weaponBlocking = upkeep('Weapon Blocking', 'weaponBlock', () => 120_000, {
  ok: (fight) => dual(fight.f),
  apply: (fight) => {
    fight.me.buffs.weaponBlock.value = 15 + 2 * L(fight, 'Weapon Blocking');
    delete fight.me.buffs.rolling;
    // 3 SP every 5 s while it lasts (2023 code, status.cpp:14754-14760; the tooltip is silent).
    dot(fight, 'Weapon Blocking drain', 5000, 120_000, -3, false, false, true);
  },
});
/** Rising Wings: 180 s (code), +50% of current SP, needs the Raven (always out). */
const risingWings = upkeep('Rising Wings', 'risingWings', () => 180_000);
/** Fury: "a duration of 20+10s per level", 60 s cooldown, a Shadow Orb (carried). Its SP regen cut is left out. */
const fury = upkeep('Fury', 'fury', (fight) => (20 + 10 * L(fight, 'Fury')) * 1000);
/**
 * Hallucination Walk: "25+5s per level", flee +10 a level and 5% a level to
 * avoid magic, 120 s cooldown, a Shadow Orb; 10% Max HP to cast (code).
 */
const hallucinationWalk = upkeep('Hallucination Walk', 'hallucination', (fight) => (25 + 5 * L(fight, 'Hallucination Walk')) * 1000, {
  apply: (fight) => {
    const l = L(fight, 'Hallucination Walk');
    fight.me.buffs.hallucination.flee = 10 * l; fight.me.buffs.hallucination.magicDodge = 0.05 * l;
  },
  hpCost: (fight) => Math.floor(0.1 * fight.f.maxHp),
});

/**
 * Night Hunt: 100 SP, 2 x level enhanced attacks (see nightHuntSwing). Off
 * unless option nightHunt; cast with HP to pay for it (option nightHuntHp, 0.8).
 */
const nightHunt: Action = {
  id: 'Night Hunt',
  isSkill: true,
  offensive: false,
  ready: (fight) => learned('Night Hunt')(fight) && fight.options.nightHunt === true && !has(fight, 'nightHunt')
    && fight.me.hp >= (typeof fight.options.nightHuntHp === 'number' ? fight.options.nightHuntHp : 0.8) * fight.f.maxHp,
  castMs: () => 0,
  cooldownMs: cooldown('Night Hunt'),
  spCost: cost('Night Hunt'),
  resolve(fight) { fight.me.buffs.nightHunt = { until: 1e12, stacks: 2 * L(fight, 'Night Hunt') }; },
};

/**
 * Dark Claw: the target takes 2% a level more from melee physical attacks
 * for 5 s and reflects nothing, 90 s cooldown (none with the Eclipse Gem).
 * Its own hit (the code's 100 + 50% a level) is kept.
 */
const darkClaw: Action = {
  id: 'Dark Claw',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Dark Claw')(fight) && optionOn(fight, 'darkClaw') && !mobHas(fight, 'darkClaw'),
  castMs: () => 0,
  cooldownMs: cooldown('Dark Claw'),
  spCost: cost('Dark Claw'),
  resolve(fight) {
    const l = L(fight, 'Dark Claw');
    fight.mob.debuffs.darkClaw = { until: fight.t + 5000, stacks: 1, value: 2 * l };
    strike(fight, 'Dark Claw', { hits: 1, canMiss: true, critBonus: null, damage: hit(fight, 'Dark Claw', 100 + 50 * (l - 1) + wings(fight)) });
  },
};

/**
 * Bloody Fangs: magic "100+40% per level + 5% per Int", "Night Wound: +1%
 * per DEX", "20% of damage dealt per level is recovered", tripled below 25%
 * Max HP (the Armory Gem: 50%), ends Night Hunt. Cast below option healBelow
 * (0.5) of Max HP, or to end a Night Hunt that would cost too much.
 */
const bloodyFangs: Action = {
  id: 'Bloody Fangs',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Bloody Fangs')(fight) && optionOn(fight, 'bloodyFangs')
    && (fight.me.hp < (typeof fight.options.healBelow === 'number' ? fight.options.healBelow : 0.5) * fight.f.maxHp || nightHuntHolds(fight)),
  castMs: cast('Bloody Fangs'),
  delayMs: delay('Bloody Fangs'),
  cooldownMs: cooldown('Bloody Fangs'),
  spCost: cost('Bloody Fangs'),
  resolve(fight) {
    const l = L(fight, 'Bloody Fangs'); const s = fight.f.stats;
    const low = fight.me.hp < (gemOf(fight) === 'armory' ? 0.5 : 0.25) * fight.f.maxHp ? 3 : 1;
    const ratio = (100 + 40 * l + 5 * s.int + (nightWound(fight) ? s.dex : 0)) * low;
    const skillDamage = fight.f.skillMods('Bloody Fangs', 'damage').percent;
    const dealt = strike(fight, 'Bloody Fangs', { hits: 2, split: true, canMiss: false, critBonus: null, kind: 'magic',
      damage: () => magicDamage(fight.f, targetNow(fight), { ratio, element: 'Neutral', skillDamage, bonus: 0 }, fight.rng) });
    heal_(fight, dealt * 0.2 * l * Math.max(0, 1 + (fight.f.healReceived ?? 0) / 100));
    delete fight.me.buffs.nightHunt;
  },
};

const orphan = orphanHeal(T);
const heal: Action = { ...orphan, ready: (fight) => optionOn(fight, 'heal') && orphan.ready!(fight) };
const hiding = hidingAction(T);

// ---- the rules on every action ---------------------------------------------------

function withRules(a: Action): Action {
  if (a.reactive || !(a.offensive || a.isSkill)) return a;
  const own = a.ready;
  return {
    ...a,
    ready: (fight) => {
      if (heldForSnap(fight, a, TOOLS)) return false;
      if ((fight.mob.buffs.pneuma?.until ?? -1) > fight.t && RANGED.has(a.id)) return false;
      if ((fight.mob.buffs.safetywall?.until ?? -1) > fight.t && MELEE.has(a.id)) return false;
      // Reflect Shield: melee only with HP to take it, unless Dark Claw is on it.
      if (MELEE.has(a.id) && (fight.mob.buffs.reflectshield?.until ?? -1) > fight.t && !mobHas(fight, 'darkClaw')
        && fight.me.hp < 0.7 * fight.f.maxHp && optionOn(fight, 'reflectCare')) return false;
      if (has(fight, 'hidden') && a.offensive) return false;
      // Option autoOnly: the auto-attack builds swing and let the Raven proc -- no damage skill
      // (the project owner, 2026-10-01: "both aa builds simply attack and trigger bird hits").
      if (a.offensive && a.id !== 'Attack' && fight.options.autoOnly === true) return false;
      // Option counterHold (the project owner's rotation, 2026-10-01): in Counter state, Counter Slash
      // again and again until it ends -- nothing else but the swing woven between.
      // In Counter state nothing but Counter Slash -- not even a swing (the project owner, 2026-10-02: "you
      // can't swing between, or there's not much point"; option counterSwing true allows it back).
      // Dark Claw may go in after Midnight Eye ("Midnight Eye -> (optional Dark Claw) -> Counter Slash", 2026-10-01).
      if (a.offensive && counter(fight) && fight.options.counterHold === true && a.id !== 'Counter Slash' && a.id !== 'Dark Claw'
        && !(a.id === 'Attack' && fight.options.counterSwing === true)) return false;
      // Option counterOnly: between Counter windows play defensive -- no damage fillers, only what opens the
      // next window (Midnight Eye), the gap closer (Shadow Slash) and Dark Claw (the owner's hit and run).
      if (a.offensive && !counter(fight) && fight.options.counterOnly === true && !COUNTER_ONLY.has(a.id)) return false;
      // Option ddHold (the project owner, 2026-10-01: "spam Definitive Dagger, keep Night Wound applied";
      // a filler between them would delay the next): only Definitive Dagger, the swing, Southern Cross
      // for the Night Wound, Dark Claw and the Shadow Slash opener.
      if (a.offensive && fight.options.ddHold === true && !DD_HOLD.has(a.id)) return false;
      return own?.(fight) ?? true;
    },
  };
}
const COUNTER_ONLY = new Set(['Midnight Eye', 'Shadow Slash', 'Dark Claw', 'Typhoon Edge', 'Counter Slash']);
const DD_HOLD = new Set(['Definitive Dagger', 'Attack', 'Southern Cross', 'Dark Claw', 'Shadow Slash']);
const MELEE = new Set(['Attack', 'Definitive Dagger', 'Northern Cross', 'Southern Cross', 'Counter Slash', 'Typhoon Edge',
  'Shadow Slash', 'Back Stab', 'Dark Claw']);
const RANGED = new Set(['Soul Destroyer', 'Midnight Eye', 'Blitz Beat', 'Sky Assault']);

// ---- defence --------------------------------------------------------------------------

/**
 * Raven Steps: "Instantly teleport to a targeted spot", "Range is 4+2 cells
 * per level (Max 14)", 2 s a level cooldown, 50 SP + 10% of current SP. The
 * Night Raven's quick way out (the project owner, 2026-10-01): out of an area
 * whose exit is within its range in one step, then back -- free with Shadow
 * Slash ready (gapClosers). The Raven is assumed out.
 */
const STEPS_RANGE = (fight: Fight) => 4 + 2 * L(fight, 'Raven Steps');
// An area whose exit is in range, or a cast at you that walking out of its range dodges (Converted Zealot's
// Back Stab: out of range when it ends, it fails -- the project owner, 2026-10-01).
const stepsWork = (fight: Fight, s: MobSkill) => learned('Raven Steps')(fight) && s.avoid.includes('walk') && !has(fight, 'rooted')
  && (s.targets === 'single' || (s.targets === 'aoe' && escapeCells(s) <= STEPS_RANGE(fight)));
const ravenSteps: Action = {
  id: 'Raven Steps',
  isSkill: true,
  offensive: false,
  reactive: true,
  ready: (fight) => learned('Raven Steps')(fight) && !has(fight, 'rooted'),
  castMs: () => 0,
  delayMs: (fight) => awayFor(fight, 100) + returnMs(fight, awayFor(fight, 100), escapeMs(fight, fight.mob.cast?.skill)),
  cooldownMs: cooldown('Raven Steps'),
  spCost: cost('Raven Steps'),
  resolve(fight) { grant(fight, 'away', awayFor(fight, 100)); },
};

/**
 * Raven Steps ahead of a follow-up area too fast to answer from its bar: the
 * monster's chain says it comes next (an "afterskill" row on the skill it just
 * used, off its delay -- Converted Zealot's Cloud Kill after Back Stab, a
 * 0.25 s cast) and walking cannot beat it. Out before it is cast, it lands
 * where you were (the project owner, 2026-10-01: "save Raven Steps for it").
 */
function chainedAreaDue(fight: Fight): MobSkill | null {
  const st = fight.mob; const m = fight.m;
  const last = m.skills.find((x) => x.skillId === st.lastSkill);
  if (!last || fight.t - (st.cds[last.skill] ?? -Infinity) > 2000 || st.cast) return null;
  return m.skills.find((x) => x.ai.cond === 'afterskill' && Number(x.ai.condValue) === st.lastSkill
    && x.targets === 'aoe' && x.type !== 'none' && x.castMs <= reactionMs(fight) + 100
    && (st.cds[x.skill] ?? -Infinity) + x.ai.delayMs <= fight.t && stepsWork(fight, x)) ?? null;
}
const stepsAhead: Action = {
  ...ravenSteps,
  id: 'Raven Steps ahead',
  reactive: false,
  ready: (fight) => optionOn(fight, 'stepsAhead') && learned('Raven Steps')(fight) && readyAt(fight, 'Raven Steps') <= fight.t
    && !has(fight, 'hidden') && !has(fight, 'away') && !!chainedAreaDue(fight),
  // Away until the follow-up has been cast and landed behind you.
  delayMs: (fight) => 1500 + returnMs(fight, 1500, escapeMs(fight, chainedAreaDue(fight) ?? undefined)),
  resolve(fight) {
    fight.me.cds['Raven Steps'] = fight.t + cooldown('Raven Steps')(fight);
    grant(fight, 'away', 1500);
  },
};

/**
 * A tell: a cast the monster always follows with a heavy area you can walk
 * from (Converted Zealot's Back Stab -> Cloud Kill). Walk out on it and stay
 * out through the follow-up -- "when I see Back Stab I walk out of its cast
 * range, and keep walking" (the project owner, 2026-09-28; the Satsujin's
 * kite rule). Option tellWalk, on by default; ahead of the automatic defence.
 */
function heavyFollowUp(fight: Fight, s: MobSkill, from: Monster): MobSkill | null {
  if (fight.options.tellWalk === false) return null;
  return from.skills.find((n) => n.ai.cond === 'afterskill' && Number(n.ai.condValue) === s.skillId
    && n.targets === 'aoe' && n.avoid.includes('walk') && assessThreat(fight, n, from).heavy) ?? null;
}
const tellOutMs = (fight: Fight) => {
  const c = fight.mob.cast;
  const next = c ? heavyFollowUp(fight, c.skill, fight.m) : null;
  const end = c ? c.endsAt - fight.t : 0;
  // The chain starts 200-300 ms after the tell (engine: next act), then its cast.
  return Math.max(escapeMs(fight, next ?? undefined), end + 300 + (next?.castMs ?? 0) + 100);
};
const walkOutOnTell: Action = {
  ...walkOut,
  id: 'Walk out on the tell',
  delayMs: (fight) => tellOutMs(fight) + returnMs(fight, tellOutMs(fight), escapeMs(fight)),
  resolve(fight) { grant(fight, 'away', tellOutMs(fight)); },
};

/** Hiding, walking or line of sight, Raven Steps out; Weapon Blocking blocks on its own (engine). */
const TOOLS: DefenseTool[] = [
  ...COMMON_TOOLS,
  moveTool('steps', 'Raven Steps', () => 100, (fight, s, r) => stepsWork(fight, s) && fight.t + reactionMs(fight) < r.endsAt,
    (fight, s) => escapeMs(fight, s)),
];
export const NIGHTRAVEN_TOOLS = TOOLS;

function react(fight: Fight, s: MobSkill, from: Monster): { action: string; at: number } | null {
  const t = assessThreat(fight, s, from);
  if (!t.heavy) return null;
  if (t.canWalk && s.targets === 'aoe') return { action: 'Walk out', at: fight.t + reactionMs(fight) };
  // Too fast to walk: Raven Steps out, if it is back off cooldown in time.
  if (s.targets === 'aoe' && stepsWork(fight, s) && readyAt(fight, 'Raven Steps') <= t.endsAt - 100) {
    return { action: 'Raven Steps', at: Math.max(fight.t + reactionMs(fight), readyAt(fight, 'Raven Steps')) };
  }
  if (t.hideWorks && t.hideReady) return { action: 'Hiding', at: Math.max(fight.t, t.endsAt - 150) };
  if (t.canLos) return { action: 'Break line of sight', at: fight.t + reactionMs(fight) };
  return null;
}

// ---- the rotation -------------------------------------------------------------------------

const ACTIONS: Action[] = [
  attack, waitAction, swingWait, heal, bloodyFangs, definitiveDagger, northernCross, southernCross, soulDestroyer, shadowSlash, backStab,
  midnightEye, counterSlash, typhoonEdge, blitzBeat, skyAssaultAction, darkClaw, nightHunt,
  weaponBlocking, risingWings, fury, hallucinationWalk,
  hiding, ravenSteps, stepsAhead, walkOutOnTell, walkOut, breakSight, morrocsMark, stayHidden, pullOffWard, backSlide,
  ...predictActions(TOOLS), stayReadyAction(TOOLS),
].map(withRules);
const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
const rule = (id: string) => BY_ID.get(id)!;
const PREEMPTS = ACTIONS.filter(isPreempt);

/**
 * The default priority: upkeep and sustain, Counter state's skills while it
 * lasts, the Night Wound, the dagger skills, the Raven, fillers, the swing.
 * Each build's profile reorders it (option order); the searches move it.
 */
const ORDER = [
  'Stay hidden', "Morroc's Mark", 'Pull it off the ward', 'Heal', 'Bloody Fangs',
  'Weapon Blocking', 'Rising Wings', 'Fury', 'Hallucination Walk', 'Night Hunt', 'Dark Claw',
  'Counter Slash', 'Midnight Eye', 'Typhoon Edge', 'Southern Cross', 'Definitive Dagger', 'Northern Cross',
  'Sky Assault', 'Soul Destroyer', 'Shadow Slash', 'Back Stab', 'Blitz Beat', 'Attack',
];
export const NIGHTRAVEN_ORDER = ORDER;

/** The rotation's switches for the searches (kits/index.ts RotationSpace). Gems are gear: --set option.gem. */
export const NIGHTRAVEN_SEARCH = {
  order: ORDER,
  switches: {
    southernRefreshMs: [1000, 0, 2500], southernFiller: [false, true], typhoonAt: [0, 3, 5], typhoonPush: [false, true],
    eyeForCounter: [true, false], autoAttack: [true, false], darkClaw: [true, false], weaponBlock: [true, false],
    risingWings: [true, false], fury: [true, false], hallucination: [true, false], nightHunt: [false, true],
    bloodyFangs: [true, false], heal: [true, false], enchantPoison: ['auto', false, true], healBelow: [0.5, 0.35, 0.7],
    tankShare: [0.4, 0.25, 0.6],
    // Not here: the owner's rotation rules (slashOpener, counterHold, typhoonAfterCounter, ddHold) --
    // set by the profile, never flipped by a search (2026-10-01).
  } as Record<string, unknown[]>,
  pinned: ['Stay hidden', "Morroc's Mark", 'Pull it off the ward'],
  // Dual-wield melee: what a new piece's random options go to first.
  // Move speed before ASPD (the project owner, 2026-10-02: shoes should roll move speed -- the build lives on
  // getting in and out).
  rolls: ['definitive_dagger_damage', 'counter_slash_damage', 'blitz_beat_damage', 'melee_damage', 'ranged_damage', 'critical_damage',
    'atk_pct', 'max_hp', 'defense_penetration', 'sp_cost_reduced', 'hp_leech', 'move_speed', 'physical_reduced', 'physical_damage_reduced',
    'after_cast_delay', 'after_cast_delay_reduced', 'aspd', 'crit', 'sp_regen', 'flee'],
  droppable: ['Definitive Dagger', 'Northern Cross', 'Southern Cross', 'Soul Destroyer', 'Shadow Slash', 'Back Stab', 'Midnight Eye',
    'Typhoon Edge', 'Blitz Beat', 'Sky Assault', 'Dark Claw', 'Night Hunt', 'Bloody Fangs', 'Heal', 'Fury', 'Hallucination Walk',
    'Rising Wings', 'Weapon Blocking', 'Attack'],
};

/** What deals damage in the order: under counterHold, Midnight Eye goes ahead of all of it. */
const DAMAGE_STEPS = new Set(['Attack', 'Dark Claw', 'Counter Slash', 'Typhoon Edge', 'Northern Cross', 'Definitive Dagger',
  'Southern Cross', 'Soul Destroyer', 'Back Stab', 'Shadow Slash', 'Blitz Beat', 'Sky Assault', 'Night Hunt']);

/**
 * The build's order (option order). The owner's Counter Slash rotation
 * (counterHold) opens Counter state with Midnight Eye first -- "Shadow Slash
 * -> Midnight Eye -> (optional Dark Claw) -> Counter Slash" (2026-10-01) --
 * whatever an order search did with it (2026-10-02: one dropped it, one put
 * it behind the dagger fillers).
 */
function orderOf(fight: Fight): string[] {
  const order = Array.isArray(fight.options.order) ? fight.options.order as string[] : ORDER;
  if (fight.options.counterHold !== true) return order;
  const rest = order.filter((id) => id !== 'Midnight Eye');
  const i = rest.findIndex((id) => DAMAGE_STEPS.has(id));
  return i < 0 ? [...rest, 'Midnight Eye'] : [...rest.slice(0, i), 'Midnight Eye', ...rest.slice(i)];
}

/**
 * Option slashOpener (the project owner, 2026-10-01): the fight opens with
 * Shadow Slash, the gap closer, once the pre-pull buffs are up.
 */
function priority(fight: Fight): Action {
  const ahead = rule('Raven Steps ahead');
  if (canUse(fight, ahead)) return ahead;
  if (fight.options.slashOpener === true && !fight.me.spent.slashOpener) {
    const slash = rule('Shadow Slash');
    if (canUse(fight, slash)) { fight.me.spent.slashOpener = true; return slash; }
  }
  for (const id of orderOf(fight)) {
    const a = BY_ID.get(id);
    if (a && canUse(fight, a)) return a;
  }
  // Swing timer on (option weaveMs): stand until the next swing or skill.
  if (optionOn(fight, 'autoAttack') && canUse(fight, rule('Wait for swing'))) return rule('Wait for swing');
  return rule('Wait');
}

// ---- before the pull ------------------------------------------------------------------------

/**
 * Enchant Poison (Poison endow, "30 seconds +15s per level"): option
 * enchantPoison 'auto' (the default) puts it on when Poison does more to the
 * target than the weapon's own element -- but a weapon with an element of its
 * own (a Sarah Irine Card's Holy) keeps it unless the target resists it --
 * between monsters, as Burning Scythe is; true always, false never.
 */
function wantsPoison(fight: Fight): boolean {
  const o = fight.options.enchantPoison ?? 'auto';
  if (o === false || !learned('Enchant Poison')(fight)) return false;
  if (o === true) return true;
  const m = fight.m; const own = fight.f.weapon?.element ?? 'Neutral';
  const ownFix = attrFix(own, m.element, m.elementLevel);
  // A weapon that has an element of its own (Sarah Irine Card: Holy) keeps it unless the target resists it
  // (the project owner, 2026-10-02); then Poison only where it does better.
  if (own !== 'Neutral' && ownFix >= 1) return false;
  return attrFix('Poison', m.element, m.elementLevel) > ownFix;
}

function prep(fight: Fight) {
  fight.options.mobility ??= 'server';
  fight.options.defense ??= 'auto';
  fight.options.tankShare ??= 0.4;
  // The Counter Slash rotation lives on Weapon Blocking (Midnight Eye's Counter state needs it): a search
  // switching it off left a "Counter Slash" build that never cast one (2026-10-02).
  if (fight.options.counterHold === true) fight.options.weaponBlock = true;
  const sw = steelWingsAspd(fight.f);
  if (sw) fight.f = { ...fight.f, aspd: Math.min(fight.f.aspdLimit ?? 190, fight.f.aspd + sw) };
  if (wantsPoison(fight)) grant(fight, 'poisonEndow', (30 + 15 * L(fight, 'Enchant Poison')) * 1000);
  // Buffs up at the pull, their cooldowns running from it -- those the build's order plays.
  const order = Array.isArray(fight.options.order) ? fight.options.order as string[] : ORDER;
  for (const [a, key] of [[weaponBlocking, 'weaponBlock'], [risingWings, 'risingWings'], [fury, 'fury'], [hallucinationWalk, 'hallucination']] as const) {
    if (!order.includes(a.id) || !learned(a.id)(fight) || !optionOn(fight, key) || !(a.ready?.(fight) ?? true)) continue;
    a.resolve(fight);
    fight.me.cds[a.id] = a.cooldownMs(fight);
  }
}

/**
 * Out of combat (the farm tool, between fights): the buffs prep puts up are
 * paid for by the second -- each one's SP (at full SP) and HP cost over its
 * duration, and Weapon Blocking's 3 SP every 5 s. They were free before
 * 2026-10-02 (the project owner: "Rising Wings also cuts our SP a lot" --
 * +50% of current SP every 180 s).
 */
function idleRegen(f: Fighter, options: Record<string, unknown>): { hpPerSec: number; spPerSec: number } {
  const order = Array.isArray(options.order) ? options.order as string[] : ORDER;
  const full = { f, me: { sp: f.maxSp, hp: f.maxHp } } as unknown as Fight;
  const kept: [Action, string, number][] = [
    [weaponBlocking, 'weaponBlock', 120], [risingWings, 'risingWings', 180],
    [fury, 'fury', 20 + 10 * lv(f, 'Fury')], [hallucinationWalk, 'hallucination', 25 + 5 * lv(f, 'Hallucination Walk')],
  ];
  let sp = 0; let hp = 0;
  for (const [a, key, s] of kept) {
    const on = options[key] !== false || (key === 'weaponBlock' && options.counterHold === true);
    if (!order.includes(a.id) || lv(f, a.id) <= 0 || !on || (key === 'weaponBlock' && !dual(f))) continue;
    sp -= a.spCost(full) / s + (key === 'weaponBlock' ? 3 / 5 : 0);
    hp -= (a.hpCost?.(full) ?? 0) / s;
  }
  return { hpPerSec: hp, spPerSec: sp };
}

function prepNotes(fight: Fight): string[] {
  const out: string[] = [];
  const g = gemOf(fight);
  if (g) out.push(`${g[0].toUpperCase()}${g.slice(1)} Gem +${gemRefine(fight)}`);
  if (has(fight, 'poisonEndow')) out.push('Enchant Poison (Poison)');
  if (has(fight, 'weaponBlock')) out.push(`Weapon Blocking ${fight.me.buffs.weaponBlock.value}%`);
  if (has(fight, 'risingWings')) out.push('Rising Wings');
  if (has(fight, 'fury')) out.push('Fury');
  if (has(fight, 'hallucination')) out.push('Hallucination Walk');
  if (daggerSword(fight.f) && L(fight, 'Blitz Beat') > 0) {
    const p = ((2 * fight.f.stats.luk + 2) / 1000) * (has(fight, 'risingWings') ? 4 : 1);
    out.push(`auto Blitz Beat ${(Math.min(1, p) * 100).toFixed(1)}% a swing${hrafnsmal(fight.f).on ? ' (Hrafnsmal: main-hand element)' : ''}`);
  }
  out.push(`ASPD ${fight.f.aspd}`);
  return out;
}

const ROLES: Record<string, string> = {
  'Definitive Dagger': 'Daggers', 'Northern Cross': 'Daggers', 'Southern Cross': 'Daggers', 'Soul Destroyer': 'Fillers',
  'Shadow Slash': 'Fillers', 'Back Stab': 'Fillers', 'Dark Claw': 'Fillers', 'Bloody Fangs': 'Fillers',
  'Counter Slash': 'Counter', 'Typhoon Edge': 'Counter', 'Typhoon Edge (Quarry Gem)': 'Counter', 'Midnight Eye': 'Counter',
  'Blitz Beat': 'Raven', 'Blitz Beat (auto)': 'Raven', 'Blitz Beat (Crow of Destiny)': 'Raven', 'Soul Destroyer (autocast)': 'Fillers', 'Sky Assault': 'Raven', 'Sky Assault (autocast)': 'Raven',
  Attack: 'Auto-attacks', 'Night Hunt': 'Auto-attacks',
};

export const nightraven: Kit = {
  className: 'Night Raven',
  actions: ACTIONS,
  roles: ROLES,
  cycleAnchor: 'Southern Cross',
  coreRoles: ['Daggers', 'Counter', 'Raven'],
  magicActions: ['Bloody Fangs'],
  priority: priorityWith(() => PREEMPTS, priority, rule('Stay ready')),
  // Holding on purpose: a snap cast due, or (option counterOnly) waiting out Midnight Eye's cooldown -- not dry.
  holding: (fight) => !!snapThreatDue(fight, TOOLS)
    || (fight.options.counterOnly === true && learned('Midnight Eye')(fight) && !counter(fight)),
  // The tell first (heavyFollowUp), then the automatic defence or the kit's own reactions.
  react: (fight, s, from) => {
    // Option counterCommit: in Counter state, tank whatever will not kill -- leech carries the build
    // (the project owner, 2026-10-02: "if it's not lethal we can take it").
    if (fight.options.counterCommit === true && counter(fight)) {
      const t = assessThreat(fight, s, from);
      if (!t.badStatus && t.dmg < 0.9 * fight.me.hp) return null;
    }
    return heavyFollowUp(fight, s, from) && !has(fight, 'rooted')
      ? { action: 'Walk out on the tell', at: fight.t + reactionMs(fight) }
      : reactWith(TOOLS, react)(fight, s, from);
  },
  prep,
  prepNotes,
  idleRegen,
  onBlock,
  // Shadow Slash dashes in, Back Stab teleports behind: no walk back after a dodge.
  gapClosers: ['Shadow Slash', 'Back Stab'],
  // What the rotations run on, for the Rotation overlay's arrows.
  statuses: (fight) => readMarks(fight, {
    me: [
      { key: 'counter', label: 'Counter state' }, { key: 'rolling', label: 'Rolling Counter', stacks: true },
      { key: 'nightHunt', label: 'Night Hunt', stacks: true }, { key: 'hidden', label: 'Hiding' },
    ],
    target: [{ key: 'nightWound', label: 'Night Wound' }, { key: 'darkClaw', label: 'Dark Claw' }],
  }),
};

/** Read by tests: the auto Blitz Beat chance a swing. */
export const autoBlitzChance = (f: Fighter, wingsUp: boolean) => (daggerSword(f) ? Math.min(1, ((2 * f.stats.luk + 2) / 1000) * (wingsUp ? 4 : 1)) : 0);
