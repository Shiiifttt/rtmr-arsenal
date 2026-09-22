/**
 * Reading an item's tooltip, for the random rolls under it.
 *
 * The rolls are not on the item -- they are what this one copy happened to
 * drop with -- so they are not in the crawled data and there is nowhere to
 * look them up. A screenshot of the tooltip is the only place they exist.
 *
 * This window is not located the way the others are. Its title is the item's
 * name, which is different every time, so there is no fixed shape to anchor
 * on. What it does have is the strip of bordered boxes underneath: the
 * client draws each roll in its own box, then the card sockets in one more,
 * all the same height and evenly spaced in a colour used nowhere else. That
 * strip is distinctive enough to find on its own.
 */

import type { Font } from './assets.ts';
import { findLines, readLine, type Rect } from './text.ts';

/** The colour the client outlines these boxes in. */
const BORDER = { r: 132, g: 0, b: 0 };
/** Top border to bottom border of one box. */
const BOX_HEIGHT = 22;
/** One box's top border to the next one's. */
const BOX_PITCH = 29;
/** A border has to run at least this much of the image's width. */
const BORDER_SPAN = 0.6;

export interface TooltipReading {
  /** The title bar, which carries the refine level and the card affixes. */
  title: string;
  /** One line per roll, as read. Empty when the item rolled nothing. */
  rolls: string[];
  /** Where the tooltip's own box starts, for reporting. */
  origin: { x: number; y: number };
}

function isBorder(image: ImageData, x: number, y: number): boolean {
  const i = (y * image.width + x) * 4;
  const d = image.data;
  return Math.abs(d[i] - BORDER.r) <= 8 && d[i + 1] <= 8 && d[i + 2] <= 8
    && d[i + 3] > 128;
}

interface Box { top: number; bottom: number; left: number; right: number }

/** Every horizontal border line, as the span of border pixels on that row. */
function borders(image: ImageData): Map<number, { left: number; right: number }> {
  const out = new Map<number, { left: number; right: number }>();
  for (let y = 0; y < image.height; y++) {
    let count = 0;
    let left = -1;
    let right = -1;
    for (let x = 0; x < image.width; x++) {
      if (!isBorder(image, x, y)) continue;
      count++;
      if (left < 0) left = x;
      right = x;
    }
    if (count > image.width * BORDER_SPAN) out.set(y, { left, right });
  }
  return out;
}

/** Pair the border lines into boxes. */
function boxes(image: ImageData): Box[] {
  const lines = borders(image);
  const out: Box[] = [];
  for (const [top, span] of lines) {
    const bottom = lines.get(top + BOX_HEIGHT);
    if (bottom) out.push({ top, bottom: top + BOX_HEIGHT, ...span });
  }
  return out.sort((a, b) => a.top - b.top);
}

/**
 * Find the tooltip, if the screenshot has one.
 *
 * The roll boxes sit in an unbroken run at the bottom, one every 29 pixels,
 * while the title bar is a box of the same size separated from them by the
 * whole body of the tooltip. So the last evenly spaced run is the strip, and
 * anything above it is the tooltip proper.
 */
export function readTooltip(image: ImageData, font: Font): TooltipReading | null {
  const found = boxes(image);
  if (found.length < 2) return null;

  let start = found.length - 1;
  while (start > 0 && found[start].top - found[start - 1].top === BOX_PITCH) start--;
  const strip = found.slice(start);

  // The title is the first box, and the strip has to sit below it; otherwise
  // this is a run of boxes belonging to something else.
  const title = found[0];
  if (title === strip[0] || title.top >= strip[0].top) return null;

  // The last box of the strip holds the card sockets, which are drawn rather
  // than written -- and which the client shows even for an item with none.
  // Whatever is above it, and has text in it, is a roll.
  const rolls: string[] = [];
  for (const box of strip.slice(0, -1)) {
    const line = textOf(image, box, font);
    if (line) rolls.push(line);
  }

  return {
    title: textOf(image, title, font),
    rolls,
    origin: { x: title.left, y: title.top },
  };
}

/** Everything written inside one box, as a single line. */
function textOf(image: ImageData, box: Box, font: Font): string {
  // Inside the border: a rounded corner and whatever sits behind the box
  // otherwise bleed in at the edges.
  const rect: Rect = {
    x: box.left + 4,
    y: box.top + 1,
    w: box.right - box.left - 7,
    h: box.bottom - box.top - 1,
  };
  return findLines(image, rect).map((line) => readLine(line, font)).join(' ').trim();
}
