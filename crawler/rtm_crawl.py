#!/usr/bin/env python3
"""
RTM: Refuge Database crawler.

The site at https://rtm-database.pages.dev is a static page: the whole
database ships as a handful of column-oriented JSON files and a folder of
PNGs. So this is not really a crawler in the scrape-every-page sense --
it takes the six data files in six requests and then fetches the icons.
No per-item page hits, which is both far kinder to the host and far more
complete: the `desc` field in the data file is the untruncated text the
detail sidebar shows, so there is nothing left to go back for.

Stages, each skippable:
  data    download the raw JSON payloads verbatim
  decode  expand the index-into-lookup-table encoding into readable records
  images  download item icons and card/equipment art

Everything is resumable. Images already on disk are skipped unless --force.

Stdlib only; no pip install.
"""

from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_rolls  # noqa: E402  (needs the path above)
import parse_bonuses  # noqa: E402  (needs the path above)

BASE = "https://rtm-database.pages.dev"

DATA_FILES = [
    "db-items.json",
    "db-mobs.json",
    "db-places.json",
    "db-skills.json",
    "codex.json",
    "skillnames.json",
]

# A card with no art of its own falls back to the shared card back.
CARD_ART_FALLBACK = "assets/icons/art/card.png"

USER_AGENT = (
    "RTMR-Arsenal-Crawler/1.0 (personal offline dataset build; "
    "crawled with the site owner's permission; stdlib urllib)"
)


# --------------------------------------------------------------------------
# polite fetching
# --------------------------------------------------------------------------


class Throttle:
    """One global minimum gap between request starts, shared by all workers.

    Concurrency alone is a bad throttle: four workers with no gap still
    burst. Gating the *start* of every request behind one lock means the
    request rate is a number the operator sets, whatever the worker count.
    """

    def __init__(self, rps: float):
        self._min_gap = 1.0 / rps if rps > 0 else 0.0
        self._lock = threading.Lock()
        self._next_at = 0.0

    def wait(self) -> None:
        if self._min_gap <= 0:
            return
        with self._lock:
            now = time.monotonic()
            if now < self._next_at:
                delay = self._next_at - now
            else:
                delay = 0.0
                self._next_at = now
            self._next_at += self._min_gap
        if delay > 0:
            time.sleep(delay)


class Fetcher:
    def __init__(self, throttle: Throttle, retries: int = 4, timeout: int = 30):
        self.throttle = throttle
        self.retries = retries
        self.timeout = timeout
        self.counts = {"ok": 0, "missing": 0, "failed": 0, "skipped": 0}
        self._lock = threading.Lock()

    def _bump(self, key: str) -> None:
        with self._lock:
            self.counts[key] += 1

    def get(self, path: str) -> bytes | None:
        """Fetch BASE/path. Returns None on a 404 (a legitimately absent icon)."""
        url = f"{BASE}/{path.lstrip('/')}"
        last_err: Exception | None = None

        for attempt in range(self.retries + 1):
            self.throttle.wait()
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT,
                "Accept": "*/*",
            })
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    body = resp.read()
                self._bump("ok")
                return body
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    self._bump("missing")
                    return None
                last_err = e
                # 429 and 5xx are the host asking for room. Give it room.
                if e.code == 429 or 500 <= e.code < 600:
                    retry_after = e.headers.get("Retry-After") if e.headers else None
                    wait = _parse_retry_after(retry_after)
                    if wait is None:
                        wait = (2 ** attempt) + random.uniform(0, 0.5)
                    if attempt < self.retries:
                        time.sleep(wait)
                        continue
                break
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last_err = e
                if attempt < self.retries:
                    time.sleep((2 ** attempt) + random.uniform(0, 0.5))
                    continue

        self._bump("failed")
        print(f"  ! failed: {path} ({last_err})", file=sys.stderr)
        return None


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


# --------------------------------------------------------------------------
# decoding
# --------------------------------------------------------------------------


def slugify(name: str) -> str:
    out = "".join(c.lower() if c.isalnum() else "-" for c in name)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-") or "unnamed"


def lookup(table: list, index) -> str | None:
    """Index into one of the payload's shared string tables, tolerantly.

    The tables are built by the site's exporter and the rows point into
    them; an out-of-range index means the export changed shape, and a
    crash three thousand rows in is a worse answer than a null.
    """
    if index is None or isinstance(index, bool):
        return None
    if not isinstance(index, int) or index < 0 or index >= len(table):
        return None
    value = table[index]
    return value if value not in ("", None) else None


def lookup_many(table: list, indices) -> list[str]:
    if not isinstance(indices, list):
        return []
    return [v for v in (lookup(table, i) for i in indices) if v]


def decode_items(payload: dict) -> list[dict]:
    cols = payload["cols"]
    C = {name: i for i, name in enumerate(cols)}

    cats = payload.get("cats", [])
    fams = payload.get("fams", [])
    grps = payload.get("grps", [])
    locs = payload.get("locs", [])
    jobs = payload.get("jobs", [])
    zones = payload.get("zones", [])
    mobs = payload.get("mobs", [])
    eles = payload.get("eles", [])
    locknames = payload.get("locknames", [])
    boxnames = payload.get("boxnames", [])
    castnames = payload.get("castnames", [])
    triggers = payload.get("triggers", [])

    freshness = {1: "new", 2: "reworked"}
    out: list[dict] = []

    for row in payload["rows"]:
        def col(name):
            idx = C.get(name)
            return row[idx] if idx is not None and idx < len(row) else None

        item_id = col("id")
        kind = lookup(grps, col("grp"))
        icon_bits = col("icon") or 0
        has_icon = bool(icon_bits & 1)
        has_art = bool(icon_bits & 2)
        is_card = kind == "Card"

        # Mirrors the site's own rule: art when the item has its own
        # drawing, the shared card back when a card does not, nothing at all
        # for the few hundred items with no picture either way.
        if has_art:
            art_path = f"images/art/{item_id}.png"
        elif is_card:
            art_path = "images/art/card.png"
        else:
            art_path = None

        drops = []
        for s in (col("src") or []):
            if not isinstance(s, list) or len(s) < 5:
                continue
            drops.append({
                "mob_id": s[0],
                "mob": lookup(mobs, s[1]),
                "mob_level": s[2],
                "zone": lookup(zones, s[3]),
                "chance_percent": s[4],
                "mvp_reward": bool(s[5]) if len(s) > 5 else False,
            })

        boxes = []
        for b in (col("box") or []):
            if not isinstance(b, list) or len(b) < 2:
                continue
            boxes.append({"container_id": b[0], "container": lookup(boxnames, b[1])})

        casts = []
        for c in (col("casts") or []):
            if not isinstance(c, list) or not c:
                continue
            casts.append({
                "skill": lookup(castnames, c[0]),
                "trigger": lookup(triggers, c[1]) if len(c) > 1 else None,
                "raw": c,
            })

        card_word = col("cardword")
        affix = None
        if isinstance(card_word, list) and card_word:
            affix = {
                "word": card_word[0],
                "position": "suffix" if (len(card_word) > 1 and card_word[1]) else "prefix",
            }

        boss_index = col("boss")
        summons = None
        if isinstance(boss_index, int) and boss_index >= 0:
            summons = {"mob": lookup(mobs, boss_index), "mob_id": col("bossid") or None}

        record = {
            "id": item_id,
            "name": col("name"),
            "kind": kind,
            "type": lookup(cats, col("cat")),
            "category": lookup(fams, col("fam")),
            "equip_slots": lookup_many(locs, col("loc")),
            "description": col("desc") or "",

            "required_level": col("lv") or 0,
            "weight": col("weight") or 0,
            "atk": col("atk") or 0,
            "matk": col("matk") or 0,
            "def": col("def") or 0,
            "mdef": col("mdef") or 0,
            "card_slots": col("slots") or 0,
            "refineable": bool(col("refine")),
            "weapon_level": col("wlv") or None,
            "element": lookup(eles, col("ele")),
            "usable_by": lookup(jobs, col("jobs")),

            "images": {
                "icon": f"images/icons/{item_id}.png" if has_icon else None,
                "art": art_path,
            },

            "drops": drops,
            "containers": boxes,
            "on_cast": casts,
            "card_affix": affix,
            "summons": summons,
            "trade_restrictions": lookup_many(locknames, col("locks")),
            "patch_notes": col("said") or [],
            "freshness": freshness.get(col("fresh")),
            "renamed_from": col("was") or None,

            "source_url": (
                f"{BASE}/?kind={(kind or '').replace(' ', '+')}&id={item_id}"
                if kind else f"{BASE}/?id={item_id}"
            ),

            # Fields whose encoding is only partly pinned down (quest and
            # acquisition metadata) are kept verbatim rather than dropped,
            # so a later pass can decode them without re-crawling.
            "raw": {
                "how": col("how"),
                "hatred": col("hatred"),
                "hatred_count": col("hatredn"),
                "icon_bits": icon_bits,
                "no_source": col("nosrc"),
                "source_mvp": col("srcmvp"),
                "source_normal": col("srcnorm"),
            },
        }
        out.append(record)

    return out


def decode_mobs(payload: dict) -> list[dict]:
    cols = payload["cols"]
    C = {name: i for i, name in enumerate(cols)}

    sizes = payload.get("sizes", [])
    races = payload.get("races", [])
    elements = payload.get("elements", [])
    zones = payload.get("zones", [])
    maps = payload.get("maps", [])
    items = payload.get("items", [])
    traitnames = payload.get("traitnames", [])

    out: list[dict] = []
    for row in payload["rows"]:
        def col(name):
            idx = C.get(name)
            return row[idx] if idx is not None and idx < len(row) else None

        # Each drop is [name index, chance %, item id]: a Poring's
        # [0, 100, 909] is Jellopy at 100%, and [4, 1, 4001] its card at 1%.
        drops = []
        for d in (col("drops") or []):
            if not isinstance(d, list) or len(d) < 3:
                continue
            drops.append({
                "item_id": d[2],
                "item": lookup(items, d[0]),
                "chance_percent": d[1],
            })

        # "crowd" runs parallel to "maps": how many spawn on each, and the
        # respawn window in seconds. A field mob reads [25, 5, 0] -- 25 of
        # them, back five seconds after dying -- and an MVP [1, 1800, 3600].
        map_names = lookup_many(maps, col("maps"))
        codes = col("codes") or []
        spawns = []
        for i, crowd in enumerate(col("crowd") or []):
            if not isinstance(crowd, list) or not crowd or i >= len(map_names):
                continue
            spawns.append({
                "map": map_names[i],
                "code": codes[i] if i < len(codes) else None,
                "count": crowd[0],
                "respawn_s": [crowd[1] if len(crowd) > 1 else 0,
                              crowd[2] if len(crowd) > 2 else 0],
            })

        out.append({
            "id": col("id"),
            "name": col("name"),
            "level": col("lv"),
            "hp": col("hp"),
            "size": lookup(sizes, col("size")),
            "race": lookup(races, col("race")),
            "element": lookup(elements, col("element")),
            "element_level": col("elv"),
            "is_mvp": bool(col("mvp")),
            "zone": lookup(zones, col("zone")),
            "maps": map_names,
            "spawns": spawns,
            "atk": col("atk"),
            "def": col("def"),
            "mdef": col("mdef"),
            "hit": col("hit"),
            "flee": col("flee"),
            "base_exp": col("exp"),
            "job_exp": col("jexp"),
            "card_effect": col("card") or None,
            "card_compound_slot": col("cslot") or None,
            "traits": lookup_many(traitnames, col("traits")),
            "drops": drops,
            "source_url": f"{BASE}/?show=mobs&id={col('id')}",
            "raw": {"stats": col("stats"), "codes": col("codes"), "where": col("where")},
        })
    return out


# --------------------------------------------------------------------------
# stages
# --------------------------------------------------------------------------


def stage_data(fetcher: Fetcher, raw_dir: Path) -> None:
    raw_dir.mkdir(parents=True, exist_ok=True)
    print(f"[data] fetching {len(DATA_FILES)} payloads")
    for name in DATA_FILES:
        body = fetcher.get(f"assets/data/{name}")
        if body is None:
            print(f"  ! {name} unavailable", file=sys.stderr)
            continue
        (raw_dir / name).write_bytes(body)
        print(f"  {name:<18} {len(body) / 1024:>8.1f} KB")


def stage_decode(raw_dir: Path, out_dir: Path) -> dict:
    items_payload = json.loads((raw_dir / "db-items.json").read_text("utf-8"))
    mobs_payload = json.loads((raw_dir / "db-mobs.json").read_text("utf-8"))

    items = decode_items(items_payload)
    mobs = decode_mobs(mobs_payload)
    apply_acquisition(items, Path(__file__).resolve().parent / "acquisition.json")

    items_dir = out_dir / "items"
    by_kind_dir = items_dir / "by-kind"
    by_kind_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "mobs").mkdir(parents=True, exist_ok=True)

    write_json(items_dir / "all.json", items)
    write_json(out_dir / "mobs" / "all.json", mobs)
    write_spawns(out_dir / "mobs" / "spawns.json", mobs)
    write_json(out_dir / "mobs" / "armor-targets.json", armor_targets(mobs))
    effort = items_dir / "effort.json"
    effort.write_text(json.dumps(item_effort(items, mobs), separators=(",", ":")), encoding="utf-8")

    buckets: dict[str, list[dict]] = {}
    for item in items:
        buckets.setdefault(item["kind"] or "Unknown", []).append(item)

    kind_summary = []
    for kind, bucket in sorted(buckets.items()):
        bucket.sort(key=lambda r: (r["name"] or "").lower())
        filename = f"{slugify(kind)}.json"
        write_json(by_kind_dir / filename, bucket)
        kind_summary.append({"kind": kind, "count": len(bucket), "file": f"items/by-kind/{filename}"})

    # The shared string tables, kept as their own file: the UI wants the
    # full list of slots, jobs and zones to build filter dropdowns, and
    # deriving that by scanning every record is wasteful.
    write_json(out_dir / "lookups.json", {
        "kinds": items_payload.get("grps", []),
        "types": items_payload.get("cats", []),
        "categories": items_payload.get("fams", []),
        "equip_slots": items_payload.get("locs", []),
        "jobs": items_payload.get("jobs", []),
        "elements": items_payload.get("eles", []),
        "zones": items_payload.get("zones", []),
        "trade_restrictions": items_payload.get("locknames", []),
        "containers": items_payload.get("boxnames", []),
        "container_sets": items_payload.get("boxsets", []),
        "skill_casts": items_payload.get("castnames", []),
        "cast_triggers": items_payload.get("triggers", []),
        "mob_sizes": mobs_payload.get("sizes", []),
        "mob_races": mobs_payload.get("races", []),
        "mob_elements": mobs_payload.get("elements", []),
    })

    # The item payload stores job limits as sentences ("All except Bouncer,
    # Judge, ...") rather than a class list, so the canonical roster comes
    # from the skill payload, which has one.
    skills_path = raw_dir / "db-skills.json"
    if skills_path.exists():
        skills = json.loads(skills_path.read_text("utf-8"))
        classes = [c for c in skills.get("classes", []) if c != "Shadow set"]
        write_json(out_dir / "classes.json", classes)
        print(f"[decode] {len(classes)} playable classes")

    print(f"[decode] {len(items)} items, {len(mobs)} monsters")
    for entry in kind_summary:
        print(f"  {entry['kind']:<14} {entry['count']:>5}")

    return {"items": items, "mobs": mobs, "kinds": kind_summary}


def stage_images(fetcher: Fetcher, items: list[dict], project: Path,
                 workers: int, force: bool) -> dict:
    icons_dir = project / "images" / "icons"
    art_dir = project / "images" / "art"
    icons_dir.mkdir(parents=True, exist_ok=True)
    art_dir.mkdir(parents=True, exist_ok=True)

    jobs: list[tuple[str, Path]] = []
    seen: set[str] = set()

    for item in items:
        bits = item["raw"]["icon_bits"] or 0
        if bits & 1:
            jobs.append((f"assets/icons/{item['id']}.png", icons_dir / f"{item['id']}.png"))
        if bits & 2:
            jobs.append((f"assets/icons/art/{item['id']}.png", art_dir / f"{item['id']}.png"))

    jobs.append((CARD_ART_FALLBACK, art_dir / "card.png"))

    deduped = []
    for remote, local in jobs:
        if remote in seen:
            continue
        seen.add(remote)
        if local.exists() and local.stat().st_size > 0 and not force:
            fetcher.counts["skipped"] += 1
            continue
        deduped.append((remote, local))

    total = len(deduped)
    print(f"[images] {total} to download ({fetcher.counts['skipped']} already on disk)")
    if not total:
        return {"downloaded": 0, "skipped": fetcher.counts["skipped"]}

    done = threading.Event()
    counter = {"n": 0}
    counter_lock = threading.Lock()

    def work(job):
        remote, local = job
        body = fetcher.get(remote)
        if body:
            tmp = local.with_suffix(".png.part")
            tmp.write_bytes(body)
            tmp.replace(local)
        with counter_lock:
            counter["n"] += 1
            n = counter["n"]
        if n % 250 == 0 or n == total:
            print(f"  {n}/{total}")

    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(work, deduped))
    finally:
        done.set()

    return {"downloaded": counter["n"], "skipped": fetcher.counts["skipped"]}


def write_spawns(path: Path, mobs: list[dict]) -> None:
    """Where each monster lives, for the planner's "where does this drop".

    Kept apart from mobs/all.json, which is over a megabyte: the planner
    only needs a monster's name, level, MVP flag and spawns, and only once
    someone asks where something drops, so this is loaded on demand.
    Positional to keep it small: {id: [name, level, mvp, [[map, count,
    respawn min s, respawn max s], ...]]}.
    """
    out = {}
    for m in mobs:
        out[str(m["id"])] = [
            m["name"], m["level"], 1 if m["is_mvp"] else 0,
            [[s["map"], s["count"], s["respawn_s"][0], s["respawn_s"][1]]
             for s in m["spawns"]],
        ]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


SOLD_EFFORT = 1000
"""What something sold for zeny with no item cost counts as. The data has
no prices, so it is simply cheap next to anything that has to be farmed."""

MVP_EFFORT_FACTOR = 200
"""How much harder a drop is to farm off an MVP than the rest of the sum
says. An MVP comes back every 30 to 60 minutes and other players want it
too, so a 3% card is some thirty kills spread over a day or more of
camping. Calibrated so Mistress Card lands just past a sun helmet, which is
where players place it. A calibration, not a model."""

SPARSE_SPAWNS = 10
"""How many spawns on a map it takes before finding the next one stops
being the slow part. A kill costs 1 + SPARSE_SPAWNS / spawns times its HP:
70 on a map is barely slower than the HP alone, 3 is four times slower,
and a lone spawn eleven times -- the walking between them is the cost. The
data has no map sizes, so this is spawns per map, not true density."""


def apply_acquisition(items: list[dict], path: Path) -> None:
    """Put back the exchange costs the database leaves out.

    Written into the item's raw "how" field, where the database's own costs
    live, so both the planner's effort score and its "where it comes from"
    overlay read the corrected figure without knowing it was corrected. The
    correction itself is kept alongside, as "how_override", so it can be
    shown and argued with.
    """
    if not path.exists():
        return
    spec = json.loads(path.read_text("utf-8"))
    by_name: dict[str, list[dict]] = {}
    for item in items:
        by_name.setdefault(item["name"], []).append(item)
    applied = 0
    for entry in spec.get("entries", []):
        costs = []
        for qty, name in entry["costs"]:
            match = by_name.get(name)
            if not match:
                print(f"  ! acquisition: no item called {name!r}", file=sys.stderr)
                continue
            costs.append([qty, name, match[0]["id"]])
        for name in entry["names"]:
            for item in by_name.get(name) or []:
                how = item["raw"].get("how")
                how = list(how) if isinstance(how, list) else ["", "", "", [], "", "", ""]
                how += [None] * max(0, 7 - len(how))
                how[3] = costs
                how[6] = ""  # an exchange, not a zeny purchase
                item["raw"]["how"] = how
                item["raw"]["how_override"] = {
                    "status": entry.get("status"), "reason": entry.get("reason")}
                applied += 1
            if name not in by_name:
                print(f"  ! acquisition: no item called {name!r}", file=sys.stderr)
    print(f"[decode] exchange costs corrected on {applied} items")


MIN_HP_PER_LEVEL = 200
"""The least HP a monster is taken to have per level, for effort. A handful
carry a token figure -- Shadow of Reginleif is level 124 with 30 HP, Fake
Pope level 144 with 240 -- which is a special mechanic (a fixed number of
hits, say), not a monster that dies to a sneeze. Read literally they make
whatever they drop look free."""


def effective_hp(mob: dict) -> float:
    """HP as it takes to chew through, armour included.

    Renewal's hard DEF lets (4000 + DEF) / (4000 + 10 DEF) of a hit through,
    and hard MDEF (1000 + MDEF) / (1000 + 10 MDEF) of a spell. Effort is not
    about one build, so the monster is taken through whichever lets more in:
    700 DEF on a Valhalla Knight counts in full only if 25 MDEF did not
    leave the door open for magic. No penetration assumed.
    """
    d = max(0, mob.get("def") or 0)
    m = max(0, mob.get("mdef") or 0)
    through = max((4000 + d) / (4000 + 10 * d), (1000 + m) / (1000 + 10 * m))
    hp = max(mob["hp"] or 0, (mob["level"] or 0) * MIN_HP_PER_LEVEL)
    return hp / through


def item_effort(items: list[dict], mobs: list[dict]) -> dict[str, list[int]]:
    """How hard each item is to get: [effort, toughest kill, route].

    Effort is roughly how much monster HP you chew through to get it; the
    toughest kill is the effective HP of the hardest monster the route asks
    you to beat. They answer different questions -- how long, and whether at
    all. A Valhalla drop is out of a mid-game character's hands because of
    the 1.5 million HP Knight standing over it, however short the grind.

    For a drop: what one kill costs over the drop chance. A kill costs the
    monster's effective HP (armour included), scaled up when there are few
    of it on its best map to find; MVPs cost far more again. For an
    exchange: the sum of what it costs, each part worked out the same way.
    The easiest route wins. Only monsters that spawn count, and never the
    level 1 training dummies.

    It is a yardstick, not a price. It exists so suggestions can tell a
    piece a character could farm next week from one that takes a finished
    endgame build -- Valhalla drops at 1% off 1.5 million HP, or a sun
    helmet at a thousand Star Pieces and a +9 moon helmet. Items whose
    effort cannot be worked out (boxes, zeny prices) are left out, and read
    as unknown rather than as cheap.
    """
    by_id = {i["id"]: i for i in items}
    mob_by_id = {m["id"]: m for m in mobs}
    # (effort, toughest kill, route) per item; None while in progress or
    # unknown. The route is the monster id for a drop, 0 for a zeny purchase
    # and -1 for an exchange, so the planner can follow the chosen route down
    # to what is actually worth farming.
    memo: dict[int, tuple[float, float, int] | None] = {}

    def effort(item_id: int, depth: int = 0) -> tuple[float, float, int] | None:
        if item_id in memo:
            return memo[item_id]
        memo[item_id] = None  # a cycle reads as unknown, not as free
        item = by_id.get(item_id)
        if item is None:
            return None
        best: tuple[float, float, int] | None = None

        def take(route: tuple[float, float, int]) -> None:
            nonlocal best
            if best is None or route[0] < best[0]:
                best = route

        for d in item.get("drops") or []:
            mob = mob_by_id.get(d["mob_id"])
            chance = d.get("chance_percent") or 0
            if not mob or not mob["spawns"] or (mob["level"] or 0) <= 1 or chance <= 0:
                continue
            most = max((s["count"] or 0) for s in mob["spawns"])
            ehp = effective_hp(mob)
            cost = ehp * (1 + SPARSE_SPAWNS / max(1, most)) / (chance / 100)
            if mob["is_mvp"]:
                cost *= MVP_EFFORT_FACTOR
            take((cost, ehp, mob["id"]))
        how = (item.get("raw") or {}).get("how")
        if isinstance(how, list) and how and how[0]:
            costs = how[3] if len(how) > 3 and isinstance(how[3], list) else []
            if not costs and len(how) > 6 and how[6] == "sold":
                take((SOLD_EFFORT, 0.0, 0))
            elif costs and depth < 6:
                total, toughest = 0.0, 0.0
                for c in costs:
                    if isinstance(c, list) and len(c) >= 3:
                        part = effort(c[2], depth + 1)
                        if part:
                            total += (c[0] or 0) * part[0]
                            toughest = max(toughest, part[1])
                take((total, toughest, -1))
        memo[item_id] = best
        return best

    out = {}
    for item in items:
        e = effort(item["id"])
        if e is not None:
            out[str(item["id"])] = [round(e[0]), round(e[1]), e[2]]
    return out


def armor_targets(mobs: list[dict]) -> dict:
    """The DEF and MDEF figures penetration is judged against.

    What penetration is worth depends entirely on the target, so the planner
    shows it against several: the softest monster, the average one, the
    average endgame one (level 130 and up), and the hardest. Only monsters
    with a spawn count: event and summon-only entries would pull the figures
    towards targets nobody farms. Averages are per kind of monster, not
    weighted by how many spawn.

    The softest is the highest level of the zero-armour monsters, so it
    names something worth fighting rather than a training dummy. DEF and
    MDEF are picked separately: the hardest target for one is not the
    hardest for the other.
    """
    def targets(key: str, name: str) -> list[dict]:
        fought = [m for m in mobs if m["spawns"] and m[key] is not None]
        endgame = [m for m in fought if (m["level"] or 0) >= 130]
        one = lambda label, m: {
            "label": label, "name": m["name"], "level": m["level"], "value": m[key]}
        mean = lambda label, group: {
            "label": label, "count": len(group),
            "value": round(sum(m[key] for m in group) / len(group)),
        }
        return [
            one(f"Lowest {name}", min(fought, key=lambda m: (m[key], -m["level"]))),
            mean("Average", fought),
            mean("Average, Lv 130+", endgame),
            one(f"Highest {name}", max(fought, key=lambda m: (m[key], m["level"]))),
        ]

    return {"def": targets("def", "DEF"), "mdef": targets("mdef", "MDEF")}


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Crawl the RTM: Refuge database into a local dataset.")
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent,
                        help="project root (default: the folder holding crawler/)")
    parser.add_argument("--rps", type=float, default=6.0,
                        help="max requests per second overall (default: 6)")
    parser.add_argument("--workers", type=int, default=4,
                        help="parallel connections (default: 4)")
    parser.add_argument("--skip-data", action="store_true", help="reuse the raw JSON on disk")
    parser.add_argument("--skip-images", action="store_true", help="metadata only")
    parser.add_argument("--skip-parse", action="store_true",
                        help="do not parse set/refine bonuses out of the text")
    parser.add_argument("--force", action="store_true", help="re-download images already present")
    args = parser.parse_args()

    project: Path = args.out
    data_dir = project / "data"
    raw_dir = data_dir / "raw"

    throttle = Throttle(args.rps)
    fetcher = Fetcher(throttle)

    started = datetime.now(timezone.utc)
    print(f"RTM crawl -> {project}")
    print(f"  rate limit: {args.rps}/s across {args.workers} connections\n")

    if args.skip_data:
        if not (raw_dir / "db-items.json").exists():
            print("--skip-data given but data/raw/db-items.json is missing", file=sys.stderr)
            return 1
        print("[data] skipped, using raw JSON on disk")
    else:
        stage_data(fetcher, raw_dir)

    decoded = stage_decode(raw_dir, data_dir)

    # The bonus parser writes its results back into the item files, so it has
    # to run after every decode -- otherwise a re-crawl would silently leave
    # the dataset without the parsed sets and refine scaling.
    if args.skip_parse:
        print("[parse] skipped")
    else:
        print("[parse] reading set and refine bonuses out of the descriptions")
        parse_bonuses.main()

    # The roll tables are hand-written, but they name stats from the registry
    # the decode just rewrote. Re-emitting them here is what catches a stat
    # key that has been renamed out from under them.
    print("[rolls] validating the hand-written roll tables")
    if build_rolls.main() != 0:
        print("[rolls] data/rolls.json was NOT updated", file=sys.stderr)

    image_stats = {"downloaded": 0, "skipped": 0}
    if args.skip_images:
        print("[images] skipped")
    else:
        image_stats = stage_images(fetcher, decoded["items"], project, args.workers, args.force)

    meta = {
        "source": BASE,
        "crawled_at": started.isoformat(),
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "items": len(decoded["items"]),
        "monsters": len(decoded["mobs"]),
        "kinds": decoded["kinds"],
        "images": image_stats,
        "requests": dict(fetcher.counts),
    }
    write_json(data_dir / "meta.json", meta)

    print("\nDone.")
    print(f"  requests: {fetcher.counts}")
    print(f"  dataset:  {data_dir}")
    if fetcher.counts["failed"]:
        print(f"  {fetcher.counts['failed']} request(s) failed; re-run to retry.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main())
