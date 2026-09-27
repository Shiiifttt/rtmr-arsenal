/**
 * Advice for one build against one monster, from its threat list
 * (threats.ts) and the damage formulas -- no fights, a few milliseconds.
 *
 * For every threat: what one landed application does to this build (mean and
 * top roll), how often one lands (the sim's cast rate and dodge share; your
 * own flee for swings), and whether it kills from full HP. Then the gear
 * levers that change that -- armour element, element / race resistance, Max
 * HP, status resistance, reflect immunity, flee -- each tried on a copy of
 * the build and kept only if it helps.
 */
import { readJSON, REPO } from './data.ts';
import { mobDamage, mobHitChance, perfectDodgeChance, statusResist } from './formulas.ts';
import type { Fighter, Monster } from './model.ts';
import { Rng } from './rng.ts';
import { sourceSkill, type Threat, type ThreatEntry } from './threats.ts';

export interface ThreatRead {
  source: string;
  type: Threat['type'];
  element: string;
  /** Damage of one landed application: mean and top roll. */
  mean: number;
  max: number;
  /** Lands per minute on this build. */
  landsPerMin: number;
  /** Share of Max HP per minute it takes off you. */
  pressure: number;
  /** Its top roll kills from full HP. */
  oneShot: boolean;
  /** Chance per landed cast of each bad status getting through. */
  statuses: { sc: string; chance: number }[];
  dodged: number;
  deathShare: number;
}

export interface Fix {
  kind: 'armor_element' | 'survive' | 'status' | 'reflect' | 'flee';
  text: string;
  /** Gear that gives it, where the item data says so. */
  items?: string[];
  /** One-shots it removes. */
  removes: string[];
  /** Change in damage taken per minute, as a share (negative is better). */
  change: number;
  /** What it is worth, for ranking: deaths it addresses plus damage it cuts. */
  value: number;
}

export interface Advice {
  monster: string;
  /** The reference build's record against it, from the threat list. */
  record: { winRate: number; lossRate: number; seconds: number } | null;
  threats: ThreatRead[];
  /** Max HP lost per minute to everything, undodged. */
  pressure: number;
  fixes: Fix[];
  play: string[];
  /** What smart swap changed for this fight, when on. */
  swap?: string[];
}

/** Statuses worth gear: they stop you acting or hurt a lot (kits/satsujin.ts BAD_STATUS). */
const BAD = new Set(['stone', 'stun', 'freeze', 'sleep', 'coma', 'burnt', 'silence', 'aeterna', 'bleeding', 'curse']);
const ELEMENTS = ['Neutral', 'Water', 'Earth', 'Fire', 'Wind', 'Poison', 'Holy', 'Dark', 'Ghost', 'Undead'];

const mean = new Rng(0, true);
/** The top of every roll. */
const top = { expect: true, between: (_lo: number, hi: number) => hi } as unknown as Rng;

function readThreat(f: Fighter, m: Monster, t: Threat): ThreatRead {
  const found = sourceSkill(m, t.source);
  const caster = found?.caster ?? m;
  const s = found?.skill;
  let avg = t.refDamage; let max = t.refDamage;
  let lands = t.perMin * (1 - t.dodged);
  if (t.kind === 'reflect') {
    avg = max = t.refDamage * (1 - Math.min(100, f.reflectReduce) / 100);
  } else if (s && t.type !== 'status' && t.type !== 'none') {
    avg = mobDamage(caster, f, s, mean);
    max = mobDamage(caster, f, s, top);
    if (t.kind === 'attack') {
      // Swings: your own flee and Perfect Dodge, not the reference build's.
      lands = t.perMin * mobHitChance(caster.hit, f.flee) * (1 - perfectDodgeChance(f.perfectDodge));
    }
  }
  const statuses = t.statuses.filter((e) => BAD.has(e.sc) && e.chance > 0).map((e) => ({
    sc: e.sc,
    chance: (e.sc === 'stone' || e.sc === 'freeze') && f.element === 'Undead'
      ? 0 : statusResist(f, e.sc, e.resist, e.chance, caster.level, caster.luk).chance,
  }));
  return {
    source: t.source, type: t.type, element: t.element,
    mean: Math.round(avg), max: Math.round(max),
    landsPerMin: lands,
    pressure: (lands * avg) / f.maxHp,
    oneShot: lands > 0 && max >= f.maxHp,
    statuses, dodged: t.dodged, deathShare: t.deathShare,
  };
}

function readAll(f: Fighter, m: Monster, e: ThreatEntry) {
  const threats = e.threats.map((t) => readThreat(f, m, t));
  return {
    threats,
    pressure: threats.reduce((a, t) => a + t.pressure, 0),
    oneShots: threats.filter((t) => t.oneShot).map((t) => t.source),
  };
}

export function advise(f: Fighter, m: Monster, e: ThreatEntry | null): Advice {
  if (!e) {
    return { monster: m.name, record: null, threats: [], pressure: 0, fixes: [],
      play: ['Not in the threat list yet: run tools/build-threats.ts with its area, or simulate it.'] };
  }
  const now = readAll(f, m, e);
  const fixes: Fix[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const k = (x: number) => (x >= 10_000 ? `${(x / 1000).toFixed(1)}k` : x.toLocaleString('en-US'));
  const change = (after: number) => (now.pressure ? after / now.pressure - 1 : 0);
  const removed = (after: string[]) => now.oneShots.filter((s) => !after.includes(s));
  // Worth: each threat's share of deaths, by how much of its top roll goes,
  // plus the cut to everything taken.
  const worth = (after: ThreatRead[], pressure: number) => -change(pressure) + now.threats.reduce((v, t, i) =>
    v + t.deathShare * Math.max(0, Math.min(1, 1 - (after[i]?.max ?? t.max) / Math.max(1, t.max))), 0);

  // Armour element: the best one, if it takes away a one-shot or a tenth of the damage.
  const el = bestArmourElement(f, m, e);
  const best = el ? { el, r: readAll({ ...f, element: el }, m, e) } : null;
  if (best) {
    const removes = removed(best.r.oneShots);
    // The threat it helps most: a one-shot it removes, else the biggest cut.
    const cut = (t: ThreatRead, i: number) => t.pressure - (best.r.threats[i]?.pressure ?? t.pressure);
    const lead = now.threats.find((t) => removes.includes(t.source))
      ?? [...now.threats].sort((a, b) => cut(b, now.threats.indexOf(b)) - cut(a, now.threats.indexOf(a)))[0];
    const after = best.r.threats.find((t) => t.source === lead?.source);
    const worse = best.r.threats.filter((t, i) => t.max > now.threats[i].max * 1.1 && t.landsPerMin > 0)
      .map((t) => t.source);
    fixes.push({
      kind: 'armor_element',
      text: `${best.el} armour: ${lead && after ? `${lead.source} ${k(lead.max)} → ${k(after.max)} at most` : ''}`
        + `${removes.length ? ` (no longer kills from full HP)` : ''}; damage taken ${signed(change(best.r.pressure))}`
        + `${worse.length ? `. Worse against ${worse.join(', ')}` : ''}`
        + `${best.el === 'Undead' ? '. Also immune to stone and freeze' : ''}.`,
      items: armorElementItems()[best.el],
      removes,
      change: change(best.r.pressure),
      value: worth(best.r.threats, best.r.pressure),
    });
  }

  // Each one-shot on its own: the resistance or Max HP that turns it into a hit you live through.
  for (const t of now.threats.filter((x) => x.oneShot)) {
    const survives = (g: Fighter) => readThreat(g, m, e.threats.find((x) => x.source === t.source)!).max < g.maxHp;
    const plus = (key: string) => needed((x) => survives({ ...f, res: { ...f.res, [key]: (f.res[key] ?? 0) + x } }));
    const ways: string[] = [];
    if (t.type !== 'none') {
      const ele = plus(`res_${t.element.toLowerCase()}`);
      if (ele !== null) ways.push(`+${ele}% ${t.element} resistance`);
      const race = plus(`res_race_${raceKeyOf(m.race)}`);
      if (race !== null) ways.push(`+${race}% resistance to ${m.race}`);
    }
    ways.push(`${k(t.max + 1)} Max HP (you have ${k(f.maxHp)})`);
    fixes.push({ kind: 'survive', text: `${t.source} hits up to ${k(t.max)}; to live through it: ${ways.join(', or ')}.`,
      removes: [t.source], change: 0, value: t.deathShare + 0.01 });
  }

  // Statuses that land and would stop you.
  const worst = new Map<string, { chance: number; from: string; perMin: number }>();
  for (const t of now.threats) {
    for (const s of t.statuses) {
      const w = worst.get(s.sc);
      const perMin = t.landsPerMin;
      if (s.chance > 0 && (!w || s.chance * perMin > w.chance * w.perMin)) worst.set(s.sc, { chance: s.chance, from: t.source, perMin });
    }
  }
  for (const [sc, w] of worst) {
    if (w.perMin <= 0) continue;
    const res = `res_status_${sc}`;
    const hasRes = sc in STATUS_GEAR;
    fixes.push({
      kind: 'status',
      text: `${w.from} ${sc === 'stone' ? 'stones' : `inflicts ${sc}`}: lands ${pct(w.chance)} of the time it hits.`
        + `${hasRes ? ` 100% ${sc} resistance (you have ${f.statusRes[res] ?? 0}%) makes you immune` : ''}`
        + `${sc === 'stone' || sc === 'freeze' ? `${hasRes ? '; so does' : ' Immune with'} Undead armour` : ''}${hasRes || sc === 'stone' || sc === 'freeze' ? '.' : ''}`,
      removes: [], change: 0,
      value: (now.threats.find((t) => t.source === w.from)?.deathShare ?? 0) + 0.02 * w.chance,
    });
  }

  // Reflect.
  const reflect = now.threats.find((t) => t.source.endsWith(': reflected') && t.landsPerMin > 0 && t.mean > 1);
  if (reflect) {
    const r = readAll({ ...f, reflectReduce: 100 }, m, e);
    fixes.push({
      kind: 'reflect',
      text: `${reflect.source.replace(': reflected', '')} reflects ${k(Math.round(reflect.mean * reflect.landsPerMin))} a minute back at you`
        + `${reflect.deathShare ? ` (${pct(reflect.deathShare)} of deaths)` : ''}; anything that ignores reflect cuts it to 1.`,
      items: ['Valkyrie Randgris Card', 'Orc Hero Helm', 'Majestic Helmet', 'Magma Ring', 'Faceworm Leg'],
      removes: removed(r.oneShots), change: change(r.pressure), value: reflect.deathShare - change(r.pressure),
    });
  }

  // Flee against the swings that land most.
  const swing = now.threats.filter((t) => t.source.endsWith(': attack')).sort((a, b) => b.pressure - a.pressure)[0];
  if (swing && swing.pressure > 0.05) {
    const caster = sourceSkill(m, swing.source)?.caster ?? m;
    const target = caster.hit - 10;
    if (f.flee < target) {
      const r = readAll({ ...f, flee: target }, m, e);
      fixes.push({ kind: 'flee', text: `${target} flee (you have ${f.flee}) makes ${caster.name}'s swings miss 90%: damage taken ${signed(change(r.pressure))}.`,
        removes: removed(r.oneShots), change: change(r.pressure), value: worth(r.threats, r.pressure) });
    }
  }

  // How to play it, from what the TAS managed.
  const play: string[] = [];
  for (const t of now.threats) {
    if (t.landsPerMin <= 0 && t.dodged <= 0) continue;
    if (t.dodged >= 0.9 && (t.oneShot || t.deathShare > 0 || t.statuses.some((s) => s.chance > 0))) {
      play.push(`${t.source}: the TAS avoids ${pct(t.dodged)} of them — watch for it and dodge.`);
    } else if (t.oneShot && t.dodged < 0.9) {
      play.push(`${t.source}: avoided only ${pct(t.dodged)} even in near-perfect play — it has to be survived, so gear for it.`);
    }
  }

  return {
    monster: m.name,
    record: { winRate: e.winRate, lossRate: e.lossRate, seconds: e.seconds },
    threats: now.threats, pressure: now.pressure,
    fixes: fixes.sort((a, b) => b.value - a.value),
    play,
  };
}

/**
 * The armour element that does best against this monster's threats: fewest
 * one-shots, then least damage taken. Null when yours already is, or when no
 * other takes away a one-shot or a tenth of the damage.
 */
export function bestArmourElement(f: Fighter, m: Monster, e: ThreatEntry): string | null {
  const now = readAll(f, m, e);
  const best = ELEMENTS.filter((el) => el !== f.element).map((el) => ({ el, r: readAll({ ...f, element: el }, m, e) }))
    .sort((a, b) => a.r.oneShots.length - b.r.oneShots.length || a.r.pressure - b.r.pressure)[0];
  if (!best) return null;
  const better = best.r.oneShots.length < now.oneShots.length
    || (best.r.oneShots.length === now.oneShots.length && now.pressure > 0 && best.r.pressure / now.pressure - 1 <= -0.1);
  return better ? best.el : null;
}

/** The smallest whole percent, up to 100, for which `ok` holds; null if none. */
function needed(ok: (x: number) => boolean): number | null {
  if (!ok(100)) return null;
  let lo = 0; let hi = 100;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ok(mid)) hi = mid; else lo = mid; }
  return hi;
}

const signed = (x: number) => `${x > 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`;
const raceKeyOf = (race: string) => {
  const k = race.toLowerCase().replace(/[^a-z]/g, '');
  return k === 'undead' ? 'undead_race' : k;
};

/** Statuses the planner has a resistance stat for. */
const STATUS_GEAR: Record<string, true> = {
  freeze: true, stun: true, stone: true, curse: true, silence: true, sleep: true, blind: true, bleeding: true, confusion: true,
};

/** Gear that sets your armour element, by element, from the item data. */
let elementItems: Record<string, string[]> | null = null;
function armorElementItems(): Record<string, string[]> {
  if (elementItems) return elementItems;
  const out: Record<string, string[]> = {};
  for (const it of readJSON<{ name: string; kind: string }[]>(`${REPO}/data/items/all.json`)) {
    if (it.kind === 'Weapon') continue;
    for (const m of JSON.stringify(it).matchAll(/"sets_element":"([A-Za-z]+)"/g)) {
      const list = (out[m[1]] ??= []);
      if (!list.includes(it.name)) list.push(it.name);
    }
  }
  return (elementItems = out);
}

/** Plain text, for the CLI. */
export function formatAdvice(a: Advice, f: Fighter): string {
  const lines: string[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  lines.push(`== ${a.monster}${a.record ? ` — reference build: wins ${pct(a.record.winRate)}, dies ${pct(a.record.lossRate)}` : ''}`);
  for (const n of a.swap ?? []) lines.push(`   ${n}`);
  if (a.threats.length) {
    lines.push(`   threat                          lands/min  dodged      mean       top`);
    for (const t of a.threats.slice(0, 10)) {
      const st = t.statuses.filter((s) => s.chance > 0).map((s) => `${s.sc} ${pct(s.chance)}`).join(', ');
      lines.push(`   ${t.source.padEnd(32).slice(0, 32)}${t.landsPerMin.toFixed(1).padStart(9)}${pct(t.dodged).padStart(8)}`
        + `${t.mean.toLocaleString('en-US').padStart(10)}${t.max.toLocaleString('en-US').padStart(10)}`
        + `${t.oneShot ? '  KILLS' : ''}${st ? `  ${st}` : ''}`);
    }
    lines.push(`   takes ${pct(a.pressure)} of your ${f.maxHp.toLocaleString('en-US')} HP a minute, before healing`);
  }
  if (a.fixes.length) {
    lines.push('   gear:');
    for (const x of a.fixes) lines.push(`   · ${x.text}${x.items?.length ? ` [${x.items.slice(0, 5).join(', ')}]` : ''}`);
  }
  if (a.play.length) {
    lines.push('   play:');
    for (const p of a.play) lines.push(`   · ${p}`);
  }
  return lines.join('\n');
}

