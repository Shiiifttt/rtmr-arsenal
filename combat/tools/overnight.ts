/**
 * A long, unattended optimisation run: many gear searches in a row, driven by
 * a plan file, resumable, with a summary at the end.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/overnight.ts \
 *     --plan runs/kingslayer-overnight.json [--smoke] [--dry] [--only heartless] [--fresh]
 *
 * For each target in the plan and each seed build meant for it:
 *   1. rot    the rotation alone (--only rotation,order), from the seed
 *   2. gear   the full gear search (every slot, cards, sets, stats, rotation,
 *             pairs), from the rot result
 * Every gear result ends on the same 2 x confirm fights (the search's final
 * check uses fixed seeds), so the seeds' results compare fairly; the best one
 * is the target's winner, and then:
 *   3. polish the rotation again on the winner, at more fights
 *   4. swaps  (targets with perTarget) the per-monster swaps from the polished build
 *   5. check  the top builds side by side over the plan's check monsters
 * and summary.md collects every stage's result and the winners' links.
 *
 * Each stage writes <outDir>/<target>/<seed>/<stage>.json and .log. A stage
 * whose .json exists is skipped, so a stopped run picks up where it was
 * (--fresh starts over). A stage that fails is retried once, then that seed
 * is dropped for the night and the rest carry on.
 *
 * --smoke: tiny fight counts and one pass, into <outDir>/smoke -- a few
 * minutes to prove the plan runs end to end before leaving it for hours.
 * --dry: print the commands only.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { readJSON } from '../src/data.ts';

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (k: string) => argv.includes(`--${k}`);

interface Knobs { screen: number; confirm: number; passes: number }
interface Plan {
  name: string;
  outDir: string;
  /** Extra gear-search flags for every stage ("--lock offhand"). */
  searchFlags?: string[];
  /** flags: extra gear-search flags for this target's stages (a budget tier: "--no-mvp", "--max-refine", "6"). */
  targets: Record<string, { vs: string; perTarget?: string; check?: string; flags?: string[] }>;
  seeds: { id: string; profile: string; set?: string; for: string[]; about?: string }[];
  rotation: Knobs; gear: Knobs; polish: Knobs;
  /** Fights per build in the side-by-side check, and how many builds it takes. */
  check: { iter: number; top: number };
}
interface SearchOut {
  final: { win: number; loss: number; dps: number; ttk: number | null; value: number; deaths: string };
  options: Record<string, unknown>; link: string; steps: { move: string }[];
  perTarget: { cost: number; target: string; swaps: string[]; options: Record<string, unknown>; own: SearchOut['final']; shared: SearchOut['final'] }[];
}
interface Profile { name?: string; build: string; skills?: Record<string, number>; options?: Record<string, unknown>; [k: string]: unknown }

const planPath = resolve(process.cwd(), one('plan') ?? 'runs/kingslayer-overnight.json');
const plan = readJSON<Plan>(planPath);
const smoke = flag('smoke');
const dry = flag('dry');
const onlyTargets = one('only')?.split(',').map((s) => s.trim());
const outDir = resolve(dirname(planPath), plan.outDir, smoke ? 'smoke' : '.');
if (flag('fresh') && existsSync(outDir) && !dry) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
const knobs = (k: Knobs): Knobs => (smoke ? { screen: 6, confirm: 12, passes: 1 } : k);

const NODE = ['--experimental-strip-types', '--no-warnings', '--import', './register.mjs'];
const t0 = Date.now();
const clock = () => { const s = Math.round((Date.now() - t0) / 1000); return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`; };
const say = (msg: string) => console.log(`[${clock()}] ${msg}`);

/** Run a tool, its output to <log> (and a one-line heartbeat to the console). */
function runTool(tool: string, args: string[], log: string): Promise<boolean> {
  const cmd = [...NODE, `tools/${tool}`, ...args];
  if (dry) { console.log(`node ${cmd.map((a) => (/[\s;']/.test(a) ? `"${a}"` : a)).join(' ')}`); return Promise.resolve(true); }
  mkdirSync(dirname(log), { recursive: true });
  const out = createWriteStream(log);
  out.write(`node ${cmd.join(' ')}\n\n`);
  return new Promise((done) => {
    const child = spawn(process.execPath, cmd, { cwd: process.cwd() });
    const echo = (buf: Buffer) => {
      out.write(buf);
      // The kept moves are the progress worth seeing.
      for (const line of buf.toString().split('\n')) if (/^(\S.*: )?pass \d+ /.test(line) || /^final/.test(line)) console.log(`    ${line.trim().slice(0, 150)}`);
    };
    child.stdout.on('data', echo); child.stderr.on('data', echo);
    child.on('close', (code) => { out.end(); done(code === 0); });
  });
}

let targetFlags: string[] = [];
async function search(stage: string, dir: string, profile: string, vs: string, k: Knobs, extra: string[]): Promise<SearchOut | null> {
  const json = join(dir, `${stage}.json`);
  if (existsSync(json) && !dry) { say(`  ${stage}: done before, kept`); return readJSON<SearchOut>(json); }
  const kk = knobs(k);
  const args = ['--profile', profile, '--vs', vs, '--screen', String(kk.screen), '--confirm', String(kk.confirm),
    '--passes', String(kk.passes), ...(plan.searchFlags ?? []), ...targetFlags, ...extra, '--out', json];
  for (let attempt = 1; attempt <= 2; attempt++) {
    say(`  ${stage}${attempt > 1 ? ' (retry)' : ''}`);
    if (await runTool('gear-search.ts', args, join(dir, `${stage}.log`))) return dry ? null : readJSON<SearchOut>(json);
    say(`  ${stage}: failed, see ${join(dir, `${stage}.log`)}`);
  }
  return null;
}

/** A search's result as a profile the next stage starts from. */
function profileFrom(seed: Profile, res: SearchOut, name: string, path: string): string {
  const p: Profile = { ...seed, name, build: res.link, options: res.options };
  delete p._about;
  if (!dry) writeFileSync(path, `${JSON.stringify(p, null, 2)}\n`);
  return path;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const show = (s: SearchOut['final']) => `win ${pct(s.win)}, lost ${pct(s.loss)}, ${Math.round(s.dps).toLocaleString('en')} dps${s.ttk ? `, ${s.ttk.toFixed(1)} s` : ''}`;
const summary: string[] = [`# ${plan.name}${smoke ? ' (smoke test)' : ''}`, '', `Plan: ${planPath}`, ''];

for (const [tid, target] of Object.entries(plan.targets)) {
  if (onlyTargets && !onlyTargets.includes(tid)) continue;
  say(`== ${tid}: ${target.vs}`);
  targetFlags = target.flags ?? [];
  const results: { seed: string; res: SearchOut; profile: string }[] = [];
  for (const seed of plan.seeds.filter((s) => s.for.includes(tid))) {
    say(`-- ${seed.id}${seed.set ? ` (${seed.set})` : ''}`);
    const dir = join(outDir, tid, seed.id);
    mkdirSync(dir, { recursive: true });
    const seedProfile = readJSON<Profile>(resolve(process.cwd(), seed.profile));
    const rot = await search('rot', dir, seed.profile, target.vs, plan.rotation, ['--only', 'rotation,order', ...(seed.set ? ['--set', seed.set] : [])]);
    if (!rot && !dry) continue;
    const rotProfile = dry ? join(dir, 'rot.profile.json') : profileFrom(seedProfile, rot!, `${seed.id}: rotation`, join(dir, 'rot.profile.json'));
    const gear = await search('gear', dir, rotProfile, target.vs, plan.gear, []);
    if (!gear) continue;
    results.push({ seed: seed.id, res: gear, profile: profileFrom(seedProfile, gear, `${plan.name}: ${tid} from ${seed.id}`, join(dir, 'gear.profile.json')) });
  }
  if (dry) continue;
  if (!results.length) { summary.push(`## ${tid}`, '', 'Every seed failed; see the logs.', ''); continue; }

  results.sort((a, b) => b.res.final.value - a.res.final.value);
  const win = results[0];
  say(`   ${tid} winner so far: ${win.seed} (${show(win.res.final)})`);
  const wdir = join(outDir, tid, win.seed);
  const winProfile = readJSON<Profile>(win.profile);
  const polish = await search('polish', wdir, win.profile, target.vs, plan.polish, ['--only', 'rotation,order']);
  const best = polish ? profileFrom(winProfile, polish, `${plan.name}: ${tid} best`, join(outDir, `${tid}-best.profile.json`)) : win.profile;
  const swaps = target.perTarget ? await search('swaps', wdir, best, target.vs, plan.gear, ['--per-target', '--swap-cost', target.perTarget]) : null;

  // The top builds side by side, on the same fights.
  const top = results.slice(0, knobs(plan.gear).passes === 1 ? 2 : plan.check.top);
  const checkLog = join(outDir, `${tid}-check.log`);
  if (!existsSync(checkLog.replace(/\.log$/, '.json'))) {
    say(`  check: best + ${top.length} seed results`);
    // variants.ts varies one profile, so each build is its own run on the same seeds.
    for (const [i, r] of [{ seed: 'best', profile: best }, ...top.map((t) => ({ seed: t.seed, profile: t.profile }))].entries()) {
      // The search's fights: the written rotation (variants.ts defaults to the look-ahead one) and its time limit.
      await runTool('variants.ts', ['--profile', r.profile, '--vs', target.check ?? target.vs, '--iter', String(smoke ? 20 : plan.check.iter),
        '--policy', 'priority', '--time', '300',
        '--json', join(outDir, 'check', `${tid}-${i}-${r.seed}.json`)], join(outDir, 'check', `${tid}-${i}-${r.seed}.log`));
    }
    writeFileSync(checkLog.replace(/\.log$/, '.json'), '{}\n');
  }

  summary.push(`## ${tid}: ${target.vs}`, '', '| Seed | Rotation only | Full search | Moves kept |', '|---|---|---|---|');
  for (const r of results) {
    const rot = readJSON<SearchOut>(join(outDir, tid, r.seed, 'rot.json'));
    summary.push(`| ${r.seed} | ${show(rot.final)} | **${show(r.res.final)}** | ${r.res.steps.length} |`);
  }
  summary.push('', `Winner: **${win.seed}**${polish ? `, rotation polished: ${show(polish.final)}` : ''}`, '', `Build: ${polish?.link ?? win.res.link}`, '',
    `Options: \`${JSON.stringify(polish?.options ?? win.res.options)}\``, '', `Profile: ${best}`, '');
  summary.push('Moves the winning search kept:', '', ...win.res.steps.map((s) => `- ${s.move}`), '');
  if (swaps) {
    summary.push('Per-monster swaps from the best build:', '', '| Cost | Monster | Shared | With swaps | Swaps |', '|---|---|---|---|---|');
    for (const p of swaps.perTarget) summary.push(`| ${p.cost} | ${p.target} | ${show(p.shared)} | ${show(p.own)} | ${p.swaps.join('; ') || '-'}${Object.keys(p.options).length ? ` (rotation ${JSON.stringify(p.options)})` : ''} |`);
    summary.push('');
  }
  summary.push(`Side-by-side check: ${join(outDir, 'check')} (${tid}-*.log)`, '');
  writeFileSync(join(outDir, 'summary.md'), `${summary.join('\n')}\n`);
}

if (!dry) {
  summary.push(`Took ${clock()}.`);
  writeFileSync(join(outDir, 'summary.md'), `${summary.join('\n')}\n`);
  say(`done: ${join(outDir, 'summary.md')}`);
}
