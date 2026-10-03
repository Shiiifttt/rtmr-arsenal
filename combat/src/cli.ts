/**
 * Run fights from the command line.
 *
 *   node --experimental-strip-types --import ./combat/register.mjs combat/src/cli.ts \
 *     [--profile combat/profiles/satsujin-example.json] [--build <share link>] \
 *     [--vs dummy|rachel_ss|jorm|<name>|<id>[,...]] [--iter 200] [--time 300] \
 *     [--seed 1] [--policy tas|priority] [--horizon 6000] [--log] [--json] \
 *     [--hp <max HP without stance>] [--sp <max SP>] [--aspd <ASPD>] \
 *     [--items "Green Potion,Panacea" | none] [--healing] [--stream]
 *     [--advise]   (no fights: the threat list, data/threats.json, read against the build)
 *     [--swap]     (smart swap: armour element and race cards changed for each monster, swap.ts)
 *
 * `npm run sim -- ...` from combat/ does the same.
 */
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';

import { advise, formatAdvice } from './advise.ts';
import { buildFighter, resolveBuild, type Profile } from './character.ts';
import { findMobs, plannerDataset, readJSON, REPO } from './data.ts';
import type { Monster } from './model.ts';
import { buildMonster, DUMMY_SECONDS, dummyMonster } from './monster.ts';
import { DEFAULT_CONSUMABLES, HEALING_ITEMS, loadout } from './items.ts';
import { fighterSheet, formatSummary } from './report.ts';
import { simulate } from './sim.ts';
import { priorityPolicy, tasPolicy } from './tas.ts';
import { smartSwap } from './swap.ts';
import { readThreats } from './threats.ts';
import { kitFor } from './kits/index.ts';

function args(argv: string[]) {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}


/** Each class's farm profile: what a build from a link borrows its ASPD model, consumables and (rotation) its options from. */
const CLASS_PROFILE: Record<string, { path: string; rotation: boolean }> = {
  Satsujin: { path: 'profiles/satsujin-farm-maxed-a.json', rotation: true },
  Revenant: { path: 'profiles/revenant-maxed-final.json', rotation: true },
  Kingslayer: { path: 'profiles/kingslayer-endgame-farm.json', rotation: true },
  'Night Raven': { path: 'profiles/nightraven-counter-commit.json', rotation: false },
};

async function main() {
  const a = args(process.argv.slice(2));
  const profilePath = typeof a.profile === 'string'
    ? resolve(process.cwd(), a.profile)
    : resolve(REPO, 'combat/profiles/satsujin-example.json');
  const profile = readJSON<Profile>(profilePath);
  if (typeof a.build === 'string') {
    profile.build = a.build;
    // The example profile's name and readings belong to its own build.
    profile.name = 'Build from link';
    profile.measured = {};
  }
  const reading = (key: string) => (typeof a[key] === 'string' && Number(a[key]) > 0 ? Number(a[key]) : undefined);
  profile.measured = {
    ...profile.measured,
    ...(reading('hp') ? { maxHp: reading('hp') } : {}),
    ...(reading('sp') ? { maxSp: reading('sp') } : {}),
    ...(reading('aspd') ? { aspd: reading('aspd') } : {}),
  };

  // The kit is the build's class; Satsujin for a class that has none yet.
  const buildClass = (await resolveBuild(profile.build, plannerDataset())).className;
  const k = kitFor(buildClass);
  // A build from a link fights with its own class's settings, not the example profile's -- a Night Raven
  // build used to play Satsujin's rotation order and ASPD model (2026-10-02, the build-at-a-glance window).
  if (typeof a.build === 'string' && typeof a.profile !== 'string') {
    const own = CLASS_PROFILE[buildClass ?? ''];
    const p = own ? readJSON<Profile>(resolve(REPO, 'combat', own.path)) : null;
    profile.aspdModel = p?.aspdModel;
    profile.consumables = p?.consumables ?? profile.consumables;
    // A class with one build plays that build's rotation; one with several (Night Raven), the kit's own.
    profile.options = own?.rotation ? p?.options : undefined;
    delete profile.baseLevel;
  }
  const f = await buildFighter(profile, {
    passives: k.passives, aliases: k.aliases, maxLevels: k.maxLevels(),
  });
  if (f.className !== k.kit.className) {
    f.notes.push(`build is ${f.className}; fought with the ${k.kit.className} kit`);
  }

  const targets: Monster[] = [];
  for (const q of String(a.vs ?? 'dummy').split(',')) {
    if (q.trim().toLowerCase() === 'dummy') { targets.push(dummyMonster()); continue; }
    const rows = findMobs(q);
    if (!rows.length) throw new Error(`no monster matches "${q}"`);
    targets.push(...rows.map(buildMonster));
  }

  // --swap: each monster fought with the spares that suit it.
  const list = readThreats();
  const entryOf = (m: Monster) => list?.monsters.find((e) => e.id === m.id) ?? null;
  const swap = a.swap === true || a.swap === 'true';
  const gearFor = (m: Monster) => (swap ? smartSwap(f, m, entryOf(m)) : { f, notes: [] as string[] });

  // --advise: no fights, the threat list read against this build.
  if (a.advise) {
    const out = targets.filter((m) => !m.dummy).map((m) => {
      const g = gearFor(m);
      const x = advise(g.f, m, entryOf(m));
      return { ...x, swap: g.notes };
    });
    if (a.json) { console.log(JSON.stringify({ fighter: { ...f, skillMods: undefined }, advice: out }, null, 1)); return; }
    console.log(fighterSheet(f));
    if (!list) console.log('  no threat list yet: run tools/build-threats.ts');
    else console.log(`  threat list: ${list.monsters.length} monsters, ${list.iterations} fights each with ${list.reference.name} (${list.builtAt.slice(0, 10)})\n`);
    for (const x of out) console.log(`${formatAdvice(x, f)}\n`);
    return;
  }

  // Consumables: Green Potions always (or --items "a,b" / "none", or the
  // profile's list); --healing adds the healing items; bosses add the free
  // Kafra Elixirs, a limited number a life.
  const itemNames = typeof a.items === 'string'
    ? (a.items.trim().toLowerCase() === 'none' ? [] : a.items.split(',').map((x) => x.trim()).filter(Boolean))
    : profile.consumables ?? DEFAULT_CONSUMABLES;
  const healing = a.healing === true || a.healing === 'true' || !!profile.healing;
  const itemsFor = (m: Monster) => loadout({
    carried: itemNames, healing, boss: m.boss && !m.dummy, elixirs: f.kafraElixirs,
  });

  const policyName = String(a.policy ?? 'tas');
  const policy = policyName === 'priority'
    ? priorityPolicy
    : tasPolicy({ horizonMs: Number(a.horizon ?? 6000) });

  // --stream: one JSON line to start (the fighter and who is being fought),
  // then one per monster as it finishes -- so a page can show progress.
  const stream = !!a.stream;
  // Written straight to fd 1: process.stdout is asynchronous on a pipe, and
  // the fights run synchronously, so its lines would all land at the end.
  const line = (o: unknown) => writeSync(1, `${JSON.stringify(o)}\n`);
  const fighterOut = { ...f, skillMods: undefined };
  if (stream) line({ type: 'start', fighter: fighterOut, targets: targets.map((m) => m.name) });

  const results = [];
  if (!a.json && !stream) {
    console.log(fighterSheet(f));
    console.log(`  assumed: ${f.notes.join('; ')}`);
    console.log(`  policy: ${policyName}; consumables: ${itemNames.join(', ') || 'none'}`
      + `${healing ? ` + healing (${HEALING_ITEMS.join(', ')})` : ''}`
      + `; on bosses ${f.kafraElixirs} Kafra Elixirs\n`);
  }
  for (const m of targets) {
    const gear = gearFor(m);
    const sum = simulate(gear.f, m, k.kit, {
      iterations: Number(a.iter ?? (m.dummy ? 20 : 200)),
      seed: Number(a.seed ?? 1),
      // Stalemate clock (the project owner): 1 minute, 10 on a boss, DUMMY_SECONDS on the dummy.
      limitMs: (m.dummy ? DUMMY_SECONDS : Number(a.time ?? (m.boss ? 600 : 60))) * 1000,
      policy,
      log: !!a.log,
      options: profile.options,
      items: itemsFor(m),
    });
    const result = {
      ...sum,
      target: {
        name: m.name, level: m.level, hp: m.hp, size: m.size, race: m.race,
        element: `${m.element}${m.elementLevel}`, boss: m.boss, dummy: !!m.dummy,
        def: m.def, mdef: m.mdef, notes: [...gear.notes, ...m.notes],
      },
    };
    if (stream) { line({ type: 'result', result }); continue; }
    results.push(result);
    if (a.json) continue;
    if (gear.notes.length) console.log(`   ${gear.notes.join('; ')}`);
    console.log(formatSummary(sum, m));
    if (sum.log) console.log(`\n   -- first fight --\n${sum.log.map((l) => `   ${l}`).join('\n')}`);
    console.log('');
  }
  if (stream) line({ type: 'done' });
  else if (a.json) console.log(JSON.stringify({ fighter: fighterOut, results }, null, 1));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
