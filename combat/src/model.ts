/**
 * The shapes the sim works in: a player reduced to the numbers combat reads,
 * a monster the same, and what a skill does.
 *
 * A `Fighter` is built once per build (character.ts) and never changes during
 * a fight; everything that changes -- HP, buffs, cooldowns -- lives in the
 * engine's state. That split is what lets the planner copy a fight cheaply.
 */
import type { StatKey } from './skilltext.ts';

export type Stats = Record<StatKey, number>;

/** Percent bonuses, keyed by the planner's stat keys (see data/stats.json). */
export type PercentBag = Record<string, number>;

export interface Weapon {
  name: string;
  /** Planner item type: "Dagger", "One-Handed Sword", ... */
  type: string;
  atk: number;
  level: number;
  refine: number;
  /** The weapon's own element, if it has one. Endows replace it. */
  element: string | null;
}

export interface Fighter {
  name: string;
  className: string;
  level: number;
  /** Totals with gear folded in: what every formula reads. */
  stats: Stats;
  maxHp: number;
  maxSp: number;
  weapon: Weapon | null;
  /** A second weapon in the off hand: dual wielding. Null for a shield. */
  offhand: Weapon | null;
  /** The shield in the off hand: its weight (display units) and refine feed the shield skills. */
  shield?: { name: string; type: string; weight: number; refine: number };
  /** Every equipped item's and card's description, for effects the parser leaves as prose (class gems). */
  gearText?: string;
  /**
   * Healing received from skills, percent (Anubis Card -50, Lone Singer
   * Armor +4 a refine): Knight's Regen, King's Fortress, your own Heal. Not
   * potions -- the server heals items by a separate rate.
   */
  healReceived?: number;
  /**
   * "N% chance to Autocast A and B when hit", from worn gear: the chance a
   * hit taken casts them (0..1), a "Per Refine:" line already times the
   * piece's refine (Bulwark Gem of the Weak +3: 3%).
   */
  autocastWhenHit?: { skills: string[]; chance: number }[];
  /** Healing power, percent: what your own Heal casts get (Lone Singer set +10). */
  healPower?: number;
  /** Flat ATK from gear other than the weapons' own ATK columns. */
  equipAtk: number;
  /** ATK % from gear ("ATK +5%"). */
  atkPercent: number;
  /** Mastery ATK: skill passives, added after cards and ignoring element. */
  masteryAtk: number;
  matk: { weapon: number; equip: number; percent: number };
  hit: number;
  flee: number;
  perfectDodge: number;
  critRate: number;
  /** Critical Damage %, on top of the base 40%. */
  critDamage: number;
  /** The left hand's Crit Damage: the build's, less what the right weapon itself gives. */
  critDamageLeft?: number;
  /** ASPD as the character window shows it. */
  aspd: number;
  /**
   * Ready to Rip (LK_CONCENTRATION): % on status ATK and weapon ATK only --
   * not equip ATK or ATK%, so not the shield skills (RTM status.cpp:6946, 7024).
   */
  concentration?: number;
  /** Move Speed % from gear (Temporal boots' 9%): the server takes the largest haste, not a sum. */
  moveSpeed?: number;
  defPen: number;
  mdefPen: number;
  def: number;
  softDef: number;
  mdef: number;
  softMdef: number;
  /** The armour element: what monster attacks are judged against. */
  element: string;
  /** Offensive percents: melee_damage, dmg_vs_race_brute, magic_dmg_fire... */
  dmg: PercentBag;
  /** The left hand's own target-type cards (its weapon's, halved by the planner): all a left-hand swing gets. */
  dmgLeft?: PercentBag;
  /** Defensive percents: res_neutral, res_race_boss, damage_reduction... */
  res: PercentBag;
  cast: { variable: number; fixed: number; all: number };
  afterCastDelay: number;
  spCost: number;
  /** Percent leech (a chance and a share), and a flat HP / SP on every hit. */
  leech: { hpRate: number; hpPower: number; spRate: number; spPower: number; hpPerHit: number; spPerHit: number };
  /** Natural regen per tick (formulas.TUNE.hp/spRegenMs), passives and gear included. */
  regen: { hp: number; sp: number };
  /**
   * Kafra Elixirs a life against a boss: 2, plus gear's "Increases Kafra
   * Elixir refill limit by +1" (the Elixir Badge).
   */
  kafraElixirs: number;
  /** Double Attack level from gear: +10% per level for a second hit, daggers only. */
  doubleAttack: number;
  /** Status resistances, percent, keyed as res_status_<name>. */
  statusRes: PercentBag;
  /** Percent cut to damage a monster reflects back (Reflect Shield, Max Pain); 100 = immune. */
  reflectReduce: number;
  /** Auto Guard level from gear: blocks 4% per level of physical attacks. */
  autoGuard?: number;
  /** Casts are never interrupted by damage ("Permanent Endure"). */
  endure?: boolean;
  /** Skill levels: always every skill at max (the project owner, 2026-09-26). */
  skillLevels: Record<string, number>;
  /**
   * Skill modifiers from gear: "Million Stab|damage" -> +15 (%). Keyed by the
   * sim's skill name; kits map gear aliases ("Full Moon Blades") in.
   */
  skillMods: (skill: string, metric: string) => { flat: number; percent: number };
  /** What was assumed rather than read, for the report. */
  notes: string[];
}

/** A status a monster skill lands on the player (combat/data/skill-effects.json). */
export interface StatusEffect {
  /** stun, freeze, stone, silence, bleeding, burning, burnt, coma, aeterna, root, ... */
  sc: string;
  /** Base chance 0..1, before the player's resistances. */
  chance: number;
  durationMs: number;
  /** The resistance rule (formulas.statusResist), or "none". */
  resist: string;
  /** Rolled on every hit rather than once per cast. */
  perHit?: boolean;
  value?: number;
  value2?: number;
}

/** A buff a monster puts on itself: Magic Mirror, Reflect Shield, Max Pain... */
export interface SelfBuff {
  sc: string;
  durationMs: number;
  value?: number;
}

/**
 * One monster skill: a mob_skill_db row (when and how often) joined with
 * what the skill does (skill-effects.json), resolved against the caster's
 * stats. See monster.ts.
 */
export interface MobSkill {
  name: string;
  /** Aegis name, "NPC_FIRESTORM". */
  skill: string;
  /** Server skill id: what an "afterskill" condition names. */
  skillId: number;
  level: number;
  kind: 'physical' | 'magic' | 'status' | 'self' | 'heal' | 'summon' | 'move' | 'none' | 'unknown';
  /** physical: DEF/flee apply. magic: MDEF applies, cannot be flee'd. status: no damage. */
  type: 'physical' | 'magic' | 'status' | 'none';
  element: string;
  /** single: needs a target (Hiding dodges it). aoe: an area (walk or hide). */
  targets: 'single' | 'aoe' | 'self';
  /** Percent of the monster's ATK (physical) or MATK (magic), per hit, stats applied. */
  ratio: number;
  /** The ratio from its second cast on (Asura Strike: the monster's SP is spent for good). */
  ratioAfterFirst?: number;
  /** Damage added to each hit before DEF. */
  flat?: number;
  /** The caster's current HP over this, added to each hit before DEF (Spear Stab). */
  flatCasterHpDiv?: number;
  /** Damage multiplier of one application (rAthena HitCount). */
  hits: number;
  /** Separate applications: ground ticks, meteors, pulses. */
  ticks: number;
  tickMs: number;
  /** ticks x tickMs: how long a lingering area lasts. */
  durationMs: number;
  castMs: number;
  /** The AI row: when the monster tries it (formulas.ts / engine.ts mobSkillUse). */
  ai: {
    state: string;
    /** 0..1 per try, the server's mob_skill_rate applied. */
    rate: number;
    /** Reuse delay from the cast's start, mob_skill_delay applied. */
    delayMs: number;
    cancelable: boolean;
    cond: string;
    condValue: string;
    target: string;
  };
  ignoresFlee?: boolean;
  ignoreDef?: boolean;
  /** Always crits (Critical Slash). */
  crit?: boolean;
  hitBonus?: number;
  /** Heals the monster by the damage it deals (Vampire Gift). */
  drain?: boolean;
  /** Does nothing to a hidden player (Dragon Breath). */
  hiddenImmune?: boolean;
  /** Plain Hiding stops it (when the caster does not see through Hiding). */
  hideBlocks?: boolean;
  /** Lands through King's Gambit / Land Protector (server IgnoreLandProtector: Earthquake). */
  noGambit?: boolean;
  statuses: StatusEffect[];
  self?: SelfBuff;
  heal?: { flat?: number; pctMaxHp?: number };
  /** Adds it calls: server monster ids, `count` at a time. */
  summon?: { mobIds: number[]; count: number };
  /** How a player may avoid it. */
  /** los: behind cover before it lands. diag: a cross -- standing diagonal to the caster misses it. */
  avoid: ('hide' | 'walk' | 'kawarimi' | 'los' | 'diag')[];
  /** An area's radius in cells, and whether it is centred on the monster rather than where it is aimed. */
  radius?: number;
  centeredOnSelf?: boolean;
  /** Set true once someone has checked it in game. */
  verified: boolean;
  note?: string;
}

export interface Monster {
  id: number;
  name: string;
  level: number;
  hp: number;
  size: string;
  race: string;
  element: string;
  elementLevel: number;
  boss: boolean;
  atk: number;
  /**
   * MATK = matkBase + a 70-130% roll of matk (the server's Attack2 column):
   * INT + level + Attack2 x [0.7, 1.3) (status.cpp:3239).
   */
  matk: number;
  matkBase: number;
  def: number;
  softDef: number;
  mdef: number;
  softMdef: number;
  hit: number;
  flee: number;
  str: number;
  luk: number;
  /** All six, for stat-scaled skill ratios. */
  stats: Stats;
  reach: number;
  adelay: number;
  statusImmune: boolean;
  /** Share of every hit it takes (server DamageTaken). */
  damageTaken: number;
  /** Server "Boss" class: ignores Hiding (status.cpp:2916-2937). */
  bossClass?: boolean;
  detector?: boolean;
  /** Cannot be knocked back (server mode KnockBackImmune): Rook's Smash leaves you on it. */
  noKnockback?: boolean;
  /** Immune to these damage kinds (Broken Thanatos: all four). */
  ignores?: ('melee' | 'ranged' | 'magic' | 'misc')[];
  /** The server snapshot's id, when it has this monster. */
  serverId?: number;
  /** The training dummy: never dies, never attacks, never stalls. */
  dummy?: boolean;
  /**
   * Boss protocol (Rachel SS, Jormungandr): its normal attacks reach a hidden
   * player and break Hiding; its skills do not. Its damage cut is its server
   * DamageTaken, like any monster's.
   */
  bossProtocol?: boolean;
  skills: MobSkill[];
  notes: string[];
}
