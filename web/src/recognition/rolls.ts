/**
 * Turning a line of roll text into one of the table's options.
 *
 * The planner's roll tables are hand-written, and their labels are the
 * planner's wording rather than the client's -- "Move Speed" against the
 * client's "Movement Speed", "Variable cast time reduced" against "Variable
 * Cast Time". So an option carries a `reads` list of wordings that have
 * actually been seen in a screenshot, and anything not on that list is
 * matched approximately against the label instead.
 *
 * The numbers are the reliable part: digits read exactly, so the magnitudes
 * are never in doubt even where the words are.
 */

import { clampRoll, defaultValues, optionOf, type RollPick, type RollTable }
  from '@sim';
import { loadAssets } from './assets.ts';
import { fold } from './names.ts';
import { readTooltip } from './tooltip.ts';

export interface RollMatch {
  /** The line as read, wildcards and all. */
  text: string;
  rollKey: string | null;
  optionKey: string | null;
  /** The matched option's label, for showing what it was taken as. */
  label: string | null;
  values: number[];
  /** Labels of the options that fit equally well, when none stood out. */
  ambiguous: string[];
}

/** Anything worse than this is not the same wording. */
const MAX_ERROR = 0.45;
/** The best match has to beat the next one by this much to be taken. */
const MARGIN = 0.15;

/**
 * Read the magnitudes out of a line, in the order they appear.
 *
 * The sign is dropped. A roll worded as a reduction is stored against the
 * stat it reduces with `sign: -1` on the grant, so the table applies the
 * direction and what belongs here is the size the client printed.
 */
export function magnitudes(text: string): number[] {
  return [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
}

/** The words of a line, with the numbers and their decoration taken out. */
function wording(text: string): string {
  return fold(text.replace(/[+-]?\d+(?:\.\d+)?%?/g, ' '));
}

/**
 * How far this wording is from that one, as a fraction of its length.
 *
 * Measured both against the whole label and against as much of the label as
 * the reading is long, because the client tends to drop a trailing qualifier
 * -- it writes "Variable Cast Time" where the table says "Variable cast time
 * reduced".
 */
function error(read: string, label: string): number {
  if (!read || !label) return 1;
  const whole = distance(read, label) / Math.max(read.length, label.length);
  if (read.length >= label.length) return whole;
  return Math.min(whole, distance(read, label.slice(0, read.length)) / read.length);
}

/** Levenshtein distance, where '?' in the reading matches anything. */
function distance(a: string, b: string): number {
  let prev = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const next = new Int32Array(b.length + 1);
    next[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const same = a[i - 1] === '?' || a[i - 1] === b[j - 1];
      next[j] = Math.min(
        prev[j - 1] + (same ? 0 : 1),
        prev[j] + 1,
        next[j - 1] + 1,
      );
    }
    prev = next;
  }
  return prev[b.length];
}

/** Match one line against everything the table can roll. */
export function matchRoll(text: string, table: RollTable): RollMatch {
  const read = wording(text);
  const values = magnitudes(text);

  const scored: { rollKey: string; optionKey: string; label: string; error: number }[] = [];
  for (const roll of table.rolls) {
    for (const option of roll.options) {
      // A wording seen in a screenshot is taken at its word; the label is
      // only ever an approximation of what the client prints.
      const best = Math.min(
        ...(option.reads ?? []).map((r) => error(read, fold(r))),
        error(read, fold(option.label)),
      );
      scored.push({
        rollKey: roll.key, optionKey: option.key, label: option.label, error: best,
      });
    }
  }
  scored.sort((a, b) => a.error - b.error);

  const best = scored[0];
  if (!best || best.error > MAX_ERROR) {
    return { text, rollKey: null, optionKey: null, label: null, values, ambiguous: [] };
  }

  const close = scored.filter((s) => s.error <= best.error + MARGIN);
  if (close.length > 1) {
    // Several fit as well as each other. "Leech Rate +16%/Leech Power 2%"
    // says nothing about whether it is the HP or the SP one, and choosing
    // would be inventing half the answer.
    return {
      text, rollKey: null, optionKey: null, label: null, values,
      ambiguous: close.map((s) => s.label),
    };
  }
  return {
    text, rollKey: best.rollKey, optionKey: best.optionKey, label: best.label,
    values, ambiguous: [],
  };
}

/** Every line of a tooltip, resolved against the table for its slot. */
export function matchRolls(lines: string[], table: RollTable): RollMatch[] {
  return lines.map((line) => matchRoll(line, table));
}

/** The matches that resolved, as the picks a slot stores. */
export function picksFrom(
  matches: RollMatch[], table: RollTable,
): Record<string, RollPick> {
  const out: Record<string, RollPick> = {};
  for (const match of matches) {
    if (!match.rollKey || !match.optionKey) continue;
    const option = optionOf(table, match.rollKey, match.optionKey);
    if (!option) continue;

    const fallback = defaultValues(option);
    out[match.rollKey] = {
      option: option.key,
      values: option.grants.map(
        (grant, i) => clampRoll(grant, match.values[i] ?? fallback[i])),
    };
  }
  return out;
}

/**
 * Read one item's rolls off a tooltip, for a slot that is already known.
 *
 * The other way round -- a screenshot that has to say which slot it belongs
 * to -- has to recognise the item from the tooltip's title and then find it
 * in the build. Asked from a slot, none of that is needed or wanted: the
 * table comes from the slot, and a title that reads badly costs nothing.
 */
export async function readSlotRolls(
  image: ImageData, table: RollTable,
): Promise<{ title: string; matched: RollMatch[] } | null> {
  const { font } = await loadAssets();
  const tooltip = readTooltip(image, font);
  if (!tooltip) return null;
  return { title: tooltip.title, matched: matchRolls(tooltip.rolls, table) };
}
