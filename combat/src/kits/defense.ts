/**
 * The automatic defence (profile option `defense: "auto"`): how to answer a
 * monster's cast, worked out from the cast itself and the tools the class
 * has, so a new class kit only lists its tools and writes its rotation (the
 * project owner, 2026-09-29: "each playbook fills itself with a priority
 * order based on threat level").
 *
 * A cast is read two ways:
 *   - its shape (the archetype): an area with time to walk out of it, an
 *     area without, a cast at you with time to get behind cover, a cast at
 *     you without. The owner's rules: a long-cast area that hits hard is
 *     walked out of; a fast one is hidden from; a hard single-target cast is
 *     hidden from or line-of-sighted, by its cast time.
 *   - its threat: light (tanked), heavy (answered), lethal (answered with
 *     anything, the reserved tools too). Physical hits count at the chance
 *     they land -- flee and Auto Guard let a class take risks with them.
 *
 * The answer order per archetype is data (playbook.json `archetypes`, per
 * class under `classes.<Class>.archetypes`); an explicit `prefer` on the
 * skill, monster or class still wins, as in the per-class reactions. Inside
 * a group ("hide|kawarimi|decoy") the cheapest tool that works is taken:
 * SP as a share of a minute's bar, time off the target, a little for the
 * cooldown it burns -- so Decoy or Kawarimi go before Hiding when they cost
 * less, and Hiding is the fallback.
 *
 * Casts too fast to answer from the cast bar (Magnus Exorcismus, Critical
 * Slash) are predicted: a tool that holds for a while (King's Gambit,
 * Kawarimi) goes down when the monster's reuse delay says one is due.
 *
 * Without the option nothing here runs: the kits' own reactions are used.
 */
import { countsAsBoss, mobHitChance } from '../formulas.ts';
import type { MobSkill, Monster } from '../model.ts';
import { archetypeOrder, playEntry, type Archetype, type Way } from '../playbook.ts';
import {
  actionById, canUse, has, MANHOLE_MS, readyAt, newFight, rollout, run, say, type Action, type Fight, type Kit,
} from '../engine.ts';
import {
  assessThreat, backSlideWorks, escapeMs, hidingReserved, losMs, reactionMs, returnMs, type Threat,
} from './common.ts';

export const autoDefense = (fight: Fight) => fight.options.defense === 'auto';

/** A cast bar this short cannot be answered once seen: it is predicted instead (the owner's 0.5 s for Magnus). */
export const FAST_CAST_MS = 500;

/**
 * A snap cast: its bar is too short to react to unless you are already
 * idle or walking -- not casting, not in a skill's pause (the project owner,
 * 2026-09-29: 300 ms). Option snapMs changes the line.
 */
export const SNAP_MS = 300;
export const snapMs = (fight: Fight) => (typeof fight.options.snapMs === 'number' ? fight.options.snapMs : SNAP_MS);

/**
 * Idle or walking: not casting, and nothing but a move or a wait holding you
 * (Walk out, Step back, Wait...: actions that are neither a skill nor an
 * attack). A normal swing counts as busy -- the owner's "idle or walking" --
 * unless option snapSwing is set (a click to move cancels a swing).
 */
export function readyToDodge(fight: Fight): boolean {
  const me = fight.me;
  if (me.cast) return false;
  if (me.busyUntil <= fight.t || !me.last) return true;
  if (me.last === 'Attack') return fight.options.snapSwing === true;
  const a = fight.kit.actions.find((x) => x.id === me.last) ?? fight.items.find((x) => x.id === me.last);
  return !a || (!a.isSkill && !a.offensive);
}

/** A snap cast that hits hard is this far past due at most before you stop waiting for it. */
const SNAP_OVERDUE_MS = 3000;

/**
 * A hard-hitting snap cast is due: the monster's reuse delay has run out on
 * a row it fires when it can (AI rate 0.5+), or it has not cast it yet in
 * the fight's first seconds -- and you would have an answer if idle (a tool
 * that works on it is ready), and nothing put down ahead covers it. The
 * character then stays idle or walking until it comes (Stay ready), giving
 * up SNAP_OVERDUE_MS past due so a row that keeps losing its turn cannot
 * freeze the fight.
 */
const snapCache = new WeakMap<object, { t: number; v: MobSkill | null }>();
export function snapThreatDue(fight: Fight, tools: DefenseTool[]): MobSkill | null {
  if (!autoDefense(fight) || fight.options.stayReady === false) return null;
  const hit = snapCache.get(fight.me);
  if (hit && hit.t === fight.t) return hit.v;
  let v: MobSkill | null = null;
  const line = snapMs(fight);
  for (const { m, st } of actorsOf(fight)) {
    for (const k of m.skills) {
      if (k.castMs > line || k.type === 'none' || k.targets === 'self') continue;
      const last = st.cds[k.skill];
      const offDelay = last === undefined || last + k.ai.delayMs <= fight.t + 300;
      if (k.ai.cond === 'afterskill') {
        // A chain: due once the skill it follows has just gone off (the
        // Tortured Maiden's Wide Bleeding -> Vampire Gift, Converted
        // Zealot's Back Stab -> Cloud Kill), or is being cast now.
        const after = Number(k.ai.condValue);
        const trigger = m.skills.find((x) => x.skillId === after);
        const fresh = st.cast?.skill.skillId === after
          // 2 s from when it landed (its reuse stamp is its cast's start).
          || (st.lastSkill === after && !!trigger && fight.t - (st.cds[trigger.skill] ?? -Infinity) - trigger.castMs <= 2000);
        if (!fresh || !offDelay) continue;
      } else {
        if (k.ai.rate < 0.5) continue;
        if (last === undefined ? fight.t > SNAP_OVERDUE_MS : fight.t > last + k.ai.delayMs + SNAP_OVERDUE_MS || !offDelay) continue;
      }
      if (tools.some((x) => x.pre?.answers(k) && x.pre.up(fight))) continue;
      const r = readThreat(fight, k, m);
      // Held for one that would kill or disable you; a heavy hit you would
      // live through is dodged when you happen to be free (option stayReadyFor
      // 'heavy': held for those too). Holding for every heavy one costs more
      // than it saves: a Satsujin waiting on Heartless's Magnus every 3.3 s
      // lost to attrition (98% -> 50%, 2026-09-29); also holding for hits that
      // leave you under 35% HP did the same (53%).
      if (r.level === 'light' || (r.level === 'heavy' && fight.options.stayReadyFor !== 'heavy')) continue;
      if (!tools.some((x) => x.way !== 'barrier' && kitHas(fight, x.action) && x.plan(fight, k, m, r) !== null)) continue;
      v = k;
      break;
    }
    if (v) break;
  }
  snapCache.set(fight.me, { t: fight.t, v });
  return v;
}

/** Idle while a hard snap cast is due, ready to dodge it (snapThreatDue). */
export function stayReadyAction(tools: DefenseTool[]): Action {
  return {
    id: 'Stay ready',
    isSkill: false,
    offensive: false,
    idle: true,
    ready: (fight) => !!snapThreatDue(fight, tools),
    castMs: () => 0,
    delayMs: () => 100,
    cooldownMs: () => 0,
    spCost: () => 0,
    resolve(fight) {
      const k = snapThreatDue(fight, tools);
      if (k && fight.log && fight.me.last !== 'Stay ready') say(fight, `stays ready for ${k.name}`);
    },
  };
}

/**
 * For a kit's rules: while a hard snap cast is due, nothing that would leave
 * you casting or in a skill's pause -- only moves, waits and potions.
 */
export const heldForSnap = (fight: Fight, a: Action, tools: DefenseTool[]) =>
  (a.isSkill || a.offensive) && !isPreempt(a) && !tools.some((t) => t.action === a.id) && !!snapThreatDue(fight, tools);
/**
 * What one SP is worth, in seconds of fighting. The written rotation is
 * played ahead once a fight (expect mode, 15 s) for its SP burn and damage:
 * a point spent on a dodge is a point the rotation cannot spend, 1 / burn
 * seconds of it -- but only if the bar runs dry before the monster dies. In
 * a short fight the bar outlasts it and SP is nearly free (a tenth); a
 * Kingslayer burning ~155 SP/s on Heartless pays in full. Option
 * spBarSeconds (a number) fixes a full bar's worth instead.
 */
const paces = new WeakMap<object, { burn: number; dps: number }>();
/**
 * Per fighter, monster and options: the pace from the pull, shared by every
 * fight of a batch -- one rollout a batch rather than one a fight (~30% of a
 * search's time, 2026-09-30; the endgame farm build read 217.1 kills/h
 * either way). Option paceFrom 'fight' measures it in each fight, from the
 * first cast it answers, as before.
 */
const pullPaces = new WeakMap<object, WeakMap<object, WeakMap<object, { burn: number; dps: number }>>>();
function rotationPace(fight: Fight): { burn: number; dps: number } {
  if (fight.options.paceFrom !== 'fight') {
    let byM = pullPaces.get(fight.f);
    if (!byM) pullPaces.set(fight.f, byM = new WeakMap());
    let byO = byM.get(fight.m);
    if (!byO) byM.set(fight.m, byO = new WeakMap());
    let p = byO.get(fight.options);
    if (!p) {
      const fresh = newFight(fight.f, fight.m, fight.kit, fight.policy, { seed: 1, limitMs: fight.limitMs, options: fight.options, items: fight.items });
      const copy = run(rollout(fresh, fight.kit.priority, 15_000));
      const secs = Math.max(1, copy.t / 1000);
      const regen = regenPerSec(fight);
      p = { burn: Math.max(1, (fresh.me.sp - copy.me.sp) / secs + regen), dps: Math.max(1, (fresh.mob.hp - copy.mob.hp) / secs) };
      byO.set(fight.options, p);
    }
    return p;
  }
  let p = paces.get(fight.me.spent);
  if (!p) {
    const copy = run(rollout(fight, fight.kit.priority, fight.t + 15_000));
    const secs = Math.max(1, (copy.t - fight.t) / 1000);
    const regen = regenPerSec(fight);
    p = { burn: Math.max(1, (fight.me.sp - copy.me.sp) / secs + regen), dps: Math.max(1, (fight.mob.hp - copy.mob.hp) / secs) };
    paces.set(fight.me.spent, p);
  }
  return p;
}
const regenPerSec = (fight: Fight) => (fight.f.regen.sp ?? 0) / 1.2 + (fight.f.regen.spSkill ?? 0) / 4;

export function spSeconds(fight: Fight): number {
  if (typeof fight.options.spBarSeconds === 'number') return fight.options.spBarSeconds / Math.max(1, fight.f.maxSp);
  const { burn, dps } = rotationPace(fight);
  const left = Math.min(fight.mob.hp / dps, (fight.limitMs - fight.t) / 1000);
  const net = burn - regenPerSec(fight);
  const lasts = net <= 0 || fight.me.sp / net >= 1.2 * left;
  return (lasts ? 0.1 : 1) / burn;
}
/** A second of cooldown burnt, in seconds of fighting. */
const CD_WEIGHT = 0.05;

export type Level = 'light' | 'heavy' | 'lethal';

export interface Plan { action: string; at: number }

/** One way a class answers a cast: its kit action and when it can go. */
export interface DefenseTool {
  way: Way;
  /** The kit action it plays. */
  action: string;
  /** When to take it against this cast, or null when it cannot answer it now. */
  plan(fight: Fight, s: MobSkill, from: Monster, r: Read): number | null;
  /** Its protection is already up past this cast (King's Gambit down): nothing to do. */
  covers?(fight: Fight, s: MobSkill, endsAt: number): boolean;
  /** Time off the target, ms (a walk out and back), if taken at `at`. */
  lostMs?(fight: Fight, s: MobSkill, r: Read, at: number): number;
  /** Only for a cast that would kill: a long cooldown (Queen's Barrier). */
  reserve?: boolean;
  /** Put down ahead of a cast too fast to answer, while it holds. */
  pre?: {
    holdMs(fight: Fight): number;
    /** It is up now. */
    up(fight: Fight): boolean;
    answers(s: MobSkill): boolean;
    /** Only against a cast worth this share of your HP or more. */
    minShare: number;
    /** A kit option can turn it off. */
    on?(fight: Fight): boolean;
  };
}

/** The read on a cast: the kit's threat, plus its shape and how bad it is. */
export interface Read extends Threat {
  archetype: Archetype;
  level: Level;
  /** The chance it lands at all (flee, Auto Guard, magic dodge). */
  land: number;
  /** Damage times that chance. */
  expected: number;
}

// ---- reading a cast ---------------------------------------------------------

function buffTotals(fight: Fight): { flee: number; magicDodge: number } {
  let flee = 0; let md = 0;
  for (const k in fight.me.buffs) {
    const b = fight.me.buffs[k];
    if (b.until <= fight.t) continue;
    flee += b.flee ?? 0;
    md = 1 - (1 - md) * (1 - (b.magicDodge ?? 0));
  }
  return { flee, magicDodge: md };
}

/** The chance it lands, as the engine rolls it (landMobHit): flee, Auto Guard, magic dodge. */
export function landChance(fight: Fight, s: MobSkill, from: Monster): number {
  const b = buffTotals(fight);
  if (s.type === 'physical') {
    const guard = Math.min(1, 0.04 * (fight.f.autoGuard ?? 0));
    const hit = s.ignoresFlee || s.crit ? 1
      : Math.min(1, mobHitChance(from.hit, fight.f.flee + b.flee) * (1 + (s.hitBonus ?? 0) / 100));
    return hit * (1 - guard);
  }
  if (s.type === 'magic') return 1 - b.magicDodge;
  return 1;
}

export function archetypeOf(fight: Fight, s: MobSkill, t: Threat): Archetype {
  if (s.targets === 'aoe') return s.avoid.includes('walk') && t.lead >= escapeMs(fight, s) ? 'area-slow' : 'area-fast';
  return t.lead >= losMs(fight) ? 'single-slow' : 'single-fast';
}

export function readThreat(fight: Fight, s: MobSkill, from: Monster): Read {
  const t = assessThreat(fight, s, from);
  const land = landChance(fight, s, from);
  const expected = t.dmg * land;
  const hp = fight.me.hp;
  // As assessThreat, on the expected damage: option tankShare (a share of
  // Max HP) or a quarter of current HP.
  const share = typeof fight.options.tankShare === 'number' ? fight.options.tankShare : null;
  // A hit that would take half of what you have is answered whatever the
  // odds it lands: flee and Auto Guard only let you tank the moderate ones
  // (the project owner, 2026-09-29: play safe and reliably).
  const big = t.dmg >= 0.5 * hp
    || (share === null ? expected >= 0.25 * hp : expected >= share * fight.f.maxHp);
  const always = !!playEntry(fight, s, from)?.always;
  const heavy = s.type !== 'none' && s.targets !== 'self' && (big || t.badStatus || always);
  // Lethal: it kills if it lands, and it lands more often than option risk
  // (a chance, 0 by default: never gamble a death).
  const risk = typeof fight.options.risk === 'number' ? fight.options.risk : 0;
  const lethal = heavy && ((t.dmg >= 0.9 * hp && land > risk) || t.badStatus);
  return { ...t, heavy, archetype: archetypeOf(fight, s, t), level: lethal ? 'lethal' : heavy ? 'heavy' : 'light', land, expected };
}

// ---- choosing an answer -------------------------------------------------------

const kitIds = new WeakMap<Kit, Set<string>>();
/** The kit has this action (Back Slide is gear, Kawarimi a Satsujin's). */
function kitHas(fight: Fight, id: string): boolean {
  let ids = kitIds.get(fight.kit);
  if (!ids) kitIds.set(fight.kit, ids = new Set(fight.kit.actions.map((a) => a.id)));
  return ids.has(id) || id === 'Enter Manhole';
}

/** What a tool costs, in seconds of fighting. */
export function toolCost(fight: Fight, tool: DefenseTool, s: MobSkill, r: Read, at: number): number {
  const a = actionById(fight, tool.action);
  const sp = a.spCost(fight) * spSeconds(fight);
  return sp + (tool.lostMs?.(fight, s, r, at) ?? 0) / 1000 + (a.cooldownMs(fight) / 1000) * CD_WEIGHT;
}

/** The order the ways are tried in for this cast, and where it came from. */
export function answerOrder(fight: Fight, s: MobSkill, from: Monster, r: Read): { groups: Way[][]; source: string } {
  const e = playEntry(fight, s, from);
  const boss = countsAsBoss(from);
  const found = e?.prefer
    ? { groups: e.prefer.map((w) => String(w).split('|').map((x) => x.trim()) as Way[]), source: 'playbook' }
    : { groups: archetypeOrder(fight.kit.className, r.archetype, boss), source: `${r.archetype}${boss ? ' (boss)' : ''}` };
  // Option stayVisible: answers that leave you where the monster can swing at
  // you (Pawn's Rod, King's Gambit) go first -- building Duel Counters off its
  // swings (the project owner, 2026-09-30).
  if (fight.options.stayVisible !== true) return found;
  const visible = (w: Way) => w === 'rod' || w === 'gambit';
  const split = found.groups.flatMap((g) => [g.filter(visible), g.filter((w) => !visible(w))]).filter((g) => g.length);
  return { groups: [...split.filter((g) => g.every(visible)), ...split.filter((g) => !g.every(visible))], source: `${found.source}, visible first` };
}

/**
 * A tool held back for a cast too fast to answer that would nearly kill
 * (Kawarimi for Critical Slash): its cooldown matches the killer's reuse, so
 * one spent elsewhere is a death. Tried only when nothing else works.
 */
function keptBack(fight: Fight, tool: DefenseTool): boolean {
  const pre = tool.pre;
  if (!pre || fight.options.predict === false || (pre.on && !pre.on(fight))) return false;
  return actorsOf(fight).some(({ m }) => m.skills.some((k) => pre.answers(k) && k.castMs <= FAST_CAST_MS
    && k.ai.rate >= 0.5 && k.type !== 'none' && k.type !== 'status'
    && assessThreat(fight, { ...k, castMs: 0 }, m).dmg >= 0.5 * fight.f.maxHp));
}

/**
 * The answer to a cast bar: a plan, or null to take it. The first group of
 * the order with a tool that works gives the cheapest such tool; the
 * reserved tools come in only for a lethal cast, after everything else.
 */
export function autoReact(fight: Fight, s: MobSkill, from: Monster, tools: DefenseTool[]): Plan | null {
  const tell = tellPlan(fight, s, from);
  if (tell) return tell;
  // A snap cast is answered only by a player who is idle or walking as it starts.
  if (s.castMs <= snapMs(fight) && !readyToDodge(fight)) {
    fight.log && say(fight, `too busy to answer ${s.name} (${s.castMs} ms)`);
    return null;
  }
  const r = readThreat(fight, s, from);
  if (r.level === 'light') return null;
  if (tools.some((x) => x.covers?.(fight, s, r.endsAt))) return null;
  // A cross misses you diagonal to the caster, which costs nothing (engine landMobHit).
  if (s.avoid.includes('diag') && fight.options.diagonal !== false && !has(fight, 'rooted')) return null;
  const { groups } = answerOrder(fight, s, from, r);
  const pick = (held: boolean): Plan | null => {
    for (const g of groups) {
      let best: (Plan & { c: number }) | null = null;
      for (const way of g) {
        for (const tool of tools) {
          if (tool.way !== way || !kitHas(fight, tool.action)) continue;
          if ((tool.reserve || keptBack(fight, tool)) !== held) continue;
          if (actionById(fight, tool.action).spCost(fight) > fight.me.sp) continue;
          const at = tool.plan(fight, s, from, r);
          if (at === null) continue;
          const c = toolCost(fight, tool, s, r, at);
          if (!best || c < best.c) best = { action: tool.action, at, c };
        }
      }
      if (best) return { action: best.action, at: best.at };
    }
    return null;
  };
  return pick(false) ?? (r.level === 'lethal' ? pick(true) : null);
}

/**
 * A tell (option kite): a cast the monster always follows with a heavy area
 * (Converted Zealot's Back Stab -> Cloud Kill) -- walk out on the tell and
 * stay out through the follow-up, for a kit that has that move.
 */
export const TELL_ACTION = 'Walk out on the tell';
function tellPlan(fight: Fight, s: MobSkill, from: Monster): Plan | null {
  if (fight.options.kite !== true || has(fight, 'rooted') || !kitHas(fight, TELL_ACTION)) return null;
  const next = from.skills.find((n) => n.ai.cond === 'afterskill' && Number(n.ai.condValue) === s.skillId
    && n.targets === 'aoe' && n.avoid.includes('walk') && readThreat(fight, n, from).level !== 'light');
  return next ? { action: TELL_ACTION, at: fight.t + reactionMs(fight) } : null;
}

// ---- the tools every class has ------------------------------------------------

/** When a planned Hiding goes off: 150 ms before the hit, never before it is off cooldown. */
const hideAt = (fight: Fight, endsAt: number) => Math.max(fight.t, readyAt(fight, 'Hiding'), endsAt - 150);

/**
 * A move out of the way (walk, Back Slide, cover): at once, as the kits' own
 * reactions do -- safe over fast (the project owner, 2026-09-29: "better
 * play safe and reliably"), since a stun or root on the way would leave you
 * in it. Option walkLate: go as late as the step and a reaction's margin
 * allow, fighting through the cast bar. Its cost is the time away and back.
 */
function moveTool(way: Way, action: string, stepMs: (fight: Fight, s: MobSkill) => number,
  works: (fight: Fight, s: MobSkill, r: Read) => boolean,
  backMs: (fight: Fight, s: MobSkill) => number = stepMs): DefenseTool {
  return {
    way, action,
    plan: (fight, s, _f, r) => {
      if (!works(fight, s, r)) return null;
      // Not before it is off cooldown (Back Slide's 3 s), and out before it lands.
      const soonest = Math.max(fight.t + reactionMs(fight), readyAt(fight, action));
      if (soonest + stepMs(fight, s) > r.endsAt) return null;
      if (fight.options.walkLate !== true) return soonest;
      return Math.max(soonest, r.endsAt - stepMs(fight, s) - reactionMs(fight) - 100);
    },
    // Out from `at` until it lands, then back -- free if a gap closer is ready by then.
    lostMs: (fight, s, r, at) => (r.endsAt + 50 - at) + returnMs(fight, r.endsAt + 50 - fight.t, backMs(fight, s)),
  };
}

/** Walking out, cover, Hiding, Back Slide from gear, a Manhole on the ground. */
export const COMMON_TOOLS: DefenseTool[] = [
  moveTool('walk', 'Walk out', (fight, s) => escapeMs(fight, s), (_fight, _s, r) => r.canWalk),
  // Out in one slide, but back on foot like any walk (common.ts backSlide).
  moveTool('backslide', 'Back Slide', () => 100,
    (fight, s, r) => backSlideWorks(fight, s) && fight.t + reactionMs(fight) < r.endsAt, (fight, s) => escapeMs(fight, s)),
  moveTool('los', 'Break line of sight', (fight) => losMs(fight), (_fight, _s, r) => r.canLos),
  { way: 'hide', action: 'Hiding',
    plan: (fight, s, from, r) => (r.hideWorks && r.hideReady && !hidingReserved(fight, s, from) ? hideAt(fight, r.endsAt) : null) },
  { way: 'manhole', action: 'Enter Manhole', lostMs: () => MANHOLE_MS,
    plan: (fight, s, _f, r) => (fight.ground.manholeUntil > r.endsAt && s.durationMs <= MANHOLE_MS - 200 && !has(fight, 'rooted')
      ? Math.max(fight.t, r.endsAt - 150) : null) },
];

// ---- predicting what cannot be seen coming -----------------------------------

const actorsOf = (fight: Fight) => [{ m: fight.m, st: fight.mob }, ...fight.mob.adds.map((a) => ({ m: a.m, st: a.st }))];

/**
 * A cast `tool` can pre-empt is due while it would hold. A cast with no bar
 * that the monster rolls on its attack turn (Critical Slash) is due just
 * before its next swing, however overdue -- other rows often take its turn.
 * A fast area (Magnus) is due as its reuse delay runs out, up to 2 s
 * overdue; one never cast yet is due at the pull (the owner: Heartless
 * always opens with Magnus; option openerPredict / openerGambit false stops it).
 * Only rows the monster fires at once when it can (AI rate 0.5+).
 */
export function preDue(fight: Fight, tool: DefenseTool): MobSkill | null {
  const pre = tool.pre!;
  const hold = pre.holdMs(fight);
  for (const { m, st } of actorsOf(fight)) {
    for (const k of m.skills) {
      if (!pre.answers(k) || k.type === 'none' || k.type === 'status' || k.targets === 'self') continue;
      if (k.castMs > FAST_CAST_MS || k.ai.rate < 0.5) continue;
      const last = st.cds[k.skill];
      const onSwing = k.castMs <= 0 && ['attack', 'any', 'angry'].includes(k.ai.state);
      if (onSwing) {
        if (st.cast || st.nextAttackAt - fight.t > 300) continue;
        if (last !== undefined && last + k.ai.delayMs > fight.t + 300) continue;
      } else if (last === undefined) {
        if (fight.t >= 1500 || fight.options.openerPredict === false || fight.options.openerGambit === false) continue;
      } else {
        const due = last + k.ai.delayMs;
        if (due > fight.t + hold - 300 || fight.t > due + 2000) continue;
      }
      if (assessThreat(fight, { ...k, castMs: 0 }, m).dmg < pre.minShare * fight.me.hp) continue;
      return k;
    }
  }
  return null;
}

/**
 * One action per tool that can be put down ahead ("Pre-empt King's Gambit"),
 * for the kit's action list -- where its own rules (a Satsujin's invisibility)
 * wrap it like any other skill. Usable only with the option on.
 */
export function predictActions(tools: DefenseTool[]): Action[] {
  return tools.filter((t) => t.pre).map((tool) => ({
    id: `Pre-empt ${tool.action}`,
    isSkill: true,
    offensive: false,
    ready: (fight: Fight) => {
      const pre = tool.pre!;
      if (!autoDefense(fight) || fight.options.predict === false || (pre.on && !pre.on(fight))) return false;
      if (pre.up(fight) || readyAt(fight, tool.action) > fight.t) return false;
      const a = actionById(fight, tool.action);
      return (a.ready?.(fight) ?? true) && !!preDue(fight, tool);
    },
    castMs: (fight: Fight) => actionById(fight, tool.action).castMs(fight),
    cooldownMs: () => 0,
    spCost: (fight: Fight) => actionById(fight, tool.action).spCost(fight),
    resolve(fight: Fight) {
      const a = actionById(fight, tool.action);
      a.resolve(fight);
      fight.me.cds[a.id] = fight.t + a.cooldownMs(fight);
    },
  }));
}

/** The kit's reaction, or the automatic one with the option on. */
export function reactWith(tools: DefenseTool[], own: Kit['react']): Kit['react'] {
  return (fight, s, from) => (autoDefense(fight) ? autoReact(fight, s, from, tools) : own(fight, s, from));
}

export const isPreempt = (a: Action) => a.id.startsWith('Pre-empt ');

/**
 * The kit's rotation, with a due prediction first when the option is on --
 * then, while a hard snap cast is due, standing ready (`hold`).
 */
export function priorityWith(predictors: () => Action[], own: Kit['priority'], hold?: Action): Kit['priority'] {
  return (fight) => {
    if (autoDefense(fight)) {
      for (const p of predictors()) {
        if (canUse(fight, p)) return p;
      }
      if (hold && canUse(fight, hold)) {
        // Moves and potions the kit wants still go; anything else waits.
        const want = own(fight);
        return !want.isSkill && !want.offensive && !want.idle ? want : hold;
      }
    }
    return own(fight);
  };
}
