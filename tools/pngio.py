#!/usr/bin/env python3
"""
Minimal PNG reader/writer, stdlib only.

The rest of the project has no pip dependencies and there is no reason for
these build tools to be the exception: everything here is 8-bit RGB or RGBA,
which is a small enough slice of the format to decode directly.

Images are held as a flat `bytearray` of RGBA, four bytes per pixel, because
that is the layout the browser gets from `getImageData` -- keeping the two
sides identical means the matching code can be read against either one.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


class Image:
    """8-bit RGBA raster."""

    __slots__ = ('width', 'height', 'data')

    def __init__(self, width: int, height: int, data: bytearray | None = None) -> None:
        self.width = width
        self.height = height
        self.data = data if data is not None else bytearray(width * height * 4)

    def pixel(self, x: int, y: int) -> tuple[int, int, int, int]:
        i = (y * self.width + x) * 4
        return tuple(self.data[i:i + 4])  # type: ignore[return-value]

    def blit(self, src: Image, x: int, y: int) -> None:
        """Copy `src` in at (x, y), replacing rather than blending."""
        for row in range(src.height):
            si = row * src.width * 4
            di = ((y + row) * self.width + x) * 4
            self.data[di:di + src.width * 4] = src.data[si:si + src.width * 4]

    def crop(self, x: int, y: int, w: int, h: int) -> Image:
        out = Image(w, h)
        for row in range(h):
            si = ((y + row) * self.width + x) * 4
            out.data[row * w * 4:(row + 1) * w * 4] = self.data[si:si + w * 4]
        return out


def read_png(path: str | Path) -> Image:
    raw = Path(path).read_bytes()
    if raw[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'{path}: not a PNG')

    pos, idat = 8, bytearray()
    width = height = depth = colour = 0
    palette = transparency = b''
    while pos < len(raw):
        (length,) = struct.unpack('>I', raw[pos:pos + 4])
        kind = raw[pos + 4:pos + 8]
        body = raw[pos + 8:pos + 8 + length]
        if kind == b'IHDR':
            width, height, depth, colour = struct.unpack('>IIBB', body[:10])
        elif kind == b'PLTE':
            palette = body
        elif kind == b'tRNS':
            transparency = body
        elif kind == b'IDAT':
            idat += body
        elif kind == b'IEND':
            break
        pos += 12 + length

    if depth != 8:
        raise ValueError(f'{path}: {depth}-bit PNGs are not supported')

    nch = _CHANNELS[colour]
    lines = _unfilter(zlib.decompress(idat), width, height, nch)

    img = Image(width, height)
    out = img.data
    for y in range(height):
        si = y * width * nch
        di = y * width * 4
        for x in range(width):
            s = si + x * nch
            d = di + x * 4
            if colour == 6:
                out[d:d + 4] = lines[s:s + 4]
            elif colour == 2:
                out[d:d + 3] = lines[s:s + 3]
                out[d + 3] = 255
            elif colour == 3:
                idx = lines[s]
                out[d:d + 3] = palette[idx * 3:idx * 3 + 3]
                out[d + 3] = transparency[idx] if idx < len(transparency) else 255
            else:  # greyscale, with or without alpha
                g = lines[s]
                out[d] = out[d + 1] = out[d + 2] = g
                out[d + 3] = lines[s + 1] if colour == 4 else 255
    return img


def _unfilter(raw: bytes, width: int, height: int, nch: int) -> bytearray:
    """Undo the per-scanline filters, returning packed samples."""
    stride = width * nch
    out = bytearray(stride * height)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        kind = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride

        if kind == 1:  # Sub
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 0xFF
        elif kind == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif kind == 3:  # Average
            for i in range(stride):
                left = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif kind == 4:  # Paeth
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                c = prev[i - nch] if i >= nch else 0
                b = prev[i]
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                if pa <= pb and pa <= pc:
                    pred = a
                elif pb <= pc:
                    pred = b
                else:
                    pred = c
                line[i] = (line[i] + pred) & 0xFF
        elif kind != 0:
            raise ValueError(f'unknown scanline filter {kind}')

        out[y * stride:(y + 1) * stride] = line
        prev = line
    return out


def write_png(path: str | Path, img: Image) -> None:
    """Write RGBA, filtering each scanline with Up -- cheap, and pixel art
    repeats vertically far more than it repeats horizontally."""
    stride = img.width * 4
    raw = bytearray()
    prev = bytes(stride)
    for y in range(img.height):
        line = img.data[y * stride:(y + 1) * stride]
        raw.append(2)
        raw += bytes((line[i] - prev[i]) & 0xFF for i in range(stride))
        prev = line

    def chunk(kind: bytes, body: bytes) -> bytes:
        return (struct.pack('>I', len(body)) + kind + body
                + struct.pack('>I', zlib.crc32(kind + body) & 0xFFFFFFFF))

    blob = b'\x89PNG\r\n\x1a\n'
    blob += chunk(b'IHDR', struct.pack('>IIBBBBB', img.width, img.height, 8, 6, 0, 0, 0))
    blob += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    blob += chunk(b'IEND', b'')
    Path(path).write_bytes(blob)
