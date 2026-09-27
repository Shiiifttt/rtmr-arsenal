/**
 * Search the gear -- and the rotation's settings -- for a target: one slot at
 * a time, every item and card the rules allow is fought against the target,
 * and the best change is kept, until nothing improves. Sets are tried whole
 * (shadow gear, armour sets), since one piece at a time never finds them.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/gear-search.ts \
 *     --profile profiles/kingslayer-jorm.json --vs Heartless \
 *     [--lock offhand] [--screen 60] [--confirm 400] [--passes 3] [--time 300] \
 *     [--set "shoes=Temporal STR Boots+6; stat.str=99"] [--only garment,upper,stats]
 *     [--exclude "Dark Illusion Card"] [--keep-stats str]
 *     [--proxy-test] [--healing] [--allow-ss] [--no-race] [--no-stats] [--workers N] [--out data/gear-search/kingslayer-heartless.json]
 *
 * The rules (the project owner, 2026-09-27):
 *   - Any drop is fine, but an easier piece beats an MVP-only one: an
 *     MVP-only item or card costs PENALTY in the score, so it is kept only
 *     where nothing easier comes close.
 *   - New pieces are tried at +6 and at +9. +9 is an investment: it costs
 *     PENALTY too. So does a piece made from a +9 one (Volan of the Sun).
 *     Pieces already worn keep their refine and cost nothing.
 *   - New pieces get average random options (the middle of each range),
 *     picked the way the owner would: a stat roll is tried on each of the
 *     three highest base stats; body armour rolls Max HP; a garment HP leech
 *     or SP recovery (both tried); the rest by ROLL_PREFERENCE. Rolls on
 *     pieces already worn stay as they are.
 *   - Nothing that only drops in the SS-rank dungeons (Rachel SS,
 *     Jormungandr's Lair, Valhalla): no supply. The Weavers excepted, at
 *     PENALTY for their price. --allow-ss lets them all in.
 *   - A skill-damage roll is never assumed: the pool is hundreds of skills.
 *   - Locked slots (--lock, comma separated) keep their piece; their cards
 *     can still change. The shield by default: the owner keeps it.
 *   - Costume slots are left alone; the ammunition slot too unless the
 *     weapon is a bow.
 *   - The kit's options (the rotation's switches) are searched like a slot.
 *
 * Scoring: wins, then 0.3 x fights not lost, then 0.3 x DPS / 20k, less the
 * penalties. Every candidate is screened on the same seeds (--screen
 * fights); the best few are fought again (--confirm) against the current
 * build on fresh seeds, and a change is kept only if it beats it there.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { dirname, resolve } from 'node:path';

import { buildFighter, resolveBuild, type Profile } from '../src/character.ts';
import { findMobs, MOB_GROUPS, mobRows, plannerDataset, readJSON } from '../src/data.ts';
import { DEFAULT_CONSUMABLES, loadout } from '../src/items.ts';
import type { Monster } from '../src/model.ts';
import { buildMonster } from '../src/monster.ts';
import { simulate } from '../src/sim.ts';
import { newFight, run } from '../src/engine.ts';
import { Rng } from '../src/rng.ts';
import { priorityPolicy, tasPolicy } from '../src/tas.ts';
import { kitFor } from '../src/kits/index.ts';
import {
  acquisitionOf, canEquip, clampRoll, fitsCard, fitsSlot, isTwoHanded, maxRefine, rollTableFor, SLOTS,
  type Build, type Item, type RollPick, type SlotDef,
} from '../../sim/src/index.ts';
import { encodeBuild } from '../../web/src/share.ts';

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (k: string) => argv.includes(`--${k}`);

const data = plannerDataset();
const profile = readJSON<Profile>(resolve(process.cwd(), one('profile') ?? 'profiles/kingslayer-jorm.json'));
const start = applySpec(await resolveBuild(profile.build, data), one('set') ?? '');

/**
 * --set: changes to the starting build, in tools/variants.ts's words --
 * "shoes=Temporal STR Boots+6; shoes.cards=Solace Card; stat.str=99;
 * weapon.refine=9; garment.rolls=none". For a pinpointed search from a
 * build that is not the profile's.
 */
function applySpec(b: Build, spec: string): Build {
  const build: Build = structuredClone(b);
  const idOf = (n: string) => {
    const hit = data.itemList.find((i) => i.name.toLowerCase() === n.trim().toLowerCase());
    if (!hit) throw new Error(`no item named "${n.trim()}"`);
    return hit.id;
  };
  for (const change of spec.split(';').map((c) => c.trim()).filter(Boolean)) {
    const eq = change.indexOf('=');
    const key = change.slice(0, eq).trim(); const value = change.slice(eq + 1).trim();
    const [head, field] = key.split(/\.(.+)/);
    if (head === 'stat') { (build.baseStats as unknown as Record<string, number>)[field] = Number(value); continue; }
    const slot = (build.slots[head] ??= { itemId: null, refine: 0, cards: [] });
    if (!field) {
      const m = /^(.*?)(?:\s*\+(\d+))?$/.exec(value)!;
      slot.itemId = idOf(m[1]); slot.cards = []; slot.rolls = undefined;
      if (m[2]) slot.refine = Number(m[2]);
    } else if (field === 'cards') slot.cards = value.split(',').map(idOf);
    else if (field === 'refine') slot.refine = Number(value);
    else if (field === 'rolls') {
      slot.rolls = value === 'none' ? undefined : Object.fromEntries(value.split(',').map((r) => {
        const [k, option, vals] = r.trim().split(':');
        return [k, { option, values: vals.split('/').map(Number) }];
      }));
    } else throw new Error(`unknown change "${change}"`);
  }
  return build;
}
/** --only: the groups to search -- slot keys (garment, upper, sh_armor...), stats, rotation, sets. */
const only = one('only') ? new Set(one('only')!.split(',').map((x) => x.trim())) : null;
const searching = (group: string) => !only || only.has(group);
/** --exclude: items and cards never tried ("Dark Illusion Card, Veidistafur"). */
const excluded = new Set((one('exclude') ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
/** --keep-stats: stats the stat moves leave alone ("str" to hold a maxed STR). */
const keepStats = new Set((one('keep-stats') ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const className = start.className ?? null;
const level = start.baseLevel;
const kit = kitFor(className ?? '');
const targets: Monster[] = (one('vs') ?? 'Heartless').split(',').flatMap((q) => findMobs(q.trim()).map(buildMonster));
const screenN = Number(one('screen') ?? 60);
const confirmN = Number(one('confirm') ?? 400);
const passes = Number(one('passes') ?? 3);
const timeS = Number(one('time') ?? 300);
const locked = new Set((one('lock') ?? 'offhand').split(',').map((s) => s.trim()).filter(Boolean));
const policy = one('policy') === 'tas' ? tasPolicy({ horizonMs: 6000 }) : priorityPolicy;

/** What an MVP-only piece, a +9 or a piece made from a +9 costs in the score: 3% of wins. */
const PENALTY = 0.03;

// ---- where things come from ---------------------------------------------------

const mvpMob = new Set(mobRows().filter((m) => m.mvp).map((m) => m.id));
/**
 * Only an MVP drops it: no vendor, no quest, no ordinary monster. A card
 * album does not count as a way to get one -- it is a lottery over every
 * card (Mistress Card is "in" the Hidden Card Album).
 */
function mvpOnly(item: Item): boolean {
  const drops = item.drops ?? [];
  const boxes = (item.containers ?? []).filter((c) => !/card album/i.test(c.container ?? ''));
  if (!drops.length || boxes.length || acquisitionOf(item)) return false;
  return drops.every((d) => d.mvp_reward || mvpMob.has(d.mob_id));
}
/** Made from a piece refined to +9 or more (Volan of the Sun). */
function madeFromNine(item: Item): boolean {
  return /\+(9|1\d)\b/.test(acquisitionOf(item)?.note ?? '');
}
/**
 * Dropped only in the SS-rank dungeons (Rachel SS, Jormungandr's Lair,
 * Valhalla, ama_ss): nobody clears them fast enough to supply the market,
 * least of all with good rolls (the project owner, 2026-09-27). Left out --
 * except the Weavers, which do trade, at a price (penalised as expensive).
 */
const SS_MAPS = new Set([...MOB_GROUPS.rachel_ss, ...MOB_GROUPS.jorm, ...MOB_GROUPS.valhalla, ...MOB_GROUPS.ama_ss]);
const mobMaps = new Map(mobRows().map((m) => [m.id, m.maps]));
function ssOnly(item: Item): boolean {
  const drops = item.drops ?? [];
  const boxes = (item.containers ?? []).filter((c) => !/card album/i.test(c.container ?? ''));
  if (!drops.length || boxes.length || acquisitionOf(item)) return false;
  return drops.every((d) => (mobMaps.get(d.mob_id) ?? []).length > 0 && mobMaps.get(d.mob_id)!.every((m) => SS_MAPS.has(m)));
}
const isWeaver = (item: Item) => / Weaver$/.test(item.name);
const allowSs = flag('allow-ss');
const allowed = (item: Item, slot: string) => !excluded.has(item.name.toLowerCase()) && canEquip(item, className, data.classRules, slot)
  && (item.required_level ?? 0) <= level && (allowSs || !ssOnly(item) || isWeaver(item));
const cards = data.itemList.filter((i) => i.kind === 'Card' && (allowSs || !ssOnly(i)) && !excluded.has(i.name.toLowerCase()));

// ---- rolls --------------------------------------------------------------------------

/**
 * Which option a roll takes when nothing more specific says: the first of
 * these it offers. Long-range damage and King's Chains because the shield
 * skills are long-range; SP cost and SP recovery because SP runs out.
 */
const ROLL_PREFERENCE = [
  'max_hp', 'sp_cost_reduced', 'ranged_damage', 'defense_penetration', 'physical_reduced',
  'physical_damage_reduced', 'sp_regen', 'hp_leech', 'flee',
  'after_cast_delay', 'after_cast_delay_reduced', 'variable_cast', 'hp_gained_per_hit', 'def', 'aspd',
];
const STATS = ['str', 'agi', 'vit', 'int', 'dex', 'luk'] as const;
const topStats = [...STATS].sort((a, b) => (start.baseStats[b] ?? 0) - (start.baseStats[a] ?? 0)).slice(0, 3);
/**
 * The stats a new piece's stat roll is tried on: the three highest, until a
 * pass's probe (probeRollStat) finds which one point is worth most -- then
 * that one, which cuts the rolling slots' candidates to a third.
 * --all-roll-stats keeps all three.
 */
let rollStats: string[] = [...topStats];

/** Average rolls for a new piece: one set per variant (stat choice, garment sustain). */
function rollVariants(item: Item, slotKey: string): { label: string; rolls: Record<string, RollPick> }[] {
  const table = rollTableFor(data.rolls, slotKey, item);
  if (!table) return [{ label: '', rolls: {} }];
  let variants: { label: string; rolls: Record<string, RollPick> }[] = [{ label: '', rolls: {} }];
  for (const roll of table.rolls) {
    // A skill-damage roll names one of hundreds of skills: never assume it
    // lands on ours (the project owner, 2026-09-27).
    const keys = roll.options.filter((o) => !o.grants.some((g) => g.skill)).map((o) => o.key);
    if (!keys.length) continue;
    let picks: string[];
    if (topStats.every((s) => keys.includes(s))) picks = [...rollStats];
    else if (slotKey === 'armor' && keys.includes('max_hp')) picks = ['max_hp'];
    else if (slotKey === 'garment' && keys.includes('hp_leech') && keys.includes('sp_regen')) picks = ['hp_leech', 'sp_regen'];
    else picks = [ROLL_PREFERENCE.find((k) => keys.includes(k)) ?? keys[0]];
    const next: typeof variants = [];
    for (const v of variants) {
      for (const key of picks) {
        const opt = roll.options.find((o) => o.key === key)!;
        const values = opt.grants.map((g) => clampRoll(g, (g.min + (g.max ?? g.min)) / 2));
        next.push({ label: picks.length > 1 ? `${v.label} ${key}`.trim() : v.label, rolls: { ...v.rolls, [roll.key]: { option: key, values } } });
      }
    }
    variants = next;
  }
  return variants;
}

// ---- moves ------------------------------------------------------------------------

/** One slot's worth of gear: the piece and what is in it. */
type SlotState = NonNullable<Build['slots'][string]>;
interface State { build: Build; options: Record<string, unknown> }
interface Move { label: string; slots?: Record<string, SlotState>; options?: Record<string, unknown>; stats?: Build['baseStats'] }

const refines = (item: Item) => (item.refineable ? [...new Set([Math.min(6, maxRefine(item)), Math.min(9, maxRefine(item))])] : [0]);
const skipSlot = (s: SlotDef, build: Build) => s.group === 'costume'
  || (s.key === 'ammo' && !/Bow/.test(data.items.get(build.slots.weapon?.itemId ?? 0)?.type ?? ''));

function itemMoves(build: Build, slot: SlotDef): Move[] {
  const cur = build.slots[slot.key];
  if (locked.has(slot.key) || skipSlot(slot, build)) return [];
  const out: Move[] = [];
  for (const item of data.itemList) {
    if (item.id === cur?.itemId || !fitsSlot(item, slot) || !allowed(item, slot.key)) continue;
    // Pieces worn across several slots, and two-handers with a shield kept: not here.
    if (item.equip_slots.length > 1 && slot.group === 'gear' && slot.key !== 'weapon') continue;
    if (slot.key === 'weapon' && isTwoHanded(item) && build.slots.offhand?.itemId) continue;
    // Keep the cards that still fit, in the sockets it has.
    const keep = (cur?.cards ?? []).filter((id): id is number => !!id)
      .filter((id) => { const c = data.items.get(id); return c && fitsCard(c, slot, item); })
      .slice(0, item.card_slots);
    for (const refine of refines(item)) {
      for (const r of rollVariants(item, slot.key)) {
        out.push({ label: `${slot.label}: ${item.name} +${refine}${r.label ? ` (${r.label})` : ''}`,
          slots: { [slot.key]: { itemId: item.id, refine, cards: keep, ...(Object.keys(r.rolls).length ? { rolls: r.rolls } : {}) } } });
      }
    }
  }
  return out;
}

function cardMoves(build: Build, slot: SlotDef): Move[] {
  const cur = build.slots[slot.key];
  const host = cur?.itemId ? data.items.get(cur.itemId) : null;
  if (!host || !host.card_slots || skipSlot(slot, build)) return [];
  const have = (cur!.cards ?? []).filter(Boolean) as number[];
  const out: Move[] = [];
  for (const card of cards) {
    if (!fitsCard(card, slot, host)) continue;
    // Every socket the same card, and (with two or more) one socket swapped.
    const all = Array(host.card_slots).fill(card.id);
    if (JSON.stringify(all) !== JSON.stringify(have)) {
      out.push({ label: `${slot.label}: ${card.name} x${host.card_slots}`, slots: { [slot.key]: { ...cur!, cards: all } } });
    }
    if (host.card_slots > 1 && have.length && have[0] !== card.id) {
      out.push({ label: `${slot.label}: ${card.name} in socket 1`, slots: { [slot.key]: { ...cur!, cards: [card.id, ...have.slice(1)] } } });
    }
  }
  return out;
}

/** A whole set at once: shadow sets, armour sets -- each piece where it fits, at +6 and at +9. */
function setMoves(build: Build): Move[] {
  const out: Move[] = [];
  for (const set of data.sets) {
    if (set.member_count < 2 || set.member_count > 5) continue;
    const members = set.member_ids.map((id) => data.items.get(id)).filter((i): i is Item => !!i);
    if (members.length !== set.member_count || members.some((i) => i.kind === 'Card')) continue;
    for (const refine of [6, 9]) {
      const slots: Record<string, SlotState> = {};
      let ok = true;
      for (const item of members) {
        const slot = SLOTS.find((s) => !slots[s.key] && !skipSlot(s, build) && !locked.has(s.key)
          && fitsSlot(item, s) && allowed(item, s.key));
        if (!slot) { ok = false; break; }
        const cur = build.slots[slot.key];
        slots[slot.key] = cur?.itemId === item.id ? cur
          : { itemId: item.id, refine: item.refineable ? Math.min(refine, maxRefine(item)) : 0, cards: [],
            ...(() => { const r = rollVariants(item, slot.key)[0].rolls; return Object.keys(r).length ? { rolls: r } : {}; })() };
      }
      if (!ok || Object.entries(slots).every(([k, s]) => build.slots[k]?.itemId === s.itemId)) continue;
      out.push({ label: `${set.name} set +${refine}`, slots });
    }
  }
  return out;
}

// ---- stats ----------------------------------------------------------------------

const STAT_CAP = Math.max(99, ...STATS.map((k) => start.baseStats[k] ?? 0));
/** Status points to raise a stat from 1 to x: floor((v - 1) / 10) + 2 for each step v -> v + 1. */
const statCost = (x: number) => { let c = 0; for (let v = 1; v < x; v++) c += Math.floor((v - 1) / 10) + 2; return c; };

/**
 * Stat points moved: 5 or 10 taken out of one stat, and the points that
 * frees spent on another, up to the cap. The total spent never grows, so the
 * build stays one the character can have.
 */
function statMoves(build: Build): Move[] {
  const out: Move[] = [];
  const base = build.baseStats;
  for (const from of STATS) {
    for (const to of STATS) {
      if (from === to || keepStats.has(from) || keepStats.has(to)) continue;
      for (const d of [5, 10]) {
        const a = base[from] ?? 1; const b = base[to] ?? 1;
        if (a - d < 1 || b >= STAT_CAP) continue;
        let free = statCost(a) - statCost(a - d);
        let nb = b;
        while (nb < STAT_CAP && statCost(nb + 1) - statCost(nb) <= free) { free -= statCost(nb + 1) - statCost(nb); nb++; }
        if (nb === b) continue;
        out.push({ label: `stats: ${from.toUpperCase()} ${a}->${a - d}, ${to.toUpperCase()} ${b}->${nb}`,
          stats: { ...base, [from]: a - d, [to]: nb } });
      }
    }
  }
  return out;
}

/** The rotation's switches (kits/kingslayer.ts options), each tried the other way. */
const OPTION_CHOICES: Record<string, unknown[]> = {
  bishopsTax: [true, false], taxHp: [0.5, 0.75, 0.35], sneakAttack: [true, false], preGambit: [true, false],
  deltaFiller: [false, true], queensBrand: [false, true], queensGambit: [true, false], reflectCare: [true, false],
  heal: [true, false], rogueFillers: [false, true], fortress: [3, 2, 1], rooksWall: [false, true], autoAttack: [false, true],
  rooksSmash: [true, false], keepRange: [true, false], spendCounters: [true, false], windSlash: [false, true],
};
/** Play styles that take several switches at once. */
const OPTION_SETS: Record<string, Record<string, unknown>> = {
  // Rook's Wall up and nothing that brings you into melee: every hit stays long range.
  "ranged only behind Rook's Wall": { rooksWall: true, rooksSmash: false, spendCounters: false, bishopsTax: false, sneakAttack: false },
  "Rook's Wall, step back after melee": { rooksWall: true, keepRange: true },
};
function optionMoves(options: Record<string, unknown>): Move[] {
  const out: Move[] = [];
  for (const [k, choices] of Object.entries(OPTION_CHOICES)) {
    const now = options[k] ?? choices[0];
    for (const v of choices) if (v !== now) out.push({ label: `rotation: ${k} = ${v}`, options: { [k]: v } });
  }
  for (const [name, set] of Object.entries(OPTION_SETS)) {
    if (Object.entries(set).some(([k, v]) => (options[k] ?? OPTION_CHOICES[k]?.[0]) !== v)) out.push({ label: `rotation: ${name}`, options: set });
  }
  return out;
}

const apply = (s: State, m: Move): State => {
  const build: Build = structuredClone(s.build);
  for (const [k, v] of Object.entries(m.slots ?? {})) build.slots[k] = structuredClone(v);
  if (m.stats) build.baseStats = { ...m.stats };
  return { build, options: { ...s.options, ...(m.options ?? {}) } };
};

/** The score's handicap: new MVP-only pieces and cards, new +9s, pieces made from a +9. */
function penalty(build: Build): number {
  let p = 0;
  for (const [k, st] of Object.entries(build.slots)) {
    if (!st?.itemId) continue;
    const was = start.slots[k];
    const item = data.items.get(st.itemId);
    if (item && was?.itemId !== st.itemId) {
      if (mvpOnly(item)) p += PENALTY;
      if (ssOnly(item)) p += PENALTY;
      if (madeFromNine(item)) p += PENALTY;
    }
    if (st.refine >= 9 && !(was?.itemId === st.itemId && (was.refine ?? 0) >= 9)) p += PENALTY;
    const before = new Set((was?.cards ?? []).filter(Boolean));
    for (const id of new Set((st.cards ?? []).filter(Boolean) as number[])) {
      const c = data.items.get(id);
      if (c && !before.has(id) && mvpOnly(c)) p += PENALTY;
    }
  }
  return p;
}

// ---- fighting ------------------------------------------------------------------

interface Score { win: number; loss: number; dps: number; ttk: number | null; value: number; deaths: string }

async function fight(s: State, n: number, seed: number): Promise<Score> {
  const f = await buildFighter({ ...profile, build: s.build }, { passives: kit.passives, aliases: kit.aliases, maxLevels: kit.maxLevels() });
  let win = 0; let loss = 0; let dps = 0; let ttk = 0; let ttkN = 0;
  const deaths: Record<string, number> = {};
  for (const m of targets) {
    const r = simulate(f, m, kit.kit, {
      iterations: n, seed, policy, options: s.options, limitMs: timeS * 1000,
      items: loadout({ carried: profile.consumables ?? DEFAULT_CONSUMABLES, healing: flag('healing') || !!profile.healing,
        boss: m.boss, elixirs: f.kafraElixirs }),
    });
    win += r.winRate; loss += r.losses / n; dps += r.dps;
    if (r.ttk) { ttk += r.ttk.p50; ttkN++; }
    for (const [k, v] of Object.entries(r.deaths)) deaths[k] = (deaths[k] ?? 0) + v;
  }
  const k = targets.length;
  win /= k; loss /= k; dps /= k;
  const top = Object.entries(deaths).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c, v]) => `${c} x${v}`).join(', ');
  // Once every fight is a win, speed is what is left to gain: 0.01 of score
  // (the bar a change must clear) is ~670 DPS.
  // The penalty is the main thread's (fightAll), so equal fighters share a score.
  const value = win + 0.3 * (1 - loss) + 0.3 * (dps / 20_000);
  return { win, loss, dps, ttk: ttkN ? ttk / ttkN : null, value, deaths: top };
}

/**
 * The estimate: one fight per target in expected-value mode (the engine's
 * rollout mode -- nothing rolled, every chance weighed), scored like
 * fight(): a win, not losing, DPS, and the lowest HP reached, since an
 * averaged fight shows risk as a thin margin rather than a loss rate. ~1/60
 * of a screen's cost; used to pick which candidates are worth fighting.
 */
async function estimate(s: State): Promise<Score> {
  const f = await buildFighter({ ...profile, build: s.build }, { passives: kit.passives, aliases: kit.aliases, maxLevels: kit.maxLevels() });
  let value = 0; let dps = 0;
  for (const m of targets) {
    const fi = newFight(f, m, kit.kit, policy, { seed: 1, limitMs: timeS * 1000, options: s.options,
      items: loadout({ carried: profile.consumables ?? DEFAULT_CONSUMABLES, healing: flag('healing') || !!profile.healing,
        boss: m.boss, elixirs: f.kafraElixirs }) });
    fi.rng = new Rng(0, true);
    run(fi);
    const d = (m.hp - Math.max(0, fi.mob.hp)) / Math.max(1, fi.t / 1000);
    dps += d;
    value += (fi.result === 'win' ? 1 : 0) + 0.3 * (fi.result === 'loss' ? 0 : 1) + 0.3 * (d / 20_000)
      + 0.2 * Math.max(0, fi.meter!.minHp) / f.maxHp;
  }
  const k = targets.length;
  return { win: 0, loss: 0, dps: dps / k, ttk: null, value: value / k, deaths: '' };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const show = (s: Score) => `win ${pct(s.win)} lost ${pct(s.loss)} ${Math.round(s.dps).toLocaleString('en-US')} dps${s.ttk ? ` ${s.ttk.toFixed(0)}s` : ''}`;

// ---- the workers -----------------------------------------------------------------
//
// Screening is thousands of independent batches: split across worker
// threads (--workers, default all cores but one). Each worker runs this same
// file with the same arguments, so it loads the profile, data and targets
// itself, then fights whatever states it is sent.

interface Job { id: number; state: State; n: number; seed: number; estimate?: boolean }


class Pool {
  private idle: Worker[] = [];
  private queue: { job: Job; done: (s: Score) => void }[] = [];
  private waiting = new Map<number, (s: Score) => void>();
  private next = 0;
  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL(import.meta.url), { execArgv: process.execArgv, argv: process.argv.slice(2) });
      w.on('message', (msg: { id: number; score: Score }) => {
        this.waiting.get(msg.id)!(msg.score);
        this.waiting.delete(msg.id);
        this.idle.push(w);
        this.pump();
      });
      w.on('error', (e) => { console.error(e); process.exit(1); });
      this.idle.push(w);
    }
  }
  run(state: State, n: number, seed: number, est = false): Promise<Score> {
    return new Promise((done) => { this.queue.push({ job: { id: this.next++, state, n, seed, estimate: est }, done }); this.pump(); });
  }
  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!; const { job, done } = this.queue.shift()!;
      this.waiting.set(job.id, done);
      w.postMessage(job);
    }
  }
  close() { for (const w of this.idle) void w.terminate(); }
}

// ---- the search -----------------------------------------------------------------

async function main() {
const workers = Math.max(1, Number(one('workers') ?? Math.max(1, availableParallelism() - 1)));
const pool = new Pool(workers);
// Many candidates make the very same fighter (a bonus the fight never reads,
// a roll that changes nothing): fought once, on the same seeds, they would
// score the same -- so they share one result. The penalty is per build.
const cache = new Map<string, Score>();
const mods = ['damage', 'cooldown', 'sp cost'];
async function fingerprint(st: State): Promise<string> {
  const f = await buildFighter({ ...profile, build: st.build }, { passives: kit.passives, aliases: kit.aliases, maxLevels: kit.maxLevels() });
  const { name: _n, notes: _no, gearText, skillMods, ...rest } = f as typeof f & { notes: unknown };
  const skillBonus = Object.keys(f.skillLevels).map((sk) => mods.map((m) => { const x = skillMods(sk, m); return `${x.flat},${x.percent}`; }).join('|'));
  return JSON.stringify([rest, skillBonus, /Shield Boomerang can combo into King's Chains/i.test(gearText ?? ''), st.options]);
}
let fought = 0; let shared = 0;
/** n = 0: the estimate (one expected-value fight a target), not a screen. */
async function fightAll(states: State[], n: number, seed: number): Promise<Score[]> {
  const keys: string[] = [];
  for (const st of states) keys.push(`${await fingerprint(st)}#${n ? `${n}#${seed}` : 'est'}`);
  const todo = new Map<string, State>();
  keys.forEach((k, i) => { if (!cache.has(k) && !todo.has(k)) todo.set(k, states[i]); });
  fought += todo.size; shared += states.length - todo.size;
  await Promise.all([...todo].map(([k, st]) => pool.run(st, n, seed, n === 0).then((sc) => { cache.set(k, sc); })));
  return states.map((st, i) => { const sc = cache.get(keys[i])!; return { ...sc, value: sc.value - penalty(st.build) }; });
}
/**
 * Screening in two rounds: every candidate on a third of the fights, then
 * the full screen for those not clearly behind -- the top fifth (at least
 * 24), and anything within 0.05 of the best. --no-race screens all fully.
 */
async function screen(moves: Move[], seed: number): Promise<{ base: Score; scored: { m: Move; s: Score }[] }> {
  const states = moves.map((m) => apply(state, m));
  let pool2 = moves.map((m, i) => ({ m, st: states[i] }));
  const quick = Math.max(10, Math.round(screenN / 3));
  if (!flag('no-race') && moves.length > 24 && quick < screenN) {
    const [, ...first] = await fightAll([state, ...states], quick, seed);
    const ranked = pool2.map((x, i) => ({ ...x, v: first[i].value })).sort((a, b) => b.v - a.v);
    const keep = Math.max(24, Math.ceil(moves.length / 5));
    pool2 = ranked.filter((x, r) => r < keep || x.v >= ranked[0].v - 0.05);
  }
  const [base, ...full] = await fightAll([state, ...pool2.map((x) => x.st)], screenN, seed);
  return { base, scored: pool2.map((x, i) => ({ m: x.m, s: full[i] })) };
}

const t0 = performance.now();
let state: State = { build: start, options: { ...(profile.options ?? {}) } };
let seedBase = 1;
const [first] = await fightAll([state], confirmN, 10_000);
if (one('set')) console.log(`from the profile with: ${one('set')}`);
console.log(`start: ${show(first)}  (${targets.map((m) => m.name).join(', ')}, ${confirmN} fights, ${workers} workers)`);
const steps: { move: string; before: Score; after: Score; tried: number }[] = [];

/**
 * Which stat a roll is best spent on: a piece already worn with a stat roll
 * gets it set to each of the top stats in turn, and the three are fought.
 */
async function probeRollStat(): Promise<void> {
  if (flag('all-roll-stats')) return;
  for (const [key, st] of Object.entries(state.build.slots)) {
    const item = st?.itemId ? data.items.get(st.itemId) : null;
    const table = item ? rollTableFor(data.rolls, key, item) : null;
    const roll = table?.rolls.find((r) => topStats.every((t) => r.options.some((o) => o.key === t)));
    if (!roll) continue;
    const states = topStats.map((t) => apply(state, { label: '', slots: { [key]: { ...st!, rolls: { ...(st!.rolls ?? {}), [roll.key]: { option: t, values: [1] } } } } }));
    const scores = await fightAll(states, confirmN, 55_555);
    const best = topStats[scores.map((x) => x.value).indexOf(Math.max(...scores.map((x) => x.value)))];
    rollStats = [best];
    console.log(`  (stat rolls on new pieces: ${best.toUpperCase()}, from ${key}: ${topStats.map((t, i) => `${t} ${scores[i].value.toFixed(3)}`).join(', ')})`);
    return;
  }
}

if (flag('proxy-test')) {
  // How well does the estimate rank candidates? Per group: where the full
  // screen's best lands in the estimate's order, and how many of the screen's
  // top 4 fall in the estimate's top 10 / 20 / 40.
  const groups: [string, Move[]][] = [
    ['rotation', optionMoves(state.options)], ['stats', statMoves(state.build)], ['sets', setMoves(state.build)],
    ...SLOTS.flatMap((sl) => [[`${sl.key} piece`, itemMoves(state.build, sl)], [`${sl.key} cards`, cardMoves(state.build, sl)]] as [string, Move[]][]),
  ];
  const [base0] = await fightAll([state], screenN, 7);
  for (const [name, moves] of groups) {
    if (moves.length < 10) continue;
    const states = moves.map((m) => apply(state, m));
    // --proxy-n N: a small real screen as the estimate instead (0: expected-value mode).
    const est = await fightAll(states, Number(one('proxy-n') ?? 0), 3);
    const scr = await fightAll(states, screenN, 7);
    const byEst = moves.map((_, i) => i).sort((a, b) => est[b].value - est[a].value);
    const byScr = moves.map((_, i) => i).sort((a, b) => scr[b].value - scr[a].value);
    const rankOf = (i: number) => byEst.indexOf(i) + 1;
    const top4 = byScr.slice(0, 4);
    const inTop = (k: number) => top4.filter((i) => rankOf(i) <= k).length;
    // Regret: the screen's best, less the best the screen gives among the
    // estimate's top K -- what pruning to K would cost (0.01 is the bar a change clears).
    const best = scr[byScr[0]].value;
    const regret = (k: number) => (best - Math.max(...byEst.slice(0, k).map((i) => scr[i].value))).toFixed(3);
    const k20 = Math.max(24, Math.ceil(moves.length / 5));
    console.log(`${name.padEnd(18)} ${String(moves.length).padStart(5)}  best #${String(rankOf(byScr[0])).padStart(4)}  gain over current ${(best - (base0?.value ?? 0)).toFixed(3)}`
      + `   regret@10 ${regret(10)}  @40 ${regret(40)}  @${k20} ${regret(k20)}   top4 in est top40: ${inTop(40)}`);
  }
  pool.close();
  return;
}

for (let pass = 1; pass <= passes; pass++) {
  let improved = false;
  await probeRollStat();
  const groups: { name: string; moves: () => Move[] }[] = [
    ...(searching('rotation') ? [{ name: 'rotation', moves: () => optionMoves(state.options) }] : []),
    ...(flag('no-stats') || !searching('stats') ? [] : [{ name: 'stats', moves: () => statMoves(state.build) }]),
    ...(searching('sets') ? [{ name: 'sets', moves: () => setMoves(state.build) }] : []),
    ...SLOTS.filter((s) => searching(s.key)).flatMap((s) => [
      { name: `${s.label} piece`, moves: () => itemMoves(state.build, s) },
      { name: `${s.label} cards`, moves: () => cardMoves(state.build, s) },
    ]),
  ];
  for (const g of groups) {
    const moves = g.moves();
    if (!moves.length) continue;
    seedBase++;
    const { base, scored } = await screen(moves, seedBase);
    const best = scored.filter((x) => x.s.value > base.value).sort((a, b) => b.s.value - a.s.value).slice(0, 4);
    if (!best.length) continue;
    // Fresh seeds, more fights: the current build and the finalists.
    const confirmSeed = 20_000 + seedBase;
    const [now, ...finals] = await fightAll([state, ...best.map((x) => apply(state, x.m))], confirmN, confirmSeed);
    let pick: { m: Move; s: Score } | null = null;
    best.forEach((x, i) => {
      const sc = finals[i];
      if (sc.value > now.value + 0.01 && (!pick || sc.value > pick.s.value)) pick = { m: x.m, s: sc };
    });
    if (!pick) continue;
    const chosen = pick as { m: Move; s: Score };
    state = apply(state, chosen.m);
    steps.push({ move: chosen.m.label, before: now, after: chosen.s, tried: moves.length });
    improved = true;
    console.log(`pass ${pass}  ${chosen.m.label.padEnd(64)} ${show(now)}  ->  ${show(chosen.s)}   [${moves.length} tried]`);
  }
  if (!improved) break;
}

const [final] = await fightAll([state], confirmN * 2, 99_999);
pool.close();
const link = `http://localhost:5173/#b=${await encodeBuild(state.build)}`;
console.log(`\nfinal (${confirmN * 2} fights): ${show(final)}; killed by ${final.deaths || 'nothing'}`);
console.log(`options: ${JSON.stringify(state.options)}`);
console.log(link);
console.log(`(${((performance.now() - t0) / 1000).toFixed(0)} s; ${fought} batches fought, ${shared} shared with an identical fighter)`);

const out = one('out');
if (out) {
  const path = resolve(process.cwd(), out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    profile: profile.name, targets: targets.map((m) => m.name),
    rules: { screenN, confirmN, timeS, locked: [...locked], penalty: PENALTY, topStats },
    start: profile.build, steps, final, options: state.options, link,
  }, null, 1)}\n`);
}
}

if (!isMainThread) {
  parentPort!.on('message', async (job: Job) => {
    parentPort!.postMessage({ id: job.id, score: job.estimate ? await estimate(job.state) : await fight(job.state, job.n, job.seed) });
  });
} else {
  await main();
}
