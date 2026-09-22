/**
 * Reading the client's text.
 *
 * The font is drawn without antialiasing, so every pixel of every character
 * is black and nothing else in a window is. That turns reading into exact
 * template matching: find the black pixels, then walk them left to right
 * taking the widest glyph that fits.
 *
 * Splitting on blank columns would be simpler but wrong -- this font kerns,
 * so "rc" can come back as a single run of ink. The greedy walk does not
 * care where the runs are.
 */

import type { Font, Glyph } from './assets.ts';

/** A band of a region that contains ink, as a column-major bitmap. */
export interface Line {
  top: number;
  bottom: number;
  width: number;
  height: number;
  /** 1 where the pixel is black; indexed [x * height + y]. */
  ink: Uint8Array;
}

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Bands shorter than this are not text.
 *
 * The equipment window gives each row a fixed height and then lets a
 * descender from the row above hang a pixel or two into it, so a naive scan
 * finds a two-row "line" of leftover g and y tails at the top of most rows.
 * Every real line here is at least nine rows tall.
 */
const MIN_LINE_HEIGHT = 5;

/**
 * JPEG turns a black pixel into a cloud of nearly-black ones, which breaks
 * everything downstream; a couple of levels of slack is all that is safe to
 * allow, and anything more lossy than that is beyond saving anyway.
 */
export function isInk(image: ImageData, x: number, y: number): boolean {
  const i = (y * image.width + x) * 4;
  const d = image.data;
  return d[i] <= 8 && d[i + 1] <= 8 && d[i + 2] <= 8 && d[i + 3] > 128;
}

/** The bands of a rectangle that hold text, top to bottom. */
export function findLines(image: ImageData, rect: Rect): Line[] {
  const right = Math.min(rect.x + rect.w, image.width);
  const bottom = Math.min(rect.y + rect.h, image.height);
  if (rect.x < 0 || rect.y < 0 || right <= rect.x || bottom <= rect.y) return [];

  const lines: Line[] = [];
  let start = -1;
  for (let y = rect.y; y <= bottom; y++) {
    let filled = false;
    for (let x = rect.x; y < bottom && x < right; x++) {
      if (isInk(image, x, y)) { filled = true; break; }
    }
    if (filled && start < 0) start = y;
    else if (!filled && start >= 0) {
      if (y - start >= MIN_LINE_HEIGHT) lines.push(extract(image, rect.x, right, start, y));
      start = -1;
    }
  }
  return lines;
}

function extract(image: ImageData, left: number, right: number,
                 top: number, bottom: number): Line {
  const width = right - left;
  const height = bottom - top;
  const ink = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (isInk(image, left + x, top + y)) ink[x * height + y] = 1;
    }
  }
  return { top, bottom, width, height, ink };
}

function blank(line: Line, x: number): boolean {
  const base = x * line.height;
  for (let y = 0; y < line.height; y++) if (line.ink[base + y]) return false;
  return true;
}

/**
 * Does this glyph sit at column x, at any vertical offset?
 *
 * The whole box has to match, blank pixels included. Nothing less will do:
 * '6' and 'B' are the same bitmap apart from their outermost columns, as are
 * 'c' and 'o', so a template allowed to ignore part of its box stops telling
 * them apart. Two characters that touch still own their own columns, so this
 * costs nothing on kerned pairs.
 */
function fits(line: Line, x: number, glyph: Glyph): boolean {
  const rows = glyph.rows;
  const gw = rows[0].length;
  const gh = rows.length;
  if (x + gw > line.width || gh > line.height) return false;

  for (let dy = 0; dy <= line.height - gh; dy++) {
    let ok = true;
    for (let cx = 0; cx < gw && ok; cx++) {
      const base = (x + cx) * line.height;
      for (let y = 0; y < line.height; y++) {
        const ry = y - dy;
        const want = ry >= 0 && ry < gh && rows[ry][cx] === '#';
        if ((line.ink[base + y] === 1) !== want) { ok = false; break; }
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Read a line.
 *
 * A character the font table does not have comes back as a single '?'
 * rather than as whatever narrower shapes happen to fit inside it. Callers
 * match these against a known list of names, where a wildcard costs nothing
 * and a confidently wrong letter costs the item.
 */
export function readLine(line: Line, font: Font): string {
  const out: string[] = [];
  let x = 0;
  let end = 0;
  while (x < line.width) {
    if (blank(line, x)) { x++; continue; }
    if (out.length && x - end >= font.space) out.push(' ');

    let width = 0;
    for (const glyph of font.glyphs) {
      if (fits(line, x, glyph)) {
        out.push(glyph.c);
        width = glyph.rows[0].length;
        break;
      }
    }
    if (!width) {
      if (out[out.length - 1] !== '?') out.push('?');
      width = 1;
    }
    x += width;
    end = x;
  }
  return out.join('');
}

/** Every line of a rectangle, read and joined with single spaces. */
export function readText(image: ImageData, rect: Rect, font: Font): string[] {
  return findLines(image, rect).map((line) => readLine(line, font));
}
