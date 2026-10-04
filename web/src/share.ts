import { SLOTS, type Build, type Goal, type RollPick, type SlotState } from '@sim';
import { SHARE_WORDS } from './share-words.ts';

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
 *
 * Since 2026-10-04 (the project owner: "the links are already quite long")
 * the build is written in binary instead (tags 'e' and 'f'): numbers as
 * variable-length integers rather than JSON digits -- an item id is three
 * bytes, not six characters -- slots as a bit mask, a piece's refine, card
 * count and roll count in one number, four of a card written once, and roll
 * keys, options and stat keys as their place in SHARE_WORDS. About half the
 * length of 'c' (a full build ~150 characters, a tier build with goals and
 * rolls ~300 against ~700). Deflate is tried on top and kept only when it is
 * shorter -- it helps the roll-heavy builds a little and the rest not at all.
 */

export const SHARE_PARAM = 'b';

/** Binary (packBinary), as is / deflated. What `encodeBuild` writes: the shorter of the two. */
const BINARY = 'e';
const BINARY_DEFLATED = 'f';
/** Positional, deflated. Written until 2026-10-04; still read. */
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
 * The positional format (tags c and d, written until 2026-10-04): the build as nested arrays in a
 * fixed order, field names dropped for position, slot keys for their index, empty tails left off. Only
 * read now; see packBinary for what is written.
 */
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
    target: (row[2] as number) ?? 0,
    ...(row[3] ? { atMost: true } : {}),
    ...(row[4] ? { open: true } : {}),
    // A cap of 0 is a real cap, but not one any goal has: none stops at nothing.
    ...(row[5] ? { cap: row[5] as number } : {}),
  };
}

export async function encodeBuild(build: Build): Promise<string> {
  const bin = packBinary(build);
  const deflated = await squeeze(bin, 'deflate-raw');
  return deflated && deflated.length < bin.length
    ? BINARY_DEFLATED + base64url(deflated)
    : BINARY + base64url(bin);
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
    if (tag === BINARY || tag === BINARY_DEFLATED) {
      const bin = tag === BINARY ? bytes : await expand(bytes, 'deflate-raw');
      return bin ? unpackBinary(bin) : null;
    }
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

// ---- the binary format ---------------------------------------------------
//
// Version 3, in order (u: unsigned varint, s: signed, n: a number, w: a word):
//   u 3 | w class (or none) | u base level | u x6 base stats (STR AGI VIT INT DEX LUK)
//   u mask of the filled slots (bit i = SLOTS[i])
//   per filled slot: u item id | u refine + 32 x cards + 256 x (all cards the same) + 512 x rolls
//                    | u card ids (one when all the same) | per roll: w key | w option (or none)
//                    | u values + 16 x (names a skill) | n values | w skill
//   u goals | per goal: w key | u column + 4 x atMost + 8 x open + 16 x (has a cap) | n target | n cap
//   u mask of the locked slots | u manual figures | per figure: w key | n value
//   u 0 for no guards, 1 + count for a list (empty included) | per guard: as a goal
// A word is u 0 for none, 1 + its letters (u length, UTF-8) when not in SHARE_WORDS, 2 + its index.
// A number is u of 4 x (zigzag of itself) when whole, 4 x (zigzag of it x 100) + 1 when in hundredths
// (a 0.2 s cast roll), and otherwise 2 then its text -- so every number comes back exactly.

const BINARY_VERSION = 3;
const WORD_INDEX = new Map(SHARE_WORDS.map((w, i) => [w, i]));
const STAT_ORDER = ['str', 'agi', 'vit', 'int', 'dex', 'luk'] as const;

class Writer {
  private out: number[] = [];
  u(n: number): void {
    let v = Math.max(0, Math.trunc(n));
    do {
      let byte = v % 128;
      v = Math.floor(v / 128);
      if (v > 0) byte |= 0x80;
      this.out.push(byte);
    } while (v > 0);
  }
  s(n: number): void { this.u(n < 0 ? -2 * n - 1 : 2 * n); }
  text(t: string): void { const b = new TextEncoder().encode(t); this.u(b.length); this.out.push(...b); }
  word(w: string | null | undefined): void {
    if (w === null || w === undefined || w === '') { this.u(0); return; }
    const i = WORD_INDEX.get(w);
    if (i !== undefined) this.u(i + 2);
    else { this.u(1); this.text(w); }
  }
  num(n: number): void {
    const zz = (v: number) => (v < 0 ? -2 * v - 1 : 2 * v);
    if (Number.isInteger(n)) { this.u(zz(n) * 4); return; }
    const h = Math.round(n * 100);
    if (Math.abs(h / 100 - n) < 1e-9) { this.u(zz(h) * 4 + 1); return; }
    this.u(2); this.text(String(n));
  }
  bytes(): Uint8Array { return Uint8Array.from(this.out); }
}

class Reader {
  private at = 0;
  private b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  u(): number {
    let n = 0; let scale = 1;
    for (;;) {
      if (this.at >= this.b.length) throw new Error('short payload');
      const byte = this.b[this.at++];
      n += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return n;
      scale *= 128;
    }
  }
  s(): number { const v = this.u(); return v % 2 ? -(v + 1) / 2 : v / 2; }
  text(): string {
    const len = this.u();
    const t = new TextDecoder().decode(this.b.subarray(this.at, this.at + len));
    this.at += len;
    return t;
  }
  word(): string | null {
    const v = this.u();
    if (v === 0) return null;
    if (v === 1) return this.text();
    const w = SHARE_WORDS[v - 2];
    if (w === undefined) throw new Error('unknown word');
    return w;
  }
  num(): number {
    const v = this.u();
    const tag = v % 4;
    if (tag === 2) return Number(this.text());
    const z = Math.floor(v / 4);
    const n = z % 2 ? -(z + 1) / 2 : z / 2;
    return tag === 1 ? n / 100 : n;
  }
  done(): boolean { return this.at >= this.b.length; }
}

function writeGoal(w: Writer, g: Goal): void {
  w.word(g.key);
  w.u(Math.max(0, COLUMNS.indexOf(g.column)) + (g.atMost ? 4 : 0) + (g.open ? 8 : 0) + (g.cap !== undefined ? 16 : 0));
  w.num(g.target ?? 0);
  if (g.cap !== undefined) w.num(g.cap);
}

function readGoal(r: Reader): Goal {
  const key = r.word() ?? '';
  const f = r.u();
  const target = r.num();
  const cap = f & 16 ? r.num() : undefined;
  return {
    key, column: COLUMNS[f & 3] ?? 'flat', target,
    ...(f & 4 ? { atMost: true } : {}),
    ...(f & 8 ? { open: true } : {}),
    ...(cap !== undefined ? { cap } : {}),
  };
}

function slotMask(keys: Iterable<string>): number {
  let mask = 0;
  for (const k of keys) { const i = SLOT_KEYS.indexOf(k); if (i >= 0) mask += 2 ** i; }
  return mask;
}

function maskKeys(mask: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < SLOT_KEYS.length && mask > 0; i++) {
    if (Math.floor(mask / 2 ** i) % 2) out.push(SLOT_KEYS[i]);
  }
  return out;
}

function packBinary(build: Build): Uint8Array {
  const w = new Writer();
  w.u(BINARY_VERSION);
  w.word(build.className);
  w.u(build.baseLevel);
  for (const k of STAT_ORDER) w.u(build.baseStats[k]);
  const filled = SLOT_KEYS.filter((k) => build.slots[k]?.itemId);
  w.u(slotMask(filled));
  for (const key of filled) {
    const st = build.slots[key]!;
    const cards = st.cards.filter((c): c is number => !!c);
    const rolls = Object.entries(st.rolls ?? {});
    const same = cards.length > 1 && cards.every((c) => c === cards[0]);
    w.u(st.itemId!);
    w.u(st.refine + 32 * cards.length + (same ? 256 : 0) + 512 * rolls.length);
    for (const c of same ? [cards[0]] : cards) w.u(c);
    for (const [rollKey, pick] of rolls) {
      w.word(rollKey);
      w.word(pick.option);
      w.u(pick.values.length + (pick.skill !== undefined ? 16 : 0));
      for (const v of pick.values) w.num(v);
      if (pick.skill !== undefined) w.word(pick.skill);
    }
  }
  const goals = build.goals ?? [];
  w.u(goals.length);
  for (const g of goals) writeGoal(w, g);
  w.u(slotMask(build.locked ?? []));
  const manual = Object.entries(build.manual ?? {});
  w.u(manual.length);
  for (const [k, v] of manual) { w.word(k); w.num(v); }
  if (!build.guards) w.u(0);
  else { w.u(1 + build.guards.length); for (const g of build.guards) writeGoal(w, g); }
  return w.bytes();
}

function unpackBinary(bytes: Uint8Array): Build | null {
  const r = new Reader(bytes);
  if (r.u() !== BINARY_VERSION) return null;
  const className = r.word();
  const baseLevel = r.u();
  const stats = STAT_ORDER.map(() => r.u());
  const slots: Record<string, SlotState> = {};
  for (const key of maskKeys(r.u())) {
    const itemId = r.u();
    const meta = r.u();
    const refine = meta % 32;
    const nCards = Math.floor(meta / 32) % 8;
    const same = Math.floor(meta / 256) % 2 === 1;
    const nRolls = Math.floor(meta / 512);
    const cards: number[] = [];
    if (same) { const c = r.u(); for (let i = 0; i < nCards; i++) cards.push(c); }
    else for (let i = 0; i < nCards; i++) cards.push(r.u());
    const rolls: Record<string, RollPick> = {};
    for (let i = 0; i < nRolls; i++) {
      const rollKey = r.word() ?? '';
      const option = r.word();
      const vm = r.u();
      const values: number[] = [];
      for (let j = 0; j < vm % 16; j++) values.push(r.num());
      const skill = vm & 16 ? r.word() ?? '' : undefined;
      rolls[rollKey] = { option, values, ...(skill !== undefined ? { skill } : {}) };
    }
    slots[key] = { itemId, refine, cards, ...(nRolls ? { rolls } : {}) };
  }
  const goals: Goal[] = [];
  for (let i = r.u(); i > 0; i--) goals.push(readGoal(r));
  const locked = maskKeys(r.u());
  const manual: Record<string, number> = {};
  const nManual = r.u();
  for (let i = 0; i < nManual; i++) { const k = r.word() ?? ''; manual[k] = r.num(); }
  const g = r.u();
  const guards = g ? Array.from({ length: g - 1 }, () => ({ ...readGoal(r), guard: true })) : undefined;
  return {
    className,
    baseLevel,
    baseStats: { str: stats[0], agi: stats[1], vit: stats[2], int: stats[3], dex: stats[4], luk: stats[5] },
    slots,
    goals,
    locked,
    ...(nManual ? { manual } : {}),
    ...(guards ? { guards } : {}),
  };
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
