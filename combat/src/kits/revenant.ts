/**
 * Revenant: the Trickster line's final job (server job slot Rebellion, which
 * inherits Gunslinger). Scythes only (server W_MACE, two-handed, 100% on
 * every size).
 *
 * Built 2026-10-01 without the project owner's play or readings: the owner
 * has not played the class and trusts the formulas so far. Numbers follow
 * the rule set for every kit -- the live tooltip (data/raw/db-skills.json,
 * checked against rtm-database.pages.dev the same day: identical) wins, the
 * patch notes on top of it, and the 2023 server code fills in only what a
 * tooltip leaves unsaid. Research: .claude/scratch/revenant-server.md (code,
 * with every tooltip disagreement) and revenant-live.md (live text, patches).
 *
 * The combo, from the class discussions (the owner, 2026-10-01):
 *   Scythe Reap (Combo Ready 4 s) > Reaping Slash (1 Overslash stack) >
 *   Hellraiser (Finisher Ready) > Reaping Slash (stacks to 5) > Roaring
 *   Overslash (one extra hit a stack). Sweeping Slash / Reaping Slash while
 *   Hellraiser and Roaring cool down; Haunting Slice autocasts Scythe Reap;
 *   Royal Scythe swapped in for Underworld Rainstorm.
 *
 * How the pieces work (code, unless a tooltip or patch says otherwise):
 *   - Combo Ready (SC_OVERBRANDREADY, the Satsujin's too): Scythe Reap 4 s,
 *     Sweeping Slash 3 s (with Advanced Scythe Mastery), Dark Message 1 s a
 *     level -- on a hit that lands. A new one never shortens the old (Patch
 *     15). Nothing in the kit spends it.
 *   - Finisher Ready (SC_SPL_ATK, the Kingslayer's too): Hellraiser, 5 s.
 *     Halves the next hit taken (Patch 18: a hit no longer ends it). Every
 *     Reaping Slash ends it.
 *   - Overslash stacks (SC_ROLLINGCUTTER, the one counter the tooltips call
 *     Overslash and Roaring stacks): only Reaping Slash sets them, 6 s, at
 *     most 5; +1 under Combo Ready, 1 + 4 x held with Finisher Ready too;
 *     without Combo Ready they fall back to 1 (held 2+: nothing, no refresh).
 *     Roaring Overslash hits stacks + 1 times and leaves them.
 */
import type { Passives } from '../character.ts';
import { plannerDataset } from '../data.ts';
import { attackIntervalMs, attrFix, castTimeMs, magicDamage, physicalDamage, skillDelayMs } from '../formulas.ts';
import type { Fighter, MobSkill, Monster } from '../model.ts';
import {
  canUse, dot, grant, has, mobHas, readyAt, say, stacks, strike, targetNow,
  type Action, type Fight, type Kit,
} from '../engine.ts';
import {
  assessThreat, backSlide, breakSight, hidingAction, lv, morrocsMark, optionOn, orphanHeal, pullOffWard, stayHidden,
  reactionMs, toolkit, waitAction, walkOut, weaveMs,
} from './common.ts';
import {
  autoDefense, COMMON_TOOLS, heldForSnap, isPreempt, predictActions, priorityWith, reactWith, snapThreatDue, stayReadyAction, type DefenseTool,
} from './defense.ts';

const TREE = ['Revenant', 'Trickster', 'Orphan'];

/** Burning Scythe endows the weapon with Fire while it lasts. */
const element = (fight: Fight) => (has(fight, 'fireEndow') ? 'Fire' : fight.f.weapon?.element ?? 'Neutral');
const T = toolkit(TREE, element);
const { cast, cooldown, spCost, learned } = T;

export const ALIASES: Record<string, string[]> = {};

const SKILLS = [
  // Revenant
  'Advanced Scythe Mastery', 'Darkside Shadow', 'Final Orchestra', 'Flaming Wave', 'Haunting Slice', 'High Jump',
  'Mirror Break', 'Ominous Presence', 'Phantom Slice', 'Reaping Slash', 'Roaring Overslash', 'Underworld Rainstorm', 'Vampire Mark',
  // Trickster
  'Burning Scythe', 'Dark Message', 'Dark Messenger', 'Hellraiser', 'Increase SP Recovery', 'Mirror Image', 'Scythe Mastery',
  'Scythe Reap', 'Shadow Parry', 'Sweeping Slash', 'True Sight',
  // Orphan
  'Hiding', 'Heal', "Morroc's Mark", 'Increase Agility',
];

export function maxLevels(): Record<string, number> {
  return Object.fromEntries(SKILLS.map((n) => [n, T.sk(n).row.max]));
}

const isScythe = (type: string | null | undefined) => type === 'Scythe';

export function passives(levels: Record<string, number>, weaponType: string | null): Passives {
  const L = (n: string) => levels[n] ?? 0;
  const scythe = isScythe(weaponType);
  return {
    // Scythe Mastery "2 ATK per level", Advanced Scythe Mastery "5 ATK per
    // level" -- mastery ATK, applied since Refuge Patch 12 (2026-09-06).
    masteryAtk: scythe ? 2 * L('Scythe Mastery') + 5 * L('Advanced Scythe Mastery') : 0,
    hit: 0,
    // Advanced Scythe Mastery "1 Crit and 2 Flee per level"; Scythe Mastery
    // "Critical Rate +1 per level", "Perfect Dodge +1 per level" (with any
    // weapon, the 2023 code: status.cpp:4846).
    flee: scythe ? 2 * L('Advanced Scythe Mastery') : 0,
    crit: scythe ? L('Scythe Mastery') + L('Advanced Scythe Mastery') : 0,
    perfectDodge: L('Scythe Mastery'),
    hpFlat: 0,
    spFlat: 0,
    hpPercent: 0,
    // Increase SP Recovery: "2 SP + 0.1% max SP regen per level".
    spRegen: { flat: 2 * L('Increase SP Recovery'), maxShare: 0.001 * L('Increase SP Recovery') },
    notes: [
      'passives: Scythe Mastery + Advanced Scythe Mastery (mastery ATK, crit, flee, Perfect Dodge), Increase SP Recovery; '
        + "Ominous Presence as the tooltip's overheal shield only (the 2023 code's +HIT / crit damage left out)",
    ],
  };
}

// ---- the combo states -----------------------------------------------------------

const combo = (fight: Fight) => has(fight, 'combo');
const comboLeft = (fight: Fight) => (combo(fight) ? fight.me.buffs.combo.until - fight.t : 0);
/** Combo Ready: a new one never shortens what you have (Refuge Patch 15). */
function grantCombo(fight: Fight, ms: number) {
  const until = Math.max(fight.me.buffs.combo?.until ?? -1, fight.t + ms);
  fight.me.buffs.combo = { until, stacks: 1 };
}
const finisher = (fight: Fight) => has(fight, 'finisher');
const overslash = (fight: Fight) => stacks(fight, 'overslash');
const MAX_STACKS = 5;
const STACK_MS = 6000;

/** The hit went in and left it standing: Combo Ready and Finisher Ready come only then (skill.cpp:1180, 4038). */
const landedAlive = (fight: Fight, dealt: number) => dealt > 0 && !fight.result;

// ---- damage ---------------------------------------------------------------------

const L = (fight: Fight, n: string) => lv(fight.f, n);
/**
 * Darkside Shadow: "Adds 2% per DEX Scaling to all Physical skills,
 * Underworld Rainstorm bonus is halved" (tooltip; the 2023 code gives it to
 * four skills only).
 */
const shadowDex = (fight: Fight, half = false) => (has(fight, 'shadow') ? (half ? 1 : 2) * fight.f.stats.dex : 0);
/**
 * True Sight: "hit by 3 and crit by 3 per level", all stats +3 (tooltip; the
 * +3 stats are left out) -- and, unsaid by the tooltip, +2% a level on every
 * weapon attack's ratio, normal attacks too (2023 code, battle.cpp:3885).
 */
const trueSightRatio = (fight: Fight) => (has(fight, 'trueSight') ? 2 * L(fight, 'True Sight') : 0);
const trueSightCrit = (fight: Fight) => (has(fight, 'trueSight') ? 3 * L(fight, 'True Sight') : 0);

/** A weapon skill's hit, element `ele` (Hellraiser: always Fire). */
function hit(fight: Fight, name: string, ratio: number, o: { ranged?: boolean; ele?: string; f?: Fighter } = {}) {
  const f = o.f ?? fight.f;
  const skillDamage = f.skillMods(name, 'damage').percent;
  const ele = o.ele ?? element(fight);
  return (crit: boolean) => physicalDamage(f, targetNow(fight), {
    ratio, element: ele, statusElement: 'Neutral', ranged: !!o.ranged, crit, skillDamage,
  }, fight.rng);
}

/** A MATK skill (Dark Message, Dark Messenger, Flaming Wave). */
function magicHit(fight: Fight, name: string, ratio: number, ele = element(fight)) {
  const skillDamage = fight.f.skillMods(name, 'damage').percent;
  return () => magicDamage(fight.f, targetNow(fight), { ratio, element: ele, skillDamage, bonus: 0 }, fight.rng);
}

/** Weapon weight, in the server's 0.1 units (the planner's weight x 10). */
const weights = new Map<string, number>();
function weaponWeight(f: Fighter): number {
  const name = f.weapon?.name;
  if (!name) return 0;
  let w = weights.get(name);
  if (w === undefined) {
    const item = plannerDataset().itemList.find((i) => i.name === name);
    weights.set(name, w = 10 * (Number((item as { weight?: number } | undefined)?.weight) || 0));
  }
  return w;
}

/** After-cast delays the tooltips leave out, from the 2023 skill_db (ms). */
const ACD: Record<string, number> = {
  'Reaping Slash': 500, 'Roaring Overslash': 1000, 'Underworld Rainstorm': 1000, 'Haunting Slice': 500,
  'Dark Message': 500, 'Dark Messenger': 500, 'Vampire Mark': 2000, 'Mirror Break': 1000,
};
const delay = (id: string) => (fight: Fight) => skillDelayMs(id === 'Scythe Reap' ? 1100 - 100 * L(fight, 'Scythe Reap') : ACD[id] ?? 0, fight.f);

const scythe = (fight: Fight) => isScythe(fight.f.weapon?.type);

// ---- attacks --------------------------------------------------------------------

/**
 * The swing. Darkside Shadow: "Double Attack chance is 10% per level" with a
 * scythe; the shadow's second hit can crit, and the rate replaces gear's
 * double attack (2023 code, battle.cpp:3748). True Sight's +2%/lv counts.
 */
const attack: Action = {
  id: 'Attack',
  isSkill: false,
  offensive: true,
  ready: (fight) => optionOn(fight, 'autoAttack'),
  castMs: () => 0,
  delayMs: (fight) => weaveMs(fight) ?? attackIntervalMs(fight.f.aspd),
  cooldownMs: (fight) => (weaveMs(fight) === null ? 0 : attackIntervalMs(fight.f.aspd)),
  spCost: () => 0,
  resolve(fight) {
    const p = has(fight, 'shadow') && scythe(fight) ? Math.min(1, 0.1 * L(fight, 'Darkside Shadow')) : 0;
    const expect = fight.rng.expect;
    const double = !expect && fight.rng.chance(p);
    strike(fight, 'Attack', {
      hits: double ? 2 : 1, split: true, canMiss: true, critBonus: trueSightCrit(fight),
      damage: (crit) => physicalDamage(fight.f, targetNow(fight), {
        ratio: 100 + trueSightRatio(fight), rightTimes: expect ? 1 + p : double ? 2 : 1, element: element(fight),
        statusElement: 'Neutral', ranged: false, crit, skillDamage: 0, normal: true,
      }, fight.rng),
    });
  },
};

/**
 * Scythe Reap: "150+25% per level +2% per Luk", can crit, "multi-strike"
 * (three shown, one roll: the code's HitCount -3), "slightly boosted by
 * weapon weight" (weight / 100 as ATK, no mastery ATK: 2023 code,
 * battle.cpp:3519-3542). Combo Ready 4 s. `level`: an autocast's own
 * (Haunting Slice's).
 */
function reap(fight: Fight, level: number, id = 'Scythe Reap'): number {
  const s = fight.f.stats;
  const ratio = 150 + 25 * level + 2 * s.luk + shadowDex(fight) + trueSightRatio(fight);
  const f: Fighter = { ...fight.f, masteryAtk: 0, equipAtk: fight.f.equipAtk + Math.floor(weaponWeight(fight.f) / 100) };
  const dealt = strike(fight, id, { hits: 3, split: true, canMiss: true, critBonus: trueSightCrit(fight),
    damage: hit(fight, 'Scythe Reap', ratio, { f }) });
  if (landedAlive(fight, dealt)) grantCombo(fight, 4000);
  return dealt;
}
const scytheReap: Action = {
  id: 'Scythe Reap',
  isSkill: true,
  offensive: true,
  // Option comboRefreshMs: recast only once Combo Ready is this close to
  // running out (or down) -- it is the combo's opener and its upkeep.
  ready: (fight) => learned('Scythe Reap')(fight) && scythe(fight)
    && comboLeft(fight) <= (typeof fight.options.comboRefreshMs === 'number' ? fight.options.comboRefreshMs : 1000),
  castMs: () => 0,
  delayMs: delay('Scythe Reap'),
  cooldownMs: cooldown('Scythe Reap'),
  spCost: spCost('Scythe Reap'),
  resolve(fight) { reap(fight, L(fight, 'Scythe Reap')); },
};

/**
 * Sweeping Slash: "200+25% per level +2% per LUK per hit", "2 individual
 * hits", "3 hits if Finisher Ready" (tooltip; the 2023 code has no third),
 * "greatly reduced outside combos" -- 110 + 2%/lv there (code). Combo Ready
 * 3 s once Advanced Scythe Mastery is learned.
 */
const sweepingSlash: Action = {
  id: 'Sweeping Slash',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Sweeping Slash')(fight) && scythe(fight) && (combo(fight) || fight.options.sweepAnytime === true),
  castMs: () => 0,
  cooldownMs: cooldown('Sweeping Slash'),
  spCost: spCost('Sweeping Slash'),
  resolve(fight) {
    const l = L(fight, 'Sweeping Slash'); const s = fight.f.stats;
    const ratio = (combo(fight) ? 200 + 25 * l + 2 * s.luk : 110 + 2 * l) + shadowDex(fight) + trueSightRatio(fight);
    const hits = finisher(fight) && fight.options.sweepThird !== false ? 3 : 2;
    const dealt = strike(fight, 'Sweeping Slash', { hits, canMiss: true, critBonus: trueSightCrit(fight),
      damage: hit(fight, 'Sweeping Slash', ratio) });
    if (L(fight, 'Advanced Scythe Mastery') > 0 && landedAlive(fight, dealt)) grantCombo(fight, 3000);
  },
};

/**
 * Hellraiser: "250+15% per level +3% per LUK", "always Fire", 9x9 around
 * you, can crit, 0.5 s variable cast, "activates Finisher Ready for 5s"
 * (on a hit it survives: code). Cast when it sets up the stack jump: under
 * Combo Ready with a stack held, and Combo Ready lasting past it.
 */
const hellraiser: Action = {
  id: 'Hellraiser',
  isSkill: true,
  offensive: true,
  // An area around you: it finds a cloaked monster (Famine Incarnate's Invisible).
  findsCloaked: true,
  ready: (fight) => learned('Hellraiser')(fight) && scythe(fight)
    && (fight.options.hellraiserAnytime === true
      || (combo(fight) && overslash(fight) >= 1 && overslash(fight) < MAX_STACKS && !finisher(fight)
        && comboLeft(fight) > cast('Hellraiser')(fight) + 400)),
  castMs: cast('Hellraiser'),
  cooldownMs: cooldown('Hellraiser'),
  spCost: spCost('Hellraiser'),
  resolve(fight) {
    const l = L(fight, 'Hellraiser'); const s = fight.f.stats;
    const ratio = 250 + 15 * l + 3 * s.luk + shadowDex(fight) + trueSightRatio(fight);
    const dealt = strike(fight, 'Hellraiser', { hits: 1, canMiss: true, critBonus: trueSightCrit(fight), aoe: true,
      damage: hit(fight, 'Hellraiser', ratio, { ele: 'Fire' }) });
    if (landedAlive(fight, dealt)) grant(fight, 'finisher', 5000);
  },
};

/**
 * Reaping Slash: "110+10% per level +2% per LUK", "+5% per Overslash Stack",
 * 5x5, can crit, 5 SP a level and 5% of current HP (Patch 18), 1.5 s
 * cooldown, three shown hits in one roll (code HitCount -3). The code cuts
 * it to 110 + 1%/lv outside Combo Ready; the tooltip does not (option
 * reapingNoCombo 'code' takes the code's). Then the stacks (see the top),
 * and Finisher Ready ends.
 *
 * When: under Combo Ready, for the first stack, for the jump to 5 under
 * Finisher Ready, to build while Hellraiser is not about to come up, and at 5
 * to keep them (option reapingFiller) -- never into a Finisher Ready it would
 * waste.
 */
const reapingSlash: Action = {
  id: 'Reaping Slash',
  isSkill: true,
  offensive: true,
  findsCloaked: true,
  ready: (fight) => {
    if (!learned('Reaping Slash')(fight) || !scythe(fight)) return false;
    const st = overslash(fight);
    if (!combo(fight)) return fight.options.reapingNoCombo === 'always';
    if (finisher(fight)) return st >= 1;
    if (st === 0) return true;
    const hr = learned('Hellraiser')(fight) && readyAt(fight, 'Hellraiser') <= fight.t + 1000 && fight.options.hellraiserAnytime !== true;
    if (st < MAX_STACKS) return !hr;
    return optionOn(fight, 'reapingFiller');
  },
  castMs: () => 0,
  delayMs: delay('Reaping Slash'),
  cooldownMs: cooldown('Reaping Slash'),
  spCost: spCost('Reaping Slash'),
  hpCost: T.hpCost('Reaping Slash'),
  resolve(fight) {
    const l = L(fight, 'Reaping Slash'); const s = fight.f.stats;
    const held = overslash(fight);
    const base = !combo(fight) && fight.options.reapingNoCombo === 'code' ? 110 + l : 110 + 10 * l + 2 * s.luk;
    const ratio = base + 5 * held + shadowDex(fight) + trueSightRatio(fight);
    strike(fight, 'Reaping Slash', { hits: 3, split: true, canMiss: true, critBonus: trueSightCrit(fight), aoe: true,
      damage: hit(fight, 'Reaping Slash', ratio) });
    // The stacks (skill.cpp:10465-10486).
    let count = 1;
    if (held > 0 && combo(fight)) count = Math.min(MAX_STACKS, 1 + held + (finisher(fight) ? 3 * held : 0));
    if (combo(fight) || held <= 1) fight.me.buffs.overslash = { until: fight.t + STACK_MS, stacks: count };
    delete fight.me.buffs.finisher;
  },
};

/**
 * Roaring Overslash: "150+15% per level +2% per LUK", "reduced if not combo
 * ready" -- 150 + 2%/lv + 2%/LUK then (code, with Patch 18's 1% -> 2% LUK),
 * one extra hit per stack, each whole (code: stacks + 1, not spent), 7x7,
 * can crit, 7 s cooldown, 25-70 SP and 10% of current SP.
 * Option roaringAt: the stacks it waits for (5).
 */
const roaringOverslash: Action = {
  id: 'Roaring Overslash',
  isSkill: true,
  offensive: true,
  findsCloaked: true,
  ready: (fight) => learned('Roaring Overslash')(fight) && scythe(fight)
    && (combo(fight) || fight.options.roaringNoCombo === true)
    && overslash(fight) >= (typeof fight.options.roaringAt === 'number' ? fight.options.roaringAt : MAX_STACKS),
  castMs: () => 0,
  delayMs: delay('Roaring Overslash'),
  cooldownMs: cooldown('Roaring Overslash'),
  spCost: spCost('Roaring Overslash'),
  resolve(fight) {
    const l = L(fight, 'Roaring Overslash'); const s = fight.f.stats;
    const ratio = (combo(fight) ? 150 + 15 * l + 2 * s.luk : 150 + 2 * l + 2 * s.luk) + shadowDex(fight) + trueSightRatio(fight);
    strike(fight, 'Roaring Overslash', { hits: overslash(fight) + 1, canMiss: true, critBonus: trueSightCrit(fight), aoe: true,
      damage: hit(fight, 'Roaring Overslash', ratio) });
  },
};

/**
 * Underworld Rainstorm: 11x11 around the target for 3 s, a hit every 0.2 s
 * (15), each "2% per Level +1% per 2 LUK and INT" on a 100% base (the
 * tooltip shows only the bonus; code and the 29 Aug note on descriptions),
 * +4% per stack at each tick, Darkside Shadow's DEX halved. "Never misses",
 * no crit. 5 s + 0.5 s cast that cannot be interrupted, DEF halved while
 * casting; Royal Scythe's "Cast Removed" takes all of it, Dark Message's Cast
 * Ready 95% of the variable part. A Shadow Orb a cast (not counted).
 * Option rainAt: the stacks it waits for (0: any).
 */
const castRemoved = new WeakMap<Fighter, boolean>();
const rainNoCast = (f: Fighter) => {
  let v = castRemoved.get(f);
  if (v === undefined) castRemoved.set(f, v = /Underworld\s+Rainstorm\s+Cast\s+Removed/i.test(f.gearText ?? ''));
  return v;
};
const RAIN_TICKS = 15;
const rainCastMs = (fight: Fight) => {
  if (rainNoCast(fight.f)) return 0;
  const t = T.sk('Underworld Rainstorm').text; const l = L(fight, 'Underworld Rainstorm');
  const vct = t.variableCast(l) * (has(fight, 'castReady') ? 0.05 : 1);
  return castTimeMs(vct, t.fixedCast(l), fight.f);
};
const underworldRainstorm: Action = {
  id: 'Underworld Rainstorm',
  isSkill: true,
  offensive: true,
  interruptible: false,
  castDefCut: 0.5,
  findsCloaked: true,
  ready: (fight) => learned('Underworld Rainstorm')(fight) && scythe(fight) && optionOn(fight, 'rainstorm')
    && overslash(fight) >= (typeof fight.options.rainAt === 'number' ? fight.options.rainAt : 0)
    // A long cast only when it is cut (Royal Scythe, Cast Ready) or option rainSlow.
    && (rainCastMs(fight) <= 1000 || fight.options.rainSlow === true),
  castMs: rainCastMs,
  delayMs: delay('Underworld Rainstorm'),
  cooldownMs: cooldown('Underworld Rainstorm'),
  spCost: spCost('Underworld Rainstorm'),
  resolve(fight) {
    const l = L(fight, 'Underworld Rainstorm');
    fight.mob.dots = fight.mob.dots.filter((d) => d.name !== 'Underworld Rainstorm');
    fight.mob.dots.push({
      name: 'Underworld Rainstorm', nextAt: fight.t + 200, every: 200, dmg: 0, lethal: true, left: RAIN_TICKS,
      hit: (x) => {
        const s = x.f.stats;
        const ratio = 100 + 2 * l + (s.luk + s.int) / 2 + 4 * overslash(x) + shadowDex(x, true) + trueSightRatio(x);
        strike(x, 'Underworld Rainstorm', { hits: 1, canMiss: false, critBonus: null, kind: 'ranged', aoe: true,
          damage: hit(x, 'Underworld Rainstorm', ratio, { ranged: true }) });
      },
    });
  },
};

/**
 * Haunting Slice: a dash in, "20% chance per level to autocast Scythe Reap"
 * at its own level (100% at Lv5), free and with no delay (Patch 18), its
 * Combo Ready always refreshing (Patch 15). The hit: "fixed based on ATK and
 * Str" with no numbers -- the 2023 code's plain 100% (no crit), long range.
 */
const hauntingSlice: Action = {
  id: 'Haunting Slice',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Haunting Slice')(fight) && scythe(fight),
  castMs: () => 0,
  delayMs: delay('Haunting Slice'),
  cooldownMs: cooldown('Haunting Slice'),
  spCost: spCost('Haunting Slice'),
  resolve(fight) {
    const l = L(fight, 'Haunting Slice');
    strike(fight, 'Haunting Slice', { hits: 1, canMiss: true, critBonus: null, kind: 'ranged',
      damage: hit(fight, 'Haunting Slice', 100 + trueSightRatio(fight), { ranged: true }) });
    if (fight.result) return;
    const p = Math.min(1, 0.2 * l);
    if (fight.rng.expect ? p >= 0.5 : fight.rng.chance(p)) {
      fight.log && say(fight, 'Haunting Slice autocasts Scythe Reap');
      reap(fight, l, 'Scythe Reap (autocast)');
    }
  },
};

/** Phantom Slice: "100+20% +2% per Vit" (a level), a pull from range, no crit, 1 s cooldown. */
const phantomSlice: Action = {
  id: 'Phantom Slice',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Phantom Slice')(fight) && scythe(fight),
  castMs: () => 0,
  cooldownMs: cooldown('Phantom Slice'),
  spCost: spCost('Phantom Slice'),
  resolve(fight) {
    const ratio = 100 + 20 * L(fight, 'Phantom Slice') + 2 * fight.f.stats.vit + shadowDex(fight) + trueSightRatio(fight);
    strike(fight, 'Phantom Slice', { hits: 1, canMiss: true, critBonus: null, kind: 'ranged',
      damage: hit(fight, 'Phantom Slice', ratio, { ranged: true }) });
  },
};

/**
 * Dark Message: "10% per level +1% per STR" of MATK, a push, and Combo Ready
 * and Cast Ready (variable cast -95%, not spent: code) for 1 s a level. The
 * damage is small; the point is Combo Ready without a hit that must land, and
 * Underworld Rainstorm's cast cut.
 */
const darkMessage: Action = {
  id: 'Dark Message',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Dark Message')(fight) && (comboLeft(fight) < 1000 || needsCastReady(fight)),
  castMs: cast('Dark Message'),
  delayMs: delay('Dark Message'),
  cooldownMs: cooldown('Dark Message'),
  spCost: spCost('Dark Message'),
  resolve(fight) {
    const l = L(fight, 'Dark Message');
    strike(fight, 'Dark Message', { hits: 1, canMiss: false, critBonus: null, kind: 'magic',
      damage: magicHit(fight, 'Dark Message', 10 * l + fight.f.stats.str) });
    grantCombo(fight, 1000 * l);
    grant(fight, 'castReady', 1000 * l);
  },
};
/** Underworld Rainstorm would be castable soon but for its cast bar. */
const needsCastReady = (fight: Fight) => learned('Underworld Rainstorm')(fight) && optionOn(fight, 'rainstorm')
  && !rainNoCast(fight.f) && !has(fight, 'castReady') && readyAt(fight, 'Underworld Rainstorm') <= fight.t + 500;

/** Dark Messenger: "25+1% per STR, per hit" of MATK, a hit a level, "1.5x damage when combo ready", 10% current SP extra. */
const darkMessenger: Action = {
  id: 'Dark Messenger',
  isSkill: true,
  offensive: true,
  ready: learned('Dark Messenger'),
  castMs: cast('Dark Messenger'),
  delayMs: delay('Dark Messenger'),
  cooldownMs: cooldown('Dark Messenger'),
  spCost: spCost('Dark Messenger'),
  resolve(fight) {
    const ratio = (25 + fight.f.stats.str) * (combo(fight) ? 1.5 : 1);
    strike(fight, 'Dark Messenger', { hits: L(fight, 'Dark Messenger'), canMiss: false, critBonus: null, kind: 'magic',
      damage: magicHit(fight, 'Dark Messenger', ratio) });
  },
};

/** Flaming Wave: "30% per level +3% per INT" of MATK, Fire (its Burning left out). */
const flamingWave: Action = {
  id: 'Flaming Wave',
  isSkill: true,
  offensive: true,
  ready: learned('Flaming Wave'),
  castMs: cast('Flaming Wave'),
  cooldownMs: cooldown('Flaming Wave'),
  spCost: spCost('Flaming Wave'),
  resolve(fight) {
    strike(fight, 'Flaming Wave', { hits: 1, canMiss: false, critBonus: null, kind: 'magic',
      damage: magicHit(fight, 'Flaming Wave', 30 * L(fight, 'Flaming Wave') + 3 * fight.f.stats.int, 'Fire') });
  },
};

// ---- buffs kept up ------------------------------------------------------------------

/** A self buff recast when it has run out (or is about to), from the rotation. */
function upkeep(id: string, buff: string, ms: (fight: Fight) => number, apply?: (fight: Fight) => void): Action {
  return {
    id,
    isSkill: true,
    offensive: false,
    ready: (fight) => learned(id)(fight) && optionOn(fight, buff) && (fight.me.buffs[buff]?.until ?? -1) <= fight.t + 500,
    castMs: cast(id),
    delayMs: delay(id),
    cooldownMs: cooldown(id),
    spCost: spCost(id),
    resolve(fight) { grant(fight, buff, ms(fight)); apply?.(fight); },
  };
}
/** Darkside Shadow: "15 seconds per level", 60 s cooldown (Patch 18); it drains 1 SP a second (2023 code, unsaid). */
const darkside = upkeep('Darkside Shadow', 'shadow', (fight) => 15_000 * L(fight, 'Darkside Shadow'),
  (fight) => dot(fight, 'Darkside Shadow drain', 1000, 15_000 * L(fight, 'Darkside Shadow'), -1, false, false, true));
/** True Sight: "Duration is 60 seconds", 80 s cooldown. */
const trueSight = upkeep('True Sight', 'trueSight', () => 60_000);
/** Vampire Mark: 60 - 5 s a level, "Leeching chance is 10% per level", "power is 3% per level", physical only (engine leech). */
const vampireMark = upkeep('Vampire Mark', 'vampireMark', (fight) => (65 - 5 * L(fight, 'Vampire Mark')) * 1000, (fight) => {
  const l = L(fight, 'Vampire Mark');
  fight.me.buffs.vampireMark.value = 10 * l; fight.me.buffs.vampireMark.value2 = 3 * l;
});
/** Shadow Parry: "Block chance is 10 + 2% per level", "20+10s per level" (engine landMobHit: any weapon hit). */
const shadowParry = upkeep('Shadow Parry', 'parry', (fight) => (20 + 10 * L(fight, 'Shadow Parry')) * 1000, (fight) => {
  fight.me.buffs.parry.value = 10 + 2 * L(fight, 'Shadow Parry');
});

/**
 * Mirror Break: the target reflects nothing for "10+5 seconds per level"
 * (engine mobGuard) -- cast on a monster with Reflect Shield or Magic Mirror
 * up (Heartless). Its 10% skill-fail chance on the target is left out.
 */
const mirrorBreak: Action = {
  id: 'Mirror Break',
  isSkill: true,
  offensive: false,
  ready: (fight) => learned('Mirror Break')(fight) && !mobHas(fight, 'kyomu')
    && ['reflectshield', 'magicmirror'].some((k) => (fight.mob.buffs[k]?.until ?? -1) > fight.t),
  castMs: cast('Mirror Break'),
  delayMs: delay('Mirror Break'),
  cooldownMs: cooldown('Mirror Break'),
  spCost: spCost('Mirror Break'),
  resolve(fight) {
    fight.mob.debuffs.kyomu = { until: fight.t + (10 + 5 * L(fight, 'Mirror Break')) * 1000, stacks: 1 };
  },
};

/**
 * Final Orchestra: a healing area, "2% of Caster's Max HP per level", "10
 * Pulses over 10 seconds", 2 s + 1 s cast, 15 s cooldown, 25% Max SP and a
 * Shadow Orb. The 2023 code heals 50 a level flat and the site's digest 666
 * at Lv10 -- the tooltip is taken, as the rule is, and this is the kit's
 * biggest open question. Its damage to enemies (half) is left out: they are
 * knocked 5 cells out of it. Option healBelow (0.5): cast under that share of HP.
 */
const finalOrchestra: Action = {
  id: 'Final Orchestra',
  isSkill: true,
  offensive: false,
  ready: (fight) => learned('Final Orchestra')(fight) && optionOn(fight, 'orchestra')
    && fight.me.hp < (typeof fight.options.healBelow === 'number' ? fight.options.healBelow : 0.5) * fight.f.maxHp,
  castMs: cast('Final Orchestra'),
  cooldownMs: cooldown('Final Orchestra'),
  spCost: spCost('Final Orchestra'),
  resolve(fight) {
    const per = 0.02 * L(fight, 'Final Orchestra') * fight.f.maxHp * Math.max(0, 1 + (fight.f.healReceived ?? 0) / 100);
    dot(fight, 'Final Orchestra', 1000, 10_000, per, false, true);
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
      // Nothing into a ward: step away first (pullOffWard). Rainstorm's ticks are long range.
      if ((fight.mob.buffs.pneuma?.until ?? -1) > fight.t && ['Haunting Slice', 'Phantom Slice', 'Underworld Rainstorm'].includes(a.id)) return false;
      if ((fight.mob.buffs.safetywall?.until ?? -1) > fight.t && MELEE.has(a.id)) return false;
      // Its Reflect Shield sends a share of a melee hit back: only with HP to take it, unless Mirror Break is on it.
      if (MELEE.has(a.id) && (fight.mob.buffs.reflectshield?.until ?? -1) > fight.t && !mobHas(fight, 'kyomu')
        && fight.me.hp < 0.7 * fight.f.maxHp && optionOn(fight, 'reflectCare')) return false;
      if (has(fight, 'hidden') && a.offensive) return false;
      return own?.(fight) ?? true;
    },
  };
}
const MELEE = new Set(['Attack', 'Scythe Reap', 'Sweeping Slash', 'Hellraiser', 'Reaping Slash', 'Roaring Overslash']);

// ---- defence --------------------------------------------------------------------------

/** The Revenant's dodges: Hiding, walking or line of sight (COMMON_TOOLS); Shadow Parry and Finisher Ready work on their own. */
const TOOLS: DefenseTool[] = [...COMMON_TOOLS];
export const REVENANT_TOOLS = TOOLS;

/** Without option defense 'auto': hide from what Hiding stops, walk out of an area, else break sight. */
function react(fight: Fight, s: MobSkill, from: Monster): { action: string; at: number } | null {
  const t = assessThreat(fight, s, from);
  if (!t.heavy) return null;
  if (t.canWalk && s.targets === 'aoe') return { action: 'Walk out', at: fight.t + reactionMs(fight) };
  if (t.hideWorks && t.hideReady) return { action: 'Hiding', at: Math.max(fight.t, t.endsAt - 150) };
  if (t.canLos) return { action: 'Break line of sight', at: fight.t + reactionMs(fight) };
  return null;
}

// ---- the rotation -------------------------------------------------------------------------

const ACTIONS: Action[] = [
  attack, waitAction, heal, scytheReap, sweepingSlash, hellraiser, reapingSlash, roaringOverslash, underworldRainstorm,
  hauntingSlice, phantomSlice, darkMessage, darkMessenger, flamingWave, darkside, trueSight, vampireMark, shadowParry,
  mirrorBreak, finalOrchestra, hiding, walkOut, breakSight, morrocsMark, stayHidden, pullOffWard, backSlide,
  ...predictActions(TOOLS), stayReadyAction(TOOLS),
].map(withRules);
const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
const rule = (id: string) => BY_ID.get(id)!;
const PREEMPTS = ACTIONS.filter(isPreempt);

/**
 * The priority, as the class discussions play it: upkeep and sustain first,
 * then the finisher (Roaring at 5 stacks), the stack builder, Hellraiser for
 * the jump, Rainstorm, Scythe Reap to open or keep Combo Ready, and the
 * fillers. The skills' own ready rules sequence the combo.
 */
const ORDER = [
  'Stay hidden', "Morroc's Mark", 'Pull it off the ward', 'Final Orchestra', 'Heal',
  'Darkside Shadow', 'True Sight', 'Vampire Mark', 'Shadow Parry', 'Mirror Break',
  'Roaring Overslash', 'Reaping Slash', 'Hellraiser', 'Underworld Rainstorm', 'Scythe Reap',
  'Sweeping Slash', 'Haunting Slice', 'Dark Message', 'Dark Messenger', 'Phantom Slice', 'Flaming Wave',
  'Attack',
];
export const REVENANT_ORDER = ORDER;

/** The rotation's switches for the searches (kits/index.ts RotationSpace). */
export const REVENANT_SEARCH = {
  order: ORDER,
  switches: {
    roaringAt: [5, 3, 1], rainAt: [0, 5, 3], comboRefreshMs: [1000, 0, 2000], reapingFiller: [true, false],
    hellraiserAnytime: [false, true], rainstorm: [true, false], autoAttack: [true, false], heal: [true, false],
    orchestra: [true, false], shadow: [true, false], trueSight: [true, false], vampireMark: [true, false], parry: [true, false],
    burningScythe: ['auto', false, true], healBelow: [0.5, 0.35, 0.7], tankShare: [0.4, 0.25, 0.6],
  } as Record<string, unknown[]>,
  pinned: ['Stay hidden', "Morroc's Mark", 'Pull it off the ward'],
  // Melee crit skills on a leech build: what a new piece's random options go to first.
  rolls: ['roaring_overslash_damage', 'reaping_slash_damage', 'melee_damage', 'critical_damage', 'atk_pct', 'max_hp', 'defense_penetration', 'sp_cost_reduced', 'hp_leech',
    'physical_reduced', 'physical_damage_reduced', 'after_cast_delay', 'after_cast_delay_reduced', 'aspd', 'crit', 'sp_regen', 'flee'],
  droppable: ['Hellraiser', 'Underworld Rainstorm', 'Sweeping Slash', 'Haunting Slice', 'Dark Message', 'Dark Messenger',
    'Phantom Slice', 'Flaming Wave', 'Attack', 'Final Orchestra', 'Heal', 'Mirror Break', 'Darkside Shadow', 'True Sight',
    'Vampire Mark', 'Shadow Parry'],
};

function priority(fight: Fight): Action {
  const order = Array.isArray(fight.options.order) ? fight.options.order as string[] : ORDER;
  for (const id of order) {
    const a = BY_ID.get(id);
    if (a && canUse(fight, a)) return a;
  }
  return rule('Wait');
}

// ---- before the pull ------------------------------------------------------------------------

/**
 * Burning Scythe (Fire endow, "30 seconds per level"): option burningScythe
 * 'auto' (the default) puts it up when Fire does more to the target than the
 * weapon's own element -- cast before the pull, as a player does between
 * monsters; true always, false never.
 */
function wantsFire(fight: Fight): boolean {
  const o = fight.options.burningScythe ?? 'auto';
  if (o === false || !learned('Burning Scythe')(fight)) return false;
  if (o === true) return true;
  const m = fight.m; const own = fight.f.weapon?.element ?? 'Neutral';
  return attrFix('Fire', m.element, m.elementLevel) > attrFix(own, m.element, m.elementLevel);
}

function prep(fight: Fight) {
  const f = fight.f;
  // As the Kingslayer: server walking, and automatic defence unless the profile says otherwise.
  fight.options.mobility ??= 'server';
  fight.options.defense ??= 'auto';
  fight.options.tankShare ??= 0.4;
  if (wantsFire(fight)) grant(fight, 'fireEndow', 30_000 * L(fight, 'Burning Scythe'));
  // Buffs up at the pull, their cooldowns running from it (Darkside Shadow's
  // 150 s outlasts most fights; the rest are recast in the rotation).
  for (const [a, key] of [[darkside, 'shadow'], [trueSight, 'trueSight'], [vampireMark, 'vampireMark'], [shadowParry, 'parry']] as const) {
    if (!learned(a.id)(fight) || !optionOn(fight, key)) continue;
    a.resolve(fight);
    fight.me.cds[a.id] = a.cooldownMs(fight);
  }
  // Ominous Presence: leech past full HP becomes a shield -- "8% per Skill
  // Lv against a single target", capped at "MaxHP + (10% x Lv) x (STR + 2 x
  // LUK + BaseLv) x Leech Power" (Patch 19), and only with positive Leech Power.
  const op = L(fight, 'Ominous Presence');
  const power = f.leech.hpPower;
  if (op > 0 && power > 0) {
    const cap = f.maxHp + 0.1 * op * (f.stats.str + 2 * f.stats.luk + f.level) * power;
    fight.me.buffs.ominous = { until: 1e12, stacks: 1, value: Math.min(1, 0.08 * op), value2: cap };
  }
}

function prepNotes(fight: Fight): string[] {
  const out: string[] = [];
  if (has(fight, 'fireEndow')) out.push('Burning Scythe (Fire)');
  if (has(fight, 'shadow')) out.push('Darkside Shadow');
  if (has(fight, 'trueSight')) out.push('True Sight');
  if (has(fight, 'vampireMark')) out.push('Vampire Mark');
  if (has(fight, 'parry')) out.push(`Shadow Parry ${fight.me.buffs.parry.value}%`);
  if (fight.me.buffs.ominous) out.push(`Ominous Presence shield up to ${Math.round(fight.me.buffs.ominous.value2 ?? 0).toLocaleString('en-US')}`);
  if (rainNoCast(fight.f)) out.push('Underworld Rainstorm without its cast (Royal Scythe)');
  return out;
}

const ROLES: Record<string, string> = {
  'Scythe Reap': 'Combo', 'Scythe Reap (autocast)': 'Combo', 'Reaping Slash': 'Combo', Hellraiser: 'Combo', 'Roaring Overslash': 'Combo',
  'Sweeping Slash': 'Fillers', 'Haunting Slice': 'Fillers', 'Phantom Slice': 'Fillers', 'Underworld Rainstorm': 'Rainstorm',
  'Dark Message': 'Magic', 'Dark Messenger': 'Magic', 'Flaming Wave': 'Magic', Attack: 'Auto-attacks',
};

export const revenant: Kit = {
  className: 'Revenant',
  actions: ACTIONS,
  roles: ROLES,
  cycleAnchor: 'Roaring Overslash',
  coreRoles: ['Combo'],
  magicActions: ['Dark Message', 'Dark Messenger', 'Flaming Wave'],
  priority: priorityWith(() => PREEMPTS, priority, rule('Stay ready')),
  holding: (fight) => !!snapThreatDue(fight, TOOLS),
  react: reactWith(TOOLS, react),
  prep,
  prepNotes,
  // Haunting Slice dashes in: no walk back after a dodge.
  gapClosers: ['Haunting Slice'],
};
