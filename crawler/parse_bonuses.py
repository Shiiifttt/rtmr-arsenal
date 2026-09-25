#!/usr/bin/env python3
"""
Pull set bonuses and refine scaling out of item description text.

The server stores an item's mechanics as the tooltip a player reads, so
everything a damage calculation needs -- what a refine is worth, what a
set grants -- is prose. This module turns that prose into data.

Three things make it harder than a regex pass:

1. The text is hard-wrapped, and not on a character count: it is wrapped to
   the game's tooltip in a proportional font, so "reduced" can sit alone on
   a line inside a 26-column block. Rebuilding logical lines has to go on
   what a line *says*, not how wide it is. See unwrap().

2. Item refine and set refine are different numbers that read almost
   identically ("Per Refine:" vs "Per total set refine:"). Mixing them
   silently would corrupt every calculation downstream, so they are parsed
   by separate patterns and stored in separate places -- never merged.

3. Set membership is declared inside each member's own description rather
   than in a field, in two different syntaxes. Items are grouped by the set
   name they name themselves, and disagreements between members are
   reported rather than averaged away.

Anything not confidently parsed keeps its original text and is counted in
the report. A damage simulator built on quietly-wrong numbers is worse than
one that knows which items it cannot model yet.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import stat_registry

# --------------------------------------------------------------------------
# 1. rebuilding logical lines
# --------------------------------------------------------------------------

# A line that opens with any of these is finishing the line above it.
_CONTINUES = re.compile(r"^[a-z]|^[+\-,;)]|^\d+%|^and\b|^per\b|^or\b", re.I | re.A)
# A bare "10%" on its own line is a fragment of the line above; "10% chance
# to autocast Heal" is a new statement, so the digit rule only fires when
# the whole line is that fragment.
_CONTINUES_LOWER = re.compile(r"^[a-z]|^[+\-,;)]|^\d+%\s*[,.]?$")

# "... and" / "... from" / "... a" cannot be the end of a sentence.
_DANGLING = re.compile(
    r"[,(]$|\b(and|or|the|of|to|from|with|a|an|vs|by|per|at|in|for|on)$", re.I)

# A heading whose own payload got cut by the wrap:
#   "Set refine 18+: Fixed Cast" + "Time -0.1s"
# Only short tails qualify, and only when the tail does not already end in a
# value -- "Set refine 9+: ASPD Limit +1" is complete and must not swallow
# the line below it.
_CUT_HEADING_TAIL = re.compile(r":\s*(?P<tail>[^:]{1,15})$")
_ENDS_IN_VALUE = re.compile(r"[\d%]\s*(s|sec|secs|seconds?|min|mins)?\.?$", re.I)


def _starts_structure(line: str) -> bool:
    """Lines that always begin something new, never continue a line above."""
    return line.endswith(":") or bool(re.search(r"\bSet\b", line))


def _is_flag_phrase(line: str) -> bool:
    """A complete effect written with no value: "Ignores Reflect Damage".

    These are short and wordy, which is exactly the shape the width-forced
    join was built for, so without this they absorb whatever follows them.
    """
    text = line.strip().rstrip(".")
    if not text or re.search(r"\d", text):
        return False
    keys = stat_registry.resolve(text).get("stat_keys") or []
    return bool(keys) and all(k in stat_registry.FLAG_KEYS for k in keys)


def unwrap(desc: str) -> list[str]:
    """Rebuild logical lines from the tooltip's hard wrapping.

    The width test below is the one reliable structural signal. The block is
    wrapped greedily, so if the first word of a line would have fitted on the
    line above, that break was deliberate and the two are separate
    statements. If it would not have fitted, the break may be the wrap
    talking. That only *permits* a join -- a line above that already ends in
    a value ("Heal cooldown +10s") is complete, and the line below starts
    something new.

    It is necessary rather than sufficient: the pixel wrapping sometimes
    breaks earlier than a character count predicts, which is why the
    lowercase and dangling-word rules run first and catch those.
    """
    physical = [l.strip() for l in desc.split("\n")]
    width = max((len(l) for l in physical), default=0)

    out: list[str] = []
    last_physical = ""

    for line in physical:
        if not line:
            out.append("")
            last_physical = ""
            continue

        prev = out[-1] if out else ""
        joined = False

        # A heading owns its own line. Whatever follows is its payload and
        # is handled as a separate statement, never glued on -- otherwise
        # "Piece Bonus:" swallows the effect under it and the heading is lost.
        if prev.endswith(":"):
            out.append(line)
            last_physical = line
            continue

        if prev:
            words = line.split()
            first = words[0] if words else ""
            forced = bool(last_physical) and (
                len(last_physical) + 1 + len(first)) > width

            if _CONTINUES_LOWER.match(line):
                joined = True
            # "<Name> Set" / "Bonus:" split across the wrap.
            elif line == "Bonus:" and re.search(r"\bSet$", prev):
                joined = True
            elif _DANGLING.search(prev):
                joined = True
            elif not prev.endswith(":"):
                m = _CUT_HEADING_TAIL.search(prev)
                if m and not _ENDS_IN_VALUE.search(m.group("tail").strip()):
                    joined = True
                # A stat name split off from its value: "Defense/Magic
                # Defense" + "Penetration +1". Kept deliberately narrow --
                # a short fragment, no value in it, not a finished sentence.
                # "Armor is Holy Element" is four words and a complete
                # clause, and must not absorb the effect on the next line.
                #
                # The continuation must carry the value, which is the whole
                # reason for the join. Without that test two flags that
                # happen to be short and adjacent get welded together:
                # "No Size Penalty" + "Ignores Reflect Damage" is one line
                # that means nothing, where they are two effects.
                elif (forced
                      and re.search(r"\d", line)
                      and not re.search(r"\d", prev)
                      and len(prev.split()) <= 3
                      and not prev.endswith((".", "!", "?"))
                      and not _is_flag_phrase(prev)
                      and not _starts_structure(line)):
                    joined = True

        if joined:
            out[-1] = prev + " " + line
        else:
            out.append(line)
        last_physical = line
    return out


# --------------------------------------------------------------------------
# 2. separating mechanics from flavour
# --------------------------------------------------------------------------

# Lines that look like effects but carry nothing the planner can use, and
# nothing the item record does not already say.
#
#   "Requirement: None"  -- 448 of them, and the two that name something name
#                           a job, which `usable_by` already holds.
#   "Slotted" / "3 Slots" -- `card_slots` is a column.
#   "Color: ..."          -- cosmetic description of the sprite.
#
# Dropped at the line level rather than left to fail parsing, because an
# unparseable line is a claim that something is missing. These are not.
_NOISE = re.compile(
    r"^(?:requirement\s*:.*"
    r"|colou?r\s*:.*"
    r"|slotted\.?"
    # Written both ways: "3 Slots" and "Two Slots".
    r"|(?:\d+|one|two|three|four)\s+slots?\.?)$", re.I)
# "Job: Night Raven Color: Awakened" -- the job half is real, the colour is
# not, so the tail is cut rather than the whole line dropped.
_NOISE_TAIL = re.compile(r"\s*\bcolou?r\s*:.*$", re.I)


def strip_noise(lines: list[str]) -> list[str]:
    out: list[str] = []
    for line in lines:
        cut = _NOISE_TAIL.sub("", line).strip() if _NOISE_TAIL.search(line) else line
        if not cut or _NOISE.match(cut.strip()):
            # An emptied line still separates blocks, so it is kept blank
            # rather than removed, or two unrelated sections would merge.
            out.append("")
            continue
        out.append(cut)
    return out

# The lore paragraph is the trailing block of prose: sentences, no stat
# values. Keeping it out of the parser stops it generating phantom effects.
def split_lore(lines: list[str]) -> tuple[list[str], str | None]:
    blocks: list[list[str]] = [[]]
    for line in lines:
        if line:
            blocks[-1].append(line)
        elif blocks[-1]:
            blocks.append([])
    blocks = [b for b in blocks if b]
    if not blocks:
        return [], None

    last = blocks[-1]
    text = " ".join(last)
    is_lore = (
        len(blocks) > 1
        and not any(re.search(r"[+\-]\s*\d", l) for l in last)
        and not any(l.endswith(":") for l in last)
        and len(text) > 40
        and text.rstrip().endswith((".", "!", "?"))
    )
    if is_lore:
        return [l for b in blocks[:-1] for l in b], text
    return [l for b in blocks for l in b], None


# --------------------------------------------------------------------------
# 3. headings
# --------------------------------------------------------------------------

# Item refine. "Per Refine:", "Per 4 Refines:", "Every Refine:"
H_PER_REFINE = re.compile(r"^(?:per|every)\s*(?P<n>\d+)?\s*refines?\s*:$", re.I)
# Item refine threshold. "If Refine +10:", "Refine 7 or higher:", "If refine is +9:"
H_REFINE_AT = re.compile(
    r"^(?:if\s+)?refine\s*(?:is\s*)?\+?(?P<n>\d+)\s*(?:\+|or\s+(?:higher|above|more))?\s*:$",
    re.I)
# Set refine, scaling. "Per total set refine:", "Per 2 total set refines:", "Per Set Refine:"
H_PER_SET_REFINE = re.compile(
    r"^per\s*(?P<n>\d+)?\s*(?:total\s+)?set\s+refines?\s*:$", re.I)
# Set refine, threshold. "Set refine 18+:"
H_SET_REFINE_AT = re.compile(
    r"^(?:at\s+)?set\s+refine\s+\+?(?P<n>\d+)\s*\+?\s*:$", re.I)
# "At set refine 9+ and again at 18+:" â€” one bonus that applies twice.
H_SET_REFINE_AGAIN = re.compile(
    r"^at\s+set\s+refine\s+\+?(?P<a>\d+)\s*\+?\s*and\s+again\s+at\s+\+?(?P<b>\d+)\s*\+?\s*:$",
    re.I)

H_PIECE_BONUS = re.compile(r"^piece\s+bonus\s*:$", re.I)
H_INNATE = re.compile(r"^innate(?:\s+effects?)?\s*:$", re.I)
H_SET_BONUS_BARE = re.compile(r"^set\s+bonus\s*:$", re.I)
H_SET_NAMED = re.compile(r"^(?P<name>.+?)\s+set\s*:$", re.I)
H_SET_BONUS_NAMED = re.compile(r"^(?P<name>.+?)\s+set\s+bonus\s*:$", re.I)

# Inline refine scaling with no heading: "Critical +2 per refine",
# "HP+2% per 3 refines", "+0.1% ... per Refine Level."
# Shadow gear says "upgrade" for the same thing ("Damage vs Angel +2% per
# Upgrade"): its refine is what the tooltip elsewhere calls an upgrade.
INLINE_PER_REFINE = re.compile(
    r"\bper\s+(?P<n>\d+\s+)?(?:refine|upgrade)(?:\s+level)?s?\b\.?", re.I)
INLINE_PER_SET_REFINE = re.compile(
    r"\bper\s+(?P<n>\d+\s+)?(?:total\s+)?set\s+refines?\b\.?", re.I)
# A third scaling axis, and one a damage calculation has to keep apart from
# both refine numbers: "INT +1 per 5 base STR."
INLINE_PER_BASE_STAT = re.compile(
    r"\bper\s+(?P<n>\d+)\s+base\s+(?P<stat>STR|AGI|VIT|INT|DEX|LUK)\b\.?", re.I)

# "8% chance to leech 5% of damage dealt" -- one sentence, two stats. How
# often it fires and how much it returns come from different gear and stack
# separately, so they are split rather than collapsed into one number.
LEECH = re.compile(
    r"^(?P<rate>\d+(?:\.\d+)?)%?\s*(?:chance\s+)?to\s+(?:leech|drain)\s+"
    r"(?P<power>\d+(?:\.\d+)?)%\s*(?:of\s+)?(?P<rest>.*)$", re.I)

# Armour that overrides the wearer's element says so flatly, either alone
# ("Dark Element") or inside a set bonus ("Armor is Dark Element").
ELEMENT_SET = re.compile(
    r"^(?:armou?r\s+is\s+)?(?P<elem>neutral|water|earth|fire|wind|poison|holy|"
    r"dark|shadow|ghost|undead)\s+element\.?$", re.I)

# Conditions a character sheet can actually answer.
# "If Base AGI is over 98", "If INT is above 98", "If VIT is 99",
# "If Base VIT > 49", "If Base VIT < 50".
#
# "base" is optional because the server writes it both ways and means the
# same thing either way: a threshold on gear is checked against the points
# on the character sheet, never against the total the gear itself produced.
# Reading it as the total would let a bonus qualify itself.
REQ_BASE_STAT = re.compile(
    r"^(?:if\s+)?(?:base\s+)?(?P<stat>STR|AGI|VIT|INT|DEX|LUK)\s*"
    r"(?:is\s+)?(?P<op>over|above|at\s+least|under|below|>=|<=|>|<)?\s*"
    r"(?P<n>\d+)\s*(?:\+|or\s+(?:above|higher|more))?$", re.I)
REQ_BASE_LEVEL = re.compile(
    r"^(?:if\s+)?base\s+level\s*(?:is\s*)?(?P<n>\d+)\s*"
    r"(?:\+|or\s+(?:above|higher|more))?$", re.I)
# "Bonus AGI +1 if Base Stat is 50" -- the stat meant is the one the effect
# itself names, so the requirement is resolved after the effect is parsed.
REQ_INLINE_SELF = re.compile(
    r"^(?P<body>.+?),?\s+if\s+base\s+stat\s+is\s+(?P<n>\d+)\s*"
    r"(?:\+|or\s+(?:above|higher|more))?\.?$", re.I)


# "Every 9 base AGI gives you 1 extra AGI." -- the same scaling as
# "per 9 base AGI", written the other way round. Backwak shows the payload
# can be several effects: "...gives you 2 extra flat DEF and 1 Perfect Dodge".
# "ATK +1 every 20 flee" -- scaling off another stat's running total rather
# than off a base stat or a refine. A third axis, kept apart from the other
# two because it is read after everything else has been added up.
EVERY_N_STAT = re.compile(
    r"^(?P<body>.+?)\s+(?:every|per)\s+(?P<per>\d+)\s+(?P<stat>[A-Za-z][\w /]*?)\s*\.?$",
    re.I)

EVERY_N_BASE = re.compile(
    r"^every\s+(?P<per>\d+)\s+base\s+(?P<stat>STR|AGI|VIT|INT|DEX|LUK)\s+"
    r"gives?\s+you\s+(?P<rest>.+?)\.?$", re.I)
EXTRA_BIT = re.compile(
    r"^(?P<value>\d+(?:\.\d+)?)\s*(?:extra\s+)?(?:flat\s+)?(?P<stat>.+?)$", re.I)

# "For each base stat over 98:" / "Each Stat at 99:" -- the multiplier is how
# many of the six base stats clear the bar, not a refine or a single stat.
H_PER_STAT_COUNT = re.compile(
    r"^(?:for\s+)?each\s+(?:base\s+)?stat\s+"
    r"(?:over\s+(?P<over>\d+)|at\s+(?P<at>\d+)|of\s+(?P<of>\d+)\s*\+?)\s*:$", re.I)

# Not a stat at all: a note that the item accepts an enchant system.
ENCHANT_AVAILABLE = re.compile(
    r"^(?P<system>[\w' ]+?)\s+enchants?"
    r"(?:\s+and\s+(?P<refining>refining))?\s+available\.?$", re.I)
ENCHANT_PLAIN = re.compile(r"^(?P<system>[\w' ]+?)\s+enchantments?\.?$", re.I)


def parse_enchant(line: str) -> dict | None:
    """"Dream Enchants available" is a property of the item, not a bonus."""
    m = ENCHANT_AVAILABLE.match(line.strip())
    if m:
        return {"system": m.group("system").strip(),
                "refining": bool(m.group("refining")), "text": line.strip()}
    m = ENCHANT_PLAIN.match(line.strip())
    if m:
        return {"system": m.group("system").strip(), "refining": False,
                "text": line.strip()}
    return None


def parse_every_n_base(line: str) -> list[dict] | None:
    m = EVERY_N_BASE.match(line.strip())
    if not m:
        return None
    per, stat = int(m.group("per")), m.group("stat").upper()
    out: list[dict] = []
    for chunk in re.split(r"\s+and\s+|,\s*", m.group("rest")):
        bit = EXTRA_BIT.match(chunk.strip())
        if not bit:
            continue
        name = bit.group("stat").strip().rstrip(".")
        eff = {
            "text": line.strip(), "stat": name,
            "value": float(bit.group("value")), "unit": None, "parsed": True,
            "per_base_stat": {"per": per, "stat": stat},
        }
        if eff["value"].is_integer():
            eff["value"] = int(eff["value"])
        eff.update(stat_registry.resolve(name))
        out.append(eff)
    return out or None


def parse_requirement(text: str) -> dict | None:
    """Turn a condition heading into something the planner can evaluate."""
    t = text.strip().rstrip(":").strip()
    m = REQ_BASE_LEVEL.match(t)
    if m:
        return {"type": "base_level", "min": int(m.group("n"))}
    m = REQ_BASE_STAT.match(t)
    if m:
        op = (m.group("op") or "").strip().lower()
        n = int(m.group("n"))
        req = {"type": "base_stat", "stat": m.group("stat").upper()}
        # "over 98" is 99 and up; "under 50" is 49 and down. Getting this off
        # by one would hand out a bonus at exactly the threshold that the
        # server withholds, on the stats where people sit exactly on it.
        if op in ("under", "below", "<"):
            req["max"] = n - 1
        elif op == "<=":
            req["max"] = n
        elif op in ("over", "above", ">"):
            req["min"] = n + 1
        else:
            req["min"] = n
        return req
    return None


def _is_heading(line: str) -> bool:
    return line.rstrip().endswith(":")


# --------------------------------------------------------------------------
# 4. one effect
# --------------------------------------------------------------------------

EFFECT = re.compile(
    r"^(?P<stat>.*?[^\s+\-])\s*(?P<sign>[+\-])\s*(?P<value>\d+(?:\.\d+)?)\s*"
    r"(?P<unit>%|s\b|sec\b|secs\b|seconds?\b|min\b|mins\b)?\s*\.?$", re.I)
# "HP Bonus: +10%", "Leech Power: 4%", "Move Speed: 007%"
EFFECT_COLON = re.compile(
    r"^(?P<stat>[^:]+?)\s*:\s*(?P<sign>[+\-])?\s*(?P<value>\d+(?:\.\d+)?)\s*"
    r"(?P<unit>%|s\b|sec\b|seconds?\b)?\s*\.?$", re.I)
# "Fire Damage Taken", "Damage taken from Boss monsters", "Ranged Damage
# Taken", "Melee physical damage taken", "Long Range Damage Taken".
DAMAGE_TAKEN = re.compile(
    r"^(?:(?P<elem>[a-z\-]+(?:\s+range)?)\s+)?(?:physical\s+)?damage\s+taken"
    r"(?:\s+from\s+(?P<target>.+))?$", re.I)
# "Ranged Damage Taken" reads as a resistance by range, not by element.
_RANGE_TAKEN = {"ranged": "Ranged Resistance", "long range": "Ranged Resistance",
                "melee": "Melee Resistance", "short range": "Melee Resistance",
                "short-range": "Melee Resistance",
                # "Final Damage Taken -5%" is Final Damage Reduction +5%.
                "final": "Final Damage Reduction"}

# HP and SP back per kill. "Recover 500 HP when killing an enemy.", "Recover
# 50 HP and 5 SP per kill.", "Regain 3 SP on kill", "On kill: recover 20 HP
# and 2 SP per refine." Kills with magic only, or scaled by base level, are
# left alone: those are a condition and a formula, not an amount.
KILL_RECOVER = re.compile(
    r"^(?P<prefix>on\s+kill\s*:\s*)?(?:recovers?|regains?|regens?|restores?)\s+"
    r"(?P<a>\d+)\s*(?P<pa>hp|sp)(?:\s*(?:and|/)\s*(?P<b>\d+)\s*(?P<pb>hp|sp))?"
    r"(?P<when>\s+(?:when\s+killing\s+(?:an?\s+)?(?:enemy|enemies|monsters?)|per\s+kill|"
    r"on\s+kill|when\s+(?:an?\s+)?(?:enemy|monster)\s+is\s+killed))?"
    r"(?P<refine>\s+per\s+refine)?\s*\.?$", re.I)
# "SP 15 per kill".
KILL_SHORT = re.compile(r"^(?P<pa>hp|sp)\s*\+?\s*(?P<a>\d+)\s+per\s+kill\s*\.?$", re.I)
# Wyrdbrand, after its two kill lines: "Amount increases by 100HP/5SP per Refine."
KILL_REFINE = re.compile(
    r"^amount\s+increases\s+by\s+(?P<a>\d+)\s*(?P<pa>hp|sp)\s*(?:/|and)\s*"
    r"(?P<b>\d+)\s*(?P<pb>hp|sp)\s+per\s+refine\s*\.?$", re.I)


def parse_kill_recover(line: str) -> list[dict] | None:
    """HP and SP recovered per kill, as the two stats they are."""
    text = line.strip()
    m = KILL_RECOVER.match(text)
    per_refine = None
    if m:
        # "Recover 10 HP" alone is regen or a proc; only a kill says it is this.
        if not (m.group("prefix") or m.group("when")):
            return None
        per_refine = 1 if m.group("refine") else None
    else:
        m = KILL_SHORT.match(text) or KILL_REFINE.match(text)
        if not m:
            return None
        per_refine = 1 if KILL_REFINE.match(text) else None
    groups = m.groupdict()
    out = []
    for value, pool in ((groups.get("a"), groups.get("pa")), (groups.get("b"), groups.get("pb"))):
        if not value:
            continue
        stat = f"{pool.upper()} on Kill"
        eff = {"text": text, "stat": stat, "value": int(value), "unit": None, "parsed": True,
               **stat_registry.resolve(stat)}
        if per_refine:
            eff["per_refine"] = per_refine
        out.append(eff)
    return out or None
# "Reflects 5% Melee Damage", "Reflect 10% short-range physical damage".
REFLECT = re.compile(
    r"^reflects?\s+(?P<value>\d+(?:\.\d+)?)%\s+(?:of\s+)?(?:melee|short[\s-]range)"
    r"(?:\s+physical)?\s+damage(?:\s+taken)?\.?$", re.I)
# "+4% Move Speed" -- the value written before the stat. Only trusted when the
# stat resolves, because this shape is also how prose opens ("+1% chance of
# dropping Shadow Ore", "+1 more per refine").
EFFECT_PREFIX = re.compile(
    r"^(?P<sign>[+\-])?\s*(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>%)?\s+"
    r"(?P<stat>[A-Za-z][A-Za-z /']*?)\s*\.?$")


def parse_effect(text: str, per_refine: int | None = None,
                 per_set_refine: int | None = None) -> dict:
    """Structure one effect line, keeping the original text either way."""
    body = text.strip()

    # Strip the inline "per refine" tail so the value can be read, and let it
    # set the scaling if a heading has not already done so.
    m = INLINE_PER_SET_REFINE.search(body)
    if m:
        if per_set_refine is None:
            per_set_refine = int((m.group("n") or "1").strip())
        body = INLINE_PER_SET_REFINE.sub("", body).strip(" .,")
    else:
        m = INLINE_PER_REFINE.search(body)
        if m:
            if per_refine is None:
                per_refine = int((m.group("n") or "1").strip())
            body = INLINE_PER_REFINE.sub("", body).strip(" .,")

    per_base_stat = None
    m = INLINE_PER_BASE_STAT.search(body)
    if m:
        per_base_stat = {"per": int(m.group("n")), "stat": m.group("stat").upper()}
        body = INLINE_PER_BASE_STAT.sub("", body).strip(" .,")

    eff: dict = {"text": text.strip()}
    if per_refine is not None:
        eff["per_refine"] = per_refine
    if per_set_refine is not None:
        eff["per_set_refine"] = per_set_refine
    if per_base_stat is not None:
        eff["per_base_stat"] = per_base_stat

    hit = EFFECT.match(body) or EFFECT_COLON.match(body)
    if not hit:
        prefix = EFFECT_PREFIX.match(body)
        if prefix and stat_registry.resolve(prefix.group("stat")).get("stat_ids"):
            hit = prefix
    if hit:
        g = hit.groupdict()
        sign = -1 if g.get("sign") == "-" else 1
        unit = (g.get("unit") or "").lower().rstrip(".")
        unit = {"sec": "s", "secs": "s", "second": "s", "seconds": "s",
                "mins": "min"}.get(unit, unit)
        stat_text = g["stat"].strip().rstrip(":").strip()
        eff.update({
            "stat": stat_text,
            "value": sign * float(g["value"]),
            "unit": unit or None,
            "parsed": True,
        })
        if eff["value"].is_integer():
            eff["value"] = int(eff["value"])
        # Resolve the wording onto canonical stat ids so the arsenal can add
        # equipment up without re-reading the text.
        eff.update(stat_registry.resolve(stat_text))
        # "SP Cost Reduction: 18%" is SP Cost -18%: the same quantity seen
        # from the other side, like "Damage Taken" below. Only where a
        # smaller number is the better one -- "Ranged Damage Reduction"
        # resolves to a resistance, which is a stat of its own where more is
        # simply more, and must not be flipped.
        keys = set(eff.get("stat_keys") or [])
        if (eff["value"] > 0 and keys and keys <= stat_registry.LOWER_IS_BETTER
                and re.search(r"\breduction\b", stat_text, re.I)):
            eff["value"] = -eff["value"]
        if eff.get("skill") and not eff.get("stat_ids"):
            # Which skills, by their proper names, so bonuses to one skill
            # from different items can be added up as one figure.
            eff["skills"] = stat_registry.canonical_skills(eff["skill"])
            if eff.get("unit") == "min":
                eff["value"] = eff["value"] * 60
                eff["unit"] = "s"
        taken = DAMAGE_TAKEN.match(stat_text)
        if not eff.get("stat_ids") and taken:
            # "Fire Damage Taken -2%" is Fire Resistance +2%: the same number
            # seen from the other side, so the sign flips with the wording.
            target = taken.group("elem") or taken.group("target")
            by_range = _RANGE_TAKEN.get((target or "").lower())
            resist = (stat_registry.resolve(by_range) if by_range
                      else stat_registry.resolve(f"Resistance vs {target}") if target else {})
            if resist.get("stat_ids") and eff.get("unit") == "%":
                eff.update(resist)
                eff["value"] = -eff["value"]
                eff["stat"] = f"Resistance vs {target}"
    else:
        eff["parsed"] = False
    return eff


def split_effects(line: str) -> list[str]:
    """"MaxHP +500, DEF +30, MDEF +5" is three effects, not one.

    Only split on a comma when what follows also carries a value, so
    "Damage against all races +10%, Max HP/SP -10%" splits but a prose
    clause with a comma in it does not.
    """
    # Commas and full stops both separate effects ("ATK -2. MATK -2."), but
    # only split when what follows carries a value of its own, so ordinary
    # prose and decimal points stay intact.
    # The full stop must follow a value to count as a separator. "ATK -2.
    # MATK -2." is two effects; "Water Element Resist. +10%" is one, with an
    # abbreviation in the middle of it.
    parts = [p.strip(" .") for p in
             re.split(r"(?:,|(?<=[%\d])\.\s)\s*(?=[^,]*?[+\-]\s*\d)", line)
             if p.strip(" .")]
    return parts if len(parts) > 1 else [line]


# "+1% per 10 base STR" on its own names no stat: it is a second clause about
# the stat named before the comma ("Max SP +1%, +1% per 10 base STR").
_BARE_VALUE = re.compile(r"^[+\-]\s*\d")

# The same thing a line later rather than a comma later:
#
#   Defense Penetration +5,        Ranged Attack +5%
#   +1 more per refine             Extra 1% per refine
#
# The continuation gives a number and no stat, so read alone it is either
# unparseable or -- worse -- a stat called "Extra". It means more of what the
# line above named. Matched against the line with its "per refine" phrase
# already taken off, so what is left has to be the quantity and nothing else:
# that is what keeps "3% per refine chance to autocast Lv1 Heal when hit" out,
# which is a proc chance rather than a second clause about a stat.
#
# "for all" reaches back over the whole run of stat lines above it rather than
# just the last one -- Dream Shoes writes three, then "Extra 1% per refine for
# all".
_CARRY_OVER = re.compile(
    r"^(?:extra\s+|an\s+extra\s+)?"
    r"(?P<sign>[+\-])?\s*(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>%)?"
    r"(?:\s+more)?(?P<all>\s+for\s+all)?\s*\.?$", re.I)


def parse_leech(line: str) -> list[dict] | None:
    """Split a leech sentence into its chance and its amount."""
    m = LEECH.match(line.strip())
    if not m:
        return None
    rest = m.group("rest").lower()
    pool = "SP" if re.search(r"\bsp\b", rest) else "HP"
    return [
        {"text": line.strip(), "stat": f"{pool} Leech Rate",
         "value": float(m.group("rate")), "unit": "%", "parsed": True,
         **stat_registry.resolve(f"{pool} Leech Rate")},
        {"text": line.strip(), "stat": f"{pool} Leech Power",
         "value": float(m.group("power")), "unit": "%", "parsed": True,
         **stat_registry.resolve(f"{pool} Leech Power")},
    ]


def parse_element(line: str) -> dict | None:
    """An armour piece that overrides the wearer's element."""
    m = ELEMENT_SET.match(line.strip())
    if not m:
        return None
    elem = m.group("elem").capitalize()
    if elem == "Shadow":
        elem = "Dark"
    return {"text": line.strip(), "parsed": True, "sets_element": elem,
            "stat_ids": [], "stat_keys": []}


def parse_flag(line: str) -> dict | None:
    """A property written as a bare phrase: "Unbreakable Weapon".

    There is no number to read, so it is carried as a value of 1 against a
    flag stat. Without this it fails parsing and is reported as missing,
    which is wrong twice over: the effect is real and the planner does know
    what it means.
    """
    text = line.strip().rstrip(".")
    if not text or re.search(r"\d", text):
        return None
    resolved = stat_registry.resolve(text)
    keys = resolved.get("stat_keys") or []
    if not keys or not all(k in stat_registry.FLAG_KEYS for k in keys):
        return None
    return {
        "text": line.strip(), "stat": text, "value": 1, "unit": None,
        "parsed": True, "flag": True,
        "stat_ids": resolved["stat_ids"], "stat_keys": keys,
    }


def parse_every_n_stat(line: str) -> list[dict] | None:
    """"ATK +1 every 20 flee" -- one step per 20 points of the flee total.

    Deliberately narrow. The stat scaled off has to resolve to exactly one
    non-base stat, and the effect itself has to parse on its own, or the
    line is left alone: "every" turns up in plenty of prose that is not
    this, and a wrong reading here multiplies a bonus rather than dropping
    it.
    """
    m = EVERY_N_STAT.match(line.strip())
    if not m:
        return None
    source = stat_registry.resolve(m.group("stat"))
    keys = source.get("stat_keys") or []
    if len(keys) != 1 or keys[0] in ("str", "agi", "vit", "int", "dex", "luk"):
        # Base stats have their own axis, which reads the character sheet
        # rather than the running total. Sending them here would let a
        # bonus scale off a bonus.
        return None

    effects = parse_line(m.group("body"))
    if not effects or not all(e.get("parsed") and e.get("stat_ids") for e in effects):
        return None
    for eff in effects:
        eff["per_stat"] = {"per": int(m.group("per")), "stat": keys[0]}
        eff["text"] = line.strip()
    return effects


def parse_line(line: str) -> list[dict]:
    flag = parse_flag(line)
    if flag:
        return [flag]
    enchant = parse_enchant(line)
    if enchant:
        return [{"text": line.strip(), "parsed": True, "enchant": enchant,
                 "stat_ids": [], "stat_keys": []}]
    every = parse_every_n_base(line)
    if every:
        return every
    every_stat = parse_every_n_stat(line)
    if every_stat:
        return every_stat
    leech = parse_leech(line)
    if leech:
        return leech
    kill = parse_kill_recover(line)
    if kill:
        return kill
    element = parse_element(line)
    if element:
        return [element]
    m = REFLECT.match(line.strip())
    if m:
        value = float(m.group("value"))
        return [{"text": line.strip(), "stat": "Reflect Melee Damage",
                 "value": int(value) if value.is_integer() else value, "unit": "%",
                 "parsed": True, **stat_registry.resolve("Reflect Melee Damage")}]

    # "Bonus AGI +1 if Base Stat is 50" -- parse the effect, then attach the
    # requirement to whichever stat the effect turned out to name.
    m = REQ_INLINE_SELF.match(line.strip())
    if m:
        effects = parse_line(m.group("body"))
        for eff in effects:
            keys = eff.get("stat_keys") or []
            primary = next((k for k in keys
                            if k in ("str", "agi", "vit", "int", "dex", "luk")), None)
            if primary:
                eff["requires"] = {"type": "base_stat", "stat": primary.upper(),
                                   "min": int(m.group("n"))}
                eff["text"] = line.strip()
        return effects

    out: list[dict] = []
    carried: dict | None = None
    for part in split_effects(line):
        eff = parse_effect(part)
        if _BARE_VALUE.match(part.strip()) and carried and not eff.get("stat"):
            eff = inherit_stat(eff, carried) or eff
        # The source keeps its place while continuations attach to it, so a
        # second clause inherits the stat *and* the sign of the real line.
        if eff.get("stat") and not eff.get("stat_inherited"):
            carried = eff
        out.append(eff)
    return _drop_zeroes(out)


def _scaling_stripped(text: str) -> str:
    """One effect line with its "per refine" / "per 5 base STR" tail taken off.

    What is left is the quantity the line is actually about, which is what
    decides whether the line is a bare continuation or prose of its own.
    """
    for pattern in (INLINE_PER_SET_REFINE, INLINE_PER_REFINE, INLINE_PER_BASE_STAT):
        if pattern.search(text):
            text = pattern.sub("", text)
    return text.strip(" .,")


def inherit_stat(eff: dict, src: dict) -> dict | None:
    """One bare-value clause, given the stat from the clause before it.

    The inherited line is composed back into tooltip wording and put through
    the parser again rather than having its ids copied across, so the stat
    resolves exactly once, in one place.

    The sign comes from the source where the continuation does not give one,
    because "extra 1%" means one percent more of what was just said -- and
    what was just said may be a reduction. Dream Shoes writes "After Cast
    Delay -5% / ASPD +5% / Variable Cast Time -5% / Extra 1% per refine for
    all", where a literal +1% would be wrong on two lines out of three.

    Returns None when there is nothing sound to inherit, and the caller
    leaves the line as it found it.
    """
    m = _CARRY_OVER.match(_scaling_stripped(eff["text"]))
    if not m or not src.get("stat"):
        return None
    sign = m.group("sign") or ("-" if (src.get("value") or 0) < 0 else "+")
    out = parse_effect(f"{src['stat']} {sign}{m.group('value')}{m.group('unit') or ''}")
    if not out.get("parsed") or not out.get("stat_ids"):
        return None
    out["text"] = eff["text"]
    out["stat_inherited"] = True
    # The scaling belongs to the continuation, not to the line it took its
    # stat from: "+1 more per refine" scales, "Defense Penetration +5" does
    # not.
    for carry in ("per_refine", "per_set_refine", "per_base_stat"):
        if carry in eff:
            out[carry] = eff[carry]
    return out


def carries_to_all(text: str) -> bool:
    """Does this continuation reach back over every stat line above it?"""
    m = _CARRY_OVER.match(_scaling_stripped(text))
    return bool(m and m.group("all"))


def carry_over(effects: list[dict], run: list[dict]) -> list[dict]:
    """Give a bare "Extra 1% per refine" the stat from the line above it.

    `run` is the unbroken row of stat-naming lines immediately above this
    one; anything that is not one clears it, so a continuation can only ever
    attach to lines it actually follows.
    """
    out: list[dict] = []
    for eff in effects:
        if eff.get("parsed") or not run:
            out.append(eff)
            continue
        sources = run if carries_to_all(eff["text"]) else run[-1:]
        made = [made_eff for made_eff in
                (inherit_stat(eff, src) for src in sources) if made_eff]
        out.extend(made or [eff])
    return out


def stat_run(effects: list[dict], previous: list[dict]) -> list[dict]:
    """The row of stat-naming lines a continuation may attach to.

    Consecutive stat lines build the row up, because "for all" reaches back
    over all of them. A line that inherited its stat leaves the row as it
    is, so two continuations in a row both reach the same place. Anything
    else -- prose, a flag, a blank line, an unreadable line -- breaks it,
    which is what stops a number picking up a stat from further up the
    tooltip than the lines it follows.
    """
    named = [e for e in effects if e.get("parsed") and e.get("stat")
             and e.get("stat_ids") and not e.get("stat_inherited")]
    if named:
        return previous + named
    return previous if any(e.get("stat_inherited") for e in effects) else []


def _drop_zeroes(effects: list[dict]) -> list[dict]:
    """Discard effects that parsed cleanly to nothing.

    The tooltips pad their stat block with the stats an item does not have:
    "HP Bonus: +00%", "Perfect Dodge: 000", "Auto Guard Lv: 0". These read
    as real lines and parse perfectly, so without this the hover promises
    "Max HP +0%" -- worse than silence, because it looks like a bonus.

    Only fully-parsed numeric effects are dropped. A line that failed to
    parse still says something nobody has read yet, and a flag carries a
    value of 1 rather than 0, so neither is touched.
    """
    return [e for e in effects
            if not (e.get("parsed") and e.get("value") == 0 and not e.get("flag"))]


# --------------------------------------------------------------------------
# 5. walking one description
# --------------------------------------------------------------------------

def slugify(name: str) -> str:
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    out = "".join(c.lower() if c.isalnum() else "-" for c in n)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def _new_block(result: dict, name: str | None) -> dict:
    block = {
        "name": name,
        "members_text": None,
        "bonus": [],
        "set_refine": {"per_set_refine": [], "thresholds": []},
    }
    result["set_blocks"].append(block)
    return block


def parse_description(desc: str) -> dict:
    lines, lore = split_lore(strip_noise(unwrap(desc)))

    result = {
        "base": [],                 # effects with no condition
        "item_refine": {"per_refine": [], "thresholds": []},
        # An item can sit in more than one set -- the Undershirt pairs with
        # both the Black Shirt and the Pink Shirt, for different bonuses --
        # so these are collected as a list rather than one name.
        "set_blocks": [],
        "piece_bonus": [],
        # Not a bonus: which enchant system, if any, the item accepts.
        "enchant": None,
        "set_refine": {"per_set_refine": [], "thresholds": []},
        "conditional": [],          # "If Refine +10:" handled above; this is
                                    # everything else ("With Bullhorn Armor:")
        "lore": lore,
        "unparsed": [],
    }

    # section: where plain effect lines currently land
    section = "base"
    pending_cond: dict | None = None
    # Which refine number the open section is counting. An inline "per 2
    # refines" means *set* refines when it sits under "Per total set refine:",
    # and item refines everywhere else. Reading it the wrong way would put a
    # set-wide bonus on a single piece, so the scope is tracked explicitly.
    pending_scope: str | None = None
    current_block: dict | None = None
    last_stat: str | None = None
    # The row of stat lines a bare "Extra 1% per refine" may attach to.
    carry_run: list[dict] = []
    expect_members = False

    for line in lines:
        # Cleared at the top of every line and put back only by the body-line
        # branch below, so a continuation can only ever attach to the body
        # line directly above it. A blank line, a heading, a condition -- any
        # of them ends the run, because none of them is a clause a number can
        # be a second half of. Fallen Sword is why: it writes "Magic Defense
        # Penetration:" and then "10" on the next line, and without this the
        # wrapped value reads as more of the Defense Penetration above it.
        carry_from, carry_run = carry_run, []
        if not line:
            continue

        # A heading carrying its own payload -- "Set refine 9+: ASPD Limit +1".
        # These do not end in a colon, so they must be recognised here rather
        # than in the heading branch below, or the condition is lost and the
        # whole phrase gets read as a stat name.
        sr = current_block["set_refine"] if current_block else result["set_refine"]
        head, sep, tail = line.partition(":")
        if sep and tail.strip() and parse_description_headline(
                head + ":", tail.strip(), result, sr):
            expect_members = False
            pending_cond = None
            continue

        # "Base Level 130 or higher: ATK +5%" on one line. Without this the
        # whole phrase is read as a stat name and the condition is lost.
        if sep and tail.strip():
            requires = parse_requirement(head)
            if requires:
                result["conditional"].append({
                    "condition": head.strip(), "requires": requires,
                    "effects": parse_line(tail.strip()),
                })
                expect_members = False
                pending_cond = None
                continue

        if _is_heading(line):
            expect_members = False
            pending_cond = None

            m = H_SET_BONUS_NAMED.match(line)
            if m and not H_PIECE_BONUS.match(line):
                current_block = _new_block(result, m.group("name").strip())
                section = "set_bonus"
                continue
            if H_SET_BONUS_BARE.match(line):
                # A bare "Set Bonus:" belongs to the "<Name> Set:" heading
                # above it; only invent a block if there was none.
                if current_block is None:
                    current_block = _new_block(result, None)
                section = "set_bonus"
                continue
            if H_PIECE_BONUS.match(line):
                section = "piece_bonus"
                continue
            if H_INNATE.match(line):
                # A rune's permanent bonus, not a condition on it. Read as
                # plain effects, so "per Upgrade" lines still find the
                # refine bucket instead of sitting in "Not counted".
                section = "base"
                continue

            m = H_SET_NAMED.match(line)
            if m:
                current_block = _new_block(result, m.group("name").strip())
                # The line after a "<Name> Set:" heading names the pieces.
                expect_members = True
                section = "set_members"
                continue

            m = H_SET_REFINE_AGAIN.match(line)
            if m:
                pending_cond = {"kind": "set_refine_threshold",
                                "at": [int(m.group("a")), int(m.group("b"))],
                                "note": "applies again at the higher step",
                                "effects": []}
                sr["thresholds"].append(pending_cond)
                section, pending_scope = "pending", "set"
                continue

            m = H_SET_REFINE_AT.match(line)
            if m:
                pending_cond = {"kind": "set_refine_threshold",
                                "at": [int(m.group("n"))], "effects": []}
                sr["thresholds"].append(pending_cond)
                section, pending_scope = "pending", "set"
                continue

            m = H_PER_SET_REFINE.match(line)
            if m:
                pending_cond = {"per": int(m.group("n") or 1), "effects": []}
                sr["per_set_refine"].append(pending_cond)
                section, pending_scope = "pending", "set"
                continue

            m = H_PER_STAT_COUNT.match(line)
            if m:
                # "over 98" and "at 99" describe the same bar from either
                # side; store the lowest qualifying value so the count rule
                # is one comparison.
                over, at, of = m.group("over"), m.group("at"), m.group("of")
                low = int(over) + 1 if over else int(at or of)
                pending_cond = {"condition": line.rstrip(":").strip(),
                                "per_stat_count": {"min": low}, "effects": []}
                result["conditional"].append(pending_cond)
                section, pending_scope = "pending", "other"
                continue

            m = H_REFINE_AT.match(line)
            if m:
                pending_cond = {"kind": "refine_threshold",
                                "at": [int(m.group("n"))], "effects": []}
                result["item_refine"]["thresholds"].append(pending_cond)
                section, pending_scope = "pending", "item"
                continue

            m = H_PER_REFINE.match(line)
            if m:
                pending_cond = {"per": int(m.group("n") or 1), "effects": []}
                # Under a set bonus heading, "Per 4 Refines:" counts the set's
                # combined refines and pays out only once the set is whole --
                # the same thing H_PER_SET_REFINE says in words, written
                # without the word "set" because the heading above already
                # said it.
                #
                # Read as the piece's own refine it was wrong three ways over:
                # every member of these shadow sets repeats the whole set
                # block, so the bonus applied four times, off four separate
                # refine numbers, and without the set needing to be complete
                # at all.
                if current_block is not None and section in (
                        "set_bonus", "set_bonus_wait", "set_members"):
                    sr["per_set_refine"].append(pending_cond)
                    section, pending_scope = "pending", "set"
                else:
                    result["item_refine"]["per_refine"].append(pending_cond)
                    section, pending_scope = "pending", "item"
                continue

            # A heading with its payload on the same line:
            #   "Set refine 9+: ASPD Limit +1"
            head, sep, tail = line.partition(":")
            if sep and tail.strip():
                sub = parse_description_headline(head + ":", tail.strip(), result)
                if sub:
                    section = "base"
                    continue

            # Anything else ("With Bullhorn Armor:", "Core:", "Dragon Soul:")
            condition = line.rstrip(":").strip()
            pending_cond = {"condition": condition, "effects": []}
            requires = parse_requirement(condition)
            if requires:
                pending_cond["requires"] = requires
            result["conditional"].append(pending_cond)
            section, pending_scope = "pending", "other"
            continue

        # ---- a body line -------------------------------------------------
        if expect_members:
            if current_block is not None:
                current_block["members_text"] = line
            expect_members = False
            section = "set_bonus_wait"
            continue

        # A line that gives a number and no stat is a second clause about the
        # line above it, so it is resolved before anything is filed away.
        line_effects = carry_over(parse_line(line), carry_from)
        carry_run = stat_run(line_effects, carry_from)

        for eff in line_effects:
            # An enchant note is a property of the item; lift it out rather
            # than letting it sit in the totals as an unreadable "effect".
            if eff.get("enchant"):
                result["enchant"] = eff["enchant"]
                continue

            # "Critical Rate +3" / "Extra +1 per refine" -- "Extra" means
            # more of whatever was named on the line before, so it inherits
            # that stat rather than becoming a stat called "Extra".
            if eff.get("stat", "").strip().lower() in ("extra", "an extra") and last_stat:
                inherited = parse_effect(eff["text"])
                inherited.update(stat_registry.resolve(last_stat))
                inherited["stat"] = last_stat
                inherited["stat_inherited"] = True
                for carry in ("per_refine", "per_set_refine", "per_base_stat"):
                    if carry in eff:
                        inherited[carry] = eff[carry]
                eff = inherited
            elif eff.get("stat") and eff.get("parsed"):
                last_stat = eff["stat"]

            target = None
            if section == "pending" and pending_cond is not None:
                # Under a set-refine heading, a bare "per 2 refines" counts
                # set refines. Re-label it so no set-wide scaling can ever
                # be mistaken for the refine on one piece.
                if pending_scope == "set" and "per_refine" in eff:
                    n = eff.pop("per_refine")
                    eff["per_set_refine"] = n
                    if "per" in pending_cond and n > pending_cond["per"]:
                        pending_cond["per"] = n
                target = pending_cond["effects"]
            elif section == "piece_bonus":
                # "Piece Bonus: ATK +1% per Refine" scales with this piece's
                # own refine. Left as a piece bonus it would count once, as
                # if the piece were always +1.
                if "per_refine" in eff:
                    _bucket(result["item_refine"]["per_refine"], eff.pop("per_refine"), eff)
                    continue
                target = result["piece_bonus"]
            elif section == "set_bonus" and current_block is not None:
                target = current_block["bonus"]
            elif section in ("base", "set_bonus_wait", "set_members"):
                # Inline scaling moves the effect into the right bucket even
                # with no heading above it.
                if "per_set_refine" in eff:
                    _bucket(result["set_refine"]["per_set_refine"],
                            eff.pop("per_set_refine"), eff)
                    continue
                if "per_refine" in eff:
                    _bucket(result["item_refine"]["per_refine"],
                            eff.pop("per_refine"), eff)
                    continue
                target = result["base"]
            if target is None:
                target = result["base"]
            target.append(eff)
            if not eff["parsed"]:
                result["unparsed"].append(eff["text"])

    return result


def parse_description_headline(head: str, tail: str, result: dict,
                               set_refine: dict | None = None) -> bool:
    """Handle "<heading>: <effects>" written on one line.

    `set_refine` is the bucket set-scoped scaling should land in -- the open
    set block when there is one, so a two-set item keeps each set's refine
    scaling with the right set.
    """
    if set_refine is None:
        set_refine = result["set_refine"]

    m = H_SET_REFINE_AGAIN.match(head.strip())
    if m:
        set_refine["thresholds"].append({
            "kind": "set_refine_threshold",
            "at": [int(m.group("a")), int(m.group("b"))],
            "note": "applies again at the higher step",
            "effects": parse_line(tail),
        })
        return True

    for rx, dest, key in (
        (H_SET_REFINE_AT, set_refine["thresholds"], "at"),
        (H_REFINE_AT, result["item_refine"]["thresholds"], "at"),
        (H_PER_SET_REFINE, set_refine["per_set_refine"], "per"),
        (H_PER_REFINE, result["item_refine"]["per_refine"], "per"),
    ):
        m = rx.match(head.strip())
        if not m:
            continue
        n = int(m.groupdict().get("n") or 1)
        entry = {"effects": parse_line(tail)}
        if key == "at":
            entry["at"] = [n]
            entry["kind"] = ("set_refine_threshold" if dest is set_refine["thresholds"]
                             else "refine_threshold")
        else:
            entry["per"] = n
        dest.append(entry)
        return True
    return False


def _bucket(dest: list, per: int, eff: dict) -> None:
    for entry in dest:
        if entry.get("per") == per:
            entry["effects"].append(eff)
            return
    dest.append({"per": per, "effects": [eff]})


# --------------------------------------------------------------------------
# 6. across the whole dataset
# --------------------------------------------------------------------------

def load_overrides(path: Path) -> dict:
    if not path.exists():
        return {}
    data = json.loads(path.read_text("utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


def _resolve_members(wanted: list, all_items: list[dict]) -> tuple[list[dict], list[str]]:
    """Turn a patch's member list into item records.

    A member is normally a name, which is what someone editing the file can
    check against the site. Some families -- the Bullhorn gear, where the
    slotted and unslotted pieces are named identically -- cannot be told
    apart that way, so a member may instead be {"id": ..., "name": ...}.
    The name is still required there and is checked against the id: it keeps
    the file readable, and a renumbering shows up as a mismatch rather than
    silently pulling in the wrong piece.
    """
    by_name: dict[str, list[dict]] = defaultdict(list)
    for item in all_items:
        by_name[item["name"]].append(item)
    by_id = {item["id"]: item for item in all_items}

    resolved: list[dict] = []
    missing: list[str] = []

    for entry in wanted:
        if isinstance(entry, dict):
            item = by_id.get(entry["id"])
            if item is None:
                missing.append(f"id {entry['id']} ({entry.get('name', '?')})")
            elif item["name"] != entry["name"]:
                missing.append(
                    f"id {entry['id']} is '{item['name']}', not '{entry['name']}'")
            else:
                resolved.append(item)
            continue

        found = by_name.get(entry, [])
        if not found:
            missing.append(entry)
        elif len(found) > 1:
            # Silently taking one of them would be a coin flip between two
            # different items, so the patch has to say which by id.
            missing.append(
                f"'{entry}' is ambiguous ({len(found)} items: "
                f"{', '.join(str(i['id']) for i in found)}) -- address it by id")
        else:
            resolved.append(found[0])

    return resolved, missing


def _new_set_record(key: str, patch: dict, index: int) -> dict:
    """An empty set record for a hand-declared set.

    Deliberately empty: every field a parsed set would have carries no
    reading of its own, so whatever the patch does not fill stays visibly
    blank rather than inheriting a guess.
    """
    return {
        "index": index,
        "key": key,
        "name": patch.get("name") or key,
        "kinds": [],
        "member_ids": [],
        "members": [],
        "member_count": 0,
        "members_text": patch.get("members_text"),
        "set_bonus": [],
        "set_refine": {"per_set_refine": [], "thresholds": []},
        "piece_bonus_note": None,
    }


def apply_set_overrides(sets: list[dict], overrides: dict,
                        all_items: list[dict] | None = None,
                        ) -> tuple[list[dict], list[str]]:
    """Fold hand corrections into the parsed sets.

    Returns what was applied and which keys matched nothing. A stale key is
    reported rather than ignored: if the source text changes shape, a
    correction that quietly stops applying is worse than a loud one.

    A patch marked "create" declares a set the parser never saw at all --
    one whose heading the tooltip writes without the colon that makes a
    heading, so the bonus under it reads as the declaring item's own. The
    set is built here rather than taught to the parser, because a colonless
    "<Name> Set" line is not distinguishable from the contents list of a
    container that happens to hold shadow sets.

    A patch marked "drop" does the reverse, for a heading that reads as a
    set but is not one -- a tooltip that writes "<Something> Set:" over what
    is really a condition on the single item. The set is removed and the
    remaining ones are renumbered, because a set's index is its position in
    the list and the app reads it that way.
    """
    wanted = overrides.get("sets", {})
    by_key = {s["key"]: s for s in sets}
    applied: list[dict] = []
    stale: list[str] = []
    dropped: set[str] = set()

    for key, patch in wanted.items():
        target = by_key.get(key)
        created = False
        if target is not None and patch.get("drop"):
            dropped.add(key)
            applied.append({"set": target["name"], "key": key,
                            "status": patch.get("status", "unverified"),
                            "reason": patch.get("reason", ""),
                            "changed": ["dropped"]})
            continue
        if target is None and patch.get("create"):
            target = _new_set_record(key, patch, len(sets))
            sets.append(target)
            by_key[key] = target
            created = True
        elif target is None:
            stale.append(key)
            continue
        elif patch.get("create"):
            # The parser found it after all, so the hand-built version is no
            # longer the only copy. Said out loud rather than silently
            # layered on top of what was parsed.
            stale.append(f"{key}: marked 'create', but the parser found this set")

        record = {"set": target["name"], "key": key,
                  "status": patch.get("status", "unverified"),
                  "reason": patch.get("reason", ""),
                  "changed": ["created"] if created else []}

        # Membership is worked out from what each item says about itself, so
        # a piece that never names the set is invisible to the parser, and a
        # set written as alternatives ("Ring and Boots", where the boots come
        # in three marks) is counted as if all of them were worn together.
        # Both are corrected here.
        if "members" in patch:
            resolved, missing = _resolve_members(patch["members"], all_items or [])
            if missing:
                stale.append(f"{key}.members: {', '.join(missing)}")
            target["member_ids"] = [i["id"] for i in resolved]
            target["members"] = [{"id": i["id"], "name": i["name"], "kind": i["kind"]}
                                 for i in resolved]
            target["kinds"] = sorted({i["kind"] for i in resolved})
            record["changed"].append("members")

        if "member_count" in patch:
            # How many pieces have to be on, which is not the length of the
            # member list when some of them are alternatives for each other.
            target["member_count"] = int(patch["member_count"])
            record["changed"].append("member_count")

        if "set_bonus" in patch:
            target["set_bonus"] = [e for line in patch["set_bonus"]
                                   for e in parse_line(line)]
            record["changed"].append("set_bonus")

        if "set_refine_thresholds" in patch:
            target["set_refine"]["thresholds"] = [
                {"kind": "set_refine_threshold", "at": list(entry["at"]),
                 "effects": [e for line in entry["effects"] for e in parse_line(line)]}
                for entry in patch["set_refine_thresholds"]
            ]
            record["changed"].append("set_refine.thresholds")

        if "set_refine_per" in patch:
            target["set_refine"]["per_set_refine"] = [
                {"per": entry["per"],
                 "effects": [e for line in entry["effects"] for e in parse_line(line)]}
                for entry in patch["set_refine_per"]
            ]
            record["changed"].append("set_refine.per_set_refine")

        # Carried into the dataset so the UI can say the numbers are a hand
        # correction, and whether anyone has checked it in game.
        target["override"] = {"status": record["status"], "reason": record["reason"]}
        applied.append(record)

    # A set's index is its position in the list, which is how the app looks
    # one up, so dropping any means renumbering the rest. Done unconditionally
    # so a created set gets a correct index too.
    if dropped:
        sets[:] = [s for s in sets if s["key"] not in dropped]
    for position, record_set in enumerate(sets):
        record_set["index"] = position

    return applied, stale


def apply_item_overrides(records: list[dict], overrides: dict) -> tuple[list[dict], list[str]]:
    """Fold hand corrections into individual items.

    Same contract as the set version: a key that matches no item is reported
    rather than dropped, because a correction that silently stops applying is
    worse than one that complains.

    Items are addressed by name. Ids are stable, but a name is what someone
    editing the file by hand can check, and a rename shows up as a stale key
    instead of silently patching the wrong thing.
    """
    wanted = overrides.get("items", {})
    by_name = {r["name"]: r for r in records}
    applied: list[dict] = []
    stale: list[str] = []

    for name, patch in wanted.items():
        target = by_name.get(name)
        if target is None:
            stale.append(name)
            continue

        record = {"item": name, "status": patch.get("status", "unverified"),
                  "reason": patch.get("reason", ""), "changed": []}

        if "effects" in patch:
            target["effects"] = [e for line in patch["effects"]
                                 for e in parse_line(line)]
            record["changed"].append("effects")

        if "conditional" in patch:
            # For a tooltip that writes a condition as though it were a
            # heading of its own, so the effect under it landed somewhere
            # other than the item's conditional bucket.
            target["conditional"] = [
                {"condition": entry["condition"],
                 "effects": [e for line in entry["effects"] for e in parse_line(line)]}
                for entry in patch["conditional"]
            ]
            record["changed"].append("conditional")

        if "per_refine" in patch:
            target["refine"]["per_refine"] = [
                {"per": entry["per"],
                 "effects": [e for line in entry["effects"] for e in parse_line(line)]}
                for entry in patch["per_refine"]
            ]
            record["changed"].append("refine.per_refine")

        if "refine_thresholds" in patch:
            target["refine"]["thresholds"] = [
                {"kind": "refine_threshold", "at": list(entry["at"]),
                 "effects": [e for line in entry["effects"] for e in parse_line(line)]}
                for entry in patch["refine_thresholds"]
            ]
            record["changed"].append("refine.thresholds")

        target["override"] = {"status": record["status"], "reason": record["reason"]}
        applied.append(record)

    return applied, stale


# Which slot group an equip slot belongs to. A Colossal Shield sits in
# "Weapon (two-handed)", so as far as a class rule is concerned it is a
# weapon, not an off-hand piece.
WEAPON_SLOTS = {"Weapon", "Weapon (two-handed)"}
OFF_HAND_SLOTS = {"Off-hand", "Shield"}
AMMO_SLOTS = {"Ammunition"}
SLOT_GROUPS = {
    "weapons": WEAPON_SLOTS,
    "off_hand": OFF_HAND_SLOTS,
    "ammunition": AMMO_SLOTS,
}


def build_class_rules(rules: dict, items: list[dict],
                      classes: list[str]) -> tuple[dict, dict]:
    """Resolve the hand-written class rules against the crawled data.

    Returns the payload the app loads and a report of what was applied and
    what matched nothing. Nothing here edits the item records: the job
    sentence stays as the site wrote it and the corrections are applied at
    read time, so removing a rule from the file undoes it without a re-crawl.

    A type that no item in that slot group actually has is reported the same
    way a stale name is. It is how a typo ("Round shield") or a type that has
    been renamed upstream shows up, rather than quietly allowing nothing.
    """
    by_name = {r["name"]: r for r in items}
    known = set(classes)
    types_by_group = {
        group: {it.get("type") for it in items
                if set(it.get("equip_slots") or []) & slots and it.get("type")}
        for group, slots in SLOT_GROUPS.items()
    }

    out_classes: dict[str, dict] = {}
    out_items: dict[str, dict] = {}
    applied: list[dict] = []
    stale: list[str] = []
    unknown_types: list[str] = []

    for name, rule in (rules.get("classes") or {}).items():
        if name not in known:
            stale.append(f"class {name}")
            continue
        entry: dict = {"status": rule.get("status", "unverified"),
                       "reason": rule.get("reason", "")}
        for group in SLOT_GROUPS:
            if group not in rule:
                continue
            allowed = list(rule[group])
            for t in allowed:
                if t not in types_by_group[group]:
                    unknown_types.append(f"{name}.{group}: {t}")
            entry[group] = allowed
        out_classes[name] = entry
        applied.append({"class": name, "status": entry["status"],
                        "changed": [g for g in SLOT_GROUPS if g in entry]})

    for name, patch in (rules.get("items") or {}).items():
        target = by_name.get(name)
        if target is None:
            stale.append(f"item {name}")
            continue
        if "usable_by" not in patch:
            continue
        # The id is what the app looks the correction up by; the name is
        # carried along so the payload can be read on its own.
        out_items[str(target["id"])] = {
            "name": name,
            "usable_by": patch["usable_by"],
            "was": target.get("usable_by"),
            "status": patch.get("status", "unverified"),
            "reason": patch.get("reason", ""),
        }
        applied.append({"item": name, "status": patch.get("status", "unverified"),
                        "changed": ["usable_by"]})

    report = {
        "class_rules_applied": applied,
        "class_rules_unverified": [a.get("class") or a.get("item") for a in applied
                                   if a["status"] != "verified"],
        "class_rules_stale": stale,
        "class_rules_unknown_types": unknown_types,
    }
    return {"classes": out_classes, "items": out_items}, report


def build(items: list[dict], overrides: dict | None = None) -> tuple[list[dict], list[dict], dict]:
    parsed: dict[int, dict] = {}
    for it in items:
        parsed[it["id"]] = parse_description(it["description"])

    # ---- group items into sets by the name they give themselves ----------
    # keyed slug -> {item id -> that item's block for this set}
    groups: dict[str, dict[int, dict]] = defaultdict(dict)
    for it in items:
        for block in parsed[it["id"]]["set_blocks"]:
            if block["name"]:
                groups[slugify(block["name"])][it["id"]] = block

    sets: list[dict] = []
    conflicts: list[dict] = []

    by_id = {it["id"]: it for it in items}

    for index, key in enumerate(sorted(groups)):
        blocks = groups[key]
        member_ids = sorted(blocks)
        members = [by_id[i] for i in member_ids]
        display = Counter(blocks[i]["name"] for i in member_ids).most_common(1)[0][0]

        # Members of one set normally repeat the same bonus text. Where they
        # disagree the majority is used and the disagreement is reported --
        # it means either a wrap this parser got wrong or a genuine server
        # inconsistency, and both are worth a human look rather than a guess.
        variants = Counter(
            json.dumps([e["text"] for e in blocks[i]["bonus"]], ensure_ascii=False)
            for i in member_ids)
        if len(variants) > 1:
            conflicts.append({
                "set": display, "field": "set_bonus",
                "variants": [json.loads(v) for v, _ in variants.most_common()],
            })
        best = variants.most_common(1)[0][0]
        set_bonus = next(
            blocks[i]["bonus"] for i in member_ids
            if json.dumps([e["text"] for e in blocks[i]["bonus"]],
                          ensure_ascii=False) == best)

        set_refine = next(
            (blocks[i]["set_refine"] for i in member_ids
             if blocks[i]["set_refine"]["per_set_refine"]
             or blocks[i]["set_refine"]["thresholds"]), None)
        if set_refine is None:
            # Older single-set items parsed their scaling before any block
            # was open; fall back to the item-level bucket.
            set_refine = next(
                (parsed[i]["set_refine"] for i in member_ids
                 if parsed[i]["set_refine"]["per_set_refine"]
                 or parsed[i]["set_refine"]["thresholds"]), None)

        members_text = next(
            (blocks[i]["members_text"] for i in member_ids if blocks[i]["members_text"]),
            None)

        sets.append({
            "index": index,
            "key": key,
            "name": display,
            "kinds": sorted({m["kind"] for m in members}),
            "member_ids": member_ids,
            "members": [{"id": m["id"], "name": m["name"], "kind": m["kind"]}
                        for m in members],
            "member_count": len(members),
            "members_text": members_text,
            "set_bonus": set_bonus,
            "set_refine": set_refine or {"per_set_refine": [], "thresholds": []},
            "piece_bonus_note": (
                "Each piece also carries its own Piece Bonus; see the item."
                if any(parsed[i]["piece_bonus"] for i in member_ids) else None),
        })

    # Hand corrections land before anything reads the set records, so the
    # item view and the totals both see the corrected numbers.
    overrides_applied, overrides_stale = apply_set_overrides(
        sets, overrides or {}, items)

    sets_of_item: dict[int, list[int]] = defaultdict(list)
    for s in sets:
        for mid in s["member_ids"]:
            sets_of_item[mid].append(s["index"])

    # ---- attach to items -------------------------------------------------
    bonuses: list[dict] = []
    for it in items:
        p = parsed[it["id"]]
        bonuses.append({
            "id": it["id"],
            "name": it["name"],
            "kind": it["kind"],
            "sets": sets_of_item.get(it["id"], []),
            "effects": p["base"],
            "piece_bonus": p["piece_bonus"],
            # Item refine only. Set refine lives on the set record, never here.
            "refine": p["item_refine"],
            "conditional": p["conditional"],
            "enchant": p["enchant"],
            "lore": p["lore"],
            "unparsed": p["unparsed"],
        })

    # Item corrections go in before the report counts anything, so a
    # corrected item is not still reported as unparsed.
    item_overrides, item_stale = apply_item_overrides(bonuses, overrides or {})
    overrides_applied += item_overrides
    overrides_stale += item_stale

    # ---- report ----------------------------------------------------------
    def walk(record: dict):
        """Every effect in a record, whichever bucket it landed in."""
        yield from record["effects"]
        yield from record["piece_bonus"]
        for group in (record["refine"]["per_refine"],
                      record["refine"]["thresholds"],
                      record["conditional"]):
            for entry in group:
                yield from entry["effects"]

    per_kind: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    total_eff = total_unparsed = 0
    mapped = skill_mod = unmapped = 0
    unmapped_names: Counter = Counter()

    def account(eff: dict) -> None:
        nonlocal mapped, skill_mod, unmapped
        if not eff.get("parsed"):
            return
        if eff.get("sets_element"):
            # Not a number, so it is neither mapped nor missing a mapping.
            return
        if eff.get("stat_ids"):
            mapped += 1
        elif eff.get("skill"):
            skill_mod += 1
        else:
            unmapped += 1
            unmapped_names[eff.get("stat", "")] += 1

    for b in bonuses:
        for eff in walk(b):
            total_eff += 1
            per_kind[b["kind"]][0] += 1
            if not eff.get("parsed"):
                total_unparsed += 1
                per_kind[b["kind"]][1] += 1
            account(eff)

    for s in sets:
        for eff in s["set_bonus"]:
            account(eff)
        for group in (s["set_refine"]["per_set_refine"], s["set_refine"]["thresholds"]):
            for entry in group:
                for eff in entry["effects"]:
                    account(eff)

    refine_items = [b for b in bonuses
                    if b["refine"]["per_refine"] or b["refine"]["thresholds"]]

    report = {
        "items": len(items),
        "sets": len(sets),
        "items_in_a_set": len(sets_of_item),
        "items_with_item_refine_scaling": len(refine_items),
        "sets_with_set_refine_scaling": sum(
            1 for s in sets
            if s["set_refine"]["per_set_refine"] or s["set_refine"]["thresholds"]),
        "effect_lines": total_eff,
        "effect_lines_unstructured": total_unparsed,
        "effect_parse_rate": round(
            100.0 * (total_eff - total_unparsed) / total_eff, 1) if total_eff else 0.0,
        "effect_parse_rate_by_kind": {
            k: {"lines": tot, "unstructured": un,
                "rate": round(100.0 * (tot - un) / tot, 1) if tot else 0.0}
            for k, (tot, un) in sorted(per_kind.items(), key=lambda kv: -kv[1][0])},
        "overrides_applied": overrides_applied,
        "overrides_unverified": [o.get("set") or o.get("item")
                                 for o in overrides_applied
                                 if o["status"] != "verified"],
        "overrides_stale": overrides_stale,
        "enchantable_items": sum(1 for b in bonuses if b["enchant"]),
        "per_stat_count_blocks": sum(
            1 for b in bonuses for c in b["conditional"] if c.get("per_stat_count")),
        "element_overrides": sum(
            1 for b in bonuses for e in walk(b) if e.get("sets_element")),
        "evaluable_conditions": sum(
            1 for b in bonuses for c in b["conditional"] if c.get("requires")),
        "conditions_total": sum(len(b["conditional"]) for b in bonuses),
        "stats_registered": len(stat_registry.STATS),
        "stat_mapping": {
            "mapped_to_stat_ids": mapped,
            "skill_modifiers": skill_mod,
            "unmapped": unmapped,
            "coverage_percent": round(
                100.0 * mapped / (mapped + skill_mod + unmapped), 1)
            if (mapped + skill_mod + unmapped) else 0.0,
        },
        "unmapped_stat_names": unmapped_names.most_common(60),
        "set_text_conflicts": conflicts,
        "singleton_sets": [s["name"] for s in sets if s["member_count"] == 1],
        "unparsed_samples": sorted({u for b in bonuses for u in b["unparsed"]})[:60],
    }
    return sets, bonuses, report


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    data = root / "data"
    items = json.loads((data / "items" / "all.json").read_text("utf-8"))
    overrides = load_overrides(root / "crawler" / "overrides.json")

    sets, bonuses, report = build(items, overrides)

    # Class equip rules are resolved against the crawled items but kept out
    # of them, so a rule can be withdrawn by editing one file.
    classes_path = data / "classes.json"
    classes = json.loads(classes_path.read_text("utf-8")) if classes_path.exists() else []
    class_rules, class_report = build_class_rules(
        load_overrides(root / "crawler" / "class-rules.json"), items, classes)
    _write(data / "class-rules.json", class_rules)
    report.update(class_report)

    _write(data / "stats.json", stat_registry.registry())
    (data / "sets").mkdir(parents=True, exist_ok=True)
    _write(data / "sets" / "all.json", sets)
    _write(data / "items" / "bonuses.json", bonuses)
    _write(data / "parse-report.json", report)

    # Fold the set index and parsed bonuses into the item records too, so a
    # UI can read one file per kind and have everything.
    by_id = {b["id"]: b for b in bonuses}
    for it in items:
        b = by_id[it["id"]]
        it["sets"] = b["sets"]
        it["effects"] = b["effects"]
        it["piece_bonus"] = b["piece_bonus"]
        it["refine"] = b["refine"]
        it["conditional"] = b["conditional"]
        it["enchant"] = b["enchant"]
        it["lore"] = b["lore"]
        # Present only where a hand correction touched this item, so the UI
        # can say the numbers are a reading rather than the tooltip.
        it["override"] = b.get("override")
    _write(data / "items" / "all.json", items)

    buckets: dict[str, list[dict]] = defaultdict(list)
    for it in items:
        buckets[it["kind"] or "Unknown"].append(it)
    for kind, bucket in buckets.items():
        bucket.sort(key=lambda r: (r["name"] or "").lower())
        _write(data / "items" / "by-kind" / f"{slugify(kind)}.json", bucket)

    print(f"sets:                {report['sets']}")
    print(f"items in a set:      {report['items_in_a_set']}")
    print(f"item-refine scaling: {report['items_with_item_refine_scaling']} items")
    print(f"set-refine scaling:  {report['sets_with_set_refine_scaling']} sets")
    print(f"effect lines:        {report['effect_lines']} "
          f"({report['effect_parse_rate']}% structured)")
    print(f"text conflicts:      {len(report['set_text_conflicts'])}")
    sm = report["stat_mapping"]
    print(f"stat registry:       {report['stats_registered']} stats")
    print(f"  mapped to ids:     {sm['mapped_to_stat_ids']} ({sm['coverage_percent']}%)")
    print(f"  skill modifiers:   {sm['skill_modifiers']}")
    print(f"  unmapped:          {sm['unmapped']}")
    if report["overrides_applied"]:
        print(f"hand overrides:      {len(report['overrides_applied'])}")
        for o in report["overrides_applied"]:
            mark = "" if o["status"] == "verified" else "  (UNVERIFIED)"
            who = o.get("set") or o.get("item")
            print(f"  {who}: {', '.join(o['changed'])}{mark}")
    if report["overrides_stale"]:
        print(f"  STALE override entries: "
              f"{', '.join(report['overrides_stale'])}", file=sys.stderr)
    if report["class_rules_applied"]:
        print(f"class rules:         {len(report['class_rules_applied'])}")
        for a in report["class_rules_applied"]:
            mark = "" if a["status"] == "verified" else "  (UNVERIFIED)"
            who = a.get("class") or a.get("item")
            print(f"  {who}: {', '.join(a['changed'])}{mark}")
    if report["class_rules_unknown_types"]:
        print(f"  UNKNOWN types in class-rules.json: "
              f"{'; '.join(report['class_rules_unknown_types'])}", file=sys.stderr)
    if report["class_rules_stale"]:
        print(f"  STALE class-rule keys, matched nothing: "
              f"{', '.join(report['class_rules_stale'])}", file=sys.stderr)
    return 0


def _write(path: Path, payload) -> None:
    """Write JSON, preferring an atomic swap but not insisting on one.

    On Windows os.replace refuses when something else holds the destination
    open -- the dev server serving the dataset, or an editor with the file
    in a tab. Both are normal while working on this project, and failing the
    whole regeneration over a held handle is worse than writing in place.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(text, encoding="utf-8")
    try:
        tmp.replace(path)
    except PermissionError:
        path.write_text(text, encoding="utf-8")
        tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main())

