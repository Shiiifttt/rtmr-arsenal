/**
 * Every item's autocasts as the sim reads them (autocast.ts), for checking
 * against the tooltips: what each one casts, how often, on what, and where
 * the numbers came from -- and every autocast line nothing could read.
 *
 *   node --experimental-strip-types --import ./register.mjs tools/autocast-audit.ts [--refine 7] [--luk 100] [--out file.md] [--item name]
 *
 * Stats are a flat 100 in everything (base LUK too) unless given; every
 * skill is at its max level, as the sim plays them.
 */
import { writeFileSync } from 'node:fs';

import { describeAutocast, genericGap, readAutocasts } from '../src/autocast.ts';
import { plannerDataset, skillRows } from '../src/data.ts';
import type { Stats } from '../src/model.ts';

const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const refine = Number(arg('refine') ?? 7);
const luk = Number(arg('luk') ?? 100);
const only = arg('item')?.toLowerCase();

const data = plannerDataset();
const stats: Stats = { str: 100, agi: 100, vit: 100, int: 100, dex: 100, luk };
const maxOf = new Map(skillRows().map((r) => [r.name, r.max]));
const levels = Object.fromEntries([...maxOf].map(([n, m]) => [n, m]));
const maxLevel = (s: string) => maxOf.get(s) ?? 1;

const lines: string[] = [`# Autocasts as read (refine +${refine}, LUK ${luk}, skills at max)`, ''];
let items = 0; let casts = 0; let unread = 0; let noEffect = 0;
for (const it of data.itemList) {
  const d = it.description ?? '';
  const onCast = (it as { on_cast?: unknown[] }).on_cast ?? [];
  if (!/auto-?\s?cast/i.test(d) && !onCast.length) continue;
  if (only && !it.name.toLowerCase().includes(only)) continue;
  const notes: string[] = [];
  const list = readAutocasts([{ itemId: it.id, refine, card: it.kind === 'Card' }], data, { stats, baseStats: stats, levels, maxLevel }, notes);
  items++;
  lines.push(`## ${it.name} (${it.id})`);
  for (const a of list) {
    casts++;
    const gaps = a.skills.map((s) => [s, genericGap(s)] as const).filter(([, g]) => g);
    if (gaps.length) noEffect++;
    lines.push(`- ${describeAutocast(a)}${gaps.length ? `  -- generic: ${gaps.map(([s, g]) => `${s}: ${g}`).join('; ')}` : ''}`);
  }
  for (const n of notes) { unread++; lines.push(`- UNREAD ${n.replace(/^autocast not read: [^:]+: /, '')}`); }
  lines.push('');
}
lines.splice(1, 0, `${items} items, ${casts} autocasts read (${noEffect} cast a skill the generic cast cannot do -- fine where a class kit has it), ${unread} lines unread.`, '');
const out = arg('out');
if (out) writeFileSync(out, `${lines.join('\n')}\n`);
else console.log(lines.join('\n'));
console.error(`${items} items, ${casts} autocasts, ${noEffect} generic gaps, ${unread} unread`);
