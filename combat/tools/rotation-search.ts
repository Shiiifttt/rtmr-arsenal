/**
 * Search the rotation on the training dummy: start from the profile's
 * rotation (its options and priority order), try every switch the other way
 * and every skill moved up or down the priority list or left out, keep the
 * best change, and repeat until nothing helps. Every candidate plays the
 * same seeds, so the comparison is fair; the winner is checked again on
 * fresh seeds against the start.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/rotation-search.ts \
 *     --profile profiles/satsujin-moon.json [--time 10] [--iter 200] [--confirm 1000] [--fixed weaveMs,slashOpener]
 *
 * --time: the dummy window in seconds (default DUMMY_SECONDS). A longer one
 * (60) weighs the loop over the opener and lets SP run short.
 * --fixed: options the search leaves as the profile has them.
 */
import { resolve } from 'node:path';

import { buildFighter, resolveBuild, type Profile } from '../src/character.ts';
import { plannerDataset, readJSON } from '../src/data.ts';
import { DUMMY_SECONDS, dummyMonster } from '../src/monster.ts';
import { simulate } from '../src/sim.ts';
import { priorityPolicy, tasPolicy } from '../src/tas.ts';
import { kitFor } from '../src/kits/index.ts';

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

const data = plannerDataset();
const profile = readJSON<Profile>(resolve(process.cwd(), one('profile') ?? 'profiles/satsujin-moon.json'));
const build = await resolveBuild(profile.build, data);
const kit = kitFor(build.className ?? '');
const f = await buildFighter(profile, { passives: kit.passives, aliases: kit.aliases, maxLevels: kit.maxLevels() });
const m = dummyMonster();
const limitMs = Number(one('time') ?? DUMMY_SECONDS) * 1000;
const iterations = Number(one('iter') ?? 200);
const confirmN = Number(one('confirm') ?? 1000);
// strictCombo is the owner's rule (Million Stab / Dragon Omamori wait for
// Combo Ready): a short window rewards breaking it, a real fight does not.
const fixed = new Set((one('fixed') ?? 'weaveMs,strictCombo').split(',').map((s) => s.trim()));

const kitOrder: string[] = await (async () => {
  const mod = await import(`../src/kits/${(build.className ?? '').toLowerCase()}.ts`);
  const o = Object.entries(mod).find(([k]) => /_ORDER$/.test(k))?.[1];
  if (!Array.isArray(o)) throw new Error(`${build.className}: the kit exports no priority order`);
  return o as string[];
})();

/** Switches the kits read, each tried the other way (defaults first). */
const SWITCHES: Record<string, unknown[]> = {
  backStab: [true, false], seedTalisman: [true, false], slashOpener: [false, true],
  hallucinationWalk: [true, false], refocus: [true, false], strictCombo: [true, false],
};
/** Entries the search never moves: dodges and upkeep. */
const PINNED = new Set(['Stay hidden', 'Pull it off the ward', "Morroc's Mark", 'Lotus Pact', 'Wait for swing']);
/** Entries it may leave out of the rotation altogether. */
const DROPPABLE = new Set(['Thousand Arms', 'Shadow Slash', 'Back Stab', 'Hallucination Walk', 'Dragon Omamori', 'Million Stab']);

type Opts = Record<string, unknown>;
interface Move { label: string; options: Opts }

function moves(o: Opts): Move[] {
  const out: Move[] = [];
  for (const [k, choices] of Object.entries(SWITCHES)) {
    if (fixed.has(k)) continue;
    const now = o[k] ?? choices[0];
    for (const v of choices) if (v !== now) out.push({ label: `${k} = ${v}`, options: { ...o, [k]: v } });
  }
  const base = (o.order ?? kitOrder) as string[];
  for (let i = 0; i < base.length; i++) {
    const x = base[i];
    if (PINNED.has(x)) continue;
    for (const d of [-3, -2, -1, 1, 2, 3]) {
      const j = i + d;
      if (j < 0 || j >= base.length) continue;
      const order = [...base]; order.splice(i, 1); order.splice(j, 0, x);
      out.push({ label: `${x} ${d < 0 ? 'up' : 'down'} ${Math.abs(d)} (${d < 0 ? 'before' : 'after'} ${base[j]})`, options: { ...o, order } });
    }
    if (DROPPABLE.has(x)) out.push({ label: `leave out ${x}`, options: { ...o, order: base.filter((y) => y !== x) } });
  }
  // Put back what an earlier step left out, at each place.
  for (const x of kitOrder.filter((y) => !base.includes(y))) {
    for (let j = 0; j <= base.length; j++) {
      const order = [...base]; order.splice(j, 0, x);
      out.push({ label: `put back ${x} before ${base[j] ?? 'the end'}`, options: { ...o, order } });
    }
  }
  return out;
}

const dps = (o: Opts, n: number, seed: number, policy = priorityPolicy) =>
  simulate(f, m, kit.kit, { iterations: n, seed, limitMs, policy, options: o }).dps;

const fmt = (x: number) => Math.round(x).toLocaleString('en-US');
const start: Opts = { ...(profile.options ?? {}) };
let cur = start;
let curDps = dps(cur, iterations, 1);
console.log(`${profile.name}: ${limitMs / 1000}s dummy, ${iterations} fights a candidate`);
console.log(`  start ${fmt(curDps)} dps`);
const path: string[] = [];
for (let round = 1; round <= 20; round++) {
  const cands = moves(cur);
  let best: Move | null = null; let bestDps = curDps;
  for (const c of cands) {
    const v = dps(c.options, iterations, 1);
    if (v > bestDps) { bestDps = v; best = c; }
  }
  // A change must beat noise: 0.2% on the same seeds.
  if (!best || bestDps < curDps * 1.002) { console.log(`  round ${round}: nothing better among ${cands.length}`); break; }
  console.log(`  round ${round}: ${best.label}  ->  ${fmt(bestDps)} dps (+${((bestDps / curDps - 1) * 100).toFixed(1)}%)`);
  path.push(best.label); cur = best.options; curDps = bestDps;
}

// The check: fresh seeds, more fights, both the start and the result, and the TAS.
const a = dps(start, confirmN, 777); const b = dps(cur, confirmN, 777);
const tas = tasPolicy({ horizonMs: 6000 });
const ta = dps(start, Math.min(confirmN, 100), 777, tas); const tb = dps(cur, Math.min(confirmN, 100), 777, tas);
console.log(`\nconfirm (${confirmN} fresh fights): start ${fmt(a)}  ->  found ${fmt(b)} dps (${((b / a - 1) * 100).toFixed(1)}%)`);
console.log(`  with the TAS lookahead on top: start ${fmt(ta)}, found ${fmt(tb)}`);
const diff = Object.fromEntries(Object.entries(cur).filter(([k, v]) => k !== 'order' && start[k] !== v));
console.log(`changes: ${path.join('; ') || 'none'}`);
if (Object.keys(diff).length) console.log(`switches: ${JSON.stringify(diff)}`);
if (cur.order) console.log(`order: ${JSON.stringify(cur.order)}`);
