/**
 * Farming a map: walk, pull, fight, sit, over and over -- how many kills an
 * hour a build gets and how much of that hour is spent sitting for SP.
 *
 *   node --experimental-strip-types --no-warnings --import ./register.mjs tools/farm.ts \
 *     --profile baselines/satsujin-rachel/owner.json --map gl_knt02 --mode fok \
 *     [--base "changes for every row"] [--variant "name: changes"] [--minutes 20] [--seeds 4] [--pack 4] \
 *     [--sit-below 0.2] [--sit-to 0.95] [--hp-sit 0.5] [--rest sit|lotus] [--solo] [--respawn 5000] [--death-ms 30000] \
 *     [--jobs N] [--json out.json] [--trace]
 *
 * The map (the project owner, 2026-09-28): a flat grid with no obstacles --
 * a torus as big as the map's walkable cells (server db/re/map_cache.dat) --
 * with the map's regulars (live spawn counts, data/raw/db-places.json; MVPs
 * and lone Boss-class spawns left out) scattered uniformly, respawning
 * --respawn ms after they die at a random cell. Monsters stand until they
 * notice you: an aggressive one (server Ai mode 0x4) within its view range
 * (SkillRange) chases at its WalkSpeed until it is in attack range, and
 * gives up past ChaseRange. You walk at your walk speed (formulas
 * walkCellMs). Ranges are square (the server's), steps straight-line.
 *
 * Each fight is the real fight engine: the nearest monster is the target,
 * every other monster chasing you is in it too, attacking from when it
 * walks up (an add), and your HP, SP, cooldowns, buffs and Focus carry from
 * one fight to the next. The target dead, the adds still up are the next
 * fight. Fights are paced (option pace): out of SP you keep swinging.
 *
 * Modes:
 *   combo  walk to the nearest monster and fight it with the profile's rotation.
 *   fok    Fan of Knives on packs (option fanOfKnives): walk toward the next
 *          monster until --pack are chasing you, then stop and let them come;
 *          Fan of Knives waits until they are in its 9x9 area (option fanPack).
 *          You also stop walking whenever the slowest chaser falls behind.
 *
 * Between fights you sit when SP is under --sit-below of Max SP (or HP under
 * --hp-sit) and nothing is chasing you, and stand at --sit-to. Regen (RTM
 * conf/battle/player.conf, status.cpp): natural SP every 1.2 s, HP every
 * 2 s, both twice as fast sitting, HP half as fast walking; skill regen
 * (Increase SP Recovery) every 4 s when not walking. None while a fight's
 * Hiding lasts (the engine).
 *
 * --solo: one monster at a time -- only the one you walk to notices you (you
 * lure it away from the rest), the pace of a player who will not chain
 * pulls (the project owner, 2026-09-28, the Tomb knights).
 *
 * --safe-rest: with --solo, nothing new notices you while you need a rest
 * (SP under --sit-below or HP under --hp-sit) or are resting -- you sit
 * somewhere safe first, fight-sit-fight (the project owner, 2026-09-29).
 * Without it an aggressive monster may walk into you half empty.
 *
 *   afk    walk around and let them hit you, casting nothing (option noCast): the kills are the reflects'
 *          and the autocasts' (the project owner's Kingslayer on juperos_03, 2026-10-04). You walk toward the
 *          next monster at a pace the slowest chaser keeps up with until --pack are on you, then on to
 *          a random spot (you never stop -- the owner: "you keep walking at a pace for the monsters to keep
 *          up"; standing still, six Dimiks that never land a hit held a run for good, 2026-10-04);
 *          a fight is run in --slice ms pieces (default 3000) so you keep walking and new monsters join.
 *          No sitting. Scored in zeny and relics an hour too: a kill pays level..2*level-1 zeny
 *          (mob.cpp ~2726) and 1..(the gear's zeny limit) (bAddGetZenyNum, data/server-loot.json), and
 *          drops a relic at --relic-rate per 10000 (Rate 10 = 0.1%, the "<Name>MVP" relics) scaled by the
 *          drop-rate gear. --skip "Gioia": monsters left off the map (the owner kills Gioia by hand).
 *
 * --rest lotus: rest with Lotus Pact instead of sitting whenever it is off
 * cooldown and affordable -- its cast (3 s variable, gear cast cuts), then
 * 10 s kneeling at 1% HP and SP per level a second (tooltip) with standing
 * regen on top; sitting fills the gaps between casts. A monster walking up
 * ends the rest (the fight starts; Lotus Pact's "chance not to take damage"
 * is not modelled).
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import { buildFighter, resolveBuild, type Profile } from '../src/character.ts';
import { findMobs, plannerDataset, readJSON, REPO } from '../src/data.ts';
import { newFight, newMobState, run, shiftMobState, type Actor, type Buff, type MobState } from '../src/engine.ts';
import { spawnCounts } from '../src/farm.ts';
import { leaveFirstCore, workCores } from '../src/cpu.ts';
import { TUNE, walkCellMs } from '../src/formulas.ts';
import { DEFAULT_CONSUMABLES, loadout } from '../src/items.ts';
import type { Fighter, Monster } from '../src/model.ts';
import type { Build } from '../../sim/src/types.ts';
import { buildMonster } from '../src/monster.ts';
import { Rng } from '../src/rng.ts';
import { priorityPolicy } from '../src/tas.ts';
import { applyVariant } from '../src/variant-spec.ts';
import { kitFor } from '../src/kits/index.ts';

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const many = (k: string) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));
const num = (k: string, d: number) => Number(one(k) ?? d);

/** Fan of Knives' area at level 5+: SplashArea 4, a 9x9 square (skill_db). */
const FOK_RADIUS = 4;
const TICK_MS = 100;
const FIGHT_LIMIT_MS = 180_000;

// ---- the map -----------------------------------------------------------------

/** Walkable cells of a map, from the server's map cache (gat types 0 and 3 are walkable). */
function walkableCells(map: string): number {
  const b = readFileSync(resolve(REPO, 'returntomorroc/db/re/map_cache.dat'));
  const n = b.readUInt16LE(4);
  let o = 8;
  for (let i = 0; i < n; i++) {
    const name = b.toString('latin1', o, o + 12).replace(/\0.*$/s, '');
    const len = b.readInt32LE(o + 16);
    if (name === map) {
      let w = 0;
      for (const v of inflateSync(b.subarray(o + 20, o + 20 + len))) if (v === 0 || v === 3) w++;
      return w;
    }
    o += 20 + len;
  }
  throw new Error(`map ${map} is not in the server's map cache`);
}

interface ServerMob { walkSpeed: number; skillRange: number; chaseRange: number; aiMode: number; attackRange: number }
let serverMobs: Record<string, ServerMob> | null = null;
const serverMob = (id?: number): ServerMob | undefined => {
  serverMobs ??= (readJSON<{ mobs: Record<string, ServerMob> }>(resolve(REPO, 'combat/data/server-mobs.json'))).mobs;
  return id === undefined ? undefined : serverMobs[String(id)];
};

interface Kind {
  m: Monster; count: number;
  walkMs: number; view: number; chase: number; aggressive: boolean; canMove: boolean; reach: number;
}

function kindsOn(map: string): Kind[] {
  const out: Kind[] = [];
  for (const [name, count] of spawnCounts(map)) {
    const rows = findMobs(name);
    const row = rows.find((r) => r.maps.includes(map)) ?? rows[0];
    if (!row || row.mvp) continue;
    const m = buildMonster(row);
    // MVPs out; a Boss-class monster too when it spawns alone (a mini-boss on a
    // long timer: Bloody Knight), kept when it is a regular (Umbral Knight x5).
    if (m.boss || (m.bossClass && count <= 1)) continue;
    const s = serverMob(m.serverId);
    out.push({
      m, count,
      walkMs: s?.walkSpeed ?? 150,
      view: s?.skillRange ?? 10,
      chase: Math.max(s?.chaseRange ?? 12, s?.skillRange ?? 10),
      aggressive: !!s && (s.aiMode & 0x4) !== 0,
      canMove: !s || (s.aiMode & 0x1) !== 0,
      reach: Math.max(1, m.reach),
    });
  }
  return out;
}

// ---- one run -------------------------------------------------------------------

/** `st` (afk): its fight state between slices -- swing timer, skill delays -- in farm time. */
interface Mob { kind: Kind; x: number; y: number; hp: number; aggro: boolean; deadUntil: number; st?: MobState }

interface RunResult {
  map: string; seed: number; minutes: number;
  kills: number; byMonster: Record<string, number>;
  ms: { fight: number; walk: number; sit: number; wait: number; dead: number };
  deaths: number; deathsBy: Record<string, number>;
  spUsed: number; fokCasts: number; fokHits: number; stalemates: number;
  /** Expected zeny and relics from the kills (afk scoring; every mode fills them). */
  zeny: number; relics: number; zenyLimit: number;
  /** Damage you dealt by action (reflects, autocasts) and took by source, and potions drunk, over the run. */
  dealt: Record<string, number>; taken: Record<string, number>; drunk: Record<string, number>; hits: number; avoided: number;
}

type Mode = 'combo' | 'fok' | 'afk';

interface ServerLoot { id: number; name: string; zeny?: number[]; drop?: { race: string; byRefine: number[] }[] }
/** What the build's gear adds to a kill's loot: the zeny limit, and drop rate by race (RC_All for all). */
function lootOf(build: Build): { zenyLimit: number; drop: Record<string, number> } {
  const rows = new Map(readJSON<{ items: ServerLoot[] }>(resolve(REPO, 'combat/data/server-loot.json')).items.map((x) => [x.id, x]));
  const data = plannerDataset();
  let zenyLimit = 0; const drop: Record<string, number> = {};
  let pirate = 0; let pirateRefine = 0;
  for (const st of Object.values(build.slots)) {
    if (!st?.itemId) continue;
    const r = Math.min(15, st.refine ?? 0);
    if (/^Pirate King (Armor|Gloves|Shoes|Pendant)$/.test(data.items.get(st.itemId)?.name ?? '')) { pirate++; pirateRefine += st.refine ?? 0; }
    for (const id of [st.itemId, ...(st.cards ?? [])]) {
      const row = id ? rows.get(id) : undefined;
      if (!row) continue;
      zenyLimit += row.zeny?.[r] ?? 0;
      for (const d of row.drop ?? []) drop[d.race] = (drop[d.race] ?? 0) + d.byRefine[r];
    }
  }
  // Pirate King's four pieces: a further 10 + their refines (db/re/item_combo_db.txt:260, not on the tooltip).
  if (pirate >= 4) zenyLimit += 10 + pirateRefine;
  return { zenyLimit, drop };
}

async function farmRun(profile: Profile, map: string, mode: Mode, seed: number, trace: boolean): Promise<RunResult> {
  const build = await resolveBuild(profile.build, plannerDataset());
  const kit = kitFor(build.className);
  const f: Fighter = await buildFighter(profile, { passives: kit.passives, aliases: kit.aliases, maxLevels: kit.maxLevels() });
  const rng = new Rng(seed * 7919 + 17);
  const side = Math.sqrt(walkableCells(map));
  const skip = new Set((one('skip') ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  const kinds = kindsOn(map).filter((k) => !skip.has(k.m.name.toLowerCase()));
  const loot = lootOf(build);
  const relicBase = num('relic-rate', 10);
  const wrap = (d: number) => { const a = Math.abs(d) % side; return Math.min(a, side - a); };
  const sd = (d: number) => { let v = d % side; if (v > side / 2) v -= side; if (v < -side / 2) v += side; return v; };
  const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(wrap(a.x - b.x), wrap(a.y - b.y));
  const place = (m: Mob) => { m.x = rng.next() * side; m.y = rng.next() * side; };
  const mobs: Mob[] = kinds.flatMap((k) => Array.from({ length: k.count }, () => {
    const m: Mob = { kind: k, x: 0, y: 0, hp: k.m.hp, aggro: false, deadUntil: -1 };
    place(m);
    return m;
  }));

  const pack = num('pack', 4);
  const order = Array.isArray(profile.options?.order) ? profile.options!.order as string[] : undefined;
  const options: Record<string, unknown> = {
    ...(profile.options ?? {}), pace: true,
    ...(mode === 'afk' ? { noCast: true, earlyStall: false } : {}),
    ...(mode === 'fok' ? {
      fanOfKnives: true, fanPack: pack,
      // Fan of Knives the only damage skill; the dodges and buffs stay.
      order: [...(order ?? ['Stay hidden', 'Predict Kawarimi', 'Hallucination Walk'])
        .filter((id) => ['Stay hidden', 'Predict Kawarimi', 'Moon guard', 'Pull it off the ward', 'Hallucination Walk', 'Lotus Pact'].includes(id)),
      'Fan of Knives', 'Attack', 'Wait for swing'],
    } : {}),
  };
  const items = loadout({ carried: profile.consumables ?? DEFAULT_CONSUMABLES, healing: !!profile.healing, boss: false, elixirs: f.kafraElixirs });
  const cellMs = walkCellMs(f);

  // You, in farm time (absolute ms).
  const me = {
    x: side / 2, y: side / 2, hp: f.maxHp, sp: f.maxSp,
    cds: {} as Record<string, number>, buffs: {} as Record<string, Buff>, focus: [] as number[], fresh: true,
    // afk: your ticking regens (Knight's Regen) carry between slices, in farm time.
    dots: [] as ReturnType<typeof newFight>['me']['dots'],
  };
  const acc = { hp: 0, sp: 0, skill: 0 };
  // The class's out-of-combat regen (Knight's Regen, King's Fortress), per second.
  const idle = kit.kit.idleRegen?.(f, options) ?? null;
  const r: RunResult = {
    map, seed, minutes: num('minutes', 20), kills: 0, byMonster: {},
    ms: { fight: 0, walk: 0, sit: 0, wait: 0, dead: 0 }, deaths: 0, deathsBy: {}, spUsed: 0, fokCasts: 0, fokHits: 0, stalemates: 0,
    zeny: 0, relics: 0, zenyLimit: loot.zenyLimit, dealt: {}, taken: {}, drunk: {}, hits: 0, avoided: 0,
  };
  const endAt = r.minutes * 60_000;
  let t = 0; let sitting = false;
  // Lotus Pact as a rest (--rest lotus): its numbers from the kit, read on a throwaway fight.
  const lotusKit = kit.kit.actions.find((a) => a.id === 'Lotus Pact');
  const probe = newFight(f, kinds[0].m, kit.kit, priorityPolicy, { seed: 1, limitMs: 1000, options });
  const lotus = one('rest') === 'lotus' && lotusKit && (f.skillLevels['Lotus Pact'] ?? 0) > 0
    ? { castMs: lotusKit.castMs(probe), sp: lotusKit.spCost(probe), cdMs: lotusKit.cooldownMs(probe), perSec: (f.skillLevels['Lotus Pact'] ?? 0) / 100 }
    : null;
  let kneelUntil = -1;
  // afk: where you are walking when the pack is full.
  let wander = { x: rng.next() * side, y: rng.next() * side };
  (r as RunResult & { lotusCasts?: number }).lotusCasts = 0;
  const say = (s: string) => { if (trace) console.log(`[${(t / 1000).toFixed(1).padStart(7)}s] HP ${Math.round(me.hp)} SP ${Math.round(me.sp)} | ${s}`); };

  const regen = (dt: number, how: 'walk' | 'stand' | 'sit') => {
    const multi = how === 'sit' ? 2 : 1;
    acc.hp += dt * multi * (how === 'walk' ? 0.5 : 1);
    acc.sp += dt * multi;
    if (how !== 'walk') acc.skill += dt;
    while (acc.hp >= TUNE.hpRegenMs) { acc.hp -= TUNE.hpRegenMs; me.hp = Math.min(f.maxHp, me.hp + f.regen.hp); }
    while (acc.sp >= TUNE.spRegenMs) { acc.sp -= TUNE.spRegenMs; me.sp = Math.min(f.maxSp, me.sp + f.regen.sp); }
    while (acc.skill >= TUNE.skillRegenMs) { acc.skill -= TUNE.skillRegenMs; me.sp = Math.min(f.maxSp, me.sp + (f.regen.spSkill ?? 0)); }
    // The class's own regen kept up out of combat (Knight's Regen, King's Fortress).
    if (idle) {
      me.hp = Math.min(f.maxHp, me.hp + idle.hpPerSec * dt / 1000);
      me.sp = Math.max(0, Math.min(f.maxSp, me.sp + idle.spPerSec * dt / 1000));
    }
  };
  const alive = (m: Mob) => m.deadUntil <= t;
  const kill = (m: Mob) => {
    r.kills++; r.byMonster[m.kind.m.name] = (r.byMonster[m.kind.m.name] ?? 0) + 1;
    // Expected loot: level..2*level-1 base zeny, 1..limit from the gear, a relic at the boosted rate.
    const lvl = m.kind.m.level;
    r.zeny += lvl + (lvl - 1) / 2 + (loot.zenyLimit > 0 ? (loot.zenyLimit + 1) / 2 : 0);
    const bonus = (loot.drop.RC_All ?? 0) + (loot.drop[`RC_${m.kind.m.race.replace(/[^A-Za-z]/g, '')}`] ?? 0);
    r.relics += Math.min(9000, Math.floor(0.5 + relicBase * (100 + bonus) / 100)) / 10000;
    m.deadUntil = t + num('respawn', 5000); m.aggro = false; m.hp = m.kind.m.hp; m.st = undefined;
  };
  const step = (from: { x: number; y: number }, to: { x: number; y: number }, cells: number) => {
    const dx = sd(to.x - from.x); const dy = sd(to.y - from.y); const d = Math.hypot(dx, dy);
    if (d <= cells) { from.x = to.x; from.y = to.y; return; }
    from.x = (from.x + (dx / d) * cells + side) % side; from.y = (from.y + (dy / d) * cells + side) % side;
  };

  while (t < endAt) {
    for (const m of mobs) if (m.deadUntil > 0 && m.deadUntil <= t) { m.deadUntil = -1; place(m); }
    // Noticed, or lost.
    const solo = argv.includes('--solo');
    const soloGoal = solo ? mobs.filter((m) => alive(m) && m.aggro)[0]
      ?? mobs.filter(alive).reduce<Mob | null>((b, m) => (!b || cheb(m, me) < cheb(b, me) ? m : b), null) : null;
    const resting = argv.includes('--safe-rest') && (sitting || kneelUntil > t
      || me.sp < num('sit-below', 0.2) * f.maxSp || me.hp < num('hp-sit', 0.5) * f.maxHp);
    for (const m of mobs) {
      if (!alive(m) || (solo && m !== soloGoal && !m.aggro) || (resting && !m.aggro)) continue;
      const d = cheb(m, me);
      // A monster that cannot move (Photon Cannon) shoots whoever walks into its reach, and stops when they leave it.
      if (!m.kind.canMove) { m.aggro = m.kind.aggressive && d <= m.kind.reach; continue; }
      if (!m.aggro && m.kind.aggressive && m.kind.canMove && d <= m.kind.view) m.aggro = true;
      else if (m.aggro && d > m.kind.chase) m.aggro = false;
    }
    const chasing = mobs.filter((m) => alive(m) && m.aggro);
    const nearest = (list: Mob[]) => list.reduce<Mob | null>((b, m) => (!b || cheb(m, me) < cheb(b, me) ? m : b), null);
    const close = mode === 'fok' ? FOK_RADIUS : 1.5;
    const onMe = chasing.filter((m) => cheb(m, me) <= Math.max(m.kind.reach, 1.5) + 0.01);
    const goal = mode === 'fok' && chasing.length < pack ? nearest(mobs.filter((m) => alive(m) && !m.aggro)) : nearest(mobs.filter(alive));
    const reached = goal && cheb(goal, me) <= close + 0.01 ? goal : null;

    // ---- a fight -----------------------------------------------------------------
    if (onMe.length || (mode !== 'afk' && reached) || (mode === 'fok' && chasing.length >= pack && chasing.every((m) => cheb(m, me) <= Math.max(m.kind.reach, FOK_RADIUS) + 0.01))) {
      sitting = false;
      const target = nearest(onMe.length ? onMe : reached ? [reached] : chasing)!;
      target.aggro = true;
      const others = mobs.filter((m) => alive(m) && m.aggro && m !== target);
      const fight = newFight(f, target.kind.m, kit.kit, priorityPolicy, {
        seed: Math.floor(rng.next() * 2 ** 32), limitMs: mode === 'afk' ? num('slice', 3000) : FIGHT_LIMIT_MS, options, items, log: trace,
      });
      if (!me.fresh) {
        fight.me.hp = me.hp; fight.me.sp = me.sp;
        fight.me.cds = Object.fromEntries(Object.entries(me.cds).map(([k, v]) => [k, v - t]));
        // Timed buffs carry; the pre-pull ones (Seven Winds for this monster's element, the stance) are this fight's own.
        const prepped = Object.entries(fight.me.buffs).filter(([, b]) => b.until >= 1e11);
        fight.me.buffs = Object.fromEntries([
          ...Object.entries(me.buffs).filter(([, b]) => b.until < 1e11).map(([k, b]) => [k, { ...b, until: b.until - t }]),
          ...prepped,
        ]);
        fight.me.focus = me.focus.map((v) => v - t);
        // afk: a regen already ticking keeps its own clock (a 3 s slice would never reach a 5 s tick).
        if (mode === 'afk' && me.dots.length) {
          const carried = me.dots.filter((d) => d.until > t).map((d) => ({ ...d, nextAt: d.nextAt - t, until: d.until - t }));
          fight.me.dots = [...fight.me.dots.filter((d) => !carried.some((c) => c.name === d.name)), ...carried];
        }
      }
      // afk: the target picks up where the last slice left it (swing timer, skill delays).
      if (mode === 'afk' && target.st) fight.mob = { ...shiftMobState(target.st, -t), adds: [] };
      fight.mob.hp = target.hp;
      if (trace && process.env.FARM_DBG) say(`start vs ${target.kind.m.name}: buffs ${JSON.stringify(Object.fromEntries(Object.entries(fight.me.buffs).filter(([, v]) => v.until > 0 && v.until < 1e11).map(([k, v]) => [k, Math.round(v.until)])))} cds ${JSON.stringify(Object.fromEntries(Object.entries(fight.me.cds).filter(([, v]) => v > 0).map(([k, v]) => [k, Math.round(v)])))} adds ${others.length} [${others.map((m) => `${m.kind.m.name}@${cheb(m, me).toFixed(1)}${m.kind.canMove ? '' : '(fixed)'}`).join(', ')}]`);
      for (const m of others) {
        const d = cheb(m, me);
        const st = mode === 'afk' && m.st ? shiftMobState(m.st, -t) : newMobState(m.kind.m);
        st.hp = m.hp;
        if (!(mode === 'afk' && m.st)) st.nextAttackAt = Math.max(0, d - m.kind.reach) * m.kind.walkMs;
        const reachAt = d <= FOK_RADIUS ? 0 : m.kind.reach <= FOK_RADIUS ? (d - FOK_RADIUS) * m.kind.walkMs : Infinity;
        const a: Actor & { farm?: Mob } = { m: m.kind.m, st, add: true, reachAt, farm: m };
        fight.mob.adds.push(a);
      }
      const spBefore = fight.me.sp;
      run(fight);
      if (trace && fight.log) for (const line of fight.log.slice(fight.result === 'loss' ? -40 : -3)) console.log(`      ${line}`);
      const dur = Math.max(1, fight.t);
      r.spUsed += Math.max(0, spBefore - fight.me.sp);
      for (const [k, v] of Object.entries(fight.meter?.actions ?? {})) {
        if (v.damage) r.dealt[k] = (r.dealt[k] ?? 0) + v.damage;
        if (items.some((x) => x.id === k)) r.drunk[k] = (r.drunk[k] ?? 0) + v.uses;
      }
      for (const [k, v] of Object.entries(fight.meter?.taken ?? {})) { if (v.damage) r.taken[k] = (r.taken[k] ?? 0) + v.damage; r.hits += v.hits; r.avoided += v.avoided; }
      const fok = fight.meter?.actions['Fan of Knives'];
      if (fok) { r.fokCasts += fok.uses; r.fokHits += fok.hits; }
      t += dur; r.ms.fight += dur;
      // What carries out.
      me.fresh = false; me.hp = fight.me.hp; me.sp = fight.me.sp;
      me.cds = Object.fromEntries(Object.entries(fight.me.cds).map(([k, v]) => [k, v + t - dur]));
      me.buffs = Object.fromEntries(Object.entries(fight.me.buffs).map(([k, b]) => [k, { ...b, until: b.until >= 1e11 ? b.until : b.until + t - dur }]));
      me.focus = fight.me.focus.map((v) => v + t - dur);
      if (mode === 'afk') {
        me.dots = fight.me.dots.map((d) => ({ ...d, nextAt: d.nextAt + t - dur, until: d.until + t - dur }));
        // Each monster's fight state, in farm time, for the next slice.
        target.st = shiftMobState(fight.mob, t - dur);
        for (const a of fight.mob.adds as (Actor & { farm?: Mob })[]) if (a.farm) a.farm.st = shiftMobState(a.st, t - dur);
      }
      for (const a of fight.killed ?? []) kill((a as Actor & { farm: Mob }).farm);
      // afk: you walked on through the slice, at a pace the chasers keep up with.
      if (mode === 'afk' && fight.result !== 'loss') {
        const chasers = mobs.filter((m) => alive(m) && m.aggro && m.kind.canMove);
        if (cheb(wander, me) < 2) wander = { x: rng.next() * side, y: rng.next() * side };
        const to = (chasers.length < pack ? nearest(mobs.filter((m) => alive(m) && !m.aggro && m.kind.aggressive)) : null) ?? wander;
        {
          const pace = Math.max(cellMs, ...chasers.map((m) => m.kind.walkMs));
          step(me, to, dur / pace);
          for (const m of chasers) { const d = cheb(m, me); if (d > m.kind.reach) step(m, me, d - m.kind.reach); }
        }
      }
      for (const a of fight.mob.adds as (Actor & { farm?: Mob })[]) {
        if (!a.farm) continue;
        a.farm.hp = a.st.hp;
        // It walked up to you.
        const d = cheb(a.farm, me);
        if (d > a.farm.kind.reach) step(a.farm, me, Math.min(d - a.farm.kind.reach, dur / a.farm.kind.walkMs));
      }
      if (fight.result === 'win') { kill(target); say(`killed ${target.kind.m.name} in ${(dur / 1000).toFixed(1)}s (${(fight.killed?.length ?? 0) + 1} down)`); }
      else if (fight.result === 'loss') {
        r.deaths++; r.deathsBy[fight.cause ?? '?'] = (r.deathsBy[fight.cause ?? '?'] ?? 0) + 1;
        say(`died to ${fight.cause}`);
        target.hp = fight.mob.hp;
        for (const m of mobs) m.aggro = false;
        const back = num('death-ms', 30_000);
        t += back; r.ms.dead += back;
        me.hp = f.maxHp; me.sp = f.maxSp; me.cds = {}; me.focus = []; me.fresh = true; me.buffs = {}; me.dots = [];
        for (const m of mobs) m.st = undefined;
        me.x = rng.next() * side; me.y = rng.next() * side;
      } else if (mode === 'afk' && fight.cause === 'time limit') {
        // A slice, not a stalemate: the fight goes on with whoever is on you next.
        target.hp = fight.mob.hp;
      } else {
        r.stalemates++; target.hp = fight.mob.hp;
        say(`fight with ${target.kind.m.name} ran out the clock`);
      }
      continue;
    }

    // ---- between fights ---------------------------------------------------------
    const needSit = me.sp < num('sit-below', 0.2) * f.maxSp || me.hp < num('hp-sit', 0.5) * f.maxHp;
    const rested = me.sp >= num('sit-to', 0.95) * f.maxSp && me.hp >= 0.95 * f.maxHp;
    if (mode !== 'afk' && !chasing.length && (needSit || ((sitting || kneelUntil > t) && !rested))) {
      if (lotus && kneelUntil <= t && (me.cds['Lotus Pact'] ?? -1) <= t && me.sp >= lotus.sp) {
        // Cast, then kneel. Standing regen through both; the cast is idle time too.
        me.sp -= lotus.sp; r.spUsed += lotus.sp;
        (r as RunResult & { lotusCasts: number }).lotusCasts++;
        say('casts Lotus Pact');
        me.cds['Lotus Pact'] = t + lotus.castMs + lotus.cdMs;
        kneelUntil = t + lotus.castMs + 10_000;
        (me as typeof me & { kneelFrom?: number }).kneelFrom = t + lotus.castMs;
      }
      if (kneelUntil > t) {
        sitting = false;
        regen(TICK_MS, 'stand');
        if (t >= ((me as typeof me & { kneelFrom?: number }).kneelFrom ?? 0)) {
          me.hp = Math.min(f.maxHp, me.hp + lotus!.perSec * f.maxHp * TICK_MS / 1000);
          me.sp = Math.min(f.maxSp, me.sp + lotus!.perSec * f.maxSp * TICK_MS / 1000);
        }
        t += TICK_MS; r.ms.sit += TICK_MS;
        continue;
      }
      if (!sitting) say('sits');
      sitting = true;
      regen(TICK_MS, 'sit'); t += TICK_MS; r.ms.sit += TICK_MS;
      continue;
    }
    kneelUntil = -1;
    if (sitting) say('stands');
    sitting = false;
    // Chasers move up.
    for (const m of chasing) {
      const d = cheb(m, me);
      if (d > m.kind.reach) step(m, me, Math.min(d - m.kind.reach, TICK_MS / m.kind.walkMs));
    }
    // Stand and let them come: a full pack, or a chaser falling out of range.
    const lagging = mode === 'fok' && chasing.some((m) => cheb(m, me) > m.kind.chase - 3);
    if (mode === 'afk') {
      if (cheb(wander, me) < 2) wander = { x: rng.next() * side, y: rng.next() * side };
      const pull = (chasing.length < pack ? nearest(mobs.filter((m) => alive(m) && !m.aggro && m.kind.aggressive)) : null) ?? wander;
      step(me, pull, TICK_MS / Math.max(cellMs, ...chasing.filter((m) => m.kind.canMove).map((m) => m.kind.walkMs)));
      regen(TICK_MS, 'walk'); t += TICK_MS; r.ms.walk += TICK_MS;
      continue;
    }
    if (!goal || (mode === 'fok' && chasing.length >= pack) || lagging) {
      regen(TICK_MS, 'stand'); t += TICK_MS; r.ms.wait += TICK_MS;
      continue;
    }
    step(me, goal, TICK_MS / cellMs);
    regen(TICK_MS, 'walk'); t += TICK_MS; r.ms.walk += TICK_MS;
  }
  return r;
}

// ---- driver --------------------------------------------------------------------

interface Job { variant: string; spec: string; map: string; seed: number }

if (one('child')) {
  const job = JSON.parse(one('child')!) as Job;
  const data = plannerDataset();
  const profile = readJSON<Profile>(resolve(process.cwd(), one('profile')!));
  const base = await resolveBuild(profile.build, data);
  const v = job.spec ? applyVariant(profile, base, data, job.spec).profile : profile;
  const res = await farmRun(v, job.map, (one('mode') ?? 'combo') as Mode, job.seed, argv.includes('--trace'));
  process.stdout.write(`${JSON.stringify({ ...job, ...res })}\n`);
} else {
  leaveFirstCore();
  const maps = (one('map') ?? 'gl_knt02').split(',').map((s) => s.trim());
  const seeds = num('seeds', 4);
  // --base "changes" applies to every row, "as is" included; each --variant adds its own on top.
  const shared = one('base') ?? '';
  const withBase = (name: string, changes: string) => (shared ? `${name}: ${shared}; ${changes}` : changes ? `${name}: ${changes}` : '');
  const variants = [{ name: 'as is', spec: withBase('as is', '') }, ...many('variant').map((s) => {
    const name = s.includes(':') ? s.slice(0, s.indexOf(':')).trim() : s;
    return { name, spec: withBase(name, s.includes(':') ? s.slice(s.indexOf(':') + 1) : '') };
  })];
  const jobs: Job[] = variants.flatMap((v) => maps.flatMap((map) => Array.from({ length: seeds }, (_, i) => ({ variant: v.name, spec: v.spec, map, seed: i + 1 }))));
  const pass = argv.filter((a, i) => !['--variant', '--seeds', '--jobs', '--json', '--map'].includes(a) && !['--variant', '--seeds', '--jobs', '--json', '--map'].includes(argv[i - 1] ?? ''));
  const out: (Job & RunResult)[] = [];
  let next = 0;
  const width = Math.max(1, Number(one('jobs') ?? workCores()));
  const runJob = (job: Job) => new Promise<void>((done) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './register.mjs',
      'tools/farm.ts', ...pass, '--child', JSON.stringify(job)], { cwd: process.cwd() });
    let so = ''; let se = '';
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    child.on('close', (code) => {
      if (code !== 0) console.error(`${job.variant} / ${job.map} / ${job.seed} failed:\n${se}`);
      else { const line = so.trim().split('\n').pop()!; if (argv.includes('--trace')) console.log(so); out.push(JSON.parse(line)); }
      done();
    });
  });
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => { while (next < jobs.length) await runJob(jobs[next++]); }));

  const rows: Record<string, unknown>[] = [];
  console.log(`\n${one('mode') ?? 'combo'} farming, ${num('minutes', 20)} min x ${seeds} seeds, pack ${num('pack', 4)}, sit below ${num('sit-below', 0.2) * 100}% SP`);
  console.log(`${'variant'.padEnd(22)}${'map'.padEnd(12)}${'kills/h'.padStart(8)}${'fight'.padStart(7)}${'walk'.padStart(6)}${'wait'.padStart(6)}${'sit'.padStart(6)}${'dead'.padStart(6)}${'sit s/kill'.padStart(11)}${'SP/kill'.padStart(8)}${'deaths/h'.padStart(9)}${'FoK hits/cast'.padStart(14)}${'zeny/h'.padStart(10)}${'relics/h'.padStart(9)}${'limit'.padStart(6)}`);
  for (const v of variants) for (const map of maps) {
    const rs = out.filter((x) => x.variant === v.name && x.map === map);
    if (!rs.length) continue;
    const S = (f: (x: RunResult) => number) => rs.reduce((s, x) => s + f(x), 0);
    const total = S((x) => x.minutes * 60_000);
    const kills = S((x) => x.kills);
    const share = (k: keyof RunResult['ms']) => S((x) => x.ms[k]) / total;
    const row = {
      variant: v.name, map, killsPerHour: kills / (total / 3_600_000),
      fight: share('fight'), walk: share('walk'), wait: share('wait'), sit: share('sit'), dead: share('dead'),
      sitPerKill: kills ? S((x) => x.ms.sit) / 1000 / kills : null, spPerKill: kills ? S((x) => x.spUsed) / kills : null,
      zenyPerHour: S((x) => x.zeny) / (total / 3_600_000), relicsPerHour: S((x) => x.relics) / (total / 3_600_000), zenyLimit: rs[0].zenyLimit,
      deathsPerHour: S((x) => x.deaths) / (total / 3_600_000), fokPerCast: S((x) => x.fokCasts) ? S((x) => x.fokHits) / S((x) => x.fokCasts) : null,
      deathsBy: rs.reduce<Record<string, number>>((a, x) => { for (const [k, n] of Object.entries(x.deathsBy)) a[k] = (a[k] ?? 0) + n; return a; }, {}),
      byMonster: rs.reduce<Record<string, number>>((a, x) => { for (const [k, n] of Object.entries(x.byMonster)) a[k] = (a[k] ?? 0) + n; return a; }, {}),
    };
    rows.push(row);
    const p = (x: number) => `${Math.round(x * 100)}%`;
    console.log(`${v.name.slice(0, 21).padEnd(22)}${map.padEnd(12)}${Math.round(row.killsPerHour).toString().padStart(8)}${p(row.fight).padStart(7)}${p(row.walk).padStart(6)}${p(row.wait).padStart(6)}${p(row.sit).padStart(6)}${p(row.dead).padStart(6)}`
      + `${(row.sitPerKill?.toFixed(1) ?? '-').padStart(11)}${Math.round(row.spPerKill ?? 0).toString().padStart(8)}${row.deathsPerHour.toFixed(1).padStart(9)}${(row.fokPerCast?.toFixed(1) ?? '-').padStart(14)}${Math.round(row.zenyPerHour).toLocaleString('en-US').padStart(10)}${row.relicsPerHour.toFixed(2).padStart(9)}${String(row.zenyLimit).padStart(6)}`);
    const d = Object.entries(row.deathsBy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} x${n}`).join(', ');
    if (d) console.log(`${''.padEnd(34)}died to ${d}`);
    // Where the damage came from and went (afk: what is doing the killing, and what hurts).
    const sum = (key: 'dealt' | 'taken' | 'drunk') => rs.reduce<Record<string, number>>((a, x) => { for (const [k, n] of Object.entries(x[key] ?? {})) a[k] = (a[k] ?? 0) + n; return a; }, {});
    const top = (o: Record<string, number>, n: number, per = true) => {
      const all = Object.values(o).reduce((a, b) => a + b, 0) || 1;
      return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
        .map(([k, v]) => (per ? `${k} ${Math.round((100 * v) / all)}%` : `${k} ${Math.round(v / (total / 3_600_000))}/h`)).join(', ');
    };
    const dealt = sum('dealt'); const taken = sum('taken'); const drunk = sum('drunk');
    if (Object.keys(dealt).length) console.log(`${''.padEnd(34)}damage from: ${top(dealt, 6)}`);
    if (Object.keys(taken).length) console.log(`${''.padEnd(34)}hurt by: ${top(taken, 6)}; hits taken ${Math.round(S((x) => x.hits ?? 0) / (total / 3_600_000))}/h, avoided ${Math.round(S((x) => x.avoided ?? 0) / (total / 3_600_000))}/h`);
    if (Object.keys(drunk).length) console.log(`${''.padEnd(34)}drinks: ${top(drunk, 4, false)}`);
    Object.assign(row, { dealt, taken, drunk });
  }
  const json = one('json');
  if (json) writeFileSync(resolve(process.cwd(), json), `${JSON.stringify({ args: argv, rows, runs: out }, null, 1)}\n`);
}
