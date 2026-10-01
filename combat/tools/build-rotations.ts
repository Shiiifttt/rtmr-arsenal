/**
 * The recommended rotations for the web app's Rotation overlay
 * (data/rotations.json), per class with a kit:
 *
 *   - allround: what the class's farm build plays (its searched rotation
 *     settings), read off a long endgame fight (Heartless) so the loop shows;
 *   - dummy: the best rotation the dummy search finds (tools/rotation-search.ts,
 *     the 10 s dummy, DUMMY_SECONDS) on the same build -- raw damage, nothing to dodge.
 *
 * A class may have several builds (Night Raven: Counter Slash, Definitive
 * Dagger): each is its own entry, keyed "<class>: <build>", with `className`.
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
import { newFight, run, type Kit, type TraceStep } from '../src/engine.ts';
import { findMobs, readJSON, REPO } from '../src/data.ts';
import { DEFAULT_CONSUMABLES, loadout } from '../src/items.ts';
import { buildMonster, DUMMY_SECONDS, dummyMonster } from '../src/monster.ts';
import type { Monster } from '../src/model.ts';
import { simulate, type Summary } from '../src/sim.ts';
import { skillRatio } from './ratio-terms.ts';
import { priorityPolicy } from '../src/tas.ts';
import { kitFor } from '../src/kits/index.ts';

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

/**
 * Each class: its farm build, and the buffs put up before the pull (by the
 * skill that grants them). `optional`: listed with an OPTIONAL label, up or
 * not by choice (Rook's Wall: the project owner, 2026-10-02).
 */
const CLASSES: {
  className: string; build?: string; profile: string; buffs: string[]; optional?: string[]; note: string; vs?: string;
  /** A buff the sim grants by an option, not by its skill's level: these options turn it off to measure it. */
  measure?: Record<string, Record<string, unknown>>;
}[] = [
  { className: 'Revenant', profile: 'profiles/revenant-maxed-final.json', note: 'maxed-out farm tier',
    buffs: ['Darkside Shadow', 'True Sight', 'Vampire Mark', 'Shadow Parry', 'Burning Scythe', 'Ominous Presence'] },
  { className: 'Satsujin', profile: 'profiles/satsujin-farm-maxed-a.json', note: 'maxed-out farm tier',
    buffs: ['Moonlight Stance', 'Seven Winds', 'Hallucination Walk', 'Magic Pierce', 'Wind Blade', 'Flaming Petals', 'Freezing Spear'],
    // Elemental Focus: two casts of the bolt for the Seven Winds element, 10 stacks at the pull (satsujin.ts prep,
    // option prepFocus); optional, one of the three (the project owner, 2026-10-02).
    optional: ['Wind Blade', 'Flaming Petals', 'Freezing Spear'],
    measure: { 'Wind Blade': { prepFocus: false }, 'Flaming Petals': { prepFocus: false }, 'Freezing Spear': { prepFocus: false } } },
  { className: 'Kingslayer', profile: 'profiles/kingslayer-endgame-farm.json', note: 'endgame farm build',
    buffs: ['Duel Stance', "King's Fortress", "Knight's Regen", "Bishop's Guard", 'Reflect Shield', 'Magic Pierce', "Rook's Wall"], optional: ["Rook's Wall"] },
  // Night Raven (2026-10-01): the endgame farm builds (10 areas, rhythm search).
  { className: 'Night Raven', build: 'Counter Slash', profile: 'profiles/nightraven-counter-commit.json', note: "Counter Slash endgame farm build (the owner's commit rotation: Shadow Slash, Midnight Eye, Counter Slash until Counter state ends, Typhoon Edge)",
    buffs: ['Weapon Blocking', 'Rising Wings', 'Fury', 'Hallucination Walk', 'Enchant Poison', 'Magic Pierce'] },
  { className: 'Night Raven', build: 'Definitive Dagger', profile: 'profiles/nightraven-dd-final.json', note: "Definitive Dagger endgame farm build (the owner's rotation)",
    buffs: ['Weapon Blocking', 'Rising Wings', 'Fury', 'Hallucination Walk', 'Enchant Poison', 'Magic Pierce'] },
];
const ALLROUND_VS = 'Heartless';
/** The dummy is a 10 s fight (the project owner, 2026-10-01; was 60 here). */
const DUMMY_S = DUMMY_SECONDS;

const raw = readJSON<{ cols: string[]; rows: unknown[][] }>(resolve(REPO, 'data/raw/db-skills.json'));
const col = (k: string) => raw.cols.indexOf(k);
const skillInfo = new Map<string, { icon: string; desc: string; max: number }>();
for (const r of raw.rows) {
  const name = String(r[col('name')]);
  if (!skillInfo.has(name)) skillInfo.set(name, { icon: String(r[col('icon')] ?? ''), desc: String(r[col('desc')] ?? ''), max: Number(r[col('max')] ?? 1) });
}
const summariesPath = resolve(REPO, 'combat/data/skill-summaries.json');
const summaries = existsSync(summariesPath) ? JSON.parse(readFileSync(summariesPath, 'utf8')) as Record<string, string> : {};
/** The tooltips reworded to read clearly, every number kept (2026-10-02); the ratio terms still read the game's own text. */
const descriptionsPath = resolve(REPO, 'combat/data/skill-descriptions.json');
const descriptions = existsSync(descriptionsPath) ? JSON.parse(readFileSync(descriptionsPath, 'utf8')) as Record<string, string> : {};

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
const NOT_SKILLS = new Set(['Wait', 'Idle', 'Wait for swing', 'Stay ready', 'Stay hidden', 'Walk out', 'Break line of sight', 'Pull it off the ward', 'Step back']);

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
    // Share of the fight a kit-tracked state was up (Night Wound on the target).
    uptime: Object.fromEntries(Object.entries(s.uptime ?? {}).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
  };
}

/**
 * What happened at each step, from traced fights: the states after it (yours
 * and the target's: Combo Ready, Overslash x5, Bishop's Tax...) and what
 * autocast inside it. The opener is read straight off the first trace; each
 * core loop is matched to its first occurrence in a trace.
 */
type Mark = { states: TraceStep['states']; procs: string[] };
function traced(kit: Kit, traces: TraceStep[][], rot: ReturnType<typeof rotationOf>) {
  const roles = kit.roles ?? {};
  // Idle (engine IDLE_STEP_MS) is a step like the kit's own, as in sim.ts analyse().
  const inRotation = (id: string) => id in roles || id === 'Idle';
  const core = (id: string) => id === 'Idle' || !kit.coreRoles || kit.coreRoles.includes(roles[id]);
  const mark = (x: TraceStep): Mark => ({ states: x.states.map((m) => ({ ...m, ...(m.leftMs !== undefined ? { leftMs: Math.round(m.leftMs) } : {}) })), procs: x.procs });
  // The steps a view keeps; what went off during the ones it drops (a Weapon Blocking block during a Wait)
  // moves on to the next step kept.
  const keep = (t: TraceStep[], ok: (id: string) => boolean): TraceStep[] => {
    const out: TraceStep[] = []; let carry: string[] = [];
    for (const x of t) {
      if (!ok(x.id)) { carry.push(...x.procs); continue; }
      out.push(carry.length ? { ...x, procs: [...carry, ...x.procs] } : x);
      carry = [];
    }
    return out;
  };
  // Two waits with only a filler between are one Idle in the loop (sim.ts analyse()); its procs move on.
  const idleOnce = (s: TraceStep[]) => s.filter((x, i) => !(x.id === 'Idle' && s[i - 1]?.id === 'Idle'));
  // Loops that differ only in how often a skill repeats are one loop (sim.ts analyse()).
  const shape = (ids: string[]) => ids.filter((id, i) => id !== ids[i - 1]).join(' → ');
  // The opener: the first moves the kit names, swings folded together (sim.ts fold).
  const moves = keep(traces[0] ?? [], inRotation);
  const opener: { id: string; mark: Mark }[] = [];
  for (const x of moves) {
    if (x.id === 'Attack' && opener[opener.length - 1]?.id === 'Attack') { opener[opener.length - 1].mark = mark(x); continue; }
    if (opener.length >= 20) break;
    opener.push({ id: x.id, mark: mark(x) });
  }
  // The core loops read off these traced fights themselves, so every loop shown has its states and
  // procs (2026-10-02: loops counted in other fights had none to show): grouped by shape, each at its
  // most common count, as one traced instance of it.
  if (kit.cycleAnchor) {
    const groups = new Map<string, { n: number; variants: Map<string, { n: number; at: TraceStep[] }> }>();
    let total = 0;
    for (const t of traces) {
      const s = idleOnce(keep(t, (id) => inRotation(id) && core(id)));
      const starts = s.flatMap((x, i) => (x.id === kit.cycleAnchor ? [i] : []));
      for (let k = 0; k + 1 < starts.length; k++) {
        const loop = s.slice(starts[k], starts[k + 1]);
        const ids = loop.map((x) => x.id);
        const g = groups.get(shape(ids)) ?? { n: 0, variants: new Map() };
        g.n++;
        const v = g.variants.get(ids.join(' → ')) ?? { n: 0, at: loop };
        v.n++;
        g.variants.set(ids.join(' → '), v);
        groups.set(shape(ids), g);
        total++;
      }
    }
    if (total) {
      const read = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 3).map((g) => {
        const v = [...g.variants.values()].sort((a, b) => b.n - a.n)[0];
        return { steps: v.at.map((x) => x.id), share: g.n / total, marks: v.at.map(mark) };
      });
      rot = { ...rot, cycles: read };
    }
  }
  const cycles = rot.cycles.map((c) => {
    if ('marks' in c) return c;
    for (const t of traces) {
      const s = idleOnce(keep(t, (id) => inRotation(id) && core(id)));
      for (let i = 0; i + c.steps.length <= s.length; i++) {
        if (c.steps.every((id, j) => s[i + j].id === id)) return { ...c, marks: c.steps.map((_, j) => mark(s[i + j])) };
      }
    }
    // Not in these few fights at its most common count: the same loop at another count, as it was traced
    // (2026-10-02: the Counter Slash loop at x14 had no marks, its states never showed).
    // Blocks are random, so the loops vary: the one nearest in length.
    let best: TraceStep[] | null = null;
    for (const t of traces) {
      const s = idleOnce(keep(t, (id) => inRotation(id) && core(id)));
      const starts = s.flatMap((x, i) => (x.id === kit.cycleAnchor ? [i] : []));
      for (let k = 0; k + 1 < starts.length; k++) {
        const loop = s.slice(starts[k], starts[k + 1]);
        if (shape(loop.map((x) => x.id)) !== shape(c.steps)) continue;
        if (!best || Math.abs(loop.length - c.steps.length) < Math.abs(best.length - c.steps.length)) best = loop;
      }
    }
    return best ? { ...c, steps: best.map((x) => x.id), marks: best.map(mark) } : c;
  });
  // Autocasts per loop, cut at the anchor as sim.ts analyse() cuts loops: fillers of their own (AUTO tiles).
  const autos = new Map<string, number>();
  let loops = 0;
  if (kit.cycleAnchor) {
    for (const t of traces) {
      const s = keep(t, inRotation);
      const starts = s.flatMap((x, i) => (x.id === kit.cycleAnchor ? [i] : []));
      for (let j = 0; j + 1 < starts.length; j++) {
        for (const x of s.slice(starts[j], starts[j + 1])) for (const p of x.procs) autos.set(p, (autos.get(p) ?? 0) + 1);
        loops++;
      }
    }
  }
  const fillers = [...rot.fillers.map((x) => ({ ...x, auto: false })), ...[...autos].map(([id, c]) => ({ id, perLoop: Math.round((c / loops) * 10) / 10, auto: true }))]
    .filter((x) => x.perLoop >= 0.2).sort((a, b) => b.perLoop - a.perLoop);
  // The opener ends where the core loop takes over (the project owner, 2026-10-02: past that it is the
  // loop again, autocasts and all): at the first anchor whose core steps after it play out one of the
  // loops shown (or its start, where the opener read runs out). No such point: its first 10 moves.
  // Waits are timing, not the loop: left out of the match.
  const folded = (ids: string[]) => { const x = ids.filter((id) => id !== 'Idle'); return x.filter((id, i) => id !== x[i - 1]); };
  const shapes = cycles.map((c) => folded(c.steps));
  let cut = -1;
  for (let i = 0; i < opener.length && cut < 0; i++) {
    if (opener[i].id !== kit.cycleAnchor) continue;
    const after = folded(opener.slice(i).map((x) => x.id).filter((id) => core(id)));
    // A whole loop after it, or the opener read running out partway into one.
    if (shapes.some((sh) => sh.length > 0 && (sh.every((id, j) => after[j] === id)
      || (after.length >= 2 && after.every((id, j) => sh[j] === id))))) cut = i;
  }
  const open = cut >= 0 ? opener.slice(0, cut) : opener.slice(0, 10);
  // Never ending on a wait (the project owner, 2026-10-02).
  while (open.length && open[open.length - 1].id === 'Idle') open.pop();
  return { ...rot, opener: open.map((x) => x.id), openerMarks: open.map((x) => x.mark), intoLoop: cut >= 0, cycles, fillers };
}

/** The best dummy rotation: tools/rotation-search.ts on this build, parsed. --keep-dummy: the one data/rotations.json already has. */
const kept = existsSync(resolve(REPO, 'data/rotations.json')) ? JSON.parse(readFileSync(resolve(REPO, 'data/rotations.json'), 'utf8')).classes ?? {} : {};
function dummySearch(profilePath: string, key: string): Record<string, unknown> {
  if (argv.includes('--keep-dummy') && kept[key]?.dummy?.options) return kept[key].dummy.options;
  if (argv.includes('--skip-search')) return {};
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './register.mjs', 'tools/rotation-search.ts',
    '--profile', profilePath, '--iter', '100', '--confirm', '300'], { encoding: 'utf8', cwd: resolve(REPO, 'combat'), maxBuffer: 1 << 26 });
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
  const anchored = { ...k.kit, cycleAnchor: typeof farmOpts.cycleAnchor === 'string' ? farmOpts.cycleAnchor : k.kit.cycleAnchor,
    coreRoles: Array.isArray(farmOpts.coreRoles) ? farmOpts.coreRoles as string[] : k.kit.coreRoles };
  // A dummy-searched build cannot live through Heartless (no HP gear): its loop is read off a fight it survives.
  const vs = c.vs ?? ALLROUND_VS;
  const allround = fight(f, buildMonster(findMobs(vs)[0]), farmOpts, 300, 100);
  const key = c.build ? `${c.className}: ${c.build}` : c.className;
  const dummyOpts = { ...farmOpts, ...dummySearch(c.profile, key) };
  const dummyRun = fight(f, dummy, dummyOpts, DUMMY_S, 200);
  // Traced fights for the per-step states: a few seeds, so a loop shows up in one of them.
  const traces = (m: Monster, options: Record<string, unknown>, limitS: number) => Array.from({ length: 30 }, (_, i) => {
    const fi = newFight(f, m, k.kit, priorityPolicy, { seed: 1000 + i, limitMs: limitS * 1000, options, trace: true,
      items: loadout({ carried: profile.consumables ?? DEFAULT_CONSUMABLES, healing: !!profile.healing, boss: m.boss, elixirs: f.kafraElixirs }) });
    run(fi);
    return fi.trace ?? [];
  });

  // What each pre-fight buff is worth on the dummy: its skill at 0, the same fights.
  const buffs = [];
  for (const b of c.buffs) {
    const offOpts = c.measure?.[b];
    if (!offOpts && !(b in opts.maxLevels)) continue;
    const off = offOpts ? f : await buildFighter({ ...profile, skills: { ...(profile.skills ?? {}), [b]: 0 } }, opts);
    const without = fight(off, dummy, { ...dummyOpts, ...offOpts }, DUMMY_S, 200).dps;
    const gain = without > 0 ? dummyRun.dps / without - 1 : Infinity;
    // Nothing on the dummy (Magic Pierce: the dummy has no DEF): what it is worth in the all-round fight instead.
    let vsGain: number | undefined;
    if (Math.abs(gain) < 0.005) {
      const off2 = fight(off, buildMonster(findMobs(vs)[0]), { ...farmOpts, ...offOpts }, 300, 100).dps;
      const g = off2 > 0 ? allround.dps / off2 - 1 : 0;
      if (g >= 0.005) vsGain = Math.round(1000 * g) / 1000;
    }
    // Without it the rotation falls apart (Moonlight Stance: no Moon skills at all): a requirement, not a percentage.
    buffs.push({ skill: b, icon: skillInfo.get(b)?.icon ?? '', dpsGain: gain > 1 ? null : Math.round(1000 * gain) / 1000, required: gain > 1,
      ...(vsGain !== undefined ? { vsGain } : {}), ...(c.optional?.includes(b) ? { optional: true } : {}) });
  }

  const ids = new Set<string>();
  const rots = [
    // A profile may cut its loops elsewhere than the kit (option cycleAnchor: the Counter Slash build at Midnight Eye).
    traced(anchored, traces(buildMonster(findMobs(vs)[0]), farmOpts, 300), rotationOf(allround)),
    traced(anchored, traces(dummy, dummyOpts, DUMMY_S), rotationOf(dummyRun)),
  ];
  for (const r of rots) {
    for (const id of [...r.opener, ...r.cycles.flatMap((x) => x.steps), ...r.fillers.map((x) => x.id)]) if (!NOT_SKILLS.has(id)) ids.add(id);
    // Autocasts (Haunting Slice's Scythe Reap, the Bulwark Gem's Shield Boomerang) get tiles of their own.
    for (const m of [...r.openerMarks, ...r.cycles.flatMap((x) => ('marks' in x ? x.marks : []) as Mark[])]) for (const p of m.procs) ids.add(p);
  }
  for (const b of buffs) ids.add(b.skill);
  const skills: Record<string, unknown> = {};
  for (const id of ids) {
    const base = id.replace(/ \(autocast\)$/, '');
    const s = skillInfo.get(base);
    skills[id] = {
      name: id, icon: s?.icon ?? '', level: f.skillLevels[base] ?? s?.max ?? 0, desc: descriptions[base] || s?.desc || '',
      summary: summaries[base] ?? null, scalings: s ? scalings(s.desc) : [],
      // The ratio term by term (base, per level, stats, buffs, conditions); null for skills without a damage formula.
      ratio: s ? skillRatio(c.className, base, s.desc, f.skillLevels) : null,
    };
  }
  result[key] = {
    className: c.className, build: profile.build, note: c.note, profileName: profile.name,
    allround: { vs, ...rotations(rots[0]) },
    dummy: { seconds: DUMMY_S, options: dummyOpts, ...rotations(rots[1]) },
    buffs, skills,
  };
  console.log(`${key}: allround ${rots[0].opener.join(' > ')}; dummy ${Math.round(dummyRun.dps)} dps; buffs ${buffs.map((b) => `${b.skill} ${b.required ? 'required' : `${(100 * (b.dpsGain ?? 0)).toFixed(1)}%`}`).join(', ')}`);
}
function rotations<T>(r: T): T { return r; }

const path = resolve(REPO, 'data/rotations.json');
const prev = existsSync(path) && one('only') ? JSON.parse(readFileSync(path, 'utf8')).classes ?? {} : {};
writeFileSync(path, `${JSON.stringify({ builtAt: new Date().toISOString(), allroundVs: ALLROUND_VS, dummySeconds: DUMMY_S, classes: { ...prev, ...result } }, null, 1)}\n`);
console.log(`wrote ${path}`);
