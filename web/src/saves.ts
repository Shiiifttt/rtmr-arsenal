import type { Build } from '@sim';

/**
 * Named builds, kept beside the autosave.
 *
 * The autosave is one slot and always the build in front of you: it is
 * memory, not a record. These are the record -- "my farming set", "the MVP
 * one" -- so trying something out costs nothing, and going back is a click
 * rather than a rebuild.
 */

const SAVES_KEY = 'rtmr.saves.v1';

export interface SavedBuild {
  /** Stable across renames, so a list key never changes under React. */
  id: string;
  name: string;
  /** Epoch milliseconds. Shown as a date, sorted on as a number. */
  savedAt: number;
  build: Build;
}

export function loadSaves(): SavedBuild[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVES_KEY) ?? 'null');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s): s is SavedBuild => !!s && typeof s.id === 'string'
        && typeof s.name === 'string' && !!s.build)
      .map((s) => ({ ...s, savedAt: Number(s.savedAt) || 0 }))
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    // Absent, blocked or corrupt storage reads as "no saved builds", which
    // is true enough and leaves whatever is there untouched.
    return [];
  }
}

/**
 * Write the list back.
 *
 * Returns the error to show, or null. Storage is small and can be full or
 * switched off, and a save that silently did nothing is the worst way for a
 * player to find that out -- they find out when the build is gone.
 */
export function writeSaves(saves: SavedBuild[]): string | null {
  try {
    localStorage.setItem(SAVES_KEY, JSON.stringify(saves));
    return null;
  } catch {
    return 'Could not save: browser storage is full or switched off.';
  }
}

/** A saved build under this name, replacing one of the same name. */
export function putSave(saves: SavedBuild[], name: string, build: Build): SavedBuild[] {
  const trimmed = name.trim();
  const existing = saves.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
  const record: SavedBuild = {
    id: existing?.id ?? newId(),
    name: trimmed,
    savedAt: Date.now(),
    build,
  };
  return [record, ...saves.filter((s) => s.id !== record.id)];
}

function newId(): string {
  return (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
}

/** "Farming set (2 Feb 2026)" -- what a download of this build is called. */
export function fileName(name: string): string {
  const safe = name.trim().replace(/[^\w -]+/g, '').trim() || 'build';
  return `rtmr-${safe.replace(/\s+/g, '-').toLowerCase()}.json`;
}
