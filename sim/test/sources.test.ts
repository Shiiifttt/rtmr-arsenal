/**
 * Where things come from: vendors and quests read off the crawl, the refine
 * ladder, and monster spawns.
 *
 * Run with:  node --experimental-strip-types --test sim/test/sources.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  acquisitionOf, readSpawns, refineMaterials, respawnText, type SpawnFile,
} from '../src/index.ts';
import type { Item } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '../../data');
const load = <T>(p: string): T => JSON.parse(readFileSync(resolve(DATA, p), 'utf8')) as T;

const items = new Map(load<Item[]>('items/all.json').map((i) => [i.id, i]));
const byId = (id: number) => items.get(id)!;

test('an exchange, and a quest with what it costs', () => {
  // Listed as sold by the database; the Einherjar Soul cost is a correction
  // in crawler/acquisition.json.
  const gleipnir = acquisitionOf(byId(2633))!;
  assert.equal(gleipnir.sold, false);
  assert.match(gleipnir.where, /Wish Maiden/);
  assert.deepEqual(gleipnir.costs, [{ qty: 100, name: 'Einherjar Soul', id: 7362 }]);

  const circlet = acquisitionOf(byId(18827))!;
  assert.equal(circlet.sold, false);
  assert.deepEqual(circlet.costs, [{ qty: 500, name: 'Einherjar Soul', id: 7362 }]);

  assert.equal(acquisitionOf(byId(13589)), null, 'a card that only drops has no vendor');
});

test('the refine ladder: ore to +3, HD to +6, Enriched to +9, Jewel for +10', () => {
  const laevateinn = byId(1533);
  const steps = refineMaterials(laevateinn, 9, 10, false);
  assert.deepEqual(steps.map((s) => s.itemId), [984, 6240, 6292, 6906]);
  assert.deepEqual(steps.map((s) => s.range), [[1, 3], [4, 6], [7, 9], [10, 10]]);
  assert.deepEqual(steps.map((s) => s.next), [false, false, false, true], '+10 is next');

  // Armour takes the Elunium line, and an unrefined piece is only told the first.
  const armor = byId(2375);
  assert.deepEqual(refineMaterials(armor, 0, 10, false)
    .map((s) => [s.itemId, s.next]), [[985, true]]);
  assert.deepEqual(refineMaterials(armor, 10, 10, false).map((s) => s.itemId),
    [985, 6241, 6291, 6290], 'fully refined: every tier, nothing next');

  assert.deepEqual(refineMaterials(armor, 4, 10, true), [], 'shadow gear is not guessed at');
});

test('runes take Bradium, then Jewel Bradium past +3', () => {
  const rune = byId(24173);
  assert.equal(rune.type, 'Rune');
  const steps = refineMaterials(rune, 6, 10, true);
  assert.deepEqual(steps.map((s) => [s.itemId, s.range, s.next]),
    [[6224, [1, 3], false], [6226, [4, 10], false]]);
  assert.match(steps[1].note ?? '', /downgrad/);
});

test('spawns: how many live on each map, and how fast they come back', () => {
  const mobs = readSpawns(load<SpawnFile>('mobs/spawns.json'));
  const past = mobs.get(2951)!;
  assert.equal(past.name, 'Maiden of Past');
  assert.equal(past.mvp, false);
  assert.ok(past.spawns.some((s) => s.map === 'Mansion Garden' && s.count === 20));

  assert.equal(respawnText([5, 0]), '5s');
  assert.equal(respawnText([1800, 3600]), '30 min - 1 h');
  assert.equal(respawnText([7200, 18000]), '2 h - 5 h');
});
