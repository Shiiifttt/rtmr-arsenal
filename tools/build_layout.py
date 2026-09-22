#!/usr/bin/env python3
"""
Describe where things sit in each game window, and how to find the window.

The client's windows are fixed layouts: the equipment panel always puts its
five rows 26 pixels apart, the status panel always puts Str at the same
offset. So nothing here has to be detected -- but it is all relative to the
window, which the player can drag anywhere, and screenshots may be of the
whole screen or of one window someone has already cropped.

So each window carries an anchor: the shape of its own title, stored as a
mask of which pixels the client draws black. Finding that shape in a
screenshot gives the offset to add to every other coordinate, and doubles as
the test of which window a screenshot is of. A shape rather than a picture,
because the background behind the title is a skin that tiles to the window's
width and that the player can make see-through -- the lettering and the rule
under it are the only part that is the same in every capture.

    python tools/build_layout.py

Writes recognition/layout.json.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pngio  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / 'recognition' / 'samples'
OUT = ROOT / 'recognition' / 'layout.json'

# Every rectangle below is in the coordinates of the named sample, and gets
# shifted by wherever the anchor turns out to be.
WINDOWS = [
    {
        'id': 'equipment',
        'title': 'Equipment',
        'sample': 'equipment-primary',
        'tabs': {
            # The active tab has no bottom edge: it runs into the panel below
            # it. Sampling that one row under each tab says which is open.
            'probeY': 37,
            'items': [
                {'key': 'primary', 'x': 40},
                {'key': 'secondary', 'x': 110},
                {'key': 'title', 'x': 182},
            ],
        },
        'slots': {
            'rows': 5,
            'firstY': 41,
            'pitch': 26,
            'iconSize': 24,
            'columns': [
                {'side': 'left', 'iconX': 10, 'textX': 30, 'textW': 87},
                # Starts past the divider at 173: the character sprite in the
                # middle panel has black outlines, which read as text.
                {'side': 'right', 'iconX': 255, 'textX': 177, 'textW': 76},
            ],
        },
    },
    {
        'id': 'status',
        'title': 'Status',
        'sample': 'status',
        'stats': {
            # Str, Agi, Vit, Int, Dex, Luk, top to bottom. The bands are cut
            # generously and the reader trims them to the ink: the two columns
            # do not sit at quite the same height, and a row of a glyph lost to
            # a tight crop stops it matching its template at all.
            'firstY': 27,
            'pitch': 16,
            'height': 12,
            'valueX': 37, 'valueW': 39,
            'costX': 89, 'costW': 14,
        },
        # Read by position rather than by looking for labels: the labels are
        # drawn in maroon, and only the values are black.
        'derived': {
            'firstY': 27,
            'pitch': 16,
            'height': 12,
            'left': {'x': 105, 'w': 88, 'keys': ['atk', 'matk', 'hit', 'critical']},
            'right': {'x': 193, 'w': 89,
                      'keys': ['def', 'mdef', 'flee', 'aspd', 'statusPoint']},
        },
    },
    {
        'id': 'basic-info',
        'title': 'Basic Information',
        'sample': 'basic-info',
        # Levels are read by pattern rather than position, because this
        # window stacks its rows differently depending on what it is showing.
        'body': [0, 20, 221, 128],
    },
]


def is_black(img: pngio.Image, x: int, y: int) -> bool:
    i = (y * img.width + x) * 4
    return (img.data[i] <= 8 and img.data[i + 1] <= 8
            and img.data[i + 2] <= 8 and img.data[i + 3] > 128)


def title_box(img: pngio.Image, limit: int = 26) -> list[int]:
    """The window's title, plus the rule drawn under it.

    Stored as a shape rather than as a picture. An earlier version of this
    kept a strip of the title bar verbatim, which meant it also kept a
    hundred pixels of background -- and that background is the part most
    likely to differ between one capture and the next, whether because the
    window is a different width, because the skin tiles differently, or
    because the UI is set to be see-through. The title lettering and the rule
    under it are pure black in every window, so matching those and ignoring
    the colour of everything else pins the window down without depending on
    any of that.
    """
    ink = [[x for x in range(img.width) if is_black(img, x, y)]
           for y in range(min(limit, img.height))]

    # The rule spans the window, so it is the one line most of whose pixels
    # are black. Find it first and work upwards from there: a screenshot
    # cropped a little loosely has a sliver of the game world above the
    # window, and picking the topmost ink instead would take that.
    rule = next((y for y, xs in enumerate(ink) if len(xs) > img.width * 0.5), None)
    if rule is None:
        raise ValueError('no rule under a title in the top rows')

    # The rule does not always sit directly under the lettering, so step over
    # a couple of blank rows before following the text up.
    bottom = rule
    while bottom > 0 and not ink[bottom - 1] and rule - bottom < 4:
        bottom -= 1
    top = bottom
    while top > 0 and ink[top - 1]:
        top -= 1
    xs = [x for y in range(top, bottom) for x in ink[y]]
    if not xs:
        raise ValueError('no title lettering above the rule')

    x0 = max(0, min(xs) - 2)
    y0 = max(0, top - 2)
    x1 = min(img.width - 1, max(xs) + 2)
    y1 = min(img.height - 1, rule + 2)
    return [x0, y0, x1 - x0 + 1, y1 - y0 + 1]


def encode(img: pngio.Image, box: list[int]) -> dict:
    """The anchor as a mask: 1 where the window draws black, 0 where it does not."""
    x, y, w, h = box
    mask = bytearray(
        1 if is_black(img, x + col, y + row) else 0
        for row in range(h) for col in range(w)
    )
    return {
        'x': x, 'y': y, 'w': w, 'h': h,
        'ink': base64.b64encode(bytes(mask)).decode('ascii'),
    }


def occurrences(img: pngio.Image, box: list[int]) -> int:
    """How many places in the sample the anchor matches, which should be one."""
    x0, y0, w, h = box
    want = [[is_black(img, x0 + col, y0 + row) for col in range(w)] for row in range(h)]
    found = 0
    for y in range(img.height - h + 1):
        for x in range(img.width - w + 1):
            for row in range(h):
                for col in range(w):
                    if is_black(img, x + col, y + row) != want[row][col]:
                        break
                else:
                    continue
                break
            else:
                found += 1
    return found


def main() -> int:
    out = []
    for window in WINDOWS:
        img = pngio.read_png(SAMPLES / f'{window["sample"]}.png')
        box = title_box(img)
        hits = occurrences(img, box)
        if hits != 1:
            print(f'{window["id"]}: anchor matches {hits} places in its own '
                  f'sample', file=sys.stderr)
            return 1
        entry = {k: v for k, v in window.items() if k != 'sample'}
        entry['anchor'] = encode(img, box)
        out.append(entry)
        print(f'{window["id"]}: anchor {box}, unique')

    OUT.write_text(json.dumps({'windows': out}), encoding='utf-8')
    print(f'{OUT.relative_to(ROOT)}: {OUT.stat().st_size // 1024} KB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
