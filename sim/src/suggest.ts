import { aggregate, BASE_STAT_IDS, skillKey } from './aggregate.ts';
import { combine, FORMULAS } from './derived.ts';
import { skillTone, statTone, type Tone } from './format.ts';
import { canEquip } from './jobs.ts';
import { rollTableFor, type RollPick } from './rolls.ts';
import {
  carryInto, fitsCard, fitsSlot, isLocked, isTwoHanded, MAIN_HAND, maxRefine, OFF_HAND,
  SLOT_BY_KEY, SLOTS, socketsOf, type SlotDef,
} from './slots.ts';
import { fillSet, missingMembers } from './sets.ts';
import { BASE_STAT_KEYS } from './types.ts';
import type {
  BaseStats, Build, Dataset, Effect, Goal, Item, SetRecord, SlotChange, SlotState, Totals,
} from './types.ts';

/**
 * Goal-driven suggestions.
 *
 * Every candidate is judged by building the whole character with it and
 * running the real aggregator, never by reading the item's own numbers in
 * isolation. That is slower, and it is the only way the answer agrees with
 * the stat panel: a set bonus that only pays out with the last piece, a
 * refine step, a cap, an off-hand weapon counting half -- all of it is
 * already in `aggregate`, and a shortcut here would have to reimplement it
 * and would drift.
 *
 * What keeps it fast enough is not scoring what cannot matter. An item is
 * only tried if some effect on it, or on a set it belongs to, names a stat a
 * goal is about.
 */

// ---- goals --------------------------------------------------------------

export interface GoalMetric {
  key: string;
  column: Goal['column'];
  label: string;
  /** For grouping in a picker; "derived" for totals worked out from the sheet. */
  category: string;
}

const METRICS = new WeakMap<Dataset, GoalMetric[]>();

/**
 * Every number a goal can be set on, in the order a picker should list them.
 *
 * Only what some piece of gear can actually move. The registry gives every
 * stat both a flat and a percent column, but most stats only ever come one
 * way -- STR is never a percent, DMG vs Demihuman is never flat -- and a goal
 * on a column nothing feeds could never be helped by any suggestion. So the
 * columns offered are the ones the data was seen to use.
 */
export function goalMetrics(data: Dataset): GoalMetric[] {
  const cached = METRICS.get(data);
  if (cached) return cached;

  const used = usedColumns(data);
  const out: GoalMetric[] = [];
  for (const f of FORMULAS) {
    out.push({ key: f.key, column: 'total', label: `${f.label} (total)`, category: 'derived' });
  }
  for (const key of BASE_STAT_KEYS) {
    const def = data.stats.find((s) => s.key === key);
    if (def) out.push({ key, column: 'total', label: `${def.name} (total)`, category: 'derived' });
  }
  out.push({ key: SP_SUSTAIN, column: 'total', label: 'SP sustain %', category: 'derived' });
  for (const s of data.stats) {
    // A flag is present or absent; there is no amount to aim for.
    if (s.category === 'flag') continue;
    // A base stat's own row is the total above; its gear-only column would
    // be the same goal with the points left out.
    if ((BASE_STAT_KEYS as string[]).includes(s.key)) continue;
    const flat = used.has(`${s.id}:flat`);
    const pct = used.has(`${s.id}:percent`);
    // Only name the unit when the stat comes both ways; otherwise the plain
    // name is unambiguous.
    if (flat) {
      out.push({ key: s.key, column: 'flat', label: pct ? `${s.name} (flat)` : s.name,
        category: s.category });
    }
    if (pct && s.combine !== 'max') {
      out.push({ key: s.key, column: 'percent', label: `${s.name} %`, category: s.category });
    }
  }
  // Skill modifiers last: there are a few hundred, and they are the long
  // tail of the list rather than its head.
  const skills = [...used].filter((u) => u.startsWith(SKILL_PREFIX))
    .map((u) => {
      const [key, column] = splitLast(u);
      const [skill, metric] = key.slice(SKILL_PREFIX.length).split('|');
      const unit = column === 'percent' ? ' %' : metric === 'level' ? '' : ' (s)';
      return { key, column: column as Goal['column'],
        label: `${skill} ${metric}${unit}`, category: 'skill modifiers' };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  out.push(...skills);
  METRICS.set(data, out);
  return out;
}

/** Goal keys for a skill modifier: "skill:Backstab|damage". */
export const SKILL_PREFIX = 'skill:';

/**
 * How much of your SP bar a cast costs, relative to having neither bonus.
 *
 * Max SP on its own is a misleading thing to guard. A build at -60% Max SP
 * and -60% SP Cost casts exactly as many times as one with neither, because
 * both sides of the sum moved together -- and shadow gear in particular
 * trades one for the other on purpose. So what is worth protecting is the
 * ratio, not the pool: casts available, as a percentage of the baseline.
 *
 * -50 means half the casts. Flat Max SP is deliberately not in it: this is
 * a reading of what the gear is doing to the ratio, and a flat bonus moves
 * the pool by an amount that depends on a base the planner does not know.
 */
export const SP_SUSTAIN = 'sp_sustain';

function spSustain(totals: Totals, data: Dataset): number {
  const pool = gearTotal(totals, data, 'max_sp')?.percent ?? 0;
  const cost = gearTotal(totals, data, 'sp_cost')?.percent ?? 0;
  // A cost reduction of 100% or more would be free casting, which nothing on
  // this server grants; the floor keeps a corrupt or stacked total from
  // dividing by nothing rather than modelling anything.
  return 100 * ((1 + pool / 100) / Math.max(0.01, 1 + cost / 100) - 1);
}

/**
 * The lines every build is held to unless it says otherwise.
 *
 * Suggestions used to hand back gear that halved the character's HP or SP
 * for a few points of crit, because nothing in the scoring knew those two
 * numbers are what keeps you alive and casting rather than stats like any
 * other. A build that cannot take a hit is not a better build whatever its
 * damage says, so both are floors from the start and the player moves or
 * removes them deliberately.
 */
export const DEFAULT_GUARDS: Goal[] = [
  { key: 'max_hp', column: 'percent', target: -50, guard: true },
  { key: SP_SUSTAIN, column: 'total', target: -50, guard: true },
];

/** This build's guards: its own if it has said, otherwise the defaults. */
export function guardsOf(build: Build): Goal[] {
  return (build.guards ?? DEFAULT_GUARDS).map((g) => ({ ...g, guard: true }));
}

/**
 * Everything a suggestion is judged against: the goals, then the guards.
 *
 * Guards last so they cannot shift the priority of a goal -- the order of
 * `goals` is the player's ranking, and it has to keep meaning that.
 */
export function allGoals(build: Build): Goal[] {
  return [...(build.goals ?? []), ...guardsOf(build)];
}

/**
 * Stats a build never gets goals for from `goalsFromBuild`: conveniences
 * nobody builds around. A boot with move speed is not a move speed build.
 * Max HP and SP are not on it -- they are survivability, and some skills
 * scale off them outright.
 */
const NOT_A_FOCUS = new Set([
  'hp_regen', 'sp_regen', 'move_speed', 'weight_limit', 'exp_gain', 'drop_rate',
]);

/** How many sources a stat needs before it reads as something the build chose. */
const FOCUS_MIN_SOURCES = 2;

/** More than this and every change breaks something; the list stops being a direction. */
const FOCUS_MAX_GOALS = 8;

/**
 * Goals read off the gear already worn, each at the value it has now.
 *
 * For "show me upgrades" without having to say what an upgrade is: whatever
 * the gear already stacks is taken to be what the build is for. A stat
 * counts when at least two separate sources push it the good way, so one
 * stray line on a piece worn for something else does not become a goal.
 * The most-stacked stats come first, which is their priority.
 *
 * Every target is the current value, so every goal starts met. That makes
 * the existing rules mean the right thing: a change that lowers any of them
 * breaks a goal and is never planned, and anything that raises one without
 * lowering another is an upgrade.
 *
 * "All stats +N" lands on every base stat equally, so for those only what
 * one stat gets beyond the least-fed of the six counts -- otherwise every
 * build with a Valkyrie Circlet would read as wanting all six.
 */
export function goalsFromBuild(build: Build, totals: Totals, data: Dataset): Goal[] {
  const found: { goal: Goal; sources: number; size: number }[] = [];
  /**
   * `fed` is what the good sources add up to, for a gear column. When the
   * build's own penalties eat most of it -- +31% Max HP from three pieces
   * and shadow gear taking 29 of it back -- the build is not about that
   * stat, and a target near zero would make any gain on it look enormous,
   * since goals are weighed as fractions of their targets.
   */
  const offer = (
    key: string, column: Goal['column'], sources: number, lower: boolean, fed?: number,
  ) => {
    if (sources < FOCUS_MIN_SOURCES) return;
    const goal: Goal = { key, column, target: 0, ...(lower ? { atMost: true } : {}) };
    const value = measure(goal, totals, build, data);
    if (fed !== undefined && Math.abs(value) < Math.abs(fed) / 2) return;
    if (fed !== undefined && Math.sign(value) !== Math.sign(fed)) return;
    // Rounded towards "met": 16.865% as a target of 16.87 would start short.
    goal.target = (lower ? Math.ceil(value * 100 - EPSILON) : Math.floor(value * 100 + EPSILON)) / 100;
    found.push({ goal, sources, size: Math.abs(value) });
  };
  // A piece's own ATK or DEF comes with wearing anything in the slot, so it
  // says nothing about what the build is for.
  const good = (s: { label: string; value: number }, key: string) =>
    statTone(key, s.value) === 'good' && !s.label.endsWith(' (base)');

  // Base stats, over the share every one of them gets.
  const labelsOf = (key: string) => new Set((gearTotal(totals, data, key)?.sources ?? [])
    .filter((s) => s.unit !== '%' && good(s, key)).map((s) => s.label));
  const perStat = BASE_STAT_KEYS.map((k) => labelsOf(k));
  const everywhere = [...perStat[0]].filter((l) => perStat.every((set) => set.has(l)));
  BASE_STAT_KEYS.forEach((key, i) => {
    offer(key, 'total', [...perStat[i]].filter((l) => !everywhere.includes(l)).length, false);
  });

  // Derived totals take their sources from the gear stat of the same key.
  const derived = new Set(FORMULAS.map((f) => f.key));
  for (const key of derived) {
    offer(key, 'total', (gearTotal(totals, data, key)?.sources ?? [])
      .filter((s) => good(s, key)).length, false);
  }

  const metrics = goalMetrics(data);
  const offered = (key: string, column: Goal['column']) =>
    metrics.some((m) => m.key === key && m.column === column);
  for (const def of data.stats) {
    if (def.category === 'flag' || NOT_A_FOCUS.has(def.key) || derived.has(def.key)) continue;
    if ((BASE_STAT_KEYS as string[]).includes(def.key)) continue;
    const sources = totals.byStat.get(def.id)?.sources ?? [];
    const lower = statTone(def.key, 1) === 'bad';
    for (const column of ['flat', 'percent'] as const) {
      if (!offered(def.key, column)) continue;
      const mine = sources.filter((s) => (s.unit === '%') === (column === 'percent') && good(s, def.key));
      offer(def.key, column, mine.length, lower, sum(mine));
    }
  }

  for (const [key, t] of totals.skills) {
    const metric = key.split('|')[1] ?? '';
    const lower = skillTone(metric, 1) === 'bad';
    for (const column of ['flat', 'percent'] as const) {
      const mine = t.sources.filter((s) => (s.unit === '%') === (column === 'percent')
        && skillTone(metric, s.value) === 'good');
      if (offered(`${SKILL_PREFIX}${key}`, column)) {
        offer(`${SKILL_PREFIX}${key}`, column, mine.length, lower, sum(mine));
      }
    }
  }

  // Most sources first; between equals, the bigger number, which is the
  // one the build has put more into.
  found.sort((a, b) => b.sources - a.sources || b.size - a.size);
  return found.slice(0, FOCUS_MAX_GOALS).map((f) => f.goal);
}

function sum(sources: { value: number }[]): number {
  return sources.reduce((acc, s) => acc + s.value, 0);
}

function splitLast(s: string): [string, string] {
  const at = s.lastIndexOf(':');
  return [s.slice(0, at), s.slice(at + 1)];
}

/**
 * "statId:flat" / "statId:percent" for every column some effect feeds, and
 * "skill:<skill>|<metric>:<column>" for every skill modifier.
 */
function usedColumns(data: Dataset): Set<string> {
  const used = new Set<string>();
  const note = (effects: Effect[] | undefined) => {
    for (const e of effects ?? []) {
      if (!e.parsed || e.flag) continue;
      const column = e.unit === '%' ? 'percent' : 'flat';
      for (const id of e.stat_ids ?? []) used.add(`${id}:${column}`);
      if (!e.stat_ids?.length && e.skill_metric && e.value !== undefined) {
        for (const skill of e.skills ?? []) {
          used.add(`${SKILL_PREFIX}${skillKey(skill, e.skill_metric)}:${column}`);
        }
      }
    }
  };
  for (const item of data.itemList) {
    note(item.effects);
    note(item.piece_bonus);
    for (const g of [...item.refine.per_refine, ...item.refine.thresholds]) note(g.effects);
    for (const c of item.conditional ?? []) note(c.effects);
    for (const [key, value] of [['atk', item.atk], ['matk', item.matk],
      ['def', item.def], ['mdef', item.mdef]] as const) {
      if (value) used.add(`${BASE_STAT_IDS[key]}:flat`);
    }
  }
  for (const set of data.sets) {
    note(set.set_bonus);
    for (const g of [...set.set_refine.per_set_refine, ...set.set_refine.thresholds]) {
      note(g.effects);
    }
  }
  // Rolls are the other source of stats, and a few exist only there.
  for (const table of data.rolls?.tables ?? []) {
    for (const roll of table.rolls) {
      for (const option of roll.options) {
        for (const g of option.grants) {
          if (g.stat_id !== undefined && g.stat_id !== null) {
            used.add(`${g.stat_id}:${g.unit === '%' ? 'percent' : 'flat'}`);
          }
        }
      }
    }
  }
  return used;
}

export function goalLabel(goal: Goal, data: Dataset): string {
  return goalMetrics(data).find((m) => m.key === goal.key && m.column === goal.column)?.label
    ?? goal.key;
}

/** The number a goal is measured against, read off a finished build. */
export function measure(goal: Goal, totals: Totals, build: Build, data: Dataset): number {
  if (goal.key === SP_SUSTAIN) return spSustain(totals, data);
  if (goal.key.startsWith(SKILL_PREFIX)) {
    const t = totals.skills.get(goal.key.slice(SKILL_PREFIX.length));
    return goal.column === 'percent' ? t?.percent ?? 0 : t?.flat ?? 0;
  }
  const gear = gearTotal(totals, data, goal.key);
  if (goal.column === 'total') {
    const derived = totals.derived.find((d) => d.key === goal.key);
    if (derived) return derived.total;
    // A base stat: the points on the sheet with the gear folded in, which is
    // the figure the character window shows.
    const points = build.baseStats?.[goal.key as keyof BaseStats] ?? 0;
    return combine(points, gear?.flat ?? 0, gear?.percent ?? 0);
  }
  return goal.column === 'percent' ? gear?.percent ?? 0 : gear?.flat ?? 0;
}

export interface GoalStatus {
  goal: Goal;
  value: number;
  met: boolean;
  /** How far there is still to go, as a fraction of the target. 0 when met. */
  shortfall: number;
}

export function goalStatus(
  goals: Goal[], totals: Totals, build: Build, data: Dataset,
): GoalStatus[] {
  return goals.map((goal) => {
    const value = measure(goal, totals, build, data);
    const short = shortOf(goal, value);
    return { goal, value, met: short <= 0, shortfall: Math.max(0, short) / scaleOf(goal) };
  });
}

/** Positive while the goal is not met, negative by however much it is beaten. */
function shortOf(goal: Goal, value: number): number {
  return goal.atMost ? value - goal.target : goal.target - value;
}

/**
 * Goals are compared as fractions of their own target, so 10 missing crit
 * and 1,000 missing HP are weighed as what they are relative to what was
 * asked for, not by which number happens to be bigger. The floor of 1 stops
 * a target of 0 from dividing by nothing.
 */
function scaleOf(goal: Goal): number {
  return Math.max(Math.abs(goal.target), 1);
}

/**
 * What beating a goal is worth, relative to closing the same gap below it.
 *
 * A met goal still wants more -- a leech target already hit is still a
 * reason to take more leech -- but at lower priority than anything still
 * short, so a surplus can never outbid progress on an unmet goal of the same
 * size. Diminishing (log) rather than capped, so there is always some pull
 * and never a runaway.
 */
const SURPLUS_WEIGHT = 0.1;

/**
 * How much less each goal counts than the one above it.
 *
 * The order of the goals is the player's priority, so it has to mean
 * something -- otherwise, once everything is met, a suggester with no reason
 * to prefer one surplus over another would answer with whichever stat the
 * gear happened to favour. It is deliberately a lean rather than a veto: at
 * three quarters a step, the third goal still counts for more than half of
 * the first, so a goal far short of its target still outranks a small gain
 * on one that is nearly there, whatever the order says.
 */
const PRIORITY_DECAY = 0.75;

/** What the goal at this position counts for, relative to the first. */
export function priorityWeight(index: number): number {
  return PRIORITY_DECAY ** index;
}

/**
 * What a broken guard counts for, against a top-priority goal's 1.
 *
 * Twice, so crossing the line is never a trade a suggestion can win on
 * points: halving the guarded stat costs 2, where taking the best goal from
 * nothing to its target is worth 1. It is a weight rather than a veto
 * because a build can start out already past the line -- gear does not come
 * off to make room for a rule -- and from there the score should be pulling
 * back towards it rather than refusing to say anything at all.
 */
const GUARD_WEIGHT = 2;

/** What this goal counts for: its rank, or a guard's fixed weight. */
function weightOf(goal: Goal, index: number): number {
  return goal.guard ? GUARD_WEIGHT : priorityWeight(index);
}

/** Lower is better. Shortfalls first; surplus on met goals after. */
function scoreOf(goals: Goal[], values: number[]): number {
  return scoreExcept(goals, values, -1);
}

/**
 * The same score with one goal left out, at everything else's real priority.
 *
 * Dropping the goal from the array instead would shift every goal below it up
 * a place and quietly promote it, which is the opposite of what asking about
 * one goal should do to the others.
 */
function scoreExcept(goals: Goal[], values: number[], skip: number): number {
  let score = 0;
  goals.forEach((goal, i) => {
    if (i === skip) return;
    const short = shortOf(goal, values[i]) / scaleOf(goal);
    // A guard that holds is worth nothing. Crediting the surplus would turn
    // "don't halve my HP" into "keep taking HP", which is a different thing
    // to ask for and one the player can ask for with an ordinary goal.
    if (short <= 0 && goal.guard) return;
    score += weightOf(goal, i) * (short > 0 ? short : -SURPLUS_WEIGHT * Math.log1p(-short));
  });
  return score;
}

/** The score of a set of goal values; lower is better. Exported for tests. */
export const goalScore = scoreOf;

/**
 * Goals this change would cost their target: met before, short after.
 *
 * Kept apart from the score rather than folded into it, because it is a
 * different kind of fact. A score says how good a build is on balance, and on
 * balance a big overshoot on one goal can outweigh a small drop on another --
 * a surplus is credited and a shortfall charged, and with the right
 * magnitudes the sums come out in favour. But a target that was met and is
 * now missed is not a smaller amount of good, it is the thing the player
 * asked for being taken away. So it is judged as a category: nothing that
 * does it is ranked above something that does not, and the plan will not do
 * it at all.
 *
 * Only the crossing counts. A goal that was already short and gets shorter is
 * charged for it by the score in the ordinary way, and shows as a loss.
 */
export function brokenGoals(goals: Goal[], before: number[], after: number[]): Goal[] {
  return goals.filter((goal, i) =>
    shortOf(goal, before[i]) <= EPSILON && shortOf(goal, after[i]) > EPSILON);
}

/** Does this change move at least one goal the right way? */
function improvesAny(goals: Goal[], before: number[], after: number[]): boolean {
  return goals.some((goal, i) => {
    const d = after[i] - before[i];
    return goal.atMost ? d < -EPSILON : d > EPSILON;
  });
}

/** How far the goals still are, with nothing for beating them. */
function shortfallOf(goals: Goal[], values: number[]): number {
  let total = 0;
  goals.forEach((goal, i) => {
    total += weightOf(goal, i) * Math.max(0, shortOf(goal, values[i])) / scaleOf(goal);
  });
  return total;
}

// ---- moves --------------------------------------------------------------

export interface Move {
  /**
   * 'sockets': a piece with more card slots, offered whatever the goals say.
   * 'rolls': the random options worth aiming for on the piece already worn.
   */
  kind: 'item' | 'cards' | 'set' | 'sockets' | 'rolls';
  /** What a person would call it: "Hodremlin Card ×4 in Shoes". */
  label: string;
  changes: SlotChange[];
  /** How much closer it brings the goals. Positive is better. */
  gain: number;
  /** Each goal's value before and after, in goal order. */
  before: number[];
  after: number[];
  /**
   * Helps some goal but is no better overall: a trade, listed after the
   * upgrades rather than hidden, and never taken by the plan. From
   * `focusMoves` it means the move costs another goal something.
   */
  sidegrade?: boolean;
  /** The suggestion before it, with its new pieces at full refine. */
  maxed?: boolean;
}

export interface SuggestOptions {
  /** Only items this class can equip. Null allows anything. */
  className: string | null;
  /** Only items at or below this required level. Null allows any. */
  maxLevel: number | null;
  /**
   * The refine a suggested piece is assumed to have. Null keeps whatever
   * the slot already had, which is how swapping in the picker behaves.
   * 'auto' tries every refine and takes the lowest that gets the most out
   * of the piece: as far up as the goals reward, and no further.
   */
  refine: number | null | 'auto';
}

const EMPTY: SlotState = { itemId: null, refine: 0, cards: [] };
const EPSILON = 1e-9;

/**
 * Put changes into a build.
 *
 * A two-handed weapon takes the off hand with it, so anything left there is
 * cleared rather than counted -- otherwise a suggestion could claim a
 * shield's bonus alongside a weapon that cannot be held with one.
 */
export function applyChanges(build: Build, changes: SlotChange[], data: Dataset): Build {
  const slots = { ...build.slots };
  for (const change of changes) slots[change.slot] = change.state;
  const weapon = data.items.get(slots.weapon?.itemId ?? -1);
  if (isTwoHanded(weapon) && slots[OFF_HAND]?.itemId) slots[OFF_HAND] = EMPTY;
  return { ...build, slots };
}

/**
 * Suggestions for one set of goals.
 *
 * Built once per goals-and-options and then asked several questions, so
 * the relevance filters are worked out once rather than per call.
 */
export class Suggester {
  /** Everything judged against: the player's goals, then the guards. */
  readonly goals: Goal[];
  /** The goals proper -- what a suggestion is actually looking for. */
  readonly wanted: Goal[];
  readonly relevant: Relevance;
  private readonly data: Dataset;
  private readonly opts: SuggestOptions;
  private readonly cards: Item[];
  private readonly sets: SetRecord[];
  private readonly setsTouching: Set<number>;
  /** Set only on the throwaway suggester `focusMoves` builds; see `objective`. */
  private pushing = false;

  // Written out rather than as parameter properties: the tests run under
  // Node's type stripping, which does not support those.
  constructor(data: Dataset, goals: Goal[], opts: SuggestOptions) {
    this.data = data;
    this.goals = goals;
    this.opts = opts;
    // Guards are left out of relevance and of `active`: a line not to cross
    // is not a reason to go looking through the gear, and on its own it is
    // not something to suggest towards. They still count in every score,
    // which is where they do their work.
    this.wanted = goals.filter((g) => !g.guard);
    this.relevant = relevanceOf(this.wanted, data);
    this.sets = data.sets.filter((s) => setTouches(s, this.relevant));
    this.setsTouching = new Set(this.sets.map((s) => s.index));
    this.cards = data.itemList.filter((i) =>
      i.kind === 'Card' && this.allowed(i) && touches(i, this.relevant));
  }

  get active(): boolean {
    return this.wanted.length > 0
      && (this.relevant.ids.size > 0 || this.relevant.skills.size > 0);
  }

  /** Goal values for a build, in goal order. */
  values(build: Build): number[] {
    const totals = aggregate(build, this.data);
    return this.goals.map((g) => measure(g, totals, build, this.data));
  }

  score(build: Build): number {
    return scoreOf(this.goals, this.values(build));
  }

  allowed(item: Item): boolean {
    if (!canEquip(item, this.opts.className, this.data.classRules)) return false;
    return this.opts.maxLevel === null || item.required_level <= this.opts.maxLevel;
  }

  /** The goals this move would take below their target. */
  breaks(move: Move): Goal[] {
    return brokenGoals(this.goals, move.before, move.after);
  }

  /**
   * Would these changes leave every locked slot as it is?
   *
   * The slot-by-slot methods already refuse to work on a locked slot, so what
   * is left is the one change that reaches past the slot it names: a
   * two-handed weapon takes the off hand with it, and `applyChanges` clears
   * whatever was there. A locked off hand must not be emptied by a
   * suggestion about the main hand.
   */
  private respectsLocks(build: Build, changes: SlotChange[]): boolean {
    if (!build.locked?.length) return true;
    if (changes.some((c) => isLocked(build, c.slot))) return false;
    if (!isLocked(build, OFF_HAND) || !build.slots[OFF_HAND]?.itemId) return true;
    const main = changes.find((c) => c.slot === MAIN_HAND);
    return !main || !isTwoHanded(this.data.items.get(main.state.itemId ?? -1));
  }

  /**
   * Is this item worth scoring at all?
   *
   * True when it names a goal stat itself or belongs to a set that does --
   * the second because the last piece of a set is worth its whole bonus
   * even when the piece alone says nothing about the goal.
   */
  mayMatter(item: Item): boolean {
    return touches(item, this.relevant) || item.sets.some((s) => this.setsTouching.has(s));
  }

  /**
   * Score every candidate the picker is showing, as the picker would equip
   * it: swapped into the slot keeping refine, cards and rolls where they fit.
   * Items that cannot matter are left out of the map, which reads as a gain
   * of nothing.
   */
  rank(
    build: Build, slotKey: string, socket: number | null, candidates: Item[],
  ): Map<number, { gain: number; after: number[] }> {
    const out = new Map<number, { gain: number; after: number[] }>();
    const slot = SLOT_BY_KEY.get(slotKey);
    if (!this.active || !slot) return out;
    const baseline = this.score(build);
    const state = build.slots[slotKey] ?? EMPTY;

    for (const item of candidates) {
      if (!this.mayMatter(item)) continue;
      let next: SlotState;
      if (socket === null) {
        next = carryInto(state, item, slot, this.data);
      } else {
        const cards = [...state.cards];
        cards[socket] = item.id;
        next = { ...state, cards };
      }
      const trial = applyChanges(build, [{ slot: slotKey, state: next }], this.data);
      const after = this.values(trial);
      out.set(item.id, { gain: baseline - scoreOf(this.goals, after), after });
    }
    return out;
  }

  /**
   * The best things to do with one slot: a different piece, a different
   * piece with the cards chosen for it, better cards in what is already
   * there, or finishing a set that has a piece in this slot.
   */
  slotMoves(
    build: Build, slotKey: string, limit = 12, withSets = true, withMaxed = true,
  ): Move[] {
    const slot = SLOT_BY_KEY.get(slotKey);
    if (!this.active || !slot || isLocked(build, slotKey)) return [];
    if (slotKey === OFF_HAND && isTwoHanded(this.data.items.get(build.slots.weapon?.itemId ?? -1))) {
      return [];
    }
    const before = this.values(build);
    const baseline = scoreOf(this.goals, before);
    const current = build.slots[slotKey] ?? EMPTY;

    // A piece that says nothing about the goal can still be the best place
    // for cards that do: a plain four-socket weapon is the whole point of
    // four Bloody Murderers. So when some goal card fits this slot, pieces
    // with sockets are tried too, as hosts.
    const cardsFit = this.cards.some((c) => fitsCard(c, slot));
    const tried: { item: Item; state: SlotState; score: number; after: number[] }[] = [];
    for (const item of this.data.itemList) {
      if (item.id === current.itemId) continue;
      if (!fitsSlot(item, slot) || !this.allowed(item)) continue;
      if (!this.mayMatter(item) && !(cardsFit && item.card_slots > 0)) continue;
      const tuned = this.tune(build, [{ slot: slotKey, state: this.place(current, item, slot) }]);
      const { state } = tuned.changes[0];
      tried.push({ item, state, score: scoreOf(this.goals, tuned.after), after: tuned.after });
    }
    tried.sort((a, b) => a.score - b.score);

    const moves: Move[] = [];
    const push = (kind: Move['kind'], label: string, state: SlotState, after: number[]) => {
      if (!this.respectsLocks(build, [{ slot: slotKey, state }])) return;
      const gain = baseline - scoreOf(this.goals, after);
      const sidegrade = gain <= EPSILON;
      if (sidegrade && !improvesAny(this.goals, before, after)) return;
      moves.push({
        kind, label, changes: [{ slot: slotKey, state }], gain, before, after,
        ...(sidegrade ? { sidegrade } : {}),
      });
    };

    // Past the upgrades, the best few trades too: a piece that gives up one
    // goal for another is still worth knowing about. They sort below every
    // upgrade by gain, which is already lower.
    const upgrades = tried.filter((t) => baseline - t.score > EPSILON);
    const trades = tried.filter((t) => baseline - t.score <= EPSILON
      && improvesAny(this.goals, before, t.after));
    for (const t of [...upgrades.slice(0, limit), ...trades.slice(0, 5)]) {
      push('item', named(t.item, t.state), t.state, t.after);
    }

    // Choosing cards for every candidate would multiply the work by the
    // card pool. The few best pieces, and the piece already worn, are where
    // it is worth doing.
    // The best few as they stand, and the best few by socket count -- the
    // second so a host is not passed over for being unremarkable bare.
    const bySockets = [...tried].sort((a, b) =>
      b.item.card_slots - a.item.card_slots || a.score - b.score);
    const hosts = [...new Set([...tried.slice(0, 5), ...bySockets.slice(0, 3)])]
      .map((t) => ({ item: t.item, state: t.state }));
    const worn = current.itemId ? this.data.items.get(current.itemId) : undefined;
    if (worn) hosts.push({ item: worn, state: current });
    for (const host of hosts) {
      if (host.item.card_slots === 0) continue;
      const filled = this.fillCards(build, slot, host.item, host.state);
      if (!filled) continue;
      // Cards can change what refine is worth ("ATK +1 per 2 refines" on a
      // card reads its host's), so the host is tuned again with them in.
      const retuned = this.tune(build, [{ slot: slotKey, state: filled.state }]);
      const { state } = retuned.changes[0];
      const kind = host.item === worn ? 'cards' : 'item';
      push(kind, withCards(named(host.item, state), state, this.data, kind === 'cards'),
        state, retuned.after);
    }

    if (withSets) {
      for (const move of this.setMoves(build)) {
        if (move.changes.some((c) => c.slot === slotKey)) moves.push(move);
      }
    }

    // Three tiers, not two. Anything that costs a goal its target goes below
    // every trade that keeps them all met, however well it scores -- the
    // score would happily buy a large overshoot with a small shortfall, and
    // that is not a trade the player asked for.
    const kept = dedupe(moves).sort((a, b) => b.gain - a.gain);
    const breaks = (m: Move) => this.breaks(m).length > 0;
    const safe = kept.filter((m) => !breaks(m));
    const listed = [
      ...safe.filter((m) => !m.sidegrade).slice(0, limit),
      ...safe.filter((m) => m.sidegrade).slice(0, 5),
      ...kept.filter(breaks).slice(0, 3),
    ];
    return withMaxed ? this.withMaxedVariants(build, listed) : listed;
  }

  /**
   * Each suggestion followed by the same suggestion at full refine.
   *
   * The refine a suggestion names is the least that does the job, which is
   * the right thing to plan around and the wrong thing to stop at: a +10
   * piece is what most players are actually working towards, and what it
   * adds on top is worth seeing next to the minimum rather than inferring.
   * Only pieces the suggestion puts on are raised -- worn gear keeps its
   * refine -- and nothing is added where they are already at the cap.
   */
  withMaxedVariants(build: Build, moves: Move[]): Move[] {
    const out: Move[] = [];
    for (const move of moves) {
      out.push(move);
      const maxed = this.maxedVariant(build, move);
      if (maxed) out.push(maxed);
    }
    return out;
  }

  private maxedVariant(build: Build, move: Move): Move | null {
    if (move.kind === 'rolls') return null;
    let raised = false;
    let cap = 0;
    const changes = move.changes.map((c) => {
      const item = this.data.items.get(c.state.itemId ?? -1);
      const limit = maxRefine(item);
      // What is already worn keeps its refine; that is the player's gear.
      if (!item || item.id === build.slots[c.slot]?.itemId || c.state.refine >= limit) return c;
      raised = true;
      cap = Math.max(cap, limit);
      return { ...c, state: { ...c.state, refine: limit } };
    });
    if (!raised) return null;
    // Only worth a row if the refine actually does something: plenty of
    // pieces scale nothing, and "the same again at +10" is just noise.
    const asIs = aggregate(applyChanges(build, move.changes, this.data), this.data);
    const full = aggregate(applyChanges(build, changes, this.data), this.data);
    if (diffTotals(asIs, full, this.data).length === 0) return null;
    const after = this.values(applyChanges(build, changes, this.data));
    const gain = scoreOf(this.goals, move.before) - scoreOf(this.goals, after);
    const single = move.changes.length === 1;
    return {
      ...move,
      label: single
        ? `+${cap} ${move.label.replace(/^\+\d+ /, '')}`
        : `${move.label} (all at +${cap})`,
      changes, gain, after,
      maxed: true,
    };
  }

  /**
   * Which random options to aim for on the piece in this slot.
   *
   * A roll is luck, not a choice, so this is advice for the next drop or
   * reroll rather than a step in the plan. Each roll takes the option that
   * serves the goals best at the top of its range; where the top has not
   * been established (max unknown) the minimum is used, so the promise is
   * one the item can keep. A skill-damage roll is aimed at a skill the goals
   * name. Rolls already set that nothing beats are left alone.
   */
  rollMoves(build: Build, slotKey: string): Move[] {
    if (!this.active || isLocked(build, slotKey)) return [];
    const state = build.slots[slotKey];
    const item = state?.itemId ? this.data.items.get(state.itemId) : undefined;
    const table = rollTableFor(this.data.rolls, slotKey, item);
    if (!state || !item || !table) return [];

    const before = this.values(build);
    const valuesWith = (rolls: Record<string, RollPick>) => this.values(
      applyChanges(build, [{ slot: slotKey, state: { ...state, rolls } }], this.data));
    let picks: Record<string, RollPick> = { ...(state.rolls ?? {}) };
    let best = scoreOf(this.goals, valuesWith(picks));
    const skillGoals = [...this.relevant.skills]
      .filter((k) => k.endsWith('|damage')).map((k) => k.slice(0, -'|damage'.length));

    const chosen: string[] = [];
    for (const roll of table.rolls) {
      let pickHere: RollPick | null = null;
      let labelHere = '';
      for (const option of roll.options) {
        const values = option.grants.map((g) => g.max ?? g.min);
        const tries = option.grants.some((g) => g.skill)
          ? skillGoals.map((skill) => ({ pick: { option: option.key, values, skill }, name: skill }))
          : [{ pick: { option: option.key, values } as RollPick, name: option.label }];
        for (const { pick, name } of tries) {
          const score = scoreOf(this.goals, valuesWith({ ...picks, [roll.key]: pick }));
          if (score < best - EPSILON) {
            best = score;
            pickHere = pick;
            labelHere = `${name} ${option.grants.map((g) => {
              const v = (g.max ?? g.min) * (g.sign ?? 1);
              return `${v > 0 ? '+' : ''}${v}${g.unit ?? ''}${g.max === null ? ' or more' : ''}`;
            }).join(' / ')}`;
          }
        }
      }
      if (pickHere) {
        picks = { ...picks, [roll.key]: pickHere };
        chosen.push(labelHere);
      }
    }
    if (chosen.length === 0) return [];
    const after = valuesWith(picks);
    return [{
      kind: 'rolls',
      label: `Aim for ${chosen.join(', ')} on ${item.name}`,
      changes: [{ slot: slotKey, state: { ...state, rolls: picks } }],
      gain: scoreOf(this.goals, before) - best,
      before, after,
    }];
  }

  /**
   * Pieces for this slot with more card slots than the one worn.
   *
   * Offered as an option rather than judged: a spare socket is worth
   * whatever card goes in it, which the goals may not say anything about --
   * a Weaver lower headgear beats most others simply by holding more cards.
   * The cards already in the slot carry over, and the new sockets are
   * filled with more copies of them, which is the usual reason to want the
   * sockets. The goal deltas are still shown, so a piece that costs
   * something on the goals says so.
   *
   * Most sockets first, then the highest level, which is where the better
   * pieces of a slot usually sit.
   */
  socketMoves(build: Build, slotKey: string, limit = 8): Move[] {
    const slot = SLOT_BY_KEY.get(slotKey);
    if (!slot || slot.cardTargets.length === 0 || isLocked(build, slotKey)) return [];
    if (slotKey === OFF_HAND && isTwoHanded(this.data.items.get(build.slots.weapon?.itemId ?? -1))) {
      return [];
    }
    const current = build.slots[slotKey] ?? EMPTY;
    const worn = current.itemId ? this.data.items.get(current.itemId) : undefined;
    const have = worn?.card_slots ?? 0;
    const before = this.values(build);
    const baseline = scoreOf(this.goals, before);
    const cards = current.cards.filter((c): c is number => !!c);

    const pieces = this.data.itemList
      .filter((i) => i.card_slots > have && fitsSlot(i, slot) && this.allowed(i))
      .sort((a, b) => b.card_slots - a.card_slots
        || b.required_level - a.required_level || a.name.localeCompare(b.name))
      .slice(0, limit);

    return this.withMaxedVariants(build, pieces.map((item) => {
      let state = carryInto(current, item, slot, this.data);
      // A fixed refine is an instruction; auto only means something with
      // goals to tune against, so without them the slot's refine is kept.
      if (typeof this.opts.refine === 'number') {
        state.refine = Math.min(maxRefine(item), Math.max(0, this.opts.refine));
      }
      const fitting = cards.filter((id) => {
        const card = this.data.items.get(id);
        return card && fitsCard(card, slot, item);
      });
      if (fitting.length > 0) {
        const sockets = [...state.cards];
        let next = 0;
        for (let i = 0; i < sockets.length; i++) {
          if (sockets[i] === null) sockets[i] = fitting[next++ % fitting.length];
        }
        state = { ...state, cards: sockets };
      }
      let after: number[];
      if (this.opts.refine === 'auto' && this.active) {
        state = { ...state, refine: 0 };
        const tuned = this.tune(build, [{ slot: slotKey, state }]);
        state = tuned.changes[0].state;
        after = tuned.after;
      } else {
        after = this.values(applyChanges(build, [{ slot: slotKey, state }], this.data));
      }
      const label = fitting.length > 0
        ? withCards(named(item, state), state, this.data, false)
        : named(item, state);
      return {
        kind: 'sockets' as const,
        label: `${label} · ${item.card_slots} slot${item.card_slots > 1 ? 's' : ''}`,
        changes: [{ slot: slotKey, state }],
        gain: baseline - scoreOf(this.goals, after),
        before, after,
      };
    }));
  }

  /**
   * The best ways to get more of one goal, met or not.
   *
   * The plan answers "how do I reach my targets"; this answers the other
   * question a player asks, which is "I want more of this one number -- what
   * can I swap, and what does it cost me?". A goal that is already met is
   * exactly when it is worth asking: the plan has nothing left to say there,
   * because every target is satisfied.
   *
   * Candidates come from a throwaway suggester that knows only this goal, so
   * relevance, card choice and refine are all worked out for the one stat.
   * They are then re-measured against the real goal list, which is where the
   * cost comes from: how much worse every *other* goal gets. Free moves come
   * first, most of the stat first. Then the trades, the best value for what
   * they cost first -- both measured as fractions of their own targets, the
   * way goals are compared everywhere else.
   */
  focusMoves(build: Build, goal: Goal, limit = 12): Move[] {
    // Identity first, so two goals on the same stat with different targets
    // stay distinct; by key only as a fallback for a copied goal object.
    let index = this.goals.indexOf(goal);
    if (index < 0) {
      index = this.goals.findIndex((g) => g.key === goal.key && g.column === goal.column);
    }
    if (index < 0) return [];
    const mine = this.goals[index];

    const inner = new Suggester(this.data, [mine], this.opts);
    // Refine is chosen to maximise the stat rather than to close a gap: a
    // met goal has no gap left, and tuning on shortfall would tie at every
    // refine and settle on +0.
    inner.pushing = true;
    if (!inner.active) return [];

    const before = this.values(build);
    const baseline = scoreOf(this.goals, before);
    const costBefore = scoreExcept(this.goals, before, index);
    const dir = mine.atMost ? -1 : 1;
    const scale = scaleOf(mine);

    const candidates: Move[] = [];
    for (const slot of SLOTS) {
      candidates.push(...inner.slotMoves(build, slot.key, limit, false, false));
    }
    candidates.push(...inner.setMoves(build));

    const rated: { move: Move; push: number; cost: number; broken: number }[] = [];
    for (const move of dedupe(candidates)) {
      const after = this.values(applyChanges(build, move.changes, this.data));
      const push = dir * (after[index] - before[index]) / scale;
      // More of the stat is the whole question, so anything that does not
      // give more of it is not an answer, however good it is otherwise.
      if (push <= EPSILON) continue;
      const cost = scoreExcept(this.goals, after, index) - costBefore;
      rated.push({
        move: { ...move, gain: baseline - scoreOf(this.goals, after), before, after },
        push,
        cost,
        broken: brokenGoals(this.goals, before, after).length,
      });
    }

    // Wanting more of one number is not permission to fall below another, so
    // whatever would do that is last whatever it buys -- and among those, the
    // ones that cost the fewest goals their target come first.
    const safe = rated.filter((r) => r.broken === 0);
    const free = safe.filter((r) => r.cost <= EPSILON).sort((a, b) => b.push - a.push);
    const trades = safe.filter((r) => r.cost > EPSILON)
      .sort((a, b) => b.push / b.cost - a.push / a.cost);
    const below = rated.filter((r) => r.broken > 0)
      .sort((a, b) => a.broken - b.broken || b.push / b.cost - a.push / a.cost);
    const listed = [...free.slice(0, limit), ...trades.slice(0, 5), ...below.slice(0, 3)]
      .map((r) => r.move);

    // Marked after the +10 variants exist, since raising a refine can start
    // costing another goal that the same piece at its minimum did not.
    return this.withMaxedVariants(build, listed).map((move) => {
      const cost = scoreExcept(this.goals, move.after, index) - costBefore;
      return cost > EPSILON ? { ...move, sidegrade: true } : { ...move, sidegrade: false };
    });
  }

  /**
   * A short plan across the whole build, one change at a time.
   *
   * Greedy: each step is the single best move given the steps before it, so
   * the steps build on each other and are meant to be applied in order. It
   * is not a search for the best build, and says so in the UI, but it
   * finishes in well under a second and every step it names is a real
   * improvement when it is taken.
   */
  plan(build: Build, maxSteps = 6): Move[] {
    if (!this.active) return [];
    // Every goal already met -- as it is from the start with goals read off
    // the build -- means there is no gap to close, so the plan looks for
    // upgrades instead: anything that raises a goal and lowers none, until
    // nothing does. Refine is then tuned for more rather than for enough,
    // since "enough" is +0 when nothing is short.
    const met = (b: Build) =>
      goalStatus(this.goals, aggregate(b, this.data), b, this.data).every((s) => s.met);
    if (met(build) && !this.pushing) {
      const upgrading = new Suggester(this.data, this.goals, this.opts);
      upgrading.pushing = true;
      return upgrading.plan(build, maxSteps);
    }
    const steps: Move[] = [];
    let current = build;
    for (let i = 0; i < maxSteps; i++) {
      if (!this.pushing && met(current)) break;

      let best: Move | null = null;
      for (const slot of SLOTS) {
        // No +10 variants: the plan is about what is needed, not the ceiling.
        for (const move of this.slotMoves(current, slot.key, 3, false, false)) {
          // A step that costs a goal its target is moving away from the point
          // of the plan, which is to have them all met. Left to the lists,
          // where it can be weighed by hand.
          if (this.breaks(move).length > 0) continue;
          if (!best || move.gain > best.gain) best = move;
        }
      }
      for (const move of this.setMoves(current)) {
        if (this.breaks(move).length > 0) continue;
        if (!best || move.gain > best.gain) best = move;
      }
      if (!best || best.gain <= EPSILON) break;
      steps.push(best);
      current = applyChanges(current, best.changes, this.data);
    }
    return steps;
  }

  /**
   * Finish a set whose bonus names a goal stat.
   *
   * A set is the one thing single swaps cannot find: until the last piece
   * goes on, each piece on its own may be worth nothing, so no one step
   * ever looks like progress. So each such set is tried as one move that
   * puts on everything missing at once.
   */
  setMoves(build: Build): Move[] {
    const before = this.values(build);
    const baseline = scoreOf(this.goals, before);
    const moves: Move[] = [];

    for (const set of this.sets) {
      const missing = missingMembers(build, set);
      // Four or more missing is a different build, not a suggestion.
      if (missing.length === 0 || missing.length > 3) continue;
      const placed = this.completeSet(build, set, missing);
      if (!placed) continue;
      // Tuned after placing, so set refine ("Set refine 18+") is judged with
      // every piece on rather than one piece at a time.
      const { changes, after } = this.tune(build, placed);
      if (!this.respectsLocks(build, changes)) continue;
      const gain = baseline - scoreOf(this.goals, after);
      if (gain <= EPSILON) continue;
      const names = missing.map((id) => {
        const item = this.data.items.get(id);
        const state = changes.find((c) => c.state.itemId === id)?.state;
        return item ? (state ? named(item, state) : item.name) : `#${id}`;
      });
      moves.push({
        kind: 'set',
        label: `Complete ${set.name} set: ${names.join(', ')}`,
        changes, gain, before, after,
      });
    }
    return moves;
  }

  /**
   * Where each missing piece of a set would go, or null if one has nowhere.
   *
   * A set is offered as one move that puts on everything missing at once, so
   * a set with any piece that cannot be placed -- barred by the class and
   * level filters, or left with only a locked slot -- is not offered at all
   * rather than offered half-done.
   */
  private completeSet(build: Build, set: SetRecord, missing: number[]): SlotChange[] | null {
    const fill = fillSet(build, set, missing, this.data, {
      allowed: (item) => this.allowed(item),
      place: (state, item, slot) => this.place(state, item, slot),
    });
    return fill.blocked.length > 0 ? null : fill.changes;
  }

  /** An item in a slot, at the refine these options assume. */
  private place(state: SlotState, item: Item, slot: SlotDef): SlotState {
    const next = carryInto(state, item, slot, this.data);
    // Auto starts from nothing and is raised by tune(), so a piece whose
    // refine does nothing for the goals is suggested unrefined.
    if (this.opts.refine === 'auto') next.refine = 0;
    else if (this.opts.refine !== null) {
      next.refine = Math.min(maxRefine(item), Math.max(0, this.opts.refine));
    }
    return next;
  }

  /**
   * With refine on auto, raise each newly placed piece to the lowest refine
   * that scores best, one piece at a time with the others in place.
   *
   * Only pieces the move puts on are touched. What is already worn keeps
   * the refine the player gave it: that is a fact about their gear, not an
   * assumption to optimise. And only when refine can reach a goal at all --
   * through the piece, a card in it, or its set's set-refine -- which keeps
   * the work to the handful of pieces where the answer is not simply +0.
   */
  private tune(build: Build, changes: SlotChange[]): { changes: SlotChange[]; after: number[] } {
    let out = changes;
    if (this.opts.refine === 'auto') {
      for (let i = 0; i < out.length; i++) {
        const { slot, state } = out[i];
        const item = this.data.items.get(state.itemId ?? -1);
        if (!item || item.id === build.slots[slot]?.itemId) continue;
        const limit = maxRefine(item);
        if (limit === 0 || !this.refineMatters(item, state)) continue;

        const at = (r: number) => out.map((c, j) =>
          (j === i ? { ...c, state: { ...c.state, refine: r } } : c));
        let bestRefine = 0;
        let bestScore = Infinity;
        for (let r = 0; r <= limit; r++) {
          const score = this.objective(this.values(applyChanges(build, at(r), this.data)));
          // Strictly better only, so a tie keeps the lower refine.
          if (score < bestScore - EPSILON) { bestScore = score; bestRefine = r; }
        }
        out = at(bestRefine);
      }
    }
    return { changes: out, after: this.values(applyChanges(build, out, this.data)) };
  }

  /**
   * What tuning a refine is trying to minimise.
   *
   * Shortfall only, normally: the small credit `scoreOf` gives for beating a
   * goal would otherwise pay for every refine past the target. When pushing
   * one stat there is no gap to close -- often the goal is already met -- so
   * the full score is used, and more of the stat always scores better.
   */
  private objective(values: number[]): number {
    return this.pushing ? scoreOf(this.goals, values) : shortfallOf(this.goals, values);
  }

  /** Can refining this piece move a goal at all? */
  private refineMatters(item: Item, state: SlotState): boolean {
    const scaled = (i: Item) => [...i.refine.per_refine, ...i.refine.thresholds]
      .some((g) => anyTouches(g.effects, this.relevant));
    if (scaled(item)) return true;
    for (const id of state.cards) {
      const card = id ? this.data.items.get(id) : undefined;
      if (card && scaled(card)) return true;
    }
    return item.sets.some((s) => {
      const set = this.data.sets[s];
      if (!set) return false;
      // Includes a set bonus's own inline "per total set refine" lines.
      const inline = set.set_bonus.filter((e) => e.per_set_refine ?? e.per_refine);
      return anyTouches(inline, this.relevant)
        || [...set.set_refine.per_set_refine, ...set.set_refine.thresholds]
          .some((g) => anyTouches(g.effects, this.relevant));
    });
  }

  /**
   * Choose cards for a piece one socket at a time, keeping a socket's card
   * when nothing beats it. Returns null when no change helps.
   */
  private fillCards(
    build: Build, slot: SlotDef, host: Item, state: SlotState,
  ): { state: SlotState; after: number[] } | null {
    const fitting = this.cards.filter((c) => fitsCard(c, slot, host));
    if (fitting.length === 0) return null;
    let best = { ...state, cards: socketsOf(host, state.cards) };
    let bestAfter = this.values(applyChanges(build, [{ slot: slot.key, state: best }], this.data));
    let bestScore = scoreOf(this.goals, bestAfter);
    let changed = false;

    for (let socket = 0; socket < best.cards.length; socket++) {
      for (const card of fitting) {
        if (best.cards[socket] === card.id) continue;
        const cards = [...best.cards];
        cards[socket] = card.id;
        const trial = { ...best, cards };
        const after = this.values(applyChanges(build, [{ slot: slot.key, state: trial }], this.data));
        const score = scoreOf(this.goals, after);
        if (score < bestScore - EPSILON) {
          best = trial; bestAfter = after; bestScore = score; changed = true;
        }
      }
    }
    return changed ? { state: best, after: bestAfter } : null;
  }
}

// ---- what a change does -------------------------------------------------

/** One number a change moves, for showing a suggestion's full effect. */
export interface TotalsChange {
  /** Matches a goal's key and column, so a goal's own line can be picked out. */
  key: string;
  column: Goal['column'];
  label: string;
  delta: number;
  /** '%', 's', or '' for a plain number. */
  unit: string;
  tone: Tone;
}

/**
 * Everything that differs between two finished builds: every stat column,
 * every skill modifier, every derived total. Losses included -- a
 * suggestion that shows only what it gains hides what it costs.
 *
 * Gains first, then losses, each in registry order so the same stat always
 * sits in the same place.
 */
export function diffTotals(before: Totals, after: Totals, data: Dataset): TotalsChange[] {
  const out: TotalsChange[] = [];
  for (const def of data.stats) {
    if (def.category === 'flag') continue;
    const a = before.byStat.get(def.id);
    const b = after.byStat.get(def.id);
    for (const column of ['flat', 'percent'] as const) {
      const delta = (b?.[column] ?? 0) - (a?.[column] ?? 0);
      if (Math.abs(delta) < 1e-9) continue;
      out.push({ key: def.key, column, label: def.name, delta,
        unit: column === 'percent' ? '%' : '', tone: statTone(def.key, delta) });
    }
  }
  for (const d of after.derived) {
    const was = before.derived.find((x) => x.key === d.key)?.total ?? 0;
    const delta = d.total - was;
    if (Math.abs(delta) < 1e-9) continue;
    out.push({ key: d.key, column: 'total', label: `${d.label} (total)`, delta,
      unit: '', tone: statTone(d.key, delta) });
  }
  const skillKeys = new Set([...before.skills.keys(), ...after.skills.keys()]);
  for (const key of [...skillKeys].sort()) {
    const a = before.skills.get(key);
    const b = after.skills.get(key);
    const { skill, metric, unit } = (b ?? a)!;
    for (const column of ['flat', 'percent'] as const) {
      const delta = (b?.[column] ?? 0) - (a?.[column] ?? 0);
      if (Math.abs(delta) < 1e-9) continue;
      out.push({ key: `${SKILL_PREFIX}${key}`, column, label: `${skill} ${metric}`, delta,
        unit: column === 'percent' ? '%' : unit ? ` ${unit}` : '', tone: skillTone(metric, delta) });
    }
  }
  return [...out.filter((c) => c.tone !== 'bad'), ...out.filter((c) => c.tone === 'bad')];
}

// ---- relevance ----------------------------------------------------------

/** What a set of goals is about: stat ids, and "<skill>|<metric>" keys. */
export interface Relevance {
  ids: Set<number>;
  skills: Set<string>;
}

export function relevanceOf(goals: Goal[], data: Dataset): Relevance {
  const ids = new Set<number>();
  const skills = new Set<string>();
  for (const goal of goals) {
    if (goal.key.startsWith(SKILL_PREFIX)) {
      skills.add(goal.key.slice(SKILL_PREFIX.length));
      continue;
    }
    // A derived value is fed by the gear stat of the same key (flee by
    // flee); a base stat total by that stat. Either way it is one id.
    const id = data.stats.find((s) => s.key === goal.key)?.id;
    if (id !== undefined) ids.add(id);
  }
  return { ids, skills };
}

/** Does anything on this item name one of these stats or skill modifiers? */
export function touches(item: Item, rel: Relevance): boolean {
  if (rel.ids.size === 0 && rel.skills.size === 0) return false;
  for (const [key, value] of [['atk', item.atk], ['matk', item.matk],
    ['def', item.def], ['mdef', item.mdef]] as const) {
    if (value && rel.ids.has(BASE_STAT_IDS[key])) return true;
  }
  if (anyTouches(item.effects, rel) || anyTouches(item.piece_bonus, rel)) return true;
  for (const g of [...item.refine.per_refine, ...item.refine.thresholds]) {
    if (anyTouches(g.effects, rel)) return true;
  }
  return (item.conditional ?? []).some((c) => anyTouches(c.effects, rel));
}

function setTouches(set: SetRecord, rel: Relevance): boolean {
  if (anyTouches(set.set_bonus, rel)) return true;
  return [...set.set_refine.per_set_refine, ...set.set_refine.thresholds]
    .some((g) => anyTouches(g.effects, rel));
}

function anyTouches(effects: Effect[] | undefined, rel: Relevance): boolean {
  return (effects ?? []).some((e) => (e.stat_ids ?? []).some((id) => rel.ids.has(id))
    || (!!e.skill_metric && (e.skills ?? []).some((s) =>
      rel.skills.has(skillKey(s, e.skill_metric!)))));
}

// ---- helpers ------------------------------------------------------------

function gearTotal(totals: Totals, data: Dataset, key: string) {
  const id = data.stats.find((s) => s.key === key)?.id;
  return id === undefined ? undefined : totals.byStat.get(id);
}

/** "+7 Mercury Riser" -- the refine is part of the suggestion, so it is named. */
function named(item: Item, state: SlotState): string {
  return state.refine > 0 ? `+${state.refine} ${item.name}` : item.name;
}

/** "Mercury Riser with Hodremlin Card ×4", or just the cards when re-carding. */
function withCards(name: string, state: SlotState, data: Dataset, cardsOnly: boolean): string {
  const counts = new Map<number, number>();
  for (const id of state.cards) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  const cards = [...counts].map(([id, n]) => {
    const name = data.items.get(id)?.name ?? `#${id}`;
    return n > 1 ? `${name} ×${n}` : name;
  }).join(', ');
  return cardsOnly ? `${cards} in ${name}` : `${name} with ${cards}`;
}

/** The same end state reached twice is one suggestion, kept at its best. */
function dedupe(moves: Move[]): Move[] {
  const seen = new Map<string, Move>();
  for (const move of moves) {
    const key = JSON.stringify(move.changes.map((c) =>
      [c.slot, c.state.itemId, c.state.cards, c.state.refine]));
    const prior = seen.get(key);
    if (!prior || move.gain > prior.gain) seen.set(key, move);
  }
  return [...seen.values()];
}
