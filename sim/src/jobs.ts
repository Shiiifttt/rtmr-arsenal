/**
 * Job restrictions are written as sentences, not lists.
 *
 * The payload stores an item's job limit as text: either a roll-call
 * ("Assassin, Rogue, Thief") or an exclusion ("All except Bouncer, Judge").
 * Reading it wrongly in the exclusion direction would hide exactly the
 * items a class can use, so the two forms are handled explicitly and
 * anything unrecognised is treated as "no restriction" rather than
 * silently filtering the item away.
 *
 * That sentence is all the site publishes, and it is not the whole rule: no
 * shield's sentence excludes Satsujin by name, yet a Satsujin holds only a
 * dagger and a one-handed shield. What a class may physically hold is
 * therefore kept alongside, in data/class-rules.json, and the two are read
 * together by `canEquip` -- which is what the app should ask. `canUse` on
 * its own answers only the sentence.
 */

import type { ClassRules, Item } from './types.ts';

const ALL_EXCEPT = /^all\s+except\s+(?<rest>.+)$/i;

/** Which slot group an equip slot belongs to; mirrors the crawler's table. */
const WEAPON_SLOTS = ['Weapon', 'Weapon (two-handed)'];
const OFF_HAND_SLOTS = ['Off-hand', 'Shield'];
const AMMO_SLOTS = ['Ammunition'];

export function canUse(usableBy: string | null | undefined, className: string | null): boolean {
  if (!className) return true;
  const text = (usableBy ?? '').trim();
  if (!text) return true;
  if (/^all$/i.test(text)) return true;

  const except = ALL_EXCEPT.exec(text);
  if (except) {
    const banned = splitClasses(except.groups!.rest);
    return !banned.includes(className.toLowerCase());
  }

  const allowed = splitClasses(text);
  // A phrase this parser does not recognise must not silently hide items.
  if (allowed.length === 0) return true;
  return allowed.includes(className.toLowerCase());
}

/**
 * The job sentence that governs this item, hand correction included.
 *
 * Corrections live in the rules payload rather than in the item record, so
 * the crawled sentence is still what the crawl wrote and withdrawing a
 * correction takes no re-crawl.
 */
export function jobLimitOf(
  item: Pick<Item, 'id' | 'usable_by'>, rules?: ClassRules | null,
): string | null {
  return rules?.items?.[String(item.id)]?.usable_by ?? item.usable_by;
}

/** Is this item a hand-corrected one, and on what footing? */
export function jobLimitFix(
  item: Pick<Item, 'id'>, rules?: ClassRules | null,
): { usable_by: string; was: string | null; status: string; reason: string } | null {
  return rules?.items?.[String(item.id)] ?? null;
}

/**
 * Can this class actually wear this item?
 *
 * Both halves must agree: the job sentence must admit the class, and where
 * the class has a rule for the slot the item's type must be one it can
 * hold. A class with no rule, or a rule that says nothing about this slot,
 * is governed by the sentence alone -- an unreviewed class must not lose
 * gear it may well be able to use.
 *
 * Cards are outside all of it: any class can compound any card. A card
 * carries the slot it goes into, so a weapon card would otherwise be judged
 * against the types its class may hold and fail every one of them -- its own
 * type is "Card", never "Dagger".
 */
export function canEquip(
  item: Item, className: string | null, rules?: ClassRules | null,
): boolean {
  if (item.kind === 'Card') return true;
  if (!canUse(jobLimitOf(item, rules), className)) return false;
  if (!className) return true;

  const rule = rules?.classes?.[className];
  if (!rule) return true;

  const allowed = slotAllowance(item, rule);
  if (!allowed) return true;
  // A rule that names types cannot judge an item that has none.
  return item.type ? allowed.includes(item.type) : true;
}

/** The type list governing the slot this item goes in, if the rule has one. */
function slotAllowance(
  item: Item, rule: NonNullable<ClassRules['classes'][string]>,
): string[] | null {
  const slots = item.equip_slots ?? [];
  if (rule.weapons && slots.some((s) => WEAPON_SLOTS.includes(s))) return rule.weapons;
  if (rule.off_hand && slots.some((s) => OFF_HAND_SLOTS.includes(s))) return rule.off_hand;
  if (rule.ammunition && slots.some((s) => AMMO_SLOTS.includes(s))) return rule.ammunition;
  return null;
}

function splitClasses(text: string): string[] {
  return text
    .split(/,| and /i)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
