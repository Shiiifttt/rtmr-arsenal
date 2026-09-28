/**
 * The damage-over-time numbers a build would put on a monster, with the
 * pieces behind them, for checking against a dummy reading.
 *
 *   node --experimental-strip-types --import ./register.mjs tools/dot-check.ts <profile.json>
 */
import { resolve } from 'node:path';

import { buildFighter, resolveBuild, type Profile } from '../src/character.ts';
import { plannerDataset, readJSON } from '../src/data.ts';
import { DOTS, dotAtk, dotLevelMult, dotMatk, dotTick, statusAtk, statusMatk, TUNE, type DotName } from '../src/formulas.ts';
import { kitFor } from '../src/kits/index.ts';

const profile = readJSON<Profile>(resolve(process.cwd(), process.argv[2]));
const k = kitFor((await resolveBuild(profile.build, plannerDataset())).className);
const f = await buildFighter(profile, { passives: k.passives, aliases: k.aliases, maxLevels: k.maxLevels() });
const s = f.stats;
console.log(`Lv ${f.level}  STR ${s.str} AGI ${s.agi} VIT ${s.vit} INT ${s.int} DEX ${s.dex} LUK ${s.luk}`);
console.log(`status ATK ${statusAtk(s, f.level)}  weapon ${f.weapon?.name} ${f.weapon?.atk} +${f.weapon?.refine}  equip ATK ${f.equipAtk}  ATK% ${f.atkPercent}`);
console.log(`status MATK ${statusMatk(s)}  weapon MATK ${f.matk.weapon}  equip MATK ${f.matk.equip}  MATK% ${f.matk.percent}`);
for (const mode of ['base', 'full', 'window'] as const) {
  TUNE.dotAtk = mode;
  console.log(`\nATK read as '${mode}': ${dotAtk(f).toFixed(0)}   MATK ${dotMatk(f).toFixed(0)}   level x${dotLevelMult(f.level).toFixed(3)}`);
  for (const n of Object.keys(DOTS) as DotName[]) {
    const d = DOTS[n];
    console.log(`  ${n.padEnd(9)} ${String(dotTick(f, n)).padStart(6)} every ${d.everyMs / 1000}s  = ${(dotTick(f, n) * 1000 / d.everyMs).toFixed(0)}/s`);
  }
}
