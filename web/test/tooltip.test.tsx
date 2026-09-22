/**
 * The item tooltip, rendered on its own.
 *
 * Two regressions live here, both of which showed a number that was not a
 * number the item has:
 *
 *  - `{(item.atk || item.matk || item.def || item.mdef) && <div/>}` renders a
 *    bare `0` when every figure is zero, because the `||` chain evaluates to
 *    0 and React prints it. Every card and every shadow piece hit this.
 *  - A card has no refine, so the host's refine must drive its per-refine
 *    lines without appearing as "+9" on the card's own name.
 *
 * Run with: npm test (bundled through esbuild, since this file has JSX)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { bindBaseStatIds } from '@sim';
import type { Dataset, Item, RollData, SetRecord, StatDef } from '@sim';
import { ItemCard } from '../src/components/ItemTooltip';

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
  classes: [],
  classRules: null,
  rolls: j<RollData>('rolls.json'),
};

const render = (item: Item, refine = 0, hostRefine = 0) =>
  renderToStaticMarkup(
    <ItemCard item={item} refine={refine} hostRefine={hostRefine} dataset={dataset} />,
  );

/** The block between the head and the level line, where the stray 0 landed. */
const afterHead = (html: string) => {
  const start = html.indexOf('</div></div>');
  const end = html.indexOf('tip-req');
  return html.slice(start, end > start ? end : start + 200);
};

test('an item with no ATK or DEF prints no stat block at all', () => {
  const offenders: string[] = [];
  const noStats = itemList.filter(
    (i) => !i.atk && !i.matk && !i.def && !i.mdef && i.equip_slots.length > 0);
  assert.ok(noStats.length > 100, 'plenty of items have none of the four');

  for (const item of noStats.slice(0, 400)) {
    const gap = afterHead(render(item));
    if (/>0</.test(gap) || /<\/div>0/.test(gap)) offenders.push(item.name);
  }
  assert.deepEqual(offenders.slice(0, 5), [],
    'a bare 0 rendered where the ATK/DEF block would be');
});

test('an item that does have them still shows them', () => {
  const cape = itemList.find((i) => i.name === 'Venus Cape')!;
  const html = render(cape, 6);
  assert.match(html, /DEF <b>15<\/b>/);
  assert.match(html, /MDEF <b>5<\/b>/);
  assert.equal(/ATK <b>/.test(html), false, 'and omits the two it has not');
});

test('a card never shows a refine on its own name', () => {
  // The refine belongs to the piece the card sits in, and that piece's own
  // hover already shows it. "+9 Dream of Kings Card" claims the card is +9.
  const card = itemList.find((i) => i.kind === 'Card')!;
  const html = render(card, 0, 9);
  assert.equal(/<em>\+9 <\/em>/.test(html), false, 'no "+9" on the card');
  assert.ok(html.includes(card.name), 'the name itself is still there');
});

test('but the host refine still drives the card scaling lines', () => {
  const card = itemList.find((i) =>
    i.kind === 'Card'
    && i.refine.per_refine.some((g) =>
      g.effects.some((e) => e.parsed && e.stat_ids?.length)))!;
  assert.ok(card, 'need a card that scales off refine');

  const unrefined = render(card, 0, 0);
  const refined = render(card, 0, 8);
  assert.notEqual(unrefined, refined, 'the host refine must change what is shown');
  assert.match(refined, /refines? of the piece|per refine of the piece/i);
});

test('stacked cards show the total they add, with the single figure alongside', () => {
  // Minorous Card: HP +20%, SP -15%. Two of them is +40% / -30%.
  const garb = itemList.find((i) => i.name === 'World Eater Garb')!;
  const minorous = itemList.find((i) => i.name === 'Minorous Card')!;
  const html = renderToStaticMarkup(
    <ItemCard item={garb} cards={[minorous, minorous]} dataset={dataset} />);
  assert.match(html, /HP \+40%<span class="tip-dim"> \(HP \+20% each\)/);
  assert.match(html, /SP -30%/);
});

test('an off-hand weapon halves its race and size lines, and says so', () => {
  const weapon = itemList.find((i) => i.kind === 'Weapon' && i.card_slots >= 2
    && i.equip_slots.includes('Weapon') && !i.equip_slots.includes('Weapon (two-handed)'))!;
  const murderer = itemList.find((i) => i.name === 'Bloody Murderer Card')!;
  const cards = [murderer, murderer];
  const offhand = renderToStaticMarkup(
    <ItemCard item={weapon} cards={cards} dataset={dataset} offhand />);
  // 18% × 2 cards × ½ = 18%.
  assert.match(offhand, /\+18%<span class="tip-dim"> \([^)]*\+18% each, halved in the off hand\)/);
  // The main hand keeps the full 36%.
  const main = renderToStaticMarkup(<ItemCard item={weapon} cards={cards} dataset={dataset} />);
  assert.match(main, /\+36%/);
  assert.equal(/halved/.test(main), false);
});

test('a refinable piece does show its own refine', () => {
  const armor = itemList.find((i) => i.refineable && i.kind !== 'Card')!;
  assert.match(render(armor, 7), /<em>\+7 <\/em>/);
});

test('a card shows no level requirement, because it has none to show', () => {
  // "No level requirement" on a card reads as a property of the card. The
  // level belongs to the piece it is compounded into.
  const card = itemList.find((i) => i.kind === 'Card' && i.weight > 0)!;
  const html = render(card);
  assert.equal(/level requirement/i.test(html), false);
  assert.equal(/Requires level/.test(html), false);
  assert.match(html, /Weight \d/, 'but its weight is real and stays');

  // A worn piece still says it, both ways round.
  const gated = itemList.find((i) => i.kind !== 'Card' && i.required_level > 0)!;
  assert.match(render(gated), /Requires level \d+/);
  const ungated = itemList.find((i) =>
    i.kind !== 'Card' && i.equip_slots.length > 0 && i.required_level === 0)!;
  if (ungated) assert.match(render(ungated), /No level requirement/);
});
