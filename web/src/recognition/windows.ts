/**
 * Finding a game window inside a screenshot.
 *
 * Each window carries the shape of its own title as an anchor: which pixels
 * the client draws black, and which it does not. The UI is drawn at one
 * pixel per pixel and never scales, so that shape appears exactly or not at
 * all -- which makes locating a window an exact search rather than a fuzzy
 * one, and makes the same search answer which window it is.
 *
 * Only the shape, never the colours. The lettering sits on a skin that tiles
 * to the window's width and that the player can make see-through, so keeping
 * a picture of it would tie this to one window size and one UI setting.
 *
 * Screenshots may be of the whole screen or of a window someone has already
 * cropped out. Both work: the anchor is found wherever it is, and every
 * other coordinate is relative to it.
 */

import type { Anchor, Font, WindowLayout } from './assets.ts';
import { findLines, isInk, readLine } from './text.ts';

export interface Found {
  layout: WindowLayout;
  /** Add this to any layout coordinate to get a screenshot coordinate. */
  dx: number;
  dy: number;
}

/** Every window present in the screenshot, in the order they were declared. */
export function findWindows(image: ImageData, layouts: WindowLayout[]): Found[] {
  const out: Found[] = [];
  for (const layout of layouts) {
    const at = findAnchor(image, layout.anchor);
    if (at) out.push({ layout, dx: at.x - layout.anchor.x, dy: at.y - layout.anchor.y });
  }
  return out;
}

function findAnchor(image: ImageData, anchor: Anchor): { x: number; y: number } | null {
  const { w, h, ink } = anchor;
  if (image.width < w || image.height < h) return null;

  // A handful of pixels that must be black, spread across the mask. Black is
  // rare enough in a screenshot that this rejects almost every position
  // without touching the rest of the shape.
  const probes: number[] = [];
  for (let i = 0; i < ink.length && probes.length < 6; i += Math.max(1, ink.length >> 4)) {
    for (let j = i; j < ink.length; j++) {
      if (ink[j]) { probes.push(j); break; }
    }
  }

  for (let y = 0; y <= image.height - h; y++) {
    for (let x = 0; x <= image.width - w; x++) {
      let hit = true;
      for (const at of probes) {
        if (!isInk(image, x + (at % w), y + Math.floor(at / w))) { hit = false; break; }
      }
      if (hit && matches(image, x, y, anchor)) return { x, y };
    }
  }
  return null;
}

/**
 * Compare the mask: black where the window draws black, not black elsewhere.
 *
 * Only whether each pixel is black, never what colour it is. The title
 * lettering and the rule under it are the one part of a window's chrome that
 * is the same in every capture -- the background behind them is a skin that
 * tiles to the window's width and can be set see-through, so matching that
 * verbatim ties the recogniser to one window size and one UI setting.
 */
function matches(image: ImageData, x: number, y: number, anchor: Anchor): boolean {
  const { w, h, ink } = anchor;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      if (isInk(image, x + col, y + row) !== (ink[row * w + col] === 1)) return false;
    }
  }
  return true;
}

/**
 * Which tab of the equipment window is open.
 *
 * The open tab has no bottom edge -- it runs into the panel below it -- so
 * the row under each tab is either border or panel, and the odd one out is
 * the open one.
 */
export function activeTab(
  image: ImageData, found: Found,
): 'primary' | 'secondary' | 'title' | undefined {
  const tabs = found.layout.tabs;
  if (!tabs) return undefined;

  const y = tabs.probeY + found.dy;
  if (y < 0 || y >= image.height) return undefined;

  const seen = tabs.items.map((tab) => {
    const x = tab.x + found.dx;
    if (x < 0 || x >= image.width) return null;
    const i = (y * image.width + x) * 4;
    return `${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`;
  });

  // Whichever colour appears once is the open tab; the others share the
  // border colour. Comparing them to each other avoids having to store what
  // either colour actually is.
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] === null) continue;
    if (seen.filter((other) => other === seen[i]).length === 1) return tabs.items[i].key;
  }
  return undefined;
}

/**
 * Say something useful when no window matched.
 *
 * "Not found" on its own is not actionable, and the two things that go wrong
 * look nothing alike: a capture that has been rescaled or saved as JPEG has
 * no pure black left in it at all, whereas a client whose window skin or font
 * differs from the samples still has perfectly good titles that simply do not
 * match the stored shapes. Reading the titles back tells them apart.
 */
export function diagnose(image: ImageData, font: Font): string {
  let ink = 0;
  for (let y = 0; y < image.height && ink < 50; y += 2) {
    for (let x = 0; x < image.width && ink < 50; x += 2) if (isInk(image, x, y)) ink++;
  }
  if (ink < 50) {
    return 'There is almost no pure black in this image. The client draws all '
      + 'its text and window edges in it, so the capture has probably been '
      + 'rescaled, or saved as JPEG rather than PNG.';
  }

  const titles = readTitles(image, font);
  if (!titles.length) {
    return 'No window title was found. This reads the Equipment, Status and '
      + 'Basic Information windows — the title bar has to be in shot and not '
      + 'covered by anything.';
  }
  return `Found ${titles.map((t) => `"${t}"`).join(', ')}, but the title did not `
    + 'match any known window. If that is the right window, the client\'s font or '
    + 'window skin differs from the samples in recognition/samples.';
}

/** Read whatever sits above each horizontal rule that looks like a title bar. */
function readTitles(image: ImageData, font: Font): string[] {
  const out: string[] = [];
  for (let y = 12; y < image.height && out.length < 4; y++) {
    const rule = longestRun(image, y);
    if (rule.length < 80) continue;

    const lines = findLines(image, { x: rule.start, y: y - 16, w: 160, h: 15 });
    const text = lines.length ? readLine(lines[lines.length - 1], font).trim() : '';
    if (text && !out.includes(text)) out.push(text);
    y += 8;  // past this window's own chrome
  }
  return out;
}

function longestRun(image: ImageData, y: number): { start: number; length: number } {
  let best = { start: 0, length: 0 };
  let from = -1;
  for (let x = 0; x <= image.width; x++) {
    if (x < image.width && isInk(image, x, y)) {
      if (from < 0) from = x;
    } else if (from >= 0) {
      if (x - from > best.length) best = { start: from, length: x - from };
      from = -1;
    }
  }
  return best;
}
