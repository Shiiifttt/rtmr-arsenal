/**
 * The recommended rotations for the web app's Rotation overlay
 * (data/rotations.json), per class with a kit:
 *
 *   - allround: what the class's farm build plays (its searched rotation
 *     settings), read off a long endgame fight (Heartless) so the loop shows;
 *   - dummy: the best rotation the dummy search finds (tools/rotation-search.ts,
 *     60 s window) on the same build -- raw damage, nothing to dodge.
 *
 * Each lists the opener, the core loops and the fillers per loop, what goes
 * up before the pull and what each pre-fight buff is worth on the dummy (its
 * skill set to 0, same fights), and every skill's tooltip, a plain-words
 * summary (data/skill-summaries.json) and the stat scalings its tooltip names.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/build-rotations.ts [--only Revenant] [--skip-search]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildFighter, type Profile } from '../src/character.ts';
import { findMobs, readJSON, REPO } from '../src/data.ts';
import { DEFAULT_CONSUMABLES, loadout } from '../src/items.ts';
import { buildMonster, dummyMonster } from '../src/monster.ts';
import type { Monster } from '../src/model.ts';
import { simulate, type Summary } from '../src/sim.ts';
import { priorityPolicy } from '../src/tas.ts';
import { kitFor } from '../src/kits/index.ts';

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

/** Each class: its farm build, and the buffs put up before the pull (by the skill that grants them). */
const CLASSES: { className: string; profile: string; buffs: string[]; note: string }[] = [
  { className: 'Revenant', profile: 'profiles/revenant-maxed-final.json', note: 'maxed-out farm tier',
    buffs: ['Darkside Shadow', 'True Sight', 'Vampire Mark', 'Shadow Parry', 'Burning Scythe', 'Ominous Presence'] },
  { className: 'Satsujin', profile: 'profiles/satsujin-farm-maxed-a.json', note: 'maxed-out farm tier',
    buffs: ['Moonlight Stance', 'Seven Winds'] },
  { className: 'Kingslayer', profile: 'profiles/kingslayer-endgame-farm.json', note: 'endgame farm build',
    buffs: ['Duel Stance', "King's Fortress", "Knight's Regen", "Bishop's Guard", 'Reflect Shield'] },
];
const ALLROUND_VS = 'Heartless';
const DUMMY_S = 60;

const raw = readJSON<{ cols: string[]; rows: unknown[][] }>(resolve(REPO, 'data/raw/db-skills.json'));
const col = (k: string) => raw.cols.indexOf(k);
const skillInfo = new Map<string, { icon: string; desc: string; max: number }>();
for (const r of raw.rows) {
  const name = String(r[col('name')]);
  if (!skillInfo.has(name)) skillInfo.set(name, { icon: String(r[col('icon')] ?? ''), desc: String(r[col('desc')] ?? ''), max: Number(r[col('max')] ?? 1) });
}
const summariesPath = resolve(REPO, 'combat/data/skill-summaries.json');
const summaries = existsSync(summariesPath) ? JSON.parse(readFileSync(summariesPath, 'utf8')) as Record<string, string> : {};

const STATS = ['STR', 'AGI', 'VIT', 'INT', 'DEX', 'LUK'];
interface Scaling { stats: string[]; per: number; every: number; text: string }
/** "+2% per LUK", "+1% per 2 LUK and INT", "2% per DEX Scaling": the stat terms a tooltip names. */
function scalings(desc: string): Scaling[] {
  const out: Scaling[] = [];
  const re = /([+-]?\d+(?:\.\d+)?)\s*%\s*(?:per|for each|every)\s*(\d+\s*)?(STR|AGI|VIT|INT|DEX|LUK)\b(?:\s*(?:and|\/|&)\s*(STR|AGI|VIT|INT|DEX|LUK)\b)?/gi;
  for (const m of desc.matchAll(re)) {
    out.push({ per: Number(m[1]), every: m[2] ? Number(m[2]) : 1, stats: [m[3].toUpperCase(), ...(m[4] ? [m[4].toUpperCase()] : [])],
      text: m[0].trim() });
  }
  return out.filter((s) => s.stats.every((x) => STATS.includes(x)));
}

/** Actions that are moves, not skills worth a tile. */
const NOT_SKILLS = new Set(['Wait', 'Wait for swing', 'Stay ready', 'Stay hidden', 'Walk out', 'Break line of sight', 'Pull it off the ward', 'Step back']);

function rotationOf(s: Summary) {
  const a = s.analysis;
  return {
    opener: a.opener,
    cycles: a.cycles.map((c) => ({ steps: c.steps, share: Math.round(c.share * 100) / 100 })),
    fillers: a.fillers.filter((x) => x.perLoop >= 0.2).map((x) => ({ id: x.id, perLoop: Math.round(x.perLoop * 10) / 10 })),
    roles: a.roles.map((r) => ({ role: r.role, share: Math.round(r.share * 100) / 100 })),
    // Every damaging action: its share of all damage, and what one cast deals on average (a step's weight in a combo).
    damage: s.actions.filter((x) => x.damage > 0).map((x) => ({ id: x.id, share: Math.round(x.share * 1000) / 1000,
      perCast: x.uses > 0 ? Math.round(x.damage / x.uses) : null })),
    prep: a.prep,
    dps: Math.round(s.dps),
  };
}

/** The best dummy rotation: tools/rotation-search.ts on this build, parsed. */
function dummySearch(profilePath: string): Record<string, unknown> {
  if (argv.includes('--skip-search')) return {};
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './register.mjs', 'tools/rotation-search.ts',
    '--profile', profilePath, '--time', String(DUMMY_S), '--iter', '100', '--confirm', '300'], { encoding: 'utf8', cwd: resolve(REPO, 'combat'), maxBuffer: 1 << 26 });
  const out: Record<string, unknown> = {};
  const sw = /^switches: (\{.*\})$/m.exec(r.stdout ?? ''); if (sw) Object.assign(out, JSON.parse(sw[1]));
  const ord = /^order: (\[.*\])$/m.exec(r.stdout ?? ''); if (ord) out.order = JSON.parse(ord[1]);
  return out;
}

const result: Record<string, unknown> = {};
for (const c of CLASSES.filter((x) => !one('only') || x.className === one('only'))) {
  const profile = readJSON<Profile>(resolve(REPO, 'combat', c.profile));
  const k = kitFor(c.className);
  const opts = { passives: k.passives, aliases: k.aliases, maxLevels: k.maxLevels() };
  const f = await buildFighter(profile, opts);
  const fight = (fi: typeof f, m: Monster, options: Record<string, unknown>, limitS: number, n: number) => simulate(fi, m, k.kit, {
    iterations: n, seed: 7, policy: priorityPolicy, options, limitMs: limitS * 1000,
    items: loadout({ carried: profile.consumables ?? DEFAULT_CONSUMABLES, healing: !!profile.healing, boss: m.boss, elixirs: fi.kafraElixirs }),
  });
  const dummy = dummyMonster();
  const farmOpts = profile.options ?? {};
  const allround = fight(f, buildMonster(findMobs(ALLROUND_VS)[0]), farmOpts, 300, 100);
  const dummyOpts = { ...farmOpts, ...dummySearch(c.profile) };
  const dummyRun = fight(f, dummy, dummyOpts, DUMMY_S, 200);

  // What each pre-fight buff is worth on the dummy: its skill at 0, the same fights.
  const buffs = [];
  for (const b of c.buffs) {
    if (!(b in opts.maxLevels)) continue;
    const off = await buildFighter({ ...profile, skills: { ...(profile.skills ?? {}), [b]: 0 } }, opts);
    const without = fight(off, dummy, dummyOpts, DUMMY_S, 200).dps;
    const gain = without > 0 ? dummyRun.dps / without - 1 : Infinity;
    // Without it the rotation falls apart (Moonlight Stance: no Moon skills at all): a requirement, not a percentage.
    buffs.push({ skill: b, icon: skillInfo.get(b)?.icon ?? '', dpsGain: gain > 1 ? null : Math.round(1000 * gain) / 1000, required: gain > 1 });
  }

  const ids = new Set<string>();
  const rots = [rotationOf(allround), rotationOf(dummyRun)];
  for (const r of rots) {
    for (const id of [...r.opener, ...r.cycles.flatMap((x) => x.steps), ...r.fillers.map((x) => x.id)]) if (!NOT_SKILLS.has(id)) ids.add(id);
  }
  for (const b of buffs) ids.add(b.skill);
  const skills: Record<string, unknown> = {};
  for (const id of ids) {
    const base = id.replace(/ \(autocast\)$/, '');
    const s = skillInfo.get(base);
    skills[id] = {
      name: id, icon: s?.icon ?? '', level: f.skillLevels[base] ?? s?.max ?? 0, desc: s?.desc ?? '',
      summary: summaries[base] ?? null, scalings: s ? scalings(s.desc) : [],
    };
  }
  result[c.className] = {
    build: profile.build, note: c.note, profileName: profile.name,
    allround: { vs: ALLROUND_VS, ...rotations(rots[0]) },
    dummy: { seconds: DUMMY_S, options: dummyOpts, ...rotations(rots[1]) },
    buffs, skills,
  };
  console.log(`${c.className}: allround ${rots[0].opener.join(' > ')}; dummy ${Math.round(dummyRun.dps)} dps; buffs ${buffs.map((b) => `${b.skill} ${b.required ? 'required' : `${(100 * (b.dpsGain ?? 0)).toFixed(1)}%`}`).join(', ')}`);
}
function rotations<T>(r: T): T { return r; }

const path = resolve(REPO, 'data/rotations.json');
const prev = existsSync(path) && one('only') ? JSON.parse(readFileSync(path, 'utf8')).classes ?? {} : {};
writeFileSync(path, `${JSON.stringify({ builtAt: new Date().toISOString(), allroundVs: ALLROUND_VS, dummySeconds: DUMMY_S, classes: { ...prev, ...result } }, null, 1)}\n`);
console.log(`wrote ${path}`);
