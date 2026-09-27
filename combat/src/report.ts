/** A summary as text: the verdict first, then the parse. */
import type { Fighter, Monster } from './model.ts';
import type { Summary } from './sim.ts';

const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pad = (s: string, w: number) => s.padEnd(w);
const lpad = (s: string, w: number) => s.padStart(w);

export function fighterSheet(f: Fighter): string {
  const s = f.stats;
  return [
    `${f.name} — ${f.className} Lv${f.level}`,
    `  STR ${s.str}  AGI ${s.agi}  VIT ${s.vit}  INT ${s.int}  DEX ${s.dex}  LUK ${s.luk}`,
    `  HP ${n0(f.maxHp)}  SP ${n0(f.maxSp)}  ASPD ${f.aspd}  HIT ${f.hit}  FLEE ${f.flee}  PD ${f.perfectDodge}  CRIT ${f.critRate}`,
    `  weapon ${f.weapon ? `${f.weapon.name} +${f.weapon.refine} (${f.weapon.atk} ATK, Lv${f.weapon.level})` : 'none'}`
      + `  equip ATK ${f.equipAtk}  ATK% ${f.atkPercent}  mastery ${f.masteryAtk}  pen ${f.defPen}`
      + `  melee% ${f.dmg.melee_damage ?? 0}  crit dmg ${f.critDamage}%`,
    `  DEF ${f.def}+${f.softDef}  MDEF ${f.mdef}+${f.softMdef}  leech ${f.leech.hpRate}%x${f.leech.hpPower}%${f.leech.hpPerHit ? ` +${f.leech.hpPerHit} HP/hit` : ''}${f.leech.spPerHit ? ` +${f.leech.spPerHit} SP/hit` : ''}`,
  ].join('\n');
}

export function formatSummary(sum: Summary, m: Monster): string {
  const out: string[] = [];
  const dummy = !!m.dummy;
  const head = `${m.name} (Lv${m.level} ${m.size} ${m.race} ${m.element}${m.elementLevel}${m.boss ? ', boss' : ''}`
    + `${dummy ? '' : `, ${n0(m.hp)} HP, DEF ${m.def} MDEF ${m.mdef}`})`;
  out.push(`== ${head}`);
  if (dummy) {
    out.push(`   DPS test: ${n0(sum.dps)} damage per second over ${sum.iterations} runs`);
  } else {
    const verdict = sum.winRate >= 0.9 ? 'BEATABLE' : sum.winRate >= 0.5 ? 'RISKY' : 'NOT YET';
    out.push(`   ${verdict}: wins ${pct(sum.winRate)} of ${sum.iterations}`
      + ` (lost ${sum.losses}, stalemate ${sum.stalemates}`
      + `${sum.stalemates ? `: ${Object.entries(sum.stalls).map(([k, v]) => `${k} x${v}`).join(', ')}` : ''})`);
    if (sum.ttk) {
      out.push(`   time to kill: median ${sum.ttk.p50.toFixed(1)}s  (p10 ${sum.ttk.p10.toFixed(1)}s, p90 ${sum.ttk.p90.toFixed(1)}s)`);
    }
    out.push(`   DPS ${n0(sum.dps)}   damage taken ${n0(sum.dtps)}/s   healed ${n0(sum.healed)} per fight`);
    const deaths = Object.entries(sum.deaths).sort((a, b) => b[1] - a[1]);
    if (deaths.length) out.push(`   killed by: ${deaths.map(([k, v]) => `${k} x${v}`).join(', ')}`);
  }

  for (const line of sum.analysis.read) out.push(`   · ${line.text}`);

  out.push('');
  out.push(`   ${pad('action', 20)}${lpad('uses', 7)}${lpad('damage', 14)}${lpad('share', 8)}${lpad('crit', 7)}${lpad('miss', 7)}`);
  for (const a of sum.actions) {
    out.push(`   ${pad(a.id, 20)}${lpad(a.uses.toFixed(1), 7)}${lpad(n0(a.damage), 14)}${lpad(pct(a.share), 8)}`
      + `${lpad(a.crit ? pct(a.crit) : '-', 7)}${lpad(a.miss ? pct(a.miss) : '-', 7)}`);
  }
  if (sum.sources.length) {
    out.push('');
    out.push(`   ${pad('taken from', 20)}${lpad('hits', 7)}${lpad('avoided', 9)}${lpad('damage', 12)}`);
    for (const s of sum.sources) {
      out.push(`   ${pad(s.id, 20)}${lpad(s.hits.toFixed(1), 7)}${lpad(s.avoided.toFixed(1), 9)}${lpad(n0(s.damage), 12)}`);
    }
  }
  const def = Object.entries(sum.defenses);
  if (def.length) out.push(`   dodges planned: ${def.map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')} per fight`);
  if (m.notes.length) out.push(`   notes: ${m.notes.join('; ')}`);
  out.push(`   (${sum.msPerFight.toFixed(1)} ms per fight)`);
  return out.join('\n');
}
