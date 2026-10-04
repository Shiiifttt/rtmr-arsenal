/**
 * Satsujin: the Moon build (dagger + shield, AGI).
 *
 * Every damage ratio, cast time, cooldown and extra cost below is read from
 * the skill's tooltip in data/raw/db-skills.json (see skilltext.ts). What is
 * written here is only what the tooltips leave to prose: which line is the
 * hit, what a state does, and the rotation.
 *
 * From the project owner (2026-09-26):
 *   - Before the pull: Moonlight Stance, Seven Winds for the right element,
 *     and two casts of a Thief bolt (Wind Blade) for 10 Focus stacks.
 *     Focus lasts 60s and is not consumed by the Moon skills.
 *   - Core combo: New Moon -> Full Moon -> Million Stab; while Combo Ready
 *     is up, weave Thousand Arms, Dragon Omamori -> Omamori Jutsu -> Full
 *     Moon (Jutsu's invisibility enables Full Moon). Auto-attack between.
 *   - Opener: Shadow Slash.
 *   - Defence: Kawarimi for physical hits flee can't cover, Hiding for the
 *     dangerous casts, walking out of areas. New Moon / Jutsu invisibility
 *     halves damage, but a hit ends it and with it the Full Moon.
 *
 * Assumptions not yet confirmed (listed in the README's open questions):
 *   - Multi-hit ratios are per hit (rAthena's rule), so Million Stab's
 *     "20 +5%/lv +1%/AGI" lands 10 times.
 *   - Dragon Omamori's "Combo Ready adds +5% per STR" counts at detonation.
 *   - Omamori Jutsu's invisibility lasts 5s, like New Moon's.
 *   - Million Stab is melee despite its 7-cell reach (the planner's Moon
 *     preset scores it on melee%); Dragon Omamori (7-11 cells) is ranged.
 */
import { attrFix, castTimeMs, magicDamage, mobDamage, mobHitChance, perfectDodgeChance, physicalDamage, statusAtk, TUNE, type DotName } from '../formulas.ts';
import { Rng } from '../rng.ts';
import type { Fighter, MobSkill, Monster } from '../model.ts';
import { playbookPlan } from '../playbook.ts';
import { ratioAt } from '../skilltext.ts';
import type { Passives } from '../character.ts';
import {
  canUse, dot, dotOnMob, enterManhole, LOTUS_BLOCK, NORMAL, focusStacks, followUpComing, grant, has, heal_, MANHOLE_MS, mobHas, readMarks, readyAt, say, stacks, strike, strikeAdds,
  targetNow,
  type Action, type Fight, type Kit,
} from '../engine.ts';
import {
  assessThreat, attackAction, backSlide, backSlideWorks, breakSight, escapeMs, hidingAction, hidingReserved, lv, morrocsMark, optionOn, pullOffWard, reactionMs,
  returnMs, stayHidden, swingWait, toolkit, walkOut,
} from './common.ts';
import {
  autoDefense, COMMON_TOOLS, heldForSnap, isPreempt, predictActions, priorityWith, reactWith, snapThreatDue, stayReadyAction, type DefenseTool,
} from './defense.ts';

const TREE = ['Satsujin', 'Shinobi', 'Assassin', 'Thief', 'Orphan'];

/** Gear writes some skills by other names. */
export const ALIASES: Record<string, string[]> = {
  'New Moon': ['New Moon Blades', 'New Moon Kick'],
  'Full Moon': ['Full Moon Blades', 'Full Moon Kick'],
};

const SKILLS = [
  'Shadow Slash', 'New Moon', 'Full Moon', 'Million Stab', 'Thousand Arms', 'Dragon Omamori',
  'Omamori Jutsu', 'Back Stab', 'Wind Blade', 'Kawarimi', 'Hiding', 'Moonlight Stance',
  'Seven Winds', 'Lotus Pact', "Morroc's Mark", 'Hallucination Walk', 'Magic Pierce', 'Advanced Blade Mastery', 'Blade Mastery',
  'Improve Dodge', 'Shadow Mastery', 'Improve Defense', 'Improve Wisdom', 'Increase SP Recovery',
  'Fan of Knives',
];

/**
 * Where the crawl's max level is wrong. Dragon Omamori was held at 5 here
 * (its SP and range tables stop at 5); the project owner reads its max as
 * 10 in game (2026-09-28), which the crawl says too.
 */
const MAX_LEVEL_FIX: Record<string, number> = {};

export function maxLevels(): Record<string, number> {
  return Object.fromEntries(SKILLS.map((n) => [n, MAX_LEVEL_FIX[n] ?? sk(n).row.max]));
}

export function passives(
  levels: Record<string, number>, weaponType: string | null, baseLevel: number,
): Passives {
  const L = (n: string) => levels[n] ?? 0;
  const daggerOrSword = weaponType === 'Dagger' || weaponType === 'One-Handed Sword';
  return {
    // Advanced Blade Mastery 3 ATK/lv, Blade Mastery 3 ATK/lv: daggers and swords.
    masteryAtk: daggerOrSword ? 3 * L('Advanced Blade Mastery') + 3 * L('Blade Mastery') : 0,
    hit: daggerOrSword ? 5 * L('Advanced Blade Mastery') : 0,
    // Improve Dodge 4/lv, Shadow Mastery 3/lv.
    flee: 4 * L('Improve Dodge') + 3 * L('Shadow Mastery'),
    // Improve Defense: 1 HP per level per base level. Improve Wisdom: 2 SP per level per 3.
    hpFlat: L('Improve Defense') * baseLevel,
    spFlat: Math.floor((L('Improve Wisdom') * 2 * baseLevel) / 3),
    hpPercent: 2 * L('Moonlight Stance'),
    // Increase SP Recovery: "2 SP + 0.1% max SP regen per level".
    spRegen: { flat: 2 * L('Increase SP Recovery'), maxShare: 0.001 * L('Increase SP Recovery') },
    // Magic Pierce (Assassin, AB_EXPIATIO) "Defense Penetration is 1 per level", self-cast
    // before the pull (the project owner, 2026-10-02), as on the Night Raven and Kingslayer.
    defPen: L('Magic Pierce'),
    notes: [
      'passives: Blade Masteries (ATK/HIT), Improve Dodge + Shadow Mastery (flee), '
        + 'Improve Defense/Wisdom (HP/SP), Moonlight Stance (Max HP), Magic Pierce (DEF pen, up before the pull)',
    ],
  };
}

// ---- the element -------------------------------------------------------------

const SEVEN_WINDS = ['Earth', 'Wind', 'Water', 'Fire', 'Ghost', 'Dark', 'Holy'];
const BOLTS: Record<string, string> = { Fire: 'Flaming Petals', Water: 'Freezing Spear', Wind: 'Wind Blade' };

/** The Seven Winds element that hits this monster hardest (ties: the lower level). */
export function bestElement(fight: Pick<Fight, 'm'>): string {
  let best = SEVEN_WINDS[0]; let v = -1;
  for (const e of SEVEN_WINDS) {
    const x = attrFix(e, fight.m.element, fight.m.elementLevel);
    if (x > v) { v = x; best = e; }
  }
  return best;
}

const element = (fight: Fight) => (fight.me.buffs.sevenWinds ? SEVEN_WINDS[fight.me.buffs.sevenWinds.stacks] : fight.f.weapon?.element ?? 'Neutral');

// ---- shared pieces ---------------------------------------------------------

const T = toolkit(TREE, element);
const { cast, cooldown, spCost, hpCost, learned } = T;
const sk = (name: string) => T.sk(name);
// Seven Winds carries its element into status ATK (rAthena SC_SEVENWIND).
const statusElement = (fight: Fight) => (fight.me.buffs.sevenWinds ? element(fight) : 'Neutral');

/** A physical skill hit, with this skill's gear bonus. Skills read the right hand only (formulas.ts). */
function physical(fight: Fight, name: string, ratio: number, o: { ranged?: boolean; ignoreDef?: boolean } = {}) {
  return T.physical(fight, name, ratio, { ...o, statusElement: statusElement(fight) });
}

function ratioOf(fight: Fight, name: string, formula = 'damage', extra = 0): number {
  const s = sk(name); const l = lv(fight.f, name);
  const r = s.text.formulas[formula];
  if (!r) throw new Error(`${name}: no "${formula}" line in its tooltip`);
  const focus = focusStacks(fight);
  let v = ratioAt(r, l, fight.f.stats) + extra;
  const f = s.text.when.focus;
  if (f) v += ratioAt(f, l, fight.f.stats, focus) - ratioAt(f, l, fight.f.stats, 0);
  if (has(fight, 'combo')) {
    const c = s.text.when['combo ready'];
    if (c) v += ratioAt(c, l, fight.f.stats);
  }
  return v;
}

/**
 * Moonless Gem of Darkness: "New Moon Blades applies Bleeding / Full Moon
 * Blades applies Poison / Dragon Omamori applies Burning". Every hit that
 * lands applies it, bosses and the boss protocol included (the project
 * owner, 2026-09-28; codex: "Now applies to bosses"). Option gemDots false
 * turns it off.
 */
const GEM_DOTS: [string, DotName][] = [['New Moon', 'bleeding'], ['Full Moon', 'poison'], ['Dragon Omamori', 'burning']];
const gemDotCache = new WeakMap<object, Record<string, DotName>>();
function gemDots(fight: Fight): Record<string, DotName> {
  let v = gemDotCache.get(fight.f);
  if (!v) {
    v = {};
    for (const [skill, dot] of GEM_DOTS) {
      const words = [skill, ...(ALIASES[skill] ?? [])].map((w) => w.replace(/\s+/g, '\\s+'));
      if (new RegExp(`(${words.join('|')})\\s+applies\\s+${dot}`, 'i').test(fight.f.gearText ?? '')) v[skill] = dot;
    }
    gemDotCache.set(fight.f, v);
  }
  return fight.options.gemDots === false ? {} : v;
}

/** After `skill` lands (damage > 0), its gem status. */
function applyGemDot(fight: Fight, skill: string, dealt: number) {
  const dot = gemDots(fight)[skill];
  if (dot && dealt > 0) dotOnMob(fight, dot);
}

// ---- actions ---------------------------------------------------------------

const attack = attackAction(T, statusElement);

const shadowSlash: Action = {
  id: 'Shadow Slash',
  isSkill: true,
  offensive: true,
  ready: learned('Shadow Slash'),
  castMs: cast('Shadow Slash'),
  cooldownMs: cooldown('Shadow Slash'),
  spCost: spCost('Shadow Slash'),
  resolve(fight) {
    const l = lv(fight.f, 'Shadow Slash');
    // Fake multi-hit: one roll shown as 3 identical pieces (the project
    // owner's dummy test, 2026-09-26: 1,195 x3, crits 1,545 x3).
    strike(fight, 'Shadow Slash', {
      hits: sk('Shadow Slash').row.hits || 3, split: true, canMiss: true,
      // "Bonus Crit Rate is 5+ 5 per level" -- prose the parser leaves alone.
      critBonus: 5 + 5 * l,
      // "Damage increases by 5% per Improve Dodge level while under
      // Hallucination Walk": added to the ratio, like every tooltip bonus.
      damage: physical(fight, 'Shadow Slash', ratioOf(fight, 'Shadow Slash')
        + (has(fight, 'hallucination') ? 5 * lv(fight.f, 'Improve Dodge') : 0)),
    });
  },
};

const INVIS_MS = 5000;

const newMoon: Action = {
  id: 'New Moon',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('New Moon')(fight) && has(fight, 'stance') && !has(fight, 'invisible'),
  castMs: cast('New Moon'),
  cooldownMs: cooldown('New Moon'),
  spCost: spCost('New Moon'),
  resolve(fight) {
    const dealt = strike(fight, 'New Moon', {
      hits: 1, canMiss: true, critBonus: null,
      damage: physical(fight, 'New Moon', ratioOf(fight, 'New Moon')),
    });
    applyGemDot(fight, 'New Moon', dealt);
    grant(fight, 'invisible', INVIS_MS);
    // A new cycle: count its Full Moons (option seedTalisman).
    grant(fight, 'fullMoons', 1e12, 0);
  },
};

const fullMoon: Action = {
  id: 'Full Moon',
  isSkill: true,
  offensive: true,
  // Option moonGuard: New Moon's invisibility halves the next hit you take
  // (RTM battle.cpp:1567, and the hit ends it: status.cpp:2351). With an
  // instant killer due (Critical Slash), hold it rather than spend it.
  ready: (fight) => learned('Full Moon')(fight) && has(fight, 'invisible') && !has(fight, 'guarding'),
  castMs: cast('Full Moon'),
  cooldownMs: cooldown('Full Moon'),
  spCost: spCost('Full Moon'),
  resolve(fight) {
    const dealt = strike(fight, 'Full Moon', {
      hits: 1, canMiss: true, critBonus: null,
      damage: physical(fight, 'Full Moon', ratioOf(fight, 'Full Moon')),
    });
    applyGemDot(fight, 'Full Moon', dealt);
    grant(fight, 'combo', sk('Full Moon').text.grants['combo ready'] ?? 5000);
    grant(fight, 'fullMoons', 1e12, stacks(fight, 'fullMoons') + 1);
  },
};

const millionStab: Action = {
  id: 'Million Stab',
  isSkill: true,
  offensive: true,
  ready: learned('Million Stab'),
  castMs: cast('Million Stab'),
  cooldownMs: cooldown('Million Stab'),
  spCost: spCost('Million Stab'),
  resolve(fight) {
    strike(fight, 'Million Stab', {
      hits: sk('Million Stab').row.hits || 10, canMiss: true, critBonus: null,
      damage: physical(fight, 'Million Stab', ratioOf(fight, 'Million Stab')),
    });
  },
};

const thousandArms: Action = {
  id: 'Thousand Arms',
  isSkill: true,
  offensive: true,
  ready: learned('Thousand Arms'),
  castMs: cast('Thousand Arms'),
  cooldownMs: cooldown('Thousand Arms'),
  spCost: spCost('Thousand Arms'),
  hpCost: hpCost('Thousand Arms'),
  resolve(fight) {
    // Fake multi-hit (the project owner, 2026-09-26): the ratio once, shown as 6.
    strike(fight, 'Thousand Arms', {
      hits: sk('Thousand Arms').row.hits || 6, split: true, canMiss: true, critBonus: null,
      damage: physical(fight, 'Thousand Arms', ratioOf(fight, 'Thousand Arms')),
    });
  },
};

const TALISMAN_MS = 50_000;

const dragonOmamori: Action = {
  id: 'Dragon Omamori',
  isSkill: true,
  offensive: true,
  interruptible: true,
  // One talisman per target. With seedTalisman off, only as the cycle's
  // middle step (DO -> Jutsu -> Full Moon), never after its second Full
  // Moon to seed the next cycle's Jutsu.
  ready: (fight) => learned('Dragon Omamori')(fight) && !mobHas(fight, 'talisman')
    && (optionOn(fight, 'seedTalisman') || stacks(fight, 'fullMoons') < 2),
  castMs: cast('Dragon Omamori'),
  cooldownMs: cooldown('Dragon Omamori'),
  spCost: spCost('Dragon Omamori'),
  resolve(fight) {
    // Combo Ready's +5%/STR counts on the apply hit too, not only the
    // explosion (the project owner, 2026-09-28; the 09-26 apply reading of
    // 9,830 under Combo Ready is ~10x the bare ratio).
    const apply = ratioOf(fight, 'Dragon Omamori', 'apply damage');
    const dealt = strike(fight, 'Dragon Omamori', {
      hits: 1, canMiss: true, critBonus: null, kind: 'ranged',
      damage: physical(fight, 'Dragon Omamori', apply, { ranged: true }),
    });
    applyGemDot(fight, 'Dragon Omamori', dealt);
    fight.mob.debuffs.talisman = { until: fight.t + TALISMAN_MS, stacks: 1 };
  },
};

const omamoriJutsu: Action = {
  id: 'Omamori Jutsu',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Omamori Jutsu')(fight) && mobHas(fight, 'talisman'),
  castMs: cast('Omamori Jutsu'),
  cooldownMs: cooldown('Omamori Jutsu'),
  spCost: spCost('Omamori Jutsu'),
  resolve(fight) {
    delete fight.mob.debuffs.talisman;
    // The explosion is Dragon Omamori's: its formula, its level, its gear bonus.
    const ratio = ratioOf(fight, 'Dragon Omamori', 'explosion');
    strike(fight, 'Omamori Explosion', {
      // "Unavoidable delayed damage" (Satsujin Soul).
      hits: 1, canMiss: false, critBonus: null, kind: 'ranged',
      damage: physical(fight, 'Dragon Omamori', ratio, { ranged: true }),
    });
    grant(fight, 'invisible', INVIS_MS);
  },
};

const backStab: Action = {
  id: 'Back Stab',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Back Stab')(fight) && fight.f.weapon?.type === 'Dagger'
    && optionOn(fight, 'backStab'),
  castMs: cast('Back Stab'),
  cooldownMs: cooldown('Back Stab'),
  spCost: spCost('Back Stab'),
  resolve(fight) {
    const l = lv(fight.f, 'Back Stab');
    const r = sk('Back Stab').text.formulas.damage;
    // Single-wielding a dagger: per-level and AGI parts tripled, +5% per
    // Improve Dodge level. Dual wielding it is the plain tooltip ratio.
    const single = !fight.f.offhand;
    const k = single ? 3 : 1;
    const ratio = r.base + k * r.perLevel * l + k * (r.perStat.agi ?? 0) * fight.f.stats.agi
      + (single ? 5 * lv(fight.f, 'Improve Dodge') : 0);
    // Fake multi-hit: the owner reads 2 x 2,530, which is the ratio once, split.
    strike(fight, 'Back Stab', {
      hits: sk('Back Stab').row.hits || 1, split: true, canMiss: true, critBonus: null,
      damage: physical(fight, 'Back Stab', ratio),
    });
  },
};

/** The lowest level that still grants 5 Focus: level 7 ("Lv7-10: 5"). */
const BOLT_LEVEL = 7;

const refocus: Action = {
  id: 'Refocus',
  isSkill: true,
  offensive: true,
  interruptible: false, // "Spell cast can't be interrupted"
  ready: (fight) => optionOn(fight, 'refocus') && focusStacks(fight) <= 5,
  castMs: (fight) => {
    const t = sk(boltFor(fight)).text;
    return castTimeMs(t.variableCast(BOLT_LEVEL), t.fixedCast(BOLT_LEVEL), fight.f);
  },
  cooldownMs: (fight) => sk(boltFor(fight)).text.cooldown(BOLT_LEVEL),
  spCost: (fight) => sk(boltFor(fight)).row.sp[BOLT_LEVEL - 1] ?? 40,
  resolve(fight) {
    const bolt = boltFor(fight);
    const ele = sk(bolt).row.element ?? 'Wind';
    const focus = focusStacks(fight);
    strike(fight, 'Refocus', {
      hits: BOLT_LEVEL, canMiss: false, critBonus: null, kind: 'magic',
      damage: () => magicDamage(fight.f, fight.m, {
        ratio: 50, element: ele, skillDamage: 0, bonus: 7 * focus,
      }, fight.rng),
    });
    addFocus(fight, 5);
  },
};

function addFocus(fight: Fight, n: number) {
  focusStacks(fight); // drops expired stacks (and replaces the array)
  const f = fight.me.focus;
  for (let i = 0; i < n; i++) {
    if (f.length >= 10) { f.sort((a, b) => a - b); f.shift(); }
    f.push(fight.t + 60_000);
  }
}

const boltFor = (fight: Fight) => BOLTS[element(fight)] ?? 'Wind Blade';

// ---- defence -----------------------------------------------------------------

const hiding = hidingAction(T);

/** Kawarimi: "[Lv 5]: Lasts 4 seconds, 3 Dodges" -- read from the tooltip's table. */
function kawarimiAt(l: number): { ms: number; dodges: number } {
  const m = new RegExp(String.raw`\[Lv ${l}\]: Lasts (\d+(?:[.,]\d+)?) seconds, (\d+) Dodge`).exec(sk('Kawarimi').row.desc);
  return m ? { ms: Number(m[1].replace(',', '.')) * 1000, dodges: Number(m[2]) } : { ms: 2000, dodges: 1 };
}

const kawarimi: Action = {
  id: 'Kawarimi',
  isSkill: true,
  offensive: false,
  // Only against something that swings: otherwise the lookahead reads its
  // short pause as cooldown timing and pays 125 SP for nothing.
  ready: (fight) => learned('Kawarimi')(fight) && !has(fight, 'kawarimi')
    && Number.isFinite(fight.m.adelay),
  castMs: () => 0,
  cooldownMs: cooldown('Kawarimi'),
  spCost: spCost('Kawarimi'),
  resolve(fight) {
    const k = kawarimiAt(lv(fight.f, 'Kawarimi'));
    grant(fight, 'kawarimi', k.ms, k.dodges);
  },
};

/**
 * An instant hit that would nearly kill (Burning Fury's Critical Slash:
 * no cast bar, always crits, ~6.4k) is predicted, not reacted to: the
 * project owner Kawarimis it "mostly by predicting it" (2026-09-28). Due is
 * the monster's reuse delay run out (its first: at the pull), for a row it
 * fires at once when it can (AI rate >= 0.5), however overdue.
 * Option predict false turns it off.
 */
function instantKillerDue(fight: Fight, within: number): boolean {
  if (fight.options.predict === false) return false;
  const all = [{ m: fight.m, st: fight.mob }, ...fight.mob.adds.map((a) => ({ m: a.m, st: a.st }))];
  const at = fight.t + within;
  const offDelay = (st: typeof fight.mob, s: MobSkill) => (st.cds[s.skill] ?? -Infinity) + s.ai.delayMs <= at;
  return all.some(({ m, st }) => m.skills.some((s, i) => {
    if (s.castMs > 0 || s.type !== 'physical' || s.targets !== 'single' || s.ai.rate < 0.5) return false;
    const due = (st.cds[s.skill] ?? -Infinity) + s.ai.delayMs;
    // No overdue cutoff: other rows often take its turns (Fire Wall before
    // Critical Slash), so an overdue killer is still coming.
    if (at < due) return false;
    // The server tries the rows in order on each attack turn and the first
    // that fires wins: a likely row ahead of it, off its delay, usually
    // takes the turn (Burning Fury's Fire Wall, 85%, before Critical Slash).
    // Option predictStrict: wait for a turn nothing ahead of it can take.
    const ahead = fight.options.predictStrict === true && m.skills.slice(0, i).some((p) => p.ai.rate >= 0.5
      && p.ai.cond === 'always' && (p.ai.state === 'attack' || p.ai.state === 'any') && offDelay(st, p));
    if (ahead) return false;
    return assessThreat(fight, { ...s, castMs: 0 }, m).dmg >= 0.5 * fight.me.hp;
  }));
}

/** The monster (or an add) has an instant hit that would nearly kill: Kawarimi is saved for it. */
function hasInstantKiller(fight: Fight): boolean {
  if (fight.options.predict === false) return false;
  const all = [{ m: fight.m }, ...fight.mob.adds.map((a) => ({ m: a.m }))];
  return all.some(({ m }) => m.skills.some((s) => s.castMs <= 0 && s.type === 'physical' && s.targets === 'single'
    && s.ai.rate >= 0.5 && assessThreat(fight, { ...s, castMs: 0 }, m).dmg >= 0.5 * fight.f.maxHp));
}

const predictKawarimi: Action = {
  ...kawarimi,
  id: 'Predict Kawarimi',
  // Just before its next attack turn, where the skill is rolled (75% a turn
  // for Critical Slash): 3 dodges over 4 s then cover two or three turns.
  // With option defense 'auto' the shared prediction (defense.ts) does this.
  ready: (fight) => !autoDefense(fight) && (kawarimi.ready?.(fight) ?? true) && readyAt(fight, 'Kawarimi') <= fight.t
    && fight.mob.nextAttackAt - fight.t <= 300 && !fight.mob.cast && instantKillerDue(fight, 300),
  resolve(fight) {
    kawarimi.resolve(fight);
    fight.me.cds.Kawarimi = fight.t + cooldown('Kawarimi')(fight);
  },
  cooldownMs: () => 0,
};

/**
 * Option moonGuard: an instant killer due and Kawarimi down or used -- New
 * Moon now, and Full Moon held (fullMoon.ready), so the killer lands at half.
 */
const castStamp = (fight: Fight) => Object.values(fight.mob.cds).reduce((a, b) => a + b, 0);
const moonGuard: Action = {
  ...newMoon,
  id: 'Moon guard',
  // Once per expected killer: the stamp is the monster's last-cast times, so
  // a new guard waits for the killer (or anything) to be cast in between.
  ready: (fight) => fight.options.moonGuard === true && (newMoon.ready?.(fight) ?? true)
    && stacks(fight, 'kawarimi') <= 0 && readyAt(fight, 'Kawarimi') > fight.t + 300 && instantKillerDue(fight, 500)
    && fight.me.buffs.guardStamp?.value !== castStamp(fight),
  resolve(fight) {
    newMoon.resolve(fight);
    fight.me.cds['New Moon'] = fight.t + cooldown('New Moon')(fight);
    // Full Moon held 3 s at most, then the fight goes on.
    grant(fight, 'guarding', 3000);
    fight.me.buffs.guardStamp = { until: 1e12, stacks: 1, value: castStamp(fight) };
  },
  cooldownMs: () => 0,
};

/**
 * A tell: a cast the monster always follows with a heavy area (Converted
 * Zealot's Back Stab -> Cloud Kill). With option kite, walk out on the tell
 * and stay out through the follow-up -- "when I see Back Stab I walk out of
 * its cast range, and keep walking" (the project owner, 2026-09-28).
 */
function heavyFollowUp(fight: Fight, s: MobSkill, from: Monster): MobSkill | null {
  if (fight.options.kite !== true) return null;
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

/**
 * Shadow Slash out of a ground spell: the monster aims it where you stand
 * as its cast starts; Shadow Slash's long reach puts you on the monster,
 * away from where it lands (the project owner, 2026-09-28, Godly Seeker's
 * Storm Gust). With option kite, for an area aimed at you, not centred on
 * the caster, and Shadow Slash off cooldown.
 */
function slashOutWorks(fight: Fight, s: MobSkill): boolean {
  return fight.options.kite === true && s.targets === 'aoe' && !s.centeredOnSelf && s.avoid.includes('walk')
    && learned('Shadow Slash')(fight) && readyAt(fight, 'Shadow Slash') <= fight.t + s.castMs - 100
    && !has(fight, 'rooted');
}
const slashOut: Action = {
  ...shadowSlash,
  id: 'Shadow Slash out',
  reactive: true,
  resolve(fight) {
    shadowSlash.resolve(fight);
    fight.me.cds['Shadow Slash'] = fight.t + cooldown('Shadow Slash')(fight);
    const c = fight.mob.cast;
    // Off the spot it is aimed at: it lands behind you, however you fight on.
    grant(fight, 'slashedOut', Math.max(100, (c ? c.endsAt - fight.t : 0) + 100));
    fight.log && say(fight, `slashes onto ${fight.m.name}, out of ${c?.skill.name ?? 'the area'}`);
  },
  cooldownMs: () => 0,
};

/**
 * Lotus Pact (KO_MEIKYOUSISUI): 3 s variable cast, 100 SP, 30 s cooldown (RTM skill_db); then 10 s
 * rooted, 1% Max HP and SP a level each second (status.cpp:15075, ten ticks), and any hit does nothing
 * 40% of the time (LOTUS_BLOCK). The project owner (2026-10-03): it cannot be cancelled, and skills
 * and movement skills still go off while rooted -- so it is a buff to fight in, not a kneel -- used
 * "if the monster doesn't cast any must-walk-out-of abilities" (Rachel's maidens: Vampire Gift).
 * Option lotus: false never in a fight; lotusAt: SP share it goes up below (default 0.5, or HP under half).
 */
export const LOTUS = { castMs: 3000, sp: 100, cooldownMs: 30_000, ms: 10_000 };
/** A skill only walking (or a diagonal, or breaking sight) gets out of: no good rooted. */
const mustWalk = (sk: MobSkill) => sk.avoid.length > 0 && sk.avoid.every((a) => a === 'walk' || a === 'diag' || a === 'los');
/**
 * Safe to tank through Lotus Pact (the project owner, 2026-10-03: "I cast it and tank the monster ...
 * when the monster can't one-shot me and I can sustain via the regen/leech/heal"): no hit it has that
 * cannot be dodged rooted (Kawarimi, Hiding still go) takes the HP you have, and its swings over the
 * cast and the 10 s -- through flee, Perfect Dodge and the 40% block -- leave you above 30% with
 * Lotus Pact's own ticks.
 */
function lotusSafe(fight: Fight): boolean {
  const f = fight.f; const sure = new Rng(0, true);
  const windowS = castTimeMs(LOTUS.castMs, 0, f) / 1000 + LOTUS.ms / 1000;
  const hp = fight.me.hp;
  let swings = 0;
  for (const m of [fight.m, ...fight.mob.adds.map((a) => a.m)]) {
    for (const k of m.skills) {
      if (k.type === 'none' || k.type === 'status' || k.targets === 'self') continue;
      if (k.avoid.includes('kawarimi') || k.avoid.includes('hide')) continue;
      if (mobDamage(m, f, k, sure) * Math.max(1, k.ticks) >= hp) return false;
    }
    const hit = mobDamage(m, f, NORMAL, sure);
    if (hit >= hp) return false;
    const land = mobHitChance(m.hit, f.flee) * (1 - perfectDodgeChance(f.perfectDodge)) * (1 - LOTUS_BLOCK);
    swings += (hit * land * windowS * 1000) / Math.max(100, m.adelay);
  }
  const ticks = (lv(f, 'Lotus Pact') / 100) * f.maxHp * (LOTUS.ms / 1000);
  return hp + ticks - swings >= 0.3 * f.maxHp;
}
const lotusPact: Action = {
  id: 'Lotus Pact',
  isSkill: true,
  offensive: false,
  ready: (fight) => learned('Lotus Pact')(fight) && fight.options.lotus !== false && !fight.mob.cast && fight.me.sp >= LOTUS.sp
    && (fight.me.sp < Number(fight.options.lotusAt ?? 0.5) * fight.f.maxSp || fight.me.hp < 0.5 * fight.f.maxHp)
    && ![fight.m, ...fight.mob.adds.map((a) => a.m)].some((m) => m.skills.some(mustWalk)) && lotusSafe(fight),
  castMs: (fight) => castTimeMs(LOTUS.castMs, 0, fight.f),
  cooldownMs: () => LOTUS.cooldownMs,
  spCost: () => LOTUS.sp,
  resolve(fight) {
    const pct = lv(fight.f, 'Lotus Pact') / 100;
    grant(fight, 'lotus', LOTUS.ms);
    grant(fight, 'rooted', LOTUS.ms);
    dot(fight, 'Lotus Pact (HP)', 1000, LOTUS.ms, pct * fight.f.maxHp, false, true, false, true);
    dot(fight, 'Lotus Pact (SP)', 1000, LOTUS.ms, pct * fight.f.maxSp, false, false, true);
  },
};

/**
 * Between fights: Lotus Pact when it wins the SP and HP back sooner than sitting (the project owner,
 * 2026-10-03: "benchmark how much faster it is to Lotus Pact between fights when necessary vs
 * sitting"). Standing through the cast and the 10 s (natural regen not doubled, heals still go), its
 * ticks on top, then sitting for the rest; its 30 s cooldown lets it go every cycle only when a cycle
 * is that long. Option lotusSit: false sits only.
 */
function recoverFor(f: Fighter, options: Record<string, unknown>, need: { sp: number; hp: number }, regen: { sp: number; hp: number }, sitS: number, cycleS: number): number {
  const l = lv(f, 'Lotus Pact');
  if (!l || options.lotusSit === false || sitS <= 0) return sitS;
  const standSp = f.regen.sp / (TUNE.spRegenMs / 1000) + (f.regen.spSkill ?? 0) / (TUNE.skillRegenMs / 1000);
  const castS = castTimeMs(LOTUS.castMs, 0, f) / 1000;
  let sp = need.sp + LOTUS.sp; let hp = need.hp; let t = 0;
  const step = 0.05; let ticks = 0;
  while ((sp > 0 || hp > 0) && t < sitS) {
    const rooted = t < castS + LOTUS.ms / 1000;
    sp -= (rooted ? standSp : regen.sp) * step; hp -= regen.hp * step;
    t += step;
    // A tick each whole second after the cast, ten in all.
    if (ticks < LOTUS.ms / 1000 && t >= castS + ticks + 1) { ticks++; sp -= (l / 100) * f.maxSp; hp -= (l / 100) * f.maxHp; }
  }
  const lotusS = Math.min(t, sitS);
  const p = Math.min(1, (cycleS + lotusS) / (LOTUS.cooldownMs / 1000));
  return p * lotusS + (1 - p) * sitS;
}

/**
 * Hallucination Walk (Assassin signature): "a duration of 25+5s per level",
 * "Flee bonus is 10 per lv and 5% per level to avoid magic damage", 120s
 * cooldown, a Shadow Orb per cast (assumed carried). Up before the pull;
 * the TAS recasts it when it lapses and the cooldown allows.
 */
function hallucinationAt(l: number) {
  const d = /duration of (\d+)\s*\+\s*(\d+)s per level/i.exec(sk('Hallucination Walk').row.desc);
  const ms = d ? (Number(d[1]) + Number(d[2]) * l) * 1000 : 50_000;
  return { ms, flee: 10 * l, magicDodge: 0.05 * l };
}

function hallucinate(fight: Fight) {
  const h = hallucinationAt(lv(fight.f, 'Hallucination Walk'));
  grant(fight, 'hallucination', h.ms, 1, { flee: h.flee, magicDodge: h.magicDodge });
}

const hallucinationWalk: Action = {
  id: 'Hallucination Walk',
  isSkill: true,
  offensive: false,
  ready: (fight) => learned('Hallucination Walk')(fight) && optionOn(fight, 'hallucinationWalk')
    && !has(fight, 'hallucination'),
  castMs: () => 0,
  cooldownMs: cooldown('Hallucination Walk'),
  spCost: spCost('Hallucination Walk'),
  resolve: hallucinate,
};

/**
 * Fan of Knives (Assassin), for farming packs: option fanOfKnives true, off
 * by default. The server's KO_HAPPOKUNAI (battle.cpp:3607): a 100% weapon
 * hit plus a flat 3 x (status ATK + right weapon ATK) x (level + 1) / 5
 * added before cards; + AGI x Improve Dodge level under Hallucination Walk.
 * Ignores DEF, flee and element; one roll shown as 4 (HitCount -4); a 9x9
 * area at level 5+ (skill_db SplashArea 4). The 2023 code counts status ATK
 * twice; Refuge Test Patch Notes 8 (2026-09-02) stopped that and "adjusted
 * the coefficient" (~20% less on a normal build) -- the coefficient is
 * UNREAD: TUNE-free here, status ATK once, pending a dummy reading.
 */
function fanDamage(fight: Fight, m: Monster) {
  const f = fight.f; const l = lv(f, 'Fan of Knives');
  let flat = (3 * (statusAtk(f.stats, f.level) + (f.weapon?.atk ?? 0)) * (l + 1)) / 5;
  if (has(fight, 'hallucination')) flat += f.stats.agi * lv(f, 'Improve Dodge');
  const skillDamage = f.skillMods('Fan of Knives', 'damage').percent;
  return (crit: boolean) => physicalDamage(f, m, {
    ratio: 100, element: 'Neutral', statusElement: 'Neutral', ranged: false, crit, skillDamage,
    ignoreDef: true, ignoreElement: true, flat,
  }, fight.rng);
}

const fanOfKnives: Action = {
  id: 'Fan of Knives',
  isSkill: true,
  offensive: true,
  // An area: it finds a cloaked monster (the project owner, 2026-10-01).
  findsCloaked: true,
  // Option fanPack (a number): wait until that many are in reach, or all
  // that are still walking in have arrived (tools/farm.ts packs).
  ready: (fight) => {
    if (fight.options.fanOfKnives !== true || !learned('Fan of Knives')(fight)) return false;
    const want = fight.options.fanPack;
    if (typeof want !== 'number') return true;
    const adds = fight.mob.adds;
    const inReach = 1 + adds.filter((a) => (a.reachAt ?? 0) <= fight.t).length;
    const coming = adds.filter((a) => (a.reachAt ?? 0) > fight.t && Number.isFinite(a.reachAt)).length;
    return inReach >= Math.min(want, inReach + coming);
  },
  castMs: cast('Fan of Knives'),
  // AfterCastActDelay 500 (skill_db).
  delayMs: () => 500,
  cooldownMs: cooldown('Fan of Knives'),
  spCost: spCost('Fan of Knives'),
  resolve(fight) {
    strike(fight, 'Fan of Knives', { hits: 4, split: true, canMiss: false, critBonus: null, aoe: true, damage: fanDamage(fight, targetNow(fight)) });
    strikeAdds(fight, 'Fan of Knives', (m) => fanDamage(fight, m)(false));
  },
};

// ---- the rotation ------------------------------------------------------------

/**
 * The rotation's hard rules (the project owner, 2026-09-26). The TAS picks
 * freely among what these allow -- timing, fillers, dodges -- but cannot
 * break them. Left to itself over a few seconds' lookahead it front-loads:
 * a Million Stab now plus one on cooldown later out-scores waiting for
 * Combo Ready, which is the wrong trade over a whole fight.
 *
 *   - Million Stab and Dragon Omamori wait for Combo Ready (from Full Moon):
 *     New Moon -> Full Moon -> Million Stab, and the Dragon Omamori ->
 *     Omamori Jutsu -> Full Moon weave inside the combo.
 *   - Invisible (New Moon or Jutsu), the only move is Full Moon. Any skill
 *     cast -- a buff too -- or a normal swing ends it and loses the Full
 *     Moon. A planned dodge (Hiding) still goes off and pays that price.
 *
 * `strictCombo: false` in a profile's options lifts the first rule.
 */
const NEEDS_COMBO = new Set(['Million Stab', 'Dragon Omamori']);

function withRules(a: Action): Action {
  if (a.reactive || !(a.offensive || a.isSkill)) return a;
  const own = a.ready;
  return {
    ...a,
    ready: (fight) => {
      // Option defense 'auto': a hard snap cast is due -- stay idle, ready to dodge it.
      if (heldForSnap(fight, a, TOOLS)) return false;
      if (has(fight, 'invisible') && a.id !== 'Full Moon') return false;
      // Hidden with the monster's chain still coming: stay in (stayHidden).
      if (has(fight, 'hidden') && followUpComing(fight)) return false;
      if (NEEDS_COMBO.has(a.id) && optionOn(fight, 'strictCombo') && !has(fight, 'combo')) return false;
      // Option reserveHiding: a paced fight keeps Hiding's SP in hand -- no
      // skill spends into it (hidingReserved keeps the cooldown for the one-shot).
      if (fight.options.reserveHiding === true && a.isSkill && a.id !== 'Hiding') {
        const cost = a.spCost(fight);
        if (cost > 0 && fight.me.sp - cost < rule('Hiding').spCost(fight)) return false;
      }
      return own?.(fight) ?? true;
    },
  };
}

/**
 * The Satsujin's dodges for the automatic defence (option defense 'auto',
 * defense.ts): the shared ones, Kawarimi against physical hits (held for an
 * instant killer, and put down ahead of one), and Shadow Slash out of an
 * area aimed at you.
 */
const TOOLS: DefenseTool[] = [
  ...COMMON_TOOLS,
  {
    way: 'kawarimi', action: 'Kawarimi',
    plan: (fight, s, _from, r) => (s.avoid.includes('kawarimi') && s.type === 'physical' && readyAt(fight, 'Kawarimi') <= r.endsAt
      ? Math.max(fight.t, r.endsAt - 100) : null),
    covers: (fight, s, endsAt) => s.type === 'physical' && stacks(fight, 'kawarimi') > 0 && fight.me.buffs.kawarimi.until >= endsAt,
    pre: {
      holdMs: (fight) => kawarimiAt(lv(fight.f, 'Kawarimi')).ms,
      up: (fight) => has(fight, 'kawarimi'),
      answers: (s) => s.type === 'physical' && s.targets === 'single' && s.avoid.includes('kawarimi'),
      minShare: 0.5,
    },
  },
  { way: 'slashout', action: 'Shadow Slash out', plan: (fight, s) => (slashOutWorks(fight, s) ? fight.t + reactionMs(fight) : null) },
];
export const SATSUJIN_TOOLS = TOOLS;

const ACTIONS: Action[] = [
  attack, shadowSlash, newMoon, fullMoon, millionStab, thousandArms, dragonOmamori, omamoriJutsu,
  backStab, refocus, kawarimi, hiding, walkOut, lotusPact, morrocsMark, hallucinationWalk, stayHidden,
  breakSight, pullOffWard, swingWait, predictKawarimi, moonGuard, walkOutOnTell, slashOut, backSlide,
  fanOfKnives, ...predictActions(TOOLS), stayReadyAction(TOOLS),
].map(withRules);
const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
const rule = (id: string) => BY_ID.get(id)!;
const PREEMPTS = ACTIONS.filter(isPreempt);

/**
 * The written rotation, first usable wins. It is also what every TAS
 * rollout plays after its first move.
 */
const ORDER = [
  'Stay hidden', 'Predict Kawarimi', 'Moon guard', 'Pull it off the ward',
  "Morroc's Mark",
  'Hallucination Walk',
  'Fan of Knives', // option fanOfKnives only: farming packs
  'Full Moon', // invisible: spend it before a hit takes it
  'Million Stab', 'Thousand Arms', 'Dragon Omamori', 'Omamori Jutsu', // the combo window
  'New Moon', // open the next combo
  'Shadow Slash', 'Back Stab', // fillers
  'Lotus Pact',
  'Attack',
  'Wait for swing', // swing timer on (weaveMs): the next swing is not due yet
];

/** The priority list, or a profile's own (option order: the same ids, reordered or left out). */
export const SATSUJIN_ORDER = ORDER;

/** The rotation's switches, for the searches (kits/index.ts RotationSpace). */
export const SATSUJIN_SEARCH = {
  order: ORDER,
  switches: {
    backStab: [true, false], seedTalisman: [true, false], slashOpener: [false, true],
    // strictCombo is not here: Million Stab and Dragon Omamori only under Combo Ready is the
    // project owner's hard rule (2026-09-26), not a setting to search.
    hallucinationWalk: [true, false], refocus: [true, false],
    // Lotus Pact in a fight (and below what SP share), and between fights when it beats sitting.
    lotus: [true, false], lotusAt: [0.5, 0.3, 0.7], lotusSit: [true, false],
  } as Record<string, unknown[]>,
  pinned: ['Stay hidden', 'Pull it off the ward', "Morroc's Mark", 'Lotus Pact', 'Wait for swing'],
  droppable: ['Thousand Arms', 'Shadow Slash', 'Back Stab', 'Hallucination Walk', 'Dragon Omamori', 'Million Stab'],
  // A new piece's random options: the Moon combo's skills (with --skill-rolls), then melee crit and flee.
  rolls: ['full_moon_damage', 'new_moon_damage', 'million_stab_damage', 'melee_damage', 'critical_damage', 'atk_pct',
    'max_hp', 'sp_cost_reduced', 'defense_penetration', 'hp_leech', 'flee', 'perfect_dodge', 'aspd', 'after_cast_delay', 'crit'],
};
function priority(fight: Fight): Action {
  // Option slashOpener: Shadow Slash before anything else.
  if (fight.options.slashOpener === true && fight.me.cds['Shadow Slash'] === undefined
    && canUse(fight, rule('Shadow Slash'))) return rule('Shadow Slash');
  const order = Array.isArray(fight.options.order) ? fight.options.order as string[] : ORDER;
  for (const id of order) {
    const a = rule(id);
    if (canUse(fight, a)) return a;
  }
  // A custom order may leave these out; standing still beats a swing on cooldown.
  if (canUse(fight, rule('Attack'))) return rule('Attack');
  if (canUse(fight, rule('Wait for swing'))) return rule('Wait for swing');
  return rule('Attack');
}

// ---- reacting to a cast bar --------------------------------------------------

/**
 * When a planned Hiding goes off: 150 ms before the hit, but never before
 * Hiding is off cooldown -- assessThreat calls it ready up to 50 ms before
 * the hit, and a dodge planned inside its cooldown fails (engine defend).
 */
const hideAt = (fight: Fight, endsAt: number) => Math.max(fight.t, readyAt(fight, 'Hiding'), endsAt - 150);

function react(fight: Fight, s: MobSkill, from: Monster): { action: string; at: number } | null {
  const t = assessThreat(fight, s, from);
  if (heavyFollowUp(fight, s, from) && !has(fight, 'rooted')) {
    return { action: 'Walk out on the tell', at: fight.t + reactionMs(fight) };
  }
  if (!t.heavy) return null;
  const { endsAt } = t;
  // The playbook first (data/playbook.json): this class's answer to the skill.
  const planned = playbookPlan(fight, s, from, endsAt, {
    slashout: () => (slashOutWorks(fight, s) ? { action: 'Shadow Slash out', at: fight.t + reactionMs(fight) } : null),
    backslide: () => (backSlideWorks(fight, s) && fight.t + reactionMs(fight) < endsAt
      ? { action: 'Back Slide', at: fight.t + reactionMs(fight) } : null),
    walk: () => (t.canWalk ? { action: 'Walk out', at: fight.t + reactionMs(fight) } : null),
    hide: () => (t.hideWorks && t.hideReady && !hidingReserved(fight, s, from) ? { action: 'Hiding', at: hideAt(fight, endsAt) } : null),
    los: () => (t.canLos ? { action: 'Break line of sight', at: fight.t + reactionMs(fight) } : null),
    manhole: () => (fight.ground.manholeUntil > endsAt && s.durationMs <= MANHOLE_MS - 200 && !has(fight, 'rooted')
      ? { action: enterManhole.id, at: Math.max(fight.t, endsAt - 150) } : null),
    kawarimi: () => (s.avoid.includes('kawarimi') && s.type === 'physical' && readyAt(fight, 'Kawarimi') <= endsAt && !hasInstantKiller(fight)
      ? { action: 'Kawarimi', at: Math.max(fight.t, endsAt - 100) } : null),
  });
  if (planned !== undefined) return planned;
  if (slashOutWorks(fight, s)) return { action: 'Shadow Slash out', at: fight.t + reactionMs(fight) };
  // Too little time to walk: Back Slide from gear is out in one step.
  if (!t.canWalk && backSlideWorks(fight, s) && fight.t + reactionMs(fight) < endsAt) {
    return { action: 'Back Slide', at: fight.t + reactionMs(fight) };
  }
  // Hiding is on a 5s cooldown and single-target casts can only be hidden
  // from, so an area is walked out of when the cast bar leaves time.
  if (t.canWalk && s.targets === 'aoe') {
    return { action: 'Walk out', at: fight.t + reactionMs(fight) };
  }
  const reserved = hidingReserved(fight, s, from);
  if (t.hideWorks && t.hideReady && (t.hideCovers || !t.canWalk) && !reserved) {
    return { action: 'Hiding', at: hideAt(fight, endsAt) };
  }
  // A Manhole on the ground: 3s where nothing lands (the Freya fight's answer
  // to Adoramus) -- ahead of line of sight, which an aimed splash now allows.
  if (fight.ground.manholeUntil > endsAt && s.durationMs <= MANHOLE_MS - 200 && !has(fight, 'rooted')) {
    return { action: enterManhole.id, at: Math.max(fight.t, endsAt - 150) };
  }
  if (t.canLos) return { action: 'Break line of sight', at: fight.t + reactionMs(fight) };
  if (t.canWalk) {
    return { action: 'Walk out', at: fight.t + reactionMs(fight) };
  }
  // Kawarimi is kept for an instant killer the monster has (Critical Slash):
  // its 20 s cooldown matches the killer's reuse, one spent elsewhere is a death.
  if (s.avoid.includes('kawarimi') && s.type === 'physical' && readyAt(fight, 'Kawarimi') <= endsAt
    && !hasInstantKiller(fight)) {
    return { action: 'Kawarimi', at: Math.max(fight.t, endsAt - 100) };
  }
  if (t.hideWorks && t.hideReady && !reserved) {
    return { action: 'Hiding', at: hideAt(fight, endsAt) };
  }
  return null;
}

// ---- before the pull ---------------------------------------------------------

/** What `prep` put up, for the log and the summary. */
function prepNotes(fight: Fight): string[] {
  const out: string[] = [];
  if (has(fight, 'stance')) out.push('Moonlight Stance');
  if (has(fight, 'hallucination')) out.push('Hallucination Walk');
  const sw = fight.me.buffs.sevenWinds;
  if (sw) {
    const e = SEVEN_WINDS[sw.stacks];
    const pct = Math.round(attrFix(e, fight.m.element, fight.m.elementLevel) * 100);
    out.push(`Seven Winds: ${e} (${pct}% vs ${fight.m.element} ${fight.m.elementLevel})`);
  }
  const focus = focusStacks(fight);
  if (focus) out.push(`${focus} Focus (${boltFor(fight)} ×2)`);
  return out;
}

function prep(fight: Fight) {
  const f = fight.f;
  if (lv(f, 'Moonlight Stance') > 0) grant(fight, 'stance', 1e12);
  // Hallucination Walk is up before the pull (the project owner, 2026-10-02,
  // replacing the 2026-09-26 "cast in the fight"); option prepHallucination
  // false for the old way. Recasts in the fight follow hallucinationWalk.
  if (lv(f, 'Hallucination Walk') > 0 && optionOn(fight, 'prepHallucination')) hallucinate(fight);
  if (lv(f, 'Seven Winds') > 0) {
    const e = bestElement(fight);
    fight.me.buffs.sevenWinds = { until: 1e12, stacks: SEVEN_WINDS.indexOf(e) };
  }
  // Two bolt casts: 10 Focus. The second cast's stacks are the freshest,
  // but both land within a few seconds of the pull; 60s is close enough.
  if (optionOn(fight, 'prepFocus')) addFocus(fight, 10);
  // Kawarimi is not pre-cast (the project owner, 2026-09-26): the TAS casts
  // it in the fight when it is worth the time, and the log and the opener say so.
  // The pull starts on full SP: the buffs' costs are paid and regenerated
  // before the fight, which a TAS can afford to wait for.
}

/** What each action is for, in the damage breakdown. */
const ROLES: Record<string, string> = {
  'New Moon': 'Moon combo', 'Full Moon': 'Moon combo', 'Million Stab': 'Moon combo',
  'Dragon Omamori': 'Omamori', 'Omamori Explosion': 'Omamori', 'Omamori Jutsu': 'Omamori',
  'Thousand Arms': 'Fillers', 'Shadow Slash': 'Fillers', 'Back Stab': 'Fillers', 'Fan of Knives': 'Fillers',
  Attack: 'Auto-attacks', Refocus: 'Focus upkeep',
  'Hallucination Walk': 'Buffs', Kawarimi: 'Buffs',
  Bleeding: 'Gem statuses', Poison: 'Gem statuses', Burning: 'Gem statuses',
};

export const satsujin: Kit = {
  className: 'Satsujin',
  actions: ACTIONS,
  roles: ROLES,
  cycleAnchor: 'New Moon',
  coreRoles: ['Moon combo', 'Omamori'],
  magicActions: ['Refocus'],
  recoverFor,
  priority: priorityWith(() => PREEMPTS, priority, rule('Stay ready')),
  holding: (fight) => !!snapThreatDue(fight, TOOLS),
  react: reactWith(TOOLS, react),
  prep,
  prepNotes,
  // Shadow Slash puts you on the target: no walk back after a dodge, with
  // mobility 'server' (the project owner, 2026-09-28).
  gapClosers: ['Shadow Slash'],
  // What the Moon combo runs on, for the Rotation overlay's arrows.
  statuses: (fight) => {
    const out = readMarks(fight, {
      me: [
        { key: 'combo', label: 'Combo Ready' }, { key: 'invisible', label: 'Invisible (New Moon)' },
        { key: 'hallucination', label: 'Hallucination Walk' }, { key: 'kawarimi', label: 'Kawarimi', stacks: true },
      ],
      target: [{ key: 'talisman', label: 'Dragon Omamori talisman' }],
      dots: { bleeding: 'Bleeding', poison: 'Poison', burning: 'Burning' },
    });
    const focus = fight.me.focus.filter((u) => u > fight.t);
    if (focus.length) out.push({ label: 'Elemental Focus', stacks: focus.length, leftMs: Math.min(...focus) - fight.t });
    return out;
  },
};
