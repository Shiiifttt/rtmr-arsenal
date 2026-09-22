/**
 * The formatter turns a parsed effect back into a readable line.
 *
 * These guard a specific failure: once the parser learned to read
 * "Every 9 base AGI gives you 1 extra AGI", the tooltip started printing the
 * parsed half ("AGI +1") and dropping the condition, promising a flat bonus
 * the item does not give. Anything that gates or scales a value has to be
 * printed with it.
 *
 * Run with: node --experimental-strip-types --test sim/test/format.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { effectLine } from '../src/index.ts';
import type { Effect, Item } from '../src/types.ts';

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');
const items: Item[] = JSON.parse(
  readFileSync(resolve(DATA, 'items/all.json'), 'utf8'));

test('an unreadable effect falls back to what the database said', () => {
  const eff: Effect = { text: 'Disables skills use', parsed: false };
  assert.equal(effectLine(eff), 'Disables skills use');
});

test('a plain effect reads as stat and value', () => {
  const eff: Effect = {
    text: 'ATK +5%', stat: 'ATK', value: 5, unit: '%', parsed: true,
  };
  assert.equal(effectLine(eff), 'ATK +5%');
  assert.equal(effectLine({ ...eff, value: -5 }), 'ATK -5%');
});

test('base-stat scaling keeps its condition', () => {
  const eff: Effect = {
    text: 'Every 9 base AGI gives you 1 extra AGI.',
    stat: 'AGI', value: 1, unit: null, parsed: true,
    per_base_stat: { per: 9, stat: 'AGI' },
  };
  assert.equal(effectLine(eff), 'AGI +1 per 9 base AGI');
});

test('set-refine scaling says so', () => {
  const eff: Effect = {
    text: 'MDEF +1', stat: 'MDEF', value: 1, unit: null, parsed: true,
    per_set_refine: 2,
  };
  assert.equal(effectLine(eff), 'MDEF +1 per 2 set refines');
});

test('a per-refine suffix is dropped only where the heading already says it', () => {
  const eff: Effect = {
    text: 'Critical +2 per refine', stat: 'Critical', value: 2, unit: null,
    parsed: true, per_refine: 1,
  };
  assert.equal(effectLine(eff), 'Critical +2 per refine');
  // Inside a "Per refine" section the suffix would be said twice.
  assert.equal(effectLine(eff, 1, true), 'Critical +2');
  assert.equal(effectLine(eff, 7, true), 'Critical +14');
});

test('a gated effect carries its gate', () => {
  const eff: Effect = {
    text: 'Bonus AGI +3 if Base Stat is 99', stat: 'AGI', value: 3,
    unit: null, parsed: true,
    requires: { type: 'base_stat', stat: 'AGI', min: 99 },
  };
  assert.equal(effectLine(eff), 'AGI +3 (needs base AGI 99)');

  const levelled: Effect = {
    text: 'ATK +5%', stat: 'ATK', value: 5, unit: '%', parsed: true,
    requires: { type: 'base_level', min: 130 },
  };
  assert.equal(effectLine(levelled), 'ATK +5% (needs base level 130)');
});

test('no real item prints a scaling effect as if it were flat', () => {
  // The regression, checked against the whole dataset rather than one item:
  // every effect that scales off something must say so when rendered.
  const offenders: string[] = [];
  for (const item of items) {
    for (const eff of [...item.effects, ...item.piece_bonus]) {
      if (!eff.per_base_stat && !eff.per_set_refine && !eff.requires) continue;
      const line = effectLine(eff);
      if (!/per |needs /.test(line)) {
        offenders.push(`${item.name}: ${eff.text} -> ${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'these lost their qualifier when rendered');
});

test('Gleipnir renders its real rule, not a flat bonus', () => {
  const gleipnir = items.find((i) => i.name === 'Gleipnir')!;
  const lines = gleipnir.effects.map((e) => effectLine(e));
  assert.ok(
    lines.some((l) => l === 'AGI +1 per 9 base AGI'),
    `expected the scaling rule, got: ${JSON.stringify(lines)}`,
  );
  assert.equal(
    lines.includes('AGI +1'), false,
    'a bare "AGI +1" would promise a flat bonus it does not give',
  );
});
