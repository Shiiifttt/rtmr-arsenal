#!/usr/bin/env python3
"""
Build the glyph templates the recogniser reads game text with.

The client draws text as an unantialiased bitmap font: every pixel of a
character is pure black and nothing else in the UI is. That makes reading it
a lookup rather than an inference problem -- compare each shape against a
table of known ones. No OCR engine, and no confidence threshold to tune,
because a shape either matches a template exactly or it does not.

The table is learned from the screenshots in recognition/samples together
with the transcripts below. Splitting a line on its blank columns does not
work on its own: this font kerns, so a pair like "rc" can share a column and
come back as one shape, while a few characters arrive as two. So the builder
aligns each line against its transcript instead, allowing a character to
occupy any width, and learns the shapes that fall out of the alignment. That
bootstraps from the characters it already knows, which is why it runs to a
fixed point rather than in one pass.

    python tools/build_font.py extract    # segment and report
    python tools/build_font.py bake       # write recognition/font.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pngio  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / 'recognition' / 'samples'
OUT_DIR = ROOT / 'recognition'

# Regions worth segmenting, per sample: (x, y, w, h).
#
# These deliberately avoid the character sprite in the equipment window,
# which is the one part of the UI that also contains pure black pixels.
REGIONS: dict[str, list[tuple[int, int, int, int]]] = {
    'equipment-primary': [
        (30, 40, 87, 130),    # left column item names
        (175, 40, 78, 130),   # right column item names
    ],
    'equipment-secondary': [
        (28, 39, 87, 130),
        (173, 39, 78, 130),
    ],
    'status': [
        (37, 28, 39, 96),     # the six stat boxes: base and gear bonus
        (89, 28, 14, 96),     # what the next point of that stat costs
        (105, 28, 88, 96),    # left derived column
        (193, 28, 89, 96),    # right derived column
    ],
    'basic-info': [
        (0, 20, 221, 126),
    ],
    # The roll boxes under an item tooltip. Cut to each sample's own boxes
    # rather than to one generous band: the tooltips are different heights,
    # and a band loose enough for all of them would take in the description
    # text of the shorter ones.
    'tooltip-garment': [(13, 339, 258, 79)],
    'tooltip-armor': [(12, 338, 258, 79)],
    'tooltip-shoes': [(11, 339, 258, 79)],
    'tooltip-accessory': [(10, 397, 258, 21)],
}

# What each line reads, in top-to-bottom, left-to-right order per region.
# Lines the builder cannot align against its transcript are reported and
# skipped, so an approximate entry costs coverage but never correctness.
TRANSCRIPTS: dict[str, list[str]] = {
    'equipment-primary': [
        '+6 Valkyrie Circ', 'let',
        'Strength Break', 'Miracle Bl...',
        '+8 Prime Laeva', 'teinn',
        '+6 Piercing Elu', 'sive Venus...',
        'Megingjard',
        'Slicer Evil Wing', 'Ears',
        'Elusive White K', 'night Armor',
        '+7 Flesh Eater', 'Vorpal Dagger',
        '+6 Elusive Tem', 'poral STR ...',
        'Heavy Hand St', 'ormwalker ...',
    ],
    'equipment-secondary': [
        'Ingwaz Rune o', 'f Plenty',
        'Agility Manual X',
        'Costume Opera', 'Phantom ...',
        'Fallen Civilizatio', 'n Armor',
        'Fallen Civilizatio', 'n Gloves',
        'Fallen Civilizatio', 'n Shoes',
        'Fallen Civilizatio', 'n Pendant',
    ],
    'status': [
        '99+36', '99+22', '49+8', '42+9', '49+10', '1 +9',
        '0', '0', '2', '1', '2', '1',
        # Left derived column, then right. The Status Point value sits in the
        # right-hand column even though its label spans both.
        '198 + 118', '133 + 80', '452', '6',
        '214 + 99', '132 + 20', '495 + 29', '172', '1',
    ],
    'basic-info': [
        'Simon', 'Satsujin',
        'HP 13753 / 13753 100%',
        'SP 2152 / 2152 100%',
        'Base Lv. 132', 'Job Lv. 60',
    ],
    'tooltip-garment': [
        'AGI +2', 'Perfect Dodge +1', 'Leech Rate +16%/Leech Power 2%',
    ],
    'tooltip-armor': [
        'AGI +2', 'Max HP +3%', 'Physical Damage Received -1%',
    ],
    'tooltip-shoes': [
        'AGI +1', 'Movement Speed +9%', 'Variable Cast Time -10%',
    ],
    'tooltip-accessory': ['AGI +1'],
}

# Characters this font draws identically. Capital I and lowercase l are the
# same bare vertical bar, so the table cannot hold both and the transcripts
# are folded onto one of them before anything is learned. Readers fold their
# side the same way before matching what comes back against known words.
CONFUSABLE = {'I': 'l'}


def canonical(text: str) -> str:
    return ''.join(CONFUSABLE.get(c, c) for c in text)

# No character is anywhere near this wide. Anything that is, is a bar or a
# rule rather than text.
MAX_GLYPH_WIDTH = 20

# Only item names train the space threshold. The numeric fields pad around
# their '+' by an amount that has nothing to do with word spacing, and it
# does not matter there anyway -- nothing downstream of a stat box cares
# where the spaces were.
SPACE_TRAINING = {'equipment-primary', 'equipment-secondary'}

Shape = tuple[str, ...]


# --------------------------------------------------------------------------
# Segmentation


def is_black(img: pngio.Image, x: int, y: int) -> bool:
    i = (y * img.width + x) * 4
    d = img.data
    return d[i] == 0 and d[i + 1] == 0 and d[i + 2] == 0 and d[i + 3] == 255


def find_lines(img: pngio.Image, box: tuple[int, int, int, int]) -> list[tuple[int, int]]:
    """Rows of the region holding ink, grouped into (top, bottom) bands."""
    x, y, w, h = box
    h = min(h, img.height - y)
    w = min(w, img.width - x)
    filled = [any(is_black(img, px, py) for px in range(x, x + w))
              for py in range(y, y + h)]
    out, start = [], None
    for i, on in enumerate(filled):
        if on and start is None:
            start = i
        elif not on and start is not None:
            out.append((y + start, y + i))
            start = None
    if start is not None:
        out.append((y + start, y + h))
    return out


def to_columns(img: pngio.Image, box: tuple[int, int, int, int],
               line: tuple[int, int]) -> list[str]:
    """A line as one string per column, top to bottom."""
    x, _, w, _ = box
    w = min(w, img.width - x)
    top, bottom = line
    return [''.join('#' if is_black(img, px, py) else '.' for py in range(top, bottom))
            for px in range(x, x + w)]


def ink_runs(columns: list[str]) -> list[tuple[int, int]]:
    """Spans of consecutive non-blank columns."""
    out, start = [], None
    for i, col in enumerate(columns):
        if '#' in col and start is None:
            start = i
        elif '#' not in col and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(columns)))
    return [r for r in out if r[1] - r[0] <= MAX_GLYPH_WIDTH]


def sample_lines(name: str) -> list[list[str]]:
    """Every text line of a sample, as column bitmaps, in transcript order."""
    img = pngio.read_png(SAMPLES / f'{name}.png')
    out = []
    for box in REGIONS[name]:
        for line in find_lines(img, box):
            columns = to_columns(img, box, line)
            runs = ink_runs(columns)
            if not runs:
                continue
            # Trim to the ink, keeping interior gaps as they are.
            out.append(columns[runs[0][0]:runs[-1][1]])
    return out


def shape_of(columns: list[str], x: int, width: int) -> Shape:
    """The ink in a span, as rows, trimmed to the rows that have any.

    The row band a line occupies depends on which characters happen to be in
    it -- one with no descender sits shorter -- so trimming is what makes the
    same character key the same way wherever it appears.
    """
    height = len(columns[0])
    rows = [''.join(columns[x + i][y] for i in range(width)) for y in range(height)]
    ink = [i for i, r in enumerate(rows) if '#' in r]
    return tuple(rows[ink[0]:ink[-1] + 1]) if ink else ()


# --------------------------------------------------------------------------
# Matching


def fits(columns: list[str], x: int, shape: Shape, exact: bool = True) -> bool:
    """Does this template sit at column x, at some vertical offset?

    The template's box has to match exactly -- every pixel, including the
    blank ones. Nothing less will do: '6' and 'B' are the same bitmap apart
    from their outermost columns, as are 'c' and 'o', so a template allowed
    to ignore any part of its box stops telling them apart.

    Characters that merely touch need no allowance: they have no blank column
    between them and so segment as one run, but each still owns its own
    columns, which is all this compares. Ones that genuinely overlap -- "Fa",
    where the a tucks under the crossbar -- do, and that is what `exact=False`
    is for. It only asks that the template's ink be present, so callers try it
    strictly across every template first and fall back to this afterwards.
    """
    width = len(shape[0])
    height = len(columns[0])
    if x + width > len(columns) or len(shape) > height:
        return False

    for dy in range(height - len(shape) + 1):
        for cx in range(width):
            column = columns[x + cx]
            for ry in range(height):
                ink = shape[ry - dy][cx] == '#' if 0 <= ry - dy < len(shape) else False
                if ink and column[ry] != '#':
                    break
                if exact and not ink and column[ry] == '#':
                    break
            else:
                continue
            break
        else:
            return True
    return False


def ordered(table: dict[Shape, str]) -> list[tuple[Shape, str]]:
    """Templates widest first, so a fragment never matches before the whole."""
    return sorted(table.items(), key=lambda kv: (-len(kv[0][0]), -len(kv[0]), kv[1]))


def read(columns: list[str], table: dict[Shape, str], space: int) -> str:
    """Read a line with the same greedy scan the browser uses.

    Only exact matches count. A character the table does not have comes back
    as a single '?' rather than as whatever combination of narrower shapes
    happens to fit inside it: the caller matches these strings against a
    known list of item names, and a wildcard costs it nothing while a
    confidently wrong letter costs it the item.
    """
    templates = ordered(table)
    out: list[str] = []
    x, end = 0, 0
    while x < len(columns):
        if '#' not in columns[x]:
            x += 1
            continue
        if out and x - end >= space:
            out.append(' ')
        hit = match(columns, x, templates)
        if hit is None:
            if not out or out[-1] != '?':
                out.append('?')
            x += 1
        else:
            char, width = hit
            out.append(char)
            x += width
        end = x
    return ''.join(out)


def match(columns: list[str], x: int, templates: list[tuple[Shape, str]]
          ) -> tuple[str, int] | None:
    """The widest template that sits at column x."""
    for shape, char in templates:
        if fits(columns, x, shape):
            return char, len(shape[0])
    return None


# --------------------------------------------------------------------------
# Learning


def align(columns: list[str], chars: str,
          by_char: dict[str, list[Shape]]) -> list[tuple[str, int, int]] | None:
    """Place every character of the transcript somewhere along the line.

    A character whose shape is already known can only go where that shape
    fits. One that is not yet known may take any width, so long as its span
    starts and ends on ink -- a few characters are drawn as two strokes with
    a blank column between them, so the span may contain a gap but cannot
    begin or end with one. The rest of the line still has to work out, which
    is what pins the width down. Returns (character, column, width) each.
    """
    limit = len(columns)
    memo: dict[tuple[int, int], list[tuple[str, int, int]] | None] = {}

    def advance(x: int) -> int:
        while x < limit and '#' not in columns[x]:
            x += 1
        return x

    def go(i: int, x: int) -> list[tuple[str, int, int]] | None:
        x = advance(x)
        if i == len(chars):
            return [] if x >= limit else None
        if x >= limit:
            return None
        key = (i, x)
        if key in memo:
            return memo[key]
        memo[key] = None  # a width is always at least 1, so this cannot cycle

        known = by_char.get(chars[i])
        if known:
            widths = sorted({len(s[0]) for s in known if fits(columns, x, s)}
                            or {len(s[0]) for s in known if fits(columns, x, s, False)},
                            reverse=True)
        else:
            widths = [w for w in range(min(MAX_GLYPH_WIDTH, limit - x), 0, -1)
                      if '#' in columns[x + w - 1]]

        for width in widths:
            rest = go(i + 1, x + width)
            if rest is not None:
                memo[key] = [(chars[i], x, width)] + rest
                return memo[key]
        return None

    return go(0, 0)


def bootstrap(lines: list[tuple[str, int, str, list[str]]]) -> dict[Shape, str]:
    """Seed the table from lines that segment into exactly one run per character.

    Nothing is known yet at this point, so the alignment has no purchase --
    every width would be as good as every other. These lines are the ones
    where blank columns alone give the answer. Shortest first, because a
    short line has the least room for a kerned pair and a split character to
    cancel out and leave the count looking right; longer ones are then only
    admitted if they agree with what the short ones established.
    """
    table: dict[Shape, str] = {}
    for name, index, text, columns in sorted(lines, key=lambda l: len(l[2])):
        chars = canonical(text.replace(' ', ''))
        runs = ink_runs(columns)
        if len(runs) != len(chars):
            continue

        found = {}
        for char, (start, end) in zip(chars, runs):
            shape = shape_of(columns, start, end - start)
            if not shape:
                continue
            seen = table.get(shape, found.get(shape))
            if seen is not None and seen != char:
                found = None
                break
            found[shape] = char
        if found:
            table.update(found)
    return table


def learn(lines: list[tuple[str, int, str, list[str]]]) -> dict[Shape, str]:
    """Extend the seed table by alignment until it stops finding new shapes.

    A shape is only taken from a span with blank columns on both sides. A
    character that touches its neighbour still gets placed -- the alignment
    needs it to get past -- but those pixels belong to two characters, so
    they are no use as a template.
    """
    table = bootstrap(lines)
    by_char: dict[str, list[Shape]] = {}
    for shape, char in table.items():
        by_char.setdefault(char, []).append(shape)

    for _ in range(8):
        learned = 0
        for name, index, text, columns in lines:
            placements = align(columns, canonical(text.replace(' ', '')), by_char)
            if placements is None:
                continue
            for char, x, width in placements:
                before = x == 0 or '#' not in columns[x - 1]
                after = x + width >= len(columns) or '#' not in columns[x + width]
                if not (before and after):
                    continue
                shape = shape_of(columns, x, width)
                if not shape or table.get(shape) == char:
                    continue
                if shape in table:
                    print(f'  {name}:{index} reads a {table[shape]!r} shape as '
                          f'{char!r}', file=sys.stderr)
                    continue
                table[shape] = char
                by_char.setdefault(char, []).append(shape)
                learned += 1
        if not learned:
            break
    return table


def space_threshold(lines: list[tuple[str, int, str, list[str]]],
                    by_char: dict[str, list[Shape]]) -> int:
    """The gap width that separates words rather than characters."""
    word: list[int] = []
    between: list[int] = []
    for name, _, text, columns in lines:
        if name not in SPACE_TRAINING:
            continue
        placements = align(columns, canonical(text.replace(' ', '')), by_char)
        if placements is None:
            continue
        spaced = set()
        seen = 0
        for char in text[1:]:
            if char == ' ':
                spaced.add(seen)
            else:
                seen += 1
        for i in range(1, len(placements)):
            _, x, _ = placements[i]
            _, px, pw = placements[i - 1]
            (between if i - 1 in spaced else word).append(x - px - pw)

    widest = max(word, default=0)
    narrowest = min(between, default=widest + 2)
    if narrowest <= widest:
        print(f'warning: character gaps reach {widest} but word gaps start at '
              f'{narrowest}; spacing cannot be read reliably', file=sys.stderr)
        return widest + 1
    return (widest + narrowest + 1) // 2


# --------------------------------------------------------------------------


def collect() -> list[tuple[str, int, str, list[str]]]:
    """Every transcribed line as (sample, index, text, columns)."""
    out = []
    for name in REGIONS:
        lines = sample_lines(name)
        expected = TRANSCRIPTS.get(name, [])
        if len(lines) != len(expected):
            print(f'{name}: {len(lines)} lines found, {len(expected)} transcribed',
                  file=sys.stderr)
        for i, columns in enumerate(lines):
            if i < len(expected):
                out.append((name, i, expected[i], columns))
    return out


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else 'extract'
    lines = collect()

    if mode == 'extract':
        for name, index, text, columns in lines:
            print(f'{name}:{index:<3} {len(ink_runs(columns)):2d} runs  {text!r}')
        return 0

    table = learn(lines)
    by_char: dict[str, list[Shape]] = {}
    for shape, char in table.items():
        by_char.setdefault(char, []).append(shape)
    space = space_threshold(lines, by_char)

    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / 'font.json').write_text(json.dumps({
        'space': space,
        'glyphs': [{'c': char, 'rows': list(shape)} for shape, char in ordered(table)],
    }, indent=0), encoding='utf-8')

    chars = sorted({c for c in table.values()})
    print(f'{len(table)} shapes covering {len(chars)} characters, space gap >= {space}')
    print('covered:', ''.join(chars))

    wrong = 0
    for name, index, text, columns in lines:
        got = read(columns, table, space)
        if got != canonical(text):
            wrong += 1
            print(f'  {name}:{index}  want {text!r}  got {got!r}')
    print(f'read back {len(lines) - wrong}/{len(lines)} sample lines exactly')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
