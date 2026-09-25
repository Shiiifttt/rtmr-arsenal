"""Validate the hand-written roll tables and emit data/rolls.json.

The rolls an item gets on drop are not on the site, so unlike everything
else under data/ this dataset has no crawled source -- crawler/rolls.json is
written by hand. What this script adds is the one thing a hand-written file
cannot keep honest by itself: every stat named in it has to exist in the
stat registry, or the planner would silently drop the bonus.

Run standalone after editing the tables:

    python crawler/build_rolls.py

It is also called at the end of a crawl, so a registry change that orphans a
stat key is caught there rather than showing up as a missing bonus later.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "crawler" / "rolls.json"
STATS = ROOT / "data" / "stats.json"
OUTPUT = ROOT / "data" / "rolls.json"


class RollError(Exception):
    """A table that would produce wrong numbers, not merely an odd one."""


def build(source: Path = SOURCE, stats_path: Path = STATS) -> dict:
    doc = json.loads(source.read_text(encoding="utf-8"))
    stats = json.loads(stats_path.read_text(encoding="utf-8"))
    id_by_key = {s["key"]: s["id"] for s in stats}

    problems: list[str] = []
    seen_slots: dict[str, str] = {}
    # Gates the planner knows how to answer. A typo here would otherwise read
    # as "no condition" and hand the roll to every item in the slot.
    known_gates = {"dropped"}

    never = doc.get("never_from", [])
    if not isinstance(never, list) or not all(isinstance(p, str) and p.strip() for p in never):
        problems.append("'never_from' must be a list of place names")

    for table in doc.get("tables", []):
        where = f"table {table.get('key')!r}"
        for gate in table.get("requires", {}):
            if gate not in known_gates:
                problems.append(
                    f"{where}: unknown condition {gate!r} "
                    f"(the planner only understands {sorted(known_gates)})")
        for slot in table.get("slots", []):
            if slot in seen_slots:
                problems.append(
                    f"{where}: slot {slot!r} is already claimed by "
                    f"{seen_slots[slot]!r}; a slot can only have one table")
            seen_slots[slot] = table.get("key")

        keys = set()
        for roll in table.get("rolls", []):
            if roll["key"] in keys:
                problems.append(f"{where}: duplicate roll key {roll['key']!r}")
            keys.add(roll["key"])
            problems += check_roll_gate(roll, where)

            option_keys = set()
            for option in roll.get("options", []):
                if option["key"] in option_keys:
                    problems.append(
                        f"{where} roll {roll['key']!r}: duplicate option "
                        f"{option['key']!r}")
                option_keys.add(option["key"])

                if not option.get("grants"):
                    problems.append(
                        f"{where}: option {option['key']!r} grants nothing")

                for grant in option.get("grants", []):
                    problems += check_grant(grant, id_by_key, where, option)

    if problems:
        raise RollError("\n".join(problems))

    doc["stat_count"] = len(id_by_key)
    return doc


def check_roll_gate(roll: dict, where: str) -> list[str]:
    """A gate on one roll: 'says', phrases the item's description must contain.

    An unknown gate, or an empty phrase list, would read as "no condition" and
    hand the roll to every item in the slot -- the failure the gate exists for.
    """
    label = f"{where} roll {roll['key']!r}"
    gate = roll.get("requires")
    if gate is None:
        return []
    problems = [f"{label}: unknown condition {g!r} (the planner only understands ['says'])"
                for g in gate if g != "says"]
    says = gate.get("says")
    if not isinstance(says, list) or not says or not all(isinstance(s, str) and s.strip() for s in says):
        problems.append(f"{label}: 'says' must be a non-empty list of phrases")
    return problems


def check_grant(grant: dict, id_by_key: dict, where: str, option: dict) -> list[str]:
    """Bind a grant to a stat id, or say why it cannot be counted."""
    label = f"{where} option {option['key']!r}"

    if grant.get("skill"):
        # A skill modifier has no stat to add into. It is carried through so
        # the planner can show the line, and lands in `uncounted` like every
        # other per-skill bonus rather than being quietly folded into totals.
        grant["stat_id"] = None
        return []

    key = grant.get("stat")
    if key is None:
        return [f"{label}: a grant needs either 'stat' or 'skill': true"]
    if key not in id_by_key:
        return [f"{label}: no stat named {key!r} in the registry"]

    grant["stat_id"] = id_by_key[key]

    lo, hi = grant.get("min"), grant.get("max")
    if lo is None:
        return [f"{label}: {key} has no minimum"]
    if hi is not None and hi < lo:
        return [f"{label}: {key} range is backwards ({lo}..{hi})"]
    return []


def main(argv: list[str] | None = None) -> int:
    try:
        doc = build()
    except RollError as exc:
        print("roll tables rejected:\n" + str(exc), file=sys.stderr)
        return 1

    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    tmp = OUTPUT.with_suffix(".json.tmp")
    tmp.write_text(text, encoding="utf-8")
    try:
        tmp.replace(OUTPUT)
    except PermissionError:
        # The dev server or an editor can hold the file open on Windows.
        OUTPUT.write_text(text, encoding="utf-8")
        tmp.unlink(missing_ok=True)

    tables = doc.get("tables", [])
    slots = sum(len(t.get("slots", [])) for t in tables)
    rolls = sum(len(t.get("rolls", [])) for t in tables)
    print(f"rolls.json: {len(tables)} tables, {slots} slots, {rolls} rolls "
          f"({doc.get('status')})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
