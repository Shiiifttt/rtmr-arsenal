/**
 * Just enough PNG to run the recogniser outside a browser.
 *
 * In the app the browser decodes images for us -- `createImageBitmap` and a
 * canvas hand back the RGBA bytes. A test has neither, and the whole point
 * of these tests is to run the real matching code against the real sample
 * screenshots, so the pixels have to come from somewhere.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The shape of the browser's ImageData, which is all the recogniser uses. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function readPNG(path: string): Raster {
  const raw = readFileSync(path);
  let pos = 8;
  let width = 0, height = 0, depth = 0, colour = 0;
  let palette = Buffer.alloc(0);
  let alpha = Buffer.alloc(0);
  const parts: Buffer[] = [];

  while (pos < raw.length) {
    const length = raw.readUInt32BE(pos);
    const kind = raw.toString('ascii', pos + 4, pos + 8);
    const body = raw.subarray(pos + 8, pos + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colour = body[9];
    } else if (kind === 'PLTE') palette = Buffer.from(body);
    else if (kind === 'tRNS') alpha = Buffer.from(body);
    else if (kind === 'IDAT') parts.push(Buffer.from(body));
    else if (kind === 'IEND') break;
    pos += 12 + length;
  }
  if (depth !== 8) throw new Error(`${path}: ${depth}-bit PNGs are not supported`);

  const nch = CHANNELS[colour];
  const lines = unfilter(inflateSync(Buffer.concat(parts)), width, height, nch);
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * nch;
      const d = (y * width + x) * 4;
      if (colour === 6) {
        data.set(lines.subarray(s, s + 4), d);
      } else if (colour === 2) {
        data.set(lines.subarray(s, s + 3), d);
        data[d + 3] = 255;
      } else if (colour === 3) {
        const i = lines[s];
        data.set(palette.subarray(i * 3, i * 3 + 3), d);
        data[d + 3] = i < alpha.length ? alpha[i] : 255;
      } else {
        data[d] = data[d + 1] = data[d + 2] = lines[s];
        data[d + 3] = colour === 4 ? lines[s + 1] : 255;
      }
    }
  }
  return { width, height, data };
}

function unfilter(raw: Buffer, width: number, height: number, nch: number): Buffer {
  const stride = width * nch;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let pos = 0;

  for (let y = 0; y < height; y++) {
    const kind = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;

    for (let i = 0; i < stride; i++) {
      const a = i >= nch ? line[i - nch] : 0;
      const b = prev[i];
      const c = i >= nch ? prev[i - nch] : 0;
      let add = 0;
      if (kind === 1) add = a;
      else if (kind === 2) add = b;
      else if (kind === 3) add = (a + b) >> 1;
      else if (kind === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (kind !== 0) throw new Error(`unknown scanline filter ${kind}`);
      line[i] = (line[i] + add) & 0xFF;
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return out;
}
