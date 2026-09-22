#!/usr/bin/env python3
"""
Pack the crawled item icons into one atlas the browser can match against.

The recogniser identifies an equipped item by comparing the 24x24 cell in a
screenshot against every icon in the database. That needs all of them in
memory at once, and 3,300 separate PNG requests is not a sensible way to get
there -- one atlas is a single request, and `createImageBitmap` plus a canvas
gives back exactly the RGBA bytes the matcher wants.

Most icons are 24x24. A couple of hundred arrive from the database with their
transparent margins trimmed off, so sizes are stored per icon and the matcher
slides those few over the cell instead of assuming they are aligned.

    python tools/build_icon_atlas.py

Writes recognition/icons.png and recognition/icons.json.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pngio  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / 'images' / 'icons'
OUT_DIR = ROOT / 'recognition'

CELL = 26          # the largest icon is 26x26; every cell is square and padded
COLUMNS = 64
# An icon cannot be bigger than the slot it is drawn in. Anything larger is
# art that landed in the icon folder by mistake.
MAX_SIDE = 26


def main() -> int:
    if not ICON_DIR.is_dir():
        print(f'no icons at {ICON_DIR} -- run the crawler first', file=sys.stderr)
        return 1

    items = json.loads((ROOT / 'data' / 'items' / 'all.json').read_text(encoding='utf-8'))
    known = {item['id'] for item in items}

    entries, images, skipped = [], [], []
    for path in sorted(ICON_DIR.glob('*.png'), key=lambda p: int(p.stem) if p.stem.isdigit() else 0):
        if not path.stem.isdigit():
            continue
        item_id = int(path.stem)
        if item_id not in known:
            continue  # an icon left over from an older crawl

        img = pngio.read_png(path)
        if img.width > MAX_SIDE or img.height > MAX_SIDE:
            skipped.append((item_id, img.width, img.height))
            continue

        entries.append({'id': item_id, 'w': img.width, 'h': img.height})
        images.append(img)

    rows = (len(entries) + COLUMNS - 1) // COLUMNS
    atlas = pngio.Image(COLUMNS * CELL, rows * CELL)
    for index, img in enumerate(images):
        x = (index % COLUMNS) * CELL
        y = (index // COLUMNS) * CELL
        atlas.blit(img, x, y)

    OUT_DIR.mkdir(exist_ok=True)
    pngio.write_png(OUT_DIR / 'icons.png', atlas)
    (OUT_DIR / 'icons.json').write_text(json.dumps({
        'cell': CELL,
        'columns': COLUMNS,
        'count': len(entries),
        'entries': entries,
    }), encoding='utf-8')

    size = (OUT_DIR / 'icons.png').stat().st_size
    print(f'{len(entries)} icons -> {atlas.width}x{atlas.height} atlas, {size // 1024} KB')
    if skipped:
        print(f'skipped {len(skipped)} oversized: {skipped[:3]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
