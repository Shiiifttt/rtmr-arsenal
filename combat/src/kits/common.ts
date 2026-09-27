/**
 * What every class kit shares: reading a skill's tooltip for its cast time,
 * cooldown and costs, a physical skill hit, the auto-attack, and the moves
 * any Orphan-line class has (Hiding, walking out of an area, Morroc's Mark),
 * plus the read on whether a monster's cast is worth dodging.
 *
 * A kit calls `toolkit(tree, element)` with its own skill tree (latest job
 * first -- a skill several jobs teach reads the first one's tooltip) and how
 * it picks its attack element.
 */
import { skillRow, type SkillRow } from '../data.ts';
import {
  attackIntervalMs, castTimeMs, mobDamage, physicalDamage, statusMatk, statusResist, TUNE,
} from '../formulas.ts';
import type { Fighter, MobSkill, Monster } from '../model.ts';
import { Rng } from '../rng.ts';
import { parseSkillText, type SkillText } from '../skilltext.ts';
import {
  followUpComing, grant, has, heal_, hidingStops, readyAt, strike,
  type Action, type Fight,
} from '../engine.ts';

/** A tooltip, parsed once. */
export interface Sk { row: SkillRow; text: SkillText }

export const lv = (f: Fighter, name: string) => f.skillLevels[name] ?? 0;

/** Kit options from the profile; everything is on unless set false. */
export const optionOn = (fight: Fight, key: string) => fight.options[key] !== false;

export interface Toolkit {
  sk(name: string): Sk;
  cast(name: string): (fight: Fight) => number;
  cooldown(name: string): (fight: Fight) => number;
  spCost(name: string): (fight: Fight) => number;
  hpCost(name: string): (fight: Fight) => number;
  learned(name: string): (fight: Fight) => boolean;
  /** A physical skill hit, with this skill's gear bonus. Skills read the right hand only (formulas.ts). */
  physical(fight: Fight, name: string, ratio: number,
    o?: { ranged?: boolean; ignoreDef?: boolean; statusElement?: string }): (crit: boolean) => number;
  element(fight: Fight): string;
}

export function toolkit(tree: string[], element: (fight: Fight) => string): Toolkit {
  const cache = new Map<string, Sk>();
  const sk = (name: string): Sk => {
    let s = cache.get(name);
    if (!s) {
      const row = skillRow(name, tree);
      s = { row, text: parseSkillText(row.desc, row.max) };
      cache.set(name, s);
    }
    return s;
  };
  return {
    sk,
    element,
    cast: (name) => (fight) => {
      const t = sk(name).text; const l = lv(fight.f, name);
      return castTimeMs(t.variableCast(l), t.fixedCast(l), fight.f);
    },
    cooldown: (name) => (fight) => {
      const cut = fight.f.skillMods(name, 'cooldown').flat * 1000;
      return Math.max(0, sk(name).text.cooldown(lv(fight.f, name)) + cut);
    },
    spCost: (name) => (fight) => {
      const s = sk(name); const l = lv(fight.f, name);
      const column = s.row.sp[Math.min(s.row.sp.length, l) - 1] ?? 0;
      const extra = s.text.extraCost.sp;
      const raw = column + extra.current * fight.me.sp + extra.max * fight.f.maxSp;
      const pct = fight.f.spCost + fight.f.skillMods(name, 'sp cost').percent;
      return Math.max(0, Math.floor(raw * Math.max(0, 1 + pct / 100)));
    },
    hpCost: (name) => (fight) => {
      const x = sk(name).text.extraCost.hp;
      return Math.floor(x.current * fight.me.hp + x.max * fight.f.maxHp);
    },
    learned: (name) => (fight) => lv(fight.f, name) > 0,
    physical(fight, name, ratio, o = {}) {
      const ele = element(fight);
      const skillDamage = fight.f.skillMods(name, 'damage').percent;
      return (crit: boolean) => physicalDamage(fight.f, fight.m, {
        ratio, element: ele, statusElement: o.statusElement ?? 'Neutral',
        ranged: !!o.ranged, crit, skillDamage, ignoreDef: o.ignoreDef,
      }, fight.rng);
    },
  };
}

// ---- actions every Orphan-line class has -------------------------------------

/**
 * The auto-attack. Double Attack: a second hit, +10% chance per level from
 * gear, with a dagger in the main hand only (RTM battle.cpp:3750-3760). A
 * rollout weighs it into one hit's ratio instead of rolling it.
 */
export function attackAction(kit: Pick<Toolkit, 'element'>, statusElement?: (fight: Fight) => string): Action {
  return {
    id: 'Attack',
    isSkill: false,
    offensive: true,
    castMs: () => 0,
    delayMs: (fight) => attackIntervalMs(fight.f.aspd),
    cooldownMs: () => 0,
    spCost: () => 0,
    resolve(fight) {
      const dagger = fight.f.weapon?.type === 'Dagger';
      const pDouble = dagger ? Math.min(1, fight.f.doubleAttack * TUNE.doubleAttackPerLevel / 100) : 0;
      const expect = fight.rng.expect;
      const hits = !expect && fight.rng.chance(pDouble) ? 2 : 1;
      const ele = kit.element(fight);
      strike(fight, 'Attack', {
        hits, canMiss: true, critBonus: 0,
        damage: (crit) => physicalDamage(fight.f, fight.m, {
          ratio: expect ? 100 * (1 + pDouble) : 100, element: ele,
          statusElement: statusElement?.(fight) ?? 'Neutral',
          ranged: false, crit, skillDamage: 0, normal: true,
        }, fight.rng),
      });
    },
  };
}

/**
 * Nothing worth doing yet: stand until the next skill comes off cooldown
 * rather than swing -- for a kit whose auto-attacks are not worth the time
 * (the project owner, 2026-09-27: a Kingslayer at 1 AGI with a shield).
 */
export const waitAction: Action = {
  id: 'Wait',
  isSkill: false,
  offensive: false,
  castMs: () => 0,
  delayMs: (fight) => {
    let next = Infinity;
    for (const a of fight.kit.actions) {
      if (!a.offensive || a.reactive || a.id === 'Attack') continue;
      const at = readyAt(fight, a.id);
      if (at > fight.t) next = Math.min(next, at);
    }
    return Math.max(100, Math.min(500, next - fight.t));
  },
  cooldownMs: () => 0,
  spCost: () => 0,
  resolve() {},
};

/**
 * Orphan Heal, on yourself: "Increases with level, INT and status MATK",
 * 7 s cooldown, 15 + 5% Max SP. The amount is the server's renewal Heal
 * (skill.cpp skill_calc_heal) at its one level: (35 + 2 x Base Level + INT)
 * / 4 x 35 x Lv / 10, plus status and weapon MATK. Cast whenever it would
 * not overheal (the project owner, 2026-09-27: off cooldown in combat).
 */
export function orphanHeal(kit: Toolkit): Action {
  const amount = (fight: Fight) => {
    const f = fight.f;
    return Math.floor((35 + 2 * f.level + f.stats.int) / 4) * 35 * Math.max(1, lv(f, 'Heal')) / 10
      + statusMatk(f.stats) + f.matk.weapon;
  };
  return {
    id: 'Heal',
    isSkill: true,
    offensive: false,
    ready: (fight) => kit.learned('Heal')(fight) && fight.f.maxHp - fight.me.hp >= amount(fight),
    castMs: kit.cast('Heal'),
    cooldownMs: (fight) => Math.max(7000, kit.cooldown('Heal')(fight)),
    spCost: (fight) => 15 + Math.floor(0.05 * fight.f.maxSp),
    resolve(fight) {
      const f = fight.f;
      heal_(fight, amount(fight) * (1 + (f.healPower ?? 0) / 100) * Math.max(0, 1 + (f.healReceived ?? 0) / 100));
    },
  };
}

export function hidingAction(kit: Toolkit): Action {
  return {
    id: 'Hiding',
    isSkill: true,
    offensive: false,
    reactive: true,
    // Ruwach / Sight keep you from hiding while they last.
    ready: (fight) => kit.learned('Hiding')(fight) && !has(fight, 'revealed'),
    castMs: () => 0,
    cooldownMs: kit.cooldown('Hiding'),
    spCost: (fight) => 15 + Math.floor(0.05 * fight.f.maxSp),
    resolve(fight) { grant(fight, 'hidden', 2000); },
  };
}

/**
 * Stay in Hiding while the monster's chain plays out: a swing or a skill
 * would bring you out between two casts Hiding stops (the Tortured Maiden's
 * Wide Stone → Wide Silence → Wide Bleeding → Vampire Gift, 0.1s each).
 */
export const stayHidden: Action = {
  id: 'Stay hidden',
  isSkill: false,
  offensive: false,
  ready: (fight) => has(fight, 'hidden') && followUpComing(fight),
  castMs: () => 0,
  delayMs: (fight) => Math.max(50, Math.min(200, fight.me.buffs.hidden.until - fight.t)),
  cooldownMs: () => 0,
  spCost: () => 0,
  resolve() {},
};

/**
 * Out until the cast lands. A lingering area is then left where it fell --
 * the monster follows you out of it (engine.ts Channel.leftBehind) -- so
 * there is no waiting for it to end.
 */
export function awayFor(fight: Fight): number {
  const c = fight.mob.cast;
  const end = c ? c.endsAt : fight.t;
  return Math.max(TUNE.walkOutMs, end - fight.t + 50);
}

export const walkOut: Action = {
  id: 'Walk out',
  isSkill: false,
  offensive: false,
  reactive: true,
  ready: (fight) => !has(fight, 'rooted'),
  castMs: () => 0,
  // Out, wait for the area to finish, back in.
  delayMs: (fight) => awayFor(fight) + TUNE.walkOutMs,
  cooldownMs: () => 0,
  spCost: () => 0,
  resolve(fight) { grant(fight, 'away', awayFor(fight)); },
};

/**
 * Pneuma and Safety Wall are ground units on the monster's own cell and do
 * not move with it (skill-effects.json). Stepping away pulls the monster off
 * them, and the ward stops mattering: what a player does rather than throw
 * a combo into it.
 */
export const wardUp = (fight: Fight, ward: 'pneuma' | 'safetywall') => (fight.mob.buffs[ward]?.until ?? -1) > fight.t;
export const pullOffWard: Action = {
  id: 'Pull it off the ward',
  isSkill: false,
  offensive: false,
  ready: (fight) => (wardUp(fight, 'pneuma') || wardUp(fight, 'safetywall')) && !has(fight, 'rooted')
    && Number.isFinite(fight.m.adelay) && !fight.mob.cast,
  castMs: () => 0,
  delayMs: () => TUNE.walkOutMs,
  cooldownMs: () => 0,
  spCost: () => 0,
  resolve(fight) {
    delete fight.mob.buffs.pneuma;
    delete fight.mob.buffs.safetywall;
  },
};

/**
 * Behind cover until a long cast lands: the cast finds no line to you (the
 * project owner, 2026-09-27: Jormungandr's long casts). Marked per skill with
 * 'los' in its dodges.
 */
export const breakSight: Action = {
  id: 'Break line of sight',
  isSkill: false,
  offensive: false,
  reactive: true,
  ready: (fight) => !has(fight, 'rooted'),
  castMs: () => 0,
  delayMs: (fight) => awayFor(fight) + TUNE.walkOutMs,
  cooldownMs: () => 0,
  spCost: () => 0,
  resolve(fight) { grant(fight, 'outOfSight', awayFor(fight)); },
};

/** Morroc's Mark: once an hour -- once a fight -- a full HP and SP restore. */
export const morrocsMark: Action = {
  id: "Morroc's Mark",
  isSkill: true,
  offensive: false,
  ready: (fight) => !fight.me.spent.mark && fight.me.hp < 0.3 * fight.f.maxHp,
  castMs: () => 0,
  cooldownMs: () => 0,
  spCost: () => 0,
  resolve(fight) {
    fight.me.spent.mark = true;
    heal_(fight, fight.f.maxHp);
    fight.me.sp = fight.f.maxSp;
  },
};

// ---- reading a cast bar -------------------------------------------------------

/** Statuses worth a dodge: they stop you acting, or hurt a lot. */
export const BAD_STATUS = new Set(['stone', 'stun', 'freeze', 'sleep', 'cursedcircle', 'coma', 'burnt', 'silence', 'aeterna', 'dispel']);

export interface Threat {
  /** When the cast lands, and how long before it there is to act. */
  endsAt: number;
  lead: number;
  /** Expected damage of every tick taken in full. */
  dmg: number;
  /** A status that stops you acting and can land on you. */
  badStatus: boolean;
  /** Worth a dodge at all. */
  heavy: boolean;
  /** Hiding would stop it and is ready in time. */
  hideWorks: boolean;
  hideReady: boolean;
  /** Hiding's 2s covers all of it. */
  hideCovers: boolean;
  /** An area with time to step out of. */
  canWalk: boolean;
  /** A cast with time to get behind cover. */
  canLos: boolean;
}

/** The read on a monster's cast that any kit's dodge plan starts from. */
export function assessThreat(fight: Fight, s: MobSkill, from: Monster): Threat {
  const endsAt = fight.t + s.castMs;
  const lead = endsAt - fight.t - TUNE.reactionMs;
  const dmg = s.type === 'status' || s.type === 'none' ? 0 : mobDamage(from, fight.f, s, new Rng(0, true)) * Math.max(1, s.ticks);
  // Worth dodging only if it can land on you: stats and gear resist it
  // (100% resistance = immune), Undead armour is immune to stone and freeze.
  const badStatus = s.statuses.some((e) => {
    if (!BAD_STATUS.has(e.sc) || e.chance <= 0) return false;
    if ((e.sc === 'stone' || e.sc === 'freeze') && fight.f.element === 'Undead') return false;
    return statusResist(fight.f, e.sc, e.resist, e.chance, from.level, from.luk).chance > 0;
  });
  // A status-only skill is worth a dodge only if it carries a bad status:
  // Wide Web's root is taken (the project owner doesn't hide from it).
  const heavy = s.type !== 'none' && s.targets !== 'self' && (dmg >= 0.25 * fight.me.hp || badStatus);
  return {
    endsAt, lead, dmg, badStatus, heavy,
    hideWorks: !!s.hiddenImmune || (s.avoid.includes('hide') && hidingStops(from, s)),
    hideReady: readyAt(fight, 'Hiding') <= endsAt - 50 && lv(fight.f, 'Hiding') > 0 && !has(fight, 'revealed'),
    hideCovers: s.durationMs <= 1800,
    canWalk: s.avoid.includes('walk') && !has(fight, 'rooted') && lead >= TUNE.walkOutMs,
    canLos: s.avoid.includes('los') && !has(fight, 'rooted') && lead >= TUNE.walkOutMs,
  };
}
