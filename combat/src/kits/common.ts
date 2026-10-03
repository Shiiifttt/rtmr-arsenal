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
  attackIntervalMs, castTimeMs, escapeCells, escapeMsFor, mobDamage, healAmount, physicalDamage, statusResist, TUNE, walkCellMs,
} from '../formulas.ts';
import type { Fighter, MobSkill, Monster } from '../model.ts';
import { playEntry } from '../playbook.ts';
import { Rng } from '../rng.ts';
import { parseSkillText, type SkillText } from '../skilltext.ts';
import {
  actionById, disabled, followUpComing, grant, has, heal_, hidingStops, readyAt, strike, targetNow,
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
      return (crit: boolean) => physicalDamage(fight.f, targetNow(fight), {
        ratio, element: ele, statusElement: o.statusElement ?? 'Neutral',
        ranged: !!o.ranged, crit, skillDamage, ignoreDef: o.ignoreDef,
      }, fight.rng);
    },
  };
}

// ---- actions every Orphan-line class has -------------------------------------

/**
 * Swing timer (profile option `weaveMs`, a number). On the server a swing sets
 * only the next swing's time (attackabletime = now + adelay, RTM
 * unit.cpp:2797), not the cast delay (canact_tick), so a skill can go off
 * right after it. A skill's delay does hold the next swing back
 * (skill_delay_attack_enable is off, unit.cpp:2701). With the option set, a
 * swing holds you only `weaveMs` (your reaction and latency; 0 is a perfect
 * player) and the next one waits the attack interval as its cooldown.
 * Without it, a swing holds you the whole interval, as before.
 */
export function weaveMs(fight: Fight): number | null {
  const v = fight.options.weaveMs;
  return typeof v === 'number' && v >= 0 ? v : null;
}

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
    delayMs: (fight) => weaveMs(fight) ?? attackIntervalMs(fight.f.aspd),
    cooldownMs: (fight) => (weaveMs(fight) === null ? 0 : attackIntervalMs(fight.f.aspd)),
    spCost: () => 0,
    resolve(fight) {
      const dagger = fight.f.weapon?.type === 'Dagger';
      // The higher of Double Attack (a dagger in the main hand, 10% a level) and gear's Double Attack chance
      // (any weapon), not both (RTM battle.cpp battle_calc_multi_attack).
      const pDouble = Math.min(1, Math.max(dagger ? fight.f.doubleAttack * TUNE.doubleAttackPerLevel : 0, fight.f.weapon ? fight.f.doubleRate ?? 0 : 0) / 100);
      const expect = fight.rng.expect;
      const double = !expect && fight.rng.chance(pDouble);
      const ele = kit.element(fight);
      // A Double Attack doubles the right hand only; the left still lands
      // once. The swing is one roll and crits whole (the project owner,
      // 2026-09-27: 1,401 twice + 530 left, crit 2,058 twice + 726).
      strike(fight, 'Attack', {
        hits: double ? 2 : 1, split: true, canMiss: true, critBonus: 0,
        damage: (crit) => physicalDamage(fight.f, targetNow(fight), {
          ratio: 100, rightTimes: expect ? 1 + pDouble : double ? 2 : 1, element: ele,
          statusElement: statusElement?.(fight) ?? 'Neutral',
          ranged: false, crit, skillDamage: 0, normal: true,
        }, fight.rng),
      });
    },
  };
}

/**
 * Swing timer on (`weaveMs`), the next swing not due and no skill wanted:
 * stand until the swing or a skill comes off cooldown, whichever is first.
 */
export const swingWait: Action = {
  id: 'Wait for swing',
  isSkill: false,
  offensive: false,
  idle: true,
  ready: (fight) => weaveMs(fight) !== null && readyAt(fight, 'Attack') > fight.t,
  castMs: () => 0,
  delayMs: (fight) => {
    let next = readyAt(fight, 'Attack');
    for (const a of fight.kit.actions) {
      if (!a.offensive || a.reactive) continue;
      const at = readyAt(fight, a.id);
      if (at > fight.t) next = Math.min(next, at);
    }
    return Math.max(10, next - fight.t);
  },
  cooldownMs: () => 0,
  spCost: () => 0,
  resolve() {},
};

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
  // formulas.healAmount: RTM's Lv1 Heal read as Lv10 (the owner's reading).
  const amount = (fight: Fight) => healAmount(fight.f, lv(fight.f, 'Heal'));
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
  // Not for a cast that lands after Hiding runs out: holding then only wastes
  // the time to dodge it some other way (Magma Knight's 2.5 s Vampire Gift, 2026-10-01).
  ready: (fight) => has(fight, 'hidden') && followUpComing(fight)
    && !(fight.mob.cast && fight.mob.cast.endsAt > fight.me.buffs.hidden.until),
  castMs: () => 0,
  delayMs: (fight) => Math.max(50, Math.min(200, fight.me.buffs.hidden.until - fight.t)),
  cooldownMs: () => 0,
  spCost: () => 0,
  resolve() {},
};

// ---- walking ------------------------------------------------------------------

/**
 * Fight option mobility: 'tas' (the default) steps out of anything in a
 * fixed TUNE.walkOutMs and reacts in TUNE.reactionMs. 'server' walks whole
 * cells at the server's speed and reacts like a player -- the lair maps are
 * too tight for the TAS's dodging (the project owner, 2026-09-28).
 */
export const serverMobility = (fight: Fight) => fight.options.mobility === 'server';
/**
 * Option kite (with mobility 'server'): the player knows the monster and
 * keeps moving while its dangerous casts are due, so a cast bar costs no
 * reaction before the walk -- the project owner at Rachel SS (2026-09-28):
 * "Storm Gust slightly behind me, most of the time I make it out".
 */
export const reactionMs = (fight: Fight) => (!serverMobility(fight) ? TUNE.reactionMs
  : fight.options.kite === true ? TUNE.kiteReactionMs : TUNE.playerReactionMs);
export const cellMs = (fight: Fight) => walkCellMs(fight.f);
/** Time to step out of `s` (one way): TUNE.walkOutMs for the TAS, whole cells with mobility 'server'. */
export const escapeMs = (fight: Fight, s?: MobSkill) => escapeMsFor(fight.options, fight.f, s);

/**
 * The walk back in after `awayMs` out: nothing when a gap closer the kit
 * names (Rook's Smash, Shadow Slash) is learned and off cooldown by then --
 * it is the next action and puts you on the target (the project owner,
 * 2026-09-28). The TAS always pays `walkMs`.
 */
export function returnMs(fight: Fight, awayMs: number, walkMs: number): number {
  if (!serverMobility(fight)) return walkMs;
  const back = fight.t + awayMs;
  const closer = (fight.kit.gapClosers ?? []).some((id) => lv(fight.f, id) > 0 && readyAt(fight, id) <= back);
  return closer ? 0 : walkMs;
}

/**
 * Out until the cast lands. A lingering area is then left where it fell --
 * the monster follows you out of it (engine.ts Channel.leftBehind) -- so
 * there is no waiting for it to end.
 */
export function awayFor(fight: Fight, stepMs = escapeMs(fight, fight.mob.cast?.skill)): number {
  const c = fight.mob.cast;
  const end = c ? c.endsAt : fight.t;
  return Math.max(stepMs, end - fight.t + 50);
}

export const walkOut: Action = {
  id: 'Walk out',
  isSkill: false,
  offensive: false,
  reactive: true,
  ready: (fight) => !has(fight, 'rooted'),
  castMs: () => 0,
  // Out, wait for the area to finish, back in.
  delayMs: (fight) => awayFor(fight) + returnMs(fight, awayFor(fight), escapeMs(fight, fight.mob.cast?.skill)),
  cooldownMs: () => 0,
  spCost: () => 0,
  resolve(fight) { grant(fight, 'away', awayFor(fight)); },
};

/**
 * Back Slide (from gear: Surt Shoes, Celestial Tome, Slider Armguard...):
 * 5 cells back at once, no cast (server TF_BACKSLIDING, knockback 5, 3 s
 * cooldown). Out of a ground spell aimed at your cell when its escape is 5
 * cells or fewer -- the project owner (2026-09-28): "pretty good mobility
 * for dodging". Then back in like any walk out.
 */
export const BACK_SLIDE_CELLS = 5;
export const backSlideWorks = (fight: Fight, s: MobSkill) => !!fight.f.backSlideMs
  && s.targets === 'aoe' && s.avoid.includes('walk') && escapeCells(s) <= BACK_SLIDE_CELLS
  && readyAt(fight, 'Back Slide') <= fight.t + s.castMs - 100 && !has(fight, 'rooted') && !disabled(fight);
export const backSlide: Action = {
  id: 'Back Slide',
  isSkill: true,
  offensive: false,
  reactive: true,
  ready: (fight) => !!fight.f.backSlideMs && !has(fight, 'rooted'),
  castMs: () => 0,
  delayMs: (fight) => awayFor(fight, 100) + returnMs(fight, awayFor(fight, 100), escapeMs(fight, fight.mob.cast?.skill)),
  cooldownMs: (fight) => fight.f.backSlideMs ?? 3000,
  spCost: () => 7,
  resolve(fight) { grant(fight, 'away', awayFor(fight, 100)); },
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
  delayMs: (fight) => (serverMobility(fight) ? Math.round(TUNE.wardCells * cellMs(fight)) : TUNE.walkOutMs),
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
export const losMs = (fight: Fight) => (serverMobility(fight) ? Math.round(TUNE.losCells * cellMs(fight)) : TUNE.walkOutMs);
export const breakSight: Action = {
  id: 'Break line of sight',
  isSkill: false,
  offensive: false,
  reactive: true,
  ready: (fight) => !has(fight, 'rooted'),
  castMs: () => 0,
  delayMs: (fight) => awayFor(fight, losMs(fight)) + returnMs(fight, awayFor(fight, losMs(fight)), losMs(fight)),
  cooldownMs: () => 0,
  spCost: () => 0,
  resolve(fight) { grant(fight, 'outOfSight', awayFor(fight, losMs(fight))); },
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
/**
 * Option reserveHiding: keep Hiding for the hit that kills. A cast you would
 * live through is tanked (or walked / line-of-sighted) when the same monster
 * has a one-shot Hiding answers that could land before Hiding is back off
 * its cooldown -- Soul of Ymir's Chain Lightning (~2k a bounce) against its
 * Dragon Breath (~35k): the project owner expects to take "Ymir's chain
 * lightning occasionally" in a long fight (2026-09-28).
 */
export function hidingReserved(fight: Fight, s: MobSkill, from: Monster): boolean {
  if (fight.options.reserveHiding !== true) return false;
  const here = assessThreat(fight, s, from);
  if (here.dmg >= 0.9 * fight.me.hp || here.badStatus) return false;
  const st = from === fight.m ? fight.mob : fight.mob.adds.find((a) => a.m === from)?.st;
  if (!st) return false;
  const backAt = here.endsAt + actionById(fight, 'Hiding').cooldownMs(fight);
  const hpAfter = fight.me.hp - here.dmg;
  const sure = new Rng(0, true);
  return from.skills.some((k) => {
    if (k === s || k.type === 'none' || k.type === 'status' || k.targets === 'self') return false;
    if (!(k.hiddenImmune || (k.avoid.includes('hide') && hidingStops(from, k)))) return false;
    if (mobDamage(from, fight.f, k, sure) * Math.max(1, k.ticks) < hpAfter) return false;
    const last = st.cds[k.skill];
    const ready = last === undefined ? fight.t : last + k.ai.delayMs;
    return Math.max(ready, fight.t) + k.castMs < backAt;
  });
}

export function assessThreat(fight: Fight, s: MobSkill, from: Monster): Threat {
  const endsAt = fight.t + s.castMs;
  const lead = endsAt - fight.t - reactionMs(fight);
  // A lingering area you can step off between waves costs one wave, not all
  // of them (engine.ts stepOffArea), with mobility 'server'.
  const steppedOff = serverMobility(fight) && s.targets === 'aoe' && s.avoid.includes('walk') && s.ticks > 1
    && s.tickMs >= escapeMs(fight, s) + reactionMs(fight);
  const waves = steppedOff ? 1 : Math.max(1, s.ticks);
  const dmg = s.type === 'status' || s.type === 'none' ? 0 : mobDamage(from, fight.f, s, new Rng(0, true)) * waves;
  // Worth dodging only if it can land on you: stats and gear resist it
  // (100% resistance = immune), Undead armour is immune to stone and freeze.
  const badStatus = s.statuses.some((e) => {
    if (!BAD_STATUS.has(e.sc) || e.chance <= 0) return false;
    if ((e.sc === 'stone' || e.sc === 'freeze') && fight.f.element === 'Undead') return false;
    return statusResist(fight.f, e.sc, e.resist, e.chance, from.level, from.luk).chance > 0;
  });
  // A status-only skill is worth a dodge only if it carries a bad status:
  // Wide Web's root is taken (the project owner doesn't hide from it).
  // Option tankShare (a fraction of Max HP): take what costs less than that
  // and would not nearly kill you -- dodge less, tank more (the project
  // owner, 2026-09-28). Unset: dodge anything over a quarter of current HP.
  const share = typeof fight.options.tankShare === 'number' ? fight.options.tankShare : null;
  const big = share === null ? dmg >= 0.25 * fight.me.hp : dmg >= share * fight.f.maxHp || dmg >= 0.5 * fight.me.hp;
  // Dodged whatever it would do: the playbook's "always" (data/playbook.json).
  const always = !!playEntry(fight, s, from)?.always;
  const heavy = s.type !== 'none' && s.targets !== 'self' && (big || badStatus || always);
  return {
    endsAt, lead, dmg, badStatus, heavy,
    hideWorks: !!s.hiddenImmune || (s.avoid.includes('hide') && hidingStops(from, s)),
    hideReady: readyAt(fight, 'Hiding') <= endsAt - 50 && lv(fight.f, 'Hiding') > 0 && !has(fight, 'revealed'),
    hideCovers: s.durationMs <= 1800,
    canWalk: s.avoid.includes('walk') && !has(fight, 'rooted') && lead >= escapeMs(fight, s),
    canLos: s.avoid.includes('los') && !has(fight, 'rooted') && lead >= losMs(fight),
  };
}
