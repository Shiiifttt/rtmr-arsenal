/**
 * Many fights, one summary: win rate, time to kill, DPS, and where the
 * damage went -- a parse, averaged over seeds.
 */
import { defMultiplier, effectivePierce } from '../../sim/src/derived.ts';
import { newFight, run, type Fight, type Kit, type Meter, type Policy } from './engine.ts';
import type { Fighter, Monster } from './model.ts';
import { Rng } from './rng.ts';

export interface SimOptions {
  iterations: number;
  seed: number;
  limitMs: number;
  policy: Policy;
  /** Keep the first fight's combat log. */
  log?: boolean;
  options?: Record<string, unknown>;
  /** Consumables carried (items.ts). */
  items?: import('./engine.ts').Action[];
  /** Keep one row a fight in `perFight` (the gear search's per-target fight counts read its spread). */
  perFight?: boolean;
}

/** One fight, as the rhythm and the search scores read it. */
export interface FightRow {
  result: 'win' | 'loss' | 'stalemate';
  /** Seconds. */
  t: number;
  dealt: number;
  /** SP and HP spent: the bars at the pull less what is left at the end. */
  sp: number;
  hp: number;
}

export interface ActionRow {
  id: string;
  /** Its kit role ("Fillers", "Moon combo"), matching `Analysis.roles`. */
  role: string;
  /** Per fight, averaged. */
  uses: number;
  damage: number;
  share: number;
  crit: number;
  miss: number;
}

export interface Summary {
  monster: string;
  monsterId: number;
  iterations: number;
  wins: number;
  losses: number;
  stalemates: number;
  /** Why the stalemates happened: "time limit", "out of SP". */
  stalls: Record<string, number>;
  winRate: number;
  /** Seconds, over won fights only. */
  ttk: { mean: number; p10: number; p50: number; p90: number } | null;
  /** Damage per second over every fight, won or not. */
  dps: number;
  /** HP taken per fight and per second. */
  taken: number;
  dtps: number;
  /** Seconds per fight, averaged over every fight. */
  seconds: number;
  healed: number;
  /** SP and HP spent, per won fight: the bars at the pull less what is left at the kill (the rhythm score, src/rhythm.ts). */
  spUsed: number;
  hpUsed: number;
  deaths: Record<string, number>;
  actions: ActionRow[];
  sources: { id: string; hits: number; avoided: number; damage: number }[];
  defenses: Record<string, number>;
  /** Share of fight time a kit's tracked state was up (Meter.uptime): Night Wound 0.87. */
  uptime: Record<string, number>;
  log: string[] | null;
  analysis: Analysis;
  msPerFight: number;
  perFight?: FightRow[];
}

/**
 * The read on a batch: what the TAS settled into, what the damage is made
 * of, and how safe it was. Everything here is derived from the fights, not
 * from the kit's written rotation -- it is what played out.
 */
export interface Analysis {
  /** The first fight's opening moves, auto-attacks folded together. */
  opener: string[];
  /**
   * The core loops the TAS repeats -- the kit's `coreRoles` skills only,
   * cut at each `cycleAnchor` (New Moon) -- most common first, with their
   * share of all loops. Fillers shift with timing, so they would make every
   * loop unique; they are counted separately in `fillers`.
   */
  cycles: { steps: string[]; share: number }[];
  /** Everything else, per loop on average: "Thousand Arms" 1.4, "Attack" (swings) 3.2. */
  fillers: { id: string; perLoop: number }[];
  /** Damage by what it is for (kit roles): Moon combo, Omamori, fillers, autos. */
  roles: { role: string; damage: number; share: number }[];
  /** Null against the dummy, which never fights back. */
  survival: Survival | null;
  /** What the monster's hard DEF costs; null against no DEF. */
  pierce: Pierce | null;
  /** The same, as a few sentences. */
  /** What the kit put up before the pull ("Seven Winds: Holy (125% vs Dark 4)"). */
  prep: string[];
  read: { kind: ReadKind; text: string }[];
}

/**
 * Survivability, 0-100: half how often you live, a quarter how close the
 * closest call was (median lowest HP), a quarter how long you could keep
 * going at the fight's net damage intake (120s or more is full marks). A
 * heuristic for ranking builds against each other, not a probability.
 */
export interface Survival {
  score: number;
  label: 'Solid' | 'OK' | 'Shaky' | 'Fragile';
  /** Share of fights not lost. */
  survived: number;
  /** Median over fights of the lowest HP reached, as a share of Max HP. */
  lowestHp: number;
  /** Seconds from full HP to dead at the average net intake; null if you out-heal it. */
  timeToDie: number | null;
  /** Healing as a share of damage taken. */
  sustain: number;
  /** Share of incoming hits flee, dodges and Hiding avoided. */
  avoided: number;
}

/**
 * Hard DEF against your penetration, in damage. Physical damage is scaled by
 * (4000 + DEF') / (4000 + 10 DEF'), DEF' being what pierce leaves; the loss
 * is what full pierce would add back. Soft DEF is left out, as in the
 * arsenal's chart: penetration does not touch it.
 */
export interface Pierce {
  def: number;
  pen: number;
  /** Pierce the penetration buys, percent (the arsenal's curve). */
  pierce: number;
  /** Share of a physical hit that gets through, 0..1. */
  through: number;
  /** DPS lost to DEF, and the same as a share of your DPS. */
  lostDps: number;
  lostShare: number;
}

export function simulate(f: Fighter, m: Monster, kit: Kit, o: SimOptions): Summary {
  const started = performance.now();
  const ttks: number[] = [];
  let wins = 0; let losses = 0; let stalemates = 0;
  const stalls: Record<string, number> = {};
  let timeSum = 0;
  // DPS over the time actually fought: an early stall stops at stoppedAt, its clock booked to the limit.
  let foughtSum = 0;
  let spUsed = 0; let hpUsed = 0;
  const deaths: Record<string, number> = {};
  const total: Meter = {
    actions: {}, taken: {}, defenses: {}, healed: 0, sequence: [], minHp: f.maxHp,
  };
  let log: string[] | null = null;
  const lows: number[] = [];
  const sequences: string[][] = [];
  let prep: string[] = [];
  const rows: FightRow[] | null = o.perFight ? [] : null;

  for (let i = 0; i < o.iterations; i++) {
    const fight: Fight = newFight(f, m, kit, o.policy, {
      seed: Rng.forIteration(o.seed, i).next() * 2 ** 32,
      limitMs: o.limitMs, log: o.log && i === 0, options: o.options, items: o.items,
    });
    if (i === 0) prep = kit.prepNotes?.(fight) ?? [];
    run(fight);
    if (i === 0) log = fight.log;
    if (fight.result === 'win') {
      wins++; ttks.push(fight.t / 1000);
      spUsed += Math.max(0, f.maxSp - fight.me.sp); hpUsed += Math.max(0, f.maxHp - fight.me.hp);
    }
    else if (fight.result === 'loss') { losses++; deaths[fight.cause ?? '?'] = (deaths[fight.cause ?? '?'] ?? 0) + 1; }
    else { stalemates++; stalls[fight.cause ?? '?'] = (stalls[fight.cause ?? '?'] ?? 0) + 1; }
    timeSum += fight.t;
    foughtSum += fight.stoppedAt ?? fight.t;
    merge(total, fight.meter!);
    lows.push(fight.result === 'loss' ? 0 : Math.max(0, fight.meter!.minHp) / f.maxHp);
    sequences.push(fight.meter!.sequence);
    if (rows) {
      let dealt = 0;
      for (const k in fight.meter!.actions) dealt += fight.meter!.actions[k].damage;
      rows.push({ result: fight.result ?? 'stalemate', t: fight.t / 1000, dealt,
        sp: Math.max(0, f.maxSp - fight.me.sp), hp: Math.max(0, f.maxHp - fight.me.hp) });
    }
  }

  const n = o.iterations;
  const dealtByActions = Object.values(total.actions).reduce((s, a) => s + a.damage, 0);
  const actions: ActionRow[] = Object.entries(total.actions)
    .map(([id, a]) => ({
      id,
      role: kit.roles?.[id] ?? 'Other',
      uses: a.uses / n,
      damage: a.damage / n,
      share: dealtByActions ? a.damage / dealtByActions : 0,
      crit: a.hits ? a.crits / a.hits : 0,
      miss: a.hits + a.misses ? a.misses / (a.hits + a.misses) : 0,
    }))
    .filter((a) => a.damage > 0 || a.uses > 0)
    .sort((a, b) => b.damage - a.damage);
  const takenTotal = Object.values(total.taken).reduce((s, t) => s + t.damage, 0);

  ttks.sort((a, b) => a - b);
  const q = (p: number) => ttks[Math.min(ttks.length - 1, Math.floor(p * ttks.length))];
  return {
    monster: m.name,
    monsterId: m.id,
    iterations: n,
    wins, losses, stalemates, stalls,
    winRate: wins / n,
    ttk: ttks.length
      ? { mean: ttks.reduce((a, b) => a + b, 0) / ttks.length, p10: q(0.1), p50: q(0.5), p90: q(0.9) }
      : null,
    dps: foughtSum ? dealtByActions / (foughtSum / 1000) : 0,
    taken: takenTotal / n,
    dtps: foughtSum ? takenTotal / (foughtSum / 1000) : 0,
    seconds: timeSum / n / 1000,
    healed: total.healed / n,
    spUsed: wins ? spUsed / wins : 0,
    hpUsed: wins ? hpUsed / wins : 0,
    deaths,
    actions,
    sources: Object.entries(total.taken).map(([id, t]) => ({
      id, hits: t.hits / n, avoided: t.avoided / n, damage: t.damage / n,
    })).sort((a, b) => b.damage - a.damage),
    defenses: Object.fromEntries(Object.entries(total.defenses).map(([k, v]) => [k, v / n])),
    uptime: Object.fromEntries(Object.entries(total.uptime ?? {}).map(([k, v]) => [k, timeSum ? Math.min(1, v / timeSum) : 0])),
    log,
    // A profile may cut its loops elsewhere (option cycleAnchor) and count other roles as the loop (option coreRoles).
    analysis: analyse({ ...kit, cycleAnchor: typeof o.options?.cycleAnchor === 'string' ? o.options.cycleAnchor : kit.cycleAnchor,
      coreRoles: Array.isArray(o.options?.coreRoles) ? o.options.coreRoles as string[] : kit.coreRoles }, m, f, {
      sequences, actions, dealt: dealtByActions / n, n, losses, lows, stalls, prep,
      taken: takenTotal, healed: total.healed, seconds: timeSum / 1000,
      hits: Object.values(total.taken).reduce((s, t) => s + t.hits, 0),
      avoided: Object.values(total.taken).reduce((s, t) => s + t.avoided, 0),
    }),
    msPerFight: (performance.now() - started) / n,
    ...(rows ? { perFight: rows } : {}),
  };
}

function analyse(kit: Kit, m: Monster, f: Fighter, d: {
  sequences: string[][]; actions: ActionRow[]; dealt: number; n: number; losses: number;
  lows: number[]; taken: number; healed: number; seconds: number; hits: number; avoided: number;
  stalls: Record<string, number>; prep: string[];
}): Analysis {
  const roles = kit.roles ?? {};
  // Rotation moves only: dodges and upkeep depend on what the monster did.
  // Idle: waiting of a second or more (engine IDLE_STEP_MS), a step of the rotation like any other.
  const inRotation = (id: string) => id in roles || id === 'Idle';
  const moves = (seq: string[]) => fold(seq.filter(inRotation));

  const anchor = kit.cycleAnchor;
  const core = (id: string) => id === 'Idle' || !kit.coreRoles || kit.coreRoles.includes(roles[id]);
  const counts = new Map<string, number>();
  const fill = new Map<string, number>();
  const variants = new Map<string, Map<string, number>>();
  let loops = 0;
  if (anchor) {
    for (const seq of d.sequences) {
      // Unfolded here: filler counts want every swing.
      const s = seq.filter(inRotation);
      const starts = s.flatMap((id, i) => (id === anchor ? [i] : []));
      // A loop runs from one anchor to the next; the last one is cut short by the fight's end.
      for (let k = 0; k + 1 < starts.length; k++) {
        const loop = s.slice(starts[k], starts[k + 1]);
        // Two waits with only a filler between them are one Idle.
        const steps = loop.filter(core).filter((id, i, a) => !(id === 'Idle' && a[i - 1] === 'Idle'));
        // Loops that differ only in how often a skill repeats are one loop (Counter Slash x13 / x14 / x15
        // in a Counter state that blocks keep stretching): shown at their most common count.
        const key = steps.filter((id, i) => id !== steps[i - 1]).join(' → ');
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const v = variants.get(key) ?? new Map<string, number>();
        v.set(steps.join(' → '), (v.get(steps.join(' → ')) ?? 0) + 1);
        variants.set(key, v);
        for (const id of loop) if (!core(id)) fill.set(id, (fill.get(id) ?? 0) + 1);
        loops++;
      }
    }
  }
  const cycles = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([key, c]) => ({ steps: [...variants.get(key)!.entries()].sort((a, b) => b[1] - a[1])[0][0].split(' → '), share: c / loops }));
  const fillers = [...fill.entries()].sort((a, b) => b[1] - a[1])
    .map(([id, c]) => ({ id, perLoop: c / loops }));

  const byRole = new Map<string, number>();
  for (const a of d.actions) byRole.set(a.role, (byRole.get(a.role) ?? 0) + a.damage);
  const roleRows = [...byRole.entries()].filter(([, v]) => v > 0)
    .map(([role, damage]) => ({ role, damage, share: d.dealt ? damage / d.dealt : 0 }))
    .sort((a, b) => b.damage - a.damage);

  let survival: Survival | null = null;
  if (!m.dummy) {
    const survived = 1 - d.losses / d.n;
    const lows = [...d.lows].sort((a, b) => a - b);
    const lowestHp = lows[Math.floor(lows.length / 2)] ?? 1;
    const net = d.seconds ? (d.taken - d.healed) / d.seconds : 0;
    const timeToDie = net > 0 ? f.maxHp / net : null;
    const lasting = timeToDie === null ? 1 : Math.min(1, timeToDie / 120);
    const score = Math.round(100 * (0.5 * survived + 0.25 * lowestHp + 0.25 * lasting));
    survival = {
      score,
      label: score >= 80 ? 'Solid' : score >= 60 ? 'OK' : score >= 40 ? 'Shaky' : 'Fragile',
      survived, lowestHp, timeToDie,
      sustain: d.taken ? d.healed / d.taken : 1,
      avoided: d.hits + d.avoided ? d.avoided / (d.hits + d.avoided) : 1,
    };
  }

  let pierce: Pierce | null = null;
  if (m.def > 0 && d.seconds > 0) {
    const magic = new Set(kit.magicActions ?? []);
    const physical = d.actions.filter((a) => !magic.has(a.id)).reduce((s, a) => s + a.damage, 0);
    const pierced = effectivePierce(f.defPen);
    const through = defMultiplier(m.def, pierced);
    const dps = (d.dealt * d.n) / d.seconds;
    const lostDps = (physical / (d.dealt || 1)) * dps * (1 / through - 1);
    pierce = {
      def: m.def, pen: f.defPen, pierce: pierced, through,
      lostDps, lostShare: dps ? lostDps / dps : 0,
    };
  }

  const opener = moves(d.sequences[0] ?? []).slice(0, 10);
  const base = { opener, cycles, fillers, roles: roleRows, survival, pierce, prep: d.prep };
  return { ...base, read: readOut(base, d.actions, f, m, d) };
}

const pc = (x: number) => `${Math.round(x * 100)}%`;
const steps = (s: string[]) => s.map((id) => (id === 'Attack' ? 'auto-attacks' : id)).join(' → ');

/**
 * The read, one short line each, tagged by what it is about so a page can
 * put some of it elsewhere (the panel keeps rotation and pierce in hovers).
 * "pointer" lines are the actionable ones: what would change the outcome.
 */
export type ReadKind = 'setup' | 'damage' | 'rotation' | 'survival' | 'pierce' | 'pointer';

function readOut(
  a: Omit<Analysis, 'read'>, actions: ActionRow[], f: Fighter, m: Monster,
  d: { taken: number; n: number; losses: number; stalls: Record<string, number> },
): { kind: ReadKind; text: string }[] {
  const out: { kind: ReadKind; text: string }[] = [];
  const say = (kind: ReadKind, text: string) => out.push({ kind, text });

  if (a.prep.length) say('setup', `Before the pull: ${a.prep.join(', ')}.`);
  const top = actions.filter((x) => x.damage > 0).slice(0, 3);
  if (a.roles.length) {
    say('damage', `${a.roles.map((r) => `${r.role} ${pc(r.share)}`).join(' · ')}; `
      + `biggest ${top.map((x) => `${x.id} ${pc(x.share)}`).join(', ')}.`);
  }
  if (a.opener.length) say('rotation', `Open: ${steps(a.opener)}.`);
  if (a.cycles[0]) {
    say('rotation', `Core loop (${pc(a.cycles[0].share)} of loops): ${steps(a.cycles[0].steps)}.`);
    if (a.cycles[1]) say('rotation', `Also (${pc(a.cycles[1].share)}): ${steps(a.cycles[1].steps)}.`);
    const fill = a.fillers.filter((x) => x.perLoop >= 0.2)
      .map((x) => `${x.id === 'Attack' ? 'auto-attack' : x.id} ×${x.perLoop.toFixed(1)}`).join(', ');
    if (fill) say('rotation', `Fillers per loop: ${fill}.`);
  }
  const s = a.survival;
  if (s) {
    say('survival', `Lives ${pc(s.survived)} of fights · closest call ${pc(s.lowestHp)} HP · `
      + `${s.timeToDie === null ? 'out-heals the damage' : `~${Math.round(s.timeToDie)}s to die`} · `
      + `heals ${pc(s.sustain)} of damage taken · avoids ${pc(s.avoided)} of hits.`);
    // Where the pressure comes from, and the one number that would change it.
    if (d.taken > 0 && f.flee < m.hit - 10) {
      const now = Math.min(100, Math.max(10, m.hit - f.flee));
      say('pointer', `Its ${m.hit} HIT lands ${now}% of swings on your ${f.flee} flee; ${m.hit - 10} flee cuts that to 10%.`);
    }
  }
  const p = a.pierce;
  if (p) {
    say('pierce', `${p.def} DEF lets ${pc(p.through)} through at ${p.pen} pen (${Math.floor(p.pierce)}% pierce)`
      + `${p.lostShare >= 0.01 ? `; full pierce would add ${pc(p.lostShare)}` : ''}.`);
  }
  const dry = d.stalls['out of SP'] ?? 0;
  if (dry) say('pointer', `Runs out of SP in ${pc(dry / d.n)} of fights: SP cost, Max SP or sustain would carry it.`);
  return out;
}

/** Runs of auto-attacks read as one step: "Attack" rather than "Attack, Attack, Attack". */
function fold(seq: string[]): string[] {
  const out: string[] = [];
  for (const id of seq) if (!(id === 'Attack' && out[out.length - 1] === 'Attack')) out.push(id);
  return out;
}

function merge(into: Meter, m: Meter) {
  for (const [k, a] of Object.entries(m.actions)) {
    const r = (into.actions[k] ??= { uses: 0, hits: 0, misses: 0, crits: 0, damage: 0 });
    r.uses += a.uses; r.hits += a.hits; r.misses += a.misses; r.crits += a.crits; r.damage += a.damage;
  }
  for (const [k, t] of Object.entries(m.taken)) {
    const r = (into.taken[k] ??= { hits: 0, avoided: 0, damage: 0 });
    r.hits += t.hits; r.avoided += t.avoided; r.damage += t.damage;
  }
  for (const [k, v] of Object.entries(m.defenses)) into.defenses[k] = (into.defenses[k] ?? 0) + v;
  for (const [k, v] of Object.entries(m.uptime ?? {})) (into.uptime ??= {})[k] = (into.uptime[k] ?? 0) + v;
  into.healed += m.healed;
  into.minHp = Math.min(into.minHp, m.minHp);
}
