/**
 * Every class kit, by class name. A build fights with its own class's kit;
 * a class without one yet falls back to Satsujin's.
 */
import type { Passives } from '../character.ts';
import type { Kit } from '../engine.ts';
import type { DefenseTool } from './defense.ts';
import * as kingslayer from './kingslayer.ts';
import * as nightraven from './nightraven.ts';
import * as revenant from './revenant.ts';
import * as satsujin from './satsujin.ts';

export interface KitEntry {
  kit: Kit;
  passives: (levels: Record<string, number>, weaponType: string | null, baseLevel: number) => Passives;
  aliases: Record<string, string[]>;
  maxLevels: () => Record<string, number>;
  /** Its dodges, for the automatic defence (option defense 'auto', defense.ts). */
  tools: DefenseTool[];
  /** What the rotation searches may change (tools/gear-search.ts --only rotation,order; tools/rotation-search.ts). */
  search: RotationSpace;
}

/**
 * A kit's rotation, as a search sees it: the written priority order (the
 * profile's option order reorders it) and the switches its rules read.
 */
export interface RotationSpace {
  order: string[];
  /** Each switch's values, the kit's default first. */
  switches: Record<string, unknown[]>;
  /** Play styles: several switches at once. */
  sets?: Record<string, Record<string, unknown>>;
  /** Order entries never moved: dodges and upkeep. */
  pinned?: string[];
  /** Entries that may be left out of the order altogether (and put back). */
  droppable?: string[];
  /** A new piece's random options: the first of these a roll line offers (gear-search ROLL_PREFERENCE; the Kingslayer's by default). */
  rolls?: string[];
}

export const KITS: Record<string, KitEntry> = {
  Satsujin: { kit: satsujin.satsujin, passives: satsujin.passives, aliases: satsujin.ALIASES, maxLevels: satsujin.maxLevels, tools: satsujin.SATSUJIN_TOOLS, search: satsujin.SATSUJIN_SEARCH },
  Revenant: { kit: revenant.revenant, passives: revenant.passives, aliases: revenant.ALIASES, maxLevels: revenant.maxLevels, tools: revenant.REVENANT_TOOLS, search: revenant.REVENANT_SEARCH },
  'Night Raven': { kit: nightraven.nightraven, passives: nightraven.passives, aliases: nightraven.ALIASES, maxLevels: nightraven.maxLevels, tools: nightraven.NIGHTRAVEN_TOOLS, search: nightraven.NIGHTRAVEN_SEARCH },
  Kingslayer: { kit: kingslayer.kingslayer, passives: kingslayer.passives, aliases: kingslayer.ALIASES, maxLevels: kingslayer.maxLevels, tools: kingslayer.KINGSLAYER_TOOLS, search: kingslayer.KINGSLAYER_SEARCH },
};

export const kitFor = (className: string | null): KitEntry => KITS[className ?? ''] ?? KITS.Satsujin;
