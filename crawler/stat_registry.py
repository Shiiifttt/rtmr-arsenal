#!/usr/bin/env python3
"""
Canonical stats, and the mapping from tooltip wording onto them.

The tooltips name the same stat several ways -- "HP", "HP Bonus", "Max HP"
and "MaxHP" are one number -- so summing a character's equipment means
resolving all of that onto one identifier first.

Three things this has to get right:

* **One phrase can be several stats.** "All Stats +4" is six bonuses, not
  one, and "HP/SP +5%" is two. Resolution therefore returns a *list* of
  stat ids, so the arsenal can add a bonus to every stat it touches without
  special-casing the wording.

* **Flat and percent are not the same stat.** "DEF +50" and "Total DEF +10%"
  stack differently in Ragnarok. The unit stays on the effect and the
  "total" scope is recorded separately, so a calculator can apply each in
  the right order rather than adding a percentage to a flat pool.

* **Most of the long tail is not a character stat at all.** "Dragon Thrust
  DMG +20%" modifies one skill. Mapping it onto a global damage stat would
  silently inflate every calculation, so those resolve to no stat id and are
  tagged as skill modifiers instead.
"""

from __future__ import annotations

import re
from pathlib import Path

# --------------------------------------------------------------------------
# the registry
# --------------------------------------------------------------------------
# (key, display name, category). Order fixes the numeric index, so append
# new entries at the end of their group rather than inserting.

STATS: list[tuple[str, str, str]] = [
    # primary
    ("str", "STR", "primary"),
    ("agi", "AGI", "primary"),
    ("vit", "VIT", "primary"),
    ("int", "INT", "primary"),
    ("dex", "DEX", "primary"),
    ("luk", "LUK", "primary"),
    # resources
    ("max_hp", "Max HP", "resource"),
    ("max_sp", "Max SP", "resource"),
    ("hp_regen", "HP Regen", "resource"),
    ("sp_regen", "SP Regen", "resource"),
    # offence
    ("atk", "ATK", "offence"),
    ("matk", "MATK", "offence"),
    ("hit", "Hit", "offence"),
    ("perfect_hit", "Perfect Hit", "offence"),
    ("crit_rate", "Critical Rate", "offence"),
    ("crit_damage", "Critical Damage", "offence"),
    ("aspd", "ASPD", "offence"),
    ("aspd_limit", "ASPD Limit", "offence"),
    ("attack_range", "Attack Range", "offence"),
    ("splash_range", "Splash Range", "offence"),
    ("double_attack", "Double Attack", "offence"),
    ("melee_damage", "Melee Damage", "offence"),
    ("ranged_damage", "Ranged Damage", "offence"),
    ("magic_damage", "Magic Damage", "offence"),
    # defence
    ("def", "DEF", "defence"),
    ("mdef", "MDEF", "defence"),
    ("flee", "Flee", "defence"),
    ("perfect_dodge", "Perfect Dodge", "defence"),
    ("def_pen", "Defense Penetration", "defence"),
    ("mdef_pen", "Magic Defense Penetration", "defence"),
    ("damage_reduction", "Damage Reduction", "defence"),
    ("reflect_melee", "Reflect Melee Damage", "defence"),
    # casting
    ("cast_time", "Cast Time", "casting"),
    ("variable_cast", "Variable Cast Time", "casting"),
    ("fixed_cast", "Fixed Cast Time", "casting"),
    ("after_cast_delay", "After Cast Delay", "casting"),
    ("cooldown", "Cooldown", "casting"),
    # cost
    ("sp_cost", "SP Cost", "cost"),
    ("attack_sp_cost", "Attack SP Cost", "cost"),
    # utility
    ("move_speed", "Move Speed", "utility"),
    ("weight_limit", "Weight Limit", "utility"),
    ("exp_gain", "EXP Gain", "utility"),
    ("healing_power", "Healing Power", "utility"),
    ("healing_received", "Healing Received", "utility"),
    # Leeching is two independent numbers: how often it fires, and how much
    # it returns. "8% chance to leech 5% of damage" is one sentence but two
    # stats, and gear that raises the chance stacks with gear that raises the
    # amount, so folding them together would be wrong in both directions.
    ("leech_hp_rate", "HP Leech Rate", "utility"),
    ("leech_hp_power", "HP Leech Power", "utility"),
    ("leech_sp_rate", "SP Leech Rate", "utility"),
    ("leech_sp_power", "SP Leech Power", "utility"),
    ("drop_rate", "Drop Rate", "utility"),
    ("potion_healing", "Potion Healing Power", "utility"),
    ("vengeance_rate", "Vengeance Rate", "offence"),
    # The chance of the skill firing, which is a different number from the
    # skill's level and stacks differently: rates add up, levels do not.
    ("double_attack_rate", "Double Attack Rate", "offence"),
    ("magic_damage_received", "Magic Damage Received", "defence"),
    ("physical_damage_received", "Physical Damage Received", "defence"),
]

SIZES = ["small", "medium", "large", "all_sizes"]
STATUSES = ["freeze", "stun", "stone", "curse", "silence", "sleep",
            "blind", "poison_status", "bleeding", "confusion"]

ELEMENTS = ["neutral", "water", "earth", "fire", "wind", "poison",
            "holy", "dark", "ghost", "undead"]
RACES = ["formless", "undead_race", "brute", "plant", "insect", "fish",
         "demon", "demihuman", "angel", "dragon", "boss", "non_boss",
         "all_races"]

# Damage-against and resistance families are generated so every element and
# race gets an id without forty hand-written rows.
for _e in ELEMENTS:
    STATS.append((f"dmg_vs_{_e}", f"DMG vs {_e.title()}", "element_damage"))
    STATS.append((f"res_{_e}", f"{_e.title()} Resistance", "element_resist"))
    STATS.append((f"magic_dmg_{_e}", f"{_e.title()} Magic DMG", "element_damage"))
for _r in RACES:
    STATS.append((f"dmg_vs_race_{_r}", f"DMG vs {_r.replace('_', ' ').title()}",
                  "race_damage"))
    STATS.append((f"res_race_{_r}", f"Resistance vs {_r.replace('_', ' ').title()}",
                  "race_resist"))
for _s in SIZES:
    STATS.append((f"dmg_vs_size_{_s}", f"DMG vs {_s.replace('_', ' ').title()}",
                  "size_damage"))
    STATS.append((f"def_vs_size_{_s}", f"Defense vs {_s.replace('_', ' ').title()}",
                  "size_defence"))
    STATS.append((f"magic_vs_size_{_s}", f"Magic vs {_s.replace('_', ' ').title()}",
                  "size_damage"))
for _st in STATUSES:
    STATS.append((f"res_status_{_st}", f"{_st.replace('_status', '').title()} Resistance",
                  "status_resist"))

# Boolean properties, not quantities. They carry a value of 1 so they travel
# through the same machinery as everything else, but "Unbreakable Weapon +2"
# is meaningless -- two sources of it is still just unbreakable -- so the UI
# shows them as present or absent rather than as a total.
#
# Appended after the generated families on purpose: ids are positional, and
# inserting above would renumber every element and race.
FLAGS = [
    ("no_size_penalty", "No Size Penalty"),
    ("ignores_reflect", "Ignores Reflect Damage"),
    ("unbreakable_weapon", "Unbreakable Weapon"),
    ("unbreakable_armor", "Unbreakable Armor"),
    ("unstrippable_weapon", "Unstrippable Weapon"),
    ("unstrippable_armor", "Unstrippable Armor"),
    ("prevents_knockback", "Prevents Knockback"),
]
FLAG_KEYS = {key for key, _ in FLAGS}
for _k, _n_ in FLAGS:
    STATS.append((_k, _n_, "flag"))

# Magic damage against a race: "Physical and magic damage vs Demon +2%".
# Sizes already had a magic family and races did not, so the magic half of
# those lines had nowhere to go. Appended last, for the same reason as the
# flags: ids are positional.
for _r in RACES:
    STATS.append((f"magic_vs_race_{_r}", f"Magic vs {_r.replace('_', ' ').title()}",
                  "race_damage"))

# Resistance by range: "Ranged Damage Taken -5%", "Long Range Resistance +5%".
# Appended last, like the families above.
STATS.append(("res_melee", "Melee Resistance", "defence"))
STATS.append(("res_ranged", "Ranged Resistance", "defence"))

# HP and SP back per kill: "Recover 500 HP when killing an enemy". Sustain
# rather than pool, and for many builds the thing that pays their SP costs.
# Appended last, like the families above.
STATS.append(("hp_on_kill", "HP on Kill", "resource"))
STATS.append(("sp_on_kill", "SP on Kill", "resource"))

INDEX = {key: i for i, (key, _, _) in enumerate(STATS)}

# Stats that do not simply add up.
#
# Most bonuses stack, so summing is the right default. A skill level does
# not: two sources of Double Attack do not make a higher level, the better
# one wins, and the server caps it at 10. Summing them would inflate a
# damage figure rather than merely mis-state a stat, so the rule travels
# with the dataset instead of living in the UI.
STAT_RULES: dict[str, dict] = {
    "double_attack": {"combine": "max", "cap": 10},
}


def registry() -> list[dict]:
    return [{"id": i, "key": k, "name": n, "category": c, **STAT_RULES.get(k, {})}
            for i, (k, n, c) in enumerate(STATS)]


# --------------------------------------------------------------------------
# aliases
# --------------------------------------------------------------------------

def _duplicate_alias_keys() -> list[str]:
    """Alias keys written twice in the source.

    A dict literal takes the last one and drops the first without a word, so
    a duplicate means an alias that looks defined and does nothing. That is
    how "Double Attack Rate" spent a while resolving to the skill level
    instead of the chance. Checked against the source text because by the
    time the dict exists the evidence is gone.
    """
    try:
        text = Path(__file__).read_text(encoding="utf-8")
    except OSError:          # importable from a zip or a bundle
        return []
    block = re.search(r"^ALIASES.*?^}", text, re.M | re.S)
    if not block:
        return []
    seen, dupes = set(), []
    for key in re.findall(r'"([^"]+)"\s*:', block.group(0)):
        if key in seen:
            dupes.append(key)
        seen.add(key)
    return dupes


def _n(text: str) -> str:
    """Normalise a tooltip stat name for lookup."""
    t = text.strip().lower()
    t = re.sub(r"^(effect|bonus|special|innate)\s*:\s*", "", t)
    # "Bonus AGI +1" names AGI; the word is decoration, as it is in "HP Bonus".
    t = re.sub(r"^bonus\s+(?=\w)", "", t)
    t = re.sub(r"\s*\bbonus\b\s*$", "", t)
    t = re.sub(r"[.]+$", "", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


_NON_NEUTRAL = [f"res_{e}" for e in ELEMENTS if e != "neutral"]

# One phrase -> one or more canonical keys.
ALIASES: dict[str, list[str]] = {
    "str": ["str"], "agi": ["agi"], "vit": ["vit"],
    "int": ["int"], "dex": ["dex"], "luk": ["luk"],
    "all stats": ["str", "agi", "vit", "int", "dex", "luk"],
    "all stat": ["str", "agi", "vit", "int", "dex", "luk"],
    "stats": ["str", "agi", "vit", "int", "dex", "luk"],

    "hp": ["max_hp"], "max hp": ["max_hp"], "maxhp": ["max_hp"],
    "sp": ["max_sp"], "max sp": ["max_sp"], "maxsp": ["max_sp"],
    "hp/sp": ["max_hp", "max_sp"], "max hp/sp": ["max_hp", "max_sp"],
    "hp and sp": ["max_hp", "max_sp"],
    "hp regen": ["hp_regen"], "hp regeneration": ["hp_regen"],
    "sp regen": ["sp_regen"], "sp regeneration": ["sp_regen"],
    "hp/sp regen": ["hp_regen", "sp_regen"],
    "hp/sp regeneration": ["hp_regen", "sp_regen"],

    "atk": ["atk"], "attack": ["atk"],
    "matk": ["matk"], "magic attack": ["matk"],
    "atk/matk": ["atk", "matk"], "matk/atk": ["atk", "matk"],
    "hit": ["hit"], "perfect hit": ["perfect_hit"],
    "critical": ["crit_rate"], "critical rate": ["crit_rate"],
    "crit": ["crit_rate"], "critical chance": ["crit_rate"],
    "critical damage": ["crit_damage"], "critical dmg": ["crit_damage"],
    "aspd": ["aspd"], "attack speed": ["aspd"],
    "aspd limit": ["aspd_limit"],
    "attack range": ["attack_range"], "range": ["attack_range"],
    "splash range": ["splash_range"],
    "double attack lv": ["double_attack"], "double attack": ["double_attack"],
    "double attack rate": ["double_attack_rate"],
    "double attack chance": ["double_attack_rate"],
    "melee damage": ["melee_damage"], "melee dmg": ["melee_damage"],
    "ranged damage": ["ranged_damage"], "ranged dmg": ["ranged_damage"],
    "magic damage": ["magic_damage"], "magic dmg": ["magic_damage"],

    "def": ["def"], "defense": ["def"], "defence": ["def"],
    "mdef": ["mdef"], "magic defense": ["mdef"], "magic defence": ["mdef"],
    "def/mdef": ["def", "mdef"], "defense/magic defense": ["def", "mdef"],
    "flee": ["flee"], "perfect dodge": ["perfect_dodge"],
    "p. dodge": ["perfect_dodge"], "p.dodge": ["perfect_dodge"],
    "defense penetration": ["def_pen"], "defence penetration": ["def_pen"],
    "def pierce": ["def_pen"], "defense pierce": ["def_pen"],
    "magic defense penetration": ["mdef_pen"],
    "magic defence penetration": ["mdef_pen"],
    "mdef pierce": ["mdef_pen"],
    "defense/magic defense penetration": ["def_pen", "mdef_pen"],
    "damage reduction": ["damage_reduction"],
    "reflect melee damage": ["reflect_melee"],

    "cast time": ["cast_time"],
    "variable cast": ["variable_cast"], "variable cast time": ["variable_cast"],
    "fixed cast": ["fixed_cast"], "fixed cast time": ["fixed_cast"],
    # "All" names both halves at once, where a bare "Cast Time" is the
    # server's own general figure. Eight items say it and none of them
    # counted for anything until this was here.
    "all cast time": ["variable_cast", "fixed_cast"],
    "after cast delay": ["after_cast_delay"],
    "cooldown": ["cooldown"],

    "sp cost": ["sp_cost"], "sp consumption": ["sp_cost"],
    "sp cost reduction": ["sp_cost"],
    "attack sp cost": ["attack_sp_cost"],

    "move speed": ["move_speed"], "movement speed": ["move_speed"],
    "weight limit": ["weight_limit"],
    "exp": ["exp_gain"], "exp gain": ["exp_gain"],
    "healing power": ["healing_power"], "healing done": ["healing_power"],
    "heal power": ["healing_power"],
    "healing received": ["healing_received"],
    "leech power": ["leech_hp_power"], "leech rate": ["leech_hp_rate"],
    "hp leech power": ["leech_hp_power"], "hp leech rate": ["leech_hp_rate"],
    "sp leech power": ["leech_sp_power"], "sp leech rate": ["leech_sp_rate"],
    "leech": ["leech_hp_power"],

    # wording variants seen in the tooltips
    # Melee is also "short range", ranged also "long range"; each is one stat
    # under every name.
    "long range attack": ["ranged_damage"], "ranged attack": ["ranged_damage"],
    "long range damage": ["ranged_damage"], "long range dmg": ["ranged_damage"],
    "ranged atk": ["ranged_damage"], "long range atk": ["ranged_damage"],
    "melee attack": ["melee_damage"], "melee atk": ["melee_damage"],
    "short range damage": ["melee_damage"], "short range dmg": ["melee_damage"],
    "short-range damage": ["melee_damage"], "short range attack": ["melee_damage"],
    "melee physical damage": ["melee_damage"],
    # Damage taken from each range, as a resistance.
    "ranged resistance": ["res_ranged"], "long range resistance": ["res_ranged"],
    "ranged damage reduction": ["res_ranged"], "long range damage reduction": ["res_ranged"],
    "melee resistance": ["res_melee"], "short range resistance": ["res_melee"],
    "melee damage reduction": ["res_melee"], "short range damage reduction": ["res_melee"],
    "exp received": ["exp_gain"], "exp gained": ["exp_gain"],
    "flat defense": ["def"], "flat def": ["def"],
    "perfect hit rate": ["perfect_hit"],
    "sp recovery": ["sp_regen"], "hp recovery": ["hp_regen"],
    "potion healing power": ["potion_healing"],
    "item healing power": ["potion_healing"],
    "vengeance rate": ["vengeance_rate"],
    "magic damage received": ["magic_damage_received"],
    "physical damage received": ["physical_damage_received"],
    "critical rate total": ["crit_rate"],
    "attack speed limit": ["aspd_limit"],
    "cast delay": ["after_cast_delay"], "after-cast delay": ["after_cast_delay"],
    "def/mdef penetration": ["def_pen", "mdef_pen"],
    "defense/mdef penetration": ["def_pen", "mdef_pen"],
    "atk and matk": ["atk", "matk"], "atk & matk": ["atk", "matk"],
    "final damage reduction": ["damage_reduction"],
    "hit rate": ["hit"],
    "defense and magic defense penetration": ["def_pen", "mdef_pen"],
    "resistance to all elements": [f"res_{e}" for e in ELEMENTS],
    "all element resistance": [f"res_{e}" for e in ELEMENTS],
    # Every element but Neutral, in the wordings the tooltips use: Asprika's
    # "All non-neutral damage reduction +20%" was read and then dropped.
    "all non-neutral damage reduction": _NON_NEUTRAL,
    "non-neutral damage reduction": _NON_NEUTRAL,
    "non-neutral resistance": _NON_NEUTRAL,
    "all non-neutral resistance": _NON_NEUTRAL,
    "all elements (except neutral) resistance": _NON_NEUTRAL,
    # From the project owner: the natural elements are the four of the
    # world, the corporal ones the four of body and spirit (Ragged Manteau).
    "all natural elements resistance": ["res_fire", "res_water", "res_wind", "res_earth"],
    "all corporal elements resistance": ["res_ghost", "res_poison", "res_holy", "res_dark"],
    "all damage reduction": ["damage_reduction"],
    # Damage received, which is lower-is-better: the "Reduction" in the
    # wording flips the sign, so "Physical Reduction +10%" is -10% received.
    "physical reduction": ["physical_damage_received"],
    "physical damage reduction": ["physical_damage_received"],
    "magic reduction": ["magic_damage_received"],
    "magic damage reduction": ["magic_damage_received"],
    "bleed resistance": ["res_status_bleeding"],
    "hp on kill": ["hp_on_kill"], "sp on kill": ["sp_on_kill"],
    "healing done and received": ["healing_power", "healing_received"],
    "variable casting time": ["variable_cast"],
    "fixed casting time": ["fixed_cast"],

    # Flags. The tooltip writes them as a bare phrase with no value.
    "no size penalty": ["no_size_penalty"],
    "size penalty removed": ["no_size_penalty"],
    "ignores reflect damage": ["ignores_reflect"],
    "ignore reflect damage": ["ignores_reflect"],
    "unbreakable weapon": ["unbreakable_weapon"],
    "unbreakable armor": ["unbreakable_armor"],
    "unbreakable armour": ["unbreakable_armor"],
    "unstrippable weapon": ["unstrippable_weapon"],
    "unstrippable armor": ["unstrippable_armor"],
    "unstrippable armour": ["unstrippable_armor"],
    "prevents knockback": ["prevents_knockback"],
    "prevent knockback": ["prevents_knockback"],
}

_ALIAS_DUPES = _duplicate_alias_keys()
if _ALIAS_DUPES:
    raise AssertionError(
        "duplicate alias keys, the earlier definition is silently dead: "
        + ", ".join(sorted(set(_ALIAS_DUPES))))

_ELEMENT_WORDS = {
    "neutral": "neutral", "water": "water", "earth": "earth", "fire": "fire",
    "wind": "wind", "poison": "poison", "holy": "holy", "dark": "dark",
    "shadow": "dark", "ghost": "ghost", "undead": "undead",
}
_RACE_WORDS = {
    "formless": "formless", "brute": "brute", "plant": "plant",
    "insect": "insect", "fish": "fish", "demon": "demon",
    "demihuman": "demihuman", "demi-human": "demihuman", "angel": "angel",
    "human": "demihuman", "humans": "demihuman", "player": "demihuman",
    "dragon": "dragon", "boss": "boss", "bosses": "boss",
    # Kept whole: "undead" alone is the element, and trimming "race" off
    # would turn a race bonus into an element one.
    "undead race": "undead_race",
    "non-boss": "non_boss", "non boss": "non_boss", "nonboss": "non_boss",
    "all races": "all_races", "all race": "all_races",
}
_SIZE_WORDS = {
    "small": "small", "medium": "medium", "large": "large",
    "all sizes": "all_sizes", "all size": "all_sizes",
}
_STATUS_WORDS = {
    "freeze": "freeze", "freezing": "freeze", "stun": "stun", "stone": "stone",
    "curse": "curse", "silence": "silence", "sleep": "sleep", "blind": "blind",
    "poison": "poison_status", "bleeding": "bleeding", "confusion": "confusion",
}

# Stats where a smaller number is the better one, so "Reduction" in the
# wording means a negative value rather than a positive one. Kept in step
# with LOWER_IS_BETTER in sim/src/format.ts, which colours the same stats.
LOWER_IS_BETTER = {
    "sp_cost", "attack_sp_cost", "cast_time", "variable_cast", "fixed_cast",
    "after_cast_delay", "cooldown", "magic_damage_received",
    "physical_damage_received",
}

# "Defense vs All Sizes", "Attack vs Large", "Resistance vs Boss",
# "Physical DMG vs Small", "Magic DMG vs all sizes", "Resistance to Formless",
# "Physical and magic damage vs Demon", "Damage and Resistance vs All Sizes".
# "to" reads as "vs" ("Damage to Boss monsters"); "damage taken from" does
# not match, because it is the opposite quantity with the opposite sign.
_VS_GENERIC = re.compile(
    r"^(?P<what>(?:physical\s+and\s+magic(?:al)?|physical|magic(?:al)?|damage\s+and\s+"
    r"resistance)\s+(?:dmg|damage)?|attack|damage|dmg|defense|defence|magic|"
    r"resistance|resist)\s*(?:vs\.?|against|to)\s+(?P<target>.+)$")

# "DMG vs Fire/Water/Wind/Earth" names four at once.
_DMG_VS = re.compile(r"^(?:dmg|damage)\s+(?:vs\.?|against|to)\s+(?P<what>.+)$")
_RESIST = re.compile(r"^(?P<what>[\w\- ]+?)\s+(?:resistance|resist)$")
_ELEM_MAGIC = re.compile(r"^(?P<what>[\w\- ]+?)\s+magic\s+(?:dmg|damage)$")

# Suffixes that mark a per-skill modifier rather than a character stat.
_SKILL_SUFFIX = re.compile(
    r"\b(dmg|damage|sp cost|cooldown|cast time|lv|level|duration|chance)$", re.I)


def resolve(stat_text: str) -> dict:
    """Map a tooltip stat name onto canonical stat ids.

    Returns {"stat_ids": [...], "stat_keys": [...], "scope": ..., and for
    unmapped skill wording "skill": "<name>", "skill_metric": "<metric>"}.
    """
    if not stat_text:
        return {"stat_ids": [], "stat_keys": []}

    raw = _n(stat_text)
    out: dict = {"stat_ids": [], "stat_keys": []}

    # "Total DEF" / "Total Flee" are the same stat applied to the running
    # total rather than added to the base pool. Ragnarok stacks those
    # differently, so the distinction is kept.
    scope = None
    m = re.match(r"^total\s+(?P<rest>.+)$", raw)
    if m:
        scope = "total"
        raw = m.group("rest")

    keys = _lookup(raw)
    if keys:
        out["stat_keys"] = keys
        out["stat_ids"] = [INDEX[k] for k in keys if k in INDEX]
        if scope:
            out["scope"] = scope
        return out

    # Not a character stat: does it read as "<skill> <metric>"?
    m = _SKILL_SUFFIX.search(raw)
    if m:
        metric = m.group(1).lower()
        skill = raw[:m.start()].strip(" :-")
        if skill:
            out["skill"] = stat_text.strip()[:len(skill)].strip() or skill
            out["skill_metric"] = {"dmg": "damage", "damage": "damage",
                                   "lv": "level"}.get(metric, metric)
    return out


# --------------------------------------------------------------------------
# skill names
# --------------------------------------------------------------------------

_SKILLS_FILE = Path(__file__).resolve().parent.parent / "data" / "raw" / "skillnames.json"
_SKILL_CACHE: dict[str, str] | None = None

# Written the short way in tooltips; the skill list spells them out.
# "increase agi" is shortened past what squashing can recover -- the skill is
# "Increase Agility" -- so it stays written out. "back stab" used to be here
# mapping to "Backstab", which is not a spelling the server uses at all: its
# own list says "Back Stab", and the squashed match now reaches it from
# either spelling.
_SKILL_ALIASES = {"increase agi": "Increase Agility"}

# Misspelled in the tooltips themselves, and too far off for the squashed
# match to reach: a letter wrong rather than a space or a full stop. Each
# target is a name on the server's own skill list, checked before it was
# written here, and each was splitting one skill's total across two or
# three entries -- Shield Boomerang was landing in three places at once.
#
# Kept apart from the aliases above because the reason differs. Those are
# tooltips writing a real name the short way; these are tooltips getting a
# real name wrong.
_SKILL_TYPOS = {
    "shield boomerange": "Shield Boomerang",
    "shield boomerand": "Shield Boomerang",
    "thow molotov": "Throw Molotov",
    "illusion of vermillion": "Illusion of Vermilion",
}

# Words that mark a phrase as being about skills in general, or a group,
# rather than naming one: "All 4 skills Damage", "Thief Spells Damage".
_NOT_A_SKILL = re.compile(
    r"\d|^\(|\b(all|skills?|spells?|every|each|these|them|basic|immune)\b", re.I)


def _squash(name: str) -> str:
    """A skill name with everything a tooltip is careless about removed.

    Spacing, punctuation, case and a trailing plural, so "Hell Raiser",
    "Shadow Stab", "Mr Bombastic" and "King's Chain" reach Hellraiser,
    Shadowstab, Mr. Bombastic and King's Chains. Each of those was showing
    up as a second skill alongside the real one, splitting its total in two.

    The trailing "+" is kept, because on this server it is a different
    skill and not a flourish: Sonic Blow and Sonic Blow+ both exist, and
    eight pairs like them would collapse into each other without it. With
    it, all 445 skills squash to 445 distinct forms.
    """
    s = re.sub(r"[^a-z0-9+]", "", name.lower())
    plus = s.endswith("+")
    if plus:
        s = s[:-1]
    if s.endswith("s"):
        s = s[:-1]
    return s + ("+" if plus else "")


def _known_skills() -> tuple[dict[str, str], dict[str, str]]:
    """The crawled skill list, by exact lower-case name and by squashed form.

    The squashed index only holds forms that exactly one skill has, so a
    loose match can never silently pick between two real skills.
    """
    global _SKILL_CACHE
    if _SKILL_CACHE is None:
        exact: dict[str, str] = {}
        squashed: dict[str, str] = {}
        clashed: set[str] = set()
        try:
            import json
            data = json.loads(_SKILLS_FILE.read_text(encoding="utf-8"))
            for row in data.get("skills", []):
                name = row[0] if isinstance(row, list) else row
                if not isinstance(name, str):
                    continue
                exact[name.lower()] = name
                key = _squash(name)
                if key in squashed and squashed[key] != name:
                    clashed.add(key)
                squashed[key] = name
        except (OSError, ValueError):
            pass
        for key in clashed:
            squashed.pop(key, None)
        _SKILL_CACHE = (exact, squashed)
    return _SKILL_CACHE


def _one_skill(text: str) -> str | None:
    t = text.strip().lower()
    known, loose = _known_skills()
    for cand in (t, t[:-1] if t.endswith("s") else None):
        if cand and cand in known:
            return known[cand]
        if cand and cand in _SKILL_ALIASES:
            return _SKILL_ALIASES[cand]
        if cand and cand in _SKILL_TYPOS:
            return _SKILL_TYPOS[cand]
    # Nothing matched as written. Try again ignoring what a tooltip is
    # careless about, which is where the one-character splits come from.
    return loose.get(_squash(t))


def canonical_skills(skill_text: str) -> list[str]:
    """The skills one modifier names, spelled as the server spells them.

    "Freezing Spear and Wind Blades" is two skills, each getting the bonus;
    a name the list does not have ("Heal", "Auto Guard" -- skills outside
    this server's class trees) is kept as written. Phrases about skills in
    general ("All 4 skills") name nothing and return an empty list, so they
    stay in "Not counted" instead of becoming a skill called "All 4".
    """
    text = re.sub(r"\s+", " ", skill_text or "").strip(" :-")
    if not text:
        return []
    whole = _one_skill(text)
    if whole:
        return [whole]
    parts = [p for p in re.split(r"\s*(?:,|/|&|\band\b)\s*", text, flags=re.I) if p]
    if len(parts) > 1:
        named = [_one_skill(p) for p in parts]
        if all(named):
            return list(dict.fromkeys(named))
    if _NOT_A_SKILL.search(text) or len(text) > 32:
        return []
    return [" ".join(w if w.isupper() else w[:1].upper() + w[1:] for w in text.split())]


def _targets(text: str) -> list[str]:
    """Split "Fire/Water/Wind/Earth" into its parts, trimming noise words."""
    out = []
    for word in re.split(r"[/,]| and ", text):
        w = word.strip().lower()
        if re.fullmatch(r"undead\s+race", w):
            out.append("undead race")
            continue
        # Until nothing more comes off: "Dark element monsters" is two noise
        # words deep, and one pass left "dark element", which is no element.
        noise = re.compile(r"\s*\b(element|elemental|monsters?|race|type|size|enemies|"
                           r"enemy|targets?)\b\s*$")
        while noise.search(w):
            w = noise.sub("", w).strip()
        if not w:
            continue
        # "Damage vs Dragons" names the same race as "vs Dragon".
        if w not in _ELEMENT_WORDS and w not in _RACE_WORDS and w.endswith("s"):
            singular = w[:-1]
            if singular in _RACE_WORDS or singular in _ELEMENT_WORDS:
                w = singular
        out.append(w)
    return out


def _as_damage(word: str) -> str | None:
    if word in _ELEMENT_WORDS:
        return f"dmg_vs_{_ELEMENT_WORDS[word]}"
    if word in _SIZE_WORDS:
        return f"dmg_vs_size_{_SIZE_WORDS[word]}"
    if word in _RACE_WORDS:
        return f"dmg_vs_race_{_RACE_WORDS[word]}"
    return None


def _as_resist(word: str) -> str | None:
    if word in _ELEMENT_WORDS:
        return f"res_{_ELEMENT_WORDS[word]}"
    if word in _STATUS_WORDS:
        return f"res_status_{_STATUS_WORDS[word]}"
    if word in _RACE_WORDS:
        return f"res_race_{_RACE_WORDS[word]}"
    return None


def _vs_kinds(verb: str) -> list[str]:
    """Which families a "<verb> vs <target>" phrase adds to."""
    verb = verb.strip()
    if verb.startswith("damage and resistance"):
        return ["dmg", "resist"]
    if verb.startswith("physical and magic"):
        return ["dmg", "magic"]
    if verb.startswith("physical"):
        return ["dmg"]
    if verb.startswith("magic"):
        return ["magic"]
    if verb in ("resistance", "resist"):
        return ["resist"]
    if verb in ("defense", "defence"):
        return ["def"]
    return ["dmg"]


_ALL_ELEMENTS = ("all elements", "all element")


def _vs_keys(kinds: list[str], targets: list[str]) -> list[str]:
    """Every stat a phrase names, across its families and its targets.

    A target that one family has no stat for is skipped for that family
    only: "Defense vs Boss" is not a thing, "Resistance vs Boss" is.
    """
    out: list[str] = []
    for kind in kinds:
        for w in targets:
            if w in _ALL_ELEMENTS:
                prefix = {"dmg": "dmg_vs_", "magic": "magic_dmg_", "resist": "res_"}.get(kind)
                if prefix:
                    out.extend(f"{prefix}{e}" for e in ELEMENTS)
                continue
            if kind == "dmg":
                key = _as_damage(w)
            elif kind == "resist":
                # A size has no resistance of its own; "Defense vs Small" is
                # the stat the game keeps for it.
                key = (f"def_vs_size_{_SIZE_WORDS[w]}" if w in _SIZE_WORDS
                       else _as_resist(w))
            elif kind == "def":
                key = f"def_vs_size_{_SIZE_WORDS[w]}" if w in _SIZE_WORDS else None
            else:  # magic
                if w in _SIZE_WORDS:
                    key = f"magic_vs_size_{_SIZE_WORDS[w]}"
                elif w in _RACE_WORDS:
                    key = f"magic_vs_race_{_RACE_WORDS[w]}"
                elif w in _ELEMENT_WORDS:
                    key = f"magic_dmg_{_ELEMENT_WORDS[w]}"
                else:
                    key = None
            if key and key in INDEX and key not in out:
                out.append(key)
    return out


def _lookup(raw: str) -> list[str]:
    if raw in ALIASES:
        return ALIASES[raw]

    m = _DMG_VS.match(raw)
    if m:
        return _vs_keys(["dmg"], _targets(m.group("what")))

    m = _VS_GENERIC.match(raw)
    if m:
        return _vs_keys(_vs_kinds(m.group("what")), _targets(m.group("target")))

    m = _RESIST.match(raw)
    if m:
        keys = [_as_resist(w) for w in _targets(m.group("what"))]
        return [k for k in keys if k and k in INDEX]

    m = _ELEM_MAGIC.match(raw)
    if m:
        keys = [f"magic_dmg_{_ELEMENT_WORDS[w]}" if w in _ELEMENT_WORDS else None
                for w in _targets(m.group("what"))]
        return [k for k in keys if k and k in INDEX]

    return []
