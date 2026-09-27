/**
 * The threat list: what each monster does to you, how often, and how much of
 * it the TAS gets out of the way of. Built once with the sim
 * (tools/build-threats.ts -> data/threats.json) so any build can be checked
 * against it in milliseconds (advise.ts) without fighting again.
 *
 * How often a monster casts and how much of it can be dodged barely depends
 * on your gear; how much it hurts does, so that part is worked out again for
 * each build. Share of deaths is the reference build's and only ranks threats.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { mobRows, readJSON, REPO } from './data.ts';
import { NORMAL } from './engine.ts';
import type { MobSkill, Monster, StatusEffect } from './model.ts';
import { buildAdd } from './monster.ts';
import type { Summary } from './sim.ts';

export interface Threat {
  /** As the sim names it: "Magnus Exorcismus", "Heartless: attack", "Autumn Blood: Soul Strike". */
  source: string;
  kind: 'skill' | 'attack' | 'reflect' | 'dot';
  /** Aegis name and level of the skill, for skill threats. */
  skill?: string;
  level?: number;
  /** Who does it: the monster, or one of its adds. */
  caster: string;
  /** An add's server id, to rebuild it. */
  addId?: number;
  type: MobSkill['type'];
  element: string;
  targets: MobSkill['targets'];
  castMs: number;
  /** Separate applications per cast (ground waves) and time between them. */
  ticks: number;
  tickMs: number;
  avoid: MobSkill['avoid'];
  statuses: Pick<StatusEffect, 'sc' | 'chance' | 'resist'>[];
  /** Times it comes at you (landed + avoided) per minute of fighting. */
  perMin: number;
  /** Share of those the TAS avoided. */
  dodged: number;
  /** Mean damage of a landed application on the reference build. */
  refDamage: number;
  /** Share of the reference build's deaths. */
  deathShare: number;
}

export interface ThreatEntry {
  id: number;
  name: string;
  groups: string[];
  level: number;
  race: string;
  element: string;
  elementLevel: number;
  size: string;
  boss: boolean;
  fights: number;
  winRate: number;
  lossRate: number;
  /** Mean fight length, seconds. */
  seconds: number;
  threats: Threat[];
}

export interface ThreatFile {
  _about: string[];
  builtAt: string;
  reference: { name: string; className: string; level: number; maxHp: number; element: string };
  iterations: number;
  monsters: ThreatEntry[];
}

export const THREATS_PATH = resolve(REPO, 'combat/data/threats.json');

export function readThreats(): ThreatFile | null {
  return existsSync(THREATS_PATH) ? readJSON<ThreatFile>(THREATS_PATH) : null;
}

const DOTS = new Set(['Bleeding', 'Burning', 'Burnt']);

/** The skill (or swing) behind a source, and who cast it. */
export function sourceSkill(m: Monster, source: string): { caster: Monster; skill: MobSkill | null; kind: Threat['kind'] } | null {
  if (DOTS.has(source)) return { caster: m, skill: null, kind: 'dot' };
  const own = m.skills.find((s) => s.name === source);
  if (own) return { caster: m, skill: own, kind: 'skill' };
  const cut = source.indexOf(': ');
  if (cut < 0) return null;
  const who = source.slice(0, cut); const what = source.slice(cut + 2);
  const caster = who === m.name ? m : addsOf(m).find((a) => a.name === who);
  if (!caster) return null;
  if (what === 'reflected') return { caster, skill: null, kind: 'reflect' };
  if (what === 'attack') return { caster, skill: NORMAL, kind: 'attack' };
  const s = caster.skills.find((x) => x.name === what);
  return s ? { caster, skill: s, kind: 'skill' } : null;
}

/** Every monster its summon rows can call, built once. */
const addCache = new Map<number, Monster[]>();
export function addsOf(m: Monster): Monster[] {
  const hit = addCache.get(m.id);
  if (hit) return hit;
  const ids = [...new Set(m.skills.flatMap((s) => s.summon?.mobIds ?? []))];
  const out = ids.map((id) => buildAdd(id, mobRows())).filter((x): x is Monster => !!x);
  addCache.set(m.id, out);
  return out;
}

/** One monster's entry from a batch of fights. */
export function threatEntry(m: Monster, groups: string[], sum: Summary): ThreatEntry {
  const minutes = Math.max(1e-9, sum.seconds / 60);
  const lossTotal = Object.values(sum.deaths).reduce((a, b) => a + b, 0);
  const threats: Threat[] = [];
  for (const src of sum.sources) {
    const events = src.hits + src.avoided;
    if (events <= 0) continue;
    const found = sourceSkill(m, src.id);
    const s = found?.skill;
    threats.push({
      source: src.id,
      kind: found?.kind ?? 'skill',
      ...(s && found?.kind === 'skill' ? { skill: s.skill, level: s.level } : {}),
      caster: found?.caster.name ?? m.name,
      ...(found && found.caster !== m && found.caster.serverId ? { addId: found.caster.serverId } : {}),
      type: found?.kind === 'reflect' || found?.kind === 'dot' ? 'none' : s?.type ?? 'none',
      element: s?.element ?? 'Neutral',
      targets: s?.targets ?? 'single',
      castMs: s?.castMs ?? 0,
      ticks: s?.ticks ?? 1,
      tickMs: s?.tickMs ?? 0,
      avoid: s?.avoid ?? [],
      statuses: (s?.statuses ?? []).map((e) => ({ sc: e.sc, chance: e.chance, resist: e.resist })),
      perMin: round(events / minutes, 2),
      dodged: round(src.avoided / events, 3),
      refDamage: Math.round(src.hits ? src.damage / src.hits : 0),
      deathShare: round(lossTotal ? (sum.deaths[src.id] ?? 0) / lossTotal : 0, 3),
    });
  }
  threats.sort((a, b) => b.deathShare - a.deathShare || b.perMin * b.refDamage - a.perMin * a.refDamage);
  return {
    id: m.id, name: m.name, groups, level: m.level, race: m.race, element: m.element,
    elementLevel: m.elementLevel, size: m.size, boss: m.boss,
    fights: sum.iterations, winRate: round(sum.winRate, 3), lossRate: round(sum.losses / sum.iterations, 3),
    seconds: round(sum.seconds, 1), threats,
  };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
