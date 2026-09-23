import { SLOTS, type Build, type Goal, type RollPick, type SlotState } from '@sim';

/**
 * A build in a link.
 *
 * The whole build travels in the URL fragment, so a share is a link and
 * nothing more: no account, no server, nothing stored anywhere. A fragment
 * rather than a query string because a fragment is never sent to the host
 * the page is served from -- what someone is planning is their business.
 *
 * The payload is the build written out positionally, deflated and
 * base64url-encoded, behind a one-character tag naming the format. A build
 * with every slot filled comes out around a sixth of its JSON.
 *
 * Deflate alone was not enough. It crushes the repeated field names, but
 * what is left is mostly digits -- five and six figure item ids -- and
 * those do not compress. So the shape goes first: field names dropped for
 * position, slot keys for their index, empty tails left off entirely. That
 * is worth about 40%, and deflate still runs afterwards for the roll keys,
 * which are the one thing left that repeats.
 *
 * The tag is what makes this safe to change. Every format this has ever
 * written still decodes, so a link someone saved or posted a year ago
 * keeps working; only the writing side moves.
 */

export const SHARE_PARAM = 'b';

/** Positional, deflated. What `encodeBuild` writes. */
const COMPACT = 'c';
/** Positional, uncompressed, for a browser with no CompressionStream. */
const COMPACT_PLAIN = 'd';
/** The first format: the whole build as JSON. Read, never written. */
const DEFLATED = 'z';
const PLAIN = 'u';

/** Slot keys as positions. See the order test in web/test/share.test.ts. */
const SLOT_KEYS = SLOTS.map((s) => s.key);
const COLUMNS: Goal['column'][] = ['flat', 'percent', 'total'];

/**
 * The build as nested arrays, in a fixed order.
 *
 * Every field is known from its position, so none of the names travel. A
 * trailing entry that would be empty is dropped rather than written as
 * `[]` or `null`, which is why the rows are ragged: most slots carry no
 * cards and no rolls, and most builds set no manual figures.
 *
 * `guards` is the one field where an empty list and a missing one mean
 * different things -- absent is "use the defaults", empty is "I took them
 * off" -- so it is written as null when absent and `[]` when emptied.
 */
function pack(build: Build): unknown[] {
  const slots: unknown[][] = [];
  for (const [key, state] of Object.entries(build.slots)) {
    const at = SLOT_KEYS.indexOf(key);
    if (at < 0 || !state?.itemId) continue;
    const cards = state.cards.filter((c): c is number => !!c);
    const rolls = Object.entries(state.rolls ?? {}).map(([rollKey, pick]) =>
      // A skill only comes back when the roll names one, so it is a fourth
      // entry rather than a null every other roll has to carry.
      pick.skill !== undefined
        ? [rollKey, pick.option ?? 0, pick.values, pick.skill]
        : [rollKey, pick.option ?? 0, pick.values]);
    slots.push(trimTail([at, state.itemId, state.refine, cards, rolls]));
  }

  const b = build.baseStats;
  const row = trimTail([
    2,
    build.className ?? 0,
    build.baseLevel,
    [b.str, b.agi, b.vit, b.int, b.dex, b.luk],
    slots,
    (build.goals ?? []).map(packGoal),
    (build.locked ?? []).map((k) => SLOT_KEYS.indexOf(k)).filter((i) => i >= 0),
    build.manual ?? 0,
  ]);

  // Guards go on after the trimming, never through it. An empty list here
  // is a real answer -- "I took them all off" -- and trimming it away would
  // hand the reader back the defaults, which is the opposite instruction.
  if (build.guards) {
    while (row.length < 8) row.push(0);
    row.push(build.guards.map(packGoal));
  }
  return row;
}

function packGoal(goal: Goal): unknown[] {
  return trimTail([goal.key, COLUMNS.indexOf(goal.column), goal.target,
    goal.atMost ? 1 : 0]);
}

/** Drop trailing entries that carry nothing, since position restores them. */
function trimTail(row: unknown[]): unknown[] {
  const out = [...row];
  while (out.length > 0 && isEmpty(out[out.length - 1])) out.pop();
  return out;
}

function isEmpty(v: unknown): boolean {
  return v === 0 || v === undefined || (Array.isArray(v) && v.length === 0);
}

function unpack(row: unknown[]): Build {
  const at = <T>(i: number, fallback: T): T | unknown => (row[i] ?? fallback);
  const stats = (at(3, []) as number[]);
  const slots: Record<string, SlotState> = {};
  for (const entry of (at(4, []) as unknown[][])) {
    const key = SLOT_KEYS[entry[0] as number];
    if (!key) continue;
    const rolls: Record<string, RollPick> = {};
    for (const r of (entry[4] ?? []) as unknown[][]) {
      rolls[r[0] as string] = {
        option: (r[1] as string) || null,
        values: (r[2] ?? []) as number[],
        ...(r[3] !== undefined ? { skill: r[3] as string } : {}),
      };
    }
    slots[key] = {
      itemId: entry[1] as number,
      refine: (entry[2] as number) ?? 0,
      cards: ((entry[3] ?? []) as number[]),
      ...(Object.keys(rolls).length > 0 ? { rolls } : {}),
    };
  }

  const guards = row[8];
  return {
    className: (row[1] as string) || null,
    baseLevel: row[2] as number,
    baseStats: {
      str: stats[0] ?? 0, agi: stats[1] ?? 0, vit: stats[2] ?? 0,
      int: stats[3] ?? 0, dex: stats[4] ?? 0, luk: stats[5] ?? 0,
    },
    slots,
    goals: (at(5, []) as unknown[][]).map(unpackGoal),
    locked: (at(6, []) as number[]).map((i) => SLOT_KEYS[i]).filter(Boolean),
    ...(row[7] ? { manual: row[7] as Record<string, number> } : {}),
    // Absent means "not said", which is what restores the defaults; only a
    // real array means the player chose, empty included. The flag itself
    // does not travel -- it is implied by the field, and writing it would
    // be a word on every guard for nothing.
    ...(Array.isArray(guards)
      ? { guards: guards.map((g) => ({ ...unpackGoal(g as unknown[]), guard: true })) }
      : {}),
  };
}

function unpackGoal(row: unknown[]): Goal {
  return {
    key: row[0] as string,
    column: COLUMNS[(row[1] as number) ?? 0] ?? 'flat',
    target: row[2] as number,
    ...(row[3] ? { atMost: true } : {}),
  };
}

export async function encodeBuild(build: Build): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(pack(build)));
  const deflated = await squeeze(json, 'deflate-raw');
  return deflated
    ? COMPACT + base64url(deflated)
    : COMPACT_PLAIN + base64url(json);
}

/**
 * The build in a shared payload, or null if it is not one.
 *
 * Returns the parsed object rather than a `Build`: it came from outside the
 * app and has not been checked against the dataset yet, which is
 * `reconcile`'s job.
 */
export async function decodeBuild(payload: string): Promise<Build | null> {
  try {
    const tag = payload[0];
    const bytes = unbase64url(payload.slice(1));
    const compressed = tag === COMPACT || tag === DEFLATED;
    const json = compressed ? await expand(bytes, 'deflate-raw') : bytes;
    if (!json || ![COMPACT, COMPACT_PLAIN, DEFLATED, PLAIN].includes(tag)) return null;

    const parsed = JSON.parse(new TextDecoder().decode(json));
    if (tag === COMPACT || tag === COMPACT_PLAIN) {
      // Positional: an array, led by its schema number.
      return Array.isArray(parsed) && parsed[0] === 2 ? unpack(parsed) : null;
    }
    // The first format, still read so old links keep working: a build is an
    // object with slots. Everything past that shape is reconcile's
    // business, not this function's.
    return parsed && typeof parsed === 'object' && parsed.slots ? parsed as Build : null;
  } catch {
    // A truncated, hand-edited or simply unrelated fragment. Not an error
    // worth showing: there is nothing the reader could do about it.
    return null;
  }
}

/** The share link for a build, against the page it is shared from. */
export async function shareUrl(build: Build): Promise<string> {
  const base = location.href.split('#')[0];
  return `${base}#${SHARE_PARAM}=${await encodeBuild(build)}`;
}

/** The payload in a URL's fragment, if it carries one. */
export function payloadIn(href: string): string | null {
  const hash = href.split('#')[1];
  if (!hash) return null;
  const match = new URLSearchParams(hash).get(SHARE_PARAM);
  return match || null;
}

// ---- bytes ---------------------------------------------------------------

async function squeeze(bytes: Uint8Array, format: string): Promise<Uint8Array | null> {
  // Absent in older Safari, and a link that is merely long still works.
  if (typeof CompressionStream === 'undefined') return null;
  return drain(new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream(format as CompressionFormat)));
}

async function expand(bytes: Uint8Array, format: string): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  return drain(new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream(format as CompressionFormat)));
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * base64, in the alphabet a URL can carry unescaped.
 *
 * `+` and `/` would be percent-encoded by anything that touches the link,
 * and the `=` padding is not needed to decode a string whose length is
 * known -- so all three go.
 */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  // In chunks: spreading a whole build into String.fromCharCode at once can
  // overflow the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
