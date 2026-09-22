# Screenshot recognition

Reads a screenshot of the game client and fills a build in from it: which
items are equipped, what they are refined to, which cards are in them, and
what the stat points are.

It runs in the browser, on the client, like the rest of the planner. There is
no OCR engine and no model — the client's UI is a fixed layout drawn at one
pixel per pixel, so every part of this is an exact comparison.

## Using it

"Read a screenshot" in the app, then paste (Ctrl+V) or drop a PNG. The
equipment window has two tabs and only one can be captured at a time, so
paste each in turn. Nothing is written to the build until you press Apply.

## How it works

**Items come from their icons, not their names.** The client blits the item's
icon into the slot unmodified, so the 24×24 cell is compared byte for byte
against all 3,298 icons from the crawl. A real match lands around 2 levels of
average error per channel and the next candidate is around 45, so there is no
threshold to tune.

**Names decide between items that share an icon.** Half the database does:
all 55 shadow armours in the game are drawn identically, as are the costume
and non-costume versions of most headgear. So the icon gives a candidate
group and the name picks within it — a much easier problem than reading a
name cold, which matters because the window mangles them:

```
+6 Piercing Elu      a +6 Venus Cape with a Skeleton Worker card
sive Venus...        and a Maiden card in it
```

Wrapped mid-word, cut off with an ellipsis, prefixed by the refine level and
by one word per compounded card. The refine prefix is parsed off, the rest is
aligned against each candidate's name allowing errors at both ends, and the
words left over are looked up in `card_affix` — which is how cards come back
out.

**Text is read by exact template matching.** The font has no antialiasing:
every pixel of every character is pure black and nothing else in a window is.
So a character either matches a stored bitmap or it does not, and one that
does not comes back as `?` rather than as a guess. A wildcard costs the name
matching nothing; a confidently wrong letter costs it the item.

**Windows are found by the shape of their title.** Each layout stores which
pixels of its title and the rule beneath it the client draws black — the
shape, not the colours, because the background is a skin that tiles to the
window's width and can be made see-through. Finding that shape says both
where the window is and which window it is, so a full-screen capture works as
well as a cropped one, and several windows in one shot are all read at once.

If nothing matches, the failure says why: a capture with no pure black left
in it has been rescaled or JPEG'd, whereas titles that read fine but match
nothing mean the client's skin or font differs from the samples.

## Item tooltips and random rolls

An item's random rolls are not in the crawled data — they are what one copy
happened to drop with — so a screenshot of its tooltip is the only place they
exist. There are two ways in:

- **The camera button on the slot**, next to the button that clears it. It
  appears only where the piece in that slot can actually roll. This is the
  better way round: the slot is known, so nothing has to be worked out from
  the picture about which item it is or where it is worn.
- **"Read a screenshot"**, which takes a tooltip like any other window and
  attaches the rolls to whichever slot already holds that item — so the
  equipment window has to go in first.

That window is found differently from the others. Its title is the item's
name, so there is no fixed shape to anchor on; what it does have is the strip
of bordered boxes underneath, one per roll and one more for the card sockets,
all the same height and evenly spaced in a colour used nowhere else. The last
box is always the sockets — the client draws them even for an item with none
— so everything above it with writing in it is a roll.

The words are then matched against the roll tables in `crawler/rolls.json`.
The client's wording and the table's labels differ ("Movement Speed" against
"Move Speed"), so an option carries a `reads` list of wordings actually seen
in a screenshot, and anything else is matched approximately against the
label. A line that fits two options equally well is reported as such rather
than guessed at: the client writes "Leech Rate/Leech Power" without saying
whether it is the HP or the SP one.

The numbers are never in doubt — digits read exactly — so only the wording is
ever uncertain.

## Rebuilding the assets

All three are generated, and all three are checked in so the app works
without running anything:

```
python tools/build_icon_atlas.py    # icons.png + icons.json, from images/icons
python tools/build_font.py bake     # font.json, from samples + transcripts
python tools/build_layout.py        # layout.json, window geometry and anchors
```

Re-run `build_icon_atlas.py` after any crawl that adds items. The other two
only change if the client's UI does.

## Known limits

**An item the crawl does not have cannot be recognised.** The sample
screenshot has a blue Valkyrie Circlet whose icon is not in the database —
the database's Valkyrie Circlet is a different colour, so it is presumably a
variant that was missed or has since been added. Rows like this are reported
as unmatched rather than guessed at.

**The font table is incomplete.** It covers the digits and most lowercase
letters, but only some capitals — a capital only enters the table if it
appears in a sample line that can be aligned against its transcript. Missing
ones read as `?`, which the name matching absorbs. To improve it, add a
screenshot to `samples/`, add its regions and transcripts to
`tools/build_font.py`, and re-bake; the builder reports how many of the
sample lines it can read back exactly.

**Kerned pairs read as wildcards.** Where two characters overlap rather than
merely touch — the "Da" of "Damage" — neither matches its template exactly
and both come back as `?`. The matching absorbs it, because a roll line is
only ever matched against a short list of known options.

**Capital I and lowercase l are the same bitmap**, so the font cannot tell
them apart and never will. Name matching folds them together.

**PNG only, at the game's own resolution.** JPEG turns a black pixel into a
cloud of nearly-black ones and a scaled capture matches nothing. This is also
why the icon comparison can afford to be exact.

**The compact HP/SP bar is not read.** `samples/status-bar.png` is kept as a
sample but has no title bar, so there is no chrome to anchor on and it would
need a different way of being located. It carries nothing the Basic
Information window does not.

**Which hand is which comes from the column.** The equipment window is laid
out as the character faces you, so its left column is the character's right
hand — the main hand — and its right column is the off hand. When dual
wielding, both weapons fit both slots, and that column is the only thing
that says which way round they go.

## Files

```
recognition/
  icons.png / icons.json   the icon library, packed into one atlas
  font.json                glyph bitmaps -> characters
  layout.json              where things sit in each window, and the anchors
  samples/                 real client captures; fixtures for the tests
                           and the source the font table is learned from
web/src/recognition/
  assets.ts    loading the above
  windows.ts   finding a window in a screenshot
  icons.ts     icon -> candidate items
  text.ts      pixels -> string
  names.ts     string -> item, refine and cards
  read.ts      one window -> a reading
  apply.ts     readings -> a build
```

Tested end to end against the sample screenshots in
`web/test/recognition.test.ts` — `npm test` in `web/`.
