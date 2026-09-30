/**
 * A class's danger database, readable: a threat list (tools/build-threats.ts
 * --out) as markdown, area by area -- each monster's outcome, the skills that
 * hurt or kill, how often they come, how much was dodged and with what.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/threat-report.ts \
 *     --in data/threats-revenant.json --md data/threats-revenant.md
 *
 * A threat is listed when it killed at least once, or a landed hit costs a
 * tenth of Max HP or more, or it deals a tenth or more of the damage taken.
 * Danger: lethal (a share of the deaths, or a hit worth half your Max HP),
 * heavy (a quarter), else notable.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readJSON } from '../src/data.ts';
import type { ThreatFile } from '../src/threats.ts';

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const file = readJSON<ThreatFile>(resolve(process.cwd(), one('in') ?? 'data/threats.json'));
const hp = file.reference.maxHp;
const pc = (x: number) => `${Math.round(100 * x)}%`;
const k1 = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

const out: string[] = [
  `# Danger database: ${file.reference.className}`, '',
  `Reference build: ${file.reference.name} (Lv${file.reference.level}, ${hp.toLocaleString('en-US')} Max HP, ${file.reference.element} armour), `
    + `${file.iterations} fights a monster, built ${file.builtAt.slice(0, 10)}. Damage is this build's; how often a skill comes and what dodges it are the monster's.`,
  '', 'Danger: **lethal** = it killed, or one landed hit is half your Max HP; **heavy** = a quarter; notable = a tenth, or a tenth of all damage taken.', '',
];
const groups = [...new Set(file.monsters.flatMap((m) => m.groups))];
for (const g of groups) {
  const mobs = file.monsters.filter((m) => m.groups[0] === g).sort((a, b) => b.lossRate - a.lossRate || a.winRate - b.winRate);
  if (!mobs.length) continue;
  out.push(`## ${g}`, '', '| Monster | Wins | Deaths | Time | Dangerous skills (danger, hit, per min, dodged) | Dodges used per fight |', '|---|---|---|---|---|---|');
  for (const m of mobs) {
    const total = m.threats.reduce((a, t) => a + t.perMin * (1 - t.dodged) * t.refDamage, 0) || 1;
    const rows = m.threats.filter((t) => t.deathShare > 0 || t.refDamage >= 0.1 * hp
      || (t.perMin * (1 - t.dodged) * t.refDamage) / total >= 0.1).slice(0, 5).map((t) => {
      const danger = t.deathShare > 0 || t.refDamage >= 0.5 * hp ? '**lethal**' : t.refDamage >= 0.25 * hp ? '**heavy**' : 'notable';
      const status = t.statuses.length ? ` +${t.statuses.map((x) => x.sc).join('/')}` : '';
      const cast = t.castMs ? ` ${(t.castMs / 1000).toFixed(1)}s cast` : '';
      const deaths = t.deathShare > 0 ? `, ${pc(t.deathShare)} of deaths` : '';
      return `${t.source}${status}: ${danger}, ${k1(t.refDamage)}${t.ticks > 1 ? ` x${t.ticks}` : ''}${cast}, ${t.perMin}/min, ${pc(t.dodged)} dodged${deaths}`;
    });
    const dodges = Object.entries(m.defenses ?? {}).filter(([, v]) => v >= 0.05).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
    out.push(`| ${m.name}${m.boss ? ' (MVP)' : ''} | ${pc(m.winRate)} | ${pc(m.lossRate)} | ${m.seconds}s | ${rows.join('<br>') || 'nothing dangerous'} | ${dodges} |`);
  }
  out.push('');
}
const md = one('md');
if (md) writeFileSync(resolve(process.cwd(), md), `${out.join('\n')}\n`);
console.log(out.join('\n'));
