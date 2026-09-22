/**
 * Reading a screenshot: find the windows, then read what is in them.
 *
 * Everything below works from fixed offsets into a located window. Nothing
 * is searched for, because there is nothing to search for -- the client
 * draws these panels the same way every time.
 */

import type { Dataset, Item } from '@sim';
import { loadAssets, type Assets, type WindowLayout } from './assets.ts';
import { matchIcon } from './icons.ts';
import { readName } from './names.ts';
import { readText } from './text.ts';
import type { Reading, ReadSlot, ReadStat } from './types.ts';
import { readTooltip } from './tooltip.ts';
import { activeTab, findWindows, type Found } from './windows.ts';

const STAT_KEYS = ['str', 'agi', 'vit', 'int', 'dex', 'luk'];

/** Read every game window the screenshot contains. */
export async function recognise(image: ImageData, dataset: Dataset): Promise<Reading[]> {
  const assets = await loadAssets();
  const cards = dataset.itemList.filter((item) => item.card_affix);

  const readings = findWindows(image, assets.windows).map((found) => {
    switch (found.layout.id) {
      case 'equipment': return readEquipment(image, found, assets, dataset, cards);
      case 'status': return readStatus(image, found, assets);
      case 'basic-info': return readBasicInfo(image, found, assets);
    }
  });

  // An item tooltip has no fixed chrome to anchor on -- its title is the
  // item's name -- so it is looked for separately, by the strip of boxes the
  // client draws its rolls in.
  const tooltip = readTooltip(image, assets.font);
  if (tooltip) {
    readings.push({
      window: 'tooltip',
      origin: tooltip.origin,
      title: tooltip.title,
      rollLines: tooltip.rolls,
    });
  }

  return readings;
}

function origin(found: Found) {
  return { x: found.dx, y: found.dy };
}

function readEquipment(
  image: ImageData, found: Found, assets: Assets, dataset: Dataset, cards: Item[],
): Reading {
  const layout = found.layout.slots;
  const slots: ReadSlot[] = [];
  if (!layout) return { window: 'equipment', origin: origin(found), slots };

  for (const column of layout.columns) {
    for (let row = 0; row < layout.rows; row++) {
      const y = layout.firstY + row * layout.pitch + found.dy;
      const icon = matchIcon(
        image, column.iconX + found.dx, y, layout.iconSize, assets.icons,
      );

      const text = readText(image, {
        x: column.textX + found.dx, y, w: column.textW, h: layout.pitch,
      }, assets.font).join('');

      if (!icon && !text) continue;  // an empty slot

      const candidates = (icon?.ids ?? [])
        .map((id) => dataset.items.get(id))
        .filter((item): item is Item => !!item);
      const name = readName(text, candidates, cards);

      slots.push({
        column: column.side,
        row,
        itemId: name.itemId ?? (candidates.length === 1 ? candidates[0].id : null),
        candidates: candidates.map((item) => item.id),
        text,
        refine: name.refine,
        cards: name.cards,
        unresolvedAffixes: name.unresolved,
      });
    }
  }

  return { window: 'equipment', origin: origin(found), tab: activeTab(image, found), slots };
}

function readStatus(image: ImageData, found: Found, assets: Assets): Reading {
  const stats: Record<string, ReadStat> = {};
  const derived: Record<string, ReadStat> = {};
  const layout = found.layout as WindowLayout;

  if (layout.stats) {
    const { firstY, pitch, height, valueX, valueW } = layout.stats;
    STAT_KEYS.forEach((key, row) => {
      const value = field(image, valueX + found.dx, firstY + row * pitch + found.dy,
                          valueW, height, assets);
      if (value) stats[key] = value;
    });
  }

  if (layout.derived) {
    const { firstY, pitch, height, left, right } = layout.derived;
    for (const side of [left, right]) {
      side.keys.forEach((key, row) => {
        const value = field(image, side.x + found.dx, firstY + row * pitch + found.dy,
                            side.w, height, assets);
        if (value) derived[key] = value;
      });
    }
  }

  return { window: 'status', origin: origin(found), stats, derived };
}

/** One numeric field, as "99+36" or "198 + 118" or just "452". */
function field(image: ImageData, x: number, y: number, w: number, h: number,
               assets: Assets): ReadStat | null {
  const text = readText(image, { x, y, w, h }, assets.font).join('').replace(/\s+/g, '');
  const parts = /^(\d+)(?:\+(\d+))?$/.exec(text);
  return parts ? { base: Number(parts[1]), bonus: Number(parts[2] ?? 0) } : null;
}

function readBasicInfo(image: ImageData, found: Found, assets: Assets): Reading {
  const body = found.layout.body;
  const levels: { base?: number; job?: number } = {};
  if (body) {
    const text = readText(image, {
      x: body[0] + found.dx, y: body[1] + found.dy, w: body[2], h: body[3],
    }, assets.font).join('\n').replace(/[ \t]+/g, '');

    // Read by pattern rather than position: this window stacks its rows
    // differently depending on what it has to show.
    levels.base = Number(/Base?Lv\.?(\d+)/i.exec(text)?.[1]) || undefined;
    levels.job = Number(/Job?Lv\.?(\d+)/i.exec(text)?.[1]) || undefined;
  }
  return { window: 'basic-info', origin: origin(found), levels };
}
