import { MARKET_ROUTE, type Dataset, type Item } from './types.ts';

/**
 * Where things come from: monster drops, vendors, quests, boxes, and the
 * materials a refine went through.
 *
 * The drops are on the item already. Where each monster lives is not -- it
 * is in data/mobs/spawns.json, loaded only when someone asks, since the
 * planner needs none of it to add up a build.
 */

/** One map a monster spawns on. */
export interface Spawn {
  map: string;
  count: number;
  /** Seconds, [min, max]; max is 0 when the respawn is fixed. */
  respawn: [number, number];
}

export interface MobInfo {
  name: string;
  level: number;
  mvp: boolean;
  spawns: Spawn[];
}

/** data/mobs/spawns.json as written: {id: [name, level, mvp, [[map, n, min, max]]]}. */
export type SpawnFile = Record<string, [string, number, 0 | 1, [string, number, number, number][]]>;

export function readSpawns(file: SpawnFile): Map<number, MobInfo> {
  const out = new Map<number, MobInfo>();
  for (const [id, [name, level, mvp, spawns]] of Object.entries(file)) {
    out.set(Number(id), {
      name, level, mvp: mvp === 1,
      spawns: spawns.map(([map, count, min, max]) => ({ map, count, respawn: [min, max] })),
    });
  }
  return out;
}

/** "5s", "30 min - 1 h": a respawn window as a person would say it. */
export function respawnText([min, max]: [number, number]): string {
  return max && max !== min ? `${duration(min)} - ${duration(max)}` : duration(min);
}

function duration(s: number): string {
  const round = (n: number) => Math.round(n * 10) / 10;
  if (s >= 3600) return `${round(s / 3600)} h`;
  if (s >= 120) return `${round(s / 60)} min`;
  return `${s}s`;
}

/**
 * A vendor, quest or exchange, from the item's `raw.how`.
 *
 * The crawl keeps that field verbatim because its encoding is only partly
 * pinned down. What is read here is the part that is clear from the data:
 * where ("Wish Maiden · Sky Garden Okolnir"), whether it is sold, what it
 * costs in other items ("500 Einherjar Soul"), and a guide's name if the
 * database credits one.
 */
export interface Acquisition {
  where: string;
  sold: boolean;
  costs: { qty: number; name: string; id: number }[];
  /** A condition in the database's words: "has to be refined to exactly +9". */
  note: string | null;
  guide: string | null;
}

export function acquisitionOf(item: Item): Acquisition | null {
  const how = item.raw?.how;
  if (!Array.isArray(how) || typeof how[0] !== 'string' || !how[0]) return null;
  const costs = Array.isArray(how[3])
    ? (how[3] as unknown[]).filter(Array.isArray).map((c) => {
      const [qty, name, id] = c as [number, string, number];
      return { qty, name, id };
    })
    : [];
  return {
    where: how[0],
    sold: how[6] === 'sold',
    costs,
    note: typeof how[4] === 'string' && how[4] ? how[4] : null,
    guide: typeof how[5] === 'string' && how[5] ? how[5] : null,
  };
}

/**
 * The refine ladder on this server, from the materials' own descriptions:
 * ordinary ore to +3, HD to +6, Enriched to +9, Jewel for +10. Weapons take
 * the Oridecon line and everything else the Elunium line.
 */
const LADDER: { upTo: number; weapon: number; armor: number }[] = [
  { upTo: 3, weapon: 984, armor: 985 }, // Oridecon, Elunium
  { upTo: 6, weapon: 6240, armor: 6241 }, // HD
  { upTo: 9, weapon: 6292, armor: 6291 }, // Enriched
  { upTo: 10, weapon: 6906, armor: 6290 }, // Jewel
];

/**
 * Runes take Bradium, which reaches +9, and Jewel Bradium, which reaches +10
 * and stops a failed refine from downgrading. Players switch to Jewel
 * Bradium past +3, so that is where the ladder switches -- it is what the
 * refine actually costs, not the furthest plain Bradium could go.
 */
const RUNE_LADDER: { upTo: number; itemId: number; note?: string }[] = [
  { upTo: 3, itemId: 6224 },
  { upTo: 10, itemId: 6226, note: 'prevents downgrading; the usual choice past +3' },
];

// TODO: once the refine success tables are known, show the median and
// average materials to reach each refine, not just which material it is.

export interface RefineStep {
  itemId: number;
  /** The refines this material covers, e.g. [4, 6] for +4 to +6. */
  range: [number, number];
  /** True for the tier past the piece's current refine: what it needs next. */
  next: boolean;
  note?: string;
}

/**
 * The materials a piece at this refine went through, plus the tier after.
 *
 * Other shadow gear refines some way the data does not say, so it gets
 * nothing rather than a guess. Runes, which share that slot group, are known.
 */
export function refineMaterials(item: Item, refine: number, maxRefine: number, shadow: boolean):
  RefineStep[] {
  if (!item.refineable || maxRefine === 0) return [];
  const rune = item.type === 'Rune';
  if (shadow && !rune) return [];
  const ladder: { upTo: number; itemId: number; note?: string }[] = rune
    ? RUNE_LADDER
    : LADDER.map((t) => ({ upTo: t.upTo, itemId: item.kind === 'Weapon' ? t.weapon : t.armor }));
  const out: RefineStep[] = [];
  let from = 1;
  for (const tier of ladder) {
    if (from > maxRefine) break;
    const to = Math.min(tier.upTo, maxRefine);
    const next = from > refine;
    out.push({ itemId: tier.itemId, range: [from, to], next,
      ...(tier.note ? { note: tier.note } : {}) });
    if (next) break;
    from = tier.upTo + 1;
  }
  return out;
}

/**
 * What to actually go and farm for an item: the part of its cheapest route
 * that takes the longest, followed down to a monster.
 *
 * A sun helmet is not farmed; its Star Pieces are. So an exchange is
 * followed into whichever ingredient costs the most in total (quantity
 * times effort), and on down until something drops. Null when the route
 * ends at a vendor or is not known.
 */
export interface FarmTarget {
  itemId: number;
  /** How many of it the original item needs, all the way down. */
  qty: number;
  /** The monster it drops best from, by effort. */
  mobId: number;
  mob: string;
  zone: string;
  chance: number;
}

export function farmFor(itemId: number, data: Dataset, qty = 1, depth = 0): FarmTarget | null {
  const e = data.effort?.get(itemId);
  const item = data.items.get(itemId);
  if (!e || !item || depth > 6) return null;
  // Bought, not farmed: see `boughtFromPlayers`.
  if (e.via === MARKET_ROUTE) return null;
  if (e.via > 0) {
    const drop = item.drops?.find((d) => d.mob_id === e.via);
    return drop ? {
      itemId, qty, mobId: drop.mob_id, mob: drop.mob, zone: drop.zone, chance: drop.chance_percent,
    } : null;
  }
  if (e.via < 0) {
    const costs = acquisitionOf(item)?.costs ?? [];
    let heaviest: { id: number; qty: number; weight: number } | null = null;
    for (const c of costs) {
      const weight = c.qty * (data.effort?.get(c.id)?.effort ?? 0);
      if (!heaviest || weight > heaviest.weight) heaviest = { id: c.id, qty: c.qty, weight };
    }
    return heaviest ? farmFor(heaviest.id, data, qty * heaviest.qty, depth + 1) : null;
  }
  return null;
}

/**
 * Is the cheapest way to this item buying it from another player? From the
 * project owner: a Weaver is a solid goal even for a class that cannot farm
 * Rachel SS itself. The items are listed by hand in crawler/acquisition.json.
 */
export function boughtFromPlayers(itemId: number, data: Dataset): boolean {
  return data.effort?.get(itemId)?.via === MARKET_ROUTE;
}
