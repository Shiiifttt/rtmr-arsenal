# Satsujin baselines

Reference builds for the project owner's Satsujin. Test any new setup or
scenario against these, on the same seeds, and report the difference from
the baseline rows — not an absolute number.

Current results: [results.md](results.md) (regenerate with the command below).

## The builds

| File | What it is |
|---|---|
| `owner.json` | The owner's build as played on 2026-09-28. Includes the Murder Knife rolls the live arsenal can't store (Melee +9%, SP cost −10%). |
| `minimum.json` | Bare minimum for Rachel SS: budget with no MVP card and no Ymir Emperium Card — Veins Ghoul, Zombie Slaughter ×2, Hodremlin, Gioia in their sockets ([cards.md](cards.md)); Heir to the King Boots/Pendant +9. |
| `minimum-loki.json` | minimum with Master Loki back: the one MVP card that matters at Rachel SS (Njord Zealot). |
| `budget.json` | Roadmap budget tier: nothing past +6. Legal stats STR 99 / AGI 99 / VIT 28 / INT 19 / DEX 49 / LUK 49. Keeps the flee setup (Asprika, Maiden cards) and the Moonless Gem +6. |
| `allround.json` | Budget gear with the one-reset all-round spread: STR 90 / AGI 99 / VIT 57 / INT 1 / DEX 49 / LUK 49. Best single spread across Rachel SS, the lair and the Tomb. |
| `standard.json` | Roadmap standard tier: +9 and MVP drops. Legal stats STR 99 / AGI 89 / VIT 33 / INT 4 / DEX 64 / LUK 49. Drops flee for burst; swaps to Hidden Gem of Silence +6. The top tier. |
| `standard-rings.json` | Standard with Megingjard → Ring of Naght Sieger [Ifrit ×2] (+1% ATK roll). About +5% DPS. |
| `endgame.json` | Roadmap endgame tier (SS-dungeon drops allowed). No better than standard; kept for reference. |

## Scenarios (`manifest.json`)

Monster sets are named in `combat/src/data.ts` (`MOB_SETS`); any tool's
`--vs` takes them: `rachel5`, `lair4`, `tomb_knights`, `guild_regulars`,
`ymir`, `elite` (the hardest regular of each high area and the area MVPs:
Burning Fury, Heartless, Tornado Knight, Guild Master, Desperate Njord,
King Schmidt, Soul of Ymir). `elite` is the short check for a new setup.

## How to test against them

From `combat/`:

```sh
# Every baseline in every scenario (about 5-10 minutes; writes results.md/.json):
node --experimental-strip-types --no-warnings --import ./register.mjs tools/baseline.ts

# A new setup next to the baselines (it gets a * in the table):
node --experimental-strip-types --no-warnings --import ./register.mjs tools/baseline.ts \
  --candidate path/to/my-setup.json --only rachel5,lair4 --out my-test

# A one-change comparison on one baseline (same fights, side by side):
node --experimental-strip-types --no-warnings --import ./register.mjs tools/variants.ts \
  --profile baselines/satsujin-rachel/budget.json --vs rachel5 --iter 300 --policy priority --time 300 \
  --variant "Venus Cape: garment=Venus Cape+9; garment.rolls=evasion:flee:6" \
  --variant "LUK to DEX: stat.luk=1; stat.dex=73"
```

Farming (kills an hour and time spent sitting for SP; `tools/farm.ts`
explains the model — flat grid, live spawn counts, server walk speeds and
aggro ranges, the real fight engine chained kill to kill):

```sh
# Single-target rotation on the Lv120-140 Distortions (Factory, Temple, Laboratory, Glast Heim Castle):
node --experimental-strip-types --no-warnings --import ./register.mjs tools/farm.ts   --profile baselines/satsujin-rachel/standard.json --mode combo --map xmas_fut01,odin_past,1@mcd,gl_cas01_   --minutes 15 --seeds 3 --sit-below 0.05 --variant "Laev: offhand=Laevateinn+9; offhand.cards=Khalitzburg Card"
# Fan of Knives packs in Glast Heim Chivalry 2:
node --experimental-strip-types --no-warnings --import ./register.mjs tools/farm.ts   --profile baselines/satsujin-rachel/owner.json --mode fok --map gl_knt02 --pack 4
```

Card alternatives (every legal card in a socket, ranked on the same fights; [cards.md](cards.md)):

```sh
node --experimental-strip-types --no-warnings --import ./register.mjs tools/card-bench.ts   --profile baselines/satsujin-rachel/budget.json --vs rachel5 --sockets "middle:0,acc2:0"   --strip "Ifrit Card,Master Loki Card" --screen 60 --confirm 300 --top 6
```

`candidates/` holds setups tested against these rows (2026-09-28): the
baselines with the long-fight options on, and the one-piece SP swaps.

A candidate profile is the same shape as the files here: copy one and edit
`build.slots`, `build.baseStats` and `options`. Keep `baseLevel`,
`weaponRaceMatch` and `measured` as they are.

The batch tools (baseline, farm, card-bench, gear-search) leave core 0 free
and run below normal priority, so the game stays smooth while they run
(`src/cpu.ts`; `RTMR_ALL_CORES=1` gives them every core).

## Rules the numbers rest on

Change any of these and the baselines must be re-run.

- **Stat points** (`gear-search.ts statCost`): the server's own cost, 1 +
  floor(v / 49) a point; base stats cap at 99. Hand-edited stats must stay
  within 439 points (Lv136).
- **Character**: base level 136. `measured` holds the owner's status-window
  corrections: flee −27 and hard MDEF +6 against the model, Max HP ×1.152.
- **Weapon race cards**: `weaponRaceMatch` counts the Murder Knife's race
  cards against any race (the owner swaps daggers per monster).
- **Bosses for gear** (`formulas.countsAsBoss`): MVPs, Boss-class monsters,
  Rachel SS, and the lair except Heartless.
- **Gem statuses** (Bleeding / Poison / Burning): codex formulas, calibrated
  on the owner's dummy (within 2%); they land on status-immune and plant
  monsters, 1 a tick on plants.
- **Movement**: live rule, gear Move Speed at half, +55% cap.
- **Play** (`options`): server walking, kiting on known killers, the Back Stab
  tell, Shadow Slash out of aimed spells, Critical Slash predicted with
  Kawarimi, Back Slide from gear. From the owner's Rachel SS playbook; the
  lair and Tomb reuse it without a playbook of their own.
- **SP regen** (2026-09-28): natural SP every 1.2 s with gear SP Recovery %;
  Increase SP Recovery is the server's skill regen (MG_SRECOVERY), its own
  4 s tick, no gear %, not while walking. Before this it rode every 1.2 s
  tick with the gear %, about 3x too much; results before 2026-09-28 18:00
  were run that way (long fights: `ymir` fell from 20-70% wins to 3-22%).
  SP leech (`leech_sp_rate/power`) now lands too.
- **Long fights** (options, off in the baselines): `pace` keeps swinging on
  no SP instead of stalling; `reserveHiding` keeps Hiding's cooldown and SP
  for a one-shot it answers (Soul of Ymir's Dragon Breath) and tanks the
  rest (Chain Lightning).
- **Monster hits**: normal attacks and weapon skills are Neutral; Kaupe,
  Auto Guard (4%/level), Perfect Dodge and flee follow the 2023 source order.

## Owner's constraints for searches

Murder Knife and its cards stay; Agility Manual X stays; class gem at most
+6; lower headgear is Flaming Weaver or Wind Weaver (+1 STR); no Celestial
Tome; MVP drops and +9 are fine. The roadmap plan that produced these is
`combat/runs/satsujin-rachel-roadmap.json`; its output is in
`data/gear-search/overnight/satsujin-rachel/`.

## Reading the results

- **A fight that isn't a win or a loss is a stall:** the owner's rule ends a
  fight when no damage skill is affordable (auto-attacks don't count). Long
  fights stall on SP, which is most of the `ymir` scenario's non-wins:
  Ymir Emperium needs ~1,000 hits, and in game you would keep swinging. Read
  `ymir` for deaths, not win rate.
- **Ifrit Card carries SP −10%:** `standard-rings` runs dry in long MVP
  fights (Soul of Ymir) while it is the fastest build everywhere else.

## Open questions

- Poison's tick rate (dummy counter readings disagree); Dragon Omamori's
  apply hit reads ~38% low; the explosion under Combo Ready is unread.
- The lair and Tomb have no Satsujin playbook yet.
- Ymir Emperium: whether the 2023 1-damage rule still holds live.
