/**
 * Download the skill icons the class kits use into images/skills/<ICON>.png,
 * from the RTM database site (the project owner's go-ahead, 2026-10-01). The
 * icon code is the crawl's (data/raw/db-skills.json 'icon': LG_MOONSLASHER).
 * Files already there are kept.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/fetch-skill-icons.ts
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readJSON, REPO } from '../src/data.ts';
import { KITS } from '../src/kits/index.ts';

const SITE = 'https://rtm-database.pages.dev/assets/skills';
const out = resolve(REPO, 'images/skills');
mkdirSync(out, { recursive: true });

const raw = readJSON<{ cols: string[]; rows: unknown[][] }>(resolve(REPO, 'data/raw/db-skills.json'));
const col = (k: string) => raw.cols.indexOf(k);
const iconOf = new Map<string, string>();
for (const r of raw.rows) {
  const name = String(r[col('name')]); const icon = r[col('icon')];
  if (typeof icon === 'string' && icon && !iconOf.has(name)) iconOf.set(name, icon);
}

// Every skill a kit knows, plus the ones its actions are named after.
const names = new Set<string>();
for (const k of Object.values(KITS)) {
  for (const n of Object.keys(k.maxLevels())) names.add(n);
  for (const a of k.kit.actions) names.add(a.id);
}
// And what data/rotations.json lists that no kit names (the Satsujin's Focus bolts before the pull).
const rotPath = resolve(REPO, 'data/rotations.json');
if (existsSync(rotPath)) {
  for (const c of Object.values(readJSON<{ classes: Record<string, { buffs: { skill: string }[] }> }>(rotPath).classes)) {
    for (const b of c.buffs) names.add(b.skill);
  }
}
const icons = [...new Set([...names].map((n) => iconOf.get(n)).filter((x): x is string => !!x))];
let got = 0; let had = 0; const missing: string[] = [];
for (const icon of icons) {
  const path = resolve(out, `${icon}.png`);
  if (existsSync(path)) { had++; continue; }
  const res = await fetch(`${SITE}/${icon}.png`);
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('png')) { missing.push(icon); continue; }
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  got++;
}
console.log(`${icons.length} icons: ${got} fetched, ${had} already there, ${missing.length} missing${missing.length ? `: ${missing.join(', ')}` : ''}`);
