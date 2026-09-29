/**
 * Run a baseline set: every profile in a manifest against every scenario, on
 * the same seeds, into one table. Other setups are tested against these rows.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/baseline.ts \
 *     [--set baselines/satsujin-rachel] [--candidate path/to/profile.json[,more.json]] \
 *     [--only rachel5,lair4] [--profiles budget,standard] [--iter 300] [--out results] [--jobs N]
 *
 * Writes <set>/<out>.json (every row) and <out>.md (per scenario: wins, lost,
 * mean kill time, DPS, what killed you). --candidate adds profiles to compare
 * without touching the manifest; their rows are marked "candidate". The
 * (scenario, profile) runs go in parallel, --jobs at a time (cores - 1).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { leaveFirstCore, workCores } from '../src/cpu.ts';

// Core 0 stays free for the player; the runs inherit it (src/cpu.ts).
leaveFirstCore();

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const list = (k: string) => one(k)?.split(',').map((s) => s.trim()).filter(Boolean);

interface Scenario { vs: string; bossTime?: number; time?: number; about?: string }
interface Manifest {
  name: string; profiles: Record<string, string>; scenarios: Record<string, Scenario>;
  iter: number; time: number; policy: string;
}
interface Row { variant: string; target: string; winRate: number; lossRate: number; ttk: number | null; dps: number; deaths: string }

const setDir = resolve(process.cwd(), one('set') ?? 'baselines/satsujin-rachel');
const manifest = JSON.parse(readFileSync(join(setDir, 'manifest.json'), 'utf8')) as Manifest;
const iter = Number(one('iter') ?? manifest.iter);
const onlyScen = list('only');
const onlyProf = list('profiles');

const profiles: { id: string; path: string; candidate: boolean }[] = [
  ...Object.entries(manifest.profiles).filter(([id]) => !onlyProf || onlyProf.includes(id))
    .map(([id, p]) => ({ id, path: join(setDir, p), candidate: false })),
  ...(list('candidate') ?? []).map((p) => ({ id: basename(p, '.json'), path: resolve(process.cwd(), p), candidate: true })),
];
const scenarios = Object.entries(manifest.scenarios).filter(([id]) => !onlyScen || onlyScen.includes(id));

const tmp = mkdtempSync(join(tmpdir(), 'baseline-'));
const results: { scenario: string; profile: string; candidate: boolean; rows: Row[] }[] = [];
const jobs = scenarios.flatMap(([sid, sc]) => profiles.map((p) => ({ sid, sc, p })));
const runJob = ({ sid, sc, p }: typeof jobs[number]) => new Promise<void>((done) => {
  const json = join(tmp, `${sid}-${p.id}.json`);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './register.mjs',
    'tools/variants.ts', '--profile', p.path, '--vs', sc.vs, '--iter', String(iter), '--policy', manifest.policy,
    '--time', String(sc.time ?? manifest.time), '--boss-time', String(sc.bossTime ?? 600), '--json', json],
  { cwd: process.cwd() });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.resume();
  child.on('close', (code) => {
    if (code !== 0) { console.error(`${sid} / ${p.id} failed:
${err}`); done(); return; }
    const rows = (JSON.parse(readFileSync(json, 'utf8')) as { rows: Row[] }).rows.filter((x) => x.variant === 'as is');
    results.push({ scenario: sid, profile: p.id, candidate: p.candidate, rows });
    const mean = (f: (x: Row) => number) => rows.reduce((s, x) => s + f(x), 0) / rows.length;
    console.log(`${sid.padEnd(15)} ${p.id.padEnd(16)} win ${(mean((x) => x.winRate) * 100).toFixed(0).padStart(3)}%  `
      + `${Math.round(mean((x) => x.dps)).toLocaleString('en').padStart(7)} dps`);
    done();
  });
});
let next = 0;
const width = Math.max(1, Number(one('jobs') ?? workCores()));
await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
  while (next < jobs.length) await runJob(jobs[next++]);
}));
// The table keeps the manifest's order, whatever order the runs finished in.
const order = (r: typeof results[number]) => jobs.findIndex((j) => j.sid === r.scenario && j.p.id === r.profile);
results.sort((a, b) => order(a) - order(b));
rmSync(tmp, { recursive: true, force: true });

// ---- the table -------------------------------------------------------------
const pct = (x: number) => `${Math.round(x * 100)}%`;
const md: string[] = [`# ${manifest.name}: results`, '',
  `${iter} fights per monster, policy ${manifest.policy}, run ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.`,
  'Per monster: win rate / mean kill time. Mean DPS over the scenario. Candidates are marked *.', ''];
for (const [sid, sc] of scenarios) {
  const here = results.filter((r) => r.scenario === sid);
  if (!here.length) continue;
  const mobs = here[0].rows.map((x) => x.target);
  md.push(`## ${sid}`, '', sc.about ?? '', '',
    `| Profile | ${mobs.join(' | ')} | Mean win | DPS |`, `|---|${mobs.map(() => '---').join('|')}|---|---|`);
  for (const r of here) {
    const cell = (m: string) => { const x = r.rows.find((y) => y.target === m)!; return `${pct(x.winRate)}${x.ttk ? `, ${x.ttk.toFixed(0)}s` : ''}`; };
    const win = r.rows.reduce((s, x) => s + x.winRate, 0) / r.rows.length;
    const dps = r.rows.reduce((s, x) => s + x.dps, 0) / r.rows.length;
    md.push(`| ${r.profile}${r.candidate ? '*' : ''} | ${mobs.map(cell).join(' | ')} | ${pct(win)} | ${Math.round(dps).toLocaleString('en')} |`);
  }
  const deaths = here.flatMap((r) => r.rows.filter((x) => x.deaths).map((x) => `${r.profile} / ${x.target}: ${x.deaths}`));
  if (deaths.length) md.push('', '<details><summary>What killed you</summary>', '', ...deaths.map((d) => `- ${d}`), '', '</details>');
  md.push('');
}
const out = one('out') ?? 'results';
writeFileSync(join(setDir, `${out}.json`), `${JSON.stringify({ name: manifest.name, iter, results }, null, 1)}\n`);
writeFileSync(join(setDir, `${out}.md`), `${md.join('\n')}\n`);
console.log(`\nwrote ${join(setDir, `${out}.md`)}`);
