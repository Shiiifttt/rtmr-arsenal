/** What reading a screenshot of one game window produces. */

/** One row of the equipment window. */
export interface ReadSlot {
  column: 'left' | 'right';
  row: number;
  /** The item, once the icon and the name agree on one. */
  itemId: number | null;
  /**
   * Everything whose icon matches this cell. Some icons are shared by fifty
   * items -- every shadow armour in the game is drawn the same -- so this is
   * regularly longer than one even when the read went perfectly.
   */
  candidates: number[];
  /** The name as read, with '?' wherever the font table came up short. */
  text: string;
  refine: number;
  /** Cards inferred from the affixes on the name, where the affix is unique. */
  cards: number[];
  /** Affixes that named a card the item cannot actually hold, or that several
   * cards share. Worth showing; not worth acting on. */
  unresolvedAffixes: string[];
}

export interface ReadStat {
  base: number;
  bonus: number;
}

/** One line of an item tooltip's roll strip. */
export interface ReadRoll {
  /** The line as read, wildcards and all, for showing when it did not match. */
  text: string;
  rollKey: string | null;
  optionKey: string | null;
  values: number[];
  /** Options that fit equally well, when none stood out. */
  ambiguous: string[];
}

export interface Reading {
  window: 'equipment' | 'status' | 'basic-info' | 'tooltip';
  /** Where the window was found, for drawing over the screenshot. */
  origin: { x: number; y: number };
  tab?: 'primary' | 'secondary' | 'title';
  slots?: ReadSlot[];
  /** str, agi, vit, int, dex, luk. */
  stats?: Record<string, ReadStat>;
  derived?: Record<string, ReadStat>;
  levels?: { base?: number; job?: number };

  /** The tooltip's title bar, which carries the refine and the card affixes. */
  title?: string;
  /** The item the title named, once it matched one. */
  itemId?: number | null;
  /**
   * The roll lines, unresolved. Which table they belong to depends on the
   * slot the item is in, which is not known until the reading is applied.
   */
  rollLines?: string[];
}
