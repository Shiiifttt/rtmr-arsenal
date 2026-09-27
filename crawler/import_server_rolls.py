"""Read the server's random option tables into crawler/rolls.json.

The rolls were hand-written from the project owner's descriptions until the
server's own files turned up (returntomorroc/, RTM's rAthena fork, 2023-12):

  db/re/item_randomopt_group.yml  what each group rolls: one entry per roll
                                  ("Slot"), each a list of options with a
                                  value range and a weight
  db/re/item_randomopt_db.yml     what each option does, as an item script.
                                  RTM reuses upstream's option names for its
                                  own effects -- ADDEXPPERCENT_KILLRACE_PLANT
                                  is -0.2s fixed cast, not EXP vs plants -- so
                                  the script is what counts, never the name
  db/re/mob_db.yml, db/import/    which group each monster drop rolls: the
                                  per-item map ("items" in rolls.json)

Skill names come from the crawl's skill rows, whose icon is the server's
aegis name (SJ_NEWMOONKICK -> New Moon).

Each server group becomes a table. Hand tables keep their slots, gates and
notes and have their rolls replaced -- roll and option keys reused where the
stat is the same, so saved builds keep their rolls. Groups with no hand
table (weapons, shields) are added gated on item type and on dropping; an
item the server names goes straight to its group's table whatever its type.
Items the server does not know (newer than 2023) fall back to the slot and
type rules. never_from stays as it is.

    python crawler/import_server_rolls.py [--dry-run]

then `python crawler/build_rolls.py` to validate and emit data/rolls.json.
"""
from __future__ import annotations

import collections
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "returntomorroc" / "db"
HAND = ROOT / "crawler" / "rolls.json"
SKILLS = ROOT / "data" / "raw" / "db-skills.json"

STATS = {"bStr": "str", "bAgi": "agi", "bVit": "vit", "bInt": "int", "bDex": "dex", "bLuk": "luk"}

# bonus -> (stat key, unit, sign, label). The sign turns the server's
# "-(value)" into the magnitude the player reads off the item.
BONUS: dict[str, tuple[str, str | None, int, str]] = {
    **{b: (k, None, 1, k.upper()) for b, k in STATS.items()},
    "bMaxHPrate": ("max_hp", "%", 1, "Max HP %"),
    "bMaxSPrate": ("max_sp", "%", 1, "Max SP %"),
    "bNoWeaponDamage": ("physical_damage_received", "%", -1, "Physical damage reduced"),
    "bNoMagicDamage": ("magic_damage_received", "%", -1, "Magic damage reduced"),
    "bHealPower2": ("healing_received", "%", 1, "Healing effect received"),
    "bDef": ("def", None, 1, "DEF"),
    "bMdef": ("mdef", None, 1, "MDEF"),
    "bFlee": ("flee", None, 1, "Flee"),
    "bFlee2": ("perfect_dodge", None, 1, "Perfect Dodge"),
    "bHPrecovRate": ("hp_regen", "%", 1, "HP regen"),
    "bSPrecovRate": ("sp_regen", "%", 1, "SP regen"),
    "bSpeedAddRate": ("move_speed", "%", 1, "Move Speed"),
    "bAspdRate": ("aspd", "%", 1, "ASPD %"),
    "bAspd": ("aspd", None, 1, "ASPD"),
    "bVariableCastrate": ("variable_cast", "%", -1, "Variable cast time reduced"),
    "bDelayrate": ("after_cast_delay", "%", -1, "After cast delay reduced"),
    "bASPDCap": ("aspd_limit", None, 1, "ASPD Limit"),
    "bMatkRate": ("matk", "%", 1, "MATK %"),
    "bAtk": ("atk", None, 1, "ATK"),
    "bMatk": ("matk", None, 1, "MATK"),
    "bCritical": ("crit_rate", None, 1, "CRIT"),
    "bHit": ("hit", None, 1, "HIT"),
    "bUseSPrate": ("sp_cost", "%", -1, "SP cost reduced"),
    "bShortAtkRate": ("melee_damage", "%", 1, "Melee damage"),
    "bLongAtkRate": ("ranged_damage", "%", 1, "Ranged damage"),
    "bCritAtkRate": ("crit_damage", "%", 1, "Critical damage"),
    "bFixedCastrate": ("fixed_cast", "%", -1, "Fixed cast time reduced %"),
    "bPerfectHitAddRate": ("perfect_hit", "%", 1, "Perfect Hit"),
    "bSplashAddRange": ("splash_range", None, 1, "Splash range"),
    "bAtkRange": ("attack_range", None, 1, "Attack range"),
    "bDoubleAddRate": ("double_attack_rate", "%", 1, "Double Attack chance"),
}
FLAGS = {"bNoSizeFix": ("no_size_penalty", "No size penalty"),
         "bReduceDamageReturn": ("ignores_reflect", "Ignores reflect damage")}

VALUE = r"-?\(?-?getrandomoptinfo\(ROA_VALUE\)\)?"


def load(path: Path):
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def skill_names() -> tuple[dict[str, str], dict[str, str]]:
    """Aegis name -> the planner's skill name (crawl), and -> the server's own."""
    raw = json.loads(SKILLS.read_text(encoding="utf-8"))
    icon, name = raw["cols"].index("icon"), raw["cols"].index("name")
    crawl: dict[str, str] = {}
    for row in raw["rows"]:
        n = row[name]
        # "Shadow Slash+" is an upgraded copy; the plain name is the skill.
        if row[icon] and (row[icon] not in crawl or crawl[row[icon]].endswith("+")):
            crawl[row[icon]] = n
    server = {s["Name"]: s.get("Description", s["Name"])
              for s in load(SERVER / "re" / "skill_db.yml").get("Body", [])}
    return crawl, server


def grants_of(script: str, lo, hi, skills) -> tuple[str, list[dict], str | None] | None:
    """(label, grants, note) for one option's script; None if it is not understood."""
    crawl, server = skills
    s = " ".join(script.split())
    rng = {"min": lo, "max": hi}

    m = re.fullmatch(r"bonus (b\w+),1;", s)
    if m and m[1] in FLAGS:
        key, label = FLAGS[m[1]]
        return label, [{"stat": key, "unit": None, "min": 1, "max": 1}], None
    m = re.fullmatch(rf"bonus (b\w+),{VALUE};", s)
    if m and m[1] in FLAGS:
        key, label = FLAGS[m[1]]
        return label, [{"stat": key, "unit": None, "min": 1, "max": 1}], f"server value {lo}"
    if m and m[1] == "bFixedCast":
        # Milliseconds on the server, seconds in the planner.
        return "Fixed cast time reduced", [{"stat": "fixed_cast", "unit": None, "sign": -1,
                                            "min": lo / 1000, "max": hi / 1000, "step": 0.001}], "In seconds."
    if m and m[1] == "bHPDrainValue":
        return "HP gained per hit", [{"stat": "hp_per_hit", "unit": None, "min": lo, "max": hi}], None
    if m and m[1] in BONUS:
        key, unit, sign, label = BONUS[m[1]]
        g = {"stat": key, "unit": unit, "min": lo, "max": hi}
        if sign < 0:
            g["sign"] = -1
        return label, [g], None

    m = re.fullmatch(rf"bonus2 bAddClass,Class_All,{VALUE};", s)
    if m:
        return "ATK %", [{"stat": "atk", "unit": "%", **rng}], "Damage vs every class (bAddClass)."
    m = re.fullmatch(rf"bonus2 bMagicAtkEle,Ele_All,{VALUE};", s)
    if m:
        return "Magic damage", [{"stat": "magic_damage", "unit": "%", **rng}], None
    m = re.fullmatch(rf"bonus2 bExpAddRace,RC_All,{VALUE};", s)
    if m:
        return "EXP", [{"stat": "exp_gain", "unit": "%", **rng}], None
    m = re.fullmatch(rf"bonus2 bIgnoreDefRaceRate,RC_All,{VALUE};", s)
    if m:
        # RTM's tooltips call bIgnoreDefRaceRate "Defense Penetration +N".
        return "Defense Penetration", [{"stat": "def_pen", "unit": None, **rng}], None
    m = re.fullmatch(rf"bonus2 bIgnoreMdefRaceRate,RC_All,{VALUE};", s)
    if m:
        return "Magic Defense Penetration", [{"stat": "mdef_pen", "unit": None, **rng}], None
    m = re.fullmatch(rf"bonus2 bHPDrainRate,(\d+),{VALUE};", s)
    if m:
        # rAthena: the rate is in tenths of a percent.
        rate = int(m[1]) / 10
        return "HP Leech", [{"stat": "leech_hp_rate", "unit": "%", "min": rate, "max": rate, "step": 0.1},
                            {"stat": "leech_hp_power", "unit": "%", **rng}], \
            f"{rate:g}% chance; the rolled value is how much of the damage comes back."

    m = re.fullmatch(rf'bonus2 bSkillAtk,"(\w+)",{VALUE};', s)
    if m:
        name = crawl.get(m[1]) or server.get(m[1], m[1])
        note = None if m[1] in crawl else f"{m[1]}: not in the crawl's skills (server name)"
        return f"{name} damage", [{"skill": True, "skill_name": name, "metric": "damage", "unit": "%", **rng}], note
    m = re.fullmatch(rf'bonus2 bSkillCooldown,"(\w+)",{VALUE};', s)
    if m:
        name = crawl.get(m[1]) or server.get(m[1], m[1])
        note = None if m[1] in crawl else f"{m[1]}: not in the crawl's skills (server name)"
        return f"{name} cooldown", [{"skill": True, "skill_name": name, "metric": "cooldown", "unit": "s", "sign": -1,
                                     "min": lo / 1000, "max": hi / 1000, "step": 0.001}], note
    m = re.fullmatch(rf'skill "(\w+)",{VALUE};', s)
    if m:
        name = crawl.get(m[1]) or server.get(m[1], m[1])
        return f"{name} level", [{"skill": True, "skill_name": name, "metric": "level", "unit": None, **rng}], \
            "Grants the skill."
    return None


def slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")


def convert_group(group: dict, options: dict, skills, problems: list[str]) -> list[dict]:
    rolls = []
    slots = [(f"roll{s['Slot']}", s["Options"]) for s in group.get("Slots", [])]
    if group.get("Random"):
        slots.append(("random", group["Random"]))
    for key, opts in slots:
        out, seen = [], set()
        weights = sum(o.get("Chance", 0) for o in opts) or 1
        for o in opts:
            script = options.get(o["Option"])
            if script is None:
                problems.append(f"{group['Group']}: {o['Option']} has no definition")
                continue
            lo, hi = o.get("MinValue", 0), o.get("MaxValue", 0)
            got = grants_of(script, lo, hi, skills)
            if got is None:
                problems.append(f"{group['Group']}: {o['Option']} not understood: {script.strip()}")
                continue
            label, grants, note = got
            chance = round(o.get("Chance", 0) / weights, 4)
            # The same effect listed twice in one roll (Astrologika's ASPD %):
            # one option spanning both ranges, their chances added.
            twin = next((x for x in out if x["label"] == label), None)
            if twin:
                for g, h in zip(twin["grants"], grants):
                    g["min"], g["max"] = min(g["min"], h["min"]), max(g["max"], h["max"])
                twin["server"]["chance"] = round(twin["server"]["chance"] + chance, 4)
                continue
            k = slug(label)
            while k in seen:
                k += "_"
            seen.add(k)
            opt = {"key": k, "label": label, "grants": grants,
                   "server": {"option": o["Option"], "chance": chance}}
            if note:
                opt["note"] = note
            out.append(opt)
        if out:
            label = roll_label(out)
            if label == "Skill modifier":
                # 150-odd skills in a dropdown: alphabetical, so typing finds one.
                out.sort(key=lambda o: o["label"].lower())
            rolls.append({"key": key, "label": label, "options": out})
    return rolls


def roll_label(options: list[dict]) -> str:
    stats = {g.get("stat") for o in options for g in o["grants"]}
    if stats <= {"str", "agi", "vit", "int", "dex", "luk", "atk", "matk", "aspd"} and stats & {"str", "luk"}:
        return "Stat"
    if all(g.get("skill") for o in options for g in o["grants"]):
        return "Skill modifier"
    return " / ".join(o["label"] for o in options[:3]) + (" / ..." if len(options) > 3 else "")


# Where each server group goes in the planner: an existing hand table (its
# slots and gates kept, its rolls replaced), or a new one. "listed" tables
# are reached only through the per-item map: the server names every item.
HAND_TABLE = {"armor": "armor", "garment": "garment", "shoes": "shoes", "accessory": "dropped_accessory",
              "manual": "manual_rune", "shadow": "shadow", "dracoorb": "orb"}
# Headgear rolls the manual group too (the server gives it to 31 headgears).
ALSO = {"manual": ["dropped_headgear"]}
NEW = {
    "shield": {"key": "shield", "label": "Shield", "slots": ["offhand"],
               "requires": {"types": ["Heavy Shield", "Round Shield", "Colossal Shield", "Arm Shield",
                                      "Square Shield", "Shield", "Armguard"], "dropped": True}},
    "dagger": {"label": "Dagger", "slots": ["weapon", "offhand"], "requires": {"types": ["Dagger"], "dropped": True}},
    "sword": {"label": "Sword", "slots": ["weapon", "offhand"],
              "requires": {"types": ["Sword", "Long Sword", "Knight Sword", "Two-Handed Sword"], "dropped": True}},
    "axe": {"label": "Axe", "slots": ["weapon", "offhand"], "requires": {"types": ["Axe", "One-Handed Axe"], "dropped": True}},
    "katar": {"label": "Katar", "slots": ["weapon"], "requires": {"types": ["Katar"], "dropped": True}},
    "scythe": {"label": "Scythe", "slots": ["weapon"], "requires": {"types": ["Scythe"], "dropped": True}},
    "bow": {"label": "Bow", "slots": ["weapon"], "requires": {"types": ["Bow", "Heavy Bow"], "dropped": True}},
    "deck": {"label": "Deck", "slots": ["weapon"], "requires": {"types": ["Deck"], "dropped": True}},
    "spear": {"label": "Spear", "slots": ["weapon"],
              "requires": {"types": ["Spear", "Wyrm Spear", "Bone Sword", "Two-Handed Spear"], "dropped": True}},
    "whip": {"label": "Whip", "slots": ["weapon"], "requires": {"types": ["Whip"], "dropped": True}},
    "codex": {"label": "Codex", "slots": ["weapon", "offhand"], "requires": {"types": ["Codex"], "dropped": True}},
    "astrologika": {"key": "astrologika", "label": "Astrologika", "slots": ["upper", "armor"],
                    "requires": {"listed": True}},
}
# Rolls where the live game has been seen to differ from the 2023 files: the
# hand roll stays. A Venus Cape screenshot (web/test/recognition.test.ts)
# reads "Leech Rate/Leech Power 16 / 2" -- the hand table's 10-20 % chance,
# 1-2 % power, HP or SP -- where the server file has a fixed 50 % chance,
# 2-5 %, HP only.
KEEP_HAND = {("garment", "sustain"): "Kept from the hand table: leech was nerfed on the live server to "
                                     "10/1 up to 20/2 (project owner, 2026-09-26; a Venus Cape reads 16 / 2). "
                                     "The 2023 server file has a 50% chance at 2-5%, HP only."}
# Recall-skill scrolls: nothing a build uses.
SKIP = {"lowerscroll", "higherscroll"}
# Hand tables that keep a skill-modifier roll for items the server does not
# know, gated on the description saying "Skill Random Mods". The ones it
# knows roll the shadow group whole, through the per-item map.
SAYS_SKILL = ["dropped_headgear", "dropped_accessory", "garment"]


def sig(o: dict) -> tuple:
    g = o["grants"][0]
    return (g.get("stat") or g.get("skill_name") or o["label"], g.get("metric"), g.get("unit"))


def keep_keys(old: list[dict], new: list[dict]) -> list[dict]:
    """Reuse the old roll and option keys (and wording) where the stat is the
    same, so a build saved against the hand tables keeps its rolls."""
    used: set[str] = set()
    for roll in new:
        mine = {sig(o) for o in roll["options"]}
        best = max((r for r in old if r["key"] not in used),
                   key=lambda r: len(mine & {sig(o) for o in r["options"]}), default=None)
        all_skill = lambda r: all(g.get("skill") for o in r["options"] for g in o["grants"])  # noqa: E731
        if best is None or not mine & {sig(o) for o in best["options"]}:
            # The hand tables' free-typed skill roll becomes the server's list
            # of named skills: same roll, so the same key.
            best = next((r for r in old if r["key"] not in used and all_skill(r)), None) if all_skill(roll) else None
            if best is None:
                continue
        used.add(best["key"])
        roll["key"], roll["label"] = best["key"], best["label"]
        if best.get("note"):
            roll["note"] = best["note"]
        by_sig = {sig(o): o for o in best["options"]}
        for o in roll["options"]:
            was = by_sig.get(sig(o))
            if was:
                o["key"], o["label"] = was["key"], was["label"]
                if was.get("reads"):
                    o["reads"] = was["reads"]
    seen: set[str] = set()
    for roll in new:
        while roll["key"] in seen:
            roll["key"] += "_"
        seen.add(roll["key"])
    return new


def item_groups() -> dict[int, set[str]]:
    """Every item a monster drops with a random option group, and its groups."""
    aegis: dict[str, int] = {}
    for f in ("re/item_db_equip.yml", "re/item_db_etc.yml", "re/item_db_usable.yml", "import/item_db.yml"):
        path = SERVER / f
        if path.exists():
            for e in load(path).get("Body") or []:
                aegis[e["AegisName"]] = e["Id"]
    out: dict[int, set[str]] = collections.defaultdict(set)
    for f in ("re/mob_db.yml", "import/mob_db.yml"):
        for m in load(SERVER / f).get("Body") or []:
            for d in (m.get("Drops") or []) + (m.get("MvpDrops") or []):
                g, iid = d.get("RandomOptionGroup"), aegis.get(d["Item"])
                if g and iid:
                    out[iid].add(g)
    return out


def main(argv: list[str]) -> int:
    dry = "--dry-run" in argv
    options = {e["Option"]: e.get("Script", "") for e in load(SERVER / "re" / "item_randomopt_db.yml")["Body"]}
    for e in load(SERVER / "import" / "item_randomopt_db.yml").get("Body") or []:
        options[e["Option"]] = e.get("Script", "")
    groups = load(SERVER / "re" / "item_randomopt_group.yml")["Body"]
    groups += load(SERVER / "import" / "item_randomopt_group.yml").get("Body") or []
    skills = skill_names()

    hand = json.loads(HAND.read_text(encoding="utf-8"))
    by_key = {t["key"]: t for t in hand["tables"]}
    problems: list[str] = []
    changed: dict[str, tuple[list, list]] = {}
    table_of: dict[str, str] = {}
    shadow_skill: list[dict] = []
    mvp_rolls: list[dict] = []
    for g in groups:
        name = g["Group"]
        if name in SKIP:
            continue
        rolls = convert_group(g, options, skills, problems)
        if name == "dracomvp":
            # The same orbs from an MVP: one table, the ranges widened below.
            mvp_rolls = rolls
            table_of[name] = "orb"
            continue
        if name in HAND_TABLE:
            targets = [HAND_TABLE[name], *ALSO.get(name, [])]
        elif name in NEW:
            spec = NEW[name]
            key = spec.get("key", f"weapon_{name}")
            if key not in by_key:
                t = {"key": key, **{k: v for k, v in spec.items() if k != "key"}, "rolls": []}
                hand["tables"].append(t)
                by_key[key] = t
            targets = [key]
        else:
            problems.append(f"group {name!r} has no place in the planner")
            continue
        table_of[name] = targets[0]
        for key in targets:
            t = by_key[key]
            old = [r for r in t.get("rolls", []) if not r.get("requires", {}).get("says")]
            new = keep_keys(old, json.loads(json.dumps(rolls)))
            for i, r in enumerate(new):
                why = KEEP_HAND.get((key, r["key"]))
                was = next((o for o in old if o["key"] == r["key"]), None)
                if why and was:
                    new[i] = {**was, "note": why}
            changed[key] = (t.get("rolls", []), new)
            t["rolls"] = new
            t["server"] = {"group": name, "file": "returntomorroc/db/re/item_randomopt_group.yml"}
        if name == "shadow":
            shadow_skill = next((r["options"] for r in rolls if r["label"] == "Skill modifier"), [])

    # An orb rolls the dracoorb group off a monster and dracomvp off an MVP:
    # Dragon Soul 1-3 / 4-5, Max HP 1-3 / 4-5 %.
    orb = by_key["orb"]
    for r, m in zip(orb["rolls"], mvp_rolls):
        for o, p in zip(r["options"], m["options"]):
            for g, h in zip(o["grants"], p["grants"]):
                g["min"], g["max"] = min(g["min"], h["min"]), max(g["max"], h["max"])
    orb["note"] = ("Project owner, 2026-09-26: a Dracomancer orb rolls two things, Dragon Soul level and Max HP. "
                   "The server rolls 1-3 on a monster's drop and 4-5 on an MVP's, for the same orbs.")

    # The description-gated skill roll, for items the server does not know.
    for key in SAYS_SKILL:
        t = by_key[key]
        t["rolls"] = t["rolls"] + [{
            "key": "skill", "label": "Skill modifier",
            "note": "Only on items whose description says \"Skill Random Mods\" and that the 2023 server data "
                    "does not list; the ones it lists roll the shadow group whole.",
            "requires": {"says": ["skill random", "skill mod"]},
            "options": json.loads(json.dumps(shadow_skill)),
        }]
        changed[key] = (changed[key][0], t["rolls"])

    # Which table each item the server names rolls. An item with two groups
    # (Knife Dagger: dagger and shadow) is left to the slot rules.
    crawl = {i["id"] for i in json.loads((ROOT / "data" / "items" / "all.json").read_text(encoding="utf-8"))}
    listed: dict[str, str] = {}
    for iid, gs in sorted(item_groups().items()):
        tables = {table_of[g] for g in gs if g in table_of}
        if iid in crawl and len(tables) == 1:
            listed[str(iid)] = tables.pop()
    hand["items"] = listed

    for key, (old, new) in changed.items():
        print(f"== {key}: {len(old)} rolls -> {len(new)}")
        for r in new:
            opts = ", ".join(f"{o['key']}={o['label']} {rng(o)}" for o in r["options"][:10])
            more = f" (+{len(r['options']) - 10} more)" if len(r["options"]) > 10 else ""
            print(f"   {r['key']} [{r['label']}]: {opts}{more}")
    print(f"\n{len(listed)} items mapped to a table: "
          + ", ".join(f"{k} {v}" for k, v in collections.Counter(listed.values()).most_common()))
    if problems:
        print("\nnot imported:\n  " + "\n  ".join(problems))
    if dry:
        return 0
    hand["status"] = "server"
    HAND.write_text(json.dumps(hand, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nwrote {HAND}")
    return 0



def rng(o: dict) -> str:
    g = o["grants"][-1]
    lo, hi = g["min"], g["max"]
    unit = g.get("unit") or ""
    return f"{lo:g}{unit}" if lo == hi else f"{lo:g}-{hi:g}{unit}"


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
