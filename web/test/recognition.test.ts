/**
 * The recogniser, run against the sample screenshots.
 *
 * These are real captures of the client, so this exercises the whole path --
 * locating the window, matching icons against the full 3,298-icon library,
 * reading the bitmap font, and mapping the result onto build slots. The
 * expectations are what a person reads off the screenshots.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  aggregate, bindBaseStatIds, SLOTS,
  type Build, type Dataset, type Item, type RollData, type StatDef,
} from '@sim';
import {
  decodeLayout, packIcons, provideAssets, type IconManifest, type Font, type RawLayout,
} from '../src/recognition/assets.ts';
import { applyReadings } from '../src/recognition/apply.ts';
import { recognise } from '../src/recognition/read.ts';
import { readPNG, type Raster } from './png.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const json = <T>(path: string): T => JSON.parse(readFileSync(ROOT + path, 'utf8')) as T;

const items = json<Item[]>('data/items/all.json');
const stats = json<StatDef[]>('data/stats.json');
bindBaseStatIds(stats);

const dataset: Dataset = {
  items: new Map(items.map((item) => [item.id, item])),
  itemList: items,
  sets: [],
  stats,
  statById: new Map(stats.map((s) => [s.id, s])),
  classes: [],
  classRules: null,
  // The real tables: reading a tooltip's rolls resolves them against these,
  // so a null here would quietly make every roll test pass vacuously.
  rolls: json<RollData>('data/rolls.json'),
};

const atlas = readPNG(ROOT + 'recognition/icons.png');
provideAssets({
  icons: packIcons(
    json<IconManifest>('recognition/icons.json'), atlas.data, atlas.width,
  ),
  font: json<Font>('recognition/font.json'),
  windows: decodeLayout(json<RawLayout>('recognition/layout.json')),
});

const sample = (name: string): Raster =>
  readPNG(`${ROOT}recognition/samples/${name}.png`);

const named = (id: number | null) => (id ? dataset.items.get(id)?.name ?? '?' : null);

function emptyBuild(): Build {
  const slots: Build['slots'] = {};
  for (const slot of SLOTS) slots[slot.key] = { itemId: null, refine: 0, cards: [] };
  return {
    className: null,
    baseStats: { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 },
    slots,
  };
}

test('reads every item out of the primary equipment tab', async () => {
  const [reading] = await recognise(sample('equipment-primary') as ImageData, dataset);

  assert.equal(reading.window, 'equipment');
  assert.equal(reading.tab, 'primary');

  const byPosition = new Map(
    (reading.slots ?? []).map((slot) => [`${slot.column}-${slot.row}`, slot]),
  );

  // Nine of the ten rows resolve to one item. The tenth, the upper headgear,
  // is a recolour whose icon the crawl does not have -- see the README.
  const expected: Record<string, string> = {
    'left-1': 'Miracle Blue Rose',
    'left-2': 'Laevateinn',
    'left-3': 'Venus Cape',
    'left-4': 'Megingjard',
    'right-0': 'Evil Wing Ears',
    'right-1': 'White Knight Armor',
    'right-2': 'Vorpal Dagger',
    'right-3': 'Temporal STR Boots',
    'right-4': 'Stormwalker Ring',
  };
  for (const [position, name] of Object.entries(expected)) {
    assert.equal(named(byPosition.get(position)?.itemId ?? null), name, position);
  }
});

test('reads refine levels off the names', async () => {
  const [reading] = await recognise(sample('equipment-primary') as ImageData, dataset);
  const refines = Object.fromEntries(
    (reading.slots ?? []).map((slot) => [`${slot.column}-${slot.row}`, slot.refine]),
  );

  assert.equal(refines['left-0'], 6);   // +6 Valkyrie Circlet
  assert.equal(refines['left-2'], 8);   // +8 Prime Laevateinn
  assert.equal(refines['left-3'], 6);   // +6 Piercing Elusive Venus Cape
  assert.equal(refines['left-4'], 0);   // Megingjard, unrefined
  assert.equal(refines['right-2'], 7);  // +7 Flesh Eater Vorpal Dagger
  assert.equal(refines['right-3'], 6);  // +6 Elusive Temporal STR Boots
});

test('reads compounded cards back out of the name affixes', async () => {
  const [reading] = await recognise(sample('equipment-primary') as ImageData, dataset);
  const slot = (reading.slots ?? []).find((s) => s.column === 'right' && s.row === 2);

  // "+7 Flesh Eater Vorpal Dagger": Flesh Eater is the Hodremlin card.
  const names = (slot?.cards ?? []).map((id) => named(id));
  assert.ok(names.includes('Hodremlin Card'), `got ${JSON.stringify(names)}`);
});

test('tells the two equipment tabs apart', async () => {
  const [reading] = await recognise(sample('equipment-secondary') as ImageData, dataset);
  assert.equal(reading.tab, 'secondary');

  // The shadow set shares its icons with every other shadow set in the game,
  // so getting these right is the name doing the work, not the icon.
  const found = (reading.slots ?? [])
    .map((slot) => named(slot.itemId))
    .filter((name): name is string => !!name);
  for (const piece of ['Armor', 'Gloves', 'Shoes', 'Pendant']) {
    assert.ok(
      found.includes(`Fallen Civilization ${piece}`),
      `expected Fallen Civilization ${piece}, got ${JSON.stringify(found)}`,
    );
  }
});

test('reads the status window', async () => {
  const [reading] = await recognise(sample('status') as ImageData, dataset);

  assert.equal(reading.window, 'status');
  assert.deepEqual(reading.stats, {
    str: { base: 99, bonus: 36 },
    agi: { base: 99, bonus: 22 },
    vit: { base: 49, bonus: 8 },
    int: { base: 42, bonus: 9 },
    dex: { base: 49, bonus: 10 },
    luk: { base: 1, bonus: 9 },
  });
  assert.deepEqual(reading.derived?.atk, { base: 198, bonus: 118 });
  assert.deepEqual(reading.derived?.def, { base: 214, bonus: 99 });
  assert.deepEqual(reading.derived?.flee, { base: 495, bonus: 29 });
  assert.deepEqual(reading.derived?.aspd, { base: 172, bonus: 0 });
  assert.deepEqual(reading.derived?.critical, { base: 6, bonus: 0 });
});

test('reads the levels out of the basic information window', async () => {
  const [reading] = await recognise(sample('basic-info') as ImageData, dataset);
  assert.deepEqual(reading.levels, { base: 132, job: 60 });
});

test('finds a window that is not at the origin', async () => {
  // Paste the equipment window into a larger image, as a full-screen capture
  // would have it, and check it still lands in the same place.
  const src = sample('equipment-primary');
  const big: Raster = {
    width: 900, height: 700,
    data: new Uint8ClampedArray(900 * 700 * 4).fill(60),
  };
  const [ox, oy] = [431, 268];
  for (let y = 0; y < src.height; y++) {
    const from = y * src.width * 4;
    big.data.set(src.data.subarray(from, from + src.width * 4),
                 ((oy + y) * big.width + ox) * 4);
  }

  const [reading] = await recognise(big as ImageData, dataset);
  assert.equal(reading.window, 'equipment');
  assert.deepEqual(reading.origin, { x: ox, y: oy });
  assert.equal(
    named((reading.slots ?? []).find((s) => s.column === 'right' && s.row === 1)?.itemId
      ?? null),
    'White Knight Armor',
  );
});

test('puts what it read into the right build slots', async () => {
  const readings = [
    ...await recognise(sample('equipment-primary') as ImageData, dataset),
    ...await recognise(sample('status') as ImageData, dataset),
  ];
  const { build, placed, skipped } = applyReadings(readings, dataset, emptyBuild());

  assert.deepEqual(build.baseStats,
    { str: 99, agi: 99, vit: 49, int: 42, dex: 49, luk: 1 });

  const where = Object.fromEntries(placed.map((p) => [p.slot.key, p.item.name]));
  assert.equal(where.armor, 'White Knight Armor');
  assert.equal(where.shoes, 'Temporal STR Boots');
  assert.equal(where.garment, 'Venus Cape');
  assert.equal(where.middle, 'Evil Wing Ears');
  assert.equal(where.lower, 'Miracle Blue Rose');

  // The character is dual wielding. The equipment window is laid out as the
  // character faces you, so its left column is the main hand and its right
  // column is the off hand -- both weapons fit both slots, and the column is
  // the only thing that says which way round they go.
  assert.equal(where.weapon, 'Laevateinn');
  assert.equal(where.offhand, 'Vorpal Dagger');
  assert.equal(build.slots.weapon.refine, 8);
  assert.equal(build.slots.offhand.refine, 7);
  assert.ok(
    !skipped.some((row) => /Laeva|orpal/.test(row.text)),
    `neither weapon should be left out: ${JSON.stringify(skipped)}`,
  );

  // Two accessories, likewise.
  assert.equal(where.acc1, 'Megingjard');
  assert.equal(where.acc2, 'Stormwalker Ring');
});

test('reading the same window twice does not fight with itself', async () => {
  const readings = await recognise(sample('equipment-primary') as ImageData, dataset);

  const once = applyReadings(readings, dataset, emptyBuild());
  const twice = applyReadings(readings, dataset, once.build);

  assert.deepEqual(twice.build.slots, once.build.slots);
  assert.equal(twice.placed.length, once.placed.length);
  assert.equal(twice.skipped.length, once.skipped.length);
});

test('reading the second tab keeps what the first one placed', async () => {
  const primary = await recognise(sample('equipment-primary') as ImageData, dataset);
  const secondary = await recognise(sample('equipment-secondary') as ImageData, dataset);

  const first = applyReadings(primary, dataset, emptyBuild());
  const both = applyReadings(secondary, dataset, first.build);

  assert.equal(
    both.build.slots.armor.itemId,
    first.build.slots.armor.itemId,
    'the primary tab armour should survive reading the secondary tab',
  );
  const added = both.placed.map((row) => row.item.name);
  assert.ok(
    added.includes('Fallen Civilization Armor'),
    `expected the shadow gear to be added: ${JSON.stringify(added)}`,
  );
});

test('a card in the off hand goes in when a weapon is there', async () => {
  const readings = await recognise(sample('equipment-primary') as ImageData, dataset);
  const { build } = applyReadings(readings, dataset, emptyBuild());

  // The off-hand Vorpal Dagger has a Hodremlin card, which targets "Weapon".
  // It only fits because the slot knows a weapon is in it rather than a
  // shield, so this is the thing to break if that ever gets dropped.
  const cards = build.slots.offhand.cards
    .map((id) => (id ? dataset.items.get(id)?.name : null))
    .filter(Boolean);
  assert.deepEqual(cards, ['Hodremlin Card']);
});

// ---- item tooltips: the random rolls -------------------------------------

/** Equip an item so a tooltip's rolls have a slot to attach to. */
function wearing(slotKey: string, itemId: number): Build {
  const build = emptyBuild();
  build.slots[slotKey] = { itemId, refine: 0, cards: [] };
  return build;
}

test('reads the roll lines off an item tooltip', async () => {
  const [reading] = await recognise(sample('tooltip-garment') as ImageData, dataset);

  assert.equal(reading.window, 'tooltip');
  assert.match(reading.title ?? '', /Venus Cape/);
  assert.deepEqual(reading.rollLines, [
    'AGl +2',
    'Perfect Dodge +1',
    'Leech Rate +16%/Leech Power 2%',
  ]);
});

test('an item that rolled nothing reads as no rolls, not as a failure', async () => {
  const [reading] = await recognise(sample('tooltip-no-rolls') as ImageData, dataset);

  // The client draws the card sockets whether or not the item has any, so
  // there is always one box under the tooltip. It is not a roll.
  assert.equal(reading.window, 'tooltip');
  assert.deepEqual(reading.rollLines, []);
});

test('resolves roll lines against the table for the slot', async () => {
  const readings = await recognise(sample('tooltip-shoes') as ImageData, dataset);
  const boots = dataset.itemList.find((i) => i.name === 'Temporal STR Boots')!;
  const { build, rolls } = applyReadings(readings, dataset, wearing('shoes', boots.id));

  const picks = build.slots.shoes.rolls ?? {};
  assert.deepEqual(picks.stat, { option: 'agi', values: [1] });
  assert.deepEqual(picks.speed, { option: 'move_speed', values: [9] });
  // Worded as a reduction: the table carries the sign, so the magnitude the
  // client printed is what gets stored.
  assert.deepEqual(picks.casting, { option: 'variable_cast', values: [10] });
  assert.equal(rolls[0].slot.key, 'shoes');
});

test('reads a roll whose wording the font could not fully make out', async () => {
  const readings = await recognise(sample('tooltip-armor') as ImageData, dataset);
  const armor = dataset.itemList.find((i) => i.name === 'Diabolus Armor')!;
  const { build } = applyReadings(readings, dataset, wearing('armor', armor.id));

  const picks = build.slots.armor.rolls ?? {};
  assert.deepEqual(picks.resource, { option: 'max_hp', values: [3] });
  // "Physical Damage Received -1%" comes back with wildcards where the font
  // has no glyph, and still has to land on the right option.
  assert.deepEqual(picks.mitigation, { option: 'physical_reduced', values: [1] });
});

test('a roll that could be either option is reported, not guessed', async () => {
  const readings = await recognise(sample('tooltip-garment') as ImageData, dataset);
  const cape = dataset.itemList.find((i) => i.name === 'Venus Cape')!;
  const { build, rolls } = applyReadings(readings, dataset, wearing('garment', cape.id));

  // The client writes "Leech Rate/Leech Power" without saying HP or SP.
  const leech = rolls[0].matched.find((m) => /Leech/.test(m.text))!;
  assert.equal(leech.optionKey, null);
  assert.deepEqual(leech.ambiguous.sort(), ['HP Leech', 'SP Leech']);
  assert.deepEqual(leech.values, [16, 2]);
  assert.equal(build.slots.garment.rolls?.sustain, undefined);

  // The two unambiguous ones still went in.
  assert.deepEqual(build.slots.garment.rolls?.stat, { option: 'agi', values: [2] });
  assert.deepEqual(build.slots.garment.rolls?.evasion,
    { option: 'perfect_dodge', values: [1] });
});

test('rolls for an item that is not equipped are reported', async () => {
  const readings = await recognise(sample('tooltip-shoes') as ImageData, dataset);
  const { skipped } = applyReadings(readings, dataset, emptyBuild());

  assert.ok(
    skipped.some((row) => /nothing equipped/.test(row.reason)),
    `expected a reason: ${JSON.stringify(skipped)}`,
  );
});

test('a tooltip read alongside the equipment window reaches the totals', async () => {
  // The whole path: the equipment window puts the boots in the shoes slot,
  // the tooltip's rolls attach to that slot, and the aggregator counts them.
  const readings = [
    ...await recognise(sample('equipment-primary') as ImageData, dataset),
    ...await recognise(sample('tooltip-shoes') as ImageData, dataset),
  ];
  const { build, rolls } = applyReadings(readings, dataset, emptyBuild());

  assert.equal(rolls.length, 1, 'the tooltip found its slot without being told');
  assert.equal(rolls[0].slot.key, 'shoes');

  // The boots grant move speed of their own, so what this checks is the
  // difference the roll makes rather than the total.
  const moveSpeed = dataset.stats.find((s) => s.key === 'move_speed')!;
  const stripped = { ...build, slots: { ...build.slots,
    shoes: { ...build.slots.shoes, rolls: {} } } };

  const withRoll = aggregate(build, dataset).byStat.get(moveSpeed.id)?.percent ?? 0;
  const without = aggregate(stripped, dataset).byStat.get(moveSpeed.id)?.percent ?? 0;
  assert.equal(withRoll - without, 9, 'the +9% move speed roll is counted');
});
