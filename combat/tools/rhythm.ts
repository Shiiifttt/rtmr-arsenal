/**
 * Kills an hour, fight - sit - fight (src/rhythm.ts), for a profile and
 * variants of it, over a map's regulars weighted by how many spawn.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/rhythm.ts \
 *     --profile profiles/kingslayer-tomb.json --map lost_dun03 [--iter 300] [--time 300] \
 *     [--variant "name: changes"]...   (tools/variants.ts syntax)
 */
import { resolve } from 'node:path';

import { buildFighter, resolveBuild, type Profile } from '../src/character.ts';
import { findMobs, plannerDataset, readJSON } from '../src/data.ts';
import { spawnCounts } from '../src/farm.ts';
import { DEFAULT_CONSUMABLES, loadout } from '../src/items.ts';
import { buildMonster } from '../src/monster.ts';
import { rhythm, sitRegen } from '../src/rhythm.ts';
import { simulate } from '../src/sim.ts';
import { priorityPolicy } from '../src/tas.ts';
import { applyVariant } from '../src/variant-spec.ts';
import { kitFor } from '../src/kits/index.ts';

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const many = (k: string) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));

const data = plannerDataset();
const profile = readJSON<Profile>(resolve(process.cwd(), one('profile') ?? 'profiles/kingslayer-tomb.json'));
const base = await resolveBuild(profile.build, data);
const map = one('map') ?? 'lost_dun03';
const iterations = Number(one('iter') ?? 300);
const limitMs = Number(one('time') ?? 300) * 1000;
const targets = [...spawnCounts(map)].flatMap(([name, count]) => {
  const row = findMobs(name).find((r) => r.maps.includes(map)) ?? findMobs(name)[0];
  if (!row || row.mvp) return [];
  return [{ m: buildMonster(row), weight: count }];
});
const k = kitFor(base.className);

console.log(`${map}: ${targets.map((t) => `${t.m.name} x${t.weight}`).join(', ')}; ${iterations} fights each`);
console.log(`${'variant'.padEnd(30)}${'kills/h'.padStart(8)}${'deaths/h'.padStart(9)}${'cycle s'.padStart(8)}${'sit s'.padStart(7)}${'SP/s sit'.padStart(9)}   fight s / SP used per knight`);
for (const spec of ['as is', ...many('variant')]) {
  const v = spec === 'as is' ? { name: 'as is', profile } : applyVariant(profile, base, data, spec);
  const f = await buildFighter(v.profile, { passives: k.passives, aliases: k.aliases, maxLevels: k.maxLevels() });
  const options = v.profile.options ?? {};
  const fights = targets.map(({ m, weight }) => ({
    weight,
    s: simulate(f, m, k.kit, {
      iterations, seed: 1, policy: priorityPolicy, options, limitMs,
      items: loadout({ carried: v.profile.consumables ?? DEFAULT_CONSUMABLES, healing: !!v.profile.healing, boss: m.boss, elixirs: f.kafraElixirs }),
    }),
  }));
  const r = rhythm(f, k.kit, options, fights);
  const per = r.per.map((p) => `${p.name.split(' ')[0]} ${p.fightS.toFixed(0)}/${Math.round(p.spUsed)}`).join('  ');
  console.log(`${v.name.slice(0, 29).padEnd(30)}${r.killsPerHour.toFixed(0).padStart(8)}${r.deathsPerHour.toFixed(1).padStart(9)}${r.cycleS.toFixed(1).padStart(8)}${r.sitS.toFixed(1).padStart(7)}${sitRegen(f, k.kit, options).sp.toFixed(0).padStart(9)}   ${per}`);
}
