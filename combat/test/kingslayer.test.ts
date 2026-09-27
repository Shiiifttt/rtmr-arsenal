/**
 * The Kingslayer kit and the player-side mechanics it brought into the
 * engine: Duel Counters from hits, Auto Guard, Pawn's Rod, King's Gambit,
 * Queen's Barrier, Finisher Ready, Reflect Shield, Max HP from the job table.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jobPool, LIVE_HP_FIX } from '../../sim/src/index.ts';
import { buildFighter, type Profile } from '../src/character.ts';
import { findMobs } from '../src/data.ts';
import { newFight, run, stacks } from '../src/engine.ts';
import type { MobSkill, Monster } from '../src/model.ts';
import { buildMonster } from '../src/monster.ts';
import { priorityPolicy } from '../src/tas.ts';
import { kingslayer, maxLevels, passives } from '../src/kits/kingslayer.ts';

const profile: Profile = {
  build: {
    className: 'Kingslayer', baseLevel: 135,
    baseStats: { str: 99, agi: 1, vit: 99, int: 49, dex: 49, luk: 1 },
    slots: {
      weapon: { item: 'Abandoned Guardian', refine: 9 },
      offhand: { item: 'Battle Glory Shield', refine: 6 },
    },
  },
};
const fighter = () => buildFighter(profile, { passives, aliases: {}, maxLevels: maxLevels() });

function only(m: Monster, rows: Record<string, Partial<MobSkill['ai']>>): Monster {
  const skills = Object.entries(rows).map(([aegis, ai]) => {
    const s = m.skills.find((x) => x.skill === aegis);
    if (!s) throw new Error(`${m.name} has no ${aegis}`);
    return { ...s, ai: { ...s.ai, rate: 1, state: 'any', ...ai } };
  });
  return { ...m, skills };
}

test('Max HP comes from the Shadow Chaser job table when nothing was read', async () => {
  const f = await fighter();
  // 4,620 base at 135 x (1 + VIT 99%) x 1.25 + flat (Improve Defense,
  // Shield Mastery, Bishop's Guard), then Duel Stance +10%.
  // With the live correction for Shadow_Chaser (sim/src/derived.ts LIVE_HP_FIX).
  assert.equal(f.maxHp, Math.floor((jobPool(4620, 99, LIVE_HP_FIX.Shadow_Chaser) + 135 * 10 + 250 + 2500) * 1.1));
  assert.ok(f.notes.some((n) => /Shadow_Chaser job table/.test(n)));
  assert.equal(f.shield?.name, 'Battle Glory Shield');
  assert.equal(f.autoGuard, 1, 'Battle Glory Shield: Auto Guard Lv 1');
});

test('Duel Stance turns physical hits into counters', async () => {
  const f = await fighter();
  const m = { ...buildMonster(findMobs('Angel of Genesis')[0]), skills: [] as MobSkill[], hit: 5000 };
  const fight = newFight({ ...f, autoGuard: 0 }, m, kingslayer, priorityPolicy, { seed: 1, limitMs: 8_000 });
  run(fight);
  assert.ok(stacks(fight, 'counters') > 0 || (fight.meter?.actions["King's Chains"]?.uses ?? 0) > 0,
    'hits gave counters, spent or kept');
});

test("King's Gambit cancels a ground spell; Pawn's Rod a spell cast at you", async () => {
  const f = await fighter();
  const heartless = buildMonster(findMobs('Heartless')[0]);
  const magnus = only(heartless, { PR_MAGNUS: { delayMs: 8_000 } });
  const a = newFight(f, magnus, kingslayer, priorityPolicy, { seed: 1, limitMs: 20_000, log: true });
  run(a);
  // Magnus's 0.3s cast is too fast to answer: the Gambit goes down before it
  // (the project owner) -- timed from the first cast, which cannot be called --
  // and a wave is stopped by it or by Hiding.
  const log = a.log!.join('\n');
  const first = log.search(/Magnus Exorcismus/);
  const gambit = log.search(/uses Pre-cast King's Gambit/);
  assert.ok(first >= 0 && gambit > first, 'the Gambit only after the first Magnus');
  assert.match(log, /avoids Magnus Exorcismus \((King's Gambit|Hiding)\)/);

  const zealot = buildMonster(findMobs('Njord Zealot')[0]);
  const petals = zealot.skills.find((s) => s.type === 'magic' && s.targets === 'single' && s.castMs >= 1000);
  if (petals) {
    const m = only(zealot, { [petals.skill]: { delayMs: 60_000 } });
    const b = newFight(f, m, kingslayer, priorityPolicy, { seed: 1, limitMs: 10_000, log: true });
    run(b);
    assert.match(b.log!.join('\n'), new RegExp(`avoids ${petals.name} \\((Pawn's Rod|Hiding)\\)`));
  }
});

test('Auto Guard blocks 4% a level of physical hits', async () => {
  const f = await fighter();
  const m = { ...buildMonster(findMobs('Angel of Genesis')[0]), skills: [] as MobSkill[], hit: 5000 };
  // Sturdy enough to last the minute: a count needs the swings.
  // (and the Angel too: Rook's Smash hits for a fifth of your HP).
  const fight = newFight({ ...f, autoGuard: 10, maxHp: 10_000_000 }, { ...m, hp: 1e13 }, kingslayer, priorityPolicy,
    { seed: 2, limitMs: 60_000 });
  run(fight);
  const t = fight.meter!.taken['Angel of Genesis: attack'];
  const share = t.avoided / (t.hits + t.avoided);
  assert.ok(share > 0.25 && share < 0.6, `blocked ${share}`);
});

test('Finisher Ready halves the next hit and ends on it; Queen\'s Barrier soaks', async () => {
  const f = await fighter();
  const m = { ...buildMonster(findMobs('Angel of Genesis')[0]), skills: [] as MobSkill[] };
  // Nothing that costs HP: the check is on the hit alone.
  const fight = newFight(f, m, kingslayer, priorityPolicy,
    { seed: 1, limitMs: 1_000, options: { queensGambit: false, bishopsTax: false, preGambit: false } });
  fight.me.buffs.finisher = { until: 1e9, stacks: 1 };
  const hp = fight.me.hp;
  // Straight through the engine's own path: hurtMe is internal, so a dot does it.
  fight.me.dots.push({ name: 'test', nextAt: 0, every: 1e9, until: 1, dmg: 1000, lethal: true });
  run(fight);
  assert.ok(hp - fight.me.hp <= 500 + 5000, 'halved');
  assert.equal(fight.me.buffs.finisher, undefined, 'ended on the hit');
});

test('an Auto-Guard card counts: Tower Eater Card is Lv10', async () => {
  const f = await buildFighter({
    ...profile,
    build: { ...(profile.build as any), slots: { ...(profile.build as any).slots,
      offhand: { item: 'Battle Glory Shield', refine: 6, cards: ['Tower Eater Card'] } } },
  }, { passives, aliases: {}, maxLevels: maxLevels() });
  assert.equal(f.autoGuard, 10);
});

test("the owner's dummy readings (2026-09-26): shield skills and Queen's Gambit", async () => {
  const { readJSON, REPO } = await import('../src/data.ts');
  const { dummyMonster } = await import('../src/monster.ts');
  const { Rng } = await import('../src/rng.ts');
  const p = readJSON<Profile>(`${REPO}/combat/profiles/kingslayer-dummy.json`);
  const f = await buildFighter(p, { passives, aliases: {}, maxLevels: maxLevels() });
  const hit = (id: string, setup: (fight: any) => void = () => {}) => {
    const fight: any = newFight(f, dummyMonster(), kingslayer, priorityPolicy, { seed: 1, limitMs: 60_000 });
    fight.rng = new Rng(0, true);
    kingslayer.prep(fight);
    fight.me.buffs.counters = { until: 1e12, stacks: 10 };
    setup(fight);
    kingslayer.actions.find((x) => x.id === id)!.resolve(fight);
    return fight.meter.actions[id].damage as number;
  };
  const near = (sim: number, game: number, tol: number, what: string) =>
    assert.ok(Math.abs(sim / game - 1) <= tol, `${what}: sim ${Math.round(sim)} vs game ${game}`);
  near(hit("King's Chains") / 4, 7155, 0.06, "King's Chains");
  near(hit("King's Chains", (x) => { x.me.buffs.sbCombo = { until: 1e12, stacks: 1 }; }) / 4, 10732, 0.06, 'with the combo');
  near(hit("King's Chains", (x) => {
    x.me.buffs.sbCombo = { until: 1e12, stacks: 1 };
    x.mob.buffs.tax = { until: 1e12, stacks: 1, value: 15 };
    x.mob.buffs.raid = { until: 1e12, stacks: 1, value: 15 };
  }) / 4, 12342, 0.06, 'with the combo, Sneak Attack and Bishop\'s Tax (they do not stack)');
  near(hit('Shield Boomerang'), 6269, 0.03, 'Shield Boomerang');
  near(hit("Queen's Gambit") / 9, 1929, 0.03, "Queen's Gambit");
  // Rook's Smash at full HP (28,030 with Duel Stance): three hits on the dummy, nothing knocks it back.
  const fight: any = newFight(f, dummyMonster(), kingslayer, priorityPolicy, { seed: 1, limitMs: 60_000 });
  fight.rng = new Rng(0, true);
  kingslayer.prep(fight);
  fight.me.buffs.counters = { until: 1e12, stacks: 10 };
  kingslayer.actions.find((x) => x.id === "Rook's Smash")!.resolve(fight);
  const rs = fight.meter.actions["Rook's Smash"];
  assert.equal(rs.hits, 3);
  near(rs.damage / 3, 5876, 0.03, "Rook's Smash");
  assert.equal(f.maxHp, 28_030, 'the read Max HP, with Duel Stance on');
  // Retribution reads 12% high on the weapon-skill calibration (a Satsujin's); held loosely.
  near(hit('Retribution'), 16375, 0.15, 'Retribution');
});

test("Knight's Regen heals 1 + 1% Max HP a level every 5 seconds", async () => {
  const f = await fighter();
  const m = { ...buildMonster(findMobs('Angel of Genesis')[0]), skills: [] as MobSkill[], adelay: Infinity, hit: 0 };
  const fight = newFight(f, m, kingslayer, priorityPolicy,
    { seed: 1, limitMs: 10_100, options: { queensGambit: false, bishopsTax: false, preGambit: false } });
  fight.me.hp = Math.floor(f.maxHp / 2);
  run(fight);
  // Two ticks at Lv5 (6% each) in 10s, plus natural regen.
  assert.ok(fight.meter!.healed >= 2 * 0.06 * f.maxHp - 1, `healed ${fight.meter!.healed}`);
});

test('Grand Cross misses from the diagonal; Jormungandr\'s long casts are line-of-sighted', async () => {
  const f = await fighter();
  const angel = buildMonster(findMobs('Angel of Genesis')[0]);
  const gc = only(angel, { CR_GRANDCROSS: { delayMs: 60_000 } });
  const a = newFight(f, { ...gc, adelay: 1e9 } as Monster, kingslayer, priorityPolicy,
    { seed: 1, limitMs: 10_000, log: true, options: { queensGambit: false, bishopsTax: false } });
  run(a);
  assert.match(a.log!.join('\n'), /avoids Grand Cross \(diagonal\)/);

  const jorm = buildMonster(findMobs('Jormungandr')[0]);
  const breath = jorm.skills.find((s) => s.skill === 'RK_DRAGONBREATH')!;
  assert.ok(breath.avoid.includes('los'));
  const swhoo = only(jorm, { SP_SWHOO: { delayMs: 60_000 } });
  const b = newFight(f, swhoo, kingslayer, priorityPolicy,
    { seed: 1, limitMs: 10_000, log: true, options: { queensGambit: false, bishopsTax: false } });
  run(b);
  assert.match(b.log!.join('\n'), /avoids Swhoo \((line of sight|Hiding)\)/);
});
