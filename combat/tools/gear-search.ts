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
 *     [--only rotation,order  (the rotation optimizer)] [--fix "rogueFillers=false,autoAttack=false"]
 *     [--exclude "Dark Illusion Card"] [--keep-stats str] [--slot-items "lower=Flaming Weaver|Wind Weaver[str:1]"] [--lock-cards weapon] [--fix-refine gem] [--refine-cap gem=6] [--penalty 0.03] [--mvp-penalty 0] [--max-refine 6]
 *     [--per-target [--swap-cost 0.1]] [--proxy-test] [--no-pairs] [--healing] [--allow-ss] [--no-race] [--no-stats] [--workers N] [--out data/gear-search/kingslayer-heartless.json]
 *     [--no-census] [--shadow-top 3] [--rolls] [--max-rolls] [--min-hp 28000]
 *     [--flat] [--accept-z 2] [--confirm-more 3] [--cheapen] [--mid-rolls] [--no-live]
 *
 * While it runs, the arsenal's dev server shows it live (the Live button):
 * what each worker is trying, on which monster, and how fast (src/live.ts).
 * --no-live: no feed. The panel can also start a search, from the build
 * being edited (--build <payload>, see below); it is the same program.
 *
 * First a census (see "the census" below): every shadow piece at +0/+3/+6/+9
 * and every card, each alone against its slot left empty. What adds nothing
 * is never tried again; the best shadow pieces per slot are mixed (the top
 * --shadow-top in each of the four set slots) and fought against whole sets.
 *
 * The rules (the project owner, 2026-09-27):
 *   - Any drop is fine, but an easier piece beats an MVP-only one: an
 *     MVP-only item or card costs PENALTY in the score, so it is kept only
 *     where nothing easier comes close.
 *   - New pieces are tried at +6 and at +9. +9 is an investment: it costs
 *     PENALTY too. So does a piece made from a +9 one (Volan of the Sun).
 *     Pieces already worn keep their refine and cost nothing. Refines are
 *     only ever +0, +3, +6 or +9 (TIERS; the owner, 2026-09-29).
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
 * build on fresh seeds, and a change is kept only if it beats it there by
 * 0.01 and by twice the noise of the difference (--accept-z).
 *
 * --screen and --confirm are a precision: each target gets the fights that
 * precision needs (fightsFor) -- few for a monster whose fights all come
 * out alike, many for one that swings. --flat: every target N fights.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { dirname, resolve } from 'node:path';

import { buildFighter, resolveBuild, type Profile } from '../src/character.ts';
import { leaveFirstCore, workCores } from '../src/cpu.ts';
import { accessoryCardFits, findMobs, MOB_GROUPS, mobRows, plannerDataset, readJSON } from '../src/data.ts';
import { DEFAULT_CONSUMABLES, loadout } from '../src/items.ts';
import type { Monster } from '../src/model.ts';
import { buildMonster, DUMMY_SECONDS, dummyMonster } from '../src/monster.ts';
import { simulate, type FightRow, type Summary } from '../src/sim.ts';
import { DEATH_S, rhythm, sitFor, sitRegen, walkFor, type Rhythm } from '../src/rhythm.ts';
import { farmScore, spawnCounts } from '../src/farm.ts';
import { newFight, run } from '../src/engine.ts';
import { Rng } from '../src/rng.ts';
import { priorityPolicy, tasPolicy } from '../src/tas.ts';
import { kitFor } from '../src/kits/index.ts';
import { LiveFeed, LiveMarks, type LiveScore, type LiveWorker } from '../src/live.ts';
import {
  acquisitionOf, canEquip, clampRoll, fitsCard, fitsSlot, isRefineable, isTwoHanded, maxRefine, rollTableFor, SLOTS,
  type Build, type Item, type RollPick, type SlotDef,
} from '../../sim/src/index.ts';
import { encodeBuild } from '../../web/src/share.ts';

process.on('unhandledRejection', (e) => { console.error('unhandled:', e); process.exit(1); });
const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (k: string) => argv.includes(`--${k}`);

const data = plannerDataset();
/** A card that fits the slot, and the side of an accessory (accessoryCardFits). */
const cardFits = (c: Item, slot: SlotDef, host?: Item | null) => fitsCard(c, slot, host) && (!host || accessoryCardFits(c.id, host.id));
/**
 * --build <share payload>: search from this build (the arsenal's Live panel
 * sends the one being edited). --profile then only lends its readings and
 * rotation; without one the kit's defaults are used. --name: what to call it.
 */
const profile: Profile = one('build')
  ? { ...(one('profile') ? readJSON<Profile>(resolve(process.cwd(), one('profile')!)) : {}), build: one('build')!, name: one('name') ?? 'Build from the web view' }
  : readJSON<Profile>(resolve(process.cwd(), one('profile') ?? 'profiles/kingslayer-jorm.json'));
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
/** The kit's written priority order and switches (kits/index.ts RotationSpace). */
const space = kit.search;
const kitOrder: string[] | null = space.order.length ? space.order : null;
/**
 * --objective farm: score by how much of the --vs maps dies to one or two
 * buttons (src/farm.ts), weighted by spawn counts, bosses left out -- speed
 * over safety (the project owner, 2026-09-28). The default, fight, plays
 * whole fights.
 */
const farmMode = one('objective') === 'farm';
const vsList = (one('vs') ?? 'Heartless').split(',').map((q) => q.trim());
// --no-mvp-targets: MVPs off the list (a farming build), and each monster once however many --vs groups name it.
// 'dummy': the training dummy (never dies, never hits back): the score is then its DPS over --time.
const targets: Monster[] = vsList.flatMap((q) => (q.toLowerCase() === 'dummy' ? [dummyMonster()] : findMobs(q).map(buildMonster)))
  .filter((m) => !(farmMode || flag('no-mvp-targets')) || !m.boss)
  .filter((m, i, all) => !flag('no-mvp-targets') || all.findIndex((x) => x.name === m.name) === i);
const farmWeights: number[] = (() => {
  if (!farmMode) return [];
  const counts = new Map<string, number>();
  for (const q of vsList) for (const [n, c] of spawnCounts(q)) counts.set(n, (counts.get(n) ?? 0) + c);
  return targets.map((m) => counts.get(m.name) ?? 1);
})();
const screenN = Number(one('screen') ?? 60);
const confirmN = Number(one('confirm') ?? 400);
const passes = Number(one('passes') ?? 3);
const timeS = Number(one('time') ?? 300);
/** The fight's clock: --time, but the dummy is always DUMMY_SECONDS (the project owner: a 10 s fight). */
const limitFor = (m: Monster) => (m.dummy ? DUMMY_SECONDS : timeS) * 1000;
const locked = new Set((one('lock') ?? 'offhand').split(',').map((s) => s.trim()).filter(Boolean));
const policy = one('policy') === 'tas' ? tasPolicy({ horizonMs: 6000 }) : priorityPolicy;

/** What an MVP-only piece, a +9 or a piece made from a +9 costs in the score: 3% of wins. */
/** --penalty: the score an MVP-only / SS-only / +9 piece costs (0.03; 0 for an endgame tier). */
const PENALTY = Number(one('penalty') ?? 0.03);
/** --mvp-penalty: what an MVP-only piece or card costs, apart from PENALTY (0: MVP drops are fine -- the Satsujin owner, 2026-09-28). */
const MVP_PENALTY = Number(one('mvp-penalty') ?? PENALTY);
/** --no-mvp: MVP-only pieces and cards are left out, not merely penalised. --max-refine N: new pieces at +N at most. */
const noMvp = flag('no-mvp');
const maxNewRefine = Number(one('max-refine') ?? 9);
const hpWeight = Number(one('hp-weight') ?? 0);
const safeScore = one('score') === 'safe';
/** --min-hp N: builds under N Max HP score nothing (a safety floor). */
const minHp = one('min-hp') ? Number(one('min-hp')) : 0;
const rhythmScore = one('score') === 'rhythm';
const deathWeight = Number(one('death-weight') ?? 0.1);
/** --stall-weight: a fight given up (the monster outlived --time) an hour costs this, like --death-weight (default the same). */
const stallWeight = Number(one('stall-weight') ?? deathWeight);
/**
 * Deaths and stalls are charged per kill, scaled to an hour at PER_KILL_REF
 * kills -- the same as the per-hour charge at that pace. Charged per hour,
 * a build that barely fights scored as safe: Eastern Sky Armor took a budget
 * Satsujin to 3 kills an hour sitting 17 minutes a kill, its deaths an hour
 * fell to almost none, and the search took it (2026-10-01). --per-hour: the old charge.
 */
const PER_KILL_REF = 200;
const perHourCharge = flag('per-hour');
/** --map (with --score rhythm): weigh each target by how many spawn there. */
// Several maps or groups ("tomb,jorm,gorge"): each weighs the same in all, its
// monsters by their share of its spawns -- a big map does not drown a small one.
const rhythmWeights = new Map<string, number>();
for (const g of (one('map') ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
  const counts = [...spawnCounts(g)].filter(([n]) => targets.some((m) => m.name === n));
  const total = counts.reduce((s, [, c]) => s + c, 0) || 1;
  for (const [n, c] of counts) rhythmWeights.set(n, (rhythmWeights.get(n) ?? 0) + (100 * c) / total);
}

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
/**
 * --mvp-max-level N: an MVP-only piece or card only when an MVP of level N or
 * below drops it (the project owner, 2026-09-29: "MVP drops from MVPs below
 * level 130").
 */
const mvpMaxLevel = one('mvp-max-level') ? Number(one('mvp-max-level')) : null;
const mvpTooHigh = (item: Item) => mvpMaxLevel !== null && mvpOnly(item)
  && Math.min(...(item.drops ?? []).map((d) => d.mob_level ?? Infinity)) > mvpMaxLevel;
// Under --max-refine 8 or less, a piece made from a +9 (Volan of the Sun) is out as well.
const allowed = (item: Item, slot: string) => !excluded.has(item.name.toLowerCase()) && !(noMvp && mvpOnly(item)) && !mvpTooHigh(item)
  && !(maxNewRefine < 9 && madeFromNine(item)) && canEquip(item, className, data.classRules, slot)
  && (item.required_level ?? 0) <= level && (allowSs || !ssOnly(item) || isWeaver(item));
// A card locked to another class by a hand rule (Revenant Ebel Card) stays out (canEquip).
const cards = data.itemList.filter((i) => i.kind === 'Card' && (allowSs || !ssOnly(i)) && !(noMvp && mvpOnly(i)) && !mvpTooHigh(i) && !excluded.has(i.name.toLowerCase())
  && canEquip(i, className, data.classRules));

// ---- rolls --------------------------------------------------------------------------

/**
 * Which option a roll takes when nothing more specific says: the first of
 * these it offers. Long-range damage and King's Chains because the shield
 * skills are long-range; SP cost and SP recovery because SP runs out.
 */
const ROLL_PREFERENCE: string[] = kit.search.rolls ?? [
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

/** --max-rolls: new pieces and re-rolls (--rolls) at the top of each range, not the middle -- bought rolls. */
const maxRolls = flag('max-rolls');

/**
 * --rolls (or rolls in --only): re-roll the pieces worn, locked slots too (a
 * re-roll is not a swap): every option of every roll line, one line at a
 * time. Skill-damage options are left out, as for new pieces.
 */
function rollMoves(build: Build, slot: SlotDef): Move[] {
  const cur = build.slots[slot.key];
  const item = cur?.itemId ? data.items.get(cur.itemId) : null;
  if (!item || skipSlot(slot, build)) return [];
  const table = rollTableFor(data.rolls, slot.key, item);
  if (!table) return [];
  const out: Move[] = [];
  for (const roll of table.rolls) {
    for (const opt of roll.options) {
      if (!rollOptionOk(opt)) continue;
      const values = opt.grants.map((g) => clampRoll(g, maxRolls ? (g.max ?? g.min) : (g.min + (g.max ?? g.min)) / 2));
      const now = cur!.rolls?.[roll.key];
      if (now && now.option === opt.key && JSON.stringify(now.values) === JSON.stringify(values)) continue;
      out.push({ label: `${slot.label} ${roll.key}: ${opt.key} ${values.join('/')}`,
        slots: { [slot.key]: { ...cur!, rolls: { ...(cur!.rolls ?? {}), [roll.key]: { option: opt.key, values } } } } });
    }
  }
  return out;
}

/**
 * --skill-rolls: a roll line may take a skill-damage option, for a skill the
 * class learns (a maxed tier's bought rolls: shadow gear's +5% Roaring
 * Overslash). Off, the owner's rule of 2026-09-27 holds: a skill roll is
 * never assumed, the pool being hundreds of skills.
 */
const skillRolls = flag('skill-rolls');
const learnedSkills = new Set(Object.keys(kit.maxLevels()));
const rollOptionOk = (o: { grants: { skill?: unknown; skill_name?: string }[] }) => !o.grants.some((g) => g.skill)
  || (skillRolls && o.grants.every((g) => !g.skill || learnedSkills.has(g.skill_name ?? '')));
/** Average rolls for a new piece: one set per variant (stat choice, garment sustain). */
function rollVariants(item: Item, slotKey: string): { label: string; rolls: Record<string, RollPick> }[] {
  const table = rollTableFor(data.rolls, slotKey, item);
  if (!table) return [{ label: '', rolls: {} }];
  let variants: { label: string; rolls: Record<string, RollPick> }[] = [{ label: '', rolls: {} }];
  for (const roll of table.rolls) {
    // A skill-damage roll names one of hundreds of skills: never assume it
    // lands on ours (the project owner, 2026-09-27).
    const keys = roll.options.filter(rollOptionOk).map((o) => o.key);
    if (!keys.length) continue;
    let picks: string[];
    const skillKeys = keys.filter((k) => roll.options.find((o) => o.key === k)!.grants.some((g) => g.skill));
    if (skillKeys.length) picks = [ROLL_PREFERENCE.find((k) => skillKeys.includes(k)) ?? skillKeys[0]];
    else if (topStats.every((s) => keys.includes(s))) picks = [...rollStats];
    else if (slotKey === 'armor' && keys.includes('max_hp')) picks = ['max_hp'];
    else if (slotKey === 'garment' && keys.includes('hp_leech') && keys.includes('sp_regen')) picks = ['hp_leech', 'sp_regen'];
    else picks = [ROLL_PREFERENCE.find((k) => keys.includes(k)) ?? keys[0]];
    const next: typeof variants = [];
    for (const v of variants) {
      for (const key of picks) {
        const opt = roll.options.find((o) => o.key === key)!;
        const values = opt.grants.map((g) => clampRoll(g, maxRolls ? (g.max ?? g.min) : (g.min + (g.max ?? g.min)) / 2));
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
/** only: fight just these targets (indices into targets) -- the per-target phase. */
interface State { build: Build; options: Record<string, unknown>; only?: number[] }
interface Move { label: string; slots?: Record<string, SlotState>; options?: Record<string, unknown>; stats?: Build['baseStats'] }

const refines = (item: Item) => (isRefineable(item)
  ? [...new Set([Math.min(6, maxNewRefine, maxRefine(item)), Math.min(9, maxNewRefine, maxRefine(item))])] : [0]);
/** The refines a piece is ever tried at: +0, +3, +6, +9, never +10 (the project owner, 2026-09-29) -- weapons +10 too (2026-09-30). */
const TIERS = [0, 3, 6, 9];
const tiersFor = (item: Item, slotKey: string) => (isRefineable(item)
  ? [...new Set((slotKey === 'weapon' ? [...TIERS, 10] : TIERS).map((r) => Math.min(r, maxRefine(item), slotKey === 'weapon' ? 99 : maxNewRefine, refineCap.get(slotKey) ?? 99)))] : [0]);
/** The cards worn in a slot that still fit a new piece there, in the sockets it has. */
const keepCards = (cur: SlotState | undefined, slot: SlotDef, item: Item) => (cur?.cards ?? []).filter((id): id is number => !!id)
  .filter((id) => { const c = data.items.get(id); return c && cardFits(c, slot, item); }).slice(0, item.card_slots);
/** The best `n` cards by the census for a piece's empty sockets, best first (none without a census). */
function bestCards(slot: SlotDef, host: Item, n: number): number[] {
  if (!cardEstimate.size || !host.card_slots || cardLocked.has(slot.key)) return [];
  return cards.filter((c) => cardFits(c, slot, host) && (cardEstimate.get(c.id) ?? 0) > 1e-6)
    .sort((a, b) => (cardEstimate.get(b.id) ?? 0) - (cardEstimate.get(a.id) ?? 0)).slice(0, n).map((c) => c.id);
}
/** A new piece's sockets: the kept cards, then the rest filled with `fill` (all the best card, or the best two alternating). */
function fillSockets(keep: number[], host: Item, fill: number[]): number[] {
  const out = [...keep];
  for (let i = out.length; i < host.card_slots; i++) out.push(fill[(i - keep.length) % fill.length]);
  return out;
}
const skipSlot = (s: SlotDef, build: Build) => s.group === 'costume'
  || (s.key === 'ammo' && !/Bow/.test(data.items.get(build.slots.weapon?.itemId ?? 0)?.type ?? ''))
  // Nothing in the off hand beside a two-handed weapon (most scythes).
  || (s.key === 'offhand' && isTwoHanded(data.items.get(build.slots.weapon?.itemId ?? 0)));

/**
 * --slot-items "lower=Flaming Weaver|Wind Weaver[str:1]; ...": a slot may
 * hold only these (the ones owned), each at any refine, cards searched as
 * usual. "[stat:n]" is the owned piece's stat roll. The piece worn is
 * re-tried at other refines too.
 */
const slotItems = new Map<string, { id: number; rolls?: Record<string, unknown> }[]>();
for (const part of (one('slot-items') ?? '').split(';').map((s) => s.trim()).filter(Boolean)) {
  const [slot, list] = part.split('=');
  slotItems.set(slot.trim(), list.split('|').map((raw) => {
    const m = /^(.*?)\s*(?:\[(\w+):(-?\d+)\])?$/.exec(raw.trim())!;
    const item = data.itemList.find((i) => i.name.toLowerCase() === m[1].toLowerCase());
    if (!item) throw new Error(`--slot-items: no item named "${m[1]}"`);
    return { id: item.id, ...(m[2] ? { rolls: { stat: { option: m[2], values: [Number(m[3])] } } } : {}) };
  }));
}

function itemMoves(build: Build, slot: SlotDef): Move[] {
  const cur = build.slots[slot.key];
  if (locked.has(slot.key) || skipSlot(slot, build)) return [];
  const only = slotItems.get(slot.key);
  if (only) {
    const out: Move[] = [];
    for (const o of only) {
      const item = data.items.get(o.id)!;
      const keep = keepCards(cur, slot, item);
      const rolls = o.id === cur?.itemId ? cur?.rolls : o.rolls;
      for (const refine of tiersFor(item, slot.key)) {
        if (o.id === cur?.itemId && refine === (cur?.refine ?? 0)) continue;
        out.push({ label: `${slot.label}: ${item.name} +${refine}`,
          slots: { [slot.key]: { itemId: item.id, refine, cards: keep, ...(rolls ? { rolls } : {}) } as SlotState } });
      }
    }
    return out;
  }
  const out: Move[] = [];
  for (const item of data.itemList) {
    if (item.id === cur?.itemId || !fitsSlot(item, slot) || !allowed(item, slot.key)) continue;
    // The census found it adds nothing on its own at any refine.
    if (slot.group === 'shadow' && deadShadow?.has(item.id)) continue;
    // Pieces worn across several slots, and two-handers with a shield kept: not here.
    if (item.equip_slots.length > 1 && slot.group === 'gear' && slot.key !== 'weapon') continue;
    // A two-hander frees the off hand: tried with it emptied, unless the off hand is locked
    // (a dual wielder never tried Crow of Destiny before 2026-10-01).
    const freesOffhand = slot.key === 'weapon' && isTwoHanded(item) && !!build.slots.offhand?.itemId;
    if (freesOffhand && locked.has('offhand')) continue;
    const emptied = freesOffhand ? { offhand: { itemId: null, refine: 0, cards: [] } as SlotState } : {};
    const keep = keepCards(cur, slot, item);
    // --refine-cap holds for a piece swapped in too (a new class gem at +9 is still past gem=6).
    for (const refine of [...new Set(refines(item).map((r) => Math.min(r, refineCap.get(slot.key) ?? r)))]) {
      const best = keep.length < item.card_slots ? bestCards(slot, item, 2) : [];
      const fills: { label: string; cards: number[] }[] = [{ label: '', cards: keep }];
      if (best.length) fills.push({ label: ` [${data.items.get(best[0])!.name} in the empty sockets]`, cards: fillSockets(keep, item, [best[0]]) });
      if (best.length > 1 && item.card_slots - keep.length > 1) {
        fills.push({ label: ` [${best.map((c) => data.items.get(c)!.name).join(' + ')}]`, cards: fillSockets(keep, item, best) });
      }
      for (const r of rollVariants(item, slot.key)) {
        for (const fl of fills) {
          out.push({ label: `${slot.label}: ${item.name} +${refine}${r.label ? ` (${r.label})` : ''}${fl.label}${freesOffhand ? ' (off hand emptied)' : ''}`,
            slots: { ...emptied, [slot.key]: { itemId: item.id, refine, cards: fl.cards, ...(Object.keys(r.rolls).length ? { rolls: r.rolls } : {}) } } });
        }
      }
    }
  }
  return out;
}

/**
 * The piece worn, refined further: locked slots too (a refine is not a swap)
 * and class gems (the data marks them not refineable, but every one has
 * per-refine lines; the planner refines them). To the next tiers up (+3, +6,
 * +9); +9 costs PENALTY.
 */
function refineMoves(build: Build, slot: SlotDef): Move[] {
  const cur = build.slots[slot.key];
  const item = cur?.itemId ? data.items.get(cur.itemId) : null;
  if (!item || !isRefineable(item) || skipSlot(slot, build) || fixedRefine.has(slot.key)) return [];
  const now = cur!.refine ?? 0;
  return tiersFor(item, slot.key).filter((r) => r > now)
    .map((refine) => ({ label: `${slot.label}: ${item.name} +${now} -> +${refine}`, slots: { [slot.key]: { ...cur!, refine } } }));
}
/** --refine-cap "gem=6,weapon=9": the most a slot's piece is refined to. */
const refineCap = new Map((one('refine-cap') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => { const [k, v] = x.split('='); return [k.trim(), Number(v)] as [string, number]; }));
/** --fix-refine slot,...: leave these refines alone. */
const fixedRefine = new Set((one('fix-refine') ?? '').split(',').map((x) => x.trim()).filter(Boolean));

/** --lock-cards weapon,...: these slots keep their cards (the owner swaps whole daggers per race, not cards). */
const cardLocked = new Set((one('lock-cards') ?? '').split(',').map((x) => x.trim()).filter(Boolean));

function cardMoves(build: Build, slot: SlotDef): Move[] {
  const cur = build.slots[slot.key];
  const host = cur?.itemId ? data.items.get(cur.itemId) : null;
  if (!host || !host.card_slots || skipSlot(slot, build) || cardLocked.has(slot.key)) return [];
  const have = (cur!.cards ?? []).filter(Boolean) as number[];
  const out: Move[] = [];
  for (const card of cards) {
    if (!cardFits(card, slot, host) || deadCards?.has(card.id)) continue;
    // Every socket the same card, and (with two or more) one socket swapped.
    const all = Array(host.card_slots).fill(card.id);
    if (JSON.stringify(all) !== JSON.stringify(have)) {
      out.push({ label: `${slot.label}: ${card.name} x${host.card_slots}`, slots: { [slot.key]: { ...cur!, cards: all } } });
    }
    // Each socket on its own: an empty second socket gets filled, a single
    // card swapped, the rest kept (Maiden of Past + a Minorous).
    if (host.card_slots > 1) {
      const sockets = Array.from({ length: host.card_slots }, (_, i) => (cur!.cards ?? [])[i] ?? null);
      for (let i = 0; i < host.card_slots; i++) {
        if (sockets[i] === card.id) continue;
        const next = [...sockets]; next[i] = card.id;
        out.push({ label: `${slot.label}: ${card.name} in socket ${i + 1}`, slots: { [slot.key]: { ...cur!, cards: next as number[] } } });
      }
    }
  }
  return out;
}

/**
 * A whole set at once: shadow sets, armour sets, weapon pairs -- each piece
 * where it fits, at +6 and at +9, with the cards worn there kept where they
 * fit and (2026-10-01) the census's best card in the sockets left empty, as a
 * single new piece gets: a pair judged half-carded against carded singles
 * never won (the Sin Daggers, Hugin + Muninn for a Night Raven). Card sets
 * are cardSetMoves. Shadow sets are the shadow group's once the census has
 * run (shadowMoves).
 */
function setMoves(build: Build): Move[] {
  const out: Move[] = [...cardSetMoves(build)];
  for (const set of data.sets) {
    if (set.member_count < 2 || set.member_count > 5) continue;
    if (shadowTop && set.member_ids.some((id) => data.items.get(id)?.kind === 'Shadow gear')) continue;
    const members = set.member_ids.map((id) => data.items.get(id)).filter((i): i is Item => !!i);
    if (members.length !== set.member_count || members.some((i) => i.kind === 'Card')) continue;
    // New pieces at +6 and +9 as elsewhere -- within --max-refine (the set moves ignored it before 2026-10-01).
    for (const refine of [...new Set([6, 9].map((r) => Math.min(r, maxNewRefine)))]) {
      const slots: Record<string, SlotState> = {};
      let ok = true;
      for (const item of members) {
        const slot = SLOTS.find((s) => !slots[s.key] && !skipSlot(s, build) && !locked.has(s.key)
          && fitsSlot(item, s) && allowed(item, s.key));
        if (!slot) { ok = false; break; }
        const cur = build.slots[slot.key];
        const keep = keepCards(cur, slot, item);
        const fill = keep.length < item.card_slots ? bestCards(slot, item, 1) : [];
        slots[slot.key] = cur?.itemId === item.id ? cur
          : { itemId: item.id, refine: item.refineable ? Math.min(refine, maxRefine(item), refineCap.get(slot.key) ?? 99) : 0,
            cards: fill.length ? fillSockets(keep, item, fill) : keep,
            ...(() => { const r = rollVariants(item, slot.key)[0].rolls; return Object.keys(r).length ? { rolls: r } : {}; })() };
      }
      if (!ok || Object.entries(slots).every(([k, s]) => build.slots[k]?.itemId === s.itemId)) continue;
      out.push({ label: `${set.name} set +${refine}`, slots });
    }
  }
  return out;
}

/**
 * A card set (Elegant Crow: Gentleman + Cavalier Card) into the pieces worn:
 * each card in the last socket of the first worn piece it fits that this
 * move has not used up, the other cards kept. One card at a time never
 * finds a bonus that needs both.
 */
function cardSetMoves(build: Build): Move[] {
  const out: Move[] = [];
  for (const set of data.sets) {
    if (set.member_count < 2 || set.member_count > 5) continue;
    const members = set.member_ids.map((id) => data.items.get(id)).filter((i): i is Item => !!i);
    if (members.length !== set.member_count || members.some((i) => i.kind !== 'Card')) continue;
    if (members.some((c) => !cards.includes(c))) continue;
    const slots: Record<string, SlotState> = {};
    const used = new Map<string, number>();
    let ok = true;
    for (const card of members) {
      const slot = SLOTS.find((sl) => {
        const st = slots[sl.key] ?? build.slots[sl.key];
        const host = st?.itemId ? data.items.get(st.itemId) : null;
        return !!host && !skipSlot(sl, build) && !cardLocked.has(sl.key) && cardFits(card, sl, host)
          && (used.get(sl.key) ?? 0) < host.card_slots;
      });
      if (!slot) { ok = false; break; }
      const st = slots[slot.key] ?? build.slots[slot.key]!;
      const host = data.items.get(st.itemId!)!;
      const n = used.get(slot.key) ?? 0;
      const next = Array.from({ length: host.card_slots }, (_, i) => (st.cards ?? [])[i] ?? null);
      next[host.card_slots - 1 - n] = card.id;
      slots[slot.key] = { ...st, cards: next as number[] };
      used.set(slot.key, n + 1);
    }
    if (!ok || Object.entries(slots).every(([k, st]) => JSON.stringify(build.slots[k]?.cards) === JSON.stringify(st.cards))) continue;
    out.push({ label: `${set.name} card set`, slots });
  }
  return out;
}

// ---- the census -----------------------------------------------------------------
//
// Before the climb, every shadow piece (at each tier) and every card is fought
// on its own against the slot left empty (the project owner, 2026-09-29). What
// adds nothing -- a bonus the fight never reads, or one worth less than an
// empty slot -- is left out of the whole search; what is left ranks the
// shadow pieces for the mixes. Shadow sets on this server are four pieces or
// no bonus, so a mix is the best single piece in each slot.

/** Shadow pieces and cards the census found add nothing (null: no census). */
let deadShadow: Set<number> | null = null;
let deadCards: Set<number> | null = null;
/**
 * The census's estimate of each card alone (a gain over the empty slot).
 * A new piece with empty sockets is also tried with them filled by the best
 * card that fits (fillSockets): a weapon or an accessory bought for its
 * sockets (Ominous Lament, a Sage Ring) cannot win bare against a piece that
 * came with cards -- the project owner's point, 2026-10-01.
 */
const cardEstimate = new Map<number, number>();
/** The live shadow pieces per slot, best first, each at its best tier; and the best whole shadow sets. */
let shadowTop: Map<string, { id: number; refine: number; gain: number }[]> | null = null;
let setTop: { name: string; slots: Record<string, SlotState>; refine: number; gain: number }[] = [];
/** The four slots a shadow set fills. The manual and the rune are single-piece slots. */
const SET_SHADOW = ['sh_armor', 'sh_gloves', 'sh_shoes', 'sh_acc'];
/** --shadow-top K: pieces per slot the mixes are made from (K^4 mixes). */
const shadowK = Number(one('shadow-top') ?? 3);

/** Whole shadow sets and mixes of the census's best pieces, each filling the four set slots. */
function shadowMoves(build: Build): Move[] {
  if (!shadowTop) return [];
  const same = (slots: Record<string, SlotState>) => Object.entries(slots)
    .every(([k, s]) => build.slots[k]?.itemId === s.itemId && (build.slots[k]?.refine ?? 0) === s.refine);
  const out: Move[] = [];
  for (const s of setTop) if (!same(s.slots)) out.push({ label: `shadow: ${s.name} set +${s.refine}`, slots: s.slots });
  const slots = SET_SHADOW.filter((k) => (shadowTop!.get(k) ?? []).length);
  let mixes: Record<string, SlotState>[] = [{}];
  for (const k of slots) {
    mixes = mixes.flatMap((m) => shadowTop!.get(k)!.slice(0, shadowK)
      .map((p) => ({ ...m, [k]: { itemId: p.id, refine: p.refine, cards: [] } })));
  }
  for (const m of mixes) {
    if (!Object.keys(m).length || same(m)) continue;
    const label = slots.map((k) => `${data.items.get(m[k].itemId!)!.name} +${m[k].refine}`).join(', ');
    out.push({ label: `shadow mix: ${label}`, slots: m });
  }
  return out;
}

// ---- stats ----------------------------------------------------------------------

const STAT_CAP = Math.max(99, ...STATS.map((k) => start.baseStats[k] ?? 0));
/** Status points to raise a stat from 1 to x: floor((v - 1) / 10) + 2 for each step v -> v + 1. */
// The server's own raise cost (RTM pc.cpp:8091, RENEWAL_STAT): 1 + floor(v / 49)
// a point from v -- 1 below 49, 2 to 97, 3 from 98. Not stock rAthena's
// floor((v-1)/10) + 2 (the project owner, 2026-09-28; the owner's spread
// costs 440 of the 439 Lv136 gives by this rule).
const statCost = (x: number) => { let c = 0; for (let v = 1; v < x; v++) c += 1 + Math.floor(v / 49); return c; };

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

/** The rotation's switches, each tried the other way, and play styles that set several (the kit's RotationSpace). */
const OPTION_CHOICES: Record<string, unknown[]> = space.switches;
const OPTION_SETS: Record<string, Record<string, unknown>> = space.sets ?? {};
/**
 * --fix "rogueFillers=false,autoAttack=false": switches set as given and
 * never searched -- the owner's rules, where the sim would rather not.
 */
const fixedOptions: Record<string, unknown> = Object.fromEntries((one('fix') ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
  const [k, v] = s.split('=').map((x) => x.trim());
  if (!(k in OPTION_CHOICES)) throw new Error(`--fix: no rotation switch "${k}"`);
  return [k, v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v];
}));
function optionMoves(options: Record<string, unknown>): Move[] {
  const out: Move[] = [];
  for (const [k, choices] of Object.entries(OPTION_CHOICES)) {
    if (k in fixedOptions) continue;
    const now = options[k] ?? choices[0];
    for (const v of choices) if (v !== now) out.push({ label: `rotation: ${k} = ${v}`, options: { [k]: v } });
  }
  for (const [name, set] of Object.entries(OPTION_SETS)) {
    if (Object.entries(set).some(([k, v]) => k in fixedOptions && fixedOptions[k] !== v)) continue;
    if (Object.entries(set).some(([k, v]) => (options[k] ?? OPTION_CHOICES[k]?.[0]) !== v)) out.push({ label: `rotation: ${name}`, options: set });
  }
  return out;
}

/**
 * The rotation's priority order (a kit's ORDER, as option order): each skill
 * moved up or down one or two places. Reactions (dodges) are not in it.
 * --only order searches just this; with rotation, the whole rotation.
 */
function orderMoves(options: Record<string, unknown>): Move[] {
  const base = (Array.isArray(options.order) ? options.order : kitOrder) as string[];
  if (!base?.length) return [];
  const pinned = new Set(space.pinned ?? []);
  const droppable = new Set(space.droppable ?? []);
  const out: Move[] = [];
  for (let i = 0; i < base.length; i++) {
    if (pinned.has(base[i])) continue;
    for (const d of [-2, -1, 1, 2]) {
      const j = i + d;
      if (j < 0 || j >= base.length) continue;
      const o = [...base]; const [x] = o.splice(i, 1); o.splice(j, 0, x);
      out.push({ label: `order: ${x} ${d < 0 ? 'up' : 'down'} ${Math.abs(d)} (before ${d < 0 ? base[j] : base[j + 1] ?? 'end'})`, options: { order: o } });
    }
    // A skill the rotation may do without: left out whole (the kit never casts what its order does not name).
    if (droppable.has(base[i])) out.push({ label: `order: leave out ${base[i]}`, options: { order: base.filter((y) => y !== base[i]) } });
  }
  // What an earlier step (or the profile) left out, put back at each place.
  for (const x of (kitOrder ?? []).filter((y) => !base.includes(y) && droppable.has(y))) {
    for (let j = 0; j <= base.length; j++) {
      const o = [...base]; o.splice(j, 0, x);
      out.push({ label: `order: put back ${x} before ${base[j] ?? 'the end'}`, options: { order: o } });
    }
  }
  return out;
}

const apply = (s: State, m: Move): State => {
  const build: Build = structuredClone(s.build);
  for (const [k, v] of Object.entries(m.slots ?? {})) build.slots[k] = structuredClone(v);
  // A two-handed weapon takes both hands: the off hand empties.
  if (isTwoHanded(data.items.get(build.slots.weapon?.itemId ?? 0)) && build.slots.offhand?.itemId) build.slots.offhand = { itemId: null, refine: 0, cards: [] };
  if (m.stats) build.baseStats = { ...m.stats };
  return { build, options: { ...s.options, ...(m.options ?? {}) }, ...(s.only ? { only: s.only } : {}) };
};

/** The score's handicap: new MVP-only pieces and cards, new +9s, pieces made from a +9. */
function penalty(build: Build): number {
  let p = 0;
  for (const [k, st] of Object.entries(build.slots)) {
    if (!st?.itemId) continue;
    const was = start.slots[k];
    const item = data.items.get(st.itemId);
    if (item && was?.itemId !== st.itemId) {
      if (mvpOnly(item)) p += MVP_PENALTY;
      if (ssOnly(item)) p += PENALTY;
      if (madeFromNine(item)) p += PENALTY;
    }
    if (st.refine >= 9 && !(was?.itemId === st.itemId && (was.refine ?? 0) >= 9)) p += PENALTY;
    const before = new Set((was?.cards ?? []).filter(Boolean));
    for (const id of new Set((st.cards ?? []).filter(Boolean) as number[])) {
      const c = data.items.get(id);
      if (c && !before.has(id) && mvpOnly(c)) p += MVP_PENALTY;
    }
  }
  return p;
}

// ---- fighting ------------------------------------------------------------------

interface Score {
  win: number; loss: number; dps: number; ttk: number | null; value: number; deaths: string; farm?: { sb: number; sbkc: number; qg: number }; rhythm?: Rhythm; axes?: number[];
  /** Per target (by index into targets): the spread of one fight's share of the score, and ms a fight -- what the fight counts are sized from. */
  spread?: { sd: (number | null)[]; ms: (number | null)[]; z: (number[] | null)[] };
}

/**
 * Fights per target, by index into targets (--flat: none, every target gets
 * n). A target whose fights all come out alike needs few; one whose fights
 * swing (stalls, deaths, a long tail) needs many; a slow one costs more a
 * fight -- the Neyman split, n_t ~ sd_t / sqrt(ms_t), scaled so the score's
 * noise is what n flat fights a target would give. On the endgame farm
 * build (62 targets) that is the same precision for ~1/4 of the fights
 * (2026-09-30): 23 targets never vary, Famine Incarnate's stalls vary most.
 */
let alloc: { sd: number[]; ms: number[] } | null = null;
const flat = flag('flat');
function fightsFor(n: number): number[] | null {
  if (!alloc || flat) return null;
  const { sd, ms } = alloc;
  const lo = Math.max(2, Math.round(n / 10));
  const top = Math.max(...sd);
  if (!(top > 0)) return sd.map(() => lo);
  // A floor on the spread: a rare death an estimate missed still gets fights.
  const s2 = sd.map((x) => Math.max(x, 0.05 * top));
  const sumSq = s2.reduce((a, x) => a + x * x, 0);
  const sumSc = s2.reduce((a, x, i) => a + x * Math.sqrt(ms[i]), 0);
  return s2.map((x, i) => Math.min(8 * n, Math.max(lo, Math.round((n * (x / Math.sqrt(ms[i])) * sumSc) / sumSq))));
}
/** Take the spread a confirm run measured as the one to size fights by. */
function learnSpread(sc: Score) {
  if (!sc.spread || flat) return;
  const prev = alloc;
  // A target not fought this time (the per-target phase) keeps what it had.
  alloc = {
    sd: targets.map((_, i) => sc.spread!.sd[i] ?? prev?.sd[i] ?? 0),
    ms: targets.map((_, i) => Math.max(0.02, sc.spread!.ms[i] ?? prev?.ms[i] ?? 1)),
  };
}

/**
 * One fight's share of the score, linearised: what a fight moves the score
 * by, around the batch's own means. Its spread per target sizes the fight
 * counts (fightsFor).
 */
function spreadOf(f: Awaited<ReturnType<typeof buildFighter>>, options: Record<string, unknown>, fought: { i: number; w: number; s: Summary }[]): Score['spread'] {
  const sd: (number | null)[] = targets.map(() => null);
  const ms: (number | null)[] = targets.map(() => null);
  // Each fight's own share, kept for the paired test of a confirm (pairedSe).
  const zs: (number[] | null)[] = targets.map(() => null);
  const std = (z: number[]) => {
    if (z.length < 2) return 0;
    const m = z.reduce((a, b) => a + b, 0) / z.length;
    return Math.sqrt(z.reduce((a, x) => a + (x - m) ** 2, 0) / (z.length - 1));
  };
  const W = fought.reduce((a, x) => a + x.w, 0) || 1;
  if (rhythmScore) {
    // value = G / C: G = 36 kills - 3600 (dw deaths + sw stalls), C the cycle, both spawn-weighted means.
    const regen = sitRegen(f, kit.kit, options);
    const g = (r: FightRow) => (r.result === 'win' ? 36 : 0) - 3600 * (r.result === 'loss' ? deathWeight : r.result === 'stalemate' ? stallWeight : 0);
    const c = (r: FightRow) => r.t + (r.result === 'loss' ? DEATH_S : sitFor(r.sp, r.hp, regen) + walkFor(f));
    const mean = (rows: FightRow[], fn: (r: FightRow) => number) => rows.reduce((a, r) => a + fn(r), 0) / Math.max(1, rows.length);
    const G = fought.reduce((a, x) => a + (x.w / W) * mean(x.s.perFight!, g), 0);
    const C = fought.reduce((a, x) => a + (x.w / W) * mean(x.s.perFight!, c), 0) || 1;
    if (perHourCharge) {
      for (const x of fought) zs[x.i] = x.s.perFight!.map((r) => ((x.w / W) * (g(r) - (G / C) * c(r))) / C);
    } else {
      // Charged per kill: value = 36 K / C - PER_KILL_REF P / K (K kills, C the cycle, P the
      // weighted deaths and stalls, a cycle each), linearised in each fight's k, c and p.
      const k = (r: FightRow) => (r.result === 'win' ? 1 : 0);
      const pen = (r: FightRow) => (r.result === 'loss' ? deathWeight : r.result === 'stalemate' ? stallWeight : 0);
      const K = Math.max(1e-6, fought.reduce((a, x) => a + (x.w / W) * mean(x.s.perFight!, k), 0));
      const P = fought.reduce((a, x) => a + (x.w / W) * mean(x.s.perFight!, pen), 0);
      const dK = 36 / C + (PER_KILL_REF * P) / (K * K); const dC = -(36 * K) / (C * C); const dP = -PER_KILL_REF / K;
      for (const x of fought) zs[x.i] = x.s.perFight!.map((r) => (x.w / W) * (dK * k(r) + dC * c(r) + dP * pen(r)));
    }
  } else {
    // value = mean over targets of win + a (1 - loss) + speed(dps); dps linearised around the batch's.
    const a = safeScore ? 0.5 : 0.3;
    for (const x of fought) {
      const rows = x.s.perFight!;
      const T = rows.reduce((acc, r) => acc + r.t, 0) / Math.max(1, rows.length) || 1;
      const dps = x.s.dps;
      const slope = safeScore ? 0.1 / (Math.LN2 * (20_000 + dps)) : 0.3 / 20_000;
      zs[x.i] = rows.map((r) => ((r.result === 'win' ? 1 : 0) + a * (r.result === 'loss' ? 0 : 1) + (slope * (r.dealt - dps * r.t)) / T) / fought.length);
    }
  }
  for (const x of fought) { ms[x.i] = x.s.msPerFight; sd[x.i] = std(zs[x.i]!); }
  return { sd, ms, z: zs };
}

/**
 * The noise on b's gain over a, fought on the same seeds: each target's
 * fights paired one by one (the same seed, so much of the luck cancels).
 * Infinity when the two were not fought alike.
 */
function pairedSe(a: Score, b: Score): number {
  const za = a.spread?.z; const zb = b.spread?.z;
  if (!za || !zb) return Infinity;
  let v = 0;
  for (let t = 0; t < targets.length; t++) {
    const x = za[t]; const y = zb[t];
    if (!x && !y) continue;
    if (!x || !y || x.length !== y.length) return Infinity;
    const n = x.length;
    if (n < 2) continue;
    const d = y.map((yi, i) => yi - x[i]);
    const m = d.reduce((acc, di) => acc + di, 0) / n;
    v += d.reduce((acc, di) => acc + (di - m) ** 2, 0) / (n - 1) / n;
  }
  return Math.sqrt(v);
}
/**
 * --accept-z Z: a change is kept only if its confirmed gain clears 0.01 and
 * Z times its paired noise (2 by default; 0 is the old rule, the bar alone).
 * On the endgame farm build a 150-fight confirm's paired noise was ~0.05 of
 * score (2026-09-30), five times the bar: best-of-four on one seed set kept
 * neutral changes about half the time. A finalist that clears the bar but
 * not the noise is fought again on fresh seeds (--confirm-more, 3 times at
 * most) and the rounds pooled.
 */
const acceptZ = Number(one('accept-z') ?? 2);
/** A score without its per-fight numbers, for the saved file. */
const lean = (sc: Score): Score => { const { spread: _s, ...rest } = sc; return rest; };
const confirmMore = Number(one('confirm-more') ?? 3);

/** This worker's marks for the live view (src/live.ts): no-ops on the main thread or under --no-live. */
const marks = new LiveMarks(isMainThread ? undefined : workerData?.live, isMainThread ? 0 : workerData?.slot ?? 0);

async function fight(s: State, n: number, seed: number, per: number[] | null = null, wantSpread = false): Promise<Score> {
  const f = await buildFighter({ ...profile, build: s.build }, { passives: kit.passives, aliases: kit.aliases, maxLevels: kit.maxLevels() });
  if (farmMode) {
    const fs = farmScore(f, kit.kit, s.options, targets.map((m, i) => ({ m, weight: farmWeights[i] })));
    return { win: fs.qg, loss: 1 - fs.sbkc, dps: 0, ttk: null, value: fs.value, deaths: '', farm: { sb: fs.sb, sbkc: fs.sbkc, qg: fs.qg } };
  }
  let win = 0; let loss = 0; let dps = 0; let ttk = 0; let ttkN = 0;
  const deaths: Record<string, number> = {};
  const idx = s.only ?? targets.map((_, i) => i);
  const fought = idx.map((i) => targets[i]);
  const sums: { s: Summary; weight: number }[] = [];
  for (let j = 0; j < fought.length; j++) {
    const m = fought[j];
    // Per-target counts only across the whole list (the per-target phase fights one target, flat).
    const iterations = per && !s.only ? per[idx[j]] : n;
    marks.target(idx[j]);
    const r = simulate(f, m, kit.kit, {
      iterations, seed, policy, options: s.options, limitMs: limitFor(m), perFight: wantSpread,
      items: loadout({ carried: profile.consumables ?? DEFAULT_CONSUMABLES, healing: flag('healing') || !!profile.healing,
        boss: m.boss, elixirs: f.kafraElixirs }),
    });
    marks.fought(iterations);
    sums.push({ s: r, weight: rhythmWeights.get(m.name) ?? 1 });
    win += r.winRate; loss += r.losses / iterations; dps += r.dps;
    if (r.ttk) { ttk += r.ttk.p50; ttkN++; }
    for (const [k, v] of Object.entries(r.deaths)) deaths[k] = (deaths[k] ?? 0) + v;
  }
  const k = fought.length;
  win /= k; loss /= k; dps /= k;
  const top = Object.entries(deaths).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c, v]) => `${c} x${v}`).join(', ');
  const spread = wantSpread ? spreadOf(f, s.options, sums.map((x, j) => ({ i: idx[j], w: x.weight, s: x.s }))) : undefined;
  // Once every fight is a win, speed is what is left to gain: 0.01 of score
  // (the bar a change must clear) is ~670 DPS.
  // The penalty is the main thread's (fightAll), so equal fighters share a score.
  // --hp-weight W: Max HP toward the 50k cap is worth W at the cap (Rook's Smash and Queen's Brand scale on HP).
  // --score safe: survival first (the project owner, 2026-09-28) -- not losing counts more, and speed on
  // a log scale, so 10% faster is worth about 1% more wins at any DPS. The default weighs DPS linearly.
  // --score rhythm: kills an hour fighting, sitting back to full and pulling
  // again (src/rhythm.ts; the project owner's Tomb plan, 2026-09-29), a death
  // an hour costing --death-weight x 100 kills (0.1: 10 kills). --map weighs the targets by spawns.
  if (rhythmScore) {
    const r = rhythm(f, kit.kit, s.options, sums);
    const scale = perHourCharge ? 1 : PER_KILL_REF / Math.max(1, r.killsPerHour);
    return { win, loss, dps, ttk: ttkN ? ttk / ttkN : null, value: r.killsPerHour / 100 - scale * (deathWeight * r.deathsPerHour + stallWeight * r.stallsPerHour), deaths: top, rhythm: r, spread };
  }
  // --min-hp N: a build under N Max HP is out, whatever it deals.
  if (minHp && f.maxHp < minHp) return { win, loss, dps, ttk: ttkN ? ttk / ttkN : null, value: -1, deaths: top, spread };
  const speed = safeScore ? 0.1 * Math.log2(1 + dps / 20_000) : 0.3 * (dps / 20_000);
  const value = win + (safeScore ? 0.5 : 0.3) * (1 - loss) + speed + hpWeight * Math.min(1, f.maxHp / 50_000);
  return { win, loss, dps, ttk: ttkN ? ttk / ttkN : null, value, deaths: top, spread };
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
  // Per target: DPS, lowest HP, lowest HP as a share, won, not lost -- the census's axes.
  const axes: number[] = [];
  for (const [ti, m] of targets.entries()) {
    marks.target(ti);
    const fi = newFight(f, m, kit.kit, policy, { seed: 1, limitMs: limitFor(m), options: s.options,
      items: loadout({ carried: profile.consumables ?? DEFAULT_CONSUMABLES, healing: flag('healing') || !!profile.healing,
        boss: m.boss, elixirs: f.kafraElixirs }) });
    fi.rng = new Rng(0, true);
    run(fi);
    marks.fought(1);
    const d = (m.hp - Math.max(0, fi.mob.hp)) / Math.max(1, fi.t / 1000);
    dps += d;
    const low = Math.max(0, fi.meter!.minHp);
    value += (fi.result === 'win' ? 1 : 0) + 0.3 * (fi.result === 'loss' ? 0 : 1) + 0.3 * (d / 20_000)
      + 0.2 * low / f.maxHp;
    axes.push(d / 20_000, low / 10_000, low / f.maxHp, fi.result === 'win' ? 1 : 0, fi.result === 'loss' ? 0 : 1);
  }
  const k = targets.length;
  return { win: 0, loss: 0, dps: dps / k, ttk: null, value: value / k, deaths: '', axes };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const show = (s: Score) => s.farm
  ? `one-button ${pct(s.farm.sb)} two-button ${pct(s.farm.sbkc)} Queen's Gambit clears ${pct(s.farm.qg)}`
  : `win ${pct(s.win)} lost ${pct(s.loss)} ${Math.round(s.dps).toLocaleString('en-US')} dps${s.ttk ? ` ${s.ttk.toFixed(0)}s` : ''}${s.rhythm ? ` ${s.rhythm.killsPerHour.toFixed(0)} kills/h (sit ${s.rhythm.sitS.toFixed(1)}s) ${s.rhythm.deathsPerHour.toFixed(1)} deaths/h` : ''}`;

// ---- the workers -----------------------------------------------------------------
//
// Screening is thousands of independent batches: split across worker
// threads (--workers, default all cores but one). Each worker runs this same
// file with the same arguments, so it loads the profile, data and targets
// itself, then fights whatever states it is sent.

interface Job { id: number; state: State; n: number; seed: number; estimate?: boolean; per?: number[] | null; spread?: boolean }


class Pool {
  private idle: Worker[] = [];
  private queue: { job: Job; done: (s: Score) => void }[] = [];
  private waiting = new Map<number, (s: Score) => void>();
  private next = 0;
  private slot = new Map<Worker, number>();
  /** What each worker is fighting now, by its slot (null: idle) -- for the live view. */
  readonly busy: (Job | null)[] = [];
  constructor(size: number, live?: SharedArrayBuffer) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL(import.meta.url), { execArgv: process.execArgv, argv: process.argv.slice(2), workerData: { live, slot: i } });
      this.slot.set(w, i);
      this.busy.push(null);
      w.on('message', (msg: { id: number; score: Score }) => {
        this.busy[i] = null;
        this.waiting.get(msg.id)!(msg.score);
        this.waiting.delete(msg.id);
        this.idle.push(w);
        this.pump();
      });
      w.on('error', (e) => { console.error('worker error:', e); process.exit(1); });
      w.on('exit', (code) => { if (code !== 0 && !this.closing) { console.error(`worker exited with ${code}`); process.exit(1); } });
      this.idle.push(w);
    }
  }
  run(state: State, n: number, seed: number, est = false, per: number[] | null = null, spread = false): Promise<Score> {
    return new Promise((done) => { this.queue.push({ job: { id: this.next++, state, n, seed, estimate: est, per, spread }, done }); this.pump(); });
  }
  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!; const { job, done } = this.queue.shift()!;
      this.waiting.set(job.id, done);
      this.busy[this.slot.get(w)!] = job;
      w.postMessage(job);
    }
  }
  private closing = false;
  close() { this.closing = true; for (const w of this.idle) void w.terminate(); }
}

// ---- the live view (src/live.ts) ------------------------------------------------

const slotLabel = (k: string) => SLOTS.find((s) => s.key === k)?.label ?? k;
function slotText(st: SlotState | undefined): string {
  if (!st?.itemId) return 'empty';
  const cs = (st.cards ?? []).filter(Boolean).map((c) => data.items.get(c!)?.name ?? `#${c}`);
  return `${data.items.get(st.itemId)?.name ?? `#${st.itemId}`}${st.refine ? ` +${st.refine}` : ''}${cs.length ? ` [${cs.join(', ')}]` : ''}`;
}
/** The piece by id: the page draws its icon (not the cards': the owner, 2026-10-01). */
const slotIds = (st: SlotState | undefined): number[] => (st?.itemId ? [st.itemId] : []);
/** What a candidate changes from the build it is tried against, in words. */
function changesFrom(cur: State, st: State): LiveWorker['changes'] {
  const out: LiveWorker['changes'] = [];
  for (const k of new Set([...Object.keys(cur.build.slots), ...Object.keys(st.build.slots)])) {
    const a = cur.build.slots[k]; const b = st.build.slots[k];
    // Candidates often differ only in their random options (HP leech or SP recovery): shown too.
    const rolled = JSON.stringify(a?.rolls ?? null) !== JSON.stringify(b?.rolls ?? null);
    const rolls = rolled ? ` · ${Object.values(b?.rolls ?? {}).map((r) => `${r.option} ${r.values.join('/')}`).join(', ') || 'no rolls'}` : '';
    if (slotSig(a) !== slotSig(b) || rolled) out.push({ key: k, text: `${slotLabel(k)}: ${slotText(b)}${rolls}`, ids: slotIds(b) });
  }
  const stats = STATS.filter((s) => (cur.build.baseStats[s] ?? 0) !== (st.build.baseStats[s] ?? 0));
  if (stats.length) out.push({ key: 'stats', text: stats.map((s) => `${s.toUpperCase()} ${cur.build.baseStats[s]}→${st.build.baseStats[s]}`).join(' ') });
  for (const [k, v] of Object.entries(st.options)) {
    if (JSON.stringify(cur.options[k]) !== JSON.stringify(v)) out.push({ key: 'options', text: `${k}: ${JSON.stringify(v)}` });
  }
  return out;
}
const liveScore = (s: Score): LiveScore => ({ value: s.value, win: s.win, loss: s.loss, dps: s.dps,
  ...(s.rhythm ? { killsPerHour: s.rhythm.killsPerHour, deathsPerHour: s.rhythm.deathsPerHour, sitS: s.rhythm.sitS } : {}) });

// ---- the search -----------------------------------------------------------------

/**
 * The per-target phase: a swap away from the shared build costs this much
 * score a slot (--swap-cost, a share of that target's DPS: 0.1 = a swap must
 * buy ~10% faster kills). Stats stay put -- no respec mid-dungeon.
 */
let swapBase: Build | null = null;
let swapPenalty = 0;
/** --swap-slots weapon,runeorb: in the per-target phase only these slots change (a weapon per race, a rune per element). */
const swapSlots = one('swap-slots') ? new Set(one('swap-slots')!.split(',').map((x) => x.trim())) : null;
const slotSig = (st: Build['slots'][string]) => st?.itemId ? `${st.itemId}+${st.refine}:${(st.cards ?? []).join(',')}` : '';
const swappedSlots = (b: Build) => (swapBase ? Object.keys({ ...swapBase.slots, ...b.slots })
  .filter((k) => slotSig(swapBase!.slots[k]) !== slotSig(b.slots[k])) : []);
function swapCharge(b: Build): number { return swapPenalty * swappedSlots(b).length; }

async function main() {
// Core 0 stays free for the player; the worker threads share the pin (src/cpu.ts).
if (isMainThread) leaveFirstCore();
const workers = Math.max(1, Number(one('workers') ?? workCores()));
// What the live view shows besides the counters: kept up to date as the search goes. --no-live: no feed.
const shown = {
  phase: 'baseline', pass: 0, group: '', groupAt: 0, groups: 0, tried: 0, tag: '',
  score: null as LiveScore | null, best: null as { label: string; gain: number } | null,
  /** The share payload of the build found, once the search is done (the page loads it). */
  result: null as string | null,
};
const feed = flag('no-live') ? null : new LiveFeed(workers, () => ({
  profile: profile.name ?? one('profile'), className, vs: vsList, maps: (one('map') ?? '').split(',').filter(Boolean),
  scoreMode: rhythmScore ? 'rhythm' : farmMode ? 'farm' : safeScore ? 'safe' : 'fight',
  ...shown,
  build: {
    slots: SLOTS.filter((s) => state.build.slots[s.key]?.itemId).map((s) => ({ key: s.key, label: s.label, text: slotText(state.build.slots[s.key]), ids: slotIds(state.build.slots[s.key]) })),
    stats: state.build.baseStats, options: state.options,
  },
  steps: steps.slice(-12).map((x) => ({ move: x.move, before: liveScore(x.before), after: liveScore(x.after), tried: x.tried })),
  workers: pool.busy.map((job): LiveWorker => (job
    ? { kind: job.estimate ? 'estimate' : job.spread ? 'confirm' : 'screen', fights: job.n, target: null, changes: changesFrom(state, job.state).slice(0, 6) }
    : { kind: 'idle', fights: 0, target: null, changes: [] })),
}), targets.map((m) => m.name));
const pool = new Pool(workers, feed?.buffer);
// Many candidates make the very same fighter (a bonus the fight never reads,
// a roll that changes nothing): fought once, on the same seeds, they would
// score the same -- so they share one result. The penalty is per build.
const cache = new Map<string, Score>();
const mods = ['damage', 'cooldown', 'sp cost'];
async function fingerprint(st: State): Promise<string> {
  const f = await buildFighter({ ...profile, build: st.build }, { passives: kit.passives, aliases: kit.aliases, maxLevels: kit.maxLevels() });
  const { name: _n, notes: _no, gearText, skillMods, ...rest } = f as typeof f & { notes: unknown };
  const skillBonus = Object.keys(f.skillLevels).map((sk) => mods.map((m) => { const x = skillMods(sk, m); return `${x.flat},${x.percent}`; }).join('|'));
  return JSON.stringify([rest, skillBonus, /Shield Boomerang can combo into King's Chains/i.test(gearText ?? ''), st.options, st.only ?? null]);
}
let fought = 0; let shared = 0;
/**
 * n = 0: the estimate (one expected-value fight a target), not a screen.
 * Otherwise n is the precision of n fights a target: fightsFor sizes each
 * target's own count. spread: measure the fights' spread too (confirm runs),
 * for the next sizing.
 */
let fightsRun = 0;
async function fightAll(states: State[], n: number, seed: number, spread = false): Promise<Score[]> {
  const per = n ? fightsFor(n) : null;
  const keys: string[] = [];
  for (const st of states) keys.push(`${await fingerprint(st)}#${n ? `${n}#${seed}#${per && !st.only ? per.join(',') : 'flat'}` : 'est'}${spread ? '#s' : ''}`);
  const todo = new Map<string, State>();
  keys.forEach((k, i) => { if (!cache.has(k) && !todo.has(k)) todo.set(k, states[i]); });
  fought += todo.size; shared += states.length - todo.size;
  for (const st of todo.values()) {
    const idx = st.only ?? targets.map((_, i) => i);
    fightsRun += n ? idx.reduce((a, i) => a + (per && !st.only ? per[i] : n), 0) : 0;
  }
  await Promise.all([...todo].map(([k, st]) => pool.run(st, n, seed, n === 0, per, spread).then((sc) => { cache.set(k, sc); })));
  return states.map((st, i) => { const sc = cache.get(keys[i])!; return { ...sc, value: sc.value - penalty(st.build) - swapCharge(st.build) }; });
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
/**
 * --no-mvp starts from the build with its MVP-only pieces and cards taken
 * off, and --max-refine caps what is already worn too: a cheap set is cheap
 * all through, not only in what the search adds.
 *
 * --cheapen holds the worn build to every rule the search holds new pieces
 * to -- for a tier searched from a richer build (budget and baseline from
 * the maxed-out one): SS-dungeon drops out unless --allow-ss (Weavers kept),
 * MVP drops over --mvp-max-level out, --refine-cap per slot. --mid-rolls:
 * the worn pieces' random options set to the middle of their range (what a
 * new piece is given), not bought ones.
 */
const midRolls = flag('mid-rolls');
function cheapen(b: Build): Build {
  const strict = flag('cheapen');
  if (!noMvp && !one('max-refine') && !strict && !midRolls) return b;
  const out: Build = structuredClone(b);
  const banned = (item: Item | undefined | null) => !!item && ((noMvp && mvpOnly(item))
    || (strict && ((!allowSs && ssOnly(item) && !isWeaver(item)) || mvpTooHigh(item) || (maxNewRefine < 9 && madeFromNine(item)))));
  for (const [k, st] of Object.entries(out.slots)) {
    if (!st?.itemId) continue;
    const item = data.items.get(st.itemId);
    if (banned(item)) { out.slots[k] = { itemId: null, refine: 0, cards: [] }; console.log(`cheap: ${k} ${item!.name} off`); continue; }
    // Weapons are exempt from the refine cap (the project owner, 2026-09-29: "+8 except weapons").
    if (one('max-refine') && st.refine > maxNewRefine && k !== 'weapon') { console.log(`cheap: ${k} ${item?.name} +${st.refine} -> +${maxNewRefine}`); st.refine = maxNewRefine; }
    const cap = refineCap.get(k);
    if (strict && cap !== undefined && st.refine > cap) { console.log(`cheap: ${k} ${item?.name} +${st.refine} -> +${cap}`); st.refine = cap; }
    st.cards = st.cards.map((c) => {
      const card = c ? data.items.get(c) : null;
      if (banned(card)) { console.log(`cheap: ${k} ${card!.name} out`); return null; }
      return c;
    }) as typeof st.cards;
    if (midRolls && st.rolls && item) {
      const table = rollTableFor(data.rolls, k, item);
      for (const [rk, pick] of Object.entries(st.rolls)) {
        const opt = table?.rolls.find((r) => r.key === rk)?.options.find((o) => o.key === pick.option);
        if (!opt) continue;
        const values = opt.grants.map((g) => clampRoll(g, (g.min + (g.max ?? g.min)) / 2));
        if (JSON.stringify(values) !== JSON.stringify(pick.values)) console.log(`cheap: ${k} ${pick.option} ${pick.values.join('/')} -> ${values.join('/')}`);
        st.rolls[rk] = { option: pick.option, values };
      }
    }
  }
  return out;
}
/**
 * Cards bound to the character ("Card is character bound": Revenant Ebel,
 * Trainer Fenrir) -- one per character (the project owner, 2026-10-01).
 */
const boundCards = new Set(data.itemList.filter((i) => i.kind === 'Card' && /character bound/i.test(i.description ?? '')).map((i) => i.id));
function boundOk(b: Build): boolean {
  const seen = new Set<number>();
  for (const st of Object.values(b.slots)) {
    for (const c of st?.cards ?? []) {
      if (!c || !boundCards.has(c)) continue;
      if (seen.has(c)) return false;
      seen.add(c);
    }
  }
  return true;
}
/** A build as it may be worn: a second copy of a bound card comes out. */
function oneBound(b: Build): Build {
  if (boundOk(b)) return b;
  const out: Build = structuredClone(b);
  const seen = new Set<number>();
  for (const [k, st] of Object.entries(out.slots)) {
    if (!st) continue;
    st.cards = st.cards.map((c) => {
      if (!c || !boundCards.has(c)) return c;
      if (seen.has(c)) { console.log(`bound: ${k} ${data.items.get(c)?.name} out (one per character)`); return null; }
      seen.add(c); return c;
    }) as typeof st.cards;
  }
  return out;
}
/** Both hands on a two-handed weapon: whatever the build had in the off hand comes off. */
function twoHands(b: Build): Build {
  if (!isTwoHanded(data.items.get(b.slots.weapon?.itemId ?? 0)) || !b.slots.offhand?.itemId) return b;
  console.log(`off hand: ${data.items.get(b.slots.offhand.itemId)?.name} off (two-handed weapon)`);
  return { ...b, slots: { ...b.slots, offhand: { itemId: null, refine: 0, cards: [] } } };
}
let state: State = { build: oneBound(twoHands(cheapen(start))), options: { ...(profile.options ?? {}), ...fixedOptions } };
let seedBase = 1;
const steps: { move: string; before: Score; after: Score; tried: number }[] = [];
feed?.start();
const [first] = await fightAll([state], confirmN, 10_000, true);
learnSpread(first);
shown.score = liveScore(first);
if (one('set')) console.log(`from the profile with: ${one('set')}`);
console.log(`start: ${show(first)}  (${targets.map((m) => m.name).join(', ')}, ${confirmN} fights, ${workers} workers)`);
{
  const per = fightsFor(confirmN);
  if (per && targets.length > 1) {
    const cost = (xs: number[]) => xs.reduce((a, x, i) => a + x * alloc!.ms[i], 0);
    console.log(`  fights per target (precision of ${screenN} flat): ${fightsFor(screenN)!.map((x, i) => `${targets[i].name} ${x}`).join(', ')}`);
    console.log(`  a confirm costs ${(100 * cost(per) / cost(targets.map(() => confirmN))).toFixed(0)}% of ${confirmN} flat fights (--flat: every target the same)`);
  }
}

/**
 * Which stat a roll is best spent on: a piece already worn with a stat roll
 * gets it set to each of the top stats in turn, and the three are fought.
 */
async function probeRollStat(): Promise<void> {
  if (flag('all-roll-stats')) return;
  // Nothing new gets rolled when no gear slot is searched (--only rotation,order).
  if (only && !SLOTS.some((s) => only.has(s.key)) && !only.has('sets') && !only.has('shadow')) return;
  for (const [key, st] of Object.entries(state.build.slots)) {
    const item = st?.itemId ? data.items.get(st.itemId) : null;
    const table = item ? rollTableFor(data.rolls, key, item) : null;
    const roll = table?.rolls.find((r) => topStats.every((t) => r.options.some((o) => o.key === t)));
    if (!roll) continue;
    const states = topStats.map((t) => apply(state, { label: '', slots: { [key]: { ...st!, rolls: { ...(st!.rolls ?? {}), [roll.key]: { option: t, values: [1] } } } } }));
    const scores = await fightAll(states, confirmN, 55_555);
    const vals = scores.map((x) => (Number.isFinite(x.value) ? x.value : -Infinity));
    const best = topStats[vals.indexOf(Math.max(...vals))] ?? topStats[0];
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
    ...SLOTS.flatMap((sl) => [[`${sl.key} piece`, itemMoves(state.build, sl)], [`${sl.key} cards`, cardMoves(state.build, sl)],
      [`${sl.key} refine`, refineMoves(state.build, sl)]] as [string, Move[]][]),
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
  feed?.stop();
  pool.close();
  return;
}



/**
 * Each state's gain over `bare` (the slot under test left empty) by the
 * estimate: no dice, so "adds nothing" is exactly zero rather than noise,
 * at ~1/60 of a screen. null: the very same fighter as bare, not fought.
 * `axes`: the gain on each of the estimate's axes (per target: DPS, lowest
 * HP, lowest HP as a share, won, not lost). Farm scoring rolls no dice
 * either, so it is used as it is, its score the one axis.
 */
type Gain = { value: number; axes: number[] } | null;
async function gainsOver(bare: State, states: State[]): Promise<Gain[]> {
  const bareKey = await fingerprint(bare);
  const live: number[] = [];
  for (let i = 0; i < states.length; i++) if (await fingerprint(states[i]) !== bareKey) live.push(i);
  const n = farmMode ? screenN : 0;
  const [b, ...s] = await fightAll([bare, ...live.map((i) => states[i])], n, 5);
  const out: Gain[] = states.map(() => null);
  const ax = (x: Score) => x.axes ?? [x.value];
  live.forEach((i, j) => { out[i] = { value: s[j].value - b.value, axes: ax(s[j]).map((v, a) => v - ax(b)[a]) }; });
  return out;
}
/**
 * Does it help on any axis, over `plain` (per axis; none: over empty)? What
 * trades one axis for another -- ATK for Max HP (Absolute Seyren) -- is kept
 * for the fights to judge: on the Tomb knights 2026-09-29 the score's own
 * sum called Absolute Seyren and Ifrit worthless, and they made the build.
 */
/** The DPS axes summed (farm: the score): the other half of a shortlist, so a glass cannon gets fought. */
const dpsGain = (g: Gain) => (!g ? 0 : g.axes.length === 1 ? g.axes[0] : g.axes.filter((_, i) => i % 5 === 0).reduce((a, b) => a + b, 0));
/** The best `k` by the estimate's score, and the best `k` by DPS alone. */
function shortlist<T>(xs: T[], gain: (x: T) => Gain, k: number): T[] {
  const by = (f: (g: Gain) => number) => [...xs].sort((a, b) => f(gain(b)) - f(gain(a))).slice(0, k);
  return [...new Set([...by((g) => g?.value ?? 0), ...by(dpsGain)])];
}
const helps = (g: Gain, plain?: number[]) => !!g && g.axes.some((a, i) => a - (plain?.[i] ?? 0) > 1e-6);
/** The same, fought: a screen on shared seeds, for ranking what the estimate kept. */
async function screenGains(bare: State, states: State[]): Promise<number[]> {
  const [b, ...s] = await fightAll([bare, ...states], screenN, 6);
  return s.map((x) => x.value - b.value);
}
const emptySlot = (): SlotState => ({ itemId: null, refine: 0, cards: [] });
/** Worn now: never pruned, whatever the census says. */
const worn = new Set(Object.values(start.slots).flatMap((s) => [s?.itemId, ...(s?.cards ?? [])]).filter((x): x is number => !!x));

async function census(): Promise<void> {
  const tc = performance.now();
  Object.assign(shown, { phase: 'census', group: 'shadow pieces', pass: 0, groupAt: 0, groups: 0, tried: 0 });
  // -- shadow pieces: each at each tier, all shadow slots emptied.
  const shSlots = SLOTS.filter((s) => s.group === 'shadow' && !locked.has(s.key) && !skipSlot(s, state.build)
    && (searching(s.key) || searching('shadow')));
  const bareBuild = structuredClone(state.build);
  for (const s of shSlots) bareBuild.slots[s.key] = emptySlot();
  const bare: State = { ...state, build: bareBuild };
  const withSlots = (slots: Record<string, SlotState>): State => ({ ...bare, build: { ...bareBuild, slots: { ...bareBuild.slots, ...slots } } });
  const cand: { slot: string; item: Item; refine: number }[] = [];
  for (const s of shSlots) {
    for (const item of data.itemList) {
      if (!fitsSlot(item, s) || !allowed(item, s.key)) continue;
      for (const refine of tiersFor(item, s.key)) cand.push({ slot: s.key, item, refine });
    }
  }
  const g = await gainsOver(bare, cand.map((c) => withSlots({ [c.slot]: { itemId: c.item.id, refine: c.refine, cards: [] } })));
  // Best tier per piece, by the estimate.
  const best = new Map<string, { slot: string; item: Item; tiers: Map<number, Gain> }>();
  cand.forEach((c, i) => {
    const k = `${c.slot}:${c.item.id}`;
    if (!best.has(k)) best.set(k, { slot: c.slot, item: c.item, tiers: new Map() });
    best.get(k)!.tiers.set(c.refine, g[i]);
  });
  // What any piece gives at a refine (its DEF, say): on each axis, the
  // commonest gain in that slot at that tier. A piece lives only if its own
  // bonus beats it somewhere -- on the Tomb build 2026-09-29 most shadow
  // pieces "lived" on refine alone.
  const plain = new Map<string, number[]>();
  {
    const tally = new Map<string, Map<string, number>[]>();
    cand.forEach((c, i) => {
      if (!g[i]) return;
      const k = `${c.slot}+${c.refine}`;
      if (!tally.has(k)) tally.set(k, []);
      g[i]!.axes.forEach((v, a) => {
        const t = (tally.get(k)![a] ??= new Map()); const key = v.toFixed(6);
        t.set(key, (t.get(key) ?? 0) + 1);
      });
    });
    for (const [k, per] of tally) plain.set(k, per.map((t) => Number([...t].sort((a, b) => b[1] - a[1])[0][0])));
  }
  deadShadow = new Set();
  const liveBySlot = new Map<string, { item: Item; est: Gain }[]>();
  for (const p of best.values()) {
    const tiers = [...p.tiers.values()].filter((x): x is NonNullable<Gain> => !!x);
    const top: Gain = tiers.length ? { value: Math.max(...tiers.map((x) => x.value)), axes: [Math.max(...tiers.map((x) => dpsGain(x)))] } : null;
    if (![...p.tiers].some(([r, x]) => helps(x, plain.get(`${p.slot}+${r}`))) && !worn.has(p.item.id)) { deadShadow.add(p.item.id); continue; }
    if (!liveBySlot.has(p.slot)) liveBySlot.set(p.slot, []);
    liveBySlot.get(p.slot)!.push({ item: p.item, est: top });
  }
  // A piece dead in one slot but alive in another (none on this server) stays in.
  for (const l of liveBySlot.values()) for (const x of l) deadShadow.delete(x.item.id);
  // Rank the estimate's best few per slot on real fights, every tier.
  shadowTop = new Map();
  const report: string[] = [];
  for (const [slot, l] of liveBySlot) {
    const short = shortlist(l, (x) => x.est, Math.max(6, shadowK * 3));
    const rows = short.flatMap((x) => tiersFor(x.item, slot).map((r) => ({ item: x.item, refine: r })));
    const sg = await screenGains(bare, rows.map((r) => withSlots({ [slot]: { itemId: r.item.id, refine: r.refine, cards: [] } })));
    const per = new Map<number, { id: number; refine: number; gain: number; tiers: string[] }>();
    rows.forEach((r, i) => {
      const p = per.get(r.item.id) ?? { id: r.item.id, refine: r.refine, gain: -Infinity, tiers: [] };
      p.tiers.push(`+${r.refine} ${sg[i] >= 0 ? '+' : ''}${sg[i].toFixed(3)}`);
      if (sg[i] > p.gain) { p.gain = sg[i]; p.refine = r.refine; }
      per.set(r.item.id, p);
    });
    const ranked = [...per.values()].sort((a, b) => b.gain - a.gain);
    shadowTop.set(slot, ranked);
    report.push(`  ${SLOTS.find((s) => s.key === slot)!.label}: ${l.length} live of ${[...best.values()].filter((p) => p.slot === slot).length}`);
    for (const p of ranked.slice(0, 5)) report.push(`    ${data.items.get(p.id)!.name.padEnd(36)} ${p.tiers.join('  ')}`);
  }
  // -- whole shadow sets, each tier, on the same empty shadow slots.
  const sets: { name: string; refine: number; slots: Record<string, SlotState> }[] = [];
  for (const set of data.sets) {
    const members = set.member_ids.map((id) => data.items.get(id));
    if (members.length !== 4 || members.some((i) => !i || i.kind !== 'Shadow gear')) continue;
    const place = new Map<string, Item>();
    for (const item of members as Item[]) {
      const s = SLOTS.find((x) => SET_SHADOW.includes(x.key) && !place.has(x.key) && fitsSlot(item, x));
      if (!s || !shSlots.some((x) => x.key === s.key) || !allowed(item, s.key)) break;
      place.set(s.key, item);
    }
    if (place.size !== 4) continue;
    for (const r of TIERS) {
      sets.push({ name: set.name, refine: r, slots: Object.fromEntries([...place].map(([k, item]) => [k,
        { itemId: item.id, refine: Math.min(r, Math.max(...tiersFor(item, k))), cards: [] }])) });
    }
  }
  shown.group = 'whole shadow sets';
  const sgEst = await gainsOver(bare, sets.map((s) => withSlots(s.slots)));
  const setShort = shortlist(sets.map((s, i) => ({ s, e: sgEst[i] })), (x) => x.e, 12);
  const setScr = await screenGains(bare, setShort.map((x) => withSlots(x.s.slots)));
  setTop = setShort.map((x, i) => ({ ...x.s, gain: setScr[i] })).sort((a, b) => b.gain - a.gain).slice(0, 8);
  report.push(`  whole sets: ${sets.length / TIERS.length} fit; best:`);
  for (const s of setTop) report.push(`    ${`${s.name} +${s.refine}`.padEnd(36)} ${s.gain >= 0 ? '+' : ''}${s.gain.toFixed(3)}`);

  // -- cards: each alone in a slot emptied of cards, once, in the first slot it fits.
  deadCards = new Set();
  const seen = new Set<number>();
  const cardReport: string[] = [];
  for (const slot of SLOTS) {
    const cur = state.build.slots[slot.key];
    const host = cur?.itemId ? data.items.get(cur.itemId) : null;
    if (slot.group !== 'gear' || !host?.card_slots || skipSlot(slot, state.build) || cardLocked.has(slot.key) || !searching(slot.key)) continue;
    const cs = cards.filter((c) => !seen.has(c.id) && cardFits(c, slot, host));
    cs.forEach((c) => seen.add(c.id));
    if (!cs.length) continue;
    const nulls = Array(host.card_slots).fill(null);
    const bareC = apply(state, { label: '', slots: { [slot.key]: { ...cur!, cards: nulls } } });
    shown.group = `${slot.label} cards`; shown.tried = cs.length;
    const cg = await gainsOver(bareC, cs.map((c) => apply(state, { label: '', slots: { [slot.key]: { ...cur!, cards: [c.id, ...nulls.slice(1)] } } })));
    let dead = 0;
    cs.forEach((c, i) => {
      cardEstimate.set(c.id, cg[i]?.value ?? 0);
      // A card in a set (a card combo) may pay only with its partner: kept.
      if (!helps(cg[i]) && !worn.has(c.id) && !(c.sets ?? []).length) { deadCards!.add(c.id); dead++; }
    });
    cardReport.push(`${slot.key} ${cs.length - dead}/${cs.length}`);
  }
  console.log(`census (${((performance.now() - tc) / 1000).toFixed(0)} s): shadow ${deadShadow.size} pieces dead; cards live per slot ${cardReport.join(', ')} (${deadCards.size} dead)`);
  console.log(report.join('\n'));
  censusOut = {
    shadow: Object.fromEntries([...shadowTop].map(([k, l]) => [k, l.slice(0, 8).map((p) => ({ name: data.items.get(p.id)!.name, refine: p.refine, gain: +p.gain.toFixed(4) }))])),
    sets: setTop.map((s) => ({ name: s.name, refine: s.refine, gain: +s.gain.toFixed(4) })),
    deadShadow: deadShadow.size, deadCards: [...deadCards].map((id) => data.items.get(id)!.name),
  };
}
let censusOut: unknown = null;

if (!flag('no-census')) await census();

/**
 * Pairs: once no single change helps, two can -- a rotation switch that only
 * pays with a piece, a stat spread that only pays with a set. The runners-up
 * of this pass's screens (the top 3 of each group, within 0.05 of the build
 * they were screened on) are paired across groups and screened like any
 * other candidates. --no-pairs skips it.
 */
let runnersUp: { m: Move; gap: number }[] = [];
const touches = (m: Move) => [...Object.keys(m.slots ?? {}), ...(m.stats ? ['stats'] : []), ...Object.keys(m.options ?? {}).map((k) => `opt:${k}`)];
function pairMoves(): Move[] {
  const pool2 = runnersUp.sort((a, b) => b.gap - a.gap).slice(0, 40).map((x) => x.m);
  const out: Move[] = [];
  for (let i = 0; i < pool2.length; i++) {
    for (let j = i + 1; j < pool2.length; j++) {
      const a = pool2[i]; const b = pool2[j];
      const ta = touches(a);
      if (touches(b).some((t) => ta.includes(t))) continue;
      out.push({ label: `${a.label}  +  ${b.label}`, slots: { ...(a.slots ?? {}), ...(b.slots ?? {}) },
        options: { ...(a.options ?? {}), ...(b.options ?? {}) }, stats: a.stats ?? b.stats });
    }
  }
  return out;
}

/** Hill-climb from `state` until nothing (single or paired) helps. */
async function climb(tag = ''): Promise<void> {
for (let pass = 1; pass <= passes; pass++) {
  let improved = false;
  runnersUp = [];
  await probeRollStat();
  const swapOnly = swapBase && swapSlots;
  const groups: { name: string; moves: () => Move[] }[] = swapOnly ? SLOTS.filter((s) => swapSlots.has(s.key)).flatMap((s) => [
    { name: `${s.label} piece`, moves: () => itemMoves(state.build, s) },
    { name: `${s.label} cards`, moves: () => cardMoves(state.build, s) },
    { name: `${s.label} refine`, moves: () => refineMoves(state.build, s) },
  ]) : [
    ...(searching('rotation') ? [{ name: 'rotation', moves: () => optionMoves(state.options) }] : []),
    ...(searching('order') || (only?.has('rotation') ?? false) ? [{ name: 'order', moves: () => orderMoves(state.options) }] : []),
    ...(flag('no-stats') || !searching('stats') || swapBase ? [] : [{ name: 'stats', moves: () => statMoves(state.build) }]),
    ...(searching('sets') ? [{ name: 'sets', moves: () => setMoves(state.build) }] : []),
    ...(shadowTop ? [{ name: 'shadow', moves: () => shadowMoves(state.build) }] : []),
    ...SLOTS.filter((s) => searching(s.key)).flatMap((s) => [
      { name: `${s.label} piece`, moves: () => itemMoves(state.build, s) },
      { name: `${s.label} cards`, moves: () => cardMoves(state.build, s) },
      { name: `${s.label} refine`, moves: () => refineMoves(state.build, s) },
      ...(flag('rolls') || (only?.has('rolls') ?? false) ? [{ name: `${s.label} rolls`, moves: () => rollMoves(state.build, s) }] : []),
    ]),
  ];
  // Pairs go last, and only once the singles are spent.
  const pairGroup = { name: 'pairs', moves: () => pairMoves() };
  for (let gi = 0; gi <= groups.length; gi++) {
    if (gi === groups.length && (improved || flag('no-pairs'))) break;
    const g = gi === groups.length ? pairGroup : groups[gi];
    // Only builds a character can wear: one of each bound card.
    const moves = g.moves().filter((m) => !m.slots || boundOk(apply(state, m).build));
    if (!moves.length) continue;
    seedBase++;
    Object.assign(shown, { phase: tag ? 'per target' : 'climb', tag: tag.replace(/: $/, ''), pass, group: g.name, groupAt: gi + 1, groups: groups.length + 1, tried: moves.length });
    const { base, scored } = await screen(moves, seedBase);
    {
      const top = [...scored].sort((a, b) => b.s.value - a.s.value)[0];
      shown.best = top ? { label: top.m.label, gain: top.s.value - base.value } : null;
    }
    if (g.name !== 'pairs') {
      for (const x of [...scored].sort((a, b) => b.s.value - a.s.value).slice(0, 3)) {
        if (x.s.value > base.value - 0.05) runnersUp.push({ m: x.m, gap: x.s.value - base.value });
      }
    }
    const best = scored.filter((x) => x.s.value > base.value).sort((a, b) => b.s.value - a.s.value).slice(0, 4);
    if (flag('verbose')) {
      const top = [...scored].sort((a, b) => b.s.value - a.s.value)[0];
      console.log(`  ${tag}${g.name}: ${moves.length} tried; best ${top ? `${(top.s.value - base.value >= 0 ? '+' : '')}${(top.s.value - base.value).toFixed(3)} ${top.m.label}` : '-'}`);
    }
    if (!best.length) continue;
    // Fresh seeds, more fights: the current build and the finalists, each
    // finalist's gain tested against its paired noise (acceptZ).
    const confirmSeed = 20_000 + seedBase;
    const fin = best.map((x) => ({ m: x.m, st: apply(state, x.m), gains: [] as number[], ses: [] as number[], s: null as Score | null }));
    let now: Score | null = null;
    let live = fin;
    let pick: { m: Move; s: Score; gain: number; se: number } | null = null;
    for (let round = 0; live.length; round++) {
      const [n0, ...fs] = await fightAll([state, ...live.map((x) => x.st)], confirmN, confirmSeed + 7_919 * round, true);
      now ??= n0;
      live.forEach((x, i) => { x.gains.push(fs[i].value - n0.value); x.ses.push(pairedSe(n0, fs[i])); x.s = fs[i]; });
      const stat = (x: typeof fin[number]) => ({ gain: x.gains.reduce((a, b) => a + b, 0) / x.gains.length,
        se: Math.sqrt(x.ses.reduce((a, b) => a + b * b, 0)) / x.ses.length });
      const passed = live.map((x) => ({ x, ...stat(x) }))
        .filter((r) => r.gain > 0.01 && (acceptZ <= 0 || r.gain > acceptZ * r.se)).sort((a, b) => b.gain - a.gain);
      if (passed.length) { pick = { m: passed[0].x.m, s: passed[0].x.s!, gain: passed[0].gain, se: passed[0].se }; break; }
      // Clears the bar, not yet the noise: fought again, the rest dropped.
      live = live.filter((x) => stat(x).gain > 0.01);
      if (flag('verbose') && live.length) console.log(`  ${tag}${g.name}: ${live.map((x) => `${x.m.label} ${stat(x).gain >= 0 ? '+' : ''}${stat(x).gain.toFixed(3)} ± ${stat(x).se.toFixed(3)}`).join('; ')} -- not yet clear of the noise${round < confirmMore ? ', fought again' : ''}`);
      if (round >= confirmMore) break;
    }
    if (!pick) continue;
    const chosen = pick as { m: Move; s: Score; gain: number; se: number };
    state = apply(state, chosen.m);
    learnSpread(chosen.s);
    steps.push({ move: chosen.m.label, before: lean(now!), after: lean(chosen.s), tried: moves.length });
    shown.score = liveScore(chosen.s);
    improved = true;
    console.log(`${tag}pass ${pass}  ${chosen.m.label.padEnd(64)} ${show(now!)}  ->  ${show(chosen.s)}   [${moves.length} tried; gain ${chosen.gain.toFixed(3)} ± ${chosen.se.toFixed(3)}]`);
  }
  if (!improved) break;
}
}
await climb();

// --per-target: the shared build is the generalist; now each target gets
// the swaps worth their cost, from it.
const perTarget: { cost: number; target: string; shared: Score; own: Score; swaps: string[]; options: Record<string, unknown> }[] = [];
if (flag('per-target') && targets.length > 1) {
  const shared = state;
  // --swap-cost takes a list ("0.05,0.1,0.2") to sweep: one shared search, a per-target phase each.
  const costs = (one('swap-cost') ?? '0.1').split(',').map(Number);
  if (costs.some((c) => !Number.isFinite(c) || c < 0)) throw new Error(`--swap-cost: numbers, comma separated (got "${one('swap-cost')}")`);
  for (const cost of costs) {
  for (let t = 0; t < targets.length; t++) {
    state = { ...shared, only: [t] };
    const [g0] = await fightAll([state], confirmN, 31_000 + t);
    swapBase = shared.build; swapPenalty = cost * 0.3 * (g0.dps / 20_000);
    shown.score = liveScore(g0);
    console.log(`\n-- ${targets[t].name}: shared build ${show(g0)}; a swap must be worth ${(cost * 100).toFixed(0)}% faster kills`);
    await climb(`${targets[t].name}: `);
    const [own] = await fightAll([state], confirmN, 31_000 + t);
    const optDiff = Object.fromEntries(Object.entries(state.options).filter(([k, v]) => shared.options[k] !== v));
    perTarget.push({ cost, target: targets[t].name, shared: g0, own, swaps: swappedSlots(state.build).map((k) => {
      const st = state.build.slots[k]; const it = st?.itemId ? data.items.get(st.itemId)?.name : '-';
      return `${k}: ${it}${st?.refine ? ` +${st.refine}` : ''}${(st?.cards ?? []).filter(Boolean).length ? ` [${st!.cards.filter(Boolean).map((c) => data.items.get(c!)?.name).join(', ')}]` : ''}`;
    }), options: optDiff });
    swapBase = null; swapPenalty = 0;
  }
  }
  state = shared;
  console.log('\nper target (shared build -> with its swaps):');
  for (const r of perTarget) {
    console.log(`  cost ${String(r.cost).padEnd(5)} ${r.target.padEnd(24)} ${show(r.shared)}  ->  ${show(r.own)}   ${r.swaps.length} swap(s)${r.swaps.length ? `: ${r.swaps.join('; ')}` : ''}${Object.keys(r.options).length ? `  rotation ${JSON.stringify(r.options)}` : ''}`);
  }
}

Object.assign(shown, { phase: 'final', tag: '', group: '', best: null });
const [final] = await fightAll([state], confirmN * 2, 99_999);
shown.score = liveScore(final);
shown.result = await encodeBuild(state.build);
feed?.stop();
pool.close();
const link = `http://localhost:5173/#b=${shown.result}`;
console.log(`\nfinal (${confirmN * 2} fights): ${show(final)}; killed by ${final.deaths || 'nothing'}`);
console.log(`options: ${JSON.stringify(state.options)}`);
console.log(link);
console.log(`(${((performance.now() - t0) / 1000).toFixed(0)} s; ${fought} batches fought, ${shared} shared with an identical fighter; ${fightsRun.toLocaleString('en-US')} fights)`);

const out = one('out');
if (out) {
  const path = resolve(process.cwd(), out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    profile: profile.name, targets: targets.map((m) => m.name),
    rules: { screenN, confirmN, timeS, locked: [...locked], penalty: PENALTY, topStats },
    start: profile.build, steps, final: lean(final), options: state.options, link, perTarget, census: censusOut,
  }, null, 1)}\n`);
}
}

if (!isMainThread) {
  parentPort!.on('message', async (job: Job) => {
    try {
      parentPort!.postMessage({ id: job.id, score: job.estimate ? await estimate(job.state) : await fight(job.state, job.n, job.seed, job.per ?? null, !!job.spread) });
    } catch (e) {
      // Say which build broke, rather than dying quietly.
      console.error(`worker failed on a batch (${job.n} fights): ${(e as Error)?.stack ?? e}
${JSON.stringify(job.state).slice(0, 2000)}`);
      process.exit(1);
    }
  });
} else {
  await main();
}
