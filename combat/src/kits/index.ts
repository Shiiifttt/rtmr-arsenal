/**
 * Every class kit, by class name. A build fights with its own class's kit;
 * a class without one yet falls back to Satsujin's.
 */
import type { Passives } from '../character.ts';
import type { Kit } from '../engine.ts';
import type { DefenseTool } from './defense.ts';
import * as kingslayer from './kingslayer.ts';
import * as satsujin from './satsujin.ts';

export interface KitEntry {
  kit: Kit;
  passives: (levels: Record<string, number>, weaponType: string | null, baseLevel: number) => Passives;
  aliases: Record<string, string[]>;
  maxLevels: () => Record<string, number>;
  /** Its dodges, for the automatic defence (option defense 'auto', defense.ts). */
  tools: DefenseTool[];
}

export const KITS: Record<string, KitEntry> = {
  Satsujin: { kit: satsujin.satsujin, passives: satsujin.passives, aliases: satsujin.ALIASES, maxLevels: satsujin.maxLevels, tools: satsujin.SATSUJIN_TOOLS },
  Kingslayer: { kit: kingslayer.kingslayer, passives: kingslayer.passives, aliases: kingslayer.ALIASES, maxLevels: kingslayer.maxLevels, tools: kingslayer.KINGSLAYER_TOOLS },
};

export const kitFor = (className: string | null): KitEntry => KITS[className ?? ''] ?? KITS.Satsujin;
