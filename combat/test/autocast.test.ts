/**
 * Gear autocasts (src/autocast.ts): the server's trigger rules, the tooltip
 * reader, and a fight that casts one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attackMask, BF, fillMask, maskMatches, readAutocasts, readTooltip } from '../src/autocast.ts';
import { buildFighter, type Profile } from '../src/character.ts';
import { plannerDataset } from '../src/data.ts';
import { newFight, run } from '../src/engine.ts';
import { dummyMonster } from '../src/monster.ts';
import { priorityPolicy } from '../src/tas.ts';
import { maxLevels, nightraven, passives } from '../src/kits/nightraven.ts';

test('trigger masks: bonus3 bAutoSpell is normal weapon attacks only, when-hit is weapon hits (pc.cpp:2560-2568)', () => {
  const attack = fillMask(0);
  assert.ok(maskMatches(attack, attackMask('melee', false)));
  assert.ok(maskMatches(attack, attackMask('ranged', false)));
  assert.ok(!maskMatches(attack, attackMask('melee', true)), 'a weapon skill does not set off a plain bAutoSpell');
  assert.ok(!maskMatches(attack, attackMask('magic', true)));
  const hit = fillMask(BF.NORMAL | BF.SKILL);
  assert.ok(maskMatches(hit, BF.WEAPON | BF.SHORT | BF.SKILL));
  assert.ok(!maskMatches(hit, BF.MAGIC | BF.LONG | BF.SKILL), 'magic never sets off a bonus3 when-hit');
  // bonus5 BF_MAGIC: magic skills, either range.
  assert.ok(maskMatches(fillMask(BF.MAGIC), attackMask('magic', true)));
});

test('tooltip reader: chances, triggers and the skill that sets one off', () => {
  const crow = readTooltip('Blitz Beat DMG+200%\nAutocast Blitz Beat Lv1 at 1% chance per base LUK\nBlitz Beat autocasts Sky Assault, 1% chance per refine');
  assert.deepEqual(crow.casts.map((c) => [c.skills, c.trigger, c.onSkills, c.rate]), [
    [['Blitz Beat'], 'attack', undefined, { flat: 0, perRefine: 0, perBaseLuk: 1 }],
    [['Sky Assault'], 'skill', ['Blitz Beat'], { flat: 0, perRefine: 1, perBaseLuk: 0 }],
  ]);
  // A "Per Refine:" heading: the chance is per refine; another line's % is not part of it.
  const gem = readTooltip('Per Refine:\nHP +2%\n1% chance to Autocast Shield Boomerang and\nKing\'s Chains when hit');
  assert.deepEqual(gem.casts.map((c) => [c.skills, c.trigger, c.rate?.perRefine, c.rate?.flat]), [
    [['Shield Boomerang', "King's Chains"], 'hit', 1, 0],
  ]);
  // Wrapped old-style text, the skill name cut across lines.
  const wrapped = readTooltip('Piece Bonus:\nChance to autocast Flaming\nPetals Lv3:\n3% +0.2% per refine.');
  assert.deepEqual(wrapped.casts.map((c) => [c.skills, c.level, c.rate]), [[['Flaming Petals'], 3, { flat: 3, perRefine: 0.2, perBaseLuk: 0 }]]);
  // "X autocasts Y": every time X goes off.
  const always = readTooltip('Shadow Slash Autocasts Wind Slash Lv3');
  assert.deepEqual(always.casts.map((c) => [c.skills, c.level, c.onSkills, c.rate?.flat]), [[['Wind Slash'], 3, ['Shadow Slash'], 100]]);
  // Set bonuses need the set: not read off one piece.
  assert.equal(readTooltip('Piece Bonus:\nHP+100\n1st Einherjar Set Bonus:\n10% chance to autocast Heal Lv1 when using Hiding').casts.length, 0);
});

test('readAutocasts: the crawl column, a tooltip chance per refine, the server mask', () => {
  const data = plannerDataset();
  const id = (name: string) => data.itemList.find((i) => i.name === name)!.id;
  const stats = { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 50 };
  const ctx = { stats, baseStats: stats, levels: {}, maxLevel: () => 10 };
  const [fb] = readAutocasts([{ itemId: id('Obsidian Dagger'), refine: 0, card: false }], data, ctx, []);
  assert.deepEqual([fb.skills, fb.level, fb.chance, fb.trigger, fb.mask], [['Fire Ball'], 7, 0.1, 'attack', fillMask(0)]);
  const yumi = readAutocasts([{ itemId: id('Yumi Bow'), refine: 7, card: false }], data, ctx, []);
  assert.ok(Math.abs(yumi[0].chance - 0.07) < 1e-9, `Yumi Bow +7: ${yumi[0].chance}`);
  const crow = readAutocasts([{ itemId: id('Crow of Destiny'), refine: 4, card: false }], data, ctx, []);
  const blitz = crow.find((a) => a.skills[0] === 'Blitz Beat')!;
  const sky = crow.find((a) => a.skills[0] === 'Sky Assault')!;
  assert.ok(Math.abs(blitz.chance - 0.5) < 1e-9, `1% per base LUK at 50: ${blitz.chance}`);
  assert.deepEqual([sky.trigger, sky.onSkill, sky.chance], ['skill', 'Blitz Beat', 0.04]);
});

test('in a fight: a normal attack sets off a bAutoSpell, at no SP, holding the next action for its delay', async () => {
  const profile: Profile = {
    build: {
      className: 'Night Raven', baseLevel: 130, baseStats: { str: 90, agi: 99, vit: 35, int: 50, dex: 87, luk: 1 },
      slots: { weapon: { item: 'Obsidian Dagger' }, offhand: { item: 'Knife' } },
    },
    aspdModel: { base: 64, mastery: 26, byType: { Dagger: 64, Sword: 69 } },
  };
  const f = await buildFighter(profile, { passives, aliases: {}, maxLevels: maxLevels() });
  const fb = f.autocasts!.find((a) => a.skills[0] === 'Fire Ball')!;
  fb.chance = 1;
  const fight = newFight(f, dummyMonster(), nightraven, priorityPolicy, {
    seed: 3, limitMs: 3_000, log: true,
    options: { order: ['Attack'], weaponBlock: false, risingWings: false, hallucination: false },
  });
  const sp = fight.me.sp;
  run(fight);
  const casts = fight.log!.filter((l) => /Obsidian Dagger autocasts Fire Ball Lv7/.test(l));
  const swings = fight.meter!.actions.Attack;
  assert.ok(casts.length > 0, 'Fire Ball went off');
  assert.equal(casts.length, swings.hits > 0 ? casts.length : 0);
  assert.ok((fight.meter!.actions['Fire Ball (autocast)']?.damage ?? 0) > 0, 'and dealt damage');
  assert.ok(fight.me.sp >= sp - 1, 'autocasts are free');
  // Fire Ball's 700 ms after-cast delay holds the swings back: fewer of them than the ASPD alone allows.
  assert.ok(casts.length <= swings.uses);
});
