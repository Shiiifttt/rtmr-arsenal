/**
 * A card benchmark: every card that fits a socket, tried in it one at a
 * time against the same fights, ranked -- the alternatives table for a
 * card that is hard to get.
 *
 * --items "lower,garment": the same for the pieces themselves -- every item
 * the class can wear in the slot, at the worn piece's refine (or its max),
 * with the worn cards that still fit and the worn rolls where its table has
 * them.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/card-bench.ts \
 *     --profile baselines/satsujin-rachel/budget.json --vs rachel5 \
 *     --sockets "middle:0,lower:0,offhand:0,acc2:0" \
 *     [--strip "Ifrit Card,Ymir Emperium Card"] [--set "variant changes"] \
 *     [--variant "name: changes"] [--screen 60] [--confirm 300] [--top 8] [--time 300] \
 *     [--allow-mvp] [--allow-ss] [--jobs N] [--json out.json]
 *
 * The base is the profile with --set applied and every --strip card taken
 * out of its sockets (an empty socket). Each candidate is the base with one
 * card in one socket; --variant adds whole setups to the same table.
 * Candidates: every card whose slot fits the socket's item, less MVP-only
 * cards and cards that only drop in the SS-rank dungeons (gear-search's
 * rules), unless allowed. Every candidate is screened on --screen fights a
 * monster; the --top of each socket (and every --variant) are fought again
 * on --confirm fresh fights. Ranked by win rate, then DPS.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildFighter, resolveBuild, type Profile } from '../src/character.ts';
import { leaveFirstCore, workCores } from '../src/cpu.ts';
import { accessoryCardFits, findMobs, MOB_GROUPS, mobRows, plannerDataset, readJSON } from '../src/data.ts';
import { DEFAULT_CONSUMABLES, loadout } from '../src/items.ts';
import { buildMonster } from '../src/monster.ts';
import { simulate } from '../src/sim.ts';
import { priorityPolicy } from '../src/tas.ts';
import { applyVariant } from '../src/variant-spec.ts';
import { kitFor } from '../src/kits/index.ts';
import {
  acquisitionOf, canEquip, fitsCard, fitsSlot, isRefineable, maxRefine, rollTableFor, SLOTS, type Build, type Item, type SlotDef,
} from '../../sim/src/index.ts';

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const many = (k: string) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));
const flag = (k: string) => argv.includes(`--${k}`);

const data = plannerDataset();
/** A card that fits the slot, and the side of an accessory (accessoryCardFits). */
const cardFits = (c: Item, slot: SlotDef, host?: Item | null) => fitsCard(c, slot, host) && (!host || accessoryCardFits(c.id, host.id));
const profile = readJSON<Profile>(resolve(process.cwd(), one('profile')!));
const named = (n: string) => data.itemList.find((i) => i.name.toLowerCase() === n.trim().toLowerCase());

/** The base: --set, then the --strip cards out. */
async function baseProfile(): Promise<Profile> {
  const built = await resolveBuild(profile.build, data);
  const p = one('set') ? applyVariant(profile, built, data, `base: ${one('set')}`).profile : { ...profile, build: built };
  const strip = new Set((one('strip') ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((n) => {
    const it = named(n); if (!it) throw new Error(`no card named "${n}"`); return it.id;
  }));
  const build: Build = structuredClone(p.build as Build);
  for (const s of Object.values(build.slots)) if (s?.cards) s.cards = s.cards.filter((c) => !strip.has(c as number));
  return { ...p, build };
}

// Sources, as gear-search judges them.
const mvpMob = new Set(mobRows().filter((m) => m.mvp).map((m) => m.id));
const boxesOf = (i: Item) => (i.containers ?? []).filter((c) => !/card album/i.test(c.container ?? ''));
const mvpOnly = (i: Item) => { const d = i.drops ?? []; return !!d.length && !boxesOf(i).length && !acquisitionOf(i) && d.every((x) => x.mvp_reward || mvpMob.has(x.mob_id)); };
const SS = new Set([...MOB_GROUPS.rachel_ss, ...MOB_GROUPS.jorm, ...MOB_GROUPS.valhalla, ...MOB_GROUPS.ama_ss]);
const mobMaps = new Map(mobRows().map((m) => [m.id, m.maps]));
const ssOnly = (i: Item) => { const d = i.drops ?? []; return !!d.length && !boxesOf(i).length && !acquisitionOf(i) && d.every((x) => (mobMaps.get(x.mob_id) ?? []).length > 0 && mobMaps.get(x.mob_id)!.every((m) => SS.has(m))); };

type Job = { id: string; socket?: string; card?: number; spec?: string; slot?: string; piece?: NonNullable<Build['slots'][string]> };

/** --items: the base with another piece in `slot`. */
function withPiece(p: Profile, slot: string, piece: NonNullable<Build['slots'][string]>): Profile {
  const build: Build = structuredClone(p.build as Build);
  build.slots[slot] = structuredClone(piece);
  return { ...p, build };
}

/** Every piece for `slot` the base's class can wear, as --items tries them. */
function pieceJobs(base: Build, slot: string): Job[] {
  const def = SLOTS.find((s) => s.key === slot)!;
  const cur = base.slots[slot];
  const out: Job[] = [];
  for (const item of data.itemList) {
    if (item.id === cur?.itemId || !fitsSlot(item, def) || item.equip_slots.length > 1) continue;
    if (!canEquip(item, base.className ?? null, data.classRules, slot) || (item.required_level ?? 0) > base.baseLevel) continue;
    if (!flag('allow-mvp') && mvpOnly(item)) continue;
    if (!flag('allow-ss') && ssOnly(item)) continue;
    const cards = (cur?.cards ?? []).filter((id): id is number => !!id)
      .filter((id) => { const c = data.items.get(id); return !!c && cardFits(c, def, item); }).slice(0, item.card_slots);
    const refine = isRefineable(item) ? Math.min(cur?.refine ?? 0, maxRefine(item)) : 0;
    // The worn rolls, where the new piece's table offers the same option.
    const table = rollTableFor(data.rolls, slot, item);
    const rolls = Object.fromEntries(Object.entries(cur?.rolls ?? {}).filter(([k, r]) =>
      table?.rolls.some((t) => t.key === k && t.options.some((o) => o.key === r.option))));
    out.push({ id: `${slot} ${item.name}`, slot, piece: { itemId: item.id, refine, cards, ...(Object.keys(rolls).length ? { rolls } : {}) } });
  }
  return out;
}

function withCard(p: Profile, socket: string, card: number): Profile {
  const [slot, idx] = socket.split(':');
  const build: Build = structuredClone(p.build as Build);
  const s = build.slots[slot]!;
  const cards = [...(s.cards ?? [])];
  cards[Number(idx)] = card;
  s.cards = cards.filter((c) => c !== undefined && c !== null);
  return { ...p, build };
}

async function score(p: Profile, n: number, seed: number) {
  const k = kitFor((await resolveBuild(p.build, data)).className);
  const f = await buildFighter(p, { passives: k.passives, aliases: k.aliases, maxLevels: k.maxLevels() });
  const rows = [];
  for (const m of (one('vs') ?? 'rachel5').split(',').flatMap((q) => findMobs(q.trim()).map(buildMonster))) {
    const s = simulate(f, m, k.kit, {
      iterations: n, seed, policy: priorityPolicy, options: p.options,
      limitMs: (m.boss ? Number(one('boss-time') ?? 1200) : Number(one('time') ?? 300)) * 1000,
      items: loadout({ carried: p.consumables ?? DEFAULT_CONSUMABLES, healing: !!p.healing, boss: m.boss, elixirs: f.kafraElixirs }),
    });
    rows.push({ target: m.name, win: s.winRate, loss: s.losses / n, dps: s.dps, ttk: s.ttk?.p50 ?? null });
  }
  const mean = (g: (r: typeof rows[number]) => number) => rows.reduce((a, r) => a + g(r), 0) / rows.length;
  return { win: mean((r) => r.win), loss: mean((r) => r.loss), dps: mean((r) => r.dps), rows, hp: f.maxHp };
}

if (one('child')) {
  const { jobs, n, seed } = JSON.parse(one('child')!) as { jobs: Job[]; n: number; seed: number };
  const base = await baseProfile();
  const out = [];
  for (const j of jobs) {
    const p = j.spec !== undefined ? (j.spec ? applyVariant(base, base.build as Build, data, j.spec).profile : base)
      : j.piece ? withPiece(base, j.slot!, j.piece) : withCard(base, j.socket!, j.card!);
    out.push({ ...j, ...(await score(p, n, seed)) });
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
} else {
  leaveFirstCore();
  const base = await baseProfile();
  const sockets = (one('sockets') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const cardName = (id: number) => data.items.get(id)?.name ?? String(id);
  const jobs: Job[] = [{ id: 'base', spec: '' }, ...many('variant').map((v) => ({ id: v.slice(0, v.indexOf(':')).trim(), spec: v }))];
  for (const socket of sockets) {
    const [slot] = socket.split(':');
    const def = SLOTS.find((s) => s.key === slot)!;
    const host = data.items.get((base.build as Build).slots[slot]!.itemId!);
    for (const c of data.itemList) {
      if (c.kind !== 'Card' || !cardFits(c, def, host)) continue;
      if (!flag('allow-mvp') && mvpOnly(c)) continue;
      if (!flag('allow-ss') && ssOnly(c)) continue;
      jobs.push({ id: `${socket} ${c.name}`, socket, card: c.id });
    }
  }
  const itemSlots = (one('items') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const slot of itemSlots) jobs.push(...pieceJobs(base.build as Build, slot));
  const width = Math.max(1, Number(one('jobs') ?? workCores()));
  const pass = argv.filter((a, i) => !['--variant', '--jobs', '--json'].includes(a) && !['--variant', '--jobs', '--json'].includes(argv[i - 1] ?? ''));
  const runAll = async (list: Job[], n: number, seed: number) => {
    const chunks: Job[][] = Array.from({ length: Math.min(width, list.length) }, () => []);
    list.forEach((j, i) => chunks[i % chunks.length].push(j));
    const res = await Promise.all(chunks.map((c) => new Promise<unknown[]>((done) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './register.mjs', 'tools/card-bench.ts',
        ...pass, '--child', JSON.stringify({ jobs: c, n, seed })], { cwd: process.cwd() });
      let so = ''; let se = '';
      child.stdout.on('data', (d) => { so += d; }); child.stderr.on('data', (d) => { se += d; });
      child.on('close', (code) => { if (code !== 0) { console.error(se); done([]); } else done(JSON.parse(so.trim().split('\n').pop()!)); });
    })));
    return res.flat() as (Job & Awaited<ReturnType<typeof score>>)[];
  };
  const rank = (a: { win: number; dps: number }, b: { win: number; dps: number }) => b.win - a.win || b.dps - a.dps;
  console.log(`screening ${jobs.length} setups x ${one('screen') ?? 60} fights a monster ...`);
  const screened = await runAll(jobs, Number(one('screen') ?? 60), 1);
  const top = Number(one('top') ?? 8);
  const keep = screened.filter((r) => r.spec !== undefined);
  for (const socket of sockets) keep.push(...screened.filter((r) => r.socket === socket).sort(rank).slice(0, top));
  for (const slot of itemSlots) keep.push(...screened.filter((r) => r.slot === slot).sort(rank).slice(0, top));
  console.log(`confirming ${keep.length} on ${one('confirm') ?? 300} fresh fights a monster ...`);
  const confirmed = await runAll(keep.map(({ id, socket, card, spec, slot, piece }) => ({ id, socket, card, spec, slot, piece })), Number(one('confirm') ?? 300), 7);
  const b = confirmed.find((r) => r.id === 'base')!;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const mobs = b.rows.map((r) => r.target);
  const pieceName = (p: NonNullable<Job['piece']>) => `${cardName(p.itemId!)}${p.refine ? ` +${p.refine}` : ''}${p.cards.length ? ` [${p.cards.map((c) => cardName(c as number)).join(', ')}]` : ''}`;
  const line = (r: typeof confirmed[number]) => `| ${r.socket ? cardName(r.card!) : r.piece ? pieceName(r.piece) : r.id} | ${r.rows.map((x) => `${pct(x.win)}${x.ttk ? ` ${x.ttk.toFixed(0)}s` : ''}`).join(' | ')} | ${pct(r.win)} | ${Math.round(r.dps).toLocaleString('en')} | ${r.dps >= b.dps ? '+' : ''}${Math.round((r.dps / b.dps - 1) * 100)}% |`;
  const md = [`Base: ${one('profile')}${one('set') ? ` with ${one('set')}` : ''}${one('strip') ? `, without ${one('strip')}` : ''}. ${one('confirm') ?? 300} fights a monster vs ${one('vs') ?? 'rachel5'}.`, ''];
  const head = `| Setup | ${mobs.join(' | ')} | Mean win | DPS | vs base |`;
  const rule = `|---|${mobs.map(() => '---').join('|')}|---|---|---|`;
  md.push('### Setups', '', head, rule, ...confirmed.filter((r) => r.spec !== undefined).sort(rank).map(line), '');
  for (const socket of sockets) {
    md.push(`### ${socket} (${cardName((base.build as Build).slots[socket.split(':')[0]]!.itemId!)}): best ${top} of ${screened.filter((r) => r.socket === socket).length}`, '', head, rule, line(b),
      ...confirmed.filter((r) => r.socket === socket).sort(rank).map(line), '');
  }
  for (const slot of itemSlots) {
    const cur = (base.build as Build).slots[slot];
    md.push(`### ${slot} pieces (worn: ${cur?.itemId ? pieceName(cur) : 'nothing'}): best ${top} of ${screened.filter((r) => r.slot === slot).length}`, '', head, rule, line(b),
      ...confirmed.filter((r) => r.slot === slot).sort(rank).map(line), '');
  }
  console.log(md.join('\n'));
  const out = one('json');
  if (out) writeFileSync(resolve(process.cwd(), out), `${JSON.stringify({ args: argv, screened, confirmed }, null, 1)}\n`);
}
