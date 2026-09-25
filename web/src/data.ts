import {
  bindBaseStatIds, readSpawns,
  type ClassGoals, type ClassRules, type Dataset, type Item, type MobInfo, type RollData,
  type SetRecord, type SpawnFile, type StatDef,
} from '@sim';

/**
 * Load the generated dataset.
 *
 * Gzipped this is well under a megabyte in total, so it is fetched once and
 * held in memory rather than paged in per screen. That keeps filtering and
 * the stat totals synchronous, which is what makes the UI feel immediate.
 */
export async function loadDataset(base = './data'): Promise<Dataset> {
  const [itemList, sets, stats, classes, classRules, rolls, armorTargets, effort, classGoals,
    levelReach] =
    await Promise.all([
      getJSON<Item[]>(`${base}/items/all.json`),
      getJSON<SetRecord[]>(`${base}/sets/all.json`),
      getJSON<StatDef[]>(`${base}/stats.json`),
      getJSON<string[]>(`${base}/classes.json`).catch(() => [] as string[]),
      // Hand-maintained corrections to what a class can hold. Missing it means
      // the job sentence on each item is the only restriction, which is how
      // the planner behaved before the file existed.
      getJSON<ClassRules>(`${base}/class-rules.json`).catch(() => null),
      // Hand-written, and built separately from the crawl. Missing it costs
      // the roll editor, not the planner, so it must not fail the load.
      getJSON<RollData>(`${base}/rolls.json`).catch(() => null),
      // A few hundred bytes; missing it only costs the penetration hover its
      // damage figures.
      getJSON<Dataset['armorTargets']>(`${base}/mobs/armor-targets.json`).catch(() => null),
      // How hard each item is to get. Missing it means suggestions are not
      // held to what the character could plausibly farm next.
      getJSON<Record<string, [number, number, number]>>(`${base}/items/effort.json`)
        .catch(() => null),
      // Hand-written starting goals per class. Missing it costs the "goals for
      // my class" button, nothing else.
      getJSON<{ presets: ClassGoals }>(`${base}/class-goals.json`)
        .then((f) => f.presets).catch(() => null),
      // What each level typically farms. Missing it means a build with no
      // hard-to-get gear is not held to anything.
      getJSON<Record<string, [number, number]>>(`${base}/mobs/level-reach.json`)
        .catch(() => null),
    ]);

  bindBaseStatIds(stats);

  return {
    items: new Map(itemList.map((i) => [i.id, i])),
    itemList,
    sets,
    stats,
    statById: new Map(stats.map((s) => [s.id, s])),
    classes,
    classRules,
    rolls,
    armorTargets,
    effort: effort
      ? new Map(Object.entries(effort)
        .map(([id, [e, kill, via]]) => [Number(id), { effort: e, kill, via }]))
      : null,
    classGoals,
    levelReach: levelReach
      ? new Map(Object.entries(levelReach)
        .map(([level, [e, kill]]) => [Number(level), { effort: e, kill }]))
      : null,
  };
}

let spawns: Promise<Map<number, MobInfo>> | null = null;

/**
 * Where every monster lives. Fetched the first time someone asks where
 * something drops, and kept: nothing else in the planner needs it.
 */
export function loadSpawns(base = './data'): Promise<Map<number, MobInfo>> {
  spawns ??= getJSON<SpawnFile>(`${base}/mobs/spawns.json`).then(readSpawns)
    .catch((e) => { spawns = null; throw e; });
  return spawns;
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Icons are optional; a lot of items legitimately have none. */
export function iconUrl(item: { images: { icon: string | null; art: string | null } }) {
  const path = item.images.icon ?? item.images.art;
  return path ? `./${path}` : null;
}
