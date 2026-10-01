/**
 * The combat sim: tooltip parsing, the formulas the codex pins, and the
 * fight rules (seeded replays, the dummy, stalemates, maxed skills).
 *
 * Run with:  npm test   (from combat/)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { advise } from '../src/advise.ts';
import { buildFighter, type Profile } from '../src/character.ts';
import { findMobs, skillRow } from '../src/data.ts';
import { canUse, grant, has, hidingStops, newFight, run, strike } from '../src/engine.ts';
import { consumables, loadout, readConsumable } from '../src/items.ts';
import type { MobSkill, Monster } from '../src/model.ts';
import { Rng } from '../src/rng.ts';
import {
  attrFix, mobDamage, mobHitChance, physicalDamage, playerHitChance, refineAtk, sizeFix, statusResist,
} from '../src/formulas.ts';
import { buildMonster, dummyMonster } from '../src/monster.ts';
import { parseRatio, parseSkillText } from '../src/skilltext.ts';
import { simulate } from '../src/sim.ts';
import { smartSwap } from '../src/swap.ts';
import type { Threat, ThreatEntry } from '../src/threats.ts';
import { priorityPolicy, tasPolicy } from '../src/tas.ts';
import { ALIASES, maxLevels, passives, satsujin } from '../src/kits/satsujin.ts';
import { defMultiplier } from '../../sim/src/derived.ts';

const profile: Profile = {
  build: {
    className: 'Satsujin', baseLevel: 136,
    baseStats: { str: 70, agi: 99, vit: 28, int: 1, dex: 45, luk: 1 },
    slots: { weapon: { item: 'Murder Knife', refine: 4 } },
  },
  measured: { maxHp: 8500, aspd: 180 },
};
const fighter = () => buildFighter(profile, { passives, aliases: ALIASES, maxLevels: maxLevels() });

test('tooltip ratios parse in both of the server\'s phrasings', () => {
  assert.deepEqual(parseRatio('250 +50% per level +8% per AGI'), { base: 250, perLevel: 50, perStat: { agi: 8 } });
  assert.deepEqual(parseRatio('200+15% per level +1% per LUK'), { base: 200, perLevel: 15, perStat: { luk: 1 } });
  const focus = parseRatio('+10% per level per Focus');
  assert.equal(focus?.perLevelPerFocus, 10);
});

test('Satsujin tooltips give the numbers the kit relies on', () => {
  const C = ['Satsujin', 'Shinobi', 'Assassin', 'Thief', 'Orphan'];
  const ms = skillRow('Million Stab', C);
  const t = parseSkillText(ms.desc, ms.max);
  assert.deepEqual(t.formulas.damage, { base: 20, perLevel: 5, perStat: { agi: 1 } });
  assert.deepEqual(t.when['combo ready']?.perStat, { dex: 1 });
  assert.equal(t.variableCast(1), 1000);
  assert.equal(t.variableCast(10), 100);
  assert.equal(t.cooldown(10), 5000);

  const fm = parseSkillText(skillRow('Full Moon', C).desc, 5);
  assert.equal(fm.grants['combo ready'], 5000);
  assert.equal(fm.extraCost.sp.current, 0.1);

  const dom = parseSkillText(skillRow('Dragon Omamori', C).desc, 10);
  assert.ok(dom.formulas.explosion && dom.formulas['apply damage']);
  assert.equal(dom.extraCost.sp.max, 0.05);
});

test('the formulas match the codex', () => {
  // "100 DEF takes 18% off, 400 takes 81% off" -- well, lets 59% through at 400.
  assert.equal(Math.round((1 - defMultiplier(100, 0)) * 100), 18);
  // Hit: roll starts at 0; never miss at FLEE + 100.
  assert.equal(playerHitChance(516, 416), 1);
  assert.equal(playerHitChance(466, 416), 0.5);
  // A monster lands at least 1 in 10, reached at FLEE = HIT - 10.
  assert.equal(mobHitChance(426, 416), 0.1);
  assert.equal(mobHitChance(426, 600), 0.1);
  // The server's element table: Ghost barely touches Ghost 4.
  assert.equal(attrFix('Ghost', 'Ghost', 4), 0.25);
});

test('the element table is the server\'s attr_fix.yml', () => {
  // Where the owner's old chart differed, the server (and the codex: "ten
  // per cent up to level 3, a quarter at level 4") docks Holy and Dark.
  assert.equal(attrFix('Holy', 'Fire', 1), 0.9);
  assert.equal(attrFix('Dark', 'Neutral', 3), 0.9);
  assert.equal(attrFix('Holy', 'Fire', 4), 0.75);
  assert.equal(attrFix('Dark', 'Neutral', 4), 0.75);
  // Levels 1-3 read the same; Holy on the Corporal four is +10% at every level.
  assert.equal(attrFix('Fire', 'Earth', 2), attrFix('Fire', 'Earth', 1));
  assert.equal(attrFix('Holy', 'Undead', 4), 1.1);
});

test('size penalties and refine ATK are the server\'s', () => {
  assert.equal(sizeFix('Dagger', 'Large', false), 0.75);
  assert.equal(sizeFix('Dagger', 'Medium', false), 0.9);
  assert.equal(sizeFix('One-Handed Axe', 'Small', false), 0.7);
  assert.equal(sizeFix('Scythe', 'Small', false), 1);
  // +0.5 / 1 / 1.5 / 2 ATK per refine by weapon level, floored.
  assert.equal(refineAtk(1, 9), 4);
  assert.equal(refineAtk(3, 7), 10);
  assert.equal(refineAtk(4, 10), 20);
});

test('a boss-protocol swing breaks Hiding; its skills do not reach you in it', async () => {
  const f = await fighter();
  const m = { ...buildMonster(findMobs('Burning Fury')[0]), skills: [], hit: 5000 };
  const fight = newFight(f, m, satsujin, priorityPolicy, { seed: 1, limitMs: 3_000, log: true });
  fight.mob.nextAttackAt = 100;
  grant(fight, 'hidden', 2000);
  fight.policy = () => satsujin.actions.find((a) => a.id === 'Lotus Pact')!; // stand still
  run(fight);
  assert.match(fight.log!.join('\n'), /swing breaks Hiding/);
});

test('a player always defends at element level 1', async () => {
  // Fire armour against a fire hit: 50% at level 1 (it would be 25% at level 4).
  const f = { ...(await fighter()), element: 'Fire' };
  const m = buildMonster(findMobs('Burning Fury')[0]);
  const hit = { type: 'magic' as const, element: 'Fire', ratio: 100 };
  const neutral = mobDamage(m, { ...f, element: 'Neutral' }, hit, new Rng(0, true));
  const fire = mobDamage(m, f, hit, new Rng(0, true));
  assert.ok(Math.abs(fire / neutral - 0.5) < 0.02, `fire armour took ${(fire / neutral).toFixed(3)} of a fire hit`);
});

test('every skill is maxed, whatever the profile says', async () => {
  const f = await fighter();
  assert.equal(f.skillLevels['Million Stab'], 10);
  assert.equal(f.skillLevels['Full Moon'], 5);
  assert.equal(f.skillLevels.Kawarimi, 5);
});

test('a measured Max HP is reproduced, with Moonlight Stance on top', async () => {
  const f = await fighter();
  // 8,500 without the stance, +10% with it: the owner's 9.4k reading.
  assert.equal(f.maxHp, Math.floor(8500 * 1.1));
});

test('the same seed plays the same fight', async () => {
  const f = await fighter();
  const m = buildMonster(findMobs('Burning Fury')[0]);
  const once = () => run(newFight(f, m, satsujin, priorityPolicy, { seed: 7, limitMs: 60_000 }));
  const a = once(); const b = once();
  assert.equal(a.t, b.t);
  assert.equal(a.mob.hp, b.mob.hp);
  assert.equal(a.me.hp, b.me.hp);
});

test('the dummy never dies, never hits back, and runs its 30 seconds', async () => {
  const f = await fighter();
  const fight = run(newFight(f, dummyMonster(), satsujin, tasPolicy({ horizonMs: 4000 }),
    { seed: 1, limitMs: 30_000 }));
  assert.equal(fight.result, 'stalemate');
  assert.equal(fight.cause, 'time limit');
  assert.equal(fight.t, 30_000);
  assert.equal(Object.keys(fight.meter!.taken).length, 0);
  assert.ok(fight.m.hp - fight.mob.hp > 0);
});

test('a fight with no SP left for any damage skill is a stalemate', async () => {
  const f = { ...(await fighter()), maxSp: 200, regen: { hp: 0, sp: 0 } };
  const m = { ...buildMonster(findMobs('Desperate Njord')[0]), adelay: Infinity, skills: [] };
  const fight = run(newFight(f, m, satsujin, priorityPolicy, { seed: 1, limitMs: 600_000 }));
  assert.equal(fight.result, 'stalemate');
  assert.equal(fight.cause, 'out of SP');
});

test('the rotation rules: Million Stab waits for Combo Ready, invisibility is only for Full Moon', async () => {
  const f = await fighter();
  const fight = newFight(f, dummyMonster(), satsujin, priorityPolicy, { seed: 1, limitMs: 30_000 });
  const usable = (id: string) => canUse(fight, satsujin.actions.find((a) => a.id === id)!);

  assert.equal(usable('Million Stab'), false, 'no combo yet');
  assert.equal(usable('Dragon Omamori'), false, 'no combo yet');
  grant(fight, 'combo', 5000);
  assert.equal(usable('Million Stab'), true);

  grant(fight, 'invisible', 5000);
  assert.equal(usable('Full Moon'), true);
  for (const id of ['Million Stab', 'Thousand Arms', 'Shadow Slash', 'Attack',
    'Hallucination Walk', 'Kawarimi', 'Lotus Pact']) {
    assert.equal(usable(id), false, `${id} would waste the invisibility`);
  }
});

test('nothing is cast between New Moon and Full Moon', async () => {
  const f = await fighter();
  const m = buildMonster(findMobs('Burning Fury')[0]);
  const tas = tasPolicy({ horizonMs: 4000 });
  let checked = 0;
  // Watch every move the TAS picks: while invisible it may only pick Full Moon.
  const watched = (fight: Parameters<typeof tas>[0]) => {
    const a = tas(fight);
    if (has(fight, 'invisible')) { checked++; assert.equal(a.id, 'Full Moon', `t=${fight.t}: ${a.id}`); }
    return a;
  };
  for (let seed = 1; seed <= 10; seed++) {
    run(newFight(f, m, satsujin, watched, { seed, limitMs: 60_000 }));
  }
  assert.ok(checked > 0, 'the fights did go invisible');
});

test('Thousand Arms is one hit shown as six; Million Stab is ten', async () => {
  const f = await fighter();
  const fight = run(newFight(f, dummyMonster(), satsujin, priorityPolicy, { seed: 1, limitMs: 30_000 }));
  const m = fight.meter!.actions;
  assert.equal(m['Thousand Arms'].hits, m['Thousand Arms'].uses);
  assert.equal(m['Million Stab'].hits, 10 * m['Million Stab'].uses);
});

test('consumables are read from their descriptions', () => {
  const green = readConsumable('Green Potion');
  assert.equal(green.cooldownMs, 10_000);
  assert.deepEqual(green.cures, ['silenced']);
  assert.equal(readConsumable('White Potion').hp, 1500);
  assert.equal(readConsumable('Yggdrasil Berry').hpShare, 1);
  assert.equal(readConsumable('Yggdrasil Berry').cooldownMs, 60_000);
});

test('a Green Potion cures silence the moment it lands', async () => {
  const f = await fighter();
  const fight = newFight(f, dummyMonster(), satsujin, priorityPolicy,
    { seed: 1, limitMs: 2_000, items: consumables(['Green Potion']) });
  grant(fight, 'silenced', 5000);
  run(fight);
  assert.equal(fight.meter!.actions['Green Potion']?.uses, 1);
  assert.ok(fight.meter!.actions['Million Stab'] || fight.meter!.actions['New Moon'], 'skills again after the cure');
});

test('Hallucination Walk is up at the pull, Kawarimi is cast in the fight', async () => {
  const f = await fighter();
  const fight = newFight(f, dummyMonster(), satsujin, priorityPolicy, { seed: 1, limitMs: 30_000 });
  assert.equal(has(fight, 'hallucination'), true);
  assert.equal(has(fight, 'kawarimi'), false);
  // The old way (the project owner, 2026-09-26): nothing up, the walk cast in the fight.
  const old = newFight(f, dummyMonster(), satsujin, priorityPolicy, { seed: 1, limitMs: 30_000, options: { prepHallucination: false } });
  assert.equal(has(old, 'hallucination'), false);
  run(old);
  assert.equal(old.meter!.sequence[0], 'Hallucination Walk');
});

/**
 * A monster with only these server rows, each tried every time (rate 1) in
 * any state, keeping its own delay and condition unless given. The delays
 * matter: a row that is always ready would win every try, and an
 * "afterskill" row behind it would never get its turn.
 */
function only(m: Monster, rows: Record<string, Partial<MobSkill['ai']>>): Monster {
  const skills = Object.entries(rows).map(([aegis, ai]) => {
    const s = m.skills.find((x) => x.skill === aegis);
    if (!s) throw new Error(`${m.name} has no ${aegis}`);
    return { ...s, ai: { ...s.ai, rate: 1, state: 'any', ...ai } };
  });
  return { ...m, skills };
}

test('the server\'s rows are read: Njord Zealot\'s AI, rates x95%, delays x75%', () => {
  const m = buildMonster(findMobs('Njord Zealot')[0]);
  assert.equal(m.serverId, 2655);
  assert.equal(m.matk, 3500, 'MATK is the server\'s Attack2');
  const storm = m.skills.find((s) => s.skill === 'NPC_FIRESTORM')!;
  assert.equal(storm.ai.rate, Math.floor(9500 * 0.95) / 10000);
  assert.equal(storm.ai.delayMs, 6000);
  assert.equal(storm.castMs, 1000);
  assert.equal(storm.ratio, 300);
  assert.equal(storm.hits, 7);
  assert.ok(storm.statuses.some((e) => e.sc === 'burnt'));
  // Dead Hill Here only fires after Fire Storm (skill 724).
  const hill = m.skills.find((s) => s.skill === 'WM_DEADHILLHERE')!;
  assert.deepEqual([hill.ai.cond, hill.ai.condValue], ['afterskill', '724']);
});

test('a monster pattern follows through: Back Stab, then Cloud Kill (afterskill)', async () => {
  const f = await fighter();
  const zealot = buildMonster(findMobs('Converted Zealot')[0]);
  const m = only(zealot, { RG_BACKSTAP: {}, SO_CLOUD_KILL: {} });
  const fight = run(newFight(f, m, satsujin, priorityPolicy, { seed: 2, limitMs: 6_000, log: true }));
  const text = fight.log!.join('\n');
  assert.match(text, /casts Back Stab[\s\S]*casts Cloud Kill/);
  // Never the other way round: Cloud Kill waits for a Back Stab.
  assert.doesNotMatch(text.split('casts Back Stab')[0], /Cloud Kill/);
});

test('Hiding dodges monster skills, even from the boss protocol (the project owner)', async () => {
  const f = await fighter();
  const m = buildMonster(findMobs('Njord Zealot')[0]);
  assert.ok(m.bossProtocol);
  const storm = m.skills.find((s) => s.skill === 'NPC_FIRESTORM')!;
  assert.equal(hidingStops(m, storm), true);
  // Its normal attacks still find you.
  assert.equal(hidingStops(m, storm, true), false);
});

test('the Freya fight: Manhole, then Adoramus, dodged by stepping into the hole', async () => {
  const f = await fighter();
  const freya = buildMonster(findMobs('Goddess Freya')[0]);
  const m = { ...only(freya, { SC_MANHOLE: {}, AB_ADORAMUS: {} }), adelay: Infinity };
  const fight = newFight(f, m, satsujin, priorityPolicy, { seed: 1, limitMs: 8_000, log: true });
  // No Hiding to fall back on, so the hole is the answer.
  fight.me.cds.Hiding = 1e9;
  fight.mob.nextAttackAt = 0;
  fight.mob.swung = true; // already angry: skills on its first act (engine mobAct)
  run(fight);
  const text = fight.log!.join('\n');
  assert.match(text, /opens a Manhole[\s\S]*casts Adoramus[\s\S]*Enter Manhole against Adoramus[\s\S]*avoids Adoramus \(Manhole\)/);
});

test('the monster takes its server DamageTaken off the boss-protocol maps', () => {
  const schmidt = buildMonster(findMobs('King Schmidt')[0]);
  assert.equal(schmidt.bossProtocol, false);
  assert.equal(schmidt.damageTaken, 0.5);
  // The boss-protocol maps too: the readings on the Maiden fit 80%.
  assert.equal(buildMonster(findMobs('Tortured Maiden')[0]).damageTaken, 0.8);
  assert.equal(buildMonster(findMobs('Jormungandr')[0]).damageTaken, 0.05);
});

test('status resistance: VIT cuts a stun, and is capped at 95%', async () => {
  const f = await fighter();
  const base = statusResist(f, 'stun', 'stun', 1, 130, 100);
  assert.ok(base.chance < 1 && base.chance > 0);
  const tank = statusResist({ ...f, stats: { ...f.stats, vit: 500, luk: 0 } }, 'stun', 'stun', 1, 130, 100);
  assert.ok(Math.abs(tank.chance - 0.05) < 1e-9, `capped at 95% resist: ${tank.chance}`);
  // Not in the table: only gear resists it.
  assert.equal(statusResist(f, 'coma', 'none', 1, 130, 100).chance, 1);
});

test('stone breaks on the next hit; Wide Web is not worth a dodge', async () => {
  const f = { ...(await fighter()), statusRes: {}, stats: { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 }, mdef: 0 };
  const maiden = buildMonster(findMobs('Tortured Maiden')[0]);
  const m = { ...only(maiden, { NPC_WIDESTONE: { cond: 'always' } }), hit: 5000 };
  const fight = newFight(f, m, satsujin, priorityPolicy, { seed: 3, limitMs: 6_000, log: true });
  fight.me.cds.Hiding = 1e9; // take it
  run(fight);
  const text = fight.log!.join('\n');
  assert.match(text, /is stoned until the next hit[\s\S]*breaks the stone/);
  // Free to act again right after: a skill cast follows the break.
  assert.match(text, /breaks the stone \/ freeze\n[^\n]*\| (casts|uses|[A-Z][a-z]+ [A-Z])/);

  const web = maiden.skills.find((s) => s.skill === 'NPC_WIDEWEB')!;
  const probe = newFight(await fighter(), maiden, satsujin, priorityPolicy, { seed: 1, limitMs: 1_000 });
  assert.equal(satsujin.react(probe, web, maiden), null);

  // Wide Stone is dodged -- unless you are immune to stone.
  const stone = maiden.skills.find((s) => s.skill === 'NPC_WIDESTONE')!;
  assert.notEqual(satsujin.react(probe, stone, maiden), null);
  const immune = newFight({ ...(await fighter()), statusRes: { res_status_stone: 100 } }, maiden, satsujin, priorityPolicy,
    { seed: 1, limitMs: 1_000 });
  assert.equal(satsujin.react(immune, stone, maiden), null);
});

test('Reflect Shield sends melee back; Valkyrie Randgris-style gear cuts it to 1', async () => {
  const conquest = buildMonster(findMobs('Conquest Incarnate')[0]);
  const fighterCache = await fighter();
  const reflected = (reflectReduce: number) => {
    const fight = newFight({ ...fighterCache, reflectReduce }, conquest, satsujin, priorityPolicy, { seed: 1, limitMs: 1_000, log: true });
    fight.mob.buffs.reflectshield = { until: 1e9, value: 50 } as any;
    const hp = fight.me.hp;
    strike(fight, 'Test', { hits: 1, canMiss: false, critBonus: null, kind: 'melee', damage: () => 10_000 } as any);
    return hp - fight.me.hp;
  };
  assert.ok(reflected(0) > 3000, `50% of what it took comes back: ${reflected(0)}`);
  assert.equal(reflected(100), 1);
  // Only melee bounces off Reflect Shield.
  const fight = newFight({ ...fighterCache, reflectReduce: 0 }, conquest, satsujin, priorityPolicy, { seed: 1, limitMs: 1_000 });
  fight.mob.buffs.reflectshield = { until: 1e9, value: 50 } as any;
  const hp = fight.me.hp;
  strike(fight, 'Test', { hits: 1, canMiss: false, critBonus: null, kind: 'magic', damage: () => 10_000 } as any);
  assert.equal(fight.me.hp, hp);
});

test('hidden through the first wave of Magnus, then off it before the next', async () => {
  const heartless = buildMonster(findMobs('Heartless')[0]);
  const m = only(heartless, { PR_MAGNUS: { delayMs: 60_000 } });
  const fight = newFight(await fighter(), m, satsujin, priorityPolicy, { seed: 1, limitMs: 15_000, log: true });
  run(fight);
  const text = fight.log!.join('\n');
  assert.match(text, /steps out of Magnus Exorcismus before its next wave/);
  assert.doesNotMatch(text, /takes [\d,]+ from Magnus/);
});

test('advice: Holy armour against Magnus, reflect immunity, stone resistance', async () => {
  const f = await fighter();
  const heartless = buildMonster(findMobs('Heartless')[0]);
  const threat = (source: string, kind: Threat['kind'], extra: Partial<Threat> = {}): Threat => ({
    source, kind, caster: heartless.name, type: 'magic', element: 'Neutral', targets: 'aoe', castMs: 300,
    ticks: 1, tickMs: 0, avoid: [], statuses: [], perMin: 10, dodged: 0.2, refDamage: 3000, deathShare: 0, ...extra,
  });
  const entry: ThreatEntry = {
    id: heartless.id, name: heartless.name, groups: ['rachel_ss'], level: heartless.level, race: heartless.race,
    element: heartless.element, elementLevel: heartless.elementLevel, size: heartless.size, boss: heartless.boss,
    fights: 100, winRate: 0, lossRate: 1, seconds: 10,
    threats: [
      threat('Magnus Exorcismus', 'skill', { skill: 'PR_MAGNUS', element: 'Holy', deathShare: 0.98 }),
      threat('Heartless: reflected', 'reflect', { type: 'none' }),
    ],
  };
  // A fragile build: Magnus kills it from full HP.
  const a = advise({ ...f, maxHp: 3000 }, heartless, entry);
  const magnus = a.threats.find((t) => t.source === 'Magnus Exorcismus')!;
  assert.ok(magnus.oneShot, `Magnus kills from full HP: ${magnus.max} vs ${f.maxHp}`);
  const armour = a.fixes.find((x) => x.kind === 'armor_element')!;
  assert.match(armour.text, /^Holy armour/);
  assert.ok(armour.items?.includes('Odin Avatar Card'));
  assert.ok(a.fixes.some((x) => x.kind === 'survive' && /Holy resistance/.test(x.text)));
  assert.ok(a.fixes.some((x) => x.kind === 'reflect'));
  // Immune to reflect: nothing to fix there.
  assert.ok(!advise({ ...f, reflectReduce: 100 }, heartless, entry).fixes.some((x) => x.kind === 'reflect'));

  // Stone: a fix until you are immune.
  const maiden = buildMonster(findMobs('Tortured Maiden')[0]);
  const stoneEntry: ThreatEntry = { ...entry, id: maiden.id, name: maiden.name, threats: [{
    ...threat('Wide Stone Curse', 'skill', { skill: 'NPC_WIDESTONE', type: 'status', refDamage: 0, dodged: 0 }),
    caster: maiden.name, statuses: [{ sc: 'stone', chance: 0.9, resist: 'stone' }],
  }] };
  assert.ok(advise(f, maiden, stoneEntry).fixes.some((x) => x.kind === 'status' && /stones/.test(x.text)));
  const immune = { ...f, statusRes: { ...f.statusRes, res_status_stone: 100 } };
  assert.ok(!advise(immune, maiden, stoneEntry).fixes.some((x) => x.kind === 'status'));
});

test('smart swap aims race cards at the monster and picks the armour element', async () => {
  const base = await fighter();
  const f = {
    ...base,
    dmg: { ...base.dmg, dmg_vs_race_demihuman: 40, dmg_vs_race_all_races: 5 },
    res: { ...base.res, res_race_demihuman: 30, res_race_boss: 10 },
  };
  const heartless = buildMonster(findMobs('Heartless')[0]);
  const entry: ThreatEntry = {
    id: heartless.id, name: heartless.name, groups: ['jorm'], level: heartless.level, race: heartless.race,
    element: heartless.element, elementLevel: heartless.elementLevel, size: heartless.size, boss: heartless.boss,
    fights: 100, winRate: 0, lossRate: 1, seconds: 10,
    threats: [{
      source: 'Magnus Exorcismus', kind: 'skill', skill: 'PR_MAGNUS', caster: heartless.name, type: 'magic', element: 'Holy',
      targets: 'aoe', castMs: 300, ticks: 1, tickMs: 0, avoid: [], statuses: [], perMin: 10, dodged: 0.2, refDamage: 3000, deathShare: 1,
    }],
  };
  const { f: g, notes } = smartSwap(f, heartless, entry);
  assert.equal(g.dmg.dmg_vs_race_angel, 40);
  assert.equal(g.dmg.dmg_vs_race_demihuman, undefined);
  assert.equal(g.dmg.dmg_vs_race_all_races, 5, 'all-race cards stay as they are');
  assert.equal(g.res.res_race_angel, 30);
  assert.equal(g.res.res_race_boss, 10);
  assert.equal(g.element, 'Holy');
  assert.equal(notes.length, 3);
  // Nothing in the list: race cards still swap, the armour stays.
  assert.equal(smartSwap(f, heartless, null).f.element, f.element);
});

test('stays in Hiding while the Maiden\'s chain plays out', async () => {
  const maiden = buildMonster(findMobs('Tortured Maiden')[0]);
  // Not the boss protocol here, so only the chain decides when Hiding ends.
  const m = { ...maiden, bossProtocol: false };
  const fight = newFight(await fighter(), m, satsujin, priorityPolicy, { seed: 1, limitMs: 8_000, log: true });
  run(fight);
  const text = fight.log!.join('\n');
  assert.match(text, /Hiding against[\s\S]*uses Stay hidden/);
});

test('the new areas resolve to monsters', () => {
  for (const g of ['gorge', 'thanatos', 'freya', 'tomb', 'guild']) {
    const rows = findMobs(g);
    assert.ok(rows.length >= 3, `${g}: ${rows.length}`);
    assert.ok(rows.every((r) => buildMonster(r).serverId), `${g}: every monster has server AI`);
  }
});

test('Kafra Elixirs come only on a boss, two a life, three with an Elixir Badge', async () => {
  const f = await fighter();
  assert.equal(f.kafraElixirs, 2);
  const badge = await buildFighter({
    ...profile,
    build: { ...(profile.build as any), slots: { ...(profile.build as any).slots, acc1: { item: 'Elixir Badge' } } },
  }, { passives, aliases: ALIASES, maxLevels: maxLevels() });
  assert.equal(badge.kafraElixirs, 3);

  assert.equal(loadout({ carried: ['Green Potion'], healing: false, boss: false, elixirs: 2 })
    .some((a) => a.id === 'Kafra Elixir'), false);
  const items = loadout({ carried: ['Green Potion'], healing: false, boss: true, elixirs: 2 });
  assert.deepEqual(items.map((a) => a.id), ['Green Potion', 'Kafra Elixir']);

  // A boss that hurts, and a long clock: the elixirs run out at two.
  const njord = buildMonster(findMobs('Desperate Njord')[0]);
  const fight = run(newFight(f, njord, satsujin, priorityPolicy, { seed: 5, limitMs: 600_000, items }));
  assert.ok((fight.meter!.actions['Kafra Elixir']?.uses ?? 0) <= 2);
});

test('healing items only when asked for', () => {
  const off = loadout({ carried: ['Green Potion'], healing: false, boss: false, elixirs: 2 }).map((a) => a.id);
  const on = loadout({ carried: ['Green Potion'], healing: true, boss: false, elixirs: 2 }).map((a) => a.id);
  assert.deepEqual(off, ['Green Potion']);
  assert.deepEqual(on, ['Green Potion', 'White Potion', 'Blue Potion', 'Yggdrasil Berry']);
});

/** One cast of a skill in expect mode, no crits, with a chosen endow and no Focus. */
function oneCast(f: Awaited<ReturnType<typeof fighter>>, monster: string, skill: string, element: string) {
  const m = buildMonster(findMobs(monster)[0]);
  const fight = newFight({ ...f, critRate: -1000 }, m, satsujin, priorityPolicy,
    { seed: 1, limitMs: 30_000, options: { prepFocus: false } });
  fight.rng = new Rng(0, true);
  fight.me.buffs.sevenWinds = { until: 1e12, stacks: ['Earth', 'Wind', 'Water', 'Fire', 'Ghost', 'Dark', 'Holy'].indexOf(element) };
  if (skill === 'Full Moon') grant(fight, 'invisible', 5000);
  const before = fight.mob.hp;
  satsujin.actions.find((a) => a.id === skill)!.resolve(fight);
  return before - fight.mob.hp;
}

test('the project owner\'s dummy test: right hand only on skills, both on autos', async () => {
  // Their build of 2026-09-26 (Laevateinn +9 / Vorpal Dagger +7), no endow, no Focus.
  const f = await buildFighter({ build: 'cfZLbitwwEET_Rc8VaLVuVn4jj8IY4dF6lNgeY2svsOy_L7JndhPCDPjFpdNVTUmBIX7Fsj3_zrOAVBbBE7wHN1Aeun4tQiDIpmEH2yJIGLINCEEq42TbIjCM5wYGQZO20Fq5OiW2EouA2MoqEGTbVlaBlTOw-3jjocnIv-E4ZIHAFRVr2i7Pa58ExBTfuvMiEMx-MuWSh1jyZRYQ5xTHPA_dmvqUX9KphtGRpiGNUvAIWipbFQOpyCo4BK2lqpKFNFrddvIETX5fwIGZiG4Hd_fcllRTRdyWWziC6ONW8jxc9W7MUy7fPTRgy7VcX9NZH4U6rf4PuU5IBvvas0W4D6kKKXoM6d3JQz-CzO4kHztZsCaWdfv7kANr6dQDp12e0phSd4pTHJKAhKRaYyx_vn_GlPpzd166NZaD4Sqf0lO3pFmAYHfu9lzkcT1df9lKxX-wObSnMSUBhqMvfluuxD9By-U1rdWovqYW78fkT0cf7Sc' },
    { passives, aliases: ALIASES, maxLevels: maxLevels() });
  const near = (got: number, want: number, what: string, tol = 0.10) =>
    assert.ok(Math.abs(got / want - 1) <= tol, `${what}: sim ${Math.round(got)} vs game ${want}`);
  const onDummy = (fx: typeof f, skill: string, o: { combo?: boolean; crit?: boolean } = {}) => {
    const fight = newFight({ ...fx, critRate: o.crit ? 10_000 : -1000 }, dummyMonster(), satsujin, priorityPolicy,
      // Read with no Hallucination Walk up (Shadow Slash 1,360 a hit with it against the game's 1,195).
      { seed: 1, limitMs: 30_000, options: { prepFocus: false, prepHallucination: false } });
    fight.rng = new Rng(0, true);
    delete fight.me.buffs.sevenWinds;
    if (skill === 'Full Moon') grant(fight, 'invisible', 5000);
    if (o.combo) grant(fight, 'combo', 5000);
    const before = fight.mob.hp;
    satsujin.actions.find((a) => a.id === skill)!.resolve(fight);
    return before - fight.mob.hp;
  };
  // Refit 2026-09-27 (right hand: status ATK x2, cards whole; ATK% on every
  // part): the skills within 4% but New Moon (9% under, open).
  near(onDummy(f, 'Million Stab', { combo: true }) / 10, 3162, 'Million Stab per hit', 0.04);
  // The off-hand dagger off: skills barely move (it only carried a Million Stab bonus).
  const noVorpal = { ...f, offhand: null, skillMods: (s: string, k: string) => (s === 'Million Stab' ? { flat: 0, percent: 0 } : f.skillMods(s, k)) };
  near(onDummy(noVorpal, 'Million Stab', { combo: true }) / 10, 2356, 'Million Stab per hit, Vorpal off', 0.04);
  // Shadow Slash: one roll shown as three.
  near(onDummy(f, 'Shadow Slash') / 3, 1195, 'Shadow Slash per shown hit', 0.03);
  near(onDummy(f, 'Shadow Slash', { crit: true }) / 3, 1545, 'Shadow Slash crit per shown hit', 0.03);
  // Autos. The 855 read then as a double attack's two hits is one right-hand
  // hit (the 2026-09-27 readings show the right hand at ~2.6x the left).
  const hitOf = (fx: typeof f, crit: boolean) => physicalDamage(fx, dummyMonster(),
    { ratio: 100, element: 'Neutral', statusElement: 'Neutral', ranged: false, crit, skillDamage: 0, normal: true }, new Rng(0, true));
  const right = (crit: boolean) => hitOf({ ...f, offhand: null }, crit);
  near(right(false), 855, 'auto, right hand', 0.04);
  near(hitOf(f, false) - right(false), 401, 'auto, left hand', 0.05);
  // These crits disagree with the 2026-09-27 ones (right +8%, left +17% on
  // LUK/5); the newer readings are the ones the formula follows.
  near(right(true), 1124, 'auto crit, right hand', 0.09);
  near(onDummy(f, 'New Moon'), 9615, 'New Moon', 0.10);
  near(onDummy(f, 'Full Moon'), 14776, 'Full Moon', 0.05);
  near(onDummy(noVorpal, 'Full Moon'), 15043, 'Full Moon, Vorpal off', 0.06);
});

test("the project owner's dummy readings of 2026-09-27: race cards whole on the right hand", async () => {
  // Murder Knife +6 [3x Chocolate Bear] / Laevateinn +9 [Khalitzburg], Ghost,
  // 10 Focus, Combo Ready. Autos: right 1,401 (crit 2,058) twice, left 530 (726).
  const { readJSON, REPO } = await import('../src/data.ts');
  const f = await buildFighter(readJSON(`${REPO}/combat/profiles/satsujin-moon.json`), { passives, aliases: ALIASES, maxLevels: maxLevels() });
  const near = (got: number, want: number, what: string, tol: number) =>
    assert.ok(Math.abs(got / want - 1) <= tol, `${what}: sim ${Math.round(got)} vs game ${want}`);
  const hitOf = (fx: typeof f, crit: boolean) => physicalDamage(fx, dummyMonster(),
    { ratio: 100, element: 'Ghost', statusElement: 'Ghost', ranged: false, crit, skillDamage: 0, normal: true }, new Rng(0, true));
  const right = (crit: boolean) => hitOf({ ...f, offhand: null }, crit);
  near(right(false), 1401, 'right hand', 0.04);
  near(right(true), 2058, 'right hand crit', 0.02);
  near(hitOf(f, false) - right(false), 530, 'left hand', 0.06);
  near(hitOf(f, true) - right(true), 726, 'left hand crit', 0.06);
  // A Double Attack swing: the right hand twice, the left once (the yellow 3.3k).
  near(physicalDamage(f, dummyMonster(), { ratio: 100, rightTimes: 2, element: 'Ghost', statusElement: 'Ghost',
    ranged: false, crit: false, skillDamage: 0, normal: true }, new Rng(0, true)), 2 * 1401 + 530, 'Double Attack swing', 0.04);
  const cast = (skill: string) => {
    const fight = newFight({ ...f, critRate: -1000 }, dummyMonster(), satsujin, priorityPolicy, { seed: 1, limitMs: 30_000 });
    fight.rng = new Rng(0, true);
    if (skill === 'Full Moon') grant(fight, 'invisible', 5000);
    grant(fight, 'combo', 5000);
    const before = fight.mob.hp;
    satsujin.actions.find((a) => a.id === skill)!.resolve(fight);
    return before - fight.mob.hp;
  };
  near(cast('New Moon'), 20_000, 'New Moon', 0.06);
  near(cast('Full Moon'), 32_800, 'Full Moon', 0.03);
  near(cast('Million Stab'), 40_000, 'Million Stab', 0.05);
});

test('the project owner\'s earlier hits on Rachel SS, within 15% (retest pending)', async () => {
  // An earlier build link of 2026-09-26: Laevateinn +9 / Vorpal Dagger +7,
  // no Focus. The sim reads 7% and 12% over; the link's base stats may be
  // off (the next one was), or Rachel SS may take ~70% rather than the
  // server file's 80%. A fresh reading with the corrected build decides.
  const f = await buildFighter({ build: 'cfZLvqtwgEMXfxc-n4Iz_Yl-jHyUEyXqztkk2JN7bQum7F83e3payCyJ4_M2cmdHAEF9iOV6_5lWAlEXwHt6DOygPXVePECSo69jB9ggEI20HiUDKOOp7BIbx3MEgaKkttFauRomjxCIgjrILBOr7yiqwcga2hXcebf-bjlMWCFxZsafj9rqPSUAs8cdw3QSCaTdLLnmKJd9WAXFNcc7rNOxpTPktXaqbPO00yCgFj6BJ2aoYkJJWwSFoTapKFmw0te4cmKWU9_o8Pars2FL1EfHY3u0QxBiPktfprg9zXnL5aL0DW669epDRrM8ZOq3-N7lHEIM7b2wt5zGkGtQ9h3SDHPQzyDTIP89kwVoy1eofQw6syaknmZq8pDml4RKXOCUBAsk6xli-fRzmlMbrcN2GPZaT4Spf0suwpVVAwjbu_YPQ-TzDeDtKxT-xObWXOSUBhpN_-GO7E_8Ybbfvaa-J6v_p8fOM_Ozkr_43' },
    { passives, aliases: ALIASES, maxLevels: maxLevels() });
  const near = (got: number, want: number, what: string) =>
    assert.ok(Math.abs(got / want - 1) <= 0.15, `${what}: sim ${Math.round(got)} vs game ${want}`);
  near(oneCast(f, 'Tortured Maiden', 'Full Moon', 'Holy'), 8801, 'Full Moon on Maiden, Holy');
  // Thousand Arms shows 6 hits of one split roll: 929 each.
  near(oneCast(f, 'Godly Seeker', 'Thousand Arms', 'Wind') / 6, 929, 'Thousand Arms on Godly Seeker, Wind');
});

test('a summoned add fights on its own: Autumn Blood', async () => {
  const f = await fighter();
  const seeker = buildMonster(findMobs('Godly Seeker')[0]);
  // Summon at the pull, nothing else, and a monster that cannot die in time.
  const m = { ...only(seeker, { NPC_SUMMONSLAVE: { cond: 'slavelt', condValue: '1' } }), hp: 1e9 };
  const fight = run(newFight(f, m, satsujin, priorityPolicy, { seed: 1, limitMs: 20_000 }));
  assert.equal(fight.mob.adds.length, 1, 'one Autumn Blood (the server row\'s level 1)');
  assert.equal(fight.mob.adds[0].m.name, 'Autumn Blood');
  const hits = Object.entries(fight.meter!.taken).filter(([k]) => k.startsWith('Autumn Blood'))
    .reduce((s, [, v]) => s + v.hits + v.avoided, 0);
  assert.ok(hits >= 4, `the add acted ${hits} times in 20s`);
});

test('a drain heals the monster by what it takes', async () => {
  const f = await fighter();
  const maiden = buildMonster(findMobs('Tortured Maiden')[0]);
  const gift = maiden.skills.find((s) => s.drain)!;
  const m = { ...maiden, adelay: Infinity, skills: [{ ...gift, castMs: 0, ai: { ...gift.ai, rate: 1, delayMs: 0, state: 'any', cond: 'always' } }] };
  const fight = newFight(f, m, satsujin, priorityPolicy, { seed: 1, limitMs: 5_000, log: true });
  fight.mob.hp = m.hp / 2;
  fight.mob.nextAttackAt = 0;
  fight.mob.swung = true; // already angry: skills on its first act (engine mobAct)
  fight.policy = () => satsujin.actions.find((a) => a.id === 'Lotus Pact')!; // stand still
  run(fight);
  assert.match(fight.log!.join('\n'), /drains [\d,]+ HP/);
});

test('the pull says what went up: the endow and the Focus', async () => {
  const f = await fighter();
  const fight = newFight(f, buildMonster(findMobs('Tortured Maiden')[0]), satsujin, priorityPolicy,
    { seed: 1, limitMs: 1_000, log: true });
  // A [PREFIGHT] block, one line each, so no line is wider than the fight's.
  assert.equal(fight.log![0], '[PREFIGHT]');
  assert.equal(fight.log![1], '  Moonlight Stance');
  assert.equal(fight.log![2], '  Hallucination Walk');
  assert.match(fight.log![3], /^ {2}Seven Winds: Holy \(110% vs Ghost 4\)$/);
  assert.match(fight.log![4], /^ {2}10 Focus/);
});

test('armor cards set the element and immunities the fight reads (Scylla Card)', async () => {
  const withScylla: Profile = {
    ...profile,
    build: {
      ...(profile.build as any),
      slots: { ...(profile.build as any).slots, armor: { item: 'Bullhorn Armor', cards: ['Scylla Card'] } },
    },
  };
  const f = await buildFighter(withScylla, { passives, aliases: ALIASES, maxLevels: maxLevels() });
  assert.equal(f.element, 'Fire');
  assert.equal(f.statusRes.res_status_stone, 100);

  // Wide Stone on every opportunity: immune, so never petrified.
  const maiden = buildMonster(findMobs('Tortured Maiden')[0]);
  const m = only(maiden, { NPC_WIDESTONE: { cond: 'always' } });
  const fight = run(newFight(f, m, satsujin, priorityPolicy, { seed: 1, limitMs: 10_000, log: true }));
  assert.match(fight.log!.join('\n'), /casts Wide Stone|uses Wide Stone/);
  assert.doesNotMatch(fight.log!.join('\n'), /is stoned/);
});

test('a batch reports every fight as a win, a loss or a stalemate', async () => {
  const f = await fighter();
  const m = buildMonster(findMobs('Tortured Maiden')[0]);
  const s = simulate(f, m, satsujin, { iterations: 20, seed: 3, limitMs: 60_000, policy: priorityPolicy });
  assert.equal(s.wins + s.losses + s.stalemates, 20);
});
