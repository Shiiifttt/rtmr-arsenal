# RTM Arsenal — data crawler

Pulls the [RTM: Refuge Database](https://rtm-database.pages.dev) into a local
dataset for the arsenal tracker (and, later, the damage simulator).

Crawled with the site owner's permission. Requests are rate-limited globally
and the whole thing is resumable, so a re-run costs almost nothing.

## Running it

Needs Python 3.9+. No dependencies.

```
python crawler/rtm_crawl.py                 # full crawl
python crawler/rtm_crawl.py --skip-images   # metadata only (6 requests, ~5s)
python crawler/rtm_crawl.py --skip-data     # re-decode + fetch missing images
python crawler/rtm_crawl.py --force         # re-download images already on disk
python crawler/rtm_crawl.py --rps 3         # be even gentler
```

Images already on disk are skipped, so an interrupted run resumes where it
stopped. `--force` is the only way to re-fetch a picture you already have.

## Why it isn't a page scraper

The site is static. The entire database ships as six JSON files under
`assets/data/`, and the page you see is those files decoded in the browser.
That means:

- **6 requests** for all 4,036 items and 743 monsters, instead of 4,779 page hits.
- **Nothing is truncated.** The `desc` field in the bulk file is the same full
  text the detail sidebar shows — the list view truncates in CSS, not in data.
  There is no `?id=` lookup worth making.

The only real traffic is the icons: ~7,100 small PNGs, fetched once.

## Layout

```
data/
  meta.json               crawl timestamp, counts, request tally
  lookups.json            the shared string tables (slots, jobs, zones, ...)
                          — use these to build filter dropdowns
  stats.json              canonical stat registry (128 stats) — see below
  parse-report.json       parser coverage and everything it could not read
  raw/                    the six payloads, verbatim, for re-decoding offline
  items/
    all.json              all 4,036 items
    by-kind/*.json        same records split by kind (weapon.json, card.json, ...)
    bonuses.json          parsed bonuses only, keyed by item id
  sets/
    all.json              252 equipment sets
  mobs/
    all.json              743 monsters, with drop tables
images/
  icons/{id}.png          48x48 inventory icon
  art/{id}.png            full illustration
  art/card.png            shared card back, for cards with no art of their own
```

`kind` is the site's own top-level grouping and matches its `?kind=` parameter:

| Weapon | Card | Class gear | Material | Armor | Relic | Shadow gear |
|---|---|---|---|---|---|---|
| **Accessory** | **Ammunition** | **Headgear** | **Usable** | **Shield** | **Costume** | **Other** |

## Item record

```jsonc
{
  "id": 4140,
  "name": "Abysmal Knight Card",
  "kind": "Card",                  // top-level grouping, = ?kind=
  "type": "Card",                  // the badge the site shows
  "category": "Card",              // finer filter bucket
  "equip_slots": ["Weapon"],       // for a card, what it compounds into
  "description": "DMG vs Bosses+10%",

  "required_level": 0, "weight": 1,
  "atk": 0, "matk": 0, "def": 0, "mdef": 0,
  "card_slots": 0,                 // slots on the gear itself
  "refineable": false,
  "weapon_level": null, "element": null, "usable_by": null,

  "images": { "icon": null, "art": "images/art/4140.png" },

  "drops": [{ "mob_id": 1219, "mob": "Abysmal Knight", "mob_level": 93,
              "zone": "Inside Glastheim Chivalry",
              "chance_percent": 1, "mvp_reward": false }],
  "containers": [],                // boxes/coffers it comes out of
  "on_cast": [],                   // auto-cast effects
  "card_affix": { "word": "Abyss", "position": "prefix" },
  "summons": null,
  "trade_restrictions": [],        // nodrop / notrade / nosell / ...
  "patch_notes": [],
  "freshness": null,               // "new" | "reworked" | null
  "source_url": "https://rtm-database.pages.dev/?kind=Card&id=4140"
}
```

Image paths are relative to the project root, and are `null` when no picture
exists. A few hundred items have no icon at all.

### The `raw` block

Quest and acquisition metadata (`how`, `hatred`) whose encoding I only partly
pinned down is preserved verbatim under `raw` rather than dropped, so it can be
decoded later without re-crawling. `raw.icon_bits` is the site's own bitfield:
`1` = has an icon, `2` = has art.

## Parsed bonuses

The server keeps an item's mechanics as the tooltip a player reads, so refine
scaling and set bonuses are prose. `parse_bonuses.py` turns that into data and
writes the result back into the item records. It runs automatically at the end
of every crawl (`--skip-parse` to suppress it), and can be run on its own:

```
python crawler/parse_bonuses.py
```

### The three refine axes, kept apart

This is the part most worth trusting, and the part easiest to get wrong. The
tooltips use near-identical wording for numbers that mean different things:

| Wording | Means | Lives in |
|---|---|---|
| `Per Refine:`, `Per 4 Refines:` | this item's refine | `item.refine.per_refine` |
| `If Refine +10:`, `Refine 7 or higher:` | this item's refine | `item.refine.thresholds` |
| `Per total set refine:` | **summed** refine of the whole set | `set.set_refine.per_set_refine` |
| `Set refine 18+:` | **summed** refine of the whole set | `set.set_refine.thresholds` |
| `per 10 base STR` | a base stat, not refine at all | `effect.per_base_stat` |

Set scaling is stored **only on the set record** and item scaling **only on the
item**, never both. A bare "per 2 refines" written underneath a set heading is
re-labelled as set refine, because that is what it means there. Two assertions
in the report keep it honest — both currently zero.

### Stat ids

Every parsed effect resolves onto `data/stats.json` so equipment can be summed
without re-reading text. `stat_ids` is a **list**, because one phrase is often
several stats:

```jsonc
{ "text": "All Stats +2", "stat": "All Stats", "value": 2, "unit": null,
  "stat_ids": [0,1,2,3,4,5], "stat_keys": ["str","agi","vit","int","dex","luk"] }
```

Three things to know when you add these up:

- **`unit` decides how it stacks.** `"DEF +50"` (`unit: null`) is flat;
  `"Total DEF +10%"` (`unit: "%"`, `scope: "total"`) multiplies the total.
  Adding a percent into a flat pool is the classic way to get wrong numbers.
- **Skill modifiers have no stat id.** `"Dragon Thrust DMG +20%"` modifies one
  skill, so it resolves to `stat_ids: []` plus `skill` and `skill_metric`.
  Folding those into a global damage stat would inflate every calculation.
- **`stat_inherited: true`** means the stat name came from the line above
  ("Critical Rate +3" / "Extra +1 per refine").

### Sets

`item.sets` is a list of indices into `data/sets/all.json` — a list because the
Undershirt really does belong to two (Black Shirt and Pink Shirt). 829 items sit
in 252 sets. Membership is taken from the set each item names in its own
description, since the source has no set field.

### What it does not read

Coverage is `83.5%` of parsed effects mapped to a stat id, and it is uneven by
design:

| Good | Weak |
|---|---|
| Shield 86%, Armor 85%, Headgear 84% | Costume, Relic, Usable, Material ~0% |
| Weapon 76%, Shadow gear 73%, Card 79% | Ammunition 4% |

The weak kinds are genuinely prose — cosmetics, boss-summon relics, "Heals 25
Base HP" — not a parser blind spot. Everything unread keeps its original text,
and `parse-report.json` lists it, so nothing is lost and nothing is invented.
Read that file before trusting a number for a calculation.

`set_text_conflicts` (currently 7) are sets whose members disagree on the bonus
text. The majority wins and the disagreement is recorded rather than averaged.

## Hand corrections

`crawler/overrides.json` is maintained **by hand** and is not generated. It
exists because the tooltips are hard-wrapped prose: a heading can end up next
to the wrong block, and a phrase can be genuinely ambiguous about what it
governs. Rather than teaching the parser one-off special cases, the correction
is written where it survives a re-crawl and can be read and argued with.

```jsonc
"sets": {
  "aggressive-orphan": {
    "status": "unverified",         // or "verified", once checked in game
    "reason": "why the parsed reading is wrong",
    "set_refine_thresholds": [
      { "at": [9],  "effects": ["All Stats +4"] },
      { "at": [18], "effects": ["Damage against all races +10%", "Max HP/SP -10%"] }
    ]
  }
}
```

Effects are written as tooltip text and run through the same parser as the real
descriptions, so stat mapping stays identical — no hand-written stat ids.

Two properties worth relying on:

- **A key that matches nothing is reported as stale**, not ignored. If the
  upstream text changes shape, a correction that quietly stops applying would
  be worse than a loud failure.
- **`status` is carried into the dataset**, and the planner badges any set
  whose numbers are a correction. An `unverified` reading never passes as fact.

Also supported: `set_bonus` (replaces the full-set effects) and `set_refine_per`
(replaces per-set-refine scaling).

## Class equip rules

`crawler/class-rules.json` is the second hand-maintained file. It answers a
question the site's data cannot: **what a class may physically hold.**

The item payload carries one job sentence per item — `"Prowler"`, or `"All
except Bouncer, Judge, …"` — and that is the whole of the upstream restriction
data. It is right about most things and silent about the rest: no shield's
sentence excludes Satsujin by name, so on the sentence alone a Satsujin
qualifies for 36 Heavy Shields, 4 Colossal Shields and the general Armguards,
and for the handful of weapons that ship with no sentence at all.

```jsonc
"classes": {
  "Satsujin": {
    "status": "unverified",            // or "verified", once checked in game
    "reason": "dagger, and a one-handed shield in the off hand",
    "weapons":  ["Dagger"],            // the weapon hand, one- and two-handed
    "off_hand": ["Round Shield", "Square Shield", "Arm Shield", "Medium Shield", "Shield"]
    // "ammunition" is also accepted
  }
},
"items": {
  "Fox Armguard": {                    // fixes the sentence for one item
    "status": "unverified",
    "reason": "…",
    "usable_by": "Prowler"             // written in the site's own grammar
  }
}
```

A Colossal Shield sits in the two-handed weapon slot, so it is judged against
`weapons`, not `off_hand` — the slot decides, not the name.

Cards are exempt from all of this: any class can compound any card. A card
carries the slot it goes into, so a weapon card would otherwise be judged
against the types its class may hold and fail every one of them — a card's own
type is `Card`, never `Dagger`.

Three properties worth relying on:

- **A slot key left out leaves that slot unconstrained.** A class entry that
  names only `weapons` still shows every off-hand piece its sentence allows,
  and a class absent from the file behaves exactly as it did before this file
  existed. Filling it in one class at a time never hides gear nobody has
  checked.
- **Nothing here edits the item records.** The sentence stays as the crawl
  wrote it; corrections are resolved into `data/class-rules.json` and applied
  at read time, so withdrawing one takes no re-crawl.
- **Stale keys and unknown types are reported**, the same as for overrides. A
  class name, item name or item type that matches nothing is named on stderr
  rather than silently allowing nothing.

Known gaps in the upstream sentences, for whoever fills this in next:

- 8 weapons and 1 shield ship with no sentence (`Abomination's Scythe`,
  `Sigrsverd`, `Maladeilan`, the Hibiki/Kuji/Mugon/Marishiten/Hrafnsax daggers,
  `Veldismagn`), so every class qualifies for them.
- 38 Class gear pieces — the Manuals, Runes and Gems — have no sentence either,
  though `Pickpocket Manual` and the like are plainly class-specific.
- The 4 general Armguards (`Darkness`, `Fox`, `Moon`, `Wolf`) are the only
  Armguards whose sentence *excludes* Prowler; the other eleven are Prowler's.

## Re-crawling later

The server sends no `Last-Modified` on the JSON, so there is no cheap change
check — `--skip-images` refetches all six payloads in a few seconds and is the
practical way to pick up database updates. Icons only need fetching for items
whose art is new, which the resume logic handles on its own.
