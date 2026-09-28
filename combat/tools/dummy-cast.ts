/**
 * One cast of each skill on the training dummy, expected damage, under the
 * conditions a reading was taken in: Focus stacks, Combo Ready, Seven Winds.
 * No crits. What the gem's damage over time would tick for is printed too.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/dummy-cast.ts <profile.json> \
 *     [--skills "New Moon,Full Moon,Dragon Omamori"] [--focus 0,10] [--element Ghost|none] [--race Demon] [--no-gem]
 */
import { resolve } from 'node:path';

import { buildFighter, resolveBuild, type Profile } from '../src/character.ts';
import { plannerDataset, readJSON } from '../src/data.ts';
import { grant, newFight } from '../src/engine.ts';
import { DOTS, dotTick, type DotName } from '../src/formulas.ts';
import { kitFor } from '../src/kits/index.ts';
import { dummyMonster } from '../src/monster.ts';
import { Rng } from '../src/rng.ts';
import { priorityPolicy } from '../src/tas.ts';

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const profile = readJSON<Profile>(resolve(process.cwd(), argv[0]));
const build = await resolveBuild(profile.build, plannerDataset());
// --no-gem: the same build with the class gem slot emptied.
if (argv.includes('--no-gem')) profile.build = { ...build, slots: { ...build.slots, gem: { itemId: null, refine: 0, cards: [] } } };
const k = kitFor(build.className);
const f = await buildFighter(profile, { passives: k.passives, aliases: k.aliases, maxLevels: k.maxLevels() });
const skills = (one('skills') ?? 'New Moon,Full Moon,Dragon Omamori,Million Stab').split(',').map((s) => s.trim());
const focusList = (one('focus') ?? '0,10').split(',').map(Number);
const element = one('element') ?? 'Ghost';
/** The dummy's race: the in-game one seems to take any race card (Chocolate Bear's Formless, Observation's Demon). */
const race = one('race') ?? 'Formless';
const SEVEN = ['Earth', 'Wind', 'Water', 'Fire', 'Ghost', 'Dark', 'Holy'];

function cast(skill: string, focus: number, combo: boolean): number {
  const fight = newFight({ ...f, critRate: -1000 }, { ...dummyMonster(), race }, k.kit, priorityPolicy,
    { seed: 1, limitMs: 30_000, options: { ...profile.options, prepFocus: false } });
  fight.rng = new Rng(0, true);
  if (element === 'none') delete fight.me.buffs.sevenWinds;
  else fight.me.buffs.sevenWinds = { until: 1e12, stacks: SEVEN.indexOf(element) };
  for (let i = 0; i < focus; i++) fight.me.focus.push(60_000);
  if (skill === 'Full Moon') grant(fight, 'invisible', 5000);
  if (combo) grant(fight, 'combo', 5000);
  if (skill === 'Omamori Jutsu') fight.mob.debuffs.talisman = { until: 1e12, stacks: 1 };
  const before = fight.mob.hp;
  k.kit.actions.find((a) => a.id === skill)!.resolve(fight);
  return before - fight.mob.hp;
}

console.log(`${f.name}${argv.includes('--no-gem') ? ' (no gem)' : ''}: Lv ${f.level}, Seven Winds ${element}, dummy race ${race}, no crits`);
console.log(`${'skill'.padEnd(16)}${focusList.flatMap((n) => [`${n} Focus`, `${n} F +combo`]).map((s) => s.padStart(13)).join('')}`);
for (const s of skills) {
  const row = focusList.flatMap((n) => [cast(s, n, false), cast(s, n, true)]);
  console.log(`${s.padEnd(16)}${row.map((v) => Math.round(v).toLocaleString('en-US').padStart(13)).join('')}`);
}
console.log('\ndamage over time, one tick:');
for (const n of Object.keys(DOTS) as DotName[]) console.log(`  ${n.padEnd(9)} ${dotTick(f, n)} every ${DOTS[n].everyMs / 1000}s`);
