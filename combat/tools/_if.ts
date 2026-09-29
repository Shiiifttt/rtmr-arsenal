import { buildFighter, resolveBuild, type Profile } from '../src/character.ts';
import { findMobs, plannerDataset, readJSON } from '../src/data.ts';
import { DEFAULT_CONSUMABLES, loadout } from '../src/items.ts';
import { buildMonster } from '../src/monster.ts';
import { simulate } from '../src/sim.ts';
import { priorityPolicy } from '../src/tas.ts';
import { applyVariant } from '../src/variant-spec.ts';
import { kitFor } from '../src/kits/index.ts';
import { mobDamage } from '../src/formulas.ts';
import { Rng } from '../src/rng.ts';
const data = plannerDataset();
const prof = readJSON<Profile>('profiles/kingslayer-current.json');
const b0 = await resolveBuild(prof.build, data); const k = kitFor(b0.className);
const v = applyVariant(prof, b0, data, 'choco: weapon.cards=Chocolate Bear Card, Chocolate Bear Card, Chocolate Bear Card, Chocolate Bear Card');
const f = await buildFighter(v.profile, { passives: k.passives, aliases: k.aliases, maxLevels: k.maxLevels() });
const m = buildMonster(findMobs('Ifrit')[0]);
console.log(`Max HP ${f.maxHp}, MDEF ${f.mdef}+${f.softMdef}, element ${f.element}`);
for (const s of m.skills.filter((x) => x.type === 'magic' || x.type === 'physical')) {
  const e = mobDamage(m, f, s, new Rng(0, true)); const top = mobDamage(m, f, s, new Rng(1, false));
  console.log(`  ${s.name.padEnd(14)} ${s.type} ${s.element} x${s.ticks} waves: ~${Math.round(e)} a wave, ~${Math.round(e * Math.max(1, s.ticks))} all waves (${(100 * e * Math.max(1, s.ticks) / f.maxHp).toFixed(0)}% of Max HP)`);
}
const items = loadout({ carried: DEFAULT_CONSUMABLES, healing: false, boss: true, elixirs: f.kafraElixirs });
const s = simulate(f, m, k.kit, { iterations: 300, seed: 11, policy: priorityPolicy, options: v.profile.options, limitMs: 600000, items });
console.log(`\n300 fights: win ${(s.winRate * 100).toFixed(0)}%, kill ${s.ttk?.mean.toFixed(1)}s, lowest HP ${Math.round(s.analysis.survival!.lowestHp * 100)}%`);
console.log('taken from:'); for (const x of s.sources) console.log(`  ${x.id.padEnd(22)} landed ${x.hits.toFixed(1)}  avoided ${x.avoided.toFixed(1)}  damage ${Math.round(x.damage)}`);
console.log('dodges:', JSON.stringify(s.defenses));
console.log('actions:', s.actions.filter((a) => a.uses > 0.05).map((a) => `${a.id} ${a.uses.toFixed(1)}`).join(', '));
const one = simulate(f, m, k.kit, { iterations: 1, seed: 5, policy: priorityPolicy, options: v.profile.options, limitMs: 600000, log: true, items });
console.log('\n--- one fight ---'); console.log((one.log ?? []).filter((l) => !/swings|attack misses|drinks/.test(l)).slice(0, 70).join('\n'));
