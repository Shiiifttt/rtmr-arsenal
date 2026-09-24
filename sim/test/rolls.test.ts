/**
 * Random rolls: the bonuses one copy of an item dropped with.
 *
 * The risk these guard is specific. The roll tables are hand-written, so
 * nothing upstream stops them naming a slot or a stat that does not exist --
 * and a roll bound to nothing would silently contribute zero while the UI
 * still showed the player their number. The other half is sign: a roll
 * worded "physical damage reduced 5%" has to land as -5 on a "received"
 * stat, or it makes the character take more damage, not less.
 *
 * Run with: node --experimental-strip-types --test sim/test/rolls.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregate, BASE_LEVEL_DEFAULT, bindBaseStatIds, carryInto, clampRoll,
  defaultBaseStats,
  defaultValues, fitsSlot, rollEffects, rollsApply, rollTableFor,
  SLOTS, SLOT_BY_KEY, tableForSlot,
} from '../src/index.ts';
import type {
  Build, Dataset, Item, RollData, RollPick, SetRecord, SlotState, StatDef,
} from '../src/types.ts';

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');
const load = <T>(p: string): T =>
  JSON.parse(readFileSync(resolve(DATA, p), 'utf8')) as T;

const itemList = load<Item[]>('items/all.json');
const stats = load<StatDef[]>('stats.json');
bindBaseStatIds(stats);

const rolls = load<RollData>('rolls.json');
const dataset: Dataset = {
  items: new Map(itemList.map((i) => [i.id, i])),
  itemList,
  sets: load<SetRecord[]>('sets/all.json'),
  stats,
  statById: new Map(stats.map((s) => [s.id, s])),
  classes: load<string[]>('classes.json'),
  classRules: null,
  rolls,
};

const statId = (key: string) => stats.find((s) => s.key === key)!.id;

function emptyBuild(): Build {
  const slots: Record<string, SlotState> = {};
  for (const s of SLOTS) slots[s.key] = { itemId: null, refine: 0, cards: [] };
  return {
    className: null,
    baseLevel: BASE_LEVEL_DEFAULT,
    baseStats: defaultBaseStats(),
    slots,
  };
}

// ---- the tables themselves ------------------------------------------------

test('every slot a roll table claims is a real slot', () => {
  const unknown: string[] = [];
  for (const table of rolls.tables) {
    for (const slot of table.slots) {
      if (!SLOT_BY_KEY.has(slot)) unknown.push(`${table.key} -> ${slot}`);
    }
  }
  assert.deepEqual(unknown, [],
    'these tables would never be reached: no slot has that key');
});

test('no slot is claimed by two tables', () => {
  const seen = new Map<string, string>();
  for (const table of rolls.tables) {
    for (const slot of table.slots) {
      assert.equal(seen.get(slot), undefined,
        `${slot} is claimed by both ${seen.get(slot)} and ${table.key}`);
      seen.set(slot, table.key);
    }
  }
});

test('every grant is bound to a stat, or is a skill modifier', () => {
  const ids = new Set(stats.map((s) => s.id));
  for (const table of rolls.tables) {
    for (const roll of table.rolls) {
      for (const option of roll.options) {
        assert.ok(option.grants.length > 0, `${option.key} grants nothing`);
        for (const grant of option.grants) {
          if (grant.skill) continue;
          assert.ok(
            grant.stat_id !== undefined && grant.stat_id !== null
              && ids.has(grant.stat_id),
            `${table.key}/${option.key} is not bound to a stat -- `
              + 're-run python crawler/build_rolls.py',
          );
        }
      }
    }
  }
});

// ---- values ---------------------------------------------------------------

test('a value is held inside the range the table allows', () => {
  const grant = { unit: '%', min: 1, max: 5 } as const;
  assert.equal(clampRoll(grant, 3), 3);
  assert.equal(clampRoll(grant, 0), 1, 'below the floor');
  assert.equal(clampRoll(grant, 9), 5, 'above the ceiling');
  assert.equal(clampRoll(grant, Number.NaN), 1, 'unparseable falls to the floor');
});

test('an unconfirmed ceiling does not become a cap', () => {
  // `max: null` means nobody has established the top of the range. Clipping
  // to a guess would quietly wrong the player's own item.
  const open = { unit: '%', min: 1, max: null };
  assert.equal(clampRoll(open, 40), 40);
  assert.equal(clampRoll(open, 0), 1, 'the floor is still known');
});

test('a fractional roll keeps its precision', () => {
  const fct = { unit: null, min: 0.2, max: 0.2, step: 0.001 };
  assert.equal(clampRoll(fct, 0.2), 0.2, 'not truncated to zero');
});

// ---- effects --------------------------------------------------------------

const garment = rolls.tables.find((t) => t.key === 'garment')!;
const armor = rolls.tables.find((t) => t.key === 'armor')!;
const shadow = rolls.tables.find((t) => t.key === 'shadow')!;

test('a roll nobody has filled in contributes nothing', () => {
  assert.deepEqual(rollEffects(garment, undefined), []);
  assert.deepEqual(rollEffects(garment, { stat: { option: null, values: [] } }), []);
});

test('"damage reduced" lands as a negative on damage received', () => {
  const option = armor.rolls.find((r) => r.key === 'mitigation')!
    .options.find((o) => o.key === 'physical_reduced')!;
  const [effect] = rollEffects(armor, {
    mitigation: { option: option.key, values: [5] },
  });
  assert.equal(effect.value, -5,
    'typed as 5% reduced, stored as -5% received');
  assert.deepEqual(effect.stat_keys, ['physical_damage_received']);
});

test('one option can grant two stats at once', () => {
  // Leech is a chance and an amount, and they are separate stats because
  // they stack differently.
  const option = garment.rolls.find((r) => r.key === 'sustain')!
    .options.find((o) => o.key === 'hp_leech')!;
  const effects = rollEffects(garment, {
    sustain: { option: option.key, values: defaultValues(option) },
  });
  assert.deepEqual(
    effects.map((e) => e.stat_keys?.[0]),
    ['leech_hp_rate', 'leech_hp_power'],
  );
  assert.deepEqual(effects.map((e) => e.value), [10, 1], 'both at their minimum');
});

test('a skill modifier counts against its skill, never a stat', () => {
  const pick: RollPick = { option: 'skill_mod', values: [5], skill: 'Bash' };
  const [effect] = rollEffects(shadow, { skill: pick });
  assert.deepEqual(effect.stat_ids, [], 'no stat to add it into');
  assert.deepEqual(effect.skills, ['Bash']);
  assert.equal(effect.skill_metric, 'damage');
  assert.match(effect.text, /Bash damage \+5%/);
});

test('a skill modifier with no skill named is reported, not counted', () => {
  const [effect] = rollEffects(shadow, { skill: { option: 'skill_mod', values: [5] } });
  assert.equal(effect.parsed, false);
});

// ---- through the aggregator ----------------------------------------------

test('a garment flee roll reaches the flee total', () => {
  const item = itemList.find(
    (i) => i.equip_slots.includes('Garment') && i.kind !== 'Card')!;

  const build = emptyBuild();
  build.slots.garment = {
    itemId: item.id, refine: 0, cards: [],
    rolls: { evasion: { option: 'flee', values: [8] } },
  };
  const after = aggregate(build, dataset);

  // Measured as a delta against the same item with no rolls: the item may
  // well give flee of its own, and an absolute figure would hide a mistake.
  const flee = (t: ReturnType<typeof aggregate>) =>
    t.byStat.get(statId('flee'))?.flat ?? 0;
  const plain = aggregate(
    { ...build, slots: { ...build.slots, garment: { ...build.slots.garment, rolls: {} } } },
    dataset,
  );
  assert.equal(flee(after) - flee(plain), 8, 'the roll, and only the roll');
});

test('a roll shows up as its own source, not folded into the item', () => {
  const item = itemList.find(
    (i) => i.equip_slots.includes('Garment') && i.kind !== 'Card')!;
  const build = emptyBuild();
  build.slots.garment = {
    itemId: item.id, refine: 0, cards: [],
    rolls: { stat: { option: 'agi', values: [2] } },
  };
  const totals = aggregate(build, dataset);
  const agi = totals.byStat.get(statId('agi'))!;
  assert.ok(
    agi.sources.some((s) => s.label === `${item.name} (roll)` && s.value === 2),
    `expected a roll source, got ${JSON.stringify(agi.sources)}`,
  );
});

// ---- the slots the tables hang off ---------------------------------------

test('manuals and shadow accessories go to different slots', () => {
  // Both declare "Shadow accessory", so the wording alone would put a manual
  // in the accessory slot and let a character wear two of neither.
  const manuals = itemList.filter((i) => i.type === 'Manual');
  const accessories = itemList.filter(
    (i) => i.kind === 'Shadow gear' && i.equip_slots.includes('Shadow accessory'));

  assert.ok(manuals.length > 0 && accessories.length > 0, 'dataset sanity');

  const manualSlot = SLOT_BY_KEY.get('sh_manual')!;
  const accSlot = SLOT_BY_KEY.get('sh_acc')!;

  assert.ok(manuals.every((i) => fitsSlot(i, manualSlot)), 'every manual fits');
  assert.ok(!manuals.some((i) => fitsSlot(i, accSlot)),
    'no manual may occupy the shadow accessory slot');
  assert.ok(accessories.every((i) => fitsSlot(i, accSlot)));
  assert.ok(!accessories.some((i) => fitsSlot(i, manualSlot)));
});

test('runes and orbs sit under shadow gear', () => {
  assert.equal(SLOT_BY_KEY.get('runeorb')!.group, 'shadow');
  assert.ok(tableForSlot(rolls, 'runeorb'), 'and roll like shadow gear');
});

// ---- gated tables ---------------------------------------------------------

const dropped = itemList.find(
  (i) => i.equip_slots.includes('Upper headgear') && (i.drops?.length ?? 0) > 0)!;
const notDropped = itemList.find(
  (i) => i.equip_slots.includes('Upper headgear') && i.kind !== 'Card'
    && !(i.drops?.length))!;

test('headgear rolls only when it drops off a monster', () => {
  assert.ok(dropped && notDropped, 'dataset has both kinds to test with');
  assert.ok(rollTableFor(rolls, 'upper', dropped), `${dropped.name} drops`);
  assert.equal(rollTableFor(rolls, 'upper', notDropped), null,
    `${notDropped.name} does not drop, so it must not roll`);
  // The slot itself still has a table -- the gate is on the item, and the UI
  // needs to tell "this slot never rolls" from "this piece does not".
  assert.ok(tableForSlot(rolls, 'upper'));
});

test('an item with no drop data at all is treated as not dropped', () => {
  // Inventing rolls is the worse of the two failures: it inflates totals
  // silently, where withholding them is visible and correctable.
  const gated = rolls.tables.find((t) => t.requires?.dropped)!;
  assert.equal(rollsApply(gated, { ...notDropped, drops: undefined }), false);
  assert.equal(rollsApply(gated, { ...notDropped, drops: [] }), false);
});

test('an ungated slot does not care where the item came from', () => {
  const garmentItem = itemList.find(
    (i) => i.equip_slots.includes('Garment') && i.kind !== 'Card')!;
  assert.ok(rollTableFor(rolls, 'garment', { ...garmentItem, drops: [] }));
});

test('saved rolls on a barred item never reach the totals', () => {
  // The gate has to hold in the aggregator too, not only in the editor:
  // a build saved before the rule existed still has the values in it.
  const build = emptyBuild();
  build.slots.upper = {
    itemId: notDropped.id, refine: 0, cards: [],
    rolls: { stat: { option: 'agi', values: [2] } },
  };
  const totals = aggregate(build, dataset);
  const agi = totals.byStat.get(statId('agi'));
  assert.ok(
    !agi?.sources.some((s) => s.label.endsWith('(roll)')),
    'a barred item contributed a roll anyway',
  );
});

test('a slot with no table quietly has no rolls', () => {
  // Weapons are not described yet. That must read as "unknown", not as a
  // crash and not as an empty table the player could fill in wrongly.
  assert.equal(tableForSlot(rolls, 'weapon'), null);
  assert.equal(tableForSlot(null, 'garment'), null);
});

test('manuals and runes roll a stat but never a skill modifier', () => {
  for (const slot of ['sh_manual', 'runeorb']) {
    const table = tableForSlot(rolls, slot)!;
    assert.ok(table, `${slot} still rolls`);
    assert.deepEqual(table.rolls.map((r) => r.key), ['stat'],
      `${slot} must not offer a skill modifier`);
  }
  // Shadow gear proper still does, so the two have not been merged by hand.
  assert.deepEqual(
    tableForSlot(rolls, 'sh_armor')!.rolls.map((r) => r.key), ['stat', 'skill']);
});

// ---- swapping the item in a slot -----------------------------------------

test('rolls carry to the next item tried in the same slot', () => {
  const [a, b] = itemList.filter(
    (i) => i.equip_slots.includes('Garment') && i.kind !== 'Card');
  const slot = SLOT_BY_KEY.get('garment')!;
  const before: SlotState = {
    itemId: a.id, refine: 0, cards: [],
    rolls: { evasion: { option: 'flee', values: [8] } },
  };
  const after = carryInto(before, b, slot, dataset);
  assert.deepEqual(after.rolls?.evasion, { option: 'flee', values: [8] },
    'the same roll, not re-typed');
});

test('rolls do not follow an item into a slot that rolls differently', () => {
  // Garment rolls evasion; shadow armor does not. Carrying the pick across
  // would leave a bonus in the totals with no control to change it.
  const garmentItem = itemList.find(
    (i) => i.equip_slots.includes('Garment') && i.kind !== 'Card')!;
  const shadowItem = itemList.find((i) => i.equip_slots.includes('Shadow armor'))!;
  const before: SlotState = {
    itemId: garmentItem.id, refine: 0, cards: [],
    rolls: {
      evasion: { option: 'flee', values: [8] },
      stat: { option: 'agi', values: [2] },
    },
  };
  const after = carryInto(before, shadowItem, SLOT_BY_KEY.get('sh_armor')!, dataset);
  assert.equal(after.rolls?.evasion, undefined, 'shadow gear has no evasion roll');
  // Shadow gear rolls +1 at most where a garment rolls +2, so the value is
  // pulled into the new range on the way.
  assert.deepEqual(after.rolls?.stat, { option: 'agi', values: [1] },
    'but the stat roll exists in both tables');
});

test('rolls are dropped when the new item is barred from rolling', () => {
  const slot = SLOT_BY_KEY.get('upper')!;
  const before: SlotState = {
    itemId: dropped.id, refine: 0, cards: [],
    rolls: { stat: { option: 'agi', values: [2] } },
  };
  const after = carryInto(before, notDropped, slot, dataset);
  assert.equal(after.rolls, undefined,
    'a piece that is not a monster drop keeps no rolls');
});

test('a value out of the new range is pulled back into it', () => {
  // Ranges tighten as they are verified, and a carried-over value has to
  // land somewhere the table actually allows.
  const slot = SLOT_BY_KEY.get('garment')!;
  const item = itemList.find(
    (i) => i.equip_slots.includes('Garment') && i.kind !== 'Card')!;
  const after = carryInto(
    { itemId: item.id, refine: 0, cards: [], rolls: { stat: { option: 'agi', values: [99] } } },
    item, slot, dataset,
  );
  assert.deepEqual(after.rolls?.stat.values, [2], 'clamped to the 1-2 range');
});
