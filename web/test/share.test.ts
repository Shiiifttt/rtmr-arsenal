/**
 * Builds in links: what goes into a fragment must come back out of it.
 *
 * The round trip is the whole contract. A link is the one part of this app
 * that has to survive being pasted into a chat window, a forum post and an
 * address bar, so the encoding is checked for exactly that -- that it
 * carries everything, and that it uses no character those would mangle.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Build } from '@sim';
import { SLOTS } from '@sim';
import { decodeBuild, encodeBuild, payloadIn } from '../src/share.ts';

const BUILD: Build = {
  className: 'Assassin',
  baseLevel: 150,
  baseStats: { str: 90, agi: 99, vit: 1, int: 1, dex: 40, luk: 1 },
  slots: {
    weapon: { itemId: 1229, refine: 9, cards: [4144, 4144, null, null] },
    lower: {
      itemId: 2299, refine: 0, cards: [],
      rolls: { atk: { option: 'ATK +%d', values: [5] },
               skl: { option: 'Backstab +%d%', values: [3], skill: 'Backstab' } },
    },
    armor: { itemId: null, refine: 0, cards: [] },
  },
  goals: [{ key: 'atk', column: 'total', target: 2000 }],
  locked: ['weapon'],
  manual: { hit: 40 },
  guards: [{ key: 'max_hp', column: 'percent', target: -30, guard: true }],
};

test('a build survives the round trip through a link', async () => {
  const back = await decodeBuild(await encodeBuild(BUILD));

  assert.equal(back?.className, 'Assassin');
  assert.equal(back?.baseLevel, 150);
  assert.deepEqual(back?.baseStats, BUILD.baseStats);
  // Cards come back packed to the front rather than in the sockets they
  // left in. Sockets are not positionally meaningful in Ragnarok -- four of
  // a card is four of a card -- and `socketsOf` pads the array back out to
  // the piece's real socket count on the way in, so the empty tail is not
  // worth the characters.
  assert.deepEqual(back?.slots.weapon,
    { itemId: 1229, refine: 9, cards: [4144, 4144] });
  assert.deepEqual(back?.slots.lower, BUILD.slots.lower);
  assert.deepEqual(back?.goals, BUILD.goals);
  assert.deepEqual(back?.locked, ['weapon']);
  assert.deepEqual(back?.manual, { hit: 40 });
  assert.deepEqual(back?.guards, BUILD.guards);
});

test('guards travel even when empty, because empty is an answer', async () => {
  // Absent means "the defaults"; [] means "I took them off". A link that
  // dropped the empty list would hand the reader back the defaults.
  const back = await decodeBuild(await encodeBuild({ ...BUILD, guards: [] }));
  assert.deepEqual(back?.guards, []);

  const { guards: _drop, ...none } = BUILD;
  assert.equal((await decodeBuild(await encodeBuild(none)))?.guards, undefined);
});

test('empty slots are left out rather than carried', async () => {
  const back = await decodeBuild(await encodeBuild(BUILD));
  assert.equal(back?.slots.armor, undefined);
  assert.deepEqual(Object.keys(back!.slots).sort(), ['lower', 'weapon']);
});

test('the payload uses only characters a URL carries unescaped', async () => {
  const payload = await encodeBuild(BUILD);
  assert.match(payload, /^[A-Za-z0-9_-]+$/);
  assert.equal(encodeURIComponent(payload), payload);
});

test('the payload is a good deal shorter than the build it carries', async () => {
  const payload = await encodeBuild(BUILD);
  assert.equal(payload[0], 'c', 'expected the compact deflated tag');
  const raw = JSON.stringify(BUILD).length;
  assert.ok(payload.length < raw / 2,
    `payload ${payload.length} should be well under half of raw JSON ${raw}`);
});

/**
 * The compact format writes a slot as its position in SLOTS, which is what
 * saves about a hundred characters on a full build. That makes the order of
 * SLOTS part of the link format: reorder it and every link anyone has
 * already saved or posted starts loading gear into the wrong slots.
 *
 * Appending is safe. This pins what is there so a reorder fails here, where
 * the reason is written down, rather than silently out in the world.
 */
test('the slot order the link format depends on is unchanged', () => {
  assert.deepEqual(SLOTS.map((s) => s.key), [
    'upper', 'middle', 'lower', 'armor', 'weapon', 'offhand', 'garment',
    'shoes', 'acc1', 'acc2', 'ammo', 'gem',
    'sh_armor', 'sh_shoes', 'sh_gloves', 'sh_acc', 'sh_manual', 'runeorb',
    'cos_upper', 'cos_middle', 'cos_lower', 'cos_garment', 'orb',
  ]);
});

test('links in the first format still decode', async () => {
  // Written by the version that shipped before the compact format: the
  // whole build as JSON, deflated, under the 'z' tag. Someone has this in
  // a chat window somewhere and it has to keep working.
  const legacy = { className: 'Assassin', baseLevel: 150,
    baseStats: BUILD.baseStats,
    slots: { weapon: { itemId: 1229, refine: 9, cards: [4144, null] } },
    locked: ['weapon'] };
  const bytes = new TextEncoder().encode(JSON.stringify(legacy));
  const z = new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const b64 = Buffer.from(z).toString('base64url');

  const back = await decodeBuild('z' + b64);
  assert.equal(back?.className, 'Assassin');
  assert.equal(back?.baseLevel, 150);
  assert.deepEqual(back?.slots.weapon, { itemId: 1229, refine: 9, cards: [4144, null] });
  assert.deepEqual(back?.locked, ['weapon']);
});

test('a fragment that is not a build reads as none rather than throwing', async () => {
  assert.equal(await decodeBuild('znonsense'), null);
  assert.equal(await decodeBuild('u' + btoa('{"not":"a build"}')), null);
  assert.equal(await decodeBuild(''), null);
  assert.equal(await decodeBuild('q????'), null);
});

test('the payload is found in a URL, and only under its own key', () => {
  assert.equal(payloadIn('https://x.dev/#b=abc'), 'abc');
  assert.equal(payloadIn('https://x.dev/?b=abc'), null);
  assert.equal(payloadIn('https://x.dev/#other=abc'), null);
  assert.equal(payloadIn('https://x.dev/'), null);
});

test('an uncompressed payload still decodes, for a browser with no deflate', async () => {
  // The first format's uncompressed tag, still read.
  const plain = 'u' + Buffer.from(JSON.stringify(BUILD)).toString('base64url');
  assert.equal((await decodeBuild(plain))?.className, 'Assassin');
});

test('a slot carries its cards and its rolls, skill and all', async () => {
  const back = await decodeBuild(await encodeBuild(BUILD));
  assert.deepEqual(back?.slots.weapon?.cards, [4144, 4144]);
  assert.deepEqual(back?.slots.lower?.rolls, BUILD.slots.lower.rolls);
});

test('a build with nothing set round-trips to the same nothing', async () => {
  const bare: Build = {
    className: null, baseLevel: 1,
    baseStats: { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 },
    slots: {},
  };
  const back = await decodeBuild(await encodeBuild(bare));
  assert.equal(back?.className, null);
  assert.deepEqual(back?.slots, {});
  assert.deepEqual(back?.goals, []);
  assert.equal(back?.guards, undefined);
  assert.equal(back?.manual, undefined);
});

test('a goal keeps a target of 0, and whether it is open, and its cap', async () => {
  const goals: Build['goals'] = [
    { key: 'atk', column: 'percent', target: 0, open: true },
    { key: 'def_pen', column: 'flat', target: 25, open: true, cap: 70 },
    { key: 'sp_cost', column: 'percent', target: 0, atMost: true, open: true, cap: -50 },
    { key: 'crit_rate', column: 'flat', target: 0 },
  ];
  const back = await decodeBuild(await encodeBuild({ ...BUILD, goals }));
  assert.deepEqual(back?.goals, goals);
});

test('a goal from an older link that dropped a target of 0 reads back as 0', async () => {
  // [key, column] with the 0 target trimmed off the end, as links used to be written.
  const row = [2, 'Satsujin', 100, [99, 74, 49, 1, 21, 1], [], [['atk', 1], ['sp_cost', 1, 0, 1]]];
  const bytes = new TextEncoder().encode(JSON.stringify(row));
  const z = new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const back = await decodeBuild('c' + Buffer.from(z).toString('base64url'));
  assert.deepEqual(back?.goals, [
    { key: 'atk', column: 'percent', target: 0 },
    { key: 'sp_cost', column: 'percent', target: 0, atMost: true },
  ]);
});
