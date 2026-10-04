/**
 * One fight, one player against one monster (and whatever it summons), in
 * milliseconds.
 *
 * The loop jumps from event to event -- the player free to act, a cast
 * finishing, a monster's next swing, a tick of a lingering area, a planned
 * dodge, a damage-over-time tick -- so a two-minute fight is a few hundred
 * steps, not 120,000.
 *
 * Two modes share the code:
 *   - rolled: the real fight, dice and all.
 *   - expect (Rng.expect): a planner rollout. Nothing is rolled; every chance
 *     becomes a weight on the damage, and monsters start no new casts,
 *     because a player cannot know one is coming. See `tas.ts`.
 *
 * Monsters think the way the server's rAthena AI does (RTM mob.cpp
 * mobskill_use, unit.cpp; .claude/scratch/formula-audit.md section e):
 *   - In melee, each attack cycle first tries the skill list, in order; every
 *     row rolls its own rate and the first that fires replaces the swing.
 *   - A row waits its delay from the start of its last cast. Conditions:
 *     HP below a share, "after skill X" (the last skill it started), number
 *     of adds, and events -- hit in melee, hit from range, hit by a skill,
 *     targeted by a cast -- that are tried the moment they happen.
 *   - After a cast it acts again 200-300 ms after the cast ends. A
 *     cancelable cast breaks when it takes damage.
 */
import {
  critChance, DOTS, dotTick, escapeMsFor, mobDamage, mobHitChance, perfectDodgeChance, playerHitChance, skillDelayMs,
  statusResist, TUNE, walkCellMs, type DotName,
} from './formulas.ts';
import type { Fighter, MobSkill, Monster, SelfBuff, StatusEffect } from './model.ts';
import { attackMask, BF, procOnAttack, procOnSkill, procWhenHit, type Autocast } from './autocast.ts';
import { mobRows } from './data.ts';
import { buildAdd } from './monster.ts';
import { Rng } from './rng.ts';

export interface Buff {
  until: number;
  stacks: number;
  /** Flee added while it lasts (Hallucination Walk; negative for Decrease AGI). */
  flee?: number;
  /** Chance, 0..1, to avoid a magic hit outright while it lasts. */
  magicDodge?: number;
  value?: number;
  value2?: number;
}

export interface PlayerState {
  hp: number;
  sp: number;
  /** Free to start something at this time. */
  busyUntil: number;
  /** An autocast's after-cast delay (autocast.ts): nothing starts before it, even past a cast it landed in. */
  canActAt?: number;
  cast: { action: string; endsAt: number; interruptible: boolean } | null;
  /** Skill -> the time it is ready again. */
  cds: Record<string, number>;
  buffs: Record<string, Buff>;
  /** One expiry time per Elemental Focus stack. */
  focus: number[];
  /** Once-a-fight things already spent. */
  spent: Record<string, true>;
  /** A dodge the TAS has planned for an incoming cast. */
  defense: { action: string; at: number; against: string } | null;
  /** The last action that went off: what `busyUntil` is the pause of (kits/defense.ts readyToDodge). */
  last?: string;
  /** Next natural regen ticks. */
  regenAt: { hp: number; sp: number; skill?: number };
  /** Uses left of limited actions, by id. */
  left: Record<string, number>;
  /** Damage over time on you: bleeding, burning, burnt. */
  dots: { name: string; nextAt: number; every: number; until: number; dmg: number; lethal: boolean; heal?: boolean; sp?: boolean; raw?: boolean }[];
}

/**
 * A lingering area still ticking: Storm Gust, Fire Wall, a meteor shower.
 * `leftBehind`: you stepped out as it went down, and the monster followed
 * you out of it, so none of its ticks reach you.
 */
export interface Channel {
  skill: MobSkill; nextAt: number; left: number; every: number; statusDone: boolean; leftBehind: boolean;
  /** You were behind cover when it landed: the rest of it misses too. */
  lostSight?: boolean;
  /** Pawn's Rod cancelled it as it landed. */
  cancelled?: boolean;
  /** Hidden through its first waves, you are out of it from this time (the walk after Hiding ends). */
  exitAt?: number;
}

export interface MobState {
  hp: number;
  nextAttackAt: number;
  cast: { skill: MobSkill; endsAt: number } | null;
  channels: Channel[];
  /** Skill (Aegis name) -> when its last cast started: its delay counts from there. */
  cds: Record<string, number>;
  /** The skill id it last started: "afterskill" reads it. */
  lastSkill: number;
  /** Skills it has landed at least once (Asura Strike is weaker after its first). */
  used: Record<string, true>;
  /** Still closing in: chase-state rows apply, attack-state ones do not. */
  rushing: boolean;
  /** Has swung at you: its first attack is always a normal one (RTM unit.cpp:2762). */
  swung?: boolean;
  /** What the kit put on it (kit-owned). */
  debuffs: Record<string, Buff & { value?: number }>;
  /** What it put on itself: Magic Mirror, Reflect Shield, Max Pain... */
  buffs: Record<string, Buff>;
  /** Monsters it summoned: each a full AI of its own, never killed. */
  adds: Actor[];
  /**
   * Your damage over time on it (Bleeding, Burning, Poison): a tick fixed when it landed, to the end of the fight.
   * With `hit`, each tick is that call instead (a ground skill of yours ticking on it: Underworld Rainstorm), `left` times.
   */
  dots: { name: string; nextAt: number; every: number; dmg: number; lethal: boolean; hit?: (fight: Fight) => void; left?: number }[];
}

/**
 * A monster in the fight: the target, or one of its adds. `reachAt`: an add
 * walking in (tools/farm.ts packs) is inside your area skills' reach from
 * this time on; Infinity for one that stays out (a ranged monster at its range).
 */
export interface Actor { m: Monster; st: MobState; add: boolean; reachAt?: number }

export interface Meter {
  /** Per action; sp is what it cost in all (percent costs read at the time). */
  actions: Record<string, { uses: number; hits: number; misses: number; crits: number; damage: number; sp?: number }>;
  taken: Record<string, { hits: number; avoided: number; damage: number }>;
  defenses: Record<string, number>;
  healed: number;
  /** Every action taken, in order: what the rotation turned out to be. */
  sequence: string[];
  /** The lowest HP reached. */
  minHp: number;
  /** Milliseconds a named state was up (a kit's debuff on the target: Night Wound). */
  uptime?: Record<string, number>;
  /** Waiting since the last action (Wait in a row): 1 s or more shows as an Idle step. */
  idleMs?: number;
}

/** Waits in a row this long show in the rotation as an Idle step (the project owner, 2026-10-02). */
export const IDLE_STEP_MS = 1000;

/** What a player can do. Kits (kits/*.ts) supply these. */
export interface Action {
  id: string;
  /** Blocked by silence. Normal attacks and walking are not skills. */
  isSkill: boolean;
  /** Breaks Hiding and New Moon's invisibility before it resolves. */
  offensive: boolean;
  /** Only ever planned in reaction to a cast, never picked as a move. */
  reactive?: boolean;
  /** Standing still (waiting on a swing timer): kept out of the meter and the log. */
  idle?: boolean;
  /** Uses per fight, when limited (Kafra Elixirs). */
  charges?: number;
  interruptible?: boolean;
  /** Share of your hard DEF lost while casting it (Queen's Gambit: 0.5). */
  castDefCut?: number;
  /** Reaches a monster that has hidden or cloaked itself, which nothing targeted can (Queen's Gambit on Famine Incarnate). */
  findsCloaked?: boolean;
  ready?(fight: Fight): boolean;
  castMs(fight: Fight): number;
  /** The pause after it. Defaults to the attack motion. */
  delayMs?(fight: Fight): number;
  cooldownMs(fight: Fight): number;
  spCost(fight: Fight): number;
  hpCost?(fight: Fight): number;
  resolve(fight: Fight): void;
}

export interface Kit {
  className: string;
  actions: Action[];
  /** What each action is for, for the damage breakdown: "combo", "filler"... */
  roles?: Record<string, string>;
  /** The action a rotation cycle starts with, for finding the loop (New Moon). */
  cycleAnchor?: string;
  /** Roles that make up the core loop; the rest count as fillers. */
  coreRoles?: string[];
  /** Actions whose damage is magic: left out of the DEF analysis. */
  magicActions?: string[];
  /**
   * Regen the class keeps up out of combat (Knight's Regen, King's Fortress),
   * as HP and SP per second, net of any upkeep: the farm tool adds it between
   * fights, where a fight's own ticks do not run.
   */
  idleRegen?(f: Fighter, options: Record<string, unknown>): { hpPerSec: number; spPerSec: number };
  /**
   * Seconds between fights to win back `sp` and `hp`, when the class has a better way than sitting
   * (Satsujin's Lotus Pact); `sitS` is the plain sit at `regen` (rhythm.ts sitFor), `cycleS` the
   * rest of the cycle (fight and walk) -- for a recovery skill's cooldown.
   */
  recoverFor?(f: Fighter, options: Record<string, unknown>, need: { sp: number; hp: number }, regen: { sp: number; hp: number }, sitS: number, cycleS: number): number;
  /** What `prep` put up, in words: "Seven Winds: Holy". */
  prepNotes?(fight: Fight): string[];
  /** The rotation as the player would write it: the rollout policy. */
  priority(fight: Fight): Action;
  /** A monster's hit landed on you (after every dodge): Duel Counters and the like. */
  onHurt?(fight: Fight, hit: { physical: boolean; normal: boolean; ranged: boolean; dmg: number }): void;
  /** A monster's hit was cancelled by Weapon Blocking: `share` 1 rolled, or its chance in a rollout. */
  onBlock?(fight: Fight, share: number): void;
  /** A cast bar just appeared: plan a dodge, or return null to take it. */
  react(fight: Fight, skill: MobSkill, from: Monster): { action: string; at: number } | null;
  /** Buffs put up before the pull. */
  prep(fight: Fight): void;
  /**
   * Skills that put you on the target at once (Rook's Smash, Shadow Slash):
   * with one ready, walking back after a dodge costs nothing (the project
   * owner, 2026-09-28). Only read with mobility 'server'.
   */
  gapClosers?: string[];
  /** Holding on purpose (kits/defense.ts: standing ready for a snap cast): not out of SP. */
  holding?(fight: Fight): boolean;
  /**
   * The states its combos run on, yours and the target's (Combo Ready,
   * Overslash stacks, Duel Counters; Bishop's Tax on the target): a traced
   * fight (Fight.trace) records them after every action, for the web app's
   * Rotation overlay.
   */
  statuses?(fight: Fight): StatusMark[];
  /**
   * Cast one of its own skills as a gear autocast (autocast.ts), `share` of
   * it (1 rolled; the chance in a rollout -- scale the damage by it): true if
   * it did. Unset, or false: its action of that name, else the generic cast.
   */
  castAutocast?(fight: Fight, skill: string, level: number, share: number): boolean;
  /** Autocasts it models itself (class rules, patch numbers newer than the crawl): autocast.ts leaves them alone. */
  ownsAutocast?(a: Autocast): boolean;
  /** The weapon's element now, endows included: what a generic autocast of a weapon-element skill takes. */
  weaponElement?(fight: Fight): string;
}

/** One state as a traced fight shows it: "Combo Ready" 2.4 s, "Overslash" x5, a shield's amount, or on the target. */
export interface StatusMark { label: string; stacks?: number; leftMs?: number; value?: number; onTarget?: boolean }

/**
 * A kit's statuses read off the fight: `me` buffs (stacks shown when asked),
 * the target's debuffs and self-buffs, and its damage over time by name.
 */
export function readMarks(fight: Fight, spec: {
  me?: { key: string; label: string; stacks?: boolean; value?: boolean }[];
  target?: { key: string; label: string }[];
  dots?: Record<string, string>;
}): StatusMark[] {
  const out: StatusMark[] = [];
  const left = (until: number) => (until >= 1e11 ? undefined : Math.max(0, until - fight.t));
  for (const x of spec.me ?? []) {
    const b = fight.me.buffs[x.key];
    if (!b || b.until <= fight.t || (x.stacks && !b.stacks) || (x.value && !b.value)) continue;
    out.push({ label: x.label, leftMs: left(b.until), ...(x.stacks ? { stacks: b.stacks } : {}), ...(x.value ? { value: Math.round(b.value ?? 0) } : {}) });
  }
  for (const x of spec.target ?? []) {
    const b = fight.mob.debuffs[x.key] ?? fight.mob.buffs[x.key];
    if (b && b.until > fight.t) out.push({ label: x.label, leftMs: left(b.until), onTarget: true });
  }
  for (const d of fight.mob.dots) {
    const label = spec.dots?.[d.name];
    if (label) out.push({ label, onTarget: true, ...(d.left !== undefined ? { leftMs: d.left * d.every } : {}) });
  }
  return out;
}
/** An action as a traced fight saw it go off: the states after it, and what autocast inside it. */
export interface TraceStep { id: string; t: number; states: StatusMark[]; procs: string[] }

/** Something that went off inside an action -- an autocast (Haunting Slice's Scythe Reap): kept with the step in a traced fight. */
export function noteProc(fight: Fight, label: string) {
  if (fight.trace) (fight.procs ??= []).push(label);
}
function traceStep(fight: Fight, a: Action) {
  if (!fight.trace) return;
  fight.trace.push({ id: a.id, t: fight.t, states: fight.kit.statuses?.(fight) ?? [], procs: fight.procs ?? [] });
  fight.procs = [];
}

export type Policy = (fight: Fight) => Action;

export interface Fight {
  t: number;
  limitMs: number;
  rng: Rng;
  f: Fighter;
  m: Monster;
  kit: Kit;
  me: PlayerState;
  /** The target's state. Its adds are in `mob.adds`. */
  mob: MobState;
  policy: Policy;
  /** Kit options from the profile ("backStab": false, ...). */
  options: Record<string, unknown>;
  /** Consumables carried (items.ts): drunk whenever one is wanted. */
  items: Action[];
  /** Holes on the ground (Manhole): step in and nothing can hurt you for a moment. */
  ground: { manholeUntil: number };
  meter: Meter | null;
  log: string[] | null;
  /** Adds your area skills killed (tools/farm.ts packs); the target's death is `result`. */
  killed?: Actor[];
  /**
   * How it ended. A stalemate is neither side dying: the clock ran out, or
   * the player can no longer afford any damage skill (the project owner,
   * 2026-09-26) -- so no fight runs forever.
   */
  result: 'win' | 'loss' | 'stalemate' | null;
  /** Why the fight ended, for a loss or a stalemate. */
  cause?: string;
  /** Dodges planned against a cast bar and not taken (option fumble). */
  fumbles?: number;
  /** An early stall: when the fight was stopped (t is then the limit, as the clock would have run). */
  stoppedAt?: number;
  /** With newFight's trace: every action and the states after it (TraceStep). */
  trace?: TraceStep[];
  /** Autocasts noted since the last traced step (noteProc). */
  procs?: string[];
  /** Inside an autocast weighed in a rollout: the share of its damage and healing that counts (autocast.ts). */
  procShare?: number;
  /** Autocasts running inside autocasts, and the ones running now (no autocast sets itself off again). */
  procDepth?: number;
  procLock?: Set<Autocast>;
}

export const newMobState = (m: Monster): MobState => ({
  hp: m.hp, nextAttackAt: 0, cast: null, channels: [], cds: {}, lastSkill: 0, used: {}, rushing: true,
  debuffs: {}, buffs: {}, adds: [], dots: [],
});

export function newFight(
  f: Fighter, m: Monster, kit: Kit, policy: Policy,
  o: {
    seed: number; limitMs: number; log?: boolean; options?: Record<string, unknown>; items?: Action[];
    /** Record every action and the kit's statuses after it (Fight.trace). */
    trace?: boolean;
  },
): Fight {
  const fight: Fight = {
    t: 0,
    limitMs: o.limitMs,
    rng: new Rng(o.seed),
    f, m, kit, policy,
    options: o.options ?? {},
    items: o.items ?? [],
    me: {
      hp: f.maxHp, sp: f.maxSp, busyUntil: 0, cast: null, cds: {}, buffs: {}, focus: [],
      spent: {}, defense: null, regenAt: { hp: TUNE.hpRegenMs, sp: TUNE.spRegenMs, skill: TUNE.skillRegenMs },
      left: Object.fromEntries((o.items ?? []).filter((a) => a.charges !== undefined)
        .map((a) => [a.id, a.charges!])),
      dots: [],
    },
    mob: newMobState(m),
    ground: { manholeUntil: -1 },
    meter: { actions: {}, taken: {}, defenses: {}, healed: 0, sequence: [], minHp: f.maxHp },
    log: o.log ? [] : null,
    ...(o.trace ? { trace: [] } : {}),
    result: null,
  };
  kit.prep(fight);
  const setup = kit.prepNotes?.(fight) ?? [];
  // Before the pull: a block of its own, one buff or state a line, so the
  // log stays as narrow as its fight lines.
  if (setup.length && fight.log) fight.log.push('[PREFIGHT]', ...setup.map((s) => `  ${s}`), '');
  // The pull: the monster swings once it closes in. A training dummy never does.
  fight.mob.nextAttackAt = Number.isFinite(m.adelay) ? Math.min(m.adelay, 500) : Infinity;
  return fight;
}

const actors = (fight: Fight): Actor[] => [{ m: fight.m, st: fight.mob, add: false }, ...fight.mob.adds];

// ---- buffs -----------------------------------------------------------------

/** Lotus Pact's chance that a hit does nothing (RTM battle.cpp:1306). */
export const LOTUS_BLOCK = 0.4;
export const has = (fight: Fight, buff: string) => (fight.me.buffs[buff]?.until ?? -1) > fight.t;
export const stacks = (fight: Fight, buff: string) => (has(fight, buff) ? fight.me.buffs[buff].stacks : 0);
export function grant(
  fight: Fight, buff: string, ms: number, n = 1, extra?: Pick<Buff, 'flee' | 'magicDodge' | 'value' | 'value2'>,
) {
  fight.me.buffs[buff] = { until: fight.t + ms, stacks: n, ...extra };
}

/** Flee and magic dodge from the buffs running now. */
function buffed(fight: Fight): { flee: number; magicDodge: number } {
  let flee = 0; let md = 0;
  for (const k in fight.me.buffs) {
    const b = fight.me.buffs[k];
    if (b.until <= fight.t) continue;
    flee += b.flee ?? 0;
    md = 1 - (1 - md) * (1 - (b.magicDodge ?? 0));
  }
  return { flee, magicDodge: md };
}
export const drop = (fight: Fight, buff: string) => { delete fight.me.buffs[buff]; };
export const mobHas = (fight: Fight, debuff: string) => (fight.mob.debuffs[debuff]?.until ?? -1) > fight.t;
const selfHas = (fight: Fight, st: MobState, sc: string) => (st.buffs[sc]?.until ?? -1) > fight.t;

/** Can't act: stunned, frozen, stoned, asleep, held in a Cursed Circle or a Manhole. */
export const disabled = (fight: Fight) => has(fight, 'stunned');

/** Live Elemental Focus stacks. */
export function focusStacks(fight: Fight): number {
  fight.me.focus = fight.me.focus.filter((u) => u > fight.t);
  return fight.me.focus.length;
}

// ---- using actions ---------------------------------------------------------

export const readyAt = (fight: Fight, id: string) => fight.me.cds[id] ?? 0;

export function canUse(fight: Fight, a: Action): boolean {
  const me = fight.me;
  if (a.isSkill && has(fight, 'silenced')) return false;
  if (disabled(fight)) return false;
  if (readyAt(fight, a.id) > fight.t) return false;
  if (a.charges !== undefined && (me.left[a.id] ?? 0) <= 0) return false;
  if (a.spCost(fight) > me.sp) return false;
  if ((a.hpCost?.(fight) ?? 0) >= me.hp) return false;
  // A hidden or cloaked monster cannot be targeted: attacks wait, not hit nothing.
  if (a.offensive && !a.findsCloaked && mobCloaked(fight)) return false;
  return a.ready?.(fight) ?? true;
}

/** The monster has hidden or cloaked itself (Famine Incarnate's Invisible). */
export const mobCloaked = (fight: Fight) => selfHas(fight, fight.mob, 'hiding') || selfHas(fight, fight.mob, 'invisible');

function start(fight: Fight, a: Action) {
  const cast = a.castMs(fight);
  if (cast > 0) {
    fight.me.cast = { action: a.id, endsAt: fight.t + cast, interruptible: a.interruptible ?? true };
    fight.me.busyUntil = fight.t + cast;
    fight.log && say(fight, `casts ${a.id} (${(cast / 1000).toFixed(2)}s)`);
    // A cast bar on it is an event the monster may answer (casttargeted).
    if (a.offensive) mobEvent(fight, { m: fight.m, st: fight.mob, add: false }, 'casttargeted');
  } else {
    complete(fight, a);
  }
}

function complete(fight: Fight, a: Action) {
  const me = fight.me;
  me.cast = null;
  // Costs are paid when the skill goes off, as in the game.
  const spPaid = a.spCost(fight);
  me.sp -= spPaid;
  const hpCost = a.hpCost?.(fight) ?? 0;
  if (hpCost) me.hp -= hpCost;
  // Attacking ends Hiding. Invisibility (New Moon, Jutsu) ends on an attack
  // or on any skill at all (the project owner, 2026-09-26); a potion is neither.
  if (a.offensive) drop(fight, 'hidden');
  if (a.offensive || a.isSkill) drop(fight, 'invisible');
  // Attacking again means you are back in reach.
  if (a.offensive) drop(fight, 'away');
  me.cds[a.id] = fight.t + a.cooldownMs(fight);
  if (a.charges !== undefined) me.left[a.id] = (me.left[a.id] ?? 0) - 1;
  me.busyUntil = Math.max(fight.t + (a.delayMs?.(fight) ?? skillDelayMs(0, fight.f)), me.canActAt ?? 0);
  me.last = a.id;
  const meter = fight.meter;
  if (a.id === 'Wait') { if (meter) meter.idleMs = (meter.idleMs ?? 0) + (me.busyUntil - fight.t); }
  else if (meter && !a.idle) {
    // A stretch of waiting long enough to see: an Idle step ahead of what ends it.
    if ((meter.idleMs ?? 0) >= IDLE_STEP_MS) {
      meter.sequence.push('Idle');
      fight.trace?.push({ id: 'Idle', t: fight.t, states: fight.kit.statuses?.(fight) ?? [], procs: [] });
    }
    meter.idleMs = 0;
  }
  if (a.idle) return;
  if (meter) {
    const row = (meter.actions[a.id] ??= { uses: 0, hits: 0, misses: 0, crits: 0, damage: 0 });
    row.uses++;
    row.sp = (row.sp ?? 0) + spPaid;
    meter.sequence.push(a.id);
  }
  // Attacks log their damage; a buff or a move says it happened.
  if (!a.offensive && !a.reactive) fight.log && say(fight, `uses ${a.id}`);
  if (!fight.f.trueGoddess || !a.isSkill) { resolveSkill(fight, a); traceStep(fight, a); return; }
  // True Goddess: whatever this cast put on cooldown (itself, or the skill it
  // stands for: Predict Kawarimi -> Kawarimi) waits 10 s at least, and Kaupe
  // Lv3 blocks the next hit that lands for 2 s.
  const before = { ...me.cds };
  resolveSkill(fight, a);
  for (const id of new Set([a.id, ...Object.keys(me.cds).filter((k) => me.cds[k] !== before[k])])) {
    me.cds[id] = Math.max(me.cds[id] ?? 0, fight.t + TUNE.trueGoddessCdMs);
  }
  grant(fight, 'kaupe', TUNE.kaupeMs, 1);
  traceStep(fight, a);
}

/**
 * An action going off, and the gear autocasts that follow a skill
 * (skill_onskillusage): a damage skill only when it dealt damage
 * (skill.cpp:4153), any other skill always (12397, 13838).
 */
function resolveSkill(fight: Fight, a: Action) {
  const before = fight.mob.hp;
  a.resolve(fight);
  if (a.isSkill && fight.f.autocasts?.length && (!a.offensive || fight.mob.hp < before)) procOnSkill(fight, a.id);
}

/**
 * Stepping into a Manhole a monster dug (Goddess Freya, Vision of Surt): for
 * 3s nothing can hurt you and you can do nothing (SC__MANHOLE, RTM
 * battle.cpp:1195; 3s is RTM's Duration2). The way the Freya fight expects
 * a player to take the Adoramus that follows (the project owner, 2026-09-26).
 */
export const MANHOLE_MS = 3000;
export const enterManhole: Action = {
  id: 'Enter Manhole',
  isSkill: false,
  offensive: false,
  reactive: true,
  ready: (fight) => fight.ground.manholeUntil > fight.t && !has(fight, 'rooted'),
  castMs: () => 0,
  delayMs: () => MANHOLE_MS,
  cooldownMs: () => 0,
  spCost: () => 0,
  resolve(fight) {
    grant(fight, 'stunned', MANHOLE_MS);
    grant(fight, 'invulnerable', MANHOLE_MS);
    fight.ground.manholeUntil = -1;
  },
};

/** Actions by id, per kit and per consumables list: looked up on every cast. */
const idMaps = new WeakMap<object, Map<string, Action>>();
const byId = (list: Action[]) => {
  let m = idMaps.get(list);
  if (!m) { m = new Map(); for (const a of list) if (!m.has(a.id)) m.set(a.id, a); idMaps.set(list, m); }
  return m;
};

export function actionById(fight: Fight, id: string): Action {
  if (id === enterManhole.id) return enterManhole;
  const a = byId(fight.kit.actions).get(id) ?? byId(fight.items).get(id);
  if (!a) throw new Error(`kit has no action ${id}`);
  return a;
}

// ---- damage both ways ------------------------------------------------------

export interface Strike {
  /** Damage of one hit, given whether it crits. Rolls its own variance. */
  damage: (crit: boolean) => number;
  hits: number;
  /**
   * Fake multi-hit: one hit's damage, shown split into `hits` pieces, with
   * one HIT roll and one crit roll for the lot. Thousand Arms. A true
   * multi-hit (Million Stab) leaves this off: every hit is its own.
   */
  split?: boolean;
  /** False for talismans and the like: no HIT roll. */
  canMiss: boolean;
  /** Crit chance bonus in points, or null if it cannot crit. */
  critBonus: number | null;
  /** What kind of hit it is, for the monster's defences and its "attacked" events. Default melee. */
  kind?: 'melee' | 'ranged' | 'magic';
  /** A skill rather than a normal attack (the "skillused" event). */
  skill?: boolean;
  /** An area: it hits a monster that has hidden or cloaked itself (the project owner, 2026-10-01: "any aoe can hit invisible enemies"). */
  aoe?: boolean;
  /** HIT added for this skill only (Definitive Dagger "Hit bonus is 5 per level"). */
  hitBonus?: number;
  /** Server BF_MISC damage (Blitz Beat, traps): what gear autocasts match it against (autocast.ts). */
  misc?: boolean;
}

/**
 * The monster's own defences against one of your hits, as a multiplier, with
 * what they send back. RTM battle.cpp / status.cpp values via skill-effects.json.
 */
function mobGuard(fight: Fight, kind: NonNullable<Strike['kind']>, aoe = false): { mult: number; reflect: number } {
  const st = fight.mob; const m = fight.m;
  // An Ignore* mode is not immunity: every hit does 1 (strike, RTM battle.cpp:2652 is_infinite_defense).
  if (m.ignores?.includes(kind)) return { mult: 1, reflect: 0 };
  const on = (sc: string) => selfHas(fight, st, sc);
  const v = (sc: string) => st.buffs[sc]?.value ?? 0;
  if (!aoe && (on('hiding') || on('invisible'))) return { mult: 0, reflect: 0 };
  // Max Pain: it takes nothing; weapon hits send a share back (RTM battle.cpp:1417, 5839).
  if (on('maxpain')) return { mult: 0, reflect: kind === 'magic' ? 0 : (v('maxpain') || 10) / 100 };
  let mult = 1; let reflect = 0;
  if (kind === 'ranged' && on('pneuma')) return { mult: 0, reflect: 0 };
  if (kind === 'melee' && on('safetywall')) {
    const b = st.buffs.safetywall;
    if (--b.stacks <= 0) delete st.buffs.safetywall;
    return { mult: 0, reflect: 0 };
  }
  if (kind === 'melee' && on('autoguard')) mult *= 1 - v('autoguard') / 100;
  if (kind === 'ranged' && on('defender')) mult *= 1 - v('defender') / 100;
  if (on('assumptio')) mult *= 1 - (v('assumptio') || 50) / 100;
  if (on('kyrie') && kind !== 'magic') {
    const b = st.buffs.kyrie;
    if (--b.stacks <= 0) delete st.buffs.kyrie;
    return { mult: 0, reflect: 0 };
  }
  // Mirror Break (KG_KYOMU, kits/revenant.ts): a target under it reflects nothing (RTM battle.cpp:7816).
  const broken = (st.debuffs.kyomu?.until ?? -1) > fight.t;
  if (kind === 'melee' && on('reflectshield') && !broken) reflect += v('reflectshield') / 100;
  if (kind === 'magic' && on('magicmirror') && !broken) reflect += v('magicmirror') / 100;
  return { mult, reflect };
}

/**
 * Gear that may kill you on your own attack: Unstable Crystal Card's "2%
 * Chance to explode when auto-attacking or using physical skills" is
 * percentheal -100,-100 (RTM item_db_etc.yml:33790), which kills
 * (pc_percentheal -> status_percent_damage(..., hp == -100), pc.cpp:9882).
 * The tooltip's chance, once per physical action.
 */
const explodeChance = new WeakMap<Fighter, number>();
function explodes(fight: Fight): boolean {
  let p = explodeChance.get(fight.f);
  if (p === undefined) {
    p = 0;
    for (const m of (fight.f.gearText ?? '').matchAll(/(\d+)%\s+chance\s+to\s+explode\s+when\s+auto-attacking\s+or\s+using\s+physical\s+skills/gi)) p += Number(m[1]) / 100;
    explodeChance.set(fight.f, p);
  }
  return p > 0 && !fight.rng.expect && fight.rng.chance(p);
}

/** Land an attack on the monster, rolling (or weighing) hit and crit per hit. */
export function strike(fight: Fight, id: string, s: Strike): number {
  const { f, m, rng } = fight;
  if ((s.kind ?? 'melee') !== 'magic' && !fight.result && explodes(fight)) {
    fight.me.hp = 0;
    fight.result = 'loss';
    fight.cause = 'Unstable Crystal Card (explodes)';
    fight.log && say(fight, `explodes (Unstable Crystal Card): dies`);
    return 0;
  }
  const kind = s.kind ?? 'melee';
  const monsterFlee = m.flee + (selfHas(fight, fight.mob, 'hallucination') ? fight.mob.buffs.hallucination.value ?? 0 : 0);
  // Perfect Hit lands whatever the flee (RTM battle.cpp:2916), after the crit check.
  const perfect = (f.perfectHit ?? 0) / 100;
  const pHit = s.canMiss ? perfect + (1 - perfect) * playerHitChance(f.hit + (s.hitBonus ?? 0), monsterFlee) : 1;
  const pCrit = s.critBonus === null ? 0 : critChance(f, m, s.critBonus);
  // A crit always lands (RTM battle.cpp:2914); the rest roll HIT.
  const pLand = pCrit + (1 - pCrit) * pHit;
  const row = fight.meter ? (fight.meter.actions[id] ??= { uses: 0, hits: 0, misses: 0, crits: 0, damage: 0 }) : null;
  const guard = mobGuard(fight, kind, !!s.aoe);
  const plant = !!m.ignores?.includes(kind);
  if (rng.expect && s.canMiss) void pLand;
  let total = 0; let crits = 0; let misses = 0; let reflected = 0;
  const rolls = s.split ? 1 : s.hits;
  // The monster's share of every hit: its DamageTaken, or the boss protocol.
  // Bishop's Tax and Sneak Attack's mark do not stack: the owner's King's
  // Chains read +15% with both up, not +30% (2026-09-26).
  const exposed = Math.max(selfHas(fight, fight.mob, 'tax') ? fight.mob.buffs.tax.value ?? 0 : 0,
    selfHas(fight, fight.mob, 'raid') ? fight.mob.buffs.raid.value ?? 0 : 0);
  // An autocast weighed into a rollout counts at its chance (autocast.ts).
  const taken = m.damageTaken * guard.mult * (1 + exposed / 100) * (fight.procShare ?? 1);
  for (let i = 0; i < rolls; i++) {
    let dmg: number;
    if (rng.expect) {
      dmg = pCrit * s.damage(true) + (1 - pCrit) * pHit * s.damage(false);
    } else {
      const crit = rng.chance(pCrit);
      if (!crit && !rng.chance(pHit)) { misses++; if (row) row.misses++; continue; }
      dmg = s.damage(crit);
      if (crit) { crits++; if (row) row.crits++; }
    }
    const raw = dmg;
    // Infinite defense (Ymir Emperium, plants: an Ignore* mode for this kind of
    // hit): 1 a hit, a fake multi-hit's pieces each counting (the server's div).
    if (plant) dmg = (s.split ? s.hits : 1) * (rng.expect ? pLand : 1);
    else dmg = Math.floor(dmg * taken);
    // Reflect Shield sends back a share of what it actually took; Max Pain
    // takes nothing and returns a share of what the hit would have done.
    reflected += (guard.mult > 0 ? dmg : raw * m.damageTaken) * guard.reflect;
    total += dmg;
    if (row) { row.hits++; row.damage += dmg; }
    leech(fight, dmg, kind !== 'magic');
  }
  if (fight.log) {
    const shield = guard.mult === 0 ? ' (blocked)' : '';
    fight.log && say(fight, `${id} → ${strikeText(total, s.hits, rolls, crits, misses, !!s.split)}${shield}`);
  }
  hurtMob(fight, total);
  if (reflected > 0 && !fight.result) {
    // Gear that "ignores reflect" cuts it by its percent but never below 1
    // (RTM battle.cpp:7873-7878, bReduceDamageReturn).
    hurtMe(fight, Math.max(1, Math.floor(reflected * (1 - Math.min(100, f.reflectReduce) / 100))), `${m.name}: reflected`);
  }
  // Being hit is an event the monster may answer, and breaks a cancelable cast.
  if (total > 0 && !fight.result) {
    const cast = fight.mob.cast;
    if (cast?.skill.ai.cancelable && !rng.expect) {
      fight.log && say(fight, `${m.name}'s ${cast.skill.name} is interrupted`);
      fight.mob.cast = null;
      fight.mob.nextAttackAt = fight.t + 250;
    }
    const me = { m, st: fight.mob, add: false };
    mobEvent(fight, me, kind === 'melee' ? 'closedattacked' : kind === 'ranged' ? 'longrangeattacked' : null);
    if (s.skill ?? id !== 'Attack') mobEvent(fight, me, 'skillused');
  }
  // Gear autocasts when attacking: a hit that landed -- blocked counts, a
  // miss does not -- on a target still standing (skill.cpp:2451-2528).
  if (!fight.result && fight.f.autocasts?.length) {
    const landed = rng.expect ? (s.canMiss ? pLand : 1) : misses < rolls ? 1 : 0;
    if (landed > 0) procOnAttack(fight, attackMask(kind, s.skill ?? id !== 'Attack', s.misc), landed);
  }
  return total;
}

/** "12,345 (10 hits, 3 crit, 1 miss)", "4,971 CRIT", "miss". */
function strikeText(
  total: number, shown: number, rolls: number, crits: number, misses: number, split: boolean,
): string {
  if (misses === rolls) return rolls > 1 ? `miss (all ${rolls})` : 'miss';
  if (rolls === 1) return `${fmt(total)}${crits ? ' CRIT' : ''}${shown > 1 ? ` (${shown} hits${split ? ', split' : ''})` : ''}`;
  const parts = [`${shown} hits`];
  if (crits) parts.push(`${crits} crit`);
  if (misses) parts.push(`${misses} miss`);
  return `${fmt(total)} (${parts.join(', ')})`;
}

function leech(fight: Fight, dmg: number, physical = true) {
  const l = fight.f.leech;
  // Vampire Mark (GN_BLOOD_SUCKER): physical hits only, its own chance and power (kits/revenant.ts).
  const vm = fight.me.buffs.vampireMark;
  if (physical && dmg > 0 && vm && vm.until > fight.t) {
    const p = Math.min(1, (vm.value ?? 0) / 100); const power = (vm.value2 ?? 0) / 100;
    const heal = fight.rng.expect ? dmg * p * power : fight.rng.chance(p) ? dmg * power : 0;
    if (heal > 0) leechHeal(fight, heal);
  }
  // A flat HP / SP on every hit that lands ("Leech 5 HP per hit", bHPDrainValue).
  if (dmg > 0 && l.hpPerHit) heal_(fight, l.hpPerHit);
  if (dmg > 0 && l.spPerHit) fight.me.sp = Math.min(fight.f.maxSp, fight.me.sp + l.spPerHit);
  // SP leech, the same roll on its own rate (bSPDrainRate).
  if (dmg > 0 && l.spRate && l.spPower) {
    const sp = fight.rng.expect
      ? dmg * Math.min(1, l.spRate / 100) * l.spPower / 100
      : fight.rng.chance(l.spRate / 100) ? dmg * l.spPower / 100 : 0;
    if (sp > 0) fight.me.sp = Math.min(fight.f.maxSp, fight.me.sp + Math.floor(sp));
  }
  if (!l.hpRate || !l.hpPower) return;
  const heal = fight.rng.expect
    ? dmg * Math.min(1, l.hpRate / 100) * l.hpPower / 100
    : fight.rng.chance(l.hpRate / 100) ? dmg * l.hpPower / 100 : 0;
  if (heal > 0) leechHeal(fight, heal);
}

/**
 * HP leeched. With an overheal rule up (buff 'ominous': value the share of
 * overheal kept, value2 the cap -- Ominous Presence, kits/revenant.ts) what
 * would spill past Max HP becomes a shield for 30 s, refreshed by new overheal.
 */
function leechHeal(fight: Fight, heal: number) {
  const om = fight.me.buffs.ominous;
  const room = fight.f.maxHp - fight.me.hp;
  heal_(fight, heal);
  if (!om || om.until <= fight.t || heal <= room) return;
  const cur = fight.me.buffs.overheal;
  const held = cur && cur.until > fight.t ? cur.value ?? 0 : 0;
  fight.me.buffs.overheal = { until: fight.t + 30_000, stacks: 1, value: Math.min(om.value2 ?? 0, held + (heal - Math.max(0, room)) * (om.value ?? 0)) };
}

/**
 * An area hit on the adds in reach (Fan of Knives on a pack): their
 * DamageTaken, your leech, and a dead add leaves the fight (`fight.killed`).
 * No HIT roll and no crit: for skills that ignore flee.
 */
export function strikeAdds(fight: Fight, id: string, damage: (m: Monster) => number): number {
  let total = 0;
  const row = fight.meter ? (fight.meter.actions[id] ??= { uses: 0, hits: 0, misses: 0, crits: 0, damage: 0 }) : null;
  for (const a of [...fight.mob.adds]) {
    if ((a.reachAt ?? 0) > fight.t || a.m.ignores?.includes('melee')) continue;
    const dmg = Math.floor(damage(a.m) * a.m.damageTaken);
    a.st.hp -= dmg; total += dmg;
    if (row) { row.hits++; row.damage += dmg; }
    leech(fight, dmg);
    if (a.st.hp <= 0) {
      fight.mob.adds = fight.mob.adds.filter((x) => x !== a);
      (fight.killed ??= []).push(a);
      fight.log && say(fight, `${a.m.name} dies`);
    }
  }
  return total;
}

export function heal_(fight: Fight, amount: number) {
  // Critical Wound: healing received cut (potions included, RTM).
  if (has(fight, 'criticalwound')) amount *= Math.max(0, 1 - (fight.me.buffs.criticalwound.value ?? 60) / 100);
  amount *= fight.procShare ?? 1;
  const before = fight.me.hp;
  fight.me.hp = Math.min(fight.f.maxHp, fight.me.hp + amount);
  if (fight.meter) fight.meter.healed += fight.me.hp - before;
}

export function hurtMob(fight: Fight, dmg: number) {
  fight.mob.hp -= dmg;
  if (fight.mob.hp <= 0 && !fight.result) {
    fight.result = 'win';
    fight.log && say(fight, `${fight.m.name} dies`);
  }
}

/**
 * Damage landing on the player. Invisibility halves it and ends (the
 * project owner); Lex Aeterna doubles it and ends; a Manhole takes it all.
 */
function hurtMe(fight: Fight, dmg: number, source: string, lethal = true): number {
  const me = fight.me;
  if (has(fight, 'invulnerable')) return 0;
  if (has(fight, 'invisible')) { dmg /= 2; drop(fight, 'invisible'); }
  if (has(fight, 'aeterna')) { dmg *= 2; drop(fight, 'aeterna'); }
  // Finisher Ready: half of the next hit (RTM battle.cpp:1563). Since Refuge
  // Patch 18 (2026-09-18) a hit no longer ends the buff -- "its 50% damage
  // reduction protects against only the next hit; reapplying the buff
  // restores this protection" -- so the guard is its stacks (1 up, 0 used)
  // and the buff runs its time for the skills that read it. Rook's Wall
  // keeps the guard up (the 2023 code, status.cpp:2352).
  const fin = me.buffs.finisher;
  if (dmg > 0 && fin && fin.until > fight.t && fin.stacks > 0) {
    dmg *= 0.5;
    if (!has(fight, 'defender')) fin.stacks = 0;
  }
  // Ominous Presence's shield (overheal from leech, kits/revenant.ts): soaks what it holds.
  const oh = me.buffs.overheal;
  if (dmg > 0 && lethal && oh && oh.until > fight.t && (oh.value ?? 0) > 0) {
    const soak = Math.min(dmg, oh.value ?? 0);
    dmg -= soak;
    oh.value = (oh.value ?? 0) - soak;
  }
  // Queen's Barrier: soaks a pool of HP or a number of hits, whichever runs out first.
  const bar = me.buffs.barrier;
  if (dmg > 0 && lethal && bar && bar.until > fight.t) {
    const soak = Math.min(dmg, bar.value ?? 0);
    dmg -= soak;
    bar.value = (bar.value ?? 0) - soak;
    bar.stacks -= 1;
    if (bar.stacks <= 0 || (bar.value ?? 0) <= 0) drop(fight, 'barrier');
  }
  dmg = Math.floor(dmg);
  if (!lethal) dmg = Math.min(dmg, Math.max(0, me.hp - 1));
  me.hp -= dmg;
  if (fight.meter) {
    const row = (fight.meter.taken[source] ??= { hits: 0, avoided: 0, damage: 0 });
    row.hits++; row.damage += dmg;
    fight.meter.minHp = Math.min(fight.meter.minHp, me.hp);
  }
  if (dmg > 0) fight.log && say(fight, `takes ${fmt(dmg)} from ${source}`);
  // Stone and freeze break on any damage: you are free to act again.
  if (dmg > 0 && (has(fight, 'stoned') || has(fight, 'frozen'))) {
    drop(fight, 'stoned'); drop(fight, 'frozen');
    if (me.buffs.stunned?.value === 1) {
      drop(fight, 'stunned');
      me.busyUntil = Math.min(me.busyUntil, fight.t);
    }
    say(fight, 'the hit breaks the stone / freeze');
  }
  if (dmg > 0 && me.cast?.interruptible && !fight.f.endure && !has(fight, 'endure') && !fight.rng.expect) {
    fight.log && say(fight, `${me.cast.action} interrupted`);
    me.cast = null;
    me.busyUntil = fight.t;
  }
  if (me.hp <= 0 && !fight.result) {
    fight.result = 'loss';
    fight.cause = source;
    fight.log && say(fight, `dies to ${source}`);
  }
  return dmg;
}

/** A drain gives the monster back what it took. */
function drained(fight: Fight, a: Actor, s: MobSkill, dmg: number) {
  if (!s.drain || dmg <= 0) return;
  a.st.hp = Math.min(a.m.hp, a.st.hp + dmg);
  fight.log && say(fight, `${a.m.name} drains ${fmt(dmg)} HP`);
}

function avoided(fight: Fight, source: string, how: string) {
  if (fight.meter) (fight.meter.taken[source] ??= { hits: 0, avoided: 0, damage: 0 }).avoided++;
  fight.log && say(fight, `avoids ${source} (${how})`);
}

// ---- the monsters ----------------------------------------------------------

export const NORMAL: MobSkill = {
  name: 'Attack', skill: 'ATTACK', skillId: 0, level: 1, kind: 'physical', type: 'physical', element: 'Neutral',
  targets: 'single', ratio: 100, hits: 1, ticks: 1, tickMs: 0, durationMs: 0, castMs: 0,
  ai: { state: 'attack', rate: 1, delayMs: 0, cancelable: false, cond: 'always', condValue: '', target: 'target' },
  statuses: [], avoid: ['kawarimi'], verified: true,
};

/** Does the monster see a hidden player to hit it (normal attacks and target-picking)? */
const seesHidden = (m: Monster) => !!m.bossProtocol;

/** When a monster's row may fire in this state (rAthena MSS_*). */
function stateOk(rowState: string, now: 'attack' | 'chase'): boolean {
  if (rowState === 'any' || rowState === 'anytarget') return true;
  if (now === 'attack') return rowState === 'attack' || rowState === 'angry';
  return rowState === 'chase' || rowState === 'follow';
}

const EVENT_CONDS = new Set(['closedattacked', 'longrangeattacked', 'skillused', 'casttargeted']);

/** A row's condition (RTM mob.cpp mobskill_use). Unknown conditions never fire. */
function condOk(fight: Fight, a: Actor, s: MobSkill, event: string | null): boolean {
  const c = s.ai.cond;
  if (EVENT_CONDS.has(c)) return c === event;
  if (event) return false;
  const n = Number(s.ai.condValue);
  const hpPct = Math.floor((100 * a.st.hp) / a.m.hp);
  switch (c) {
    case 'always': return true;
    case 'myhpltmaxrate': return hpPct <= n;
    case 'myhpinrate': return hpPct <= n; // lower bound in val1; rarely matters
    // A friend is another monster, never the caster: RTM conf/battle/monster.conf
    // monster_ai 0x001 leaves 0x010 ("mob skills defined for friends will also
    // trigger on themselves") off. Alone, a knight never casts its friend Heal.
    case 'friendhpltmaxrate': {
      const others = [
        ...(a.st === fight.mob ? [] : [{ hp: fight.mob.hp, max: fight.m.hp }]),
        ...fight.mob.adds.filter((x) => x !== a && x.st.hp > 0).map((x) => ({ hp: x.st.hp, max: x.m.hp })),
      ];
      return others.some((o) => Math.floor((100 * o.hp) / o.max) <= n);
    }
    case 'afterskill': return a.st.lastSkill === n;
    case 'slavelt': return a.st.adds.length < n;
    case 'slavele': return a.st.adds.length <= n;
    case 'attackpcge': return 1 >= n;
    case 'attackpcgt': return 1 > n;
    case 'mystatuson': return selfHas(fight, a.st, s.ai.condValue.toLowerCase());
    case 'mystatusoff': return !selfHas(fight, a.st, s.ai.condValue.toLowerCase());
    case 'masterhpltmaxrate': return a.add && Math.floor((100 * fight.mob.hp) / fight.m.hp) <= n;
    default: return false;
  }
}

/**
 * More is coming that Hiding would stop: a cast under way, or the last cast
 * (in the past 2s) has an "afterskill" row waiting on it, off its delay --
 * the Tortured Maiden's Wide Stone → Silence → Bleeding → Vampire Gift.
 */
export function followUpComing(fight: Fight): boolean {
  for (const a of actors(fight)) {
    const st = a.st;
    if (st.cast && hidingStops(a.m, st.cast.skill, false) && st.cast.skill.type !== 'none') return true;
    // An area still ticking on your cell: Hiding is what keeps its waves off.
    if (st.channels.some((ch) => !ch.leftBehind && !ch.lostSight && ch.skill.targets === 'aoe'
      && hidingStops(a.m, ch.skill, false))) return true;
    const last = a.m.skills.find((s) => s.skillId === st.lastSkill);
    if (!last || fight.t - (st.cds[last.skill] ?? -Infinity) > 2000) continue;
    const chained = a.m.skills.some((s) => s.ai.cond === 'afterskill' && Number(s.ai.condValue) === st.lastSkill
      && s.type !== 'none' && (st.cds[s.skill] ?? -Infinity) + s.ai.delayMs <= fight.t);
    if (chained) return true;
  }
  return false;
}

/**
 * Try the skill list once (RTM mob.cpp:3692-3904): in order, each row off
 * its delay, in the right state, winning its own rate roll and meeting its
 * condition; the first that fires starts its cast and ends the try.
 * `event` limits it to rows keyed on that event.
 */
function mobSkillUse(fight: Fight, a: Actor, now: 'attack' | 'chase', event: string | null): boolean {
  const { rng } = fight;
  if (rng.expect || a.st.cast) return false;
  const hidden = has(fight, 'hidden') && !seesHidden(a.m);
  for (const s of a.m.skills) {
    if ((a.st.cds[s.skill] ?? -Infinity) + s.ai.delayMs > fight.t) continue;
    if (!stateOk(s.ai.state, now)) continue;
    if (!rng.chance(s.ai.rate)) continue;
    if (!condOk(fight, a, s, event)) continue;
    // Needs you as a target and cannot see you: try the next row.
    if (hidden && s.targets === 'single' && s.kind !== 'self') continue;
    if (s.summon && a.st.adds.length >= 8) continue;
    a.st.cds[s.skill] = fight.t;
    a.st.lastSkill = s.skillId;
    a.st.cast = { skill: s, endsAt: fight.t + s.castMs };
    if (s.castMs > 0) {
      fight.log && say(fight, `${a.m.name} casts ${s.name}${s.level > 1 ? ` ${s.level}` : ''} (${(s.castMs / 1000).toFixed(1)}s)`);
      let plan = fight.kit.react(fight, s, a.m);
      // Option fumble (a chance, 0..1): the player misses this dodge and
      // tanks the cast -- a human error rate for "how many can I take" (the
      // project owner, 2026-09-29).
      const fumble = typeof fight.options.fumble === 'number' ? fight.options.fumble : 0;
      if (plan && fumble > 0 && rng.chance(fumble)) {
        fight.fumbles = (fight.fumbles ?? 0) + 1;
        // An area can still be walked out of when the planned answer is
        // missed (Hiding spent early, a slow key): kite, ready to leave its
        // range (the project owner, 2026-09-30, on Vampire Gift). Option
        // kite: already moving, no reaction; otherwise notice, then move.
        const react = fight.options.kite === true ? TUNE.kiteReactionMs : 2 * TUNE.playerReactionMs;
        const walkable = s.targets === 'aoe' && s.avoid.includes('walk') && plan.action !== 'Walk out'
          && !has(fight, 'rooted') && fight.kit.actions.some((x) => x.id === 'Walk out')
          && s.castMs - react >= escapeMsFor(fight.options, fight.f, s);
        // A cast aimed at you (Swhoo) can still be line-of-sighted behind
        // cover when the bar leaves time (kits/common.ts losMs).
        const losMs = fight.options.mobility === 'server' ? Math.round(TUNE.losCells * walkCellMs(fight.f)) : TUNE.walkOutMs;
        const coverable = !walkable && s.avoid.includes('los') && plan.action !== 'Break line of sight'
          && !has(fight, 'rooted') && fight.kit.actions.some((x) => x.id === 'Break line of sight') && s.castMs - react >= losMs;
        fight.log && say(fight, `misses the dodge against ${s.name} (fumble)${walkable ? ', walks out instead' : coverable ? ', breaks line of sight instead' : ''}`);
        plan = walkable ? { action: 'Walk out', at: fight.t + react } : coverable ? { action: 'Break line of sight', at: fight.t + react } : null;
      }
      // One dodge in hand at a time: a second cast bar keeps the one that
      // comes due first (a Hiding in time for it usually covers both).
      const held = fight.me.defense;
      if (plan && (!held || plan.at < held.at)) fight.me.defense = { ...plan, against: s.name };
    } else {
      mobResolve(fight, a);
    }
    return true;
  }
  return false;
}

/** An event on a monster: tried at once, whatever its swing timer says. */
function mobEvent(fight: Fight, a: Actor, event: string | null) {
  if (!event || a.st.cast || fight.result) return;
  if (mobSkillUse(fight, a, a.st.rushing ? 'chase' : 'attack', event)) {
    // The pending swing is dropped for the cast.
    if (!a.st.cast) a.st.nextAttackAt = fight.t + 250;
  }
}

function mobAct(fight: Fight, a: Actor) {
  const { m, st } = a;
  if (has(fight, 'hidden') && !seesHidden(m)) {
    // Nothing to swing at; it waits, and may still buff itself.
    mobSkillUse(fight, a, 'attack', null);
    if (!st.cast) st.nextAttackAt = fight.t + m.adelay;
    return;
  }
  // You stepped out of reach: it chases, and chase rows may fire.
  const away = has(fight, 'away') && !a.add;
  const now = away || st.rushing ? 'chase' : 'attack';
  // "First attack is always a normal attack": skills on the attack timer
  // only once it is angry, after its first swing (RTM unit.cpp:2762).
  if ((st.swung || away) && mobSkillUse(fight, a, now, null)) return;
  if (away) { st.nextAttackAt = fight.t + 500; return; }
  st.rushing = false;
  st.swung = true;
  landMobHit(fight, a, NORMAL, true);
  st.nextAttackAt = fight.t + m.adelay;
}

function mobResolve(fight: Fight, a: Actor) {
  const { m, st } = a;
  const s = st.cast!.skill;
  st.cast = null;
  // It acts again 200-300 ms after the cast ends (RTM skill.cpp:12668, AI think grid).
  st.nextAttackAt = fight.t + (fight.rng.expect ? 250 : 200 + Math.floor(fight.rng.next() * 100));
  if (s.castMs === 0) fight.log && say(fight, `${m.name} uses ${s.name}${s.level > 1 ? ` ${s.level}` : ''}`);

  if (s.skill === 'SC_MANHOLE') {
    // A hole on the ground for 10s (Duration1). Falling in holds you 3s and
    // nothing can hurt you: the player's choice, as a dodge (enterManhole).
    fight.ground.manholeUntil = fight.t + 10_000;
    fight.log && say(fight, `${m.name} opens a Manhole`);
    return;
  }
  switch (s.kind) {
    case 'self':
      if (s.self) selfBuff(fight, a, s.self);
      return;
    case 'heal': {
      const amt = s.heal?.flat ?? ((s.heal?.pctMaxHp ?? 0) * m.hp) / 100;
      if (amt > 0) {
        st.hp = Math.min(m.hp, st.hp + amt);
        fight.log && say(fight, `${m.name} heals ${fmt(amt)}`);
      }
      return;
    }
    case 'summon':
      summon(fight, a, s);
      return;
    case 'physical': case 'magic': case 'status':
      break;
    default:
      return;
  }
  // The numbers as of now: Asura Strike after its first, Spear Stab off current HP.
  const now: MobSkill = {
    ...s,
    ratio: st.used[s.skill] && s.ratioAfterFirst !== undefined ? s.ratioAfterFirst : s.ratio,
    flat: (s.flat ?? 0) + (s.flatCasterHpDiv ? st.hp / s.flatCasterHpDiv : 0),
  };
  st.used[s.skill] = true;
  if (s.ticks > 1 && s.tickMs > 0) {
    // Out of it as it lands: an area you can walk from stays behind you.
    // (Or slashed onto the caster during the cast: 'slashedOut', which attacking does not end.)
    const leftBehind = s.targets === 'aoe' && s.avoid.includes('walk') && (has(fight, 'away') || has(fight, 'slashedOut'));
    st.channels.push({ skill: now, nextAt: fight.t, left: s.ticks, every: s.tickMs, statusDone: false, leftBehind });
  } else {
    landMobHit(fight, a, now, false);
  }
}

function selfBuff(fight: Fight, a: Actor, b: SelfBuff) {
  const stacks = b.sc === 'safetywall' || b.sc === 'kyrie' ? Math.max(1, b.value ?? 1) : 1;
  a.st.buffs[b.sc] = { until: fight.t + (b.durationMs || 10_000), stacks, value: b.value };
  fight.log && say(fight, `${a.m.name} puts up ${b.sc}`);
}

function summon(fight: Fight, a: Actor, s: MobSkill) {
  const ids = s.summon?.mobIds ?? [];
  if (!ids.length) return;
  for (let i = 0; i < (s.summon?.count ?? 1) && fight.mob.adds.length < 8; i++) {
    const add = buildAdd(ids[i % ids.length], mobRows());
    if (!add) continue;
    const st = newMobState(add);
    st.nextAttackAt = fight.t + Math.min(add.adelay, 1000);
    // Adds hang off the target so "slavelt" on it counts them.
    const actor: Actor = { m: add, st, add: true };
    fight.mob.adds.push(actor);
    // An add's own summons count against its "slavelt" too.
    if (a.add) a.st.adds.push(actor);
    fight.log && say(fight, `${a.m.name} summons ${add.name}`);
  }
}

/**
 * A lingering area (Magnus Exorcismus: a wave every 3 s) whose wave just
 * landed on you: a player steps off it before the next, rather than hiding
 * from the cast (the project owner, 2026-09-28: tank more, hide less). With
 * mobility 'server' only. The walk costs its cells; a cast that would not
 * finish before you must move is given up.
 */
function stepOffArea(fight: Fight, ch: Channel) {
  const s = ch.skill;
  if (fight.options.mobility !== 'server' || ch.leftBehind || ch.left <= 1 || fight.result) return;
  if (s.targets !== 'aoe' || !s.avoid.includes('walk') || has(fight, 'rooted') || disabled(fight)) return;
  const step = escapeMsFor(fight.options, fight.f, s);
  const leaveBy = ch.nextAt + ch.every - step;
  if (fight.t + TUNE.playerReactionMs > leaveBy) {
    // Its waves come faster than a walk out (Cloud Kill, every 0.5 s): walk
    // anyway, taking what lands on the way, rather than stand in it to the
    // end -- once free to move (after a cast or the pause after a skill).
    const me = fight.me;
    if (ch.exitAt !== undefined) return;
    const exitAt = Math.max(fight.t + TUNE.playerReactionMs, me.cast ? me.cast.endsAt : me.busyUntil) + step;
    if (exitAt >= ch.nextAt + ch.every * (ch.left - 1)) return;
    ch.exitAt = exitAt;
    me.busyUntil = Math.max(me.busyUntil, exitAt);
    fight.log && say(fight, `walks out of ${s.name} through its waves`);
    return;
  }
  const me = fight.me;
  if (me.cast && me.cast.endsAt > leaveBy) me.cast = null;
  const from = Math.max(fight.t + TUNE.playerReactionMs, me.cast ? me.cast.endsAt : me.busyUntil);
  me.busyUntil = Math.max(me.busyUntil, Math.min(from, leaveBy) + step);
  ch.leftBehind = true;
  fight.log && say(fight, `steps off ${s.name} before its next wave`);
}

/**
 * One application of a monster's hit or area on you: hiding, walking out,
 * Kawarimi, flee and dodges first, then damage and the statuses it carries.
 */
function landMobHit(fight: Fight, a: Actor, s: MobSkill, normal: boolean, ch?: Channel) {
  const { f, rng, me } = fight;
  const m = a.m;
  if (s.targets === 'self' || s.type === 'none') return;
  const aoe = s.targets === 'aoe';
  // The damage source as the report shows it: an add's name goes in front.
  const src = normal || a.add ? `${m.name}: ${normal ? 'attack' : s.name}` : s.name;
  if (has(fight, 'hidden') && (s.hiddenImmune || hidingStops(m, s, normal))) {
    // A single-target chain (Chain Lightning's bounces) needs its first hit to
    // find you: hidden as it lands, the whole chain fails, like losing sight.
    if (ch && s.targets === 'single' && !ch.statusDone) ch.lostSight = true;
    // Hidden through the first wave of an area you can walk from (Magnus
    // Exorcismus, Storm Gust): out of Hiding and off it before the next wave.
    if (ch && aoe && s.avoid.includes('walk') && !has(fight, 'rooted')) {
      const step = escapeMsFor(fight.options, f, s);
      if (ch.every >= step) {
        ch.leftBehind = true;
        fight.log && say(fight, `steps out of ${s.name} before its next wave`);
      } else if (ch.exitAt === undefined && ch.nextAt + ch.every * (ch.left - 1) > me.buffs.hidden.until) {
        // Its waves come faster than a walk out (Storm Gust, 0.45s): stay
        // hidden, then walk out as Hiding ends -- whatever lands on the way
        // still hits (Hiding is 2s in the Refuge, a storm up to 4.5s).
        ch.exitAt = me.buffs.hidden.until + step;
        me.busyUntil = Math.max(me.busyUntil, ch.exitAt);
        fight.log && say(fight, `will walk out of ${s.name} as Hiding ends`);
      }
    }
    return avoided(fight, src, 'Hiding');
  }
  if (aoe && ch?.exitAt !== undefined && fight.t >= ch.exitAt) {
    ch.leftBehind = true;
    return avoided(fight, src, 'walked out');
  }
  // The boss protocol swings at you in Hiding, and the swing breaks it (the project owner).
  if (normal && has(fight, 'hidden')) {
    drop(fight, 'hidden');
    fight.log && say(fight, `${m.name}'s swing breaks Hiding`);
    // Out of Hiding early: the walk out of a storm starts now.
    for (const x of actors(fight)) {
      for (const c of x.st.channels) {
        if (c.exitAt !== undefined) c.exitAt = Math.min(c.exitAt, fight.t + escapeMsFor(fight.options, f, c.skill));
      }
    }
  }
  // Out of reach: an area you left, or a single-target cast you walk out of range of (avoid 'walk').
  if ((aoe || (!normal && s.avoid.includes('walk'))) && (has(fight, 'away') || has(fight, 'slashedOut') || ch?.leftBehind)) {
    return avoided(fight, src, 'walked out');
  }
  // Behind cover as it landed (Break line of sight).
  // A cast that finds no line to you fails whole: none of its later hits come.
  if (!normal && (ch?.lostSight || (s.avoid.includes('los') && has(fight, 'outOfSight')))) {
    if (ch) ch.lostSight = true;
    return avoided(fight, src, 'line of sight');
  }
  // A cross (Grand Cross, Grand Darkness): diagonal to the caster it misses --
  // unless you cannot move to stay there (the project owner, 2026-09-27).
  if (!normal && s.avoid.includes('diag') && fight.options.diagonal !== false && !disabled(fight) && !has(fight, 'rooted')) {
    return avoided(fight, src, 'diagonal');
  }
  if (has(fight, 'invulnerable')) return avoided(fight, src, 'Manhole');
  if (s.type === 'physical' && stacks(fight, 'kawarimi') > 0) {
    me.buffs.kawarimi.stacks--;
    return avoided(fight, src, 'Kawarimi');
  }
  // Pawn's Rod: a spell cast at you inside its window is cancelled (RTM
  // SA_MAGICROD). Its SP refund is left out: monster skills carry no SP cost here.
  // The spell is cancelled whole: no later hit of it lands (Chain Lightning).
  // Any magic the monster casts itself at you, a splash too (Adoramus): the
  // server checks src == dsrc, so only a ground unit's hits get past it.
  if (!normal && s.avoid.includes('rod') && (has(fight, 'magicRod') || ch?.cancelled)) {
    if (ch) ch.cancelled = true;
    return avoided(fight, src, "Pawn's Rod");
  }
  // King's Gambit (Land Protector): no ground spell lands on it.
  // It deletes the spell's unit too: no later wave (RTM skill.cpp SA_LANDPROTECTOR).
  if (aoe && s.avoid.includes('walk') && !s.noGambit && has(fight, 'landProtector')) {
    if (ch) ch.left = 0;
    return avoided(fight, src, "King's Gambit");
  }
  // Auto Guard: 4% per level of physical attacks blocked (RTM status.cpp:11168, battle.cpp:1243).
  // Shadow Parry (LK_PARRYING, buff 'parry', value a percent): any weapon hit, normal or skill (battle.cpp:1309).
  const parry = s.type === 'physical' && has(fight, 'parry') ? (me.buffs.parry.value ?? 0) / 100 : 0;
  const guardChance = s.type === 'physical' ? 1 - (1 - Math.min(1, 0.04 * (f.autoGuard ?? 0))) * (1 - parry) : 0;
  if (guardChance > 0 && !rng.expect && rng.chance(guardChance)) return avoided(fight, src, parry ? 'Shadow Parry' : 'Auto Guard');
  // Flee and Perfect Dodge: physical only; PD only against normal attacks.
  // Crits and a player who cannot move are always hit (RTM battle.cpp:2914-2924).
  // Magic can be dodged outright by a buff (Hallucination Walk).
  const b = buffed(fight);
  let p = 1;
  const helpless = disabled(fight);
  if (s.type === 'physical' && !s.ignoresFlee && !s.crit && !helpless) {
    p *= Math.min(1, mobHitChance(m.hit, f.flee + b.flee) * (1 + (s.hitBonus ?? 0) / 100));
  }
  if (normal) p *= 1 - perfectDodgeChance(f.perfectDodge);
  if (s.type === 'magic') p *= 1 - b.magicDodge;
  const firstTick = !ch || !ch.statusDone;
  if (s.type === 'status') {
    if (!rng.expect) {
      if (rng.chance(p)) {
        // Counted as a hit that did no damage, so the threat list sees it.
        if (fight.meter && firstTick) (fight.meter.taken[src] ??= { hits: 0, avoided: 0, damage: 0 }).hits++;
        applyStatuses(fight, a, s, firstTick);
      } else if (firstTick) avoided(fight, src, 'flee');
    }
    if (ch) ch.statusDone = true;
    return;
  }
  const target = playerAsTarget(fight);
  const ranged = a.add && m.reach > 3;
  // Rook's Wall: 10% per level off physical hits from range. The server
  // judges a monster's hit by distance (skillrange_by_distance): 4+ cells is
  // long range. So it counts only for a monster that reaches that far, and
  // only while you are not up close (the kit's 'close', from melee skills).
  const wall = s.type === 'physical' && m.reach > 3 && has(fight, 'defender') && !has(fight, 'close')
    ? Math.max(0, 1 - (me.buffs.defender.value ?? 0) / 100) : 1;
  // Weapon Blocking (GC_WEAPONBLOCKING, buff 'weaponBlock', value a percent):
  // rolled after the hit roll, on any weapon hit or a short-range one -- a
  // spell from a monster beside you too (RTM battle.cpp:1220-1225). A block
  // cancels the hit and the kit hears of it (Counter state, kits/nightraven.ts).
  const blockable = s.type === 'physical' || (s.type === 'magic' && s.targets === 'single' && m.reach <= 3);
  const block = blockable && has(fight, 'weaponBlock') ? Math.min(1, (me.buffs.weaponBlock.value ?? 0) / 100) : 0;
  // Lotus Pact (KO_MEIKYOUSISUI, buff 'lotus'): any hit does nothing 40% of the time (RTM battle.cpp:1306, "custom value").
  const lotus = has(fight, 'lotus') ? LOTUS_BLOCK : 0;
  if (rng.expect) {
    // A rollout: Kaupe takes the hit whole (it would take the first that lands).
    if (kaupeBlocks(fight, s)) return;
    if (block > 0) fight.kit.onBlock?.(fight, p * block);
    const took = hurtMe(fight, p * (1 - guardChance) * (1 - block) * (1 - lotus) * wall * mobDamage(m, target, s, rng, ranged), src);
    drained(fight, a, s, took);
    afterHit(fight, a, s, normal, took);
    return;
  }
  if (!rng.chance(p)) return avoided(fight, src, s.type === 'magic' ? 'magic dodge' : 'flee');
  if (kaupeBlocks(fight, s)) return avoided(fight, src, 'Kaupe');
  if (block > 0 && rng.chance(block)) {
    fight.kit.onBlock?.(fight, 1);
    return avoided(fight, src, 'Weapon Blocking');
  }
  if (lotus > 0 && rng.chance(lotus)) return avoided(fight, src, 'Lotus Pact');
  const dmg = mobDamage(m, target, s, rng, ranged) * vulnerability(fight, s.element) * wall;
  const took = hurtMe(fight, dmg, src);
  drained(fight, a, s, took);
  afterHit(fight, a, s, normal, took);
  applyStatuses(fight, a, s, firstTick);
  if (ch) ch.statusDone = true;
}

/**
 * Kaupe Lv3 (True Goddess): blocks one hit that lands, skill or otherwise,
 * magic too -- not Earthquake (RTM battle.cpp:1331; Lv3 is 100%,
 * status.cpp:11377). Status ticks on you never reach it.
 */
function kaupeBlocks(fight: Fight, s: MobSkill): boolean {
  if (!has(fight, 'kaupe') || s.skill === 'NPC_EARTHQUAKE') return false;
  drop(fight, 'kaupe');
  return true;
}

/**
 * A hit that got through: the kit hears of it (Duel Counters), and your
 * Reflect Shield sends a share of a melee hit back (RTM battle.cpp:7826-7852:
 * short-range weapon damage only).
 */
function afterHit(fight: Fight, a: Actor, s: MobSkill, normal: boolean, took: number) {
  if (took <= 0 || fight.result) return;
  const physical = s.type === 'physical';
  const ranged = a.m.reach > 3;
  // Gear autocasts when hit (skill_counter_additional_effect): matched on the hit's mask, aimed at who hit you.
  if (fight.f.autocasts?.length && (physical || s.type === 'magic')) {
    withTarget(fight, a, () => procWhenHit(fight, (physical ? BF.WEAPON : BF.MAGIC) | (ranged || s.type === 'magic' ? BF.LONG : BF.SHORT) | (normal ? BF.NORMAL : BF.SKILL)));
    if (fight.result) return;
  }
  fight.kit.onHurt?.(fight, { physical, normal, ranged, dmg: took });
  if (!physical || !a.st.hp || a.st.hp <= 0) return;
  // Two reflects off one weapon hit, each its own (RTM battle.cpp): the gear's (bShort/LongWeaponDamageReturn,
  // 5830, ranged hits too) and Reflect Shield's (battle_do_reflect, 6096, short range only). Each is sent as a
  // short-range normal weapon hit of yours -- its "when attacking" autocasts roll on it -- and drains
  // (battle_drain); never more than your Max HP (7900).
  const gear = ranged ? fight.f.reflectRanged ?? 0 : fight.f.reflectMelee ?? 0;
  if (gear > 0) reflectBack(fight, a, took, gear, 'Reflect (gear)');
  const rs = fight.me.buffs.reflectshield;
  if (!ranged && rs && rs.until > fight.t && !fight.result) reflectBack(fight, a, took, rs.value ?? 0, 'Reflect Shield');
}

/** A reflect landing on who hit you (an add too): its damage, your leech, and your attack autocasts on it. */
function reflectBack(fight: Fight, a: Actor, took: number, pct: number, id: string) {
  const back = Math.min(fight.f.maxHp, Math.max(1, Math.floor(took * pct / 100)));
  if (a.st.hp <= 0) return;
  if (fight.meter) {
    const row = (fight.meter.actions[id] ??= { uses: 0, hits: 0, misses: 0, crits: 0, damage: 0 });
    row.hits++; row.damage += back;
  }
  fight.log && say(fight, `${id} → ${fmt(back)}${a.add ? ` (${a.m.name})` : ''}`);
  withTarget(fight, a, () => {
    hurtMob(fight, back);
    leech(fight, back);
    if (!fight.result) procOnAttack(fight, BF.WEAPON | BF.SHORT | BF.NORMAL, 1);
  });
}

/**
 * Run `fn` with `a` as the target: what lands in it (hurtMob, a kit's strike, an autocast) lands on that
 * monster, and the rest of the fight -- the target included -- stands in as its adds (an area autocast
 * reaches them). An add that dies there leaves the fight (`fight.killed`); the target dying in an area hit
 * is the fight won. With `a` the target already, just `fn`.
 */
export function withTarget(fight: Fight, a: Actor, fn: () => void) {
  if (!a.add || a.st === fight.mob) { fn(); return; }
  const m0 = fight.m; const st0 = fight.mob; const result0 = fight.result;
  const main: Actor = { m: m0, st: st0, add: true };
  const others = st0.adds.filter((x) => x !== a);
  fight.m = a.m; fight.mob = a.st; a.st.adds = [main, ...others];
  try { fn(); } finally {
    const died = fight.result === 'win' || a.st.hp <= 0;
    const rest = a.st.adds; a.st.adds = [];
    fight.m = m0; fight.mob = st0;
    st0.adds = rest.filter((x) => x !== main);
    const killed = fight.killed ?? [];
    const mainDied = killed.includes(main);
    if (mainDied) fight.killed = killed.filter((x) => x !== main);
    fight.result = mainDied ? 'win' : result0;
    if (died) { (fight.killed ??= []).push(a); fight.log && say(fight, `${a.m.name} dies`); }
    else st0.adds.push(a);
  }
}

/** Frozen you are Water 1, stoned Earth 1, whatever your armour says. */
function playerAsTarget(fight: Fight): Fighter {
  if (has(fight, 'frozen')) return { ...fight.f, element: 'Water' };
  if (has(fight, 'stoned')) return { ...fight.f, element: 'Earth' };
  const cut = fight.me.cast ? actionById(fight, fight.me.cast.action)?.castDefCut ?? 0 : 0;
  if (cut) return { ...fight.f, def: Math.floor(fight.f.def * (1 - cut)) };
  return fight.f;
}

/**
 * Extra damage of an element from a debuff: Burnt (+400% Fire), Wide Web
 * (the next Fire hit +100%, then it ends), Cloud Kill's poison, Comet's
 * Magic Poison (every element). As a multiplier, applied to the whole hit.
 */
function vulnerability(fight: Fight, element: string): number {
  let bonus = 0;
  const b = fight.me.buffs;
  if (element === 'Fire' && has(fight, 'burnt')) bonus += (b.burnt.value2 ?? 400) / 100;
  if (element === 'Fire' && has(fight, 'webbed')) { bonus += 1; drop(fight, 'webbed'); }
  if (element === 'Poison' && has(fight, 'cloudpoison')) bonus += (b.cloudpoison.value ?? 10) / 100;
  if (element !== 'Neutral' && has(fight, 'magicpoison')) bonus += (b.magicpoison.value ?? 20) / 100;
  return 1 + bonus;
}

/**
 * Does Hiding stop this? The project owner (2026-09-26): on the live server
 * Hiding reliably dodges monster skills -- the 2023 code let Boss and
 * Detector monsters hit a hidden player, which the server no longer does.
 * Normal attacks: the boss protocol still swings at you, and the swing
 * breaks Hiding (landMobHit). A skill can be marked `hideBlocks: false` in
 * mob-skills.json once a reading says Hiding fails.
 */
export function hidingStops(m: Monster, s: MobSkill, normal = false): boolean {
  if (normal) return !m.bossProtocol;
  return s.hideBlocks !== false;
}

/** Holds that end the moment you take damage (the project owner, 2026-09-26). */
const BREAKS_ON_DAMAGE = new Set(['stone', 'freeze']);

const DISABLING: Record<string, string> = {
  stun: 'stunned', freeze: 'frozen', stone: 'stoned', sleep: 'asleep',
  cursedcircle: 'held in a Cursed Circle', manhole: 'stuck in a Manhole', deepsleep: 'asleep',
};

/** Statuses a hit carries, each rolled against your resistances. */
function applyStatuses(fight: Fight, a: Actor, s: MobSkill, firstTick: boolean) {
  for (const e of s.statuses) {
    if (!e.perHit && !firstTick) continue;
    applyStatus(fight, a, s, e);
  }
}

function applyStatus(fight: Fight, a: Actor, s: MobSkill, e: StatusEffect) {
  const { f, rng, me } = fight;
  if (rng.expect) return;
  const sc = e.sc;
  // Undead armour cannot be frozen or stoned; nothing stacks on a stun-like hold.
  if ((sc === 'freeze' || sc === 'stone') && f.element === 'Undead') return;
  if (DISABLING[sc] && disabled(fight)) return;
  const r = statusResist(f, sc, e.resist, e.chance, a.m.level, a.m.luk);
  if (!rng.chance(r.chance)) return;
  const ms = Math.max(0, e.durationMs * r.duration - r.flatMs);
  if (DISABLING[sc]) {
    if (ms <= 0) return;
    // value 1 marks a hold that the next damage breaks (stone, freeze).
    grant(fight, 'stunned', ms, 1, { value: BREAKS_ON_DAMAGE.has(sc) ? 1 : 0 });
    if (sc === 'freeze') grant(fight, 'frozen', ms);
    if (sc === 'stone') grant(fight, 'stoned', ms);
    if (sc === 'manhole') grant(fight, 'invulnerable', ms);
    me.cast = null;
    me.busyUntil = Math.max(me.busyUntil, fight.t + ms);
    me.defense = null;
    say(fight, BREAKS_ON_DAMAGE.has(sc)
      ? `is ${DISABLING[sc]} until the next hit, ${(ms / 1000).toFixed(1)}s at most (${s.name})`
      : `is ${DISABLING[sc]} for ${(ms / 1000).toFixed(1)}s (${s.name})`);
    return;
  }
  switch (sc) {
    case 'silence':
      grant(fight, 'silenced', ms); break;
    case 'root':
      grant(fight, 'rooted', ms);
      // Wide Web (RTM): the next Fire hit does +100%.
      if (s.skill === 'NPC_WIDEWEB') grant(fight, 'webbed', ms);
      break;
    case 'bleeding':
      dot(fight, 'Bleeding', 10_000, ms, 125, true); break;
    case 'burning':
      dot(fight, 'Burning', 3000, ms, 200 + 0.01 * f.maxHp, true); break;
    case 'burnt':
      // 2000 HP a second, never lethal, and Fire hits +400% while it lasts (RTM).
      dot(fight, 'Burnt', 1000, ms, e.value ?? 2000, false);
      grant(fight, 'burnt', ms, 1, { value2: e.value2 ?? 400 });
      break;
    case 'coma':
      // HP to 1, SP to 0 (RTM status.cpp:11352).
      me.hp = Math.min(me.hp, 1); me.sp = 0; break;
    case 'aeterna':
      grant(fight, 'aeterna', ms || 60_000); break;
    case 'decagi':
      // AGI down: 1 flee per AGI and 1 per 10 on top (codex).
      grant(fight, 'decagi', ms, 1, { flee: -Math.round(Math.abs(e.value ?? 12) * 1.1) }); break;
    case 'mandragora':
      me.sp = Math.max(0, me.sp - (fight.f.maxSp * (e.value ?? 50)) / 100); break;
    case 'spdrain':
      me.sp = Math.max(0, me.sp - (e.value ?? 0)); break;
    case 'spdrainpct':
      // Wide Soul Drain: a share of your current SP.
      me.sp = Math.max(0, me.sp * (1 - (e.value ?? 0) / 100)); break;
    case 'reveal':
      // Ruwach / Sight: Hiding and New Moon break, and cannot be held while it lasts.
      drop(fight, 'hidden'); drop(fight, 'invisible');
      grant(fight, 'revealed', ms || 10_000);
      break;
    case 'criticalwound':
      grant(fight, 'criticalwound', ms, 1, { value: e.value ?? 60 }); break;
    case 'cloudpoison': case 'magicpoison':
      grant(fight, sc, ms, 1, { value: e.value }); break;
    case 'dispel':
      for (const k of ['hallucination', 'kawarimi', 'sevenWinds', 'combo']) drop(fight, k);
      break;
    default:
      // blind, confusion, curse, poison (0 damage on RTM), hellpower...: no
      // effect on a TAS fighting one monster.
      if (sc === 'other') return;
      break;
  }
  fight.log && say(fight, `gets ${sc}${ms ? ` for ${(ms / 1000).toFixed(1)}s` : ''} (${s.name})`);
}

/**
 * Something ticking on you: damage, or with `heal` a regen (Knight's Regen). `raw`: a heal that is
 * not a heal skill (status_heal: Lotus Pact), so healing received does not scale it.
 */
export function dot(fight: Fight, name: string, every: number, ms: number, dmg: number, lethal: boolean, heal = false, sp = false, raw = false) {
  if (ms <= 0) return;
  fight.me.dots = fight.me.dots.filter((d) => d.name !== name);
  fight.me.dots.push({ name, nextAt: fight.t + every, every, until: fight.t + ms, dmg, lethal, ...(heal ? { heal } : {}), ...(sp ? { sp } : {}), ...(raw ? { raw } : {}) });
}

/**
 * Put a damage over time on the target (kits: the Satsujin gem's Bleeding,
 * Poison, Burning). Fixed at the moment it lands and runs to the end of the
 * fight (codex); while it is on, another application does nothing (RTM
 * status.cpp:10587-10601 refuses the overlap). First tick one interval on.
 */
export function dotOnMob(fight: Fight, name: DotName): boolean {
  if (fight.mob.dots.some((d) => d.name === name)) return false;
  const k = DOTS[name];
  const dmg = dotTick(fight.f, name);
  fight.mob.dots.push({ name, nextAt: fight.t + k.everyMs, every: k.everyMs, dmg, lethal: k.lethal });
  fight.log && say(fight, `${fight.m.name} takes ${name} (${fmt(dmg)} every ${k.everyMs / 1000}s)`);
  return true;
}

/**
 * The target as your hits meet it right now. Poisoned, its soft DEF is 10%
 * lower (RTM status.cpp:7630-7631, def2 -= def2 x 10/100; the codex only says
 * Poison "softens defence"). GUESS that today's server keeps the 10%.
 */
export function targetNow(fight: Fight): Monster {
  const m = fight.m;
  if (!m.softDef || !fight.mob.dots.some((d) => d.name === 'poison')) return m;
  return { ...m, softDef: Math.floor(m.softDef * (1 - TUNE.poisonSoftDefCut)) };
}

function mobDotTick(fight: Fight, d: MobState['dots'][number]) {
  const taken = TUNE.dotDamageTaken ? fight.m.damageTaken : 1;
  let dmg = Math.floor(d.dmg * taken);
  // A plant-type monster (Ignore* modes: Ymir Emperium) takes 1 a tick -- the
  // statuses land, the damage is capped (the project owner's test, 2026-09-28).
  if (fight.m.ignores?.length) dmg = 1;
  // Poison stops at 1 HP (codex).
  if (!d.lethal) dmg = Math.max(0, Math.min(dmg, fight.mob.hp - 1));
  if (dmg <= 0) return;
  const label = d.name[0].toUpperCase() + d.name.slice(1);
  if (fight.meter) {
    const row = (fight.meter.actions[label] ??= { uses: 0, hits: 0, misses: 0, crits: 0, damage: 0 });
    row.hits++; row.damage += dmg;
  }
  fight.log && say(fight, `${label} tick → ${fmt(dmg)}`);
  hurtMob(fight, dmg);
}

// ---- the loop --------------------------------------------------------------

/**
 * A fight that cannot end in time: from EARLY_STALL_MS to half the time limit, if three times
 * the damage rate so far would still leave the monster alive at the clock,
 * it stops here as the time-limit stalemate it was bound to be, booked at the
 * limit so kills an hour read the same. Ymir Emperium takes 1 a hit: ~1% of
 * its HP every 10 s, a 120 s fight each time. Real fights only (not
 * rollouts, not the dummy); option earlyStall false plays every fight out.
 */
const EARLY_STALL_MS = 20_000;
const EARLY_STALL_MARGIN = 3;

/** Run until someone dies or the clock (fight.limitMs, absolute) runs out. */
export function run(fight: Fight): Fight {
  const { me } = fight;
  let guard = 0;
  const early = fight.options.earlyStall !== false && !fight.rng.expect && !fight.m.dummy;
  const t0 = fight.t; const hp0 = fight.mob.hp;
  while (!fight.result) {
    // Only in the fight's first half: late on, one burst can still finish it (Famine Incarnate out of its cloak).
    if (early && fight.t - t0 >= EARLY_STALL_MS && fight.t <= fight.limitMs / 2) {
      const rate = (hp0 - fight.mob.hp) / (fight.t - t0);
      if (rate * EARLY_STALL_MARGIN * (fight.limitMs - fight.t) < fight.mob.hp) {
        fight.log && say(fight, `cannot kill it by the time limit at ${EARLY_STALL_MARGIN}x its pace so far: a stalemate at the limit`);
        fight.stoppedAt = fight.t;
        fight.t = fight.limitMs;
        fight.result = 'stalemate';
        fight.cause = 'time limit';
        break;
      }
    }
    // A fight that stops moving forward is a bug in a kit or the engine: booked as a stalemate
    // (cause 'engine loop', so it shows) rather than killing an hours-long search.
    if (++guard > 2_000_000) { fight.result = 'stalemate'; fight.cause = 'engine loop'; break; }
    const all = actors(fight);
    const tMe = me.cast ? me.cast.endsAt : me.busyUntil;
    const tDef = me.defense?.at ?? Infinity;
    const tRegen = Math.min(me.regenAt.hp, me.regenAt.sp, me.regenAt.skill ?? Infinity);
    let tMob = Infinity; let who: Actor | null = null;
    let tTick = Infinity; let tickOf: { a: Actor; ch: Channel } | null = null;
    for (const a of all) {
      const t = a.st.cast ? a.st.cast.endsAt : a.st.nextAttackAt;
      if (t < tMob) { tMob = t; who = a; }
      for (const ch of a.st.channels) if (ch.nextAt < tTick) { tTick = ch.nextAt; tickOf = { a, ch }; }
    }
    let tDot = Infinity;
    for (const d of me.dots) tDot = Math.min(tDot, d.nextAt);
    let tMobDot = Infinity;
    for (const d of fight.mob.dots) tMobDot = Math.min(tMobDot, d.nextAt);
    const next = Math.min(tMe, tDef, tMob, tTick, tRegen, tDot, tMobDot);
    if (next > fight.limitMs) {
      fight.t = fight.limitMs;
      fight.result = 'stalemate';
      fight.cause = 'time limit';
      break;
    }
    fight.t = Math.max(fight.t, next);

    if (tRegen === next) {
      // No natural regen while hidden (RTM status.cpp:15786).
      const still = has(fight, 'hidden');
      if (me.regenAt.hp === next) { if (!still) heal_(fight, fight.f.regen.hp); me.regenAt.hp += TUNE.hpRegenMs; }
      if (me.regenAt.sp === next) {
        if (!still) me.sp = Math.min(fight.f.maxSp, me.sp + fight.f.regen.sp);
        me.regenAt.sp += TUNE.spRegenMs;
      }
      if (me.regenAt.skill === next) {
        // Skill regen: not while hidden, nor while walking out ('away').
        if (!still && !has(fight, 'away')) me.sp = Math.min(fight.f.maxSp, me.sp + (fight.f.regen.spSkill ?? 0));
        me.regenAt.skill += TUNE.skillRegenMs;
      }
      continue;
    }
    if (tDot === next) {
      const d = me.dots.find((x) => x.nextAt === next)!;
      // Skill heals over time (Knight's Regen, King's Fortress): healing received applies.
      // An SP regen skill (King's Fortress Lv2) restores SP instead.
      if (d.sp) me.sp = Math.max(0, Math.min(fight.f.maxSp, me.sp + d.dmg));
      else if (d.heal) heal_(fight, d.dmg * (d.raw ? 1 : Math.max(0, 1 + (fight.f.healReceived ?? 0) / 100)));
      else hurtMe(fight, d.dmg, d.name, d.lethal);
      d.nextAt += d.every;
      if (d.nextAt > d.until) me.dots = me.dots.filter((x) => x !== d);
      continue;
    }
    if (tMobDot === next) {
      const d = fight.mob.dots.find((x) => x.nextAt === next)!;
      d.nextAt += d.every;
      if (d.hit) {
        d.hit(fight);
        if (d.left !== undefined && --d.left <= 0) fight.mob.dots = fight.mob.dots.filter((x) => x !== d);
      } else mobDotTick(fight, d);
      continue;
    }
    if (tDef === next) { defend(fight); continue; }
    if (tTick === next && tickOf) {
      const { a, ch } = tickOf;
      const hpBefore = me.hp;
      landMobHit(fight, a, ch.skill, false, ch);
      // Only a wave that reached you is worth walking off.
      if (me.hp < hpBefore) stepOffArea(fight, ch);
      ch.left--;
      ch.nextAt += ch.every;
      if (ch.left <= 0) a.st.channels = a.st.channels.filter((x) => x !== ch);
      continue;
    }
    if (tMob === next && who) {
      if (who.st.cast) mobResolve(fight, who);
      else mobAct(fight, who);
      continue;
    }
    // The player.
    if (me.cast) {
      const a = actionById(fight, me.cast.action);
      complete(fight, a);
    } else {
      // A potion costs no time: drink whatever is wanted, then choose.
      const drink = fight.items.find((x) => canUse(fight, x));
      if (drink) { fight.log && say(fight, `drinks ${drink.id}`); complete(fight, drink); continue; }
      if (outOfSp(fight)) {
        fight.result = 'stalemate';
        fight.cause = 'out of SP';
        say(fight, 'out of SP for every damage skill: stalemate');
        break;
      }
      if (disabled(fight)) { me.busyUntil = me.buffs.stunned.until; continue; }
      start(fight, fight.policy(fight));
    }
  }
  return fight;
}

/**
 * No damage skill is affordable any more. Checked in the real fight only --
 * a rollout that runs dry just keeps swinging -- and never against the
 * training dummy, whose test is a fixed window.
 */
function outOfSp(fight: Fight): boolean {
  // Held in Hiding (a kit rule), not dry.
  if (fight.rng.expect || fight.m.dummy || has(fight, 'hidden')) return false;
  // Option pace: a long fight is paced, not given up -- swing and wait for
  // SP (regen, leech, Lotus Pact) until a skill is affordable again. The
  // clock (limitMs) still ends it.
  if (fight.options.pace === true) return false;
  // An auto-attack build (option autoOnly, kits/nightraven.ts) deals its
  // damage with the swing: no skill to afford is not being dry.
  if (fight.options.autoOnly === true) return false;
  // Nothing castable into a ward (Pneuma, Safety Wall) is not being dry: the
  // kit pulls the monster off it (kits/common.ts pullOffWard).
  const ward = (k: string) => (fight.mob.buffs[k]?.until ?? -1) > fight.t;
  if (ward('pneuma') || ward('safetywall')) return false;
  if (fight.kit.holding?.(fight)) return false;
  // A skill counts if it is affordable and its setup holds (cooldowns
  // aside): Omamori Jutsu costs 5 SP, but needs a talisman that costs 150.
  let any = false;
  for (const a of fight.kit.actions) {
    if (!a.isSkill || !a.offensive || a.reactive) continue;
    const cost = a.spCost(fight);
    if (cost <= 0) continue;
    any = true;
    if (cost <= fight.me.sp && (a.ready?.(fight) ?? true)) return false;
  }
  return any;
}

/** The planned dodge goes off now, cancelling a cast if one is running. */
function defend(fight: Fight) {
  const me = fight.me;
  const plan = me.defense!;
  me.defense = null;
  if (disabled(fight)) return;
  const a = actionById(fight, plan.action);
  if (readyAt(fight, a.id) > fight.t || a.spCost(fight) > me.sp || !(a.ready?.(fight) ?? true)) return;
  if (me.cast) { fight.log && say(fight, `cancels ${me.cast.action}`); me.cast = null; }
  if (fight.meter) fight.meter.defenses[a.id] = (fight.meter.defenses[a.id] ?? 0) + 1;
  fight.log && say(fight, `${a.id} against ${plan.against}`);
  complete(fight, a);
}

// ---- logging ---------------------------------------------------------------

export const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function say(fight: Fight, text: string) {
  if (!fight.log) return;
  const hp = `${fmt(Math.max(0, fight.me.hp))}/${fmt(fight.f.maxHp)}`;
  const mhp = `${(Math.max(0, fight.mob.hp) / fight.m.hp * 100).toFixed(1)}%`;
  // SP too (the project owner, 2026-10-02: SP is what runs out on the skill builds).
  const sp = `${fmt(Math.max(0, fight.me.sp))}/${fmt(fight.f.maxSp)}`;
  fight.log.push(`[${(fight.t / 1000).toFixed(2).padStart(7)}s] HP ${hp.padStart(13)} | SP ${sp.padStart(11)} | mob ${mhp.padStart(6)} | ${text}`);
}

// ---- copying for the planner -----------------------------------------------

/**
 * A monster's state with every time in it moved by `dt` ms (a fight's clock starts at 0: tools/farm.ts
 * carries a monster from one fight into the next): its swing, cast, waves, skill delays, buffs, ticks.
 */
export function shiftMobState(st: MobState, dt: number): MobState {
  const c = cloneMob(st);
  const sb = <T extends Buff>(b: Record<string, T>) => { for (const k in b) b[k] = { ...b[k], until: b[k].until + dt }; return b; };
  c.nextAttackAt += dt;
  if (c.cast) c.cast.endsAt += dt;
  for (const ch of c.channels) { ch.nextAt += dt; if (ch.exitAt !== undefined) ch.exitAt += dt; }
  for (const k in c.cds) c.cds[k] += dt;
  sb(c.debuffs); sb(c.buffs);
  for (const d of c.dots) d.nextAt += dt;
  c.adds = [];
  return c;
}

function cloneMob(st: MobState): MobState {
  return {
    ...st,
    cast: st.cast && { ...st.cast },
    channels: st.channels.map((c) => ({ ...c })),
    cds: { ...st.cds },
    used: { ...st.used },
    debuffs: cloneBuffs(st.debuffs),
    buffs: cloneBuffs(st.buffs),
    adds: st.adds.map((a) => ({ ...a, st: cloneMob(a.st) })),
    dots: st.dots.map((d) => ({ ...d })),
  };
}

/** A cheap copy in expect mode, running `policy` until `untilMs`. */
export function rollout(fight: Fight, policy: Policy, untilMs: number): Fight {
  const me = fight.me;
  const copy: Fight = {
    ...fight,
    rng: new Rng(0, true),
    policy,
    meter: null,
    log: null,
    // A rollout is imagined: nothing it does goes into the real fight's trace.
    trace: undefined,
    procs: undefined,
    limitMs: Math.min(fight.limitMs, untilMs),
    ground: { ...fight.ground },
    me: {
      ...me,
      cast: me.cast && { ...me.cast },
      cds: { ...me.cds },
      buffs: cloneBuffs(me.buffs),
      focus: [...me.focus],
      spent: { ...me.spent },
      defense: me.defense && { ...me.defense },
      regenAt: { ...me.regenAt },
      left: { ...me.left },
      dots: me.dots.map((d) => ({ ...d })),
    },
    mob: cloneMob(fight.mob),
  };
  return copy;
}

function cloneBuffs<T extends Buff>(b: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k in b) out[k] = { ...b[k] };
  return out;
}

/** Start `a` in a rollout copy, then play it out. */
export function playOut(copy: Fight, a: Action): Fight {
  if (!copy.me.cast && copy.me.busyUntil <= copy.t) start(copy, a);
  return run(copy);
}
