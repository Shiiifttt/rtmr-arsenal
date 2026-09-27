/**
 * Try gear and stat changes against the same fights, side by side: the
 * first step of the gear search.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/variants.ts \
 *     --profile profiles/kingslayer-dummy.json [--vs dummy,jorm,rachel_ss] [--iter 60] \
 *     --variant "VIT boots: shoes=Temporal VIT Boots" \
 *     --variant "Tower Eater: offhand.cards=Tower Eater Card" \
 *     [--policy tas|priority] [--sp-value 0.5] [--time 300] [--json out.json]   (--time: seconds before a fight is a stalemate; bosses 600)
 *
 * A variant is a name, a colon, and changes separated by ';':
 *   slot=Item Name[+refine]        put an item in a slot (its cards are dropped)
 *   slot.cards=Card A, Card B      the slot's cards, in socket order
 *   slot.refine=N
 *   slot.rolls=roll1:max_hp:2, roll2:sp_cost_reduced:5   (or none)
 *   stat.str=N                     base stat points
 *   skill.Rook's Smash=N           a skill level
 *   option.name=value              a kit option (true / false / a number)
 *   items=Green Potion, Blue Potion  the consumables carried (or none)
 *   healing=true                   carry the healing items (White/Blue Potion, Yggdrasil Berry)
 *   res.res_neutral=N              add N to one of your resistances (percent)
 *   mob.SR_KNUCKLEARROW.avoid=los  let a monster skill be dodged another way (hide, walk, los, diag)
 * The profile as it is always runs first, as "as is".
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildFighter, resolveBuild, type Profile } from '../src/character.ts';
import { findMobs, plannerDataset, readJSON } from '../src/data.ts';
import { DEFAULT_CONSUMABLES, loadout } from '../src/items.ts';
import type { MobSkill, Monster } from '../src/model.ts';
import { buildMonster, DUMMY_SECONDS, dummyMonster } from '../src/monster.ts';
import { simulate } from '../src/sim.ts';
import { priorityPolicy, tasPolicy } from '../src/tas.ts';
import { kitFor } from '../src/kits/index.ts';
import type { Build } from '../../sim/src/types.ts';

const argv: string[] = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const many = (k: string) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));

const data = plannerDataset();
const profile = readJSON<Profile>(resolve(process.cwd(), one('profile') ?? 'profiles/satsujin-example.json'));
const baseBuild = await resolveBuild(profile.build, data);
const iterations = Number(one('iter') ?? 60);
const targets: Monster[] = (one('vs') ?? 'dummy,jorm,rachel_ss').split(',').flatMap((q: string) =>
  (q.trim() === 'dummy' ? [dummyMonster()] : findMobs(q.trim()).map(buildMonster)));

interface Variant {
  name: string;
  profile: Profile;
  res: Record<string, number>;
  avoid: { skill: string; how: string }[];
}

const idOf = (name: string) => {
  const hit = data.itemList.find((i) => i.name.toLowerCase() === name.trim().toLowerCase());
  if (!hit) throw new Error(`no item named "${name.trim()}"`);
  return hit.id;
};

function applyChanges(spec: string): Variant {
  const [name, rest] = spec.includes(':') ? [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)] : [spec, ''];
  const build: Build = structuredClone(baseBuild);
  const p: Profile = { ...profile, build, skills: { ...(profile.skills ?? {}) }, options: { ...(profile.options ?? {}) } };
  const res: Record<string, number> = {}; const avoid: Variant['avoid'] = [];
  for (const change of rest.split(';').map((c) => c.trim()).filter(Boolean)) {
    const eq = change.indexOf('=');
    const key = change.slice(0, eq).trim(); const value = change.slice(eq + 1).trim();
    const [head, field] = key.split(/\.(.+)/);
    if (head === 'stat') { (build.baseStats as unknown as Record<string, number>)[field] = Number(value); continue; }
    if (head === 'skill') { p.skills![field] = Number(value); continue; }
    if (head === 'items') { p.consumables = value === 'none' ? [] : value.split(',').map((x) => x.trim()); continue; }
    if (head === 'healing') { p.healing = value === 'true'; continue; }
    if (head === 'res') { res[field] = (res[field] ?? 0) + Number(value); continue; }
    if (head === 'mob') { avoid.push({ skill: field.split('.')[0], how: value }); continue; }
    if (head === 'option') { p.options![field] = value === 'true' ? true : value === 'false' ? false : Number.isFinite(Number(value)) ? Number(value) : value; continue; }
    const slot = (build.slots[head] ??= { itemId: null, refine: 0, cards: [] });
    if (!field) {
      const m = /^(.*?)(?:\s*\+(\d+))?$/.exec(value)!;
      slot.itemId = idOf(m[1]); slot.cards = []; slot.rolls = undefined;
      if (m[2]) slot.refine = Number(m[2]);
    } else if (field === 'cards') slot.cards = value.split(',').map(idOf);
    else if (field === 'refine') slot.refine = Number(value);
    else if (field === 'rolls') {
      // "roll1:max_hp:2, roll3:ranged_damage:5" (values joined by '/'), or none.
      slot.rolls = value === 'none' ? undefined : Object.fromEntries(value.split(',').map((r) => {
        const [key, option, vals] = r.trim().split(':');
        return [key, { option, values: vals.split('/').map(Number) }];
      }));
    }
    else throw new Error(`unknown change "${change}"`);
  }
  return { name: name.trim(), profile: p, res, avoid };
}

const variants: Variant[] = [{ name: 'as is', profile, res: {}, avoid: [] }, ...many('variant').map(applyChanges)];
// --policy priority: the kit's written rotation; tas (default) looks ahead,
// with --sp-value weighing the SP a move spends (tas.ts spValue).
const policy = one('policy') === 'priority' ? priorityPolicy
  : tasPolicy({ horizonMs: 6000, spValue: one('sp-value') ? Number(one('sp-value')) : undefined });

interface Row {
  variant: string; target: string; dummy: boolean; winRate: number; lossRate: number; ttk: number | null; dps: number;
  deaths: string;
}
const rows: Row[] = [];
for (const v of variants) {
  const k = kitFor((await resolveBuild(v.profile.build, data)).className);
  const f = await buildFighter(v.profile, { passives: k.passives, aliases: k.aliases, maxLevels: k.maxLevels() });
  for (const [key, n] of Object.entries(v.res)) f.res[key] = (f.res[key] ?? 0) + n;
  process.stdout.write(`${v.name}: HP ${f.maxHp.toLocaleString("en-US")}, SP ${f.maxSp.toLocaleString("en-US")} (regen ${f.regen.sp}), INT ${f.stats.int}, pen ${f.defPen}, Auto Guard ${f.autoGuard ?? 0}\n`);
  for (const base of targets) {
    const m: Monster = v.avoid.length ? { ...base, skills: base.skills.map((s) => {
      const add = v.avoid.filter((a) => a.skill === s.skill).map((a) => a.how) as MobSkill['avoid'];
      return add.length ? { ...s, avoid: [...new Set([...s.avoid, ...add])] } : s;
    }) } : base;
    const sum = simulate(f, m, k.kit, {
      iterations: m.dummy ? Math.min(iterations, 10) : iterations, seed: 1, policy, options: v.profile.options,
      limitMs: (m.dummy ? DUMMY_SECONDS : m.boss ? 600 : Number(one('time') ?? 60)) * 1000,
      items: loadout({ carried: v.profile.consumables ?? DEFAULT_CONSUMABLES, healing: !!v.profile.healing, boss: m.boss && !m.dummy, elixirs: f.kafraElixirs }),
    });
    const top = Object.entries(sum.deaths).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s, n]) => `${s} x${n}`).join(', ');
    const lossRate = sum.losses / (sum.wins + sum.losses + sum.stalemates);
    rows.push({ variant: v.name, target: m.name, dummy: !!m.dummy, winRate: sum.winRate, lossRate, ttk: sum.ttk?.p50 ?? null,
      dps: sum.dps, deaths: top });
  }
}

// One table: a row per monster, a column per variant (win rate, median time to kill).
const names = variants.map((v) => v.name);
const w = Math.max(14, ...names.map((n) => n.length + 2));
console.log(`\n${'monster'.padEnd(26)}${names.map((n) => n.padStart(w)).join('')}`);
for (const t of [...new Set(rows.map((r) => r.target))]) {
  const cells = names.map((n) => {
    const r = rows.find((x) => x.variant === n && x.target === t)!;
    // Win rate and median kill time; with no wins, the loss rate and DPS.
    return (r.dummy ? `${Math.round(r.dps).toLocaleString('en-US')} dps`
      : r.winRate > 0 ? `${Math.round(r.winRate * 100)}% ${r.ttk ? `${r.ttk.toFixed(0)}s` : '-'}`
        : `0% L${Math.round(r.lossRate * 100)} ${Math.round(r.dps / 100) / 10}k`).padStart(w);
  });
  console.log(`${t.slice(0, 25).padEnd(26)}${cells.join('')}`);
}
const fights = rows.filter((r) => !r.dummy);
if (fights.length) {
  console.log(`${'mean win rate'.padEnd(26)}${names.map((n) => {
    const mine = fights.filter((r) => r.variant === n);
    return `${Math.round((mine.reduce((a, r) => a + r.winRate, 0) / mine.length) * 100)}%`.padStart(w);
  }).join('')}`);
}
for (const r of fights.filter((x) => x.deaths)) console.log(`  ${r.variant} / ${r.target}: killed by ${r.deaths}`);
const out = one('json');
if (out) writeFileSync(resolve(process.cwd(), out), `${JSON.stringify({ profile: profile.name, iterations, variants: names, rows }, null, 1)}\n`);
