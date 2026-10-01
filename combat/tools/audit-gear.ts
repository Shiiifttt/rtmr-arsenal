/**
 * Audit the planner's item data for what a gear search would silently miss
 * (the project owner, 2026-10-01: "validate items and set bonuses so we dont
 * miss them in the future"). Found that day: the Sin Daggers' set bonus
 * (Definitive Dagger Cooldown -0.5s) lost to a heading without "Set", the
 * Hrafnsmal set with no bonus lines, the Revenant Ebel Card wearable by
 * every class.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/audit-gear.ts \
 *     [--class "Night Raven"] [--md out.md]
 *
 * --class: also list every unread line on gear that class can wear that
 * names one of its kit's skills (an autocast, an area, a cooldown the
 * parser left as prose) -- what the kit must read itself or the search
 * values at nothing.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { plannerDataset } from '../src/data.ts';
import { kitFor } from '../src/kits/index.ts';
import { canEquip, type Item } from '../../sim/src/index.ts';

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const data = plannerDataset();
const out: string[] = [];
const section = (title: string, rows: string[]) => {
  out.push(`## ${title} (${rows.length})`, '', ...(rows.length ? rows.map((r) => `- ${r}`) : ['- none']), '');
};

type Effect = { text: string; parsed?: boolean };
const unread = (effects: Effect[] | undefined) => (effects ?? []).filter((e) => e.parsed === false).map((e) => e.text);
/** Every line the parser read or left, wherever it sits on the item. */
function lines(i: Item): { where: string; text: string; parsed: boolean }[] {
  const x = i as Item & {
    effects?: Effect[]; piece_bonus?: Effect[]; conditional?: { condition: string; effects: Effect[] }[];
    refine?: { per_refine?: { effects: Effect[] }[]; thresholds?: { at: number[]; effects: Effect[] }[] };
  };
  const all: { where: string; text: string; parsed: boolean }[] = [];
  for (const e of x.effects ?? []) all.push({ where: 'item', text: e.text, parsed: e.parsed !== false });
  for (const e of x.piece_bonus ?? []) all.push({ where: 'piece', text: e.text, parsed: e.parsed !== false });
  for (const c of x.conditional ?? []) for (const e of c.effects) all.push({ where: `if ${c.condition}`, text: e.text, parsed: e.parsed !== false });
  for (const r of x.refine?.per_refine ?? []) for (const e of r.effects) all.push({ where: 'per refine', text: e.text, parsed: e.parsed !== false });
  for (const t of x.refine?.thresholds ?? []) for (const e of t.effects) all.push({ where: `+${t.at.join('/')}`, text: e.text, parsed: e.parsed !== false });
  return all;
}

// 1. Set wording in the text, no set made of it.
const setWords = /(^|\n)[^\n]*\bSet\b[^\n]*:\s*\n|\nSet Bonus:/i;
section('Items whose text has a set heading but belong to no set', data.itemList
  .filter((i) => setWords.test(i.description ?? '') && !((i as Item & { sets?: number[] }).sets ?? []).length)
  .map((i) => `${i.name} (${i.id}): "${/([^\n]*)\n[^\n]*\n?Set Bonus:/i.exec(i.description ?? '')?.[1] ?? 'set heading'}"`));

// 2. Sets with nothing in them.
section('Sets with no bonus at all (no set bonus, no refine lines)', data.sets
  .filter((s) => !s.set_bonus.length && !(s.set_refine?.per_set_refine?.length) && !(s.set_refine?.thresholds?.length))
  .map((s) => `${s.name}: ${s.member_ids.map((id) => data.items.get(id)?.name).join(' + ')}`));

// 3. Set bonus lines the parser left as prose.
section('Set bonus lines left unread', data.sets.flatMap((s) => unread(s.set_bonus as Effect[]).map((t) => `${s.name}: "${t}"`)));

// 4. Single conditions that look like a set and read nothing (the Sin Daggers before the fix).
section('Item conditions with every line unread', data.itemList.flatMap((i) => {
  const c = (i as Item & { conditional?: { condition: string; effects: Effect[] }[] }).conditional ?? [];
  return c.filter((x) => x.effects.length && x.effects.every((e) => e.parsed === false))
    .map((x) => `${i.name}: "${x.condition}" -> ${x.effects.map((e) => `"${e.text}"`).join(', ')}`);
}));

// 5. Cards that may be class-locked with no rule saying so.
const classNames = Object.keys(data.classRules?.skills ?? {});
section('Cards that name a class or say "character bound", with no class rule', data.itemList
  .filter((i) => i.kind === 'Card' && !data.classRules?.items?.[String(i.id)]
    && (/character bound/i.test(i.description ?? '') || classNames.some((c) => i.name.startsWith(`${c} `))))
  .map((i) => `${i.name} (${i.id}): ${(i.description ?? '').split('\n').filter(Boolean).slice(0, 3).join(' / ')}`));

// 6. Lines read as parsed that carry a number but feed no stat and no skill: two
// tooltip lines run together (Ogretooth's "Permanent Endure Effect ASPD Limit +2")
// or a stat the planner has no key for. Wherever the line sits (piece, condition,
// refine, set), and a skill line counts only if it named a real skill: "All 4
// Skills Damage +10%" (Master Thief) read as a skill called "All 4" before.
type Read = Effect & { stat_keys?: string[] | null; skills?: string[] | null; sets_element?: string };
const feedsNothing = (e: Read) => e.parsed !== false && !(e.stat_keys ?? []).length && !(e.skills ?? []).length
  && !e.sets_element && /[+-]\s*\d/.test(e.text);
const readLines = (i: Item) => {
  const x = i as Item & { effects?: Read[]; piece_bonus?: Read[]; conditional?: { condition: string; effects: Read[] }[];
    refine?: { per_refine?: { effects: Read[] }[]; thresholds?: { at: number[]; effects: Read[] }[] } };
  return [
    ...(x.effects ?? []).map((e) => ['item', e] as const), ...(x.piece_bonus ?? []).map((e) => ['piece', e] as const),
    ...(x.conditional ?? []).flatMap((c) => c.effects.map((e) => [`if ${c.condition}`, e] as const)),
    ...(x.refine?.per_refine ?? []).flatMap((r) => r.effects.map((e) => ['per refine', e] as const)),
    ...(x.refine?.thresholds ?? []).flatMap((t) => t.effects.map((e) => [`+${t.at.join('/')}`, e] as const)),
  ];
};
section('Read lines with a number that feed nothing (merged lines, unknown stats)', [
  ...data.itemList.flatMap((i) => readLines(i).filter(([, e]) => feedsNothing(e)).map(([w, e]) => `${i.name} [${w}]: "${e.text}"`)),
  ...data.sets.flatMap((s) => [
    ...(s.set_bonus as Read[]),
    ...(s.set_refine?.per_set_refine ?? []).flatMap((r) => r.effects as Read[]),
    ...(s.set_refine?.thresholds ?? []).flatMap((t) => t.effects as Read[]),
  ].filter(feedsNothing).map((e) => `${s.name} [set]: "${e.text}"`)),
]);

// 7. Per class: unread lines naming the kit's skills, on gear the class can wear.
const cls = one('class');
if (cls) {
  const skills = Object.keys(kitFor(cls).maxLevels()).filter((n) => n.length > 4);
  const rx = new RegExp(`\\b(${skills.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
  section(`${cls}: unread lines naming its skills (the kit must read these, or they count for nothing)`, data.itemList
    .filter((i) => canEquip(i, cls, data.classRules))
    .flatMap((i) => lines(i).filter((l) => !l.parsed && rx.test(l.text)).map((l) => `${i.name} [${l.where}]: "${l.text}"`)));
}

const text = `# Gear data audit (${new Date().toISOString().slice(0, 10)})\n\n${out.join('\n')}`;
if (one('md')) writeFileSync(resolve(process.cwd(), one('md')!), text);
console.log(text);
