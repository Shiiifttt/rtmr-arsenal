/**
 * The playbook: how a player answers a monster's skill, by skill first --
 * so a new class gets a sensible baseline from what is already known -- then
 * refined per class, per monster, and per class against one monster
 * (data/playbook.json, the project owner, 2026-09-29).
 *
 * What CAN dodge a skill is a fact about the skill (mob-skills.json,
 * MobSkill.avoid). The playbook is the player's preference among those:
 * an ordered list of generic ways ("walk", "hide", "gambit" ...), which
 * each kit maps to its own actions (a Kingslayer's gambit is King's
 * Gambit, its hide is Hiding). The first way the class has, that works on
 * the skill and is ready in time, is taken; a skill with an entry whose
 * ways all fail is tanked. A skill with no entry is left to the kit's own
 * logic, so adding an entry only changes that skill.
 */
import { resolve } from 'node:path';

import { COMBAT_DATA, readJSON, REPO } from './data.ts';
import type { Fight } from './engine.ts';
import type { MobSkill, Monster } from './model.ts';

/** A generic way to not be hit. */
export type Way = 'gambit' | 'walk' | 'hide' | 'decoy' | 'rod' | 'los' | 'manhole' | 'kawarimi' | 'barrier' | 'backslide' | 'slashout';

export interface PlayEntry {
  /** The ways to try, best first. Only these are tried. */
  prefer?: Way[];
  /** Dodge it whatever it would do (otherwise only a heavy hit is dodged). */
  always?: boolean;
  note?: string;
}

/**
 * The shape of a cast, for the automatic defence (kits/defense.ts): an area
 * with time to walk out of it, an area without, a cast at you with time to
 * get behind cover, a cast at you without.
 */
export type Archetype = 'area-slow' | 'area-fast' | 'single-slow' | 'single-fast';

interface PlaybookFile {
  skills: Record<string, PlayEntry>;
  mobs: Record<string, Record<string, PlayEntry>>;
  classes: Record<string, {
    skills?: Record<string, PlayEntry>; mobs?: Record<string, Record<string, PlayEntry>>;
    archetypes?: Partial<Record<Archetype, string[]>>;
  }>;
  /** Default answer order per archetype: groups of ways, "a|b" = the cheaper of them. */
  archetypes?: Partial<Record<Archetype, string[]>>;
}

let book: PlaybookFile | undefined;
const data = (): PlaybookFile => (book ??= readJSON<PlaybookFile>(resolve(COMBAT_DATA, 'playbook.json')));

let trees: Record<string, { from?: string }> | undefined;
/**
 * The class and the jobs it came from, itself first (crawler/class-rules.json
 * trees): Kingslayer, Duelist, Rogue, Thief. An entry under a job counts for
 * every job after it -- classes.Rogue for any rogue-based class (the project
 * owner, 2026-09-29).
 */
export function lineage(className: string): string[] {
  trees ??= readJSON<{ trees: Record<string, { from?: string }> }>(resolve(REPO, 'crawler/class-rules.json')).trees;
  const out = [className];
  for (let c = trees[className]?.from; c && !out.includes(c); c = trees[c]?.from) out.push(c);
  return out;
}

/**
 * The answer order for an archetype, the nearest job's own if one has it:
 * groups of ways. Against a boss (an MVP or a server Boss-class monster) an
 * "<archetype>:boss" entry wins where the job has one.
 */
export function archetypeOrder(className: string, a: Archetype, boss = false): Way[][] {
  const d = data();
  const keys = boss ? [`${a}:boss`, a] : [a];
  let groups: string[] | undefined;
  for (const c of lineage(className)) {
    const own = d.classes[c]?.archetypes as Record<string, string[]> | undefined;
    groups = keys.map((k) => own?.[k]).find(Boolean);
    if (groups) break;
  }
  groups ??= d.archetypes?.[a] ?? [];
  return groups.map((g) => g.split('|').map((w) => w.trim()) as Way[]);
}

/** The entry for this skill from this monster, for this fight's class: most specific wins, field by field. */
export function playEntry(fight: Fight, s: MobSkill, from: Monster): PlayEntry | null {
  const d = data();
  // Oldest job first, so the class's own entry wins over its ancestors'.
  const chain = lineage(fight.kit.className).reverse().map((c) => d.classes[c] ?? {});
  const layers = [d.skills[s.skill], ...chain.map((c) => c.skills?.[s.skill]), d.mobs[from.name]?.[s.skill],
    ...chain.map((c) => c.mobs?.[from.name]?.[s.skill])]
    .filter((e): e is PlayEntry => !!e);
  if (!layers.length) return null;
  return Object.assign({}, ...layers) as PlayEntry;
}

/** One way as a kit offers it: the action and when to take it, or null when it cannot answer this cast. */
export type WayPlan = (s: MobSkill, endsAt: number) => { action: string; at: number } | null;

/**
 * The playbook's answer to a cast: a plan, null (an entry, but nothing in
 * it works: tank it), or undefined (no entry: the kit decides).
 */
export function playbookPlan(fight: Fight, s: MobSkill, from: Monster, endsAt: number,
  ways: Partial<Record<Way, WayPlan>>): { action: string; at: number } | null | undefined {
  const e = playEntry(fight, s, from);
  if (!e?.prefer) return undefined;
  for (const w of e.prefer) {
    const plan = ways[w]?.(s, endsAt);
    if (plan) return plan;
  }
  return null;
}
