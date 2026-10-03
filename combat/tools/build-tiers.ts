/**
 * The planner's tier builds: data/class-tiers.json, from the tier searches
 * (data/gear-search/tiers/, .claude/scratch/rebench/tiers.mjs).
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/build-tiers.ts
 *
 * Every build has three tiers (the project owner, 2026-10-02): budget (what
 * a Lv130 can get from nothing), baseline (entry to the endgame maps) and
 * maxed (no limits). Each is a playstyle of data/class-goals.json; the
 * planner measures that playstyle's goals on the tier's build for its
 * targets, sees how far the player's build is along, and aims the
 * suggestions at the next tier (sim/src/presets.ts tierGoals).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readJSON, REPO } from '../src/data.ts';

/** Sim build -> the class and playstyle (data/class-goals.json) it stands for. */
const BUILDS: { id: string; className: string; style: string }[] = [
  { id: 'nr-counter', className: 'Night Raven', style: 'Counter Slash / Typhoon (STR)' },
  { id: 'nr-dd', className: 'Night Raven', style: 'Definitive Dagger (AGI/STR)' },
  { id: 'nr-aa', className: 'Night Raven', style: 'Pure auto-attack (crit)' },
  { id: 'nr-raven', className: 'Night Raven', style: 'Raven auto-attack (LUK)' },
  { id: 'satsujin', className: 'Satsujin', style: 'Moon (AGI/flee)' },
  { id: 'revenant', className: 'Revenant', style: 'Scythe crit (STR/LUK)' },
  { id: 'kingslayer', className: 'Kingslayer', style: 'Ebony (Max HP/VIT)' },
];
const TIERS = ['budget', 'baseline', 'maxed'] as const;

interface Rhythmed { win: number; value: number; rhythm?: { killsPerHour: number; deathsPerHour: number } }
interface Result {
  link: string;
  final: Rhythmed;
  perTarget?: { target: string; swaps: string[]; shared: Rhythmed; own: Rhythmed }[];
}

/** A swap is shown when it is worth this much more kills an hour on its monster; below, it is noise. */
const SWAP_GAIN = 0.05;
/**
 * The per-monster swaps grouped by what is carried: one weapon setup and the monsters it is for, best
 * gain first ("Guiding Dagger +9 [Observation Card x3] for Godly Seeker, Angel of Genesis, Heartless").
 */
function groupSwaps(rows: NonNullable<Result['perTarget']>) {
  const groups = new Map<string, { swaps: string[]; monsters: string[]; gain: number }>();
  for (const t of rows) {
    const before = t.shared.rhythm?.killsPerHour ?? 0; const after = t.own.rhythm?.killsPerHour ?? 0;
    const gain = before > 0 ? after / before - 1 : 0;
    if (!t.swaps.length || gain < SWAP_GAIN) continue;
    const key = t.swaps.join('; ');
    const g = groups.get(key) ?? { swaps: t.swaps, monsters: [], gain: 0 };
    g.monsters.push(t.target); g.gain = Math.max(g.gain, Math.round(gain * 1000) / 1000);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.monsters.length - a.monsters.length || b.gain - a.gain);
}

const DIR = resolve(REPO, 'combat/data/gear-search/tiers');
const load = (name: string) => (existsSync(`${DIR}/${name}.json`) ? readJSON<Result & { final: { value: number } }>(`${DIR}/${name}.json`) : null);

const out: Record<string, Record<string, Record<string, unknown>>> = {};
for (const b of BUILDS) {
  for (const tier of TIERS) {
    // The tier's own search, the second maxed start, and every stricter tier's build -- each is a legal build
    // here too (a baseline build is a maxed one) -- the best of them by kills an hour. A search can stick
    // short of a stricter tier's result (Kingslayer maxed 300 kills/h under its baseline's 370, 2026-10-03).
    const a = load(`${b.id}-${tier}`);
    const stricter = TIERS.slice(0, TIERS.indexOf(tier)).map((t) => load(`${b.id}-${t}`));
    const kph = (x: Result | null) => x?.final.rhythm?.killsPerHour ?? -1;
    const pool = [a, tier === 'maxed' ? load(`${b.id}-maxed-b`) : null, ...stricter].filter((x): x is NonNullable<typeof a> => !!x);
    if (!a || !pool.length) { console.log(`${b.id} ${tier}: not run yet`); continue; }
    const r = pool.reduce((best, x) => (kph(x) > kph(best) ? x : best));
    if (r !== a) console.log(`  ${b.id} ${tier}: a stricter or second search did better (${Math.round(kph(r))} vs ${Math.round(kph(a))} kills/h)`);
    // The weapons worth carrying come from the tier's swap list job (--per-target from its own build).
    const swapsOf = load(`${b.id}-${tier}-swaps`);
    if (swapsOf && r === a) r.perTarget = swapsOf.perTarget;
    const payload = r.link.split('#b=')[1];
    if (!payload) { console.log(`${b.id} ${tier}: no build link`); continue; }
    ((out[b.className] ??= {})[b.style] ??= {})[tier] = {
      payload,
      killsPerHour: Math.round(r.final.rhythm?.killsPerHour ?? 0),
      deathsPerHour: Math.round((r.final.rhythm?.deathsPerHour ?? 0) * 10) / 10,
      win: Math.round(r.final.win * 1000) / 1000,
      // The weapons worth carrying for particular monsters (baseline and maxed: per-monster swaps).
      swaps: r === a ? groupSwaps(r.perTarget ?? []) : [],
    };
    console.log(`${b.className} / ${b.style} / ${tier}: ${Math.round(r.final.rhythm?.killsPerHour ?? 0)} kills/h`);
  }
}

const file = resolve(REPO, 'data/class-tiers.json');
writeFileSync(file, `${JSON.stringify({
  _comment: 'Generated by combat/tools/build-tiers.ts from the tier gear searches: per class and playstyle (data/class-goals.json), the sim\'s budget / baseline / maxed builds over the 10 endgame areas. Do not edit by hand.',
  builtAt: new Date().toISOString().slice(0, 10),
  classes: out,
}, null, 1)}\n`);
console.log(`wrote ${file}`);
