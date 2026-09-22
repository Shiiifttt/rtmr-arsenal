/** Shapes of the generated dataset, plus the build model the UI edits. */

/** A condition the character sheet can actually answer. */
export type Requirement =
  /**
   * A threshold on the character's own points. At least one of min/max is
   * present: "If Base VIT > 49" and "If Base VIT < 50" are the two halves
   * of one item and both have to be expressible.
   */
  | { type: 'base_stat'; stat: string; min?: number; max?: number }
  | { type: 'base_level'; min: number };

export interface Effect {
  text: string;
  /** Overrides the wearer's element ("Armor is Holy Element"). Not a number. */
  sets_element?: string;
  /** Gate on the character sheet, attached to this one effect. */
  requires?: Requirement;
  stat?: string;
  value?: number;
  unit?: string | null;
  parsed?: boolean;
  stat_ids?: number[];
  stat_keys?: string[];
  scope?: 'total';
  /** Scales with this item's own refine. */
  per_refine?: number;
  /** Scales with the summed refine of a whole set. */
  per_set_refine?: number;
  /** Scales with a base stat the character sheet has not modelled yet. */
  per_base_stat?: { per: number; stat: string };
  /**
   * Scales with another stat's running total: "ATK +1 every 20 flee".
   *
   * Distinct from `per_base_stat`, which reads the character sheet. This one
   * reads the result of everything else, so it is applied in a second pass
   * once the first is complete.
   */
  per_stat?: { per: number; stat: string };
  /**
   * A property rather than a quantity: "Unbreakable Weapon". Carries a
   * value of 1 so it travels with everything else, but two sources of it
   * is still just unbreakable, so the UI shows presence not a total.
   */
  flag?: boolean;
  skill?: string;
  skill_metric?: string;
  /**
   * The skills a modifier applies to, by the server's own names. Several
   * when one line names several ("Freezing Spear and Wind Blades"); empty
   * when it names skills in general ("All 4 skills").
   */
  skills?: string[];
  stat_inherited?: boolean;
}

export interface RefineGroup {
  per?: number;
  at?: number[];
  kind?: string;
  note?: string;
  effects: Effect[];
}

export interface Item {
  id: number;
  name: string;
  kind: string;
  type: string | null;
  category: string | null;
  equip_slots: string[];
  description: string;
  required_level: number;
  weight: number;
  atk: number;
  matk: number;
  def: number;
  mdef: number;
  card_slots: number;
  refineable: boolean;
  weapon_level: number | null;
  element: string | null;
  usable_by: string | null;
  images: { icon: string | null; art: string | null };
  /**
   * For cards: the word this card adds to the name of whatever it is
   * slotted into. It is how the equipment window shows a compounded card,
   * and so how a screenshot can be read back to one.
   */
  card_affix: { word: string; position: 'prefix' | 'suffix' } | null;
  sets: number[];
  /**
   * Which monsters drop this, from the crawl. Empty for anything obtained
   * some other way -- a quest, a box, a vendor -- which is what decides
   * whether a headgear or accessory rolls at all.
   */
  drops?: {
    mob_id: number;
    mob: string;
    mob_level: number;
    zone: string;
    chance_percent: number;
    mvp_reward: boolean;
  }[];
  effects: Effect[];
  piece_bonus: Effect[];
  refine: { per_refine: RefineGroup[]; thresholds: RefineGroup[] };
  conditional: {
    condition: string;
    requires?: Requirement;
    /** "For each base stat over 98:" — multiplier is how many stats clear it. */
    per_stat_count?: { min: number };
    effects: Effect[];
  }[];
  /**
   * Which enchant system the item accepts. A property of the item, not a
   * bonus: "Dream Enchants available" grants nothing by itself.
   */
  enchant: { system: string; refining: boolean; text: string } | null;
  lore: string | null;
  /**
   * Present when this item's numbers were corrected by hand in
   * crawler/overrides.json rather than read straight from the tooltip.
   */
  override?: { status: 'verified' | 'unverified'; reason: string } | null;
}

export interface SetRecord {
  index: number;
  key: string;
  name: string;
  member_ids: number[];
  members: { id: number; name: string; kind: string }[];
  member_count: number;
  members_text: string | null;
  set_bonus: Effect[];
  set_refine: { per_set_refine: RefineGroup[]; thresholds: RefineGroup[] };
  piece_bonus_note: string | null;
  /**
   * Present when this set's numbers were corrected by hand in
   * crawler/overrides.json rather than read straight from the tooltip.
   * "unverified" means it is a considered reading, not a checked fact.
   */
  override?: { status: 'verified' | 'unverified'; reason: string };
}

export interface StatDef {
  id: number;
  key: string;
  name: string;
  category: string;
  /**
   * How several sources of this stat combine. Absent means they add up,
   * which is the ordinary case; 'max' means the best one wins, as it does
   * for a skill level like Double Attack.
   */
  combine?: 'max';
  /** Hard ceiling the server enforces, applied after combining. */
  cap?: number;
}

/**
 * A single bonus one roll option grants.
 *
 * `min`/`max` bound what the player may type. A null `max` means the range
 * has not been established yet, which is a different statement from "no
 * upper bound exists" and is why it is not simply left out.
 */
export interface RollGrant {
  /** Registry key, or absent for a skill modifier that has no stat. */
  stat?: string;
  /** Bound at build time from the registry; null for a skill modifier. */
  stat_id?: number | null;
  unit: string | null;
  min: number;
  max: number | null;
  /** Input granularity. Fixed cast time is in seconds, everything else whole. */
  step?: number;
  /** -1 where the roll is worded as a reduction of a "received" stat. */
  sign?: number;
  /** True where the roll modifies a named skill rather than a stat. */
  skill?: boolean;
}

export interface RollOption {
  key: string;
  label: string;
  /**
   * How the client words this option, where that has actually been seen in
   * a screenshot. The labels here are the planner's own wording and the
   * client's often differs ("Movement Speed" for "Move Speed"), so a reader
   * checks these first and falls back to matching the label approximately.
   */
  reads?: string[];
  note?: string;
  grants: RollGrant[];
}

/** One of the independent rolls an item gets, with the choices it can take. */
export interface RollDef {
  key: string;
  label: string;
  options: RollOption[];
}

export interface RollTable {
  key: string;
  label: string;
  /** Slot keys this table applies to. Each slot has at most one table. */
  slots: string[];
  /**
   * A gate on the item rather than the slot. Headgear and accessories roll
   * only on a monster drop, so the same slot both does and does not roll
   * depending on what is in it.
   */
  requires?: { dropped?: boolean };
  rolls: RollDef[];
}

export interface RollData {
  version: number;
  /** "unverified" while the ranges come from description rather than testing. */
  status: 'verified' | 'unverified';
  note?: string[];
  tables: RollTable[];
}

/** One filled equipment slot. */
export interface SlotState {
  itemId: number | null;
  refine: number;
  /** Card ids, one per socket; null where the socket is empty. */
  cards: (number | null)[];
  /**
   * The item's random rolls, keyed by roll key so a change to the tables
   * cannot shift a saved value onto a different roll.
   */
  rolls?: Record<string, import('./rolls.ts').RollPick>;
}

/**
 * The character's own stat points, before equipment.
 *
 * Kept apart from the equipment totals because the tooltips that scale off
 * them say "base": "INT +1 per 5 base STR" counts the points on the
 * character sheet, not the STR an item just granted. Feeding the combined
 * figure back in would let bonuses compound on themselves.
 */
export interface BaseStats {
  str: number;
  agi: number;
  vit: number;
  int: number;
  dex: number;
  luk: number;
}

export const BASE_STAT_KEYS: (keyof BaseStats)[] =
  ['str', 'agi', 'vit', 'int', 'dex', 'luk'];

/**
 * A character sheet runs 1-99. The cap applies to the points spent, not to
 * the result: gear is free to push a stat well past 99, so only the input
 * is clamped and the totals are left alone.
 */
export const BASE_STAT_MIN = 1;
export const BASE_STAT_MAX = 99;

export function clampBaseStat(n: number): number {
  if (!Number.isFinite(n)) return BASE_STAT_MIN;
  return Math.max(BASE_STAT_MIN, Math.min(BASE_STAT_MAX, Math.trunc(n)));
}

export function defaultBaseStats(): BaseStats {
  return {
    str: BASE_STAT_MIN, agi: BASE_STAT_MIN, vit: BASE_STAT_MIN,
    int: BASE_STAT_MIN, dex: BASE_STAT_MIN, luk: BASE_STAT_MIN,
  };
}

/**
 * Base level is a guess at the ceiling, not something the dataset states.
 * The highest gate seen in the data is "Base Level 130 or higher".
 */
export const BASE_LEVEL_MIN = 1;
export const BASE_LEVEL_MAX = 200;
export const BASE_LEVEL_DEFAULT = 1;

export function clampBaseLevel(n: number): number {
  if (!Number.isFinite(n)) return BASE_LEVEL_MIN;
  return Math.max(BASE_LEVEL_MIN, Math.min(BASE_LEVEL_MAX, Math.trunc(n)));
}

export interface Build {
  className: string | null;
  baseLevel: number;
  baseStats: BaseStats;
  slots: Record<string, SlotState>;
  /**
   * Flat additions to a derived stat that the planner cannot work out --
   * skills, buffs, anything not modelled yet. Keyed by derived stat key.
   * Typed in by the player so a figure can be reconciled with the game
   * without pretending the planner knows where the number came from.
   */
  manual?: Record<string, number>;
  /** Numbers the player is building towards. See suggest.ts. */
  goals?: Goal[];
  /**
   * Slot keys no suggestion may touch -- the piece, its cards and its rolls
   * alike. Settled parts of a build, so the planner works on the rest.
   *
   * On the build rather than in `SuggestOptions` because it is a fact about
   * this build, saved and restored with it, and because every suggestion
   * already has the build in hand: there is no way for a lock to be missed
   * by a suggester built before it was set. See `isLocked`.
   */
  locked?: string[];
}

/**
 * A figure the player wants to reach.
 *
 * `column` says which number is meant, because the planner keeps several
 * for one stat: a gear stat's flat and percent columns are different
 * quantities, and "STR 120" means the character-sheet total, not what the
 * gear adds. `total` is only offered for the base stats and derived values.
 */
export interface Goal {
  key: string;
  column: 'flat' | 'percent' | 'total';
  target: number;
  /**
   * The target is a ceiling rather than a floor. Reductions are written as
   * negatives ("Variable Cast -30%"), so reaching -50% means staying under.
   */
  atMost?: boolean;
}

/**
 * What a class may physically hold, and per-item fixes to the job sentence.
 *
 * Hand-maintained in crawler/class-rules.json and resolved into
 * data/class-rules.json by the build. A slot key left out leaves that slot
 * governed by the item's job sentence alone, so a half-filled entry never
 * hides gear nobody has checked. See `canEquip`.
 */
export interface ClassRules {
  classes: Record<string, {
    /** Item types allowed in the weapon hand, one- or two-handed. */
    weapons?: string[];
    off_hand?: string[];
    ammunition?: string[];
    status: string;
    reason: string;
  }>;
  /** Keyed by item id as a string, the way JSON object keys arrive. */
  items: Record<string, {
    name: string;
    usable_by: string;
    /** The sentence the site shipped, kept so the fix can be argued with. */
    was: string | null;
    status: string;
    reason: string;
  }>;
}

export interface Dataset {
  items: Map<number, Item>;
  itemList: Item[];
  sets: SetRecord[];
  stats: StatDef[];
  statById: Map<number, StatDef>;
  classes: string[];
  /** Class equip rules; null if data/class-rules.json has not been built. */
  classRules: ClassRules | null;
  /** Hand-written roll tables; null if data/rolls.json has not been built. */
  rolls: RollData | null;
}

/** A running total for one stat. Flat and percent never mix. */
export interface StatTotal {
  statId: number;
  flat: number;
  percent: number;
  sources: { label: string; value: number; unit: string | null }[];
}

/** One piece claiming to set the wearer's element. */
export interface ElementClaim {
  element: string;
  source: string;
  applied: boolean;
}

/**
 * A running total for one skill modifier: "Backstab damage", "Heal cooldown".
 *
 * Kept out of the stat totals on purpose. A skill's damage bonus is not a
 * global damage stat, and folding it into one would inflate every other
 * calculation. Totalled here, it can be read and aimed at without leaking.
 */
export interface SkillTotal {
  skill: string;
  /** "damage", "cooldown", "sp cost", "cast time", "duration", "level", "chance". */
  metric: string;
  flat: number;
  percent: number;
  /** The unit the flat column is in: "s" for a cooldown, null for a level. */
  unit: string | null;
  sources: { label: string; value: number; unit: string | null }[];
}

export interface Totals {
  byStat: Map<number, StatTotal>;
  /** Skill modifiers, keyed "<skill>|<metric>". See skillKey. */
  skills: Map<string, SkillTotal>;
  /** Values worked out from the sheet rather than read off gear. */
  derived: import('./derived.ts').DerivedStat[];
  /** The element the character ends up with, or null for the default. */
  element: string | null;
  /** Every claim, in the order they were considered. First one wins. */
  elementClaims: ElementClaim[];
  /** Effects that are real but could not be added up, with the reason. */
  uncounted: { label: string; text: string; reason: string }[];
  /** Sets and how many of their pieces are currently worn. */
  setProgress: {
    set: SetRecord;
    worn: number;
    total: number;
    complete: boolean;
    setRefine: number;
    /** Which member ids are actually equipped, so the UI can name the gap. */
    wornIds: number[];
  }[];
}
