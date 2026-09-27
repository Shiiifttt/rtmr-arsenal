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
import { attrFix, castTimeMs, magicDamage, TUNE } from '../formulas.ts';
import type { MobSkill, Monster } from '../model.ts';
import { ratioAt } from '../skilltext.ts';
import type { Passives } from '../character.ts';
import {
  canUse, enterManhole, focusStacks, followUpComing, grant, has, heal_, MANHOLE_MS, mobHas, readyAt, strike,
  type Action, type Fight, type Kit,
} from '../engine.ts';
import {
  assessThreat, attackAction, breakSight, hidingAction, lv, morrocsMark, optionOn, pullOffWard, stayHidden, toolkit,
  walkOut,
} from './common.ts';

const TREE = ['Satsujin', 'Shinobi', 'Assassin', 'Thief', 'Orphan'];

/** Gear writes some skills by other names. */
export const ALIASES: Record<string, string[]> = {
  'New Moon': ['New Moon Blades', 'New Moon Kick'],
  'Full Moon': ['Full Moon Blades', 'Full Moon Kick'],
};

const SKILLS = [
  'Shadow Slash', 'New Moon', 'Full Moon', 'Million Stab', 'Thousand Arms', 'Dragon Omamori',
  'Omamori Jutsu', 'Back Stab', 'Wind Blade', 'Kawarimi', 'Hiding', 'Moonlight Stance',
  'Seven Winds', 'Lotus Pact', "Morroc's Mark", 'Hallucination Walk', 'Advanced Blade Mastery', 'Blade Mastery',
  'Improve Dodge', 'Shadow Mastery', 'Improve Defense', 'Improve Wisdom', 'Increase SP Recovery',
];

/**
 * Where the crawl's max level is wrong. Dragon Omamori says 10, but its SP
 * and range tables stop at 5, and the project owner's readings (2026-09-26)
 * only fit level 5: apply 9,830 and explosion 16,072 under Combo Ready.
 */
const MAX_LEVEL_FIX: Record<string, number> = { 'Dragon Omamori': 5 };

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
    notes: [
      'passives: Blade Masteries (ATK/HIT), Improve Dodge + Shadow Mastery (flee), '
        + 'Improve Defense/Wisdom (HP/SP), Moonlight Stance (Max HP)',
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
    strike(fight, 'New Moon', {
      hits: 1, canMiss: true, critBonus: null,
      damage: physical(fight, 'New Moon', ratioOf(fight, 'New Moon')),
    });
    grant(fight, 'invisible', INVIS_MS);
  },
};

const fullMoon: Action = {
  id: 'Full Moon',
  isSkill: true,
  offensive: true,
  ready: (fight) => learned('Full Moon')(fight) && has(fight, 'invisible'),
  castMs: cast('Full Moon'),
  cooldownMs: cooldown('Full Moon'),
  spCost: spCost('Full Moon'),
  resolve(fight) {
    strike(fight, 'Full Moon', {
      hits: 1, canMiss: true, critBonus: null,
      damage: physical(fight, 'Full Moon', ratioOf(fight, 'Full Moon')),
    });
    grant(fight, 'combo', sk('Full Moon').text.grants['combo ready'] ?? 5000);
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
  // One talisman per target.
  ready: (fight) => learned('Dragon Omamori')(fight) && !mobHas(fight, 'talisman'),
  castMs: cast('Dragon Omamori'),
  cooldownMs: cooldown('Dragon Omamori'),
  spCost: spCost('Dragon Omamori'),
  resolve(fight) {
    // Combo Ready's +5%/STR counts on the apply hit too, not only the
    // explosion: the owner's 9,830 apply reading is ~10x the bare ratio.
    const apply = ratioOf(fight, 'Dragon Omamori', 'apply damage');
    strike(fight, 'Dragon Omamori', {
      hits: 1, canMiss: true, critBonus: null, kind: 'ranged',
      damage: physical(fight, 'Dragon Omamori', apply, { ranged: true }),
    });
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

/** Lotus Pact: 10s kneeling, 1% HP and SP per level per second. */
const lotusPact: Action = {
  id: 'Lotus Pact',
  isSkill: true,
  offensive: false,
  ready: (fight) => learned('Lotus Pact')(fight) && fight.me.sp < 0.15 * fight.f.maxSp && !fight.mob.cast,
  castMs: cast('Lotus Pact'),
  delayMs: () => 10_000,
  cooldownMs: () => 10_000,
  spCost: () => 0,
  resolve(fight) {
    const pct = lv(fight.f, 'Lotus Pact') * 10 / 100; // 10 seconds' worth, up front
    heal_(fight, pct * fight.f.maxHp);
    fight.me.sp = Math.min(fight.f.maxSp, fight.me.sp + pct * fight.f.maxSp);
  },
};

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
      if (has(fight, 'invisible') && a.id !== 'Full Moon') return false;
      // Hidden with the monster's chain still coming: stay in (stayHidden).
      if (has(fight, 'hidden') && followUpComing(fight)) return false;
      if (NEEDS_COMBO.has(a.id) && optionOn(fight, 'strictCombo') && !has(fight, 'combo')) return false;
      return own?.(fight) ?? true;
    },
  };
}

const ACTIONS: Action[] = [
  attack, shadowSlash, newMoon, fullMoon, millionStab, thousandArms, dragonOmamori, omamoriJutsu,
  backStab, refocus, kawarimi, hiding, walkOut, lotusPact, morrocsMark, hallucinationWalk, stayHidden,
  breakSight, pullOffWard,
].map(withRules);
const rule = (id: string) => ACTIONS.find((a) => a.id === id)!;

/**
 * The written rotation, first usable wins. It is also what every TAS
 * rollout plays after its first move.
 */
const ORDER = [
  'Stay hidden', 'Pull it off the ward',
  "Morroc's Mark",
  'Hallucination Walk',
  'Full Moon', // invisible: spend it before a hit takes it
  'Million Stab', 'Thousand Arms', 'Dragon Omamori', 'Omamori Jutsu', // the combo window
  'New Moon', // open the next combo
  'Shadow Slash', 'Back Stab', // fillers
  'Lotus Pact',
  'Attack',
];

function priority(fight: Fight): Action {
  for (const id of ORDER) {
    const a = rule(id);
    if (canUse(fight, a)) return a;
  }
  return rule('Attack');
}

// ---- reacting to a cast bar --------------------------------------------------

function react(fight: Fight, s: MobSkill, from: Monster): { action: string; at: number } | null {
  const t = assessThreat(fight, s, from);
  if (!t.heavy) return null;
  const { endsAt } = t;
  // Hiding is on a 5s cooldown and single-target casts can only be hidden
  // from, so an area is walked out of when the cast bar leaves time.
  if (t.canWalk && s.targets === 'aoe') {
    return { action: 'Walk out', at: fight.t + TUNE.reactionMs };
  }
  if (t.hideWorks && t.hideReady && (t.hideCovers || !t.canWalk)) {
    return { action: 'Hiding', at: Math.max(fight.t, endsAt - 150) };
  }
  if (t.canLos) return { action: 'Break line of sight', at: fight.t + TUNE.reactionMs };
  // A Manhole on the ground: 3s where nothing lands (the Freya fight's answer to Adoramus).
  if (fight.ground.manholeUntil > endsAt && s.durationMs <= MANHOLE_MS - 200 && !has(fight, 'rooted')) {
    return { action: enterManhole.id, at: Math.max(fight.t, endsAt - 150) };
  }
  if (t.canWalk) {
    return { action: 'Walk out', at: fight.t + TUNE.reactionMs };
  }
  if (s.avoid.includes('kawarimi') && s.type === 'physical' && readyAt(fight, 'Kawarimi') <= endsAt) {
    return { action: 'Kawarimi', at: Math.max(fight.t, endsAt - 100) };
  }
  if (t.hideWorks && t.hideReady) {
    return { action: 'Hiding', at: Math.max(fight.t, endsAt - 150) };
  }
  return null;
}

// ---- before the pull ---------------------------------------------------------

/** What `prep` put up, for the log and the summary. */
function prepNotes(fight: Fight): string[] {
  const out: string[] = [];
  if (has(fight, 'stance')) out.push('Moonlight Stance');
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
  if (lv(f, 'Seven Winds') > 0) {
    const e = bestElement(fight);
    fight.me.buffs.sevenWinds = { until: 1e12, stacks: SEVEN_WINDS.indexOf(e) };
  }
  // Two bolt casts: 10 Focus. The second cast's stacks are the freshest,
  // but both land within a few seconds of the pull; 60s is close enough.
  if (optionOn(fight, 'prepFocus')) addFocus(fight, 10);
  // Hallucination Walk and Kawarimi are not pre-cast (the project owner,
  // 2026-09-26): the TAS casts them in the fight when they are worth the
  // time, and the log and the opener say so.
  // The pull starts on full SP: the buffs' costs are paid and regenerated
  // before the fight, which a TAS can afford to wait for.
}

/** What each action is for, in the damage breakdown. */
const ROLES: Record<string, string> = {
  'New Moon': 'Moon combo', 'Full Moon': 'Moon combo', 'Million Stab': 'Moon combo',
  'Dragon Omamori': 'Omamori', 'Omamori Explosion': 'Omamori', 'Omamori Jutsu': 'Omamori',
  'Thousand Arms': 'Fillers', 'Shadow Slash': 'Fillers', 'Back Stab': 'Fillers',
  Attack: 'Auto-attacks', Refocus: 'Focus upkeep',
  'Hallucination Walk': 'Buffs', Kawarimi: 'Buffs',
};

export const satsujin: Kit = {
  className: 'Satsujin',
  actions: ACTIONS,
  roles: ROLES,
  cycleAnchor: 'New Moon',
  coreRoles: ['Moon combo', 'Omamori'],
  magicActions: ['Refocus'],
  priority,
  react,
  prep,
  prepNotes,
};
