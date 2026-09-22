/**
 * The "more of this one goal" overlay, rendered on its own.
 *
 * `focusMoves` is tested against the real dataset in sim/test/suggest.test.ts;
 * what is checked here is that the overlay shows what those moves say -- a
 * dialog over the build, a row per suggestion with the piece, its refine and
 * its cards, the goal deltas that make the cost readable, and an Equip button
 * per row. A list of good suggestions that renders a bare `0`, or drops the
 * losses, is worse than no list.
 *
 * Run with: npm test (bundled through esbuild, since this file has JSX)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { bindBaseStatIds, defaultBaseStats, fitsSlot, SLOTS, Suggester } from '@sim';
import type {
  Build, Dataset, Goal, Item, Move, RollData, SetRecord, SlotState, StatDef,
} from '@sim';
import { GoalFocus } from '../src/components/GoalFocus';

const ROOT = new URL('../../data/', import.meta.url);
const j = <T,>(p: string): T => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));
const itemList = j<Item[]>('items/all.json');
const stats = j<StatDef[]>('stats.json');
bindBaseStatIds(stats);

const dataset: Dataset = {
  items: new Map(itemList.map((i) => [i.id, i])),
  itemList,
  sets: j<SetRecord[]>('sets/all.json'),
  stats,
  statById: new Map(stats.map((s) => [s.id, s])),
  classes: j<string[]>('classes.json'),
  classRules: j('class-rules.json'),
  rolls: j<RollData>('rolls.json'),
};

const melee: Goal = { key: 'melee_damage', column: 'percent', target: 50 };
const hp: Goal = { key: 'max_hp', column: 'flat', target: 40000 };

/** A dressed build: the highest-level thing that fits each slot, at +7. */
function fullBuild(): Build {
  const slots: Record<string, SlotState> = {};
  for (const slot of SLOTS) {
    const best = itemList.filter((i) => i.kind !== 'Card' && fitsSlot(i, slot))
      .sort((a, b) => b.required_level - a.required_level)[0];
    slots[slot.key] = { itemId: best?.id ?? null, refine: 7, cards: [] };
  }
  return {
    className: null, baseLevel: 150, baseStats: defaultBaseStats(),
    slots, goals: [melee, hp],
  };
}

const build = fullBuild();
const suggester = new Suggester(dataset, [melee, hp],
  { className: null, maxLevel: 150, refine: 'auto' });
const moves = suggester.focusMoves(build, melee);

const render = (list: Move[] = moves, lockedSlots = 0) => renderToStaticMarkup(
  <GoalFocus
    goal={melee}
    label="Melee Damage %"
    moves={list}
    dataset={dataset}
    build={build}
    goals={[melee, hp]}
    lockedSlots={lockedSlots}
    onApply={() => {}}
    onClose={() => {}}
  />,
);

test('it opens over the build as a dialog, not inside the panel', () => {
  const html = render();
  assert.match(html, /class="overlay"/);
  assert.match(html, /class="picker focus"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /More Melee Damage %/);
});

test('every suggestion is a row with the piece and a way to equip it', () => {
  assert.ok(moves.length > 0, 'the dataset has ways to add melee damage');
  const html = render();
  assert.equal((html.match(/<li>/g) ?? []).length, moves.length);
  assert.equal((html.match(/>Equip</g) ?? []).length, moves.length);
  // The first move's own label, whatever it turns out to be, is on screen.
  const label = moves[0].label.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  assert.ok(html.includes(label), `expected "${label}" in the list`);
  // The slot each piece goes in is named, so a row is not just an item name.
  assert.match(html, /class="move-piece"/);
});

test('each row carries the icon of what it puts on', () => {
  const html = render();
  assert.match(html, /class="move-icons"/);
  // An icon per row at least, and every one is either real art or the
  // placeholder -- never a broken image with an empty src.
  const icons = (html.match(/class="icon(?: ph)?"/g) ?? []).length;
  assert.ok(icons >= moves.length, `${icons} icons for ${moves.length} rows`);
  assert.equal(/src=""/.test(html), false);
  for (const src of html.match(/<img class="icon" src="([^"]+)"/g) ?? []) {
    assert.match(src, /images\/(icons|art)\/\d+\.png/);
  }
  // A move that only changes cards shows the cards, not the piece that is
  // staying on: four of one card is one icon, not four.
  const carded = moves.find((m) => m.kind === 'cards');
  if (carded) {
    const one = render([carded]);
    assert.equal((one.match(/class="icon(?: ph)?"/g) ?? []).length, 1);
  }
});

test('the cost is on the row: the other goal is shown when a move moves it', () => {
  const html = render();
  // Both goals are labelled where a move changes them, gains and losses
  // alike, which is what makes a trade readable as a trade.
  assert.match(html, /Melee Damage/);
  assert.ok(/gain/.test(html) && /loss/.test(html), 'the full-effect counts are there');
});

test('the count in the foot splits free swaps from trades', () => {
  const free = moves.filter((m) => !m.sidegrade).length;
  const trades = moves.length - free;
  const html = render();
  assert.ok(html.includes(`${free} free`), `expected "${free} free"`);
  if (trades > 0) {
    assert.ok(html.includes(`${trades} trade`), `expected "${trades} trade"`);
    assert.match(html, /Sidegrade/);
  }
});

test('nothing to suggest says so, and says what to loosen', () => {
  const html = render([]);
  assert.match(html, /Nothing within these options gives more Melee Damage %/);
  assert.match(html, /class, level or refine/);
  assert.equal(/<li>/.test(html), false);
  assert.ok(html.includes('0 free'));
  // With nothing locked, a lock is not offered as the reason.
  assert.equal(/unlocking/.test(html), false);
});

test('a lock is named as a reason only when something is locked', () => {
  assert.match(render([], 1), /unlocking the locked slot/);
  assert.match(render([], 3), /unlocking one of the 3 locked slots/);
  // Never on a list that found something: the answer is the list.
  assert.equal(/unlocking/.test(render(moves, 3)), false);
});

test('no stray zeroes anywhere in the list', () => {
  // The `{n && <div/>}` trap: a falsy number renders as a bare 0.
  for (const html of [render(), render([])]) {
    assert.equal(/>0</.test(html.replace(/>0 free</g, '>zero free<')), false);
  }
});
