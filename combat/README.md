# Combat sim (local only)

A headless, seeded simulator: one character, played like a TAS, against one
monster, many times over. It answers "can this build beat that monster if
played well, how fast, and what kills it", and gives a WoW-style parse of
where the damage came from. Not part of the web app.

```sh
cd combat
npm run sim -- --vs dummy --log                 # 30s pure-DPS test, with a combat log
npm run sim -- --vs rachel_ss                   # every Rachel SS monster, 200 fights each
npm run sim -- --vs gorge,freya                 # also: jorm, thanatos, tomb, guild, ama_ss, valhalla
npm run sim -- --vs jorm --build "<share link>" # your build from the arsenal's share link
npm run sim -- --vs "Tortured Maiden" --iter 1000 --seed 4 --json
npm test
```

**From the arsenal:** under `npm run dev` in web/, the toolbar has a
**Simulate** button. It sends the current build to the dev server, which
runs this same CLI as a child process (`combatPlugin` in
web/vite.config.ts). The button and the endpoint exist only on the dev
server: a `vite build` contains neither.

Consumables: Green Potions are always carried. `--healing` (the panel's
**Healing items**) adds White/Blue Potions and Yggdrasil Berries. On a boss
the free Kafra Elixirs come too, 2 a life, plus one per Elixir Badge.

Flags: `--hp`, `--sp`, `--aspd` (readings from the character window),
`--healing`, `--items "<names>" | none`, `--stream` (one JSON line per monster as it finishes, what the panel reads),
`--profile <json>` (default `profiles/satsujin-example.json`),
`--build <share link or payload>`, `--vs dummy|rachel_ss|jorm|<name>|<id>[,…]`,
`--iter N`, `--time <seconds>`, `--seed N`, `--policy tas|priority`,
`--horizon <ms>` (TAS lookahead, default 6000), `--log`, `--json`.

## How a fight ends

- **Win**: the monster dies. **Loss**: you die.
- **Stalemate**: the clock runs out (1 minute, 10 on a boss, 30s on the
  dummy), or you can no longer afford any damage skill. Nothing runs forever.
- The **dummy** is Formless / Neutral 1 / Medium with no DEF, MDEF, flee or
  resistances. It never attacks and never dies, so its fight is a DPS test.

## Groups

| `--vs` | Maps | What |
|---|---|---|
| `rachel_ss` | rachelnm_e | Rachel SS (boss protocol) |
| `jorm` | jor_nest01-02, jor_core | Jormungandr's lair (boss protocol) |
| `gorge` | moc_fild20-22 | Dimensional Gorge ("Gorge Distortion") |
| `thanatos` | tha_para01-08 | Thanatos Paradise ("Paradise Distortion") |
| `freya` | ra_dun00-02 | Rachel Hidden Temple and Goddess Freya ("Rachel Distortion") |
| `tomb` | lost_dun03 | Tomb of Kings: Lost Island Tomb, King Schmidt |
| `guild` | guild_falld | Ymir's War Castle: Guild Master, Soul of Ymir |
| `ama_ss`, `valhalla` | ama_ss, val_dun01-02 | Newer than the server snapshot: normal attacks only |

## Monsters: where their numbers come from

- **Stats** from the crawl (data/raw/db-mobs.json), which is the newest.
- **What they cast, when and how often** from the server's own
  mob_skill_db, read out of the `returntomorroc/` snapshot (2023-12) by
  `tools/import-server.ts` into `data/server-mobs.json`. Re-run it if the
  snapshot changes:
  `node --experimental-strip-types tools/import-server.ts`.
  The same file supplies MATK (`Attack2`), `DamageTaken`, class and modes,
  and summons' stats.
- **What each skill does** in `data/skill-effects.json`, read from the
  server source (battle.cpp ratios, skill.cpp effects, status.cpp values)
  with the source line cited on every entry. Hand-kept; edit freely.
- **What you have seen in game** in `data/mob-skills.json`, laid over
  the top (Vampire Gift no longer passes Hiding, etc.).

Monsters think the way the server's AI does: on each attack cycle they try
their skill list in order, each row with its own rate (x95%) and delay
(x75%, counted from the cast's start), under its condition (HP below a
share, after skill X, number of adds, hit in melee / from range / by a
skill / targeted by a cast). Adds are full monsters of their own that the
sim never kills. Your statuses are rolled against your stats (VIT, INT,
AGI, LUK, MDEF, as status.cpp does) and then your gear.

Every monster takes its server DamageTaken share: Rachel SS 80%, the
Jormungandr nest 90%, MVPs 50%, Jormungandr 5%. The owner's Rachel SS
readings fit 80%.

Formulas follow the server where the project owner reckons it is right
(2026-09-26): its element table, size penalties, refine ATK, cast time
x0.9, crit damage (x1.2 with LUK/10 and half of Crit Damage) and
half-strength card bonuses. The owner's dummy test (2026-09-26) set the
rest: skills use the right hand's ATK only (the off hand's cards still
count), at twice a hand's ATK (`TUNE.skillAtkFactor`, source unknown);
auto-attacks land each hand; status ATK counts once; Shadow Slash is one
roll shown as three.

Your dodges: Hiding stops monster skills (the project owner: it reliably
does on the live server); the boss protocol's normal attacks still swing at
you and break it; you walk
out of areas laid around the monster or on the ground (the monster follows
you, so the area stays behind); a Manhole a monster dug (Goddess Freya,
Vision of Surt) holds you 3s where nothing can hurt you; Kawarimi stops
physical hits.

`.claude/scratch/formula-audit.md` has the full comparison of every formula
against the server code, including what the sim deliberately does
differently because a reading from the game says so.

## Advice without fighting

`--advise` checks a build against the threat list, `data/threats.json`,
in a few milliseconds and runs no fights. For each thing a monster does to you,
it reports:

- how often it lands
- what one hit does to this build, both the average and the top roll
- whether it kills you from full HP
- which bad statuses get through

It then tries gear fixes on a copy of the build and keeps the ones that help:

- the best armour element, with the gear that gives it
- the element resistance, race resistance or Max HP that lets you live through each one-shot
- immunity to each status that lands
- reflect immunity
- the flee at which normal attacks miss 90%

It also adds notes on what to dodge and what has to be survived.

    npm run sim -- --vs jorm --advise [--build <link>]

The threat list comes from `tools/build-threats.ts`. It fights every monster
in the areas 100 times with the example build and the TAS, then keeps each
threat's:

- rate per minute
- share the TAS dodged
- element, type and statuses
- share of deaths

How often a threat comes and how much of it can be dodged depend mostly on
the monster, while the damage depends on the build and is recalculated each
time. Rebuild the list when the monster data or the TAS's play changes. A
full build takes about a minute.

## Smart swap

`--swap`, or **Smart swap** in the panel, assumes you arrive with spare gear
and changes it for each monster:

- **Race damage cards:** the build's weapon cards against particular races
  are pointed at the monster's race, with the total unchanged. "All races"
  and boss/non-boss lines stay as they are.
- **Race resistance cards:** retargeted the same way.
- **Armour element:** the element the threat list ranks best against that
  monster, if it beats the build's own. A monster missing from the threat
  list keeps your armour.

It only moves what the build already has. It doesn't model what an armour
card being replaced was giving. Each result notes what was swapped.

## Where things live

| File | What |
|---|---|
| `src/formulas.ts` | **Every formula and constant.** DEF/MDEF curves, hit/flee, crits, cast time, ASPD, size and element tables, monster damage. `TUNE` holds the calibrations. Each one names its source: the codex, rAthena line, or GUESS. |
| `src/skilltext.ts` | Reads skill numbers out of the tooltips in `data/raw/db-skills.json`, e.g. "Damage: 250 +50% per level +8% per AGI". A re-crawl changes the sim with it. |
| `src/kits/satsujin.ts` | The Satsujin: which tooltip line is which hit, the states (New Moon, Combo Ready, talismans, Focus), the rotation, and when to dodge. |
| `data/server-mobs.json` | Generated: the server snapshot's monsters and their AI rows. |
| `data/skill-effects.json` | What each monster skill does, from the server source. |
| `data/mob-skills.json` | In-game findings laid over the server data. |
| `tools/import-server.ts` | Rebuilds `server-mobs.json` from `returntomorroc/`. |
| `src/character.ts` | A build becomes combat numbers through the planner's own `aggregate`, so the sim and the arsenal agree on gear. HP, SP and ASPD come from `measured` in the profile. |
| `src/engine.ts` | The event loop, in ms, rolled or in expect mode. |
| `src/tas.ts` | The TAS: tries every usable action a few seconds ahead and takes the best. |
| `src/threats.ts`, `tools/build-threats.ts` | The threat list: what each monster did to the reference build, written to `data/threats.json`. |
| `src/advise.ts` | Checks a build against the threat list and suggests gear fixes. |

Every skill is at max level. Skill damage multipliers, SP-cost and cooldown
lines on gear are read from the planner's skill totals. `ALIASES` maps gear
names such as "Full Moon Blades" to the skills.

## Not modelled yet

Buffs from others, killing adds (they stay for the fight), knockback and
positioning beyond "step out", Morroc's Mark's +10% stats (only its full
restore), SP drain per second in New Moon, the off hand's own cards (both
hands share the build's card totals), monster status immunity against your
debuffs, blind / confusion / curse (logged, no effect), the monster skills
that act on other monsters (Heal on a friend, Hami Castle swaps), the Heart
of the Serpent kill buff (x101 damage on Jormungandr for 30s), and skills'
own after-cast delay (the tooltips give none, so each skill waits the
attack motion; the server's (150 - AGI)/150 x 0.9 is in skillDelayMs for
when one is known). The 2023 scripts' Rachel SS HP drain is not on the
live server (the project owner).
The TAS plays on expected values: it cannot see the dice or a cast that has
not started.
