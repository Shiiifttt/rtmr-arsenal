# RTM Arsenal — build planner

Dark-themed gear planner: pick a class, fill the equipment slots, socket cards,
set refine levels, and read the totalled stats.

## Running it

The dataset has to exist first (see `../crawler/README.md`):

```
python crawler/rtm_crawl.py       # once, from the project root
cd web
npm ci --ignore-scripts           # postinstall scripts are not needed here
npm run dev                       # http://localhost:5173
```

Other scripts: `npm run build` (typecheck + static bundle into `dist/`),
`npm test` (the aggregation tests), `npm run typecheck`.

`dist/` is fully self-contained — the data and images are copied in at build
time, so it can be served by any static host with no backend.

## Why it looks like this

**No server, ever.** The whole dataset is 583 KB gzipped, so it loads once into
memory and every filter and total is computed on the client. There is nothing to
host but files, which is also why there is no server attack surface to worry
about.

**120 packages.** React, Vite, TypeScript and their dependencies — nothing else.
No UI kit, no state library, no CDN scripts, no web fonts. The only third-party
code that reaches a browser is React itself.

## Layout

```
sim/src/        pure TypeScript, no React — the part with the actual logic
  slots.ts      character slots, and what fits in each
  sets.ts       which members of a set are missing, and where each one goes
  jobs.ts       job restriction sentences -> can this class use it
  aggregate.ts  a build -> stat totals
sim/test/       node --test, no test framework needed
web/src/        the UI
  build.ts      an empty build, and reconciling a saved one against the data
  saves.ts      named builds, kept beside the autosave
  share.ts      a whole build in a URL fragment
  recognition/  reads a screenshot of the game and fills the build in
web/test/       the recogniser, run against real client captures
tools/          build the recogniser's assets (stdlib Python, like the crawler)
recognition/    those generated assets, plus the sample screenshots
```

`sim` deliberately has no React in it. It is unit-testable, it runs in plain
Node, and the damage simulator can be built on it later without dragging the
interface along.

## Keeping and sharing a build

The build in front of you is saved as you work on it, in one slot. The
**Builds** button is for everything past that:

- **Save** it under a name, so trying something out costs nothing and going
  back is a click. Named builds live in `localStorage` beside the autosave
  (`web/src/saves.ts`).
- **Export** / **Import** a `.json` file, for a backup or another machine.
  Anything imported goes through the same `reconcile` as a restored save, so a
  stale or hand-edited file cannot put a number the rest of the app does not
  expect into a total.
- **Share link** puts the whole build in the URL fragment, written
  positionally, deflated and base64url-encoded behind a one-character tag
  naming the format. No account and no server — a few pieces is a link of
  about 290 characters and every slot filled is about 500, and a fragment is
  never sent to the host the page is served from. `web/src/share.ts`.

  Deflate alone was not enough: it crushes the repeated field names, but what
  is left is mostly five and six figure item ids, which do not compress. So
  the shape goes first — field names dropped for position, slot keys for
  their index into `SLOTS`, empty tails left off — which is worth about 40%,
  and deflate still runs afterwards for the roll keys. Because slots travel
  as positions, the order of `SLOTS` is part of the link format; a test pins
  it, so reordering fails there rather than silently loading someone's saved
  link into the wrong slots. Appending to `SLOTS` is safe.

  "Empty tails left off" once cost goals their target: a target of 0 at the
  end of a goal's row was trimmed, read back as missing, and the goal was
  dropped on load. A missing target now reads as 0, which also rescues links
  written before the fix, and a goal carries whether it is open and its cap,
  after the old fields where an older reader does not look.

  The tag is what makes the format safe to change. Every format this has ever
  written still decodes, so a link someone saved a year ago keeps working;
  only the writing side moves.

**A link never costs you your own build.** Opening one shows a banner and
suspends the autosave entirely: look at it, change it, throw it away, and what
you were building is exactly where you left it. "Make it mine" takes it over
and starts saving; "Back to mine" puts yours back. A link pasted into a tab
that already has the app open only changes the fragment, so that is handled
too.

## Reading a screenshot

"Read a screenshot" takes a PNG of the game's Equipment, Status or Basic
Information window and fills the build in from it — items, refine levels,
compounded cards and stat points. Items are identified by comparing the icon
the client drew against all 3,298 icons from the crawl, which is exact rather
than approximate because the client blits them unmodified; the name is read
off the bitmap font to choose between items that share an icon, of which
there are a great many.

`recognition/README.md` has the details, including what it cannot do.

## How the totals work

For every equipped piece the aggregator adds its base ATK/MATK/DEF/MDEF columns,
its description effects, its piece bonus, its refine scaling, and the effects of
any cards socketed into it. Then, for each set where **every** member is worn, it
adds the set bonus and the set-refine scaling.

Three things it does deliberately:

- **Flat and percent stay in separate columns.** `DEF +50` and `Total DEF +10%`
  stack differently in Ragnarok. Merging them into one number would imply this
  tool knows the order they apply in — it does not yet, and that is the damage
  model's job.
- **Per-N refine counts steps, not levels.** `Per 4 Refines:` at +11 applies
  twice. There is a test for this, because getting it wrong looks plausible.
- **Set refine is the sum across the set.** A four-piece set at +5 each is set
  refine 20, which is what `Set refine 18+:` is measured against — not the refine
  of any one piece.

### Class gems

Gems have a slot of their own (`gem`, filed by the server under `Gem`). The
data calls every gem unrefineable, but each one has a `Per Refine:` block and
an `If refine is +10:` tier, so the planner trusts the tooltip: gems take a
refine like any other piece (`isRefineable` in `sim/src/slots.ts`).

### Off-hand weapons count race and size at half

A one-handed weapon dual-wielded in the off hand contributes its race and size
**damage** modifiers (`DMG vs Demihuman`, `DMG vs Large`, `Magic vs Small`,
Boss / Non-Boss / All Races…) at half. That covers the weapon, its refine and
the cards in it, and the stat panel's sources say `(off-hand, half)`.
Critical Damage from the **cards** in it counts at half as well; the weapon's
own Critical Damage stays whole.
Resistances are not halved, nothing on a shield is, and set bonuses belong to
the set rather than the hand, so they stay whole. The rules are
`HALVED_OFFHAND` (categories) and `HALVED_OFFHAND_CARDS` (stats, cards only)
in `sim/src/aggregate.ts`. Whether element damage (`DMG vs Fire`…) is halved
is not known yet; it is counted whole.

## Goals and suggestions

The Goals panel takes targets on any number the planner shows: a gear stat's
flat or percent column, a base stat's total, or a derived value such as Flee.
Each is "at least" or "at most" (reductions are negative, so "Variable Cast
≤ -50%" is a ceiling).

The list only offers columns the data actually uses. The registry gives every
stat both a flat and a percent column, but most stats only ever appear one way:
STR is never a percent, and DMG vs Demihuman is never flat. So `goalMetrics`
scans items, cards, refine scaling, sets and roll tables, and offers only the
columns something feeds. A stat that appears both ways is listed as
"ATK (flat)" and "ATK %". Base stats are offered only as totals (points plus
gear).

Goals drive three things:

- **Best for goals** sorting in the item picker. Search and filters work as
  before; only the order changes. Each row gets chips showing what it would
  do to each goal.
- A **Recommended** tab in the picker: other pieces, pieces with their cards
  chosen (a four-socket weapon with four of the right card), better cards in
  what is already worn, and finishing a set that has a piece in that slot.
- **Suggest changes**: recommendations across the whole build, each its own
  upgrade -- get this piece, card it, refine it -- rather than a chain.
- **Clicking a goal's name**: the best ways to get more of that one number,
  whatever else it costs.

**"Just give me more of this."** Click the name of any goal and a window opens
over the build — the same overlay the item picker uses, since the rows are full
suggestions and need the room — listing every swap, card choice and set that
would push that one stat further, whether or not the goal is already met.
Candidates are worked out by a suggester that knows only that goal, so
relevance, the cards it picks and the refine it chooses are all in service of
the one stat; they are then measured against the whole goal list, which is
where the cost comes from.

Swaps that cost no other goal anything come first, most of the stat first.
Then the trades, marked "Sidegrade", ordered by the best value for what they
cost. Both are compared as fractions of their own targets, the way goals are
weighed everywhere else, so 10 crit given up is not drowned out by 1,000 HP.
The foot of the window counts the two ("11 free, 4 trades"). Each row is an
alternative to the build as it stands rather than a step in a plan, so they do
not build on each other, and each shows exactly what it costs: your goals
inline, everything else behind "N gains · N losses". Equip takes one and the
window stays open, worked out again for the build it leaves -- as does the
"Suggest changes" overlay, which searches again from the new build -- so
upgrades can be taken one after another without reopening either.

This is where an already-met goal gets its refines, too. Normal planning tunes
refine against the gap left to a target, which is nothing once the target is
met — so on its own it would leave every piece at +0. Pushing one stat tunes
against the stat instead. One click is about 100–250 ms on a full build.

**Locking a slot** settles it: the padlock on each slot's header tells every
suggestion to leave that slot alone — its piece, its cards and its rolls
alike. Lock the parts of the build you have decided on and the planner works
on the rest, which is the way to ask "what else can I do, given this weapon
stays". The lock survives a save, and it covers every route a suggestion could
take: the plan, the slot's own Recommended tab (disabled, and it says why),
its "more card slots" list, its roll advice, and a set that would have needed
that slot — a set is offered as one move that puts on everything missing, so a
set needing a locked slot is not offered at all rather than offered half-done.

Locking the **off hand** also stops a two-handed weapon being suggested for
the main hand while something is in it, because equipping one clears the off
hand — the one change that reaches past the slot it names.

An empty slot can be locked too ("leave this one alone"), and nothing stops
you from editing a locked slot by hand: the lock is an instruction to the
planner, not a catch on the slot. The "All items" tab and its "Best for goals"
sort keep working on a locked slot, because opening the picker is you
choosing, not the planner proposing.

The **Refine** option sets the refine a suggested piece is assumed to have.
**Auto** is the default: each piece a suggestion puts on is tried at every
refine and gets the lowest one that closes the most of the gap. It goes as
high as the goals reward and stops once they are met, and the refine it chose
is part of the suggestion's name ("+5 Pilfer Gem…"). Refine is only raised
where it can reach a goal (through the piece, a card in it, or its set's set
refine), so a piece whose refine does nothing for the goals is suggested at
+0. Gear you already wear keeps your refine. The other choices are a fixed
+0–+10, or "keep slot's".

**Met goals still count, at lower priority.** Beating a goal is worth a tenth
of closing the same gap below it, with diminishing returns. So a leech target
you have already hit still pulls towards more leech, but never outbids a goal
that is still short.

**The order of the goals is their priority**, and the ▲▼ arrows on each row
change it. Each goal counts three quarters of the one above it, so with
everything met the top goal is the one that gets the gear — which is the whole
reason to reorder: once your targets are all satisfied, move the stat you now
want most to the top. It is a lean rather than a veto. At three quarters a
step the third goal still counts more than half of the first, so a goal far
short of its target keeps outranking a small gain on one that is nearly there,
whatever the order says. `priorityWeight` in `sim/src/suggest.ts` is the rule.

**Sidegrades** are pieces that help one goal but cost another and come out no
better overall. They are listed after the upgrades, marked "Sidegrade", and
the plan never takes them.

**Dropping below a target you have met is its own category**, worse than any
sidegrade. A score says how good a build is on balance, and on balance a large
overshoot on one goal can outweigh a small drop on another — a surplus is
credited, a shortfall charged, and with the right magnitudes the sums come out
in favour of the swap. But a target that was met and is now missed is not a
smaller amount of good; it is the thing you asked for being taken away. So it
is judged as a category rather than a number:

- Nothing that does it is ever ranked above something that does not. Every
  list puts those last — after the upgrades *and* after the sidegrades — in
  the picker, in a slot's recommendations, and in the "more of this one goal"
  window, where they come after the trades whatever they buy. Wanting more of
  one number is not permission to fall below another.
- **The plan never takes such a step at all.** The point of the plan is to
  have every goal met, so a step that un-meets one is moving away from it.
  Those swaps stay in the lists, where they can be weighed by hand.
- The row says so: "Below Max HP %" in front of the label, and the goal's own
  delta chip is underlined in red wherever it appears, including the picker's
  item list. A plain red loss and a loss that costs you the target read
  differently, because they are different.

Only the crossing counts. A goal that was already short and gets shorter is
charged for it by the score in the ordinary way and shows as a loss — it was
not met, so there is no target to lose. `brokenGoals` in `sim/src/suggest.ts`
is the rule.

**More card slots** is its own section of the Recommended tab, and is shown
even with no goals set. It lists pieces for the slot with more sockets than
the one worn, most sockets first. The cards already worn carry over and fill
the new sockets, so a Weaver lower headgear shows up as "with Hell Poodle
Card ×2".

**Skill modifiers** ("Backstab damage +10%", "Heal cooldown -2 s") are added
up per skill and metric, shown under the stat totals, and can be goals. Skill
names come from the server's own skill list, and a line that names several
skills ("Freezing Spear and Wind Blades DMG +3%") counts for each one. Lines
about skills in general ("All 4 skills Damage") name no single skill, so they
stay in "Not counted".

**Each recommendation shows its full effect.** Your goals are shown inline.
Everything else it changes (stats, skill modifiers, derived totals) sits
behind a "N gains · N losses" button, which opens both lists side by side on
hover. Hover a recommended piece for its tooltip, at the refine and with the
cards the suggestion gives it.

Every recommendation row leads with the **icon** of what it puts on, the same
one the picker and the slot grid use, so a list of suggestions can be scanned
the way the picker is. A row that keeps the piece and only changes its cards
shows the cards instead, one icon per distinct card — four of the same card is
one icon, not four. A set move shows each piece it puts on, up to four.

**Full refine is offered alongside.** The refine a suggestion names is the
least that does the job; directly under it sits the same suggestion with its
new pieces at +10, marked "At full refine", so the two can be compared. Only
pieces the suggestion puts on are raised — worn gear keeps your refine — and
the row is left out where +10 changes nothing. The plan sticks to the minimum.

**Random options** appear in the Recommended tab for a piece that rolls. They
show the best option for each roll at the top of its range, or at the minimum
where the top is not known. A skill-damage roll is aimed at a skill your goals
name. It is advice for the next drop or reroll, so "Set rolls" fills the slot's
roll editor but the plan never counts on it. Accessories roll ATK +1%,
MATK +1% and a flat ASPD +1 on top of the headgear options (`crawler/rolls.json`).

Bonuses are coloured by what they do, not by their sign. A penalty is red and
a bonus green, and lower-is-better stats read the other way round: SP cost,
cast times, after-cast delay, cooldowns, damage received, and skill cooldown /
cast-time / SP-cost modifiers. So "SP Cost -10%" is green. The rule is
`effectTone` / `statTone` in `sim/src/format.ts`.

Every candidate is scored by building the whole character with it and running
the real aggregator, so set bonuses, refine steps, caps and off-hand halving
all count exactly as the stat panel counts them. Each goal is weighed as a
fraction of its own target, so 10 missing crit is not drowned out by 1,000
missing HP.

A percentage is weighed out of at least 100, whatever its target: it is a
multiplier, so ATK +5% is a twentieth more damage whether the goal started at
0 or at 40. Penetration is weighed as the damage it lets through, out of 100,
against the average level 130+ monster (208 DEF, 116 MDEF): through the
in-game pierce curve and renewal's DEF formula, 5 to 25 penetration is some
+17% damage, but 36 to 57 only +10%, so penetration stops outbidding melee%
once there is a fair amount of it. The goal list still shows the raw figure. Before
this, a percent goal starting at 0 counted each 1% as a whole target, and +14%
ATK outscored +3 AGI by several hundred times. `scaleOf` in
`sim/src/suggest.ts`.

**Accessories have sides.** Accessory 1 is the right hand's and 2 the
left's, as in the game. Most accessories go on either; the ones typed "Left
Accessory" (Gleipnir, Megingjard) or "Right Accessory" (Andvarinaut) only on
their own side, and a saved build with one on the wrong side has the two
swapped when it loads. The screenshot reader puts the equipment window's
left-column accessory in Accessory 2: accessories there are not mirrored the
way the weapons are.

**Sky Garden gear never rolls** random options, whatever its slot:
`never_from` in `crawler/rolls.json`.

**Recommendations, not a plan.** "Suggest changes" lists independent
upgrades, each measured from the build as it is: the best swap for every slot
and the best couple of sets (**Recommended**), the best cards for each piece
already worn, empty sockets first (**Cards for what you wear**), refines,
better-rolled copies, other sets, trades, and what is further off. One row can
still be several things at once -- a piece, with cards, at a refine -- but no
row depends on another. It used to be a greedy plan of steps that built on
each other; a chain hid every slot its first steps did not reach, and a player
picks an upgrade, not a route. `Suggester.plan` still exists for the route.
The same lists appear whether goals are short or met: a short goal simply
counts for more in each.

### Guard rails

Every build is held to two floors unless it says otherwise: **Max HP % ≥ -50**
and **SP sustain % ≥ -50**. Without them the scoring would happily trade most
of a character's HP or SP for a few points of whatever is being chased, because
nothing in a score says those two are what keeps you alive and casting rather
than stats like any other.

A guard is not a goal. It counts for nothing while it holds — so it never pulls
a suggestion towards more of itself, and costs the real goals nothing — and
counts for twice a top-priority goal once crossed. Crossing one from a build
that was above it is treated like breaking any other met target: ranked last,
flagged "Below …", and never planned. `GUARD_WEIGHT` and `DEFAULT_GUARDS` in
`sim/src/suggest.ts`.

**SP sustain** is the pool weighed against what a cast costs:
`(1 + MaxSP%) / (1 + SPCost%) - 1`, as a percentage. Guarding Max SP on its own
would be misleading — a build at -60% Max SP and -60% SP Cost casts exactly as
often as one with neither, and shadow gear trades one for the other on purpose.
So what is guarded is the ratio: casts you can afford. It is also offerable as
an ordinary goal ("SP sustain %").

They live under "Guard rails" in the Goals panel, folded away, with each target
editable and each removable. An absent `guards` field on a build means the
defaults; an empty array means the player took them off and meant it.

**Side goals: what every build cares about a little.** Besides the goals a
player sets, every suggestion is weighed against a few numbers that matter to
any character, each held where the build already is (`sideGoals` in
`sim/src/suggest.ts`):

| Side goal | Worth, per unit | Why |
| --- | --- | --- |
| Max HP % | 0.3 per 100%, both ways | every class lives on it: +10% is worth about +2 AGI to a 74 AGI build |
| Max SP % | losses only, 0.25 per 100% | every class uses it; crediting gains would let SP gear crowd out the goals |
| Leech (rate × power, HP and SP: avg % of damage returned) | 0.04 per 1%, both ways, physical builds only | how a physical build keeps its HP up; Evil Wing Ears' 15% chance of 3% is 0.45% |
| Resistance vs elements, vs races (averages) | 0.5 per 100%, both ways; a negative member counts double | good side goals whatever the build; a hole like Godslayer's -50% vs every race is devastating |
| Damage reduction (final, melee/ranged, physical/magic received) | 0.5 per 100%, both ways | the same, for everything at once |
| HP/SP on kill, as % of a 10,000 HP / 500 SP pool | 0.5 per 100% | pays for a great deal of HP and SP costs (Wyrdbrand) |
| ASPD Limit | 0.03 per point, physical builds only | what attack-speed builds run into; worth nothing to a caster |
| Perfect Dodge | 0.1 per 100, both ways | 100 is immunity to normal physical attacks, but not to skills: minor |
| VIT, INT (totals) | 0.003 per point | more HP, SP and regeneration for any build: a +6 Valkyrie Circlet is worth having |

All of these weights are calibrations, not measurements. Side goals never
rank and are never "broken" -- a little HP for a lot of damage is a trade to
weigh, not one to rule out -- but "Recommended" and the other upgrade lists,
which promise to lower nothing, leave anything that lowers one to the
sidegrades. None of their stats is ever filed under "not used by this
build". They are not stored on the build and cannot be removed; a goal of the
player's own on the same number takes its place, and each can be chosen as an
ordinary goal too.

### Filling a set

One piece on is enough to name a set, so the Sets panel offers **Fill** on any
set that is short: it works out which members are missing, where each one goes
— an empty slot first, then any slot not already holding a member — and puts
them all on in one move. Refines and cards already in those slots are kept
where they fit, as a hand swap would.

A locked slot is nowhere, so a set that needs one is offered greyed out rather
than half-done. Sets that list alternatives (seven Asgard accessories of which
any two count) stop once they have enough. `completeSet` / `fillSet` in
`sim/src/sets.ts`, which the planner's set moves use too.

### The "Not counted" panel

Anything real that could not be added up appears there with a reason:
conditional blocks (`With Bullhorn Armor:`), per-skill modifiers
(`Dragon Thrust DMG +20%`), and bonuses that scale off base stats this sheet
does not model yet.

That panel is the point. Without it those effects would silently vanish and the
totals would look more complete than they are.

## Base stats

The Base Stats panel takes the character's own points and shows each stat as
**points · gear · total**.

Bonuses written "per N base STAT" read the *points* column only, never the
total. That is what "base" means in the tooltip, and it matters: feeding the
combined figure back in would let a STR bonus raise a bonus that scales off
STR, which compounds on itself.

Scaling counts whole steps — `+1 per 5 base STR` at 49 STR is +9, not +9.8.
While a stat is left at zero, effects that scale off it are listed under
"Not counted" rather than silently contributing nothing.

## Leeching, element, and gated bonuses

**Leech is two stats, not one.** "8% chance to leech 5% of damage" is one
sentence describing a *rate* (how often) and a *power* (how much). Gear that
raises the chance stacks with gear that raises the amount, so they are parsed
into `leech_hp_rate` and `leech_hp_power` (and the SP pair) and totalled
separately. Collapsing them would be wrong in both directions.

**Element is a property, not a quantity.** A piece saying "Armor is Holy
Element" overrides the wearer's element rather than adding to anything. Only
one can hold: claims are collected in slot order, then set bonuses, and the
**first wins**. The losing claims are still shown, with a tooltip naming them —
otherwise swapping in a second element armour would change nothing on screen
with no explanation.

**Conditions on the character sheet are evaluated.** `Base STR 99:`,
`If base INT is 98 or above:` and `Base Level 130 or higher:` are parsed into
structured requirements and applied the moment the sheet satisfies them. Below
the gate they appear under "Not counted" saying exactly what they need
(`needs base STR 99 (have 80)`).

Conditions the sheet *cannot* answer — `With Bullhorn Armor:`, `On kill:` —
are still only listed, never guessed at in either direction.

## Known gaps

- **Conditions needing combat or party state are listed, not applied.** Only
  base stat and base level gates are evaluated; everything else stays in the
  "Not counted" panel.
- **Set bonuses require the full set.** Partial-set tiers are not modelled;
  the panel shows worn/total so you can see how close a set is.
- **Percent bonuses are shown, not applied.** The panel totals them in their own
  column; how they combine with flat values is the damage model's job.
- Stat coverage is 83.5% of parsed effects. See `data/parse-report.json`.

Refine is capped at **+10**, which is this server's limit (`MAX_REFINE` in
`sim/src/slots.ts`). A build saved under a different cap is clamped on load.

Base level is capped at **200** (`BASE_LEVEL_MAX` in `sim/src/types.ts`). That
one is a guess — the highest gate anywhere in the data is "Base Level 130 or
higher", and the dataset never states a ceiling.

### How far the longer-term lists look

"Longer-term goals", "Sidegrades" and "Worth target-farming" look past the
build's reach, but not without limit: 20 times its reach in grind and 5 times
in monster toughness (`FAR_EFFORT_FACTOR`, `FAR_KILL_FACTOR` in
`sim/src/suggest.ts`). Unlimited, a level 100 character was sent after a
Vesper Card and a Dedicated Scarf -- an MVP card and a drop off a level 170
with millions of HP -- over gear it could use this month. A refine of +6 is
assumed within reach from the start (`REACH_REFINE_FLOOR`), the top of the
HD ore tier. All of these are calibrations.

### Skills that scale off base stats

A Satsujin's Full Moon is "250 +50% per level +8% per AGI": at 90 AGI a point
of AGI is some 0.65% more damage, on top of its flee. Each class preset in
`data/class-goals.json` lists the skills its playstyle deals damage with
(`scaling`), read off their descriptions at max level by
`scalingFromDescription` in `sim/src/presets.ts` -- a test re-reads every entry
from the raw skill data, so a figure cannot drift from its tooltip. The
damage chains gain a last link for them (`melee_skill_mult`,
`ranged_skill_mult`, `phys_skill_mult`, `magic_skill_mult`): the geometric
mean, over the playstyle's skills, of how far the build's stats raise each
ratio. Where a class has several styles of one kind, the one its base stats
fit best is used. "Combo Ready adds +N% per STAT" lines count, since a
Satsujin's rotation hands Combo Ready out every Full Moon.

### Trading one set for another

A set suggestion that takes four or more pieces off is still left out -- that
is a different build -- unless what it takes off is one complete set: trading
Fallen Civilization for another shadow set is a decision players weigh. And
since a replaced set usually carried something (Fallen Civilization's SP cost
-50%), the best few such swaps are also tried together with the one change
elsewhere that wins most of it back, and listed as one trade: "Complete
Aggressive Orphan set + +6 Laevateinn with Pinguicula Card". Each set is
listed once, paired or not, whichever comes out ahead.

**Trades are also tried as combinations.** A trade usually costs something a
change or two elsewhere would win back: Fallen Civilization carries SP cost
-50%, and a refined Laevateinn in each hand gets much of it back. So the most
promising trades -- swaps of a whole set first, then the best others -- are
tried again with up to two more changes (`MAX_FIXES`), each the one that
leaves the whole worth most: a swap, cards, or refining a piece already worn,
in a slot the combination has not touched, never crossing a guard. A
combination that then lowers nothing at all is listed under Recommended, if
it is within reach; the rest are sidegrades like any other. One row, one
decision: "Complete Aggressive Orphan set + +6 Laevateinn with Pinguicula Card
+ +6 Laevateinn with Pinguicula Card (Off-hand)".

**A set is refined together.** Set refine is the sum over the pieces, so a
threshold like Aggressive Orphan's "set refine 9+ and again at 18+" is out of
any one piece's reach, and tuning one piece at a time left all four at +0.
The new pieces are raised together first, then each trimmed to the least that
keeps the result -- +3/+5/+5/+5, set refine 18, both +10% all-race tiers. A
set found in the trade search for one goal is re-tuned against every goal
before it is weighed.
