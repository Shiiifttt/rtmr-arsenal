/**
 * The playbook the automatic defence fills in by itself (option defense
 * 'auto', src/kits/defense.ts): for one build, every damaging skill of every
 * monster in the groups, how the cast reads (shape, threat, damage, the
 * chance it lands) and the answers in the order they would be tried -- the
 * first one listed is taken when it is ready. Read it to spot a skill that
 * needs an explicit entry in data/playbook.json.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/defense-book.ts \
 *     --profile profiles/kingslayer-current.json --vs lair4,rachel5 [--hp 1.0] [--md out.md]
 *
 * Read at full resources (every tool off cooldown, full SP) and --hp share
 * of Max HP (default full).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildFighter, resolveBuild, type Profile } from '../src/character.ts';
import { findMobs, plannerDataset, readJSON } from '../src/data.ts';
import { actionById, newFight } from '../src/engine.ts';
import { buildMonster } from '../src/monster.ts';
import { priorityPolicy } from '../src/tas.ts';
import { kitFor } from '../src/kits/index.ts';
import { answerOrder, FAST_CAST_MS, readThreat, snapMs, toolCost } from '../src/kits/defense.ts';

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

const data = plannerDataset();
const profile = readJSON<Profile>(resolve(process.cwd(), one('profile') ?? 'profiles/satsujin-example.json'));
const build = await resolveBuild(profile.build, data);
const k = kitFor(build.className);
const f = await buildFighter(profile, { passives: k.passives, aliases: k.aliases, maxLevels: k.maxLevels() });
const hpShare = Number(one('hp') ?? 1);
const k1 = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

const out: string[] = [`# Automatic playbook: ${profile.name ?? one('profile')}`, '',
  `${build.className}, HP ${f.maxHp.toLocaleString('en-US')}, SP ${f.maxSp.toLocaleString('en-US')}, flee ${f.flee}, Auto Guard ${f.autoGuard ?? 0}. `
  + `Read at ${Math.round(hpShare * 100)}% HP, everything off cooldown. Tools: ${[...new Set(k.tools.map((t) => t.action))].join(', ')}.`, '',
  'Answers in the order tried; the first is taken when ready, the rest are fallbacks. (R) = reserved: only for a lethal cast, after all else. '
  + 'Snap casts (bar of 300 ms or less) are answered only when idle or walking; for a lethal one the character stays ready while it is due.', ''];
const seen = new Set<string>();
for (const q of (one('vs') ?? 'rachel5').split(',')) {
  for (const row of findMobs(q.trim())) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    const m = buildMonster(row);
    const fight = newFight(f, m, k.kit, priorityPolicy, { seed: 1, limitMs: (m.boss ? 600 : 300) * 1000, options: { ...profile.options, defense: 'auto' } });
    fight.t = 2000;
    fight.me.hp = Math.max(1, Math.round(hpShare * f.maxHp));
    fight.me.cds = {};
    const rows: string[] = [];
    for (const s of m.skills) {
      if (s.type === 'none' || s.targets === 'self' || rows.some((r) => r.startsWith(`| ${s.name} |`))) continue;
      fight.mob.cast = { skill: s, endsAt: fight.t + s.castMs };
      const r = readThreat(fight, s, m);
      const { groups, source } = answerOrder(fight, s, m, r);
      const answers: string[] = [];
      if (r.level !== 'light' && !(s.avoid.includes('diag') && profile.options?.diagonal !== false)) {
        for (const g of groups) {
          const here = k.tools.filter((t) => g.includes(t.way))
            .map((t) => ({ t, at: t.plan(fight, s, m, r) }))
            .filter((x) => x.at !== null && actionById(fight, x.t.action))
            .map((x) => ({ ...x, c: toolCost(fight, x.t, s, r, x.at!) }))
            .sort((a, b) => a.c - b.c);
          for (const x of here) answers.push(`${x.t.action}${x.t.reserve ? ' (R)' : ''}`);
        }
      }
      // Too fast to answer from the bar: put down ahead when due (defense.ts preDue).
      const pre = k.tools.filter((t) => t.pre && t.pre.answers(s) && (!t.pre.on || t.pre.on(fight)) && s.castMs <= FAST_CAST_MS
        && s.ai.rate >= 0.5 && s.type !== 'status' && r.dmg >= t.pre.minShare * fight.me.hp).map((t) => `pre-empt ${t.action}; `).join('');
      // A snap cast is answered only when idle or walking; a lethal one is waited for (Stay ready).
      const snap = s.castMs <= snapMs(fight)
        ? (r.level === 'lethal' || (r.level === 'heavy' && profile.options?.stayReadyFor === 'heavy') ? 'snap: stays ready; ' : 'snap: only if idle; ')
        : '';
      const what = snap + pre + (r.level === 'light' ? 'tank' : s.avoid.includes('diag') && profile.options?.diagonal !== false ? 'stand diagonal'
        : answers.length ? answers.join(' → ') : 'nothing works: tank');
      rows.push(`| ${s.name} | ${(s.castMs / 1000).toFixed(1)}s | ${s.type} ${s.targets} | ${k1(r.dmg)} (${Math.round((r.dmg / fight.me.hp) * 100)}%) | ${Math.round(r.land * 100)}% | ${r.archetype} | ${r.level} | ${source === 'playbook' ? 'playbook.json' : 'auto'} | ${what} |`);
    }
    fight.mob.cast = null;
    if (!rows.length) continue;
    out.push(`## ${m.name}`, '', '| Skill | Cast | Kind | Damage (of HP) | Lands | Shape | Threat | Order from | Answers |',
      '|---|---|---|---|---|---|---|---|---|', ...rows, '');
  }
}
const md = one('md');
if (md) { writeFileSync(resolve(process.cwd(), md), `${out.join('\n')}\n`); console.log(`wrote ${md}`); } else console.log(out.join('\n'));
