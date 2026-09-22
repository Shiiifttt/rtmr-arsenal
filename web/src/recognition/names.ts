/**
 * Turning the name the client shows into an item, a refine level and cards.
 *
 * The displayed name is not the item's name. Refining prepends "+7", every
 * compounded card adds a word, and the window then wraps the result mid-word
 * and cuts it off with an ellipsis if it still does not fit. So
 *
 *     +6 Piercing Elu / sive Venus...
 *
 * is a +6 Venus Cape with a Skeleton Worker card and a Maiden card in it.
 *
 * None of that has to be undone exactly. The icon has already narrowed the
 * field to a handful of items, so this only has to say which of those the
 * text looks most like -- and then read the words left over as affixes.
 */

import type { Item } from '@sim';

export interface NameReading {
  refine: number;
  /** The item the text matches best, or null if nothing matched well enough. */
  itemId: number | null;
  /** How wrong the best match was, per character. Lower is better. */
  error: number;
  /** True when a second candidate was almost as good. */
  ambiguous: boolean;
  cards: number[];
  /** Affix text that did not resolve to exactly one card. */
  unresolved: string[];
}

/**
 * Fold away the differences the font cannot express.
 *
 * Capital I and lowercase l are the same bitmap in this font, so the table
 * only holds one of them and every I comes back as an l. Spacing is dropped
 * too: the window breaks names mid-word, so where the spaces fall in the
 * text says nothing about where they fall in the name.
 */
export function fold(text: string): string {
  return text
    .replace(/I/g, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9?]/g, '');
}

/** Strip the refine prefix the client adds, and note an ellipsis. */
export function split(text: string): { refine: number; rest: string; cut: boolean } {
  const flat = text.replace(/\s+/g, '');
  const refine = /^\+(\d+)/.exec(flat);
  return {
    refine: refine ? Number(refine[1]) : 0,
    rest: refine ? flat.slice(refine[0].length) : flat,
    cut: /\.\.\.?$/.test(flat),
  };
}

interface Alignment {
  cost: number;
  /** Where in the text the name started and ended. */
  from: number;
  to: number;
}

/**
 * Line a name up against the text, ignoring anything before or after it.
 *
 * What sits before the name is the card prefixes and what sits after is the
 * suffixes, so both ends are free. A '?' in the text is a character the font
 * table did not have and matches anything.
 */
function align(name: string, text: string): Alignment {
  const m = name.length;
  const n = text.length;
  // cost[j] and start[j] for the current row of the matrix.
  let cost = new Int32Array(n + 1);
  let start = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) start[j] = j;

  for (let i = 1; i <= m; i++) {
    const next = new Int32Array(n + 1);
    const nextStart = new Int32Array(n + 1);
    next[0] = i;
    nextStart[0] = 0;
    for (let j = 1; j <= n; j++) {
      const same = text[j - 1] === '?' || text[j - 1] === name[i - 1];
      let best = cost[j - 1] + (same ? 0 : 1);
      let from = start[j - 1];
      if (cost[j] + 1 < best) { best = cost[j] + 1; from = start[j]; }
      if (next[j - 1] + 1 < best) { best = next[j - 1] + 1; from = nextStart[j - 1]; }
      next[j] = best;
      nextStart[j] = from;
    }
    cost = next;
    start = nextStart;
  }

  let to = 0;
  for (let j = 1; j <= n; j++) if (cost[j] < cost[to]) to = j;
  return { cost: cost[to], from: start[to], to };
}

/** Anything worse than this is not the same name. */
const MAX_ERROR = 0.34;
/** Two candidates this close cannot be told apart by their names. */
const TIE = 0.06;

/**
 * Read a slot's text, given the items its icon could be.
 *
 * `cards` is every card in the dataset, which is what the leftover words are
 * looked up in.
 */
export function readName(
  text: string, candidates: Item[], cards: Item[],
): NameReading {
  const { refine, rest, cut } = split(text);
  const folded = fold(rest);

  let best: { item: Item; error: number; at: Alignment } | null = null;
  let runnerUp = Infinity;

  for (const item of candidates) {
    const full = fold(item.name);
    // A cut-off name can only be present as far as the text goes, so the
    // pattern is trimmed to that before it is scored -- otherwise every
    // truncated name looks equally wrong.
    const name = cut ? full.slice(0, Math.max(4, folded.length)) : full;
    if (!name) continue;

    const at = align(name, folded);
    const error = at.cost / name.length;
    if (!best || error < best.error) {
      if (best) runnerUp = best.error;
      best = { item, error, at };
    } else if (error < runnerUp) {
      runnerUp = error;
    }
  }

  if (!best || best.error > MAX_ERROR) {
    return {
      refine, itemId: null, error: best?.error ?? 1, ambiguous: candidates.length > 1,
      cards: [], unresolved: folded ? [folded] : [],
    };
  }

  const affixes = readAffixes(
    folded.slice(0, best.at.from), folded.slice(best.at.to), best.item, cards,
  );
  return {
    refine,
    itemId: best.item.id,
    error: best.error,
    ambiguous: runnerUp - best.error < TIE,
    cards: affixes.cards,
    unresolved: affixes.unresolved,
  };
}

/**
 * Read the words around the name back into cards.
 *
 * Several cards can share an affix word, and a word only means a card at all
 * if that card fits the item it is on -- so a word that resolves to anything
 * other than exactly one usable card is reported rather than guessed at.
 */
function readAffixes(
  before: string, after: string, item: Item, cards: Item[],
): { cards: number[]; unresolved: string[] } {
  const found: number[] = [];
  const unresolved: string[] = [];

  for (const [text, position] of [[before, 'prefix'], [after, 'suffix']] as const) {
    let rest = text;
    while (rest) {
      const word = longestAffix(rest, position, cards);
      if (!word) {
        unresolved.push(rest);
        break;
      }
      const usable = word.cards.filter((card) => fitsSameSlot(card, item));
      if (usable.length === 1) found.push(usable[0].id);
      else unresolved.push(word.word);
      rest = rest.slice(word.used);
    }
  }
  return { cards: found, unresolved };
}

interface AffixHit {
  word: string;
  /** Characters of the text the word accounted for. */
  used: number;
  cards: Item[];
}

function longestAffix(rest: string, position: 'prefix' | 'suffix',
                      cards: Item[]): AffixHit | null {
  let best: AffixHit | null = null;
  for (const card of cards) {
    const affix = card.card_affix;
    if (!affix || affix.position !== position) continue;
    const word = fold(affix.word);
    if (!word) continue;
    const hit = consume(rest, word);
    if (!hit) continue;
    // A '?' stands for at least one unread character, so a word made mostly
    // of them was not really read at all -- a lone '?' would otherwise match
    // any three-letter affix in the game.
    if (hit.literals < Math.ceil(word.length * 0.6)) continue;

    if (!best || word.length > best.word.length) {
      best = { word, used: hit.used, cards: [card] };
    } else if (word.length === best.word.length) {
      best.cards.push(card);
    }
  }
  return best;
}

/**
 * Fit `word` against the start of `text`, or null if it does not.
 *
 * A '?' is a character the font table did not have, and consecutive unknowns
 * collapse into one -- so a '?' may stand for more than one letter and the
 * two strings cannot be compared position by position. `literals` counts the
 * characters that actually matched, which is how the caller tells a real
 * reading from a wildcard absorbing the whole word.
 */
function consume(text: string, word: string): { used: number; literals: number } | null {
  const seen = new Set<number>();

  const walk = (i: number, j: number): { used: number; literals: number } | null => {
    if (j === word.length) return { used: i, literals: 0 };
    if (i >= text.length) return null;
    const key = i * (word.length + 1) + j;
    if (seen.has(key)) return null;
    seen.add(key);

    if (text[i] === '?') {
      for (let take = 1; take <= 3 && j + take <= word.length; take++) {
        const rest = walk(i + 1, j + take);
        if (rest) return rest;
      }
      return null;
    }
    if (text[i] !== word[j]) return null;
    const rest = walk(i + 1, j + 1);
    return rest && { used: rest.used, literals: rest.literals + 1 };
  };

  return walk(0, 0);
}

function fitsSameSlot(card: Item, item: Item): boolean {
  return card.equip_slots.some((slot) => item.equip_slots.includes(slot)
    // Cards for shields say "Shield" where the shield itself says "Off-hand".
    || (slot === 'Shield' && item.equip_slots.includes('Off-hand')));
}
