/**
 * Job limits: the sentence the site ships, and the class rules beside it.
 *
 * Built from stub items rather than the crawled dataset, so the cases stay
 * legible and a change to the data cannot quietly turn a test green.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canEquip, canUse, jobLimitFix, jobLimitOf } from '../src/jobs.ts';
import type { ClassRules, Item } from '../src/types.ts';

function item(id: number, name: string, type: string, slots: string[],
              usable_by: string | null): Item {
  return {
    id, name, kind: 'Weapon', type, category: null, equip_slots: slots,
    description: '', required_level: 1, weight: 0, atk: 0, matk: 0, def: 0, mdef: 0,
    card_slots: 0, refineable: true, weapon_level: null, element: null,
    usable_by, images: { icon: null, art: null }, card_affix: null,
    sets: [], effects: [], piece_bonus: [],
    refine: { per_refine: [], thresholds: [] }, conditional: [], lore: null,
  } as Item;
}

const DAGGER = item(1, 'Dagger', 'Dagger', ['Weapon'], null);
const SWORD = item(2, 'Sword', 'Sword', ['Weapon'], null);
const COLOSSAL = item(3, 'Diamond Shield', 'Colossal Shield', ['Weapon (two-handed)'],
  'All except Judge, Peacekeeper, Prowler, Shadowseer');
const ROUND = item(4, 'Buckler', 'Round Shield', ['Off-hand'], null);
const HEAVY = item(5, 'Knight Shield', 'Heavy Shield', ['Off-hand'],
  'All except Bouncer, Judge, Mimic, Peacekeeper, Pit Boss, Prowler, Ronin');
const ARMGUARD = item(6, 'Fox Armguard', 'Armguard', ['Off-hand'],
  'All except Bouncer, Judge, Mimic, Peacekeeper, Pit Boss, Prowler, Ronin, Shadowseer');
const KUNAI = item(7, 'Kunai', 'Kunai', ['Ammunition'], null);
const HAT = item(8, 'Hat', 'Upper Headgear', ['Upper headgear'], null);

const RULES: ClassRules = {
  classes: {
    Satsujin: {
      weapons: ['Dagger'],
      off_hand: ['Shield', 'Round Shield', 'Square Shield', 'Arm Shield', 'Medium Shield'],
      status: 'unverified',
      reason: 'dagger and a one-handed shield',
    },
  },
  items: {},
};

test('the sentence is read in both directions', () => {
  assert.equal(canUse('Assassin, Rogue', 'Rogue'), true);
  assert.equal(canUse('Assassin, Rogue', 'Satsujin'), false);
  assert.equal(canUse('All except Judge, Peacekeeper', 'Judge'), false);
  assert.equal(canUse('All except Judge, Peacekeeper', 'Satsujin'), true);
});

test('no sentence and no class means no restriction', () => {
  assert.equal(canUse(null, 'Satsujin'), true);
  assert.equal(canUse('Jester', null), true);
  assert.equal(canEquip(SWORD, null, RULES), true);
});

test('a class rule closes what the sentence leaves open', () => {
  // Every one of these passes the sentence: none of them names Satsujin.
  assert.equal(canUse(SWORD.usable_by, 'Satsujin'), true);
  assert.equal(canUse(COLOSSAL.usable_by, 'Satsujin'), true);
  assert.equal(canUse(HEAVY.usable_by, 'Satsujin'), true);

  assert.equal(canEquip(DAGGER, 'Satsujin', RULES), true);
  assert.equal(canEquip(SWORD, 'Satsujin', RULES), false);
  assert.equal(canEquip(ROUND, 'Satsujin', RULES), true);
  assert.equal(canEquip(HEAVY, 'Satsujin', RULES), false);
  assert.equal(canEquip(ARMGUARD, 'Satsujin', RULES), false);
});

test('a two-handed shield is judged as a weapon, since that is its slot', () => {
  assert.equal(canEquip(COLOSSAL, 'Satsujin', RULES), false);
});

test('a slot the rule says nothing about keeps the sentence alone', () => {
  // The Satsujin entry names weapons and the off hand, not ammunition or
  // armour, so neither may be filtered on its type.
  assert.equal(canEquip(KUNAI, 'Satsujin', RULES), true);
  assert.equal(canEquip(HAT, 'Satsujin', RULES), true);
});

test('any class can compound any card', () => {
  // A weapon card lives in the weapon slot but is a Card, so judging it
  // against the types a Satsujin may hold would reject every one of them.
  const card = { ...item(9, 'Hydra Card', 'Card', ['Weapon'], null), kind: 'Card' };
  const shieldCard = { ...item(10, 'Thara Frog Card', 'Card', ['Shield'], null), kind: 'Card' };
  assert.equal(canEquip(card, 'Satsujin', RULES), true);
  assert.equal(canEquip(shieldCard, 'Satsujin', RULES), true);

  // Even a card whose sentence names other classes: the restriction is on
  // the piece it goes into, not on who may slot it.
  const named = { ...item(11, 'Odd Card', 'Card', ['Weapon'], 'Jester'), kind: 'Card' };
  assert.equal(canEquip(named, 'Satsujin', RULES), true);
});

test('a class with no rule at all is governed by the sentence', () => {
  assert.equal(canEquip(HEAVY, 'Assassin', RULES), true);
  assert.equal(canEquip(HEAVY, 'Ronin', RULES), false);
  assert.equal(canEquip(SWORD, 'Assassin', RULES), true);
});

test('missing rules behave as the sentence did before the file existed', () => {
  for (const rules of [null, undefined]) {
    assert.equal(canEquip(SWORD, 'Satsujin', rules), true);
    assert.equal(canEquip(HEAVY, 'Ronin', rules), false);
  }
});

test('a per-item correction replaces the sentence', () => {
  const fixed: ClassRules = {
    classes: {},
    items: {
      '6': {
        name: 'Fox Armguard', usable_by: 'Prowler', was: ARMGUARD.usable_by,
        status: 'unverified', reason: 'armguards are Prowler gear',
      },
    },
  };
  assert.equal(jobLimitOf(ARMGUARD, fixed), 'Prowler');
  assert.equal(jobLimitOf(HEAVY, fixed), HEAVY.usable_by);
  assert.equal(canEquip(ARMGUARD, 'Prowler', fixed), true);
  assert.equal(canEquip(ARMGUARD, 'Assassin', fixed), false);
  assert.equal(jobLimitFix(ARMGUARD, fixed)?.was, ARMGUARD.usable_by);
  assert.equal(jobLimitFix(HEAVY, fixed), null);
});
