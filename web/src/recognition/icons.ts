/**
 * Identifying an equipped item from the icon the client draws for it.
 *
 * The client blits the item's icon into the slot unmodified, so this is a
 * direct pixel comparison against the icon library rather than anything
 * perceptual -- a real match lands around 2 levels of average error per
 * channel and the next candidate is twenty times worse, which is about as
 * unambiguous as image matching gets.
 *
 * What it cannot do is tell apart items the database draws identically, and
 * there are a lot of those: every shadow armour in the game shares one icon.
 * So this returns the whole tie group and leaves picking to the name.
 */

import type { Icons } from './assets.ts';

export interface IconMatch {
  /** Items whose icons are equally good fits, best first. */
  ids: number[];
  /** Mean absolute error per channel, 0-255. */
  error: number;
}

/**
 * Above this, the cell holds something that is not in the library -- most
 * often an empty slot, which sits around 23, or an item added since the last
 * crawl. Real matches sit near 2, so there is no shortage of room here.
 */
const ACCEPT = 10;

/** Icons within this much of the best are indistinguishable in practice. */
const TIE = 1;

const opaqueCounts = new WeakMap<Icons, Int32Array>();

function counts(icons: Icons): Int32Array {
  let cached = opaqueCounts.get(icons);
  if (!cached) {
    cached = new Int32Array(icons.entries.length);
    icons.entries.forEach((entry, index) => {
      let n = 0;
      for (let y = 0; y < entry.h; y++) {
        for (let x = 0; x < entry.w; x++) {
          if (icons.pixels[entry.at + y * icons.stride + x * 4 + 3] > 200) n++;
        }
      }
      cached![index] = n;
    });
    opaqueCounts.set(icons, cached);
  }
  return cached;
}

/**
 * Compare every icon against the square at (x, y).
 *
 * Most icons are the size of the slot and so have one possible alignment.
 * The couple of hundred that arrive from the database with their transparent
 * margins trimmed off are slid over the cell instead.
 */
export function matchIcon(
  image: ImageData, x: number, y: number, size: number, icons: Icons,
): IconMatch | null {
  const opaque = counts(icons);
  let best = Infinity;
  // Kept with their errors and filtered at the end: an icon that ties the
  // leader now may be well behind a later one, and pruning as we go would
  // mean re-checking the whole list every time the leader improves.
  const near: { id: number; error: number }[] = [];

  for (let index = 0; index < icons.entries.length; index++) {
    const entry = icons.entries[index];
    if (!opaque[index]) continue;

    const dxLo = Math.min(0, size - entry.w);
    const dxHi = Math.max(0, size - entry.w);
    const dyLo = Math.min(0, size - entry.h);
    const dyHi = Math.max(0, size - entry.h);

    for (let dy = dyLo; dy <= dyHi; dy++) {
      for (let dx = dxLo; dx <= dxHi; dx++) {
        // Anything worse than the leader cannot change the answer, so the
        // comparison can stop the moment it passes that total.
        const limit = best * 3 * opaque[index];
        const error = compare(image, x + dx, y + dy, x, y, size, icons, entry, limit);
        if (error === null) continue;

        const mean = error / (3 * opaque[index]);
        if (mean <= best + TIE) near.push({ id: entry.id, error: mean });
        if (mean < best) best = mean;
      }
    }
  }

  if (best > ACCEPT) return null;
  const ids = near
    .filter((hit) => hit.error <= best + TIE)
    .sort((a, b) => a.error - b.error)
    .map((hit) => hit.id);
  return { ids: [...new Set(ids)], error: best };
}

/** Summed absolute error over the icon's opaque pixels, or null if it exceeds
 * `limit` -- which is the common case and worth leaving early. */
function compare(
  image: ImageData, ix: number, iy: number, slotX: number, slotY: number,
  size: number, icons: Icons, entry: { at: number; w: number; h: number },
  limit: number,
): number | null {
  const { pixels, stride } = icons;
  const data = image.data;
  let total = 0;

  for (let y = 0; y < entry.h; y++) {
    const py = iy + y;
    if (py < slotY || py >= slotY + size || py < 0 || py >= image.height) continue;
    let src = entry.at + y * stride;
    let dst = (py * image.width + ix) * 4;

    for (let x = 0; x < entry.w; x++, src += 4, dst += 4) {
      const px = ix + x;
      if (px < slotX || px >= slotX + size || px < 0 || px >= image.width) continue;
      if (pixels[src + 3] <= 200) continue;

      total += Math.abs(data[dst] - pixels[src])
        + Math.abs(data[dst + 1] - pixels[src + 1])
        + Math.abs(data[dst + 2] - pixels[src + 2]);
      if (total > limit) return null;
    }
  }
  return total;
}
