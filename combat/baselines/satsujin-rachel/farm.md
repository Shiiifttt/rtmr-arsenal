# Satsujin farming (2026-09-28, re-run after the fight-to-fight fixes)

`tools/farm.ts`, 15 min x 3 seeds per map. Kills an hour, share of time resting for SP, share fighting, deaths an hour. Re-run after two fixes: Seven Winds is recast per monster (it had carried the first monster's element), and a planned Hiding waits out its cooldown.

## Lv120-140 Distortions, full rotation (xmas_fut01, odin_past, 1@mcd, gl_cas01_)

### Sitting below 20% SP (the default)

| Setup | Kills/h | Sit | Fight | Deaths/h | Per map |
|---|---|---|---|---|---|
| owner | 576 | 43% | 31% | 0.0 | xmas_fut01 663, odin_past 553, 1@mcd 413, gl_cas01_ 675 |
| budget | 415 | 62% | 20% | 0.0 | xmas_fut01 525, odin_past 300, 1@mcd 313, gl_cas01_ 521 |
| allround | 368 | 63% | 21% | 0.0 | xmas_fut01 429, odin_past 335, 1@mcd 291, gl_cas01_ 419 |
| standard | 514 | 60% | 16% | 0.7 | xmas_fut01 653, odin_past 412, 1@mcd 416, gl_cas01_ 576 |
| standard-rings | 505 | 60% | 17% | 0.3 | xmas_fut01 627, odin_past 395, 1@mcd 389, gl_cas01_ 611 |
| endgame | 630 | 55% | 16% | 0.0 | xmas_fut01 757, odin_past 543, 1@mcd 436, gl_cas01_ 784 |
| standard + Laev | 695 | 51% | 17% | 0.0 | xmas_fut01 832, odin_past 617, 1@mcd 484, gl_cas01_ 845 |
| standard + Laev+basic | 714 | 29% | 36% | 2.0 | xmas_fut01 877, odin_past 665, 1@mcd 359, gl_cas01_ 955 |
| standard + Laguz+basic | 694 | 30% | 36% | 2.0 | xmas_fut01 868, odin_past 663, 1@mcd 388, gl_cas01_ 857 |
| owner + Mistress (Weaver) | 688 | 34% | 33% | 0.0 | xmas_fut01 808, odin_past 628, 1@mcd 457, gl_cas01_ 860 |
| owner + Mistress x2 (Weaver) | 915 | 15% | 43% | 0.3 | xmas_fut01 1063, odin_past 877, 1@mcd 561, gl_cas01_ 1159 |

### Sitting only below 5% SP

| Setup | Kills/h | Sit | Fight | Deaths/h | Per map |
|---|---|---|---|---|---|
| standard | 595 | 45% | 26% | 1.7 | xmas_fut01 704, odin_past 524, 1@mcd 461, gl_cas01_ 689 |
| standard + Laev | 761 | 42% | 24% | 0.0 | xmas_fut01 893, odin_past 603, 1@mcd 556, gl_cas01_ 991 |
| standard + Laev+basic | 856 | 9% | 50% | 2.3 | xmas_fut01 1025, odin_past 683, 1@mcd 508, gl_cas01_ 1208 |
| standard + Laguz+basic | 843 | 7% | 50% | 4.7 | xmas_fut01 987, odin_past 753, 1@mcd 505, gl_cas01_ 1128 |
| owner | 662 | 29% | 41% | 0.3 | xmas_fut01 709, odin_past 643, 1@mcd 484, gl_cas01_ 812 |
| owner + Mistress (Weaver) | 780 | 22% | 42% | 1.0 | xmas_fut01 960, odin_past 677, 1@mcd 489, gl_cas01_ 995 |
| owner + Mistress x2 (Weaver) | 973 | 9% | 47% | 0.0 | xmas_fut01 1075, odin_past 969, 1@mcd 561, gl_cas01_ 1285 |

## Resting with Lotus Pact instead of sitting (`--rest lotus`)

Lotus Pact Lv5 between fights: 3 s cast, 10 s at 5% HP/SP a second, recast off its cooldown, sitting in the gaps. Idle = sitting + Lotus time.

| Setup | Rest below | Sit: kills/h, idle | Lotus: kills/h, idle | Deaths/h (lotus) |
|---|---|---|---|---|
| standard | 20% SP | 514, 60% | 849, 35% | 0.7 |
| standard + Laevateinn +9 | 20% SP | 695, 51% | 1032, 26% | 0.7 |
| standard | 5% SP | 595, 45% | 875, 20% | 1.3 |
| standard + Laevateinn +9 | 5% SP | 761, 42% | 1053, 15% | 1.3 |
| owner | 20% SP | 576, 43% | 766, 23% | 0.7 |
| owner + Mistress | 20% SP | 688, 34% | 880, 15% | 0.3 |
| owner | 5% SP | 662, 29% | 836, 12% | 0.0 |
| owner + Mistress | 5% SP | 780, 22% | 939, 7% | 0.3 |

## Glast Heim Chivalry 2 (gl_knt02), Fan of Knives packs of 4

| Setup | Kills/h | Sit | Fight | Deaths/h | Per map |
|---|---|---|---|---|---|
| owner | 1569 | 0% | 53% | 0.0 | gl_knt02 1569 |
| budget | 1589 | 4% | 52% | 0.0 | gl_knt02 1589 |
| allround | 1420 | 11% | 48% | 0.0 | gl_knt02 1420 |
| standard | 1699 | 6% | 42% | 0.0 | gl_knt02 1699 |
| standard-rings | 1632 | 12% | 38% | 0.0 | gl_knt02 1632 |
| endgame | 1964 | 0% | 41% | 0.0 | gl_knt02 1964 |

Fan of Knives damage uses the 2023 server formula with status ATK counted once (Refuge patch 8); its new coefficient is unread. Lotus Pact's chance not to take damage is not modelled.
