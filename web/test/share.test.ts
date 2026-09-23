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
import { decodeBuild, encodeBuild, payloadIn } from '../src/share.ts';

const BUILD: Build = {
  className: 'Assassin',
  baseLevel: 150,
  baseStats: { str: 90, agi: 99, vit: 1, int: 1, dex: 40, luk: 1 },
  slots: {
    weapon: { itemId: 1229, refine: 9, cards: [4144, 4144, null, null] },
    lower: { itemId: 2299, refine: 0, cards: [], rolls: { atk: { option: 2, value: 5 } } },
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
  assert.deepEqual(back?.slots.weapon, BUILD.slots.weapon);
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

test('deflating is what keeps the link short', async () => {
  const payload = await encodeBuild(BUILD);
  assert.equal(payload[0], 'z', 'expected the deflated tag');
  assert.ok(payload.length < JSON.stringify(BUILD).length,
    `payload ${payload.length} should beat raw JSON ${JSON.stringify(BUILD).length}`);
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
  const plain = 'u' + Buffer.from(JSON.stringify(BUILD)).toString('base64url');
  const back = await decodeBuild(plain);
  assert.equal(back?.className, 'Assassin');
});
