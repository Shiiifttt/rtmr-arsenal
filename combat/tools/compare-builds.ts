/**
 * Score gear changes against a profile on the gear search's own terms (its
 * score, its targets, its fight counts, the same seeds): each variant is one
 * gear-search run with --set and no passes. For checking a search's picks
 * against the ones a player would make.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/compare-builds.ts \
 *     --variants data/compare/revenant-owner.json [--out data/compare/revenant-owner.out.json] -- <gear-search flags>
 *
 * The variants file: { "name": "--set spec", ... }; "as is" runs first. Every
 * flag after -- goes to gear-search (--profile, --vs, --map, --score...);
 * --passes 0 and --no-census are added.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const own = dash >= 0 ? argv.slice(0, dash) : argv;
const pass = dash >= 0 ? argv.slice(dash + 1) : [];
const one = (k: string) => { const i = own.indexOf(`--${k}`); return i >= 0 ? own[i + 1] : undefined; };
const variants = JSON.parse(readFileSync(resolve(process.cwd(), one('variants')!), 'utf8')) as Record<string, string>;

const rows: { name: string; spec: string; final: string; value: number | null }[] = [];
for (const [name, spec] of [['as is', ''], ...Object.entries(variants)] as [string, string][]) {
  const args = ['--experimental-strip-types', '--no-warnings', '--import', './register.mjs', 'tools/gear-search.ts',
    ...pass, '--passes', '0', '--no-census', ...(spec ? ['--set', spec] : [])];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  const final = /^final \(\d+ fights\): (.*)$/m.exec(r.stdout ?? '')?.[1] ?? `FAILED: ${(r.stderr ?? '').split('\n').slice(0, 3).join(' ')}`;
  const kph = /([\d.]+) kills\/h/.exec(final); const dph = /([\d.]+) deaths\/h/.exec(final);
  rows.push({ name, spec, final, value: kph && dph ? Number(kph[1]) / 100 - 0.3 * Number(dph[1]) : null });
  console.log(`${name.padEnd(44)} ${final}  (${Math.round((Date.now() - t0) / 1000)} s)`);
}
const out = one('out');
if (out) writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(rows, null, 1)}\n`);
