import { aggregate, BASE_STAT_IDS, skillKey } from './aggregate.ts';
import { combine, defMultiplier, effectivePierce, FORMULAS, mdefMultiplier } from './derived.ts';
import { skillTone, statTone, type Tone } from './format.ts';
import { canEquip } from './jobs.ts';
import { rollTableFor, type RollPick } from './rolls.ts';
import { rankPlaystyles } from './presets.ts';
import {
  carryInto, fitsCard, fitsSlot, isLocked, isTwoHanded, maxRefine, OFF_HAND,
  settleHeadgear,
  SLOT_BY_KEY, SLOTS, socketsOf, type SlotDef,
} from './slots.ts';
import { fillSet, missingMembers } from './sets.ts';
import { acquisitionOf, farmFor } from './sources.ts';
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
  for (const c of DAMAGE_CHAINS) {
    out.push({ key: c.key, column: 'percent', label: `${c.label} %`, category: 'damage (combined)' });
  }
  for (const t of TARGET_TOTALS) {
    out.push({ key: t.key, column: 'percent', label: `${t.label} %`, category: 'damage vs any target' });
  }
  for (const [key, label] of Object.entries(SIDE_LABELS)) {
    out.push({ key, column: 'percent', label: `${label} %`, category: 'resistance and sustain' });
  }
  for (const g of TARGET_GROUPS) {
    out.push({ key: g.key, column: 'percent', label: `${g.label} %`, category: 'damage vs any target' });
  }
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

// ---- damage against a kind of target -------------------------------------

/**
 * Race, size and element damage, read the way it lands on a monster.
 *
 * The registry keeps "DMG vs All Races" as a stat of its own, beside
 * Demihuman, Brute and the rest, and a goal on one race used to read only
 * that race's column -- so a Demihuman goal never saw an all-races line, and
 * an Ifrit Card did nothing for a Large goal. Against a Demihuman both
 * apply, so a goal on one member of a group reads the member plus the
 * group's "all" stat.
 *
 * Elements have no "all" stat: "all elements" is written onto each of the
 * ten when the tooltip is parsed, so Vesper Card is already in every one.
 */
interface TargetGroup {
  /** The goal key for "against any of them". */
  key: string;
  label: string;
  members: string[];
  /** The stat for the whole group, when the registry has one. */
  all?: string;
}

const RACES = ['formless', 'undead_race', 'brute', 'plant', 'insect', 'fish', 'demon',
  'demihuman', 'angel', 'dragon'];
const SIZES = ['small', 'medium', 'large'];
const ELEMENTS = ['neutral', 'water', 'earth', 'fire', 'wind', 'poison', 'holy', 'dark', 'ghost',
  'undead'];

const TARGET_GROUPS: TargetGroup[] = [
  { key: 'any_race_dmg', label: 'DMG vs any race', members: RACES.map((r) => `dmg_vs_race_${r}`),
    all: 'dmg_vs_race_all_races' },
  { key: 'any_size_dmg', label: 'DMG vs any size', members: SIZES.map((s) => `dmg_vs_size_${s}`),
    all: 'dmg_vs_size_all_sizes' },
  { key: 'any_element_dmg', label: 'DMG vs any element', members: ELEMENTS.map((e) => `dmg_vs_${e}`) },
  { key: 'any_race_magic', label: 'Magic vs any race',
    members: RACES.map((r) => `magic_vs_race_${r}`), all: 'magic_vs_race_all_races' },
  { key: 'any_size_magic', label: 'Magic vs any size',
    members: SIZES.map((s) => `magic_vs_size_${s}`), all: 'magic_vs_size_all_sizes' },
];

/**
 * "Against any target": race, size and element together, as one percentage.
 *
 * The three are separate modifiers that multiply rather than add, as in
 * vanilla renewal -- confirmed for this server by the project owner. So +6% vs all sizes (Ifrit) and +4% vs all elements (Vesper)
 * can be weighed against each other and against a race card, in one number.
 * Magic has no element-of-target stat on this server, so its version is race
 * and size.
 */
const TARGET_TOTALS: { key: string; label: string; groups: string[] }[] = [
  { key: 'any_target_dmg', label: 'DMG vs any target',
    groups: ['any_race_dmg', 'any_size_dmg', 'any_element_dmg'] },
  { key: 'any_target_magic', label: 'Magic vs any target', groups: ['any_race_magic', 'any_size_magic'] },
];

/**
 * One damage chain as one number: the multipliers a hit goes through, each
 * a separate modifier that multiplies the others, as in renewal.
 *
 * Kept apart as goals, the links were traded against each other by their
 * rank in the list rather than by what they do to a hit -- ATK +3% ranked
 * above "vs any target" beat a +6% all-sizes card, when the card is twice
 * the damage. Folded into one goal they are weighed the way they stack.
 * Critical damage is left out: it only applies on a crit.
 */
/** Chain links for how much a playstyle's skills gain from base stats. */
const SKILL_RATIO_PHYS = 'skill_ratio_phys';
const SKILL_RATIO_MAGIC = 'skill_ratio_magic';

/**
 * How far base stats raise a playstyle's skill ratios, as one percentage:
 * the geometric mean over its skills of (base + stats) / base, less one.
 * Each skill counts alike in relative terms, so a +8%-per-AGI skill and a
 * +1%-per-AGI one pull by what they do to their own damage. The playstyle is
 * the class's first with scaling of this kind (`scaling` in
 * data/class-goals.json); none, and the link is 0 -- a plain damage chain.
 */
function skillRatio(kind: 'physical' | 'magic', totals: Totals, build: Build, data: Dataset): number {
  // A class can have several styles of one kind -- an Assassin's katar,
  // blades and axe are all physical -- so the one the base stats fit best.
  const styles = (data.classGoals?.[build.className ?? ''] ?? []).filter((p) => p.scaling?.kind === kind);
  const style = styles.length > 1 ? rankPlaystyles(styles, build.baseStats)[0]?.style : styles[0];
  const skills = style?.scaling?.skills ?? [];
  if (skills.length === 0) return 0;
  const stat = (k: string) => measure({ key: k, column: 'total', target: 0 }, totals, build, data);
  const logs = skills.map((sk) => {
    const bonus = Object.entries(sk.per).reduce((acc, [k, per]) => acc + (per ?? 0) * stat(k), 0);
    return Math.log((sk.base + bonus) / sk.base);
  });
  return 100 * (Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length) - 1);
}

const DAMAGE_CHAINS: { key: string; label: string; factors: string[] }[] = [
  { key: 'phys_dmg_mult', label: 'Physical DMG (ATK% × target)', factors: ['atk', 'any_target_dmg'] },
  { key: 'melee_dmg_mult', label: 'Melee DMG (ATK% × target × melee)',
    factors: ['atk', 'any_target_dmg', 'melee_damage'] },
  { key: 'ranged_dmg_mult', label: 'Ranged DMG (ATK% × target × ranged)',
    factors: ['atk', 'any_target_dmg', 'ranged_damage'] },
  { key: 'magic_dmg_mult', label: 'Magic DMG (MATK% × target)', factors: ['matk', 'any_target_magic'] },
  // The same, with the skills' own scaling off base stats as one more link:
  // a Satsujin's Full Moon is 500% +8% per AGI, so a point of AGI is some
  // 0.65% more damage on top of its flee. See `skillRatio`.
  { key: 'phys_skill_mult', label: 'Physical skill DMG (ATK% × target × stat scaling)',
    factors: ['atk', 'any_target_dmg', SKILL_RATIO_PHYS] },
  { key: 'ranged_skill_mult', label: 'Ranged skill DMG (ATK% × target × ranged × stat scaling)',
    factors: ['atk', 'any_target_dmg', 'ranged_damage', SKILL_RATIO_PHYS] },
  { key: 'melee_skill_mult', label: 'Melee skill DMG (ATK% × target × melee × stat scaling)',
    factors: ['atk', 'any_target_dmg', 'melee_damage', SKILL_RATIO_PHYS] },
  { key: 'magic_skill_mult', label: 'Magic skill DMG (MATK% × target × stat scaling)',
    factors: ['matk', 'any_target_magic', SKILL_RATIO_MAGIC] },
];
const CHAIN_BY_KEY = new Map(DAMAGE_CHAINS.map((c) => [c.key, c]));

const GROUP_BY_KEY = new Map(TARGET_GROUPS.map((g) => [g.key, g]));
const GROUP_OF_MEMBER = new Map(TARGET_GROUPS.flatMap((g) => g.members.map((m) => [m, g] as const)));

/**
 * Goals worked out here rather than read off one stat. There is no line in
 * a change's stat list that is the goal's own, so their movement has to be
 * shown from the goal values instead -- see `computedGoal`.
 */
export function computedGoal(key: string): boolean {
  return key === SP_SUSTAIN || GROUP_BY_KEY.has(key) || TARGET_TOTALS.some((t) => t.key === key)
    || CHAIN_BY_KEY.has(key) || key in SIDE_LABELS
    || !!GROUP_OF_MEMBER.get(key)?.all;
}

function percentOf(totals: Totals, data: Dataset, key: string): number {
  return gearTotal(totals, data, key)?.percent ?? 0;
}

/** One member of a group as it lands: its own column plus the group's "all". */
function memberPercent(totals: Totals, data: Dataset, group: TargetGroup, member: string): number {
  return percentOf(totals, data, member) + (group.all ? percentOf(totals, data, group.all) : 0);
}

/**
 * The bonus that holds whatever of the group is being hit: the weakest
 * member's. A Demihuman card is worth nothing here, and an all-races one its
 * full amount, which is the difference between building for one map and
 * building to hit anything.
 */
function groupPercent(totals: Totals, data: Dataset, group: TargetGroup): number {
  return Math.min(...group.members.map((m) => memberPercent(totals, data, group, m)));
}

/** The stats a target goal or damage chain reads, for relevance. */
function targetInputs(key: string): string[] {
  // Which base stats a class's skills scale off is the class's business;
  // for relevance, any of them may.
  if (key === SKILL_RATIO_PHYS || key === SKILL_RATIO_MAGIC) return [...BASE_STAT_KEYS];
  if (key === RES_ELEMENTS) return RES_ELEMENT_KEYS;
  if (key === RES_RACES) return RES_RACE_KEYS;
  if (key === RES_DAMAGE) return RES_DAMAGE_INPUTS;
  if (key === KILL_SUSTAIN) return ['hp_on_kill', 'sp_on_kill'];
  if (key === LEECH) return LEECH_INPUTS;
  const chain = CHAIN_BY_KEY.get(key);
  if (chain) return chain.factors.flatMap((f) => [f, ...targetInputs(f)]);
  const group = GROUP_BY_KEY.get(key);
  if (group) return [...group.members, ...(group.all ? [group.all] : [])];
  const total = TARGET_TOTALS.find((t) => t.key === key);
  if (total) return total.groups.flatMap(targetInputs);
  const of = GROUP_OF_MEMBER.get(key);
  return of?.all ? [key, of.all] : [];
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
 *
 * Movement speed joined them on the project owner's word: past -10% a
 * character feels awful to play, whatever it gains.
 */
export const DEFAULT_GUARDS: Goal[] = [
  { key: 'max_hp', column: 'percent', target: -50, guard: true },
  { key: SP_SUSTAIN, column: 'total', target: -50, guard: true },
  { key: 'move_speed', column: 'percent', target: -10, guard: true },
];

/** This build's guards: its own if it has said, otherwise the defaults. */
export function guardsOf(build: Build): Goal[] {
  return (build.guards ?? DEFAULT_GUARDS).map((g) => ({ ...g, guard: true }));
}

/**
 * Everything a suggestion is judged against: the goals, the guards, and --
 * given the dataset -- the side goals every build has (`sideGoals`).
 *
 * Guards and side goals last so they cannot shift the priority of a goal --
 * the order of `goals` is the player's ranking, and it has to keep meaning that.
 */
export function allGoals(build: Build, data?: Dataset): Goal[] {
  const goals = [...(build.goals ?? []), ...guardsOf(build)];
  return data ? [...goals, ...sideGoals(build, aggregate(build, data), data)] : goals;
}

/**
 * Resistance, as three averages: across the ten elements, across the ten
 * races (with "all races" folded into each), and against damage in general.
 * An average, not the weakest member as damage uses: resisting one element
 * still helps every time that element hits. A negative member counts double:
 * a hole in your resistances -- Godslayer's -50% against every race -- is
 * worse than the same amount of plain absence would suggest.
 */
export const RES_ELEMENTS = 'res_elements';
export const RES_RACES = 'res_races';
export const RES_DAMAGE = 'res_damage';
/** HP and SP back per kill, as a percentage of a typical pool. */
export const KILL_SUSTAIN = 'kill_sustain';
/**
 * Leech as what it returns on average: chance times amount, HP and SP
 * together, in percent of damage dealt. The two halves come from different
 * gear and multiply, so neither alone says anything.
 */
export const LEECH = 'leech';

/**
 * The pool a kill's HP and SP are measured against: roughly a level 100
 * character's. The sheet has no Max HP or SP of its own yet, so this is a
 * calibration, not a reading -- Wyrdbrand's 500 HP and 20 SP a kill come
 * out at 5% and 4%.
 */
const KILL_POOL = { hp: 10000, sp: 500 };

const RES_ELEMENT_KEYS = ELEMENTS.map((e) => `res_${e}`);
const RES_RACE_KEYS = RACES.map((r) => `res_race_${r}`);
const LEECH_INPUTS = ['leech_hp_rate', 'leech_hp_power', 'leech_sp_rate', 'leech_sp_power'];
const RES_DAMAGE_INPUTS = ['damage_reduction', 'res_melee', 'res_ranged',
  'physical_damage_received', 'magic_damage_received'];

/** A resistance member as it counts: a negative one double. */
const resisted = (v: number) => (v < 0 ? 2 * v : v);

function sideMeasure(key: string, totals: Totals, data: Dataset): number | undefined {
  const pct = (k: string) => percentOf(totals, data, k);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  switch (key) {
    case RES_ELEMENTS:
      return mean(RES_ELEMENT_KEYS.map((k) => resisted(pct(k))));
    case RES_RACES: {
      const all = pct('res_race_all_races');
      return mean(RES_RACE_KEYS.map((k) => resisted(pct(k) + all)));
    }
    case RES_DAMAGE:
      // Final reduction applies to everything; melee and ranged each to half
      // of it, and "received" is the same thing from the other side.
      return resisted(pct('damage_reduction'))
        + mean([resisted(pct('res_melee')), resisted(pct('res_ranged'))])
        - mean([pct('physical_damage_received'), pct('magic_damage_received')]);
    case LEECH:
      return (pct('leech_hp_rate') * pct('leech_hp_power')
        + pct('leech_sp_rate') * pct('leech_sp_power')) / 100;
    case KILL_SUSTAIN: {
      const flat = (k: string) => gearTotal(totals, data, k)?.flat ?? 0;
      return 100 * (flat('hp_on_kill') / KILL_POOL.hp + flat('sp_on_kill') / KILL_POOL.sp);
    }
    default:
      return undefined;
  }
}

/** Labels for the side measures, which have no line of their own in the registry. */
const SIDE_LABELS: Record<string, string> = {
  [RES_ELEMENTS]: 'Resistance vs elements (avg)',
  [RES_RACES]: 'Resistance vs races (avg)',
  [RES_DAMAGE]: 'Damage reduction (all)',
  [KILL_SUSTAIN]: 'HP/SP on kill (% of pool)',
  [LEECH]: 'Leech (avg % of damage)',
};

/**
 * What every build cares about a little, whatever its goals.
 *
 * From the project owner: Max HP % and Max SP % matter to every class;
 * resistances are good side goals even where a build is not about them, and
 * a negative one can be devastating; ASPD Limit matters to anything that
 * attacks for its damage; and HP or SP back per kill pays for a great deal
 * of HP and SP costs. None of these is a goal a player set, so each is
 * worth a little per point -- `gain` and `loss` per `per` units, against a
 * top-priority goal's 1 per whole target. Calibrations, not measurements.
 *
 * Max HP and SP are charged for losses only: crediting gains would crowd the
 * goals out with HP gear. At 0.25 per 100%, a Black Acidus Card's ATK +5% no
 * longer pays for its HP -50%.
 */
const SIDE_RULES: { key: string; column: Goal['column']; side: NonNullable<Goal['side']>;
  physical?: boolean }[] = [
  // Max HP both ways: from the project owner, it is worth more than a loss
  // to avoid -- +10% about +2 AGI on a 74 AGI build. Max SP losses only.
  { key: 'max_hp', column: 'percent', side: { gain: 0.3, loss: 0.3, per: 100 } },
  { key: 'max_sp', column: 'percent', side: { gain: 0, loss: 0.25, per: 100 } },
  { key: RES_ELEMENTS, column: 'percent', side: { gain: 0.5, loss: 0.5, per: 100 } },
  { key: RES_RACES, column: 'percent', side: { gain: 0.5, loss: 0.5, per: 100 } },
  { key: RES_DAMAGE, column: 'percent', side: { gain: 0.5, loss: 0.5, per: 100 } },
  { key: KILL_SUSTAIN, column: 'percent', side: { gain: 0.5, loss: 0.5, per: 100 } },
  // Leech: how a physical build keeps its HP up between potions. Per 1% of
  // damage returned on average -- Evil Wing Ears' 15% chance of 3% is 0.45%.
  { key: LEECH, column: 'percent', side: { gain: 0.04, loss: 0.04, per: 1 }, physical: true },
  // A point of ASPD Limit about as much as +3 AGI on a 100 AGI build.
  { key: 'aspd_limit', column: 'flat', side: { gain: 0.03, loss: 0.03, per: 1 }, physical: true },
  // VIT and INT raise Max HP and SP and their regeneration, so they help any
  // build a little whatever its goals: a +6 Valkyrie Circlet is worth having
  // on a build that never asked for either. A point about a quarter of what
  // a point of AGI is to a 74 AGI build that ranks it first.
  // Perfect Dodge: a chance to dodge a normal physical attack outright, so
  // 100 is immunity to them -- but not to skills, so of minor value.
  { key: 'perfect_dodge', column: 'flat', side: { gain: 0.1, loss: 0.1, per: 100 } },
  { key: 'vit', column: 'total', side: { gain: 0.003, loss: 0.003, per: 1 } },
  { key: 'int', column: 'total', side: { gain: 0.003, loss: 0.003, per: 1 } },
];

/** Goal keys that mark a build as one that attacks for its damage. */
const PHYSICAL = /^(atk|def_pen|melee_damage|ranged_damage|crit_|aspd|double_attack|dmg_vs_|any_(target|race|size|element)_dmg$|(phys|melee|ranged)_dmg_mult$)/;

/**
 * Every side goal, each held where the build already is.
 *
 * A stat the player already has a goal on is left to that goal. ASPD Limit
 * is left out of a build with no physical goal: a caster gains nothing from it.
 */
export function sideGoals(build: Build, totals: Totals, data: Dataset): Goal[] {
  const own = build.goals ?? [];
  const physical = own.some((g) => PHYSICAL.test(g.key));
  return SIDE_RULES
    .filter((r) => (!r.physical || physical)
      && !own.some((g) => g.key === r.key && g.column === r.column))
    .map((r) => {
      const goal: Goal = { key: r.key, column: r.column, target: 0, side: r.side };
      goal.target = Math.floor(measure(goal, totals, build, data) * 100 + EPSILON) / 100;
      return goal;
    });
}

/** The stats the side goals read: never "not used by this build". */
const SIDE_STATS = ['max_hp', 'max_sp', ...RES_ELEMENT_KEYS, ...RES_RACE_KEYS,
  ...RES_DAMAGE_INPUTS, 'hp_on_kill', 'sp_on_kill', 'aspd_limit', 'perfect_dodge', ...LEECH_INPUTS,
  'vit', 'int'];

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

/**
 * Stats a class wants whatever its gear says so far. From players: the
 * Legend and Revenant branches are built around crits, so crit is never
 * incidental there -- one source is enough to make it a goal, and losing
 * it is always a loss.
 */
export const CLASS_WANTS: Record<string, string[]> = {
  Vagabond: ['crit_rate', 'crit_damage'],
  Legend: ['crit_rate', 'crit_damage'],
  Trickster: ['crit_rate', 'crit_damage'],
  Revenant: ['crit_rate', 'crit_damage'],
};

/**
 * The stats that count for this build: its goals, what its gear stacks,
 * and what its class always wants. A change that costs something outside
 * this -- two crit off a build with none to speak of -- costs it nothing.
 */
export function statsThatMatter(
  build: Build, totals: Totals, data: Dataset, goals: Goal[] = [],
): Set<string> {
  const out = new Set<string>();
  for (const g of [...goals, ...goalsFromBuild(build, totals, data)]) out.add(g.key);
  for (const key of CLASS_WANTS[build.className ?? ''] ?? []) out.add(key);
  for (const key of SIDE_STATS) out.add(key);
  return out;
}

// ---- reach ----------------------------------------------------------------

/**
 * What a character can plausibly get next, read off what it already has.
 *
 * Suggestions across the whole build used to reach for whatever scored best
 * in the database: a +10 on a character with no +9s, a sun helmet, Valhalla
 * drops for a build still farming mid-level maps. All of those are real
 * items and none of them is advice. So the build's own gear sets the bar:
 * the second-best piece on each count, not the best, so one lucky drop or
 * one +10 does not unlock everything.
 *
 * Only for suggestions across the whole build. Browsing one slot is someone
 * looking at what exists, and there everything is shown.
 */
export interface Reach {
  /** The longest grind (see data/items/effort.json) worth suggesting. */
  effort: number | null;
  /** The toughest monster, in effective HP, a suggestion may send you after. */
  kill: number | null;
  /** The highest refine worth assuming on a suggested piece. */
  refine: number;
}

/** The ways forward from a build that has met its goals; see `upgradePaths`. */
export interface UpgradePaths {
  /** The best swap within reach, one per slot, and sets to finish. */
  near: Move[];
  /** Cards for the pieces already worn, one per slot: empty sockets first of all. */
  cards: Move[];
  /** Worn pieces refined further, up to +9. */
  refines: Move[];
  /** Copies of worn pieces with rolls that suit the build better. */
  rolls: Move[];
  /** The best out of reach, one per slot: something to work towards. */
  far: Move[];
  /** Trades: more of one goal for less of another, best on balance first. */
  sides: Move[];
  /** High-effort moves far enough ahead of the rest to target-farm. */
  farm: Move[];
  /** Other sets worth finishing, beyond the one a list above already took. */
  sets: Move[];
}

/** What the suggestion overlay shows: the recommendations, by kind. */
export type PlanPaths = UpgradePaths;

/** How many set swaps, and other trades, are tried with changes to win back what they cost. */
const PAIR_SETS = 4;
const PAIR_TRADES = 4;
/** And how many changes a combination may add. */
const MAX_FIXES = 2;

/** What the trade search finds: trades, what to farm, and combinations that are upgrades. */
export interface TradeOffs {
  sides: Move[];
  farm: Move[];
  /** Trades that, with a change or two elsewhere, lower nothing at all. */
  combos: Move[];
}

/** How many alternative sets are listed. */
export const SET_ALTERNATIVES = 4;

/**
 * How many "within reach" swaps are listed: one per slot, so enough for
 * every gear slot rather than the eight every other list stops at. A slot
 * left off the end is an upgrade the player never hears about.
 */
const NEAR_LIMIT = 14;
/** How many sets the "within reach" list takes among the slots. */
const NEAR_SETS = 2;

/**
 * What a piece past the build's reach is discounted by when ranked against
 * ones within it. A ranking, not a filter: an Invoker's Ring that is worth
 * twice anything nearby still comes out on top.
 */
export const HIGH_EFFORT_DISCOUNT = 0.5;

/**
 * How far a high-effort move has to outdo the best within reach before it
 * is called out as worth farming on purpose. A calibration, not a model.
 */
export const STANDOUT_FACTOR = 2;

/** And the least it has to be worth at all: a tenth of the top goal's target. */
const STANDOUT_MIN = 0.1;

/**
 * What a change is worth to the goals, gains less losses, each goal as a
 * fraction of where it stands and at its priority.
 *
 * The score cannot rank trades. It charges a goal dropped below its target
 * in full and credits one raised past it on a log, which is right for
 * "don't take what I have" and useless for "is +15% leech worth 5 crit".
 * This is the straight sum, so a trade that gives far more than it takes
 * comes out ahead. Guards are left out: they are lines, not amounts.
 * `gainsOnly` sums just the goals it raises, for weighing against a cost
 * that is not a goal's.
 */
export function tradeValue(
  goals: Goal[], before: number[], after: number[], gainsOnly = false,
): number {
  let total = 0;
  goals.forEach((goal, i) => {
    if (goal.guard) return;
    const scale = Math.max(scaleOf(goal), Math.abs(before[i]));
    const term = goal.side ? sideWorth(goal, before[i], after[i])
      : priorityWeight(i) * (goal.atMost ? -1 : 1)
        * (scored(goal, after[i]) - scored(goal, before[i])) / scale;
    total += gainsOnly ? Math.max(0, term) : term;
  });
  return total;
}

/**
 * What a trade is charged per 100% lost on a stat the goals do not cover.
 *
 * `tradeValue` sees only the goals, so a sidegrade that buys a little crit
 * with -160% HP and SP regen looked free -- neither regen is anyone's goal,
 * and both are still what keeps a character going between fights. A quarter
 * per 100% keeps a small loss cheap and makes a pile of them cost more than
 * most trades gain: +10% on the top goal is worth 0.1.
 */
export const COLLATERAL_WEIGHT = 0.25;

/**
 * The losses a change inflicts outside the goals, as a trade cost.
 *
 * Percent columns only: they share a scale, where a flat 200 HP and a flat
 * 2 ASPD do not. Skill modifiers are left out -- one on a skill the build does
 * not use costs it nothing -- and so are gains, since a stat nobody asked for
 * is not a reason to take a trade.
 */
export function collateralCost(changes: TotalsChange[], rel: Relevance, data: Dataset): number {
  let cost = 0;
  for (const c of changes) {
    if (c.tone !== 'bad' || c.column !== 'percent' || c.key.startsWith(SKILL_PREFIX)) continue;
    const id = data.stats.find((s) => s.key === c.key)?.id;
    if (id === undefined || rel.ids.has(id)) continue;
    cost += COLLATERAL_WEIGHT * Math.abs(c.delta) / 100;
  }
  return cost;
}

/** The furthest a suggestion refines a piece already worn. See `refineMoves`. */
export const REFINE_MOVE_CAP = 9;

/**
 * How far past the build's own gear a suggestion may reach, in grind. Was 5,
 * until a build wearing three Sky Garden pieces (easy, from the project
 * owner) had Rachel Jewel (rare) within reach. A calibration.
 */
export const REACH_EFFORT_FACTOR = 3;
/**
 * How much tougher a monster may be than the ones the build already farms.
 * Tighter than the grind: a longer grind is patience, a monster three times
 * tougher is a different character.
 */
export const REACH_KILL_FACTOR = 3;
/**
 * The refine assumed reachable even with nothing refined yet: the top of
 * the HD ore tier. Was 4; the project owner counts a +6 Valkyrie Circlet an
 * easy goal. This server's refine rates are still not known.
 */
export const REACH_REFINE_FLOOR = 6;

export function reachOf(build: Build, data: Dataset): Reach {
  const efforts: number[] = [];
  const kills: number[] = [];
  const refines: number[] = [];
  for (const state of Object.values(build.slots)) {
    const item = state?.itemId ? data.items.get(state.itemId) : undefined;
    if (!item) continue;
    for (const id of [item.id, ...state.cards]) {
      const e = id ? data.effort?.get(id) : undefined;
      if (e !== undefined) {
        efforts.push(e.effort);
        kills.push(e.kill);
      }
    }
    if (maxRefine(item) > 0) refines.push(state.refine);
  }
  const secondBest = (xs: number[]) => {
    const sorted = [...xs].sort((a, b) => b - a);
    return sorted[1] ?? sorted[0];
  };
  // The character's level is a floor under what its gear says: whatever it
  // wears, it can farm the monsters of its own level -- and a fresh
  // character in starter gear would otherwise read as having no limit.
  const floor = levelFloor(build.baseLevel, data);
  const effort = maxOf(secondBest(efforts), floor?.effort);
  const kill = maxOf(secondBest(kills), floor?.kill);
  return {
    effort: effort === undefined ? null : effort * REACH_EFFORT_FACTOR,
    kill: kill === undefined ? null : kill * REACH_KILL_FACTOR,
    refine: Math.max(REACH_REFINE_FLOOR, secondBest(refines) ?? 0),
  };
}

/** The larger of two numbers either of which may be missing. */
function maxOf(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

/** What a character of this level typically farms; the nearest level below if missing. */
function levelFloor(level: number, data: Dataset): { effort: number; kill: number } | undefined {
  const table = data.levelReach;
  if (!table) return undefined;
  for (let l = level; l >= 1; l--) {
    const row = table.get(l);
    if (row) return row;
  }
  return undefined;
}

/**
 * The refine an item's recipe asks of a piece going into it: "The moon
 * headgear has to be refined to exactly +9" is a +9 before the sun helmet
 * is even possible.
 */
function refineRequired(item: Item): number {
  const note = acquisitionOf(item)?.note ?? '';
  const m = /refined to (?:exactly )?\+(\d+)/i.exec(note);
  return m ? Number(m[1]) : 0;
}

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
  const wanted = new Set(CLASS_WANTS[build.className ?? ''] ?? []);
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
    if (sources < (wanted.has(key) ? 1 : FOCUS_MIN_SOURCES)) return;
    // Open: the target is where the build is, not where the stat stops mattering.
    const goal: Goal = { key, column, target: 0, open: true, ...(lower ? { atMost: true } : {}) };
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
  const side = sideMeasure(goal.key, totals, data);
  if (side !== undefined) return side;
  if (goal.key === SKILL_RATIO_PHYS) return skillRatio('physical', totals, build, data);
  if (goal.key === SKILL_RATIO_MAGIC) return skillRatio('magic', totals, build, data);
  const group = GROUP_BY_KEY.get(goal.key);
  if (group) return groupPercent(totals, data, group);
  const total = TARGET_TOTALS.find((t) => t.key === goal.key);
  if (total) {
    const product = total.groups.reduce((acc, key) =>
      acc * (1 + groupPercent(totals, data, GROUP_BY_KEY.get(key)!) / 100), 1);
    return (product - 1) * 100;
  }
  const chain = CHAIN_BY_KEY.get(goal.key);
  if (chain) {
    const product = chain.factors.reduce((acc, f) =>
      acc * (1 + measure({ key: f, column: 'percent', target: 0 }, totals, build, data) / 100), 1);
    return (product - 1) * 100;
  }
  const member = GROUP_OF_MEMBER.get(goal.key);
  if (member?.all && goal.column === 'percent') {
    return memberPercent(totals, data, member, goal.key);
  }
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
 * Where more of a stat stops mattering, for a goal that does not say.
 *
 * From the project owner: SP cost is solved at -50%, and penetration past
 * 70 is worth nothing. Built in rather than only on the presets, because a
 * goal saved before, or read off the build, carries no cap of its own -- and
 * a build at -62% SP cost was still being sent after more.
 */
const DEFAULT_CAPS: Record<string, number> = { sp_cost: -50, def_pen: 70, mdef_pen: 70 };

/** A goal's cap: its own, or the stat's default, never short of its target. */
export function goalCap(goal: Goal): number | undefined {
  if (goal.cap !== undefined) return goal.cap;
  const cap = DEFAULT_CAPS[goal.key];
  if (cap === undefined) return undefined;
  return goal.atMost ? Math.min(cap, goal.target) : Math.max(cap, goal.target);
}

/**
 * Penetration as the damage it lets through, in percent over none, against
 * the average level 130+ monster (208 DEF, 116 MDEF -- data/mobs/armor-targets.json).
 *
 * Read as a straight line, every point to 70 was worth the same, and three
 * Hodremlin Cards taking a build from 36 to 57 penetration outranked three
 * melee +3% cards. Through the in-game pierce curve and renewal's DEF
 * formula, 5 to 25 is some +17% damage, but 36 to 57 only +10% -- less than
 * the +9% melee is on every hit, once melee is ranked above it.
 */
const REF_DEF = 208;
const REF_MDEF = 116;
const PEN_DAMAGE: Record<string, (pen: number) => number> = {
  def_pen: (p) => 100 * (defMultiplier(REF_DEF, effectivePierce(p)) / defMultiplier(REF_DEF, 0) - 1),
  mdef_pen: (p) => 100 * (mdefMultiplier(REF_MDEF, effectivePierce(p)) / mdefMultiplier(REF_MDEF, 0) - 1),
};

/**
 * A goal's value as scoring weighs it: capped, and for penetration turned
 * into the damage it adds. The goal list still shows the raw figure.
 */
function scored(goal: Goal, value: number): number {
  const c = capped(goal, value);
  return PEN_DAMAGE[goal.key]?.(c) ?? c;
}

/** How far short of its target a goal is, as scoring weighs it; negative past it. */
function gapOf(goal: Goal, value: number): number {
  const at = scored(goal, value);
  const target = scored(goal, goal.target);
  return goal.atMost ? at - target : target - at;
}

/** A goal's value with anything past its cap cut off: past it, more is nothing. */
export function capped(goal: Goal, value: number): number {
  const cap = goalCap(goal);
  if (cap === undefined) return value;
  return goal.atMost ? Math.max(value, cap) : Math.min(value, cap);
}

/**
 * What an open goal's surplus is worth, as a fraction of its target: all of
 * it up to the cap. Zero for a goal that is not open, or not yet met.
 *
 * A goal read off the build or a preset starts at where the build already
 * is. Crediting what lies past that at a tenth, on a log, as an ordinary
 * goal's surplus is, made it a line the build had reached and could stop
 * at -- so penetration at a set 50 pulled every plan towards the one set
 * that had it, and nothing past it counted.
 */
function openSurplus(goal: Goal, value: number): number {
  if (!goal.open) return 0;
  return Math.max(0, -gapOf(goal, value)) / scaleOf(goal);
}

/**
 * Goals are compared as fractions of their own target, so 10 missing crit
 * and 1,000 missing HP are weighed as what they are relative to what was
 * asked for, not by which number happens to be bigger. The floor of 1 stops
 * a target of 0 from dividing by nothing.
 *
 * A percentage is floored at 100 instead, because it is a multiplier on
 * something: ATK +5% is a twentieth more damage whatever the goal's target
 * says. At a floor of 1 a percent goal starting at 0 counted +1% as a
 * whole target's worth -- so +14% ATK on a Pasana-carded dagger outscored
 * +3 AGI on a 74 AGI build by several hundred times, and every stat goal
 * was drowned out. Guards keep their own scale: their weight is calibrated
 * on it.
 *
 * Penetration goes with them. It is a flat number, but one out of 100 --
 * 100 is full pierce -- and each point is worth roughly half a percent of
 * damage against a level 130 monster's DEF. Against its usual target of 25
 * a point counted as much as 10% ATK, and pen cards filled every slot.
 */
function scaleOf(goal: Goal): number {
  const percent = goal.column === 'percent' || goal.key === SP_SUSTAIN
    || OUT_OF_100.has(goal.key);
  return Math.max(Math.abs(goal.target), percent && !goal.guard ? PERCENT_SCALE : 1);
}

/** What a percent goal is measured against, at the least: the whole of the base. */
const PERCENT_SCALE = 100;
/** Flat stats that run 0-100, and so are weighed as percentages are. */
const OUT_OF_100 = new Set(['def_pen', 'mdef_pen']);

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

/**
 * What moving a side goal from one value to another is worth: positive for
 * better. Linear, at its own rates each way -- there is no target to reach,
 * only more or less of something every build likes.
 */
function sideWorth(goal: Goal, from: number, to: number): number {
  const d = to - from;
  const { gain, loss, per } = goal.side!;
  return (d > 0 ? gain : loss) * d / per;
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
    if (goal.side) { score -= sideWorth(goal, goal.target, values[i]); return; }
    const short = gapOf(goal, values[i]) / scaleOf(goal);
    // A guard that holds is worth nothing. Crediting the surplus would turn
    // "don't halve my HP" into "keep taking HP", which is a different thing
    // to ask for and one the player can ask for with an ordinary goal.
    if (short <= 0 && goal.guard) return;
    const surplus = goal.open ? openSurplus(goal, values[i])
      : SURPLUS_WEIGHT * Math.log1p(Math.max(0, -short));
    score += weightOf(goal, i) * (short > 0 ? short : -surplus);
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
 *
 * A side goal is never broken: it sits at the build's own value, so any
 * loss at all would cross it, and a little HP for a lot of damage is a trade
 * to weigh, not one to rule out. Its loss is charged by the score instead.
 */
export function brokenGoals(goals: Goal[], before: number[], after: number[]): Goal[] {
  return goals.filter((goal, i) => !goal.side
    && shortOf(goal, before[i]) <= EPSILON && shortOf(goal, after[i]) > EPSILON);
}

/** Side goals this change lowers: HP, a resistance, sustain given up. */
export function sideLost(goals: Goal[], before: number[], after: number[]): Goal[] {
  return goals.filter((goal, i) => goal.side && after[i] < before[i] - EPSILON);
}

/**
 * Complete sets a change would leave incomplete.
 *
 * A player running a full set is running it on purpose -- the set bonus is
 * usually the reason for the pieces -- so a swap that breaks one is judged
 * like one that takes a goal below its target: listed after everything
 * that keeps them whole, and never planned. The score would often allow
 * it, because a set bonus the goals do not name counts for nothing there.
 */
export function brokenSets(before: Totals, after: Totals): SetRecord[] {
  const stillWhole = new Set(after.setProgress.filter((p) => p.complete).map((p) => p.set.index));
  return before.setProgress.filter((p) => p.complete && !stillWhole.has(p.set.index))
    .map((p) => p.set);
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
    if (goal.side) { total -= Math.min(0, sideWorth(goal, goal.target, values[i])); return; }
    // An open goal is not done at its target, so refine is tuned for its
    // surplus too; an ordinary goal's surplus is left to the full score.
    total += weightOf(goal, i) * (Math.max(0, gapOf(goal, values[i])) / scaleOf(goal)
      - openSurplus(goal, values[i]));
  });
  return total;
}

// ---- moves --------------------------------------------------------------

export interface Move {
  /**
   * 'sockets': a piece with more card slots, offered whatever the goals say.
   * 'rolls': the random options worth aiming for on the piece already worn.
   * 'refine': the piece already worn, refined further.
   */
  kind: 'item' | 'cards' | 'set' | 'sockets' | 'rolls' | 'refine';
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
  /**
   * Puts on something past what the build usually reaches: a longer grind
   * or a tougher monster. Still suggested -- it may well be worth it -- but
   * said, and ranked below what is close by.
   */
  highEffort?: boolean;
  /**
   * High effort, and so far ahead of anything within reach that it is worth
   * going after on purpose. Only for pieces that drop from something.
   */
  standout?: boolean;
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
  /**
   * What the character can plausibly get next. Undefined means "work it out
   * from the build" when planning across the whole build, and no limit when
   * working on one slot; null means no limit anywhere. See `Reach`.
   */
  reach?: Reach | null;
}

const EMPTY: SlotState = { itemId: null, refine: 0, cards: [] };
const EPSILON = 1e-9;

/**
 * Put changes into a build.
 *
 * A two-handed weapon takes the off hand with it, so anything left there is
 * cleared rather than counted -- otherwise a suggestion could claim a
 * shield's bonus alongside a weapon that cannot be held with one. The same
 * goes for a headgear worn in two positions: see `settleHeadgear`.
 */
export function applyChanges(build: Build, changes: SlotChange[], data: Dataset): Build {
  let slots = { ...build.slots };
  for (const change of changes) {
    slots[change.slot] = change.state;
    // A headgear worn in two positions empties the other one, and whatever
    // goes where one was takes it off.
    slots = settleHeadgear(slots, change.slot, data);
  }
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
    // which is where they do their work. Side goals likewise: they weigh
    // what a change does, they are not a reason to go looking through gear.
    this.wanted = goals.filter((g) => !g.guard && !g.side);
    this.relevant = relevanceOf(this.wanted, data);
    this.sets = data.sets.filter((s) => setTouches(s, this.relevant));
    this.setsTouching = new Set(this.sets.map((s) => s.index));
    this.cards = data.itemList.filter((i) =>
      i.kind === 'Card' && this.allowed(i) && touches(i, this.relevant));
  }

  /** The options it was built with, so the same suggester can be rebuilt elsewhere. */
  get options(): SuggestOptions {
    return this.opts;
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
    if (this.opts.maxLevel !== null && item.required_level > this.opts.maxLevel) return false;
    const reach = this.opts.reach;
    if (reach) {
      const e = this.data.effort?.get(item.id);
      if (e && reach.effort !== null && e.effort > reach.effort) return false;
      if (e && reach.kill !== null && e.kill > reach.kill) return false;
      if (refineRequired(item) > reach.refine) return false;
    }
    return true;
  }

  /** The highest refine to assume on this piece: its cap, or the build's reach. */
  private refineCap(item: Item): number {
    return Math.min(maxRefine(item), this.opts.reach?.refine ?? Infinity);
  }

  /**
   * This suggester held to what the build can reach, for suggestions across
   * the whole build. Itself when a reach was already given.
   */
  private withinReach(build: Build): Suggester {
    if (this.opts.reach !== undefined) return this;
    const held = new Suggester(this.data, this.goals, { ...this.opts, reach: reachOf(build, this.data) });
    held.pushing = this.pushing;
    return held;
  }

  /** The goals this move would take below their target. */
  breaks(move: Move): Goal[] {
    return brokenGoals(this.goals, move.before, move.after);
  }

  /** The complete sets this move would break, from `build`. */
  breaksSets(build: Build, move: Move): SetRecord[] {
    return brokenSets(aggregate(build, this.data),
      aggregate(applyChanges(build, move.changes, this.data), this.data));
  }

  /** Neither takes a goal below its target nor breaks a complete set. */
  private keeps(build: Build, move: Move): boolean {
    return this.breaks(move).length === 0 && this.breaksSets(build, move).length === 0;
  }

  /** `keeps`, and gives up no Max HP % or Max SP % either: an upgrade, not a trade. */
  private lowersNothing(build: Build, move: Move): boolean {
    return this.keeps(build, move) && sideLost(this.goals, move.before, move.after).length === 0;
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
    // What reaches past the slot it names -- a two-handed weapon emptying
    // the off hand, a two-position headgear emptying the other position --
    // is caught by looking at what the change leaves behind.
    const after = applyChanges(build, changes, this.data).slots;
    return build.locked.every((k) => JSON.stringify(after[k]) === JSON.stringify(build.slots[k]));
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
    // Only a trade is judged on what it costs outside the goals, so this is
    // worked out on the first one rather than for every slot asked about.
    let outside: { covered: Relevance; totals: Totals } | null = null;
    const push = (kind: Move['kind'], label: string, state: SlotState, after: number[]) => {
      if (!this.respectsLocks(build, [{ slot: slotKey, state }])) return;
      const gain = baseline - scoreOf(this.goals, after);
      const sidegrade = gain <= EPSILON;
      if (sidegrade && !improvesAny(this.goals, before, after)) return;
      // What a trade gains on the goals has to outweigh what it costs
      // outside them: -160% regen for a little crit is not a sidegrade.
      // Only the gains -- a trade between two goals is shown as one, and its
      // cost to the goals is already on the row.
      if (sidegrade) {
        outside ??= { covered: relevanceOf(this.goals, this.data), totals: aggregate(build, this.data) };
        const next = aggregate(applyChanges(build, [{ slot: slotKey, state }], this.data), this.data);
        const cost = collateralCost(diffTotals(outside.totals, next, this.data), outside.covered, this.data);
        if (tradeValue(this.goals, before, after, true) - cost <= EPSILON) return;
      }
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
    // Held to a reach, the suggestion already sits at the highest refine the
    // build can be expected to hit; "the same at +10" is the advice it is
    // there to stop giving.
    if (this.opts.reach) return null;
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
   *
   * Held to a reach -- suggestions across the whole build -- it aims at the
   * middle of each range instead: a copy worth farming for, not the one
   * perfect drop.
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
        const aim = (g: { min: number; max: number | null }) => (g.max === null ? g.min
          : this.opts.reach ? Math.round((g.min + g.max) / 2) : g.max);
        const values = option.grants.map(aim);
        const tries = option.grants.some((g) => g.skill)
          ? skillGoals.map((skill) => ({ pick: { option: option.key, values, skill }, name: skill }))
          : [{ pick: { option: option.key, values } as RollPick, name: option.label }];
        for (const { pick, name } of tries) {
          const score = scoreOf(this.goals, valuesWith({ ...picks, [roll.key]: pick }));
          if (score < best - EPSILON) {
            best = score;
            pickHere = pick;
            labelHere = `${name} ${option.grants.map((g) => {
              const v = aim(g) * (g.sign ?? 1);
              const more = g.max === null || aim(g) < g.max;
              return `${v > 0 ? '+' : ''}${v}${g.unit ?? ''}${more ? ' or more' : ''}`;
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
      label: this.opts.reach
        ? `Farm another ${item.name} rolled ${chosen.join(', ')}`
        : `Aim for ${chosen.join(', ')} on ${item.name}`,
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
    // Past the build's reach too: asking for more of one number is exactly
    // when a long grind can be worth knowing about. Such moves are marked
    // and ranked at HIGH_EFFORT_DISCOUNT, never left out.
    const reach = this.reachFor(build);
    // Identity first, so two goals on the same stat with different targets
    // stay distinct; by key only as a fallback for a copied goal object.
    let index = this.goals.indexOf(goal);
    if (index < 0) {
      index = this.goals.findIndex((g) => g.key === goal.key && g.column === goal.column);
    }
    if (index < 0) return [];
    const mine = this.goals[index];

    const inner = new Suggester(this.data, [mine], { ...this.opts, reach: anyGrind(reach) });
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
    candidates.push(...inner.refineMoves(build));

    const rated: { move: Move; push: number; cost: number; broken: number }[] = [];
    for (const move of dedupe(candidates)) {
      const after = this.values(applyChanges(build, move.changes, this.data));
      const push = dir * (scored(mine, after[index]) - scored(mine, before[index])) / scale;
      // More of the stat is the whole question, so anything that does not
      // give more of it is not an answer, however good it is otherwise.
      if (push <= EPSILON) continue;
      const cost = scoreExcept(this.goals, after, index) - costBefore;
      const highEffort = this.beyondReach(build, move, reach);
      rated.push({
        move: {
          ...move, gain: baseline - scoreOf(this.goals, after), before, after,
          ...(highEffort ? { highEffort } : {}),
        },
        push: highEffort ? push * HIGH_EFFORT_DISCOUNT : push,
        cost,
        broken: brokenGoals(this.goals, before, after).length
          + this.breaksSets(build, move).length,
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
    // costing another goal that the same piece at its minimum did not. Held
    // to a reach, there are none: see `maxedVariant`.
    return (reach ? listed : this.withMaxedVariants(build, listed)).map((move) => {
      const cost = scoreExcept(this.goals, move.after, index) - costBefore;
      return cost > EPSILON ? { ...move, sidegrade: true } : { ...move, sidegrade: false };
    });
  }

  /**
   * Every way forward from a build whose goals are all met, by kind.
   *
   * Once nothing is short there is no gap for a plan to close, and a greedy
   * chain of steps only shows whatever scores highest -- the easy +9 on a
   * circlet, or the sun helmet a player could be working towards, both drop
   * off the end. So the answer is a set of paths instead, each on its own:
   * the best swap for each slot within reach, refines on what is worn,
   * better-rolled copies, and the best of what is out of reach for each
   * slot, with what to farm for it.
   *
   * Every goal and guard is held where the build already is, not merely at
   * its target: an upgrade raises something and lowers nothing. A build
   * that has met its SP cost goal has not thereby made SP cost free to
   * spend, and treating a surplus as spendable is how an off-hand swap used
   * to cost it the SP efficiency it was built around.
   */
  upgradePaths(build: Build, perKind = 8): UpgradePaths {
    return last(this.upgradeStream(build, perKind), emptyPaths());
  }

  /**
   * `upgradePaths` a piece at a time: a snapshot after each slot, each list
   * and each goal's trades, so a caller can show what is found as it is
   * found. The last snapshot is the answer. Cheapest and closest first --
   * within reach, sets, refines, rolls -- then what is further off.
   */
  *upgradeStream(build: Build, perKind = 8): Generator<UpgradePaths> {
    const out = emptyPaths();
    if (!this.active) { yield out; return; }
    const reach = this.reachFor(build);
    const near = this.upgrader(build, reach);
    const wide = this.upgrader(build, wideOf(reach));
    const snap = (): UpgradePaths => ({ ...out });

    let perSlot: Move[] = [];
    for (const found of near.nearStream(build)) {
      perSlot = found.near;
      out.near = found.near;
      out.cards = found.cards;
      yield snap();
    }
    const nearSets = best(near.setMoves(build)).filter((m) => near.lowersNothing(build, m));
    // The best couple of sets beside the slots, the rest under "other sets":
    // a character with no shadow gear is offered a dozen whole shadow sets,
    // and they pushed every single-slot upgrade off the end of the list.
    const chosenSets = nearSets.slice(0, NEAR_SETS);
    // A piece of a set that is already on the list says the same thing
    // again, four times over for a four-slot shadow set.
    const inSets = new Set(chosenSets.flatMap((m) => m.changes.map((c) => c.state.itemId)));
    const upgrades = best([
      ...perSlot.filter((m) => !m.changes.every((c) => inSets.has(c.state.itemId))),
      ...chosenSets,
    ]).slice(0, NEAR_LIMIT);
    out.near = upgrades;
    out.sets = nearSets.filter((m) => !upgrades.some((u) => u.label === m.label))
      .slice(0, SET_ALTERNATIVES);
    yield snap();
    out.refines = best(near.refineMoves(build)).filter((m) => near.lowersNothing(build, m))
      .slice(0, perKind);
    out.rolls = best(SLOTS.flatMap((slot) => near.rollMoves(build, slot.key)))
      .filter((m) => near.lowersNothing(build, m)).slice(0, 3);
    yield snap();

    const far: Move[] = [];
    for (const slot of SLOTS) {
      const top = wide.topOf(build, slot.key, (m) => this.beyondReach(build, m, reach));
      if (!top) continue;
      far.push({ ...top, highEffort: true });
      out.far = best([...far]).slice(0, perKind);
      yield snap();
    }
    // A set already recommended is not offered again as a trade, at some
    // other refine: it is the same decision.
    const listed = new Set([...upgrades, ...out.sets].map(setName).filter(Boolean));
    for (const t of this.tradeOffStream(build, upgrades, out.far, perKind)) {
      out.sides = t.sides.filter((m) => !listed.has(setName(m)));
      out.farm = t.farm;
      // A trade that a change or two elsewhere turns into a net win, lowering
      // nothing, is recommended with the rest.
      if (t.combos.length > 0) out.near = best([...upgrades, ...t.combos]).slice(0, NEAR_LIMIT);
      yield snap();
    }
  }

  /**
   * This suggester as `upgradeStream` asks its questions: every goal held
   * where the build already is, more always wanted, within `reach`.
   */
  private upgrader(build: Build, reach: Reach | null): Suggester {
    const s = new Suggester(this.data, this.heldAt(build), { ...this.opts, reach });
    s.pushing = true;
    return s;
  }

  /** The best swap for one slot that lowers nothing and passes `keep`. */
  private topOf(build: Build, slot: string, keep: (m: Move) => boolean = () => true): Move | undefined {
    return best(this.slotMoves(build, slot, 3, false, false))
      .find((m) => this.lowersNothing(build, m) && keep(m));
  }

  /**
   * The best swap for each slot, and the best cards for each piece already
   * worn, a slot at a time: the lists so far after each.
   *
   * Cards get their own list because the best swap for a slot is almost
   * never the piece already there. Four empty sockets were invisible behind
   * a slightly better helmet, when a card is the cheapest upgrade there is.
   */
  private *nearStream(build: Build): Generator<{ near: Move[]; cards: Move[] }> {
    const near: Move[] = [];
    const cards: Move[] = [];
    for (const slot of SLOTS) {
      const top = this.topOf(build, slot.key);
      const card = this.cardMove(build, slot.key);
      if (top) near.push(top);
      if (card) cards.push(card);
      if (!top && !card) continue;
      yield { near: best([...near]).slice(0, NEAR_LIMIT), cards: best([...cards]) };
    }
  }

  /** Better cards in the piece this slot already holds, if any help and lower nothing. */
  private cardMove(build: Build, slotKey: string): Move | null {
    const slot = SLOT_BY_KEY.get(slotKey);
    const state = build.slots[slotKey];
    const item = state?.itemId ? this.data.items.get(state.itemId) : undefined;
    if (!slot || !item || item.card_slots === 0 || isLocked(build, slotKey)) return null;
    const filled = this.fillCards(build, slot, item, state);
    if (!filled) return null;
    const before = this.values(build);
    const move: Move = {
      kind: 'cards',
      label: withCards(named(item, filled.state), filled.state, this.data, true),
      changes: [{ slot: slotKey, state: filled.state }],
      gain: scoreOf(this.goals, before) - scoreOf(this.goals, filled.after),
      before, after: filled.after,
    };
    return move.gain > EPSILON && this.lowersNothing(build, move) ? move : null;
  }

  /**
   * Everything the suggestion overlay shows, a section at a time.
   *
   * Recommendations, each on its own and measured from the build as it is:
   * the best swap for each slot, cards for what is worn, refines, better
   * rolls, other sets, what is out of reach, and trades. Goals short or met,
   * the same lists -- a short goal simply counts for more in each.
   *
   * There used to be a plan here: greedy steps that built on each other. The
   * project owner found a chain the wrong shape for advice. A player picks
   * an upgrade, not a route, and a chain hid every slot the first steps did
   * not reach. `plan` is still there for anyone who wants the route.
   *
   * Each snapshot is complete as far as it goes; the last is the answer. A
   * generator so the work can be spread out -- the app runs it off the page,
   * showing each snapshot as it lands -- and paused and picked up again.
   */
  *paths(build: Build): Generator<PlanPaths> {
    yield* this.upgradeStream(build);
  }

  /**
   * The best few sets to finish within reach, other than any in `taken`.
   *
   * A plan takes the one set that scores best and moves on, so a close
   * second -- Fallen Civilization beside Dragon Claw -- is never seen. A
   * set is a bigger decision than one swap, and which one depends on what
   * the player can farm, so the runners-up are listed on their own. Each
   * keeps every goal and complete set, as a plan step would.
   */
  setAlternatives(build: Build, taken: Move[] = [], limit = SET_ALTERNATIVES): Move[] {
    if (!this.active) return [];
    const held = this.withinReach(build);
    const upgrading = goalStatus(this.goals, aggregate(build, this.data), build, this.data)
      .every((s) => s.met);
    const s = new Suggester(this.data, this.goals, held.opts);
    s.pushing = held.pushing || upgrading;
    const labels = new Set(taken.map((m) => m.label));
    return s.setMoves(build)
      .filter((m) => m.gain > EPSILON && !labels.has(m.label) && s.keeps(build, m))
      .sort((a, b) => b.gain - a.gain)
      .slice(0, limit);
  }

  /**
   * Every goal held where the build already is, not merely at its target:
   * an upgrade raises something and lowers nothing. See `upgradePaths`.
   */
  private heldAt(build: Build): Goal[] {
    const values = this.values(build);
    // Held at the cap, not past it: at -62% SP cost with a cap of -50%,
    // giving back 12% costs nothing and is not a loss to guard.
    return this.goals.map((g, i) => {
      const v = capped(g, values[i]);
      return { ...g, cap: goalCap(g), target: g.atMost ? Math.min(g.target, v) : Math.max(g.target, v) };
    });
  }

  /** The reach these options give, or the build's own when they give none. */
  private reachFor(build: Build): Reach | null {
    return this.opts.reach === undefined ? reachOf(build, this.data) : this.opts.reach;
  }

  /** Does this move put on anything, piece or card, that the reach turns away? */
  private beyondReach(build: Build, move: Move, reach: Reach | null): boolean {
    if (!reach) return false;
    const near = new Suggester(this.data, [], { ...this.opts, reach });
    return move.changes.some((c) => {
      // A piece put on at a refine past the build's usual is a stretch too.
      const worn = build.slots[c.slot];
      const raised = c.state.itemId !== worn?.itemId ? c.state.refine : c.state.refine - (worn?.refine ?? 0);
      if (raised > 0 && c.state.refine > reach.refine) return true;
      return newIds(build, c).some((id) => {
        const item = this.data.items.get(id);
        return !!item && !near.allowed(item);
      });
    });
  }

  /**
   * The trades worth making, and what is worth farming on purpose.
   *
   * `upgradePaths` only lists changes that lower nothing, which is right for
   * "upgrade" and leaves out the change a player most often means by
   * "sidegrade": an Invoker's Ring for an accessory that gave a little crit,
   * when the build is about leech. So the best change per goal is found as
   * `focusMoves` finds it -- a suggester that knows only that goal -- and
   * each is weighed by `tradeValue`: all it gains against all it costs.
   * What comes out ahead, and crosses no guard, is listed, one per slot.
   *
   * Past the build's reach it is still listed, marked, and ranked at
   * `HIGH_EFFORT_DISCOUNT`. And a high-effort change worth `STANDOUT_FACTOR`
   * times the best within reach -- `upgrades` are that, the plan's steps or
   * the within-reach swaps -- is called out in `farm`, if it drops anywhere.
   */
  tradeOffs(build: Build, upgrades: Move[], far: Move[], limit = 8): TradeOffs {
    return last(this.tradeOffStream(build, upgrades, far, limit), { sides: [], farm: [], combos: [] });
  }

  /** `tradeOffs` a goal at a time: the lists so far, after each goal's search. */
  *tradeOffStream(
    build: Build, upgrades: Move[], far: Move[], limit = 8,
  ): Generator<TradeOffs> {
    if (!this.active) { yield { sides: [], farm: [], combos: [] }; return; }
    const held = this.heldAt(build);
    const reach = this.reachFor(build);
    const before = this.values(build);
    const baseline = scoreOf(this.goals, before);
    const wideOpts = { ...this.opts, reach: anyGrind(reach) };
    // What the goals, guards included, already account for; losses anywhere
    // else are charged by `collateralCost`.
    const covered = relevanceOf(this.goals, this.data);
    const totalsBefore = aggregate(build, this.data);

    type Rated = { move: Move; value: number; rank: number; slot: string };
    const rated: Rated[] = [];
    const seen = new Set<string>();
    // Trades that give something up, for combining below.
    const costly: { move: Move; worth: number; breaksSet: boolean }[] = [];
    // Combinations that, together, lower nothing: upgrades, not trades.
    const combos: Move[] = [];
    // A set found for one goal had its refine tuned for that goal alone: the
    // AGI search put Aggressive Orphan on at +0, blind to the +10% against
    // every race its set refine pays at 9 and again at 18. Retuned here
    // against every goal before it is weighed.
    // The real goals and guards, not `held`: held at the build's own
    // figures, the SP guard read the set's -10% Max SP as crossing a line
    // and tuned the refine back to +0.
    const tuner = new Suggester(this.data, this.goals, wideOpts);
    tuner.pushing = true;
    const retuned = (move: Move): Move => {
      if (move.kind !== 'set') return move;
      const { changes } = tuner.tune(build, move.changes);
      const set = this.data.sets.find((x) => x.name === setName(move));
      return { ...move, changes, ...(set ? { label: this.setTitle(build, set, changes) } : {}) };
    };
    const rate = (found: Move, pairable = true) => {
      const move = pairable ? retuned(found) : found;
      const key = stateKey(move);
      if (seen.has(key)) return;
      seen.add(key);
      if (!this.respectsLocks(build, move.changes)) return;
      const next = applyChanges(build, move.changes, this.data);
      const after = this.values(next);
      const moved = held.map((g, i) => (g.guard ? 0 : (g.atMost ? -1 : 1) * (after[i] - before[i])));
      // Upgrades are listed as upgrades; this is for what costs something.
      if (!moved.some((d) => d < -EPSILON) || !moved.some((d) => d > EPSILON)) return;
      // A trade may cost a goal; it may not cross a guard's line.
      if (brokenGoals(this.goals, before, after).some((g) => g.guard)) return;
      if (pairable) {
        costly.push({ move, worth: tradeValue(held, before, after),
          breaksSet: move.kind === 'set' && brokenSets(totalsBefore, aggregate(next, this.data)).length > 0 });
      }
      const value = tradeValue(held, before, after)
        - collateralCost(diffTotals(totalsBefore, aggregate(next, this.data), this.data), covered, this.data);
      if (value <= EPSILON) return;
      const highEffort = this.beyondReach(build, move, reach);
      rated.push({
        move: {
          ...move, before, after, gain: baseline - scoreOf(this.goals, after), sidegrade: true,
          ...(highEffort ? { highEffort } : {}),
        },
        value,
        rank: highEffort ? value * HIGH_EFFORT_DISCOUNT : value,
        // One row per set, paired with a win-back change or not, whichever
        // comes out ahead.
        slot: move.kind === 'set' ? `set:${setName(move) || move.label}` : move.changes.map((c) => c.slot).join('+'),
      });
    };

    // The lists as they stand, from what has been rated so far.
    const lists = () => {
      const sorted = [...rated].sort((a, b) => b.rank - a.rank);
      const perSlot = new Map<string, (typeof rated)[number]>();
      for (const r of sorted) if (!perSlot.has(r.slot)) perSlot.set(r.slot, r);
      const sides = [...perSlot.values()].slice(0, limit);

      // Farming on purpose: measured against everything that is not itself a
      // long way off.
      const valueOf = (m: Move) => tradeValue(held, before, m.after);
      const close = Math.max(0, ...upgrades.map(valueOf), ...sides.filter((r) => !r.move.highEffort)
        .map((r) => r.value));
      const farm = [...far.map((m) => ({ move: m, value: valueOf(m) })),
        ...sides.filter((r) => r.move.highEffort)]
        .filter((r) => r.value >= STANDOUT_MIN && r.value >= STANDOUT_FACTOR * close
          && this.farmable(build, r.move))
        .sort((a, b) => b.value - a.value)
        .slice(0, 3)
        .map((r) => ({ ...r.move, highEffort: true, standout: true }));
      const standing = new Set(farm.map((m) => m.label));
      return {
        sides: sides.map((r) => (standing.has(r.move.label) ? { ...r.move, standout: true } : r.move)),
        farm,
        combos: best([...combos]),
      };
    };

    // A goal at a time, so the lists fill in as the search goes rather than
    // all at the end.
    for (const goal of held) {
      if (goal.guard || goal.side) continue;
      const inner = new Suggester(this.data, [goal], wideOpts);
      inner.pushing = true;
      if (!inner.active) continue;
      // And the same at up to +9, where the refine pays: a +9 Valkyrie
      // Circlet is a trade for a Wyrdbrand where a +6 one is not. Marked high
      // effort past the build's usual refine, so ranked below what is close.
      const refined = new Suggester(this.data, [goal],
        { ...wideOpts, reach: wideOpts.reach && { ...wideOpts.reach, refine: Math.max(wideOpts.reach.refine, REFINE_MOVE_CAP) } });
      refined.pushing = true;
      // Re-carding what is worn, which three new pieces for the slot would
      // otherwise crowd out: melee cards for the Hodremlins in a knife
      // already in the off hand is a trade worth seeing. Within reach as well
      // as past it, or the best cards anywhere (Bestia) hide the ones a
      // player can actually get.
      const close = new Suggester(this.data, [goal], { ...this.opts, reach });
      close.pushing = true;
      const found: Move[] = [];
      for (const slot of SLOTS) {
        found.push(...inner.slotMoves(build, slot.key, 3, false, false));
        for (const s of [close, inner]) {
          const cards = s.cardMove(build, slot.key);
          if (cards) found.push(cards);
        }
      }
      found.push(...inner.setMoves(build));
      // Each piece found, tuned again with +9 allowed: only where refine pays
      // does it come back different.
      for (const move of [...found]) {
        if (move.kind !== 'item' || move.changes.length !== 1) continue;
        const { changes } = refined.tune(build, move.changes);
        const [c] = changes;
        const item = this.data.items.get(c.state.itemId ?? -1);
        if (!item || c.state.refine === move.changes[0].state.refine) continue;
        found.push({ ...move, changes, label: move.label.replace(/^(\+\d+ )?/, `+${c.state.refine} `) });
      }
      for (const move of dedupe(found)) rate(move);
      yield lists();
    }

    // A trade usually costs something one or two changes elsewhere would win
    // back: trading Fallen Civilization away drops SP cost -50%, and a
    // refined Laevateinn or a rune gets much of it back. Judged alone, the
    // trade is charged for all of it. So the most promising -- swaps of a
    // whole set first, then the best other trades -- are tried with up to
    // two changes, in slots they leave alone, each the one that does most
    // for the combination as a whole. What then lowers nothing at all is an
    // upgrade in its own right; the rest are trades like any other.
    const promising = [
      ...costly.filter((c) => c.breaksSet).sort((a, b) => b.worth - a.worth).slice(0, PAIR_SETS),
      ...costly.filter((c) => !c.breaksSet).sort((a, b) => b.worth - a.worth).slice(0, PAIR_TRADES),
    ];
    for (const { move } of promising) {
      const combo = this.compensate(build, move, held, before, reach);
      if (combo === move) continue;
      const next = applyChanges(build, combo.changes, this.data);
      const after = this.values(next);
      const lowers = held.some((g, i) => !g.guard && (g.atMost ? -1 : 1) * (after[i] - before[i]) < -EPSILON);
      const outside = collateralCost(diffTotals(totalsBefore, aggregate(next, this.data), this.data), covered, this.data);
      const gain = baseline - scoreOf(this.goals, after);
      // Recommended is within reach; a combination past it stays a trade,
      // marked and ranked lower like any other.
      if (!lowers && outside <= EPSILON && gain > EPSILON && !this.beyondReach(build, combo, reach)
        && !brokenGoals(this.goals, before, after).some((g) => g.guard)) {
        combos.push({ ...combo, before, after, gain, sidegrade: false });
      } else {
        rate(combo, false);
      }
    }
    if (promising.length > 0) yield lists();
    if (seen.size === 0) yield lists();
  }

  /**
   * A trade, plus up to `MAX_FIXES` changes that win back what it costs.
   *
   * Each change is the one, in a slot the combination has not touched yet,
   * that leaves the whole worth most -- a swap, cards, or refining a piece
   * already worn -- found by a suggester that knows only the goals still
   * short of where they were. It stops as soon as nothing helps. Returns
   * the trade itself when nothing does.
   */
  private compensate(build: Build, move: Move, held: Goal[], before: number[], reach: Reach | null): Move {
    let combo = move;
    let worth = tradeValue(held, before, this.values(applyChanges(build, move.changes, this.data)));
    for (let k = 0; k < MAX_FIXES; k++) {
      const next = applyChanges(build, combo.changes, this.data);
      const now = this.values(next);
      const lost = held.filter((g, i) => !g.guard && !g.side
        && (g.atMost ? -1 : 1) * (now[i] - before[i]) < -EPSILON);
      if (lost.length === 0) break;
      const fixer = new Suggester(this.data, lost, { ...this.opts, reach });
      fixer.pushing = true;
      if (!fixer.active) break;
      const taken = new Set(combo.changes.map((c) => c.slot));
      const fixes: Move[] = fixer.refineMoves(next).filter((m) => !taken.has(m.changes[0].slot));
      for (const slot of SLOTS) {
        if (taken.has(slot.key)) continue;
        fixes.push(...fixer.slotMoves(next, slot.key, 1, false, false));
        const card = fixer.cardMove(next, slot.key);
        if (card) fixes.push(card);
      }
      let best: { fix: Move; worth: number } | null = null;
      for (const fix of fixes) {
        if (!this.respectsLocks(build, fix.changes)) continue;
        const after = this.values(applyChanges(next, fix.changes, this.data));
        // A guard is a line a trade may not cross, and a combination is one
        // trade: Soul of Ymir's SP back at -25% move speed is not a fix.
        if (brokenGoals(this.goals, before, after).some((g) => g.guard)) continue;
        const w = tradeValue(held, before, after);
        if (!best || w > best.worth) best = { fix, worth: w };
      }
      if (!best || best.worth <= worth + EPSILON) break;
      // The same piece twice -- a Laevateinn in each hand -- says which is which.
      const where = SLOT_BY_KEY.get(best.fix.changes[0].slot)?.label;
      const part = combo.label.includes(best.fix.label) && where ? `${best.fix.label} (${where})` : best.fix.label;
      combo = { ...combo, label: `${combo.label} + ${part}`,
        changes: [...combo.changes, ...best.fix.changes] };
      worth = best.worth;
    }
    return combo;
  }

  /** Does the hardest new thing this move puts on drop from a monster? */
  private farmable(build: Build, move: Move): boolean {
    let hardest: { id: number; effort: number } | null = null;
    for (const c of move.changes) {
      for (const id of newIds(build, c)) {
        const e = this.data.effort?.get(id)?.effort ?? 0;
        if (!hardest || e > hardest.effort) hardest = { id, effort: e };
      }
    }
    return !!hardest && farmFor(hardest.id, this.data) !== null;
  }

  /**
   * The worn pieces most worth refining, best first, up to +9.
   *
   * Refining competes in the plan with every swap, and a swap usually
   * scores higher, so refines rarely make its few steps. But taking what is
   * already worn from +6 to +9 is the upgrade most players are actually
   * working on, so it is offered on its own as well.
   */
  refineUpgrades(build: Build, limit = 3): Move[] {
    if (!this.active) return [];
    const held = this.withinReach(build);
    const pushing = new Suggester(this.data, this.goals, held.opts);
    pushing.pushing = held.pushing
      || goalStatus(this.goals, aggregate(build, this.data), build, this.data).every((s) => s.met);
    return pushing.refineMoves(build)
      .filter((m) => m.gain > EPSILON && pushing.breaks(m).length === 0)
      .sort((a, b) => b.gain - a.gain)
      .slice(0, limit);
  }

  /**
   * The copies of worn pieces worth farming for better rolls, best first.
   *
   * The same piece with rolls that suit the build: often the cheapest real
   * upgrade there is, since the player already farms where it drops. Aimed
   * at a typical good roll, not a perfect one, and nothing that would take
   * a goal below its target.
   */
  rollUpgrades(build: Build, limit = 3): Move[] {
    if (!this.active) return [];
    const held = this.withinReach(build);
    const pushing = new Suggester(this.data, this.goals, held.opts);
    pushing.pushing = held.pushing
      || goalStatus(this.goals, aggregate(build, this.data), build, this.data).every((s) => s.met);
    return SLOTS.flatMap((slot) => pushing.rollMoves(build, slot.key))
      .filter((m) => m.gain > EPSILON && pushing.breaks(m).length === 0)
      .sort((a, b) => b.gain - a.gain)
      .slice(0, limit);
  }

  /**
   * The best pieces out of the build's reach: something to aim for when
   * nothing close by improves on what is worn.
   *
   * Reach keeps a plan honest, but a plan that comes back empty leaves the
   * player with no idea what to work towards. So the same search runs with
   * the grind and the toughness limits off -- refine still stops at +9 --
   * and what it finds that the reach turned away is offered separately, as
   * alternatives rather than steps, each with what to go and farm for it.
   * Nothing that would take a goal below its target.
   */
  stretchMoves(build: Build, limit = 5): Move[] {
    if (!this.active) return [];
    const near = this.reachFor(build);
    const wide = new Suggester(this.data, this.goals, { ...this.opts, reach: wideOf(near) });
    // With every goal met there is no gap to close, so it pushes, as the
    // plan does.
    wide.pushing = this.pushing
      || goalStatus(this.goals, aggregate(build, this.data), build, this.data).every((s) => s.met);
    const heldBack = new Suggester(this.data, this.goals, { ...this.opts, reach: near });

    const candidates: Move[] = [];
    for (const slot of SLOTS) candidates.push(...wide.slotMoves(build, slot.key, 3, false, false));
    candidates.push(...wide.setMoves(build));
    return dedupe(candidates)
      .filter((m) => m.gain > EPSILON && wide.keeps(build, m))
      // Only what the reach turned away; the rest the plan already offers.
      .filter((m) => m.changes.some((c) => {
        if (c.state.itemId === build.slots[c.slot]?.itemId) {
          return c.state.cards.some((id) => {
            const card = id ? this.data.items.get(id) : undefined;
            return !!card && !heldBack.allowed(card);
          });
        }
        const item = this.data.items.get(c.state.itemId ?? -1);
        const cards = c.state.cards.map((id) => (id ? this.data.items.get(id) : undefined));
        return [item, ...cards].some((i) => !!i && !heldBack.allowed(i));
      }))
      .sort((a, b) => b.gain - a.gain)
      .slice(0, limit)
      .map((m) => ({ ...m, highEffort: true }));
  }

  /**
   * Refining what is already worn, as far as it helps and no further than +9.
   *
   * Often the honest answer to "what next": when nothing within reach beats
   * the piece in the slot, taking a +7 circlet to +9 is the upgrade. Never
   * +10 -- the last step is a sliver of a chance with a downgrade on failure,
   * which is a gamble, not a plan -- and never past the piece's own cap.
   * Offered past the build's usual refine, because one piece is exactly
   * where a player would put the effort; that is what reach does not cover.
   */
  refineMoves(build: Build): Move[] {
    const before = this.values(build);
    const baseline = scoreOf(this.goals, before);
    const moves: Move[] = [];
    for (const slot of SLOTS) {
      if (isLocked(build, slot.key)) continue;
      const state = build.slots[slot.key];
      const item = state?.itemId ? this.data.items.get(state.itemId) : undefined;
      if (!item) continue;
      const top = Math.min(REFINE_MOVE_CAP, maxRefine(item));
      if (state.refine >= top || !this.refineMatters(item, state)) continue;
      // The lowest refine that scores best, so a step that only pays at +8
      // is not dressed up as needing +9.
      let best: { refine: number; score: number; after: number[] } | null = null;
      for (let r = state.refine + 1; r <= top; r++) {
        const trial = applyChanges(build, [{ slot: slot.key, state: { ...state, refine: r } }], this.data);
        const after = this.values(trial);
        const score = scoreOf(this.goals, after);
        if (!best || score < best.score - EPSILON) best = { refine: r, score, after };
      }
      if (!best) continue;
      const gain = baseline - best.score;
      if (gain <= EPSILON) continue;
      moves.push({
        kind: 'refine',
        label: `Refine ${item.name} +${state.refine} → +${best.refine}`,
        changes: [{ slot: slot.key, state: { ...state, refine: best.refine } }],
        gain, before, after: best.after,
      });
    }
    return moves;
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
    return last(this.planStream(build, maxSteps), []);
  }

  /** `plan` a step at a time: the steps so far, after each one is found. */
  *planStream(build: Build, maxSteps = 6): Generator<Move[]> {
    if (!this.active) return;
    const held = this.withinReach(build);
    if (held !== this) { yield* held.planStream(build, maxSteps); return; }
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
      yield* upgrading.planStream(build, maxSteps);
      return;
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
          if (best && move.gain <= best.gain) continue;
          if (this.keeps(current, move)) best = move;
        }
      }
      for (const move of [...this.setMoves(current), ...this.refineMoves(current)]) {
        if (best && move.gain <= best.gain) continue;
        if (this.keeps(current, move)) best = move;
      }
      if (!best || best.gain <= EPSILON) break;
      steps.push(best);
      current = applyChanges(current, best.changes, this.data);
      yield [...steps];
    }
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
      if (missing.length === 0) continue;
      const placed = this.completeSet(build, set, missing);
      if (!placed) continue;
      // Taking off four or more pieces for a set is a different build, not a
      // suggestion. Pieces that go into empty slots take nothing off, so a
      // character with no shadow gear is offered a whole shadow set.
      // The exception is one whole set for another: shadow gear is worn as a
      // set, and trading Fallen Civilization for a different four is the
      // decision a player is actually weighing, not a rebuild.
      const displacedIds = placed.map((c) => build.slots[c.slot]?.itemId).filter((id): id is number => !!id);
      if (displacedIds.length > 3 && !this.isWholeSet(build, displacedIds)) continue;
      // Tuned after placing, so set refine ("Set refine 18+") is judged with
      // every piece on rather than one piece at a time.
      const { changes, after } = this.tune(build, placed);
      if (!this.respectsLocks(build, changes)) continue;
      const gain = baseline - scoreOf(this.goals, after);
      if (gain <= EPSILON) continue;
      moves.push({
        kind: 'set',
        label: this.setTitle(build, set, changes),
        changes, gain, before, after,
      });
    }
    return moves;
  }

  /**
   * "Complete Aggressive Orphan set, set refine 18": the set and what its
   * refine comes to, and no more. The pieces, each at its refine, are the
   * row's own list below it, where each can be hovered; naming them here as
   * well said everything twice.
   */
  private setTitle(build: Build, set: SetRecord, changes: SlotChange[]): string {
    const progress = aggregate(applyChanges(build, changes, this.data), this.data).setProgress
      .find((p) => p.set.index === set.index);
    const refine = progress?.setRefine ?? 0;
    return `Complete ${set.name} set${refine > 0 ? `, set refine ${refine}` : ''}`;
  }

  /** Are these worn pieces, all of them, members of one set the build has complete? */
  private isWholeSet(build: Build, ids: number[]): boolean {
    const complete = aggregate(build, this.data).setProgress.filter((p) => p.complete);
    return complete.some((p) => ids.every((id) => this.data.items.get(id)?.sets.includes(p.set.index)));
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
      // Set refine is the sum over the pieces, so a threshold -- Aggressive
      // Orphan's "set refine 9+ and again at 18+" -- is out of any one
      // piece's reach, and tuned alone every piece stayed at +0. So all the
      // new pieces are raised together first, to the lowest shared refine
      // that scores best; the loop below then trims each to the least that
      // keeps it.
      const tunable = out.map((c) => {
        const item = this.data.items.get(c.state.itemId ?? -1);
        return !!item && item.id !== build.slots[c.slot]?.itemId
          && this.refineCap(item) > 0 && this.refineMatters(item, c.state) ? this.refineCap(item) : 0;
      });
      if (tunable.filter((cap) => cap > 0).length > 1) {
        const together = (r: number) => out.map((c, j) =>
          (tunable[j] > 0 ? { ...c, state: { ...c.state, refine: Math.min(r, tunable[j]) } } : c));
        let bestR = 0;
        let bestScore = Infinity;
        for (let r = 0; r <= Math.max(...tunable); r++) {
          const score = this.objective(this.values(applyChanges(build, together(r), this.data)));
          if (score < bestScore - EPSILON) { bestScore = score; bestR = r; }
        }
        out = together(bestR);
      }
      for (let i = 0; i < out.length; i++) {
        const { slot, state } = out[i];
        const item = this.data.items.get(state.itemId ?? -1);
        if (!item || item.id === build.slots[slot]?.itemId) continue;
        const limit = this.refineCap(item);
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
    // flee); a base stat total by that stat. A derived total is also fed by
    // whatever its formula reads -- flee by AGI -- or AGI gear, cards and
    // refines would never be looked at for a flee goal.
    const id = data.stats.find((s) => s.key === goal.key)?.id;
    if (id !== undefined) ids.add(id);
    // A target goal, or one race of a group with an "all" stat, is fed by
    // everything it reads -- or an all-races card would never be looked at.
    for (const input of targetInputs(goal.key)) {
      const inputId = data.stats.find((s) => s.key === input)?.id;
      if (inputId !== undefined) ids.add(inputId);
    }
    if (goal.column === 'total') {
      for (const input of FORMULAS.find((f) => f.key === goal.key)?.inputs ?? []) {
        const inputId = data.stats.find((s) => s.key === input)?.id;
        if (inputId !== undefined) ids.add(inputId);
      }
    }
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

/** The reach with the grind and toughness limits off; refine still stops at +9. */
function wideOf(reach: Reach | null): Reach {
  return { effort: farOf(reach), kill: farKillOf(reach), refine: Math.max(reach?.refine ?? 0, REFINE_MOVE_CAP) };
}

/**
 * How far past reach the longer-term lists look, in grind. Unlimited, they
 * sent a level 100 character after a Vesper Card -- an MVP card some six
 * hundred times its reach -- over gear it could use this month. Twenty
 * times keeps the Sage gear and the quest-chain tomes, and a calibration.
 */
const FAR_EFFORT_FACTOR = 20;
function farOf(reach: Reach | null): number | null {
  return reach?.effort == null ? null : reach.effort * FAR_EFFORT_FACTOR;
}

/**
 * And how much tougher a monster: a Dedicated Scarf, 3% off a level 170
 * with 6.4 million effective HP, was being called worth target-farming for a
 * character whose toughest reach is some 160 thousand. A calibration.
 */
const FAR_KILL_FACTOR = 5;
function farKillOf(reach: Reach | null): number | null {
  return reach?.kill == null ? null : reach.kill * FAR_KILL_FACTOR;
}

/**
 * The reach with the grind and toughness limits off and the refine kept.
 * For listing high-effort pieces beside the rest: a piece is marked for how
 * hard it is to get, and assuming +9 on it as well would be a second stretch
 * the mark does not mention.
 */
function anyGrind(reach: Reach | null): Reach | null {
  return reach && { effort: farOf(reach), kill: farKillOf(reach), refine: reach.refine };
}

/** What a change puts on that the slot did not have: the piece, and new cards. */
function newIds(build: Build, change: SlotChange): number[] {
  const was = build.slots[change.slot];
  return [
    ...(change.state.itemId !== was?.itemId && change.state.itemId ? [change.state.itemId] : []),
    ...change.state.cards.filter((id): id is number => !!id && !was?.cards.includes(id)),
  ];
}

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

/** What a move leaves in the slots it touches, as one comparable string. */
function stateKey(move: Move): string {
  return JSON.stringify(move.changes.map((c) =>
    [c.slot, c.state.itemId, c.state.cards, c.state.refine]));
}

/** The last thing a generator yields, or `fallback` if it yields nothing. */
function last<T>(gen: Iterable<T>, fallback: T): T {
  let out = fallback;
  for (const v of gen) out = v;
  return out;
}

/** Every list of the upgrade paths, empty. */
function emptyPaths(): UpgradePaths {
  return { near: [], cards: [], refines: [], rolls: [], far: [], sides: [], farm: [], sets: [] };
}

/** "Ornstein's Gift" for a move that completes that set; '' for anything else. */
function setName(move: Move): string {
  return move.kind === 'set' ? /^Complete (.+?) set\b/.exec(move.label)?.[1] ?? '' : '';
}

/** The moves that help, most first. */
function best(moves: Move[]): Move[] {
  return moves.filter((m) => m.gain > EPSILON).sort((a, b) => b.gain - a.gain);
}

/** The same end state reached twice is one suggestion, kept at its best. */
function dedupe(moves: Move[]): Move[] {
  const seen = new Map<string, Move>();
  for (const move of moves) {
    const key = stateKey(move);
    const prior = seen.get(key);
    if (!prior || move.gain > prior.gain) seen.set(key, move);
  }
  return [...seen.values()];
}
