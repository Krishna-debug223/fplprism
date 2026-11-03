# GW10 projection review · 3 November 2026

## What was low

The GW10 public snapshot used model 1.4.5 and included all ten fixtures and 670 players. Arsenal–Hull, Bournemouth–Ipswich and Nottingham Forest–Manchester City were mapped correctly. The official FPL bootstrap returned zero for all four attack and defence strength fields for all 20 clubs, making the model's static team-strength factor exactly neutral. The model still used FDR, venue, recent form, player xG/xA and team underlying numbers, but one relative matchup signal was absent.

The live feed also exposes a match as `finished_provisional` before `finished`. During that interval, cumulative player xG and starts can already include the match while the model's completed-match denominator and recent-form inputs do not. Version 1.4.6 accepts a provisionally completed match with a recorded final score as prior evidence. An in-progress match remains excluded.

## Change

When official ratings are zero, derive modest attack and defence ratings from each club's pre-match xG and xGA, shrunk toward the league mean with six match equivalents. Preserve nonzero official ratings. This brings the live input treatment closer to the documented historical replay and restores a directional fixture signal. The position calibration, minutes mixture, FPL scoring and sportsbook weight are unchanged. The locked GW9 forecast is untouched.

In a local replay of the 3 November live feed, the change moved the largest individual GW10 xPts by less than 0.05. Illustrative values: Tavernier 3.94→3.98, Evanilson 3.69→3.74, Gabriel 3.56→3.58, Raya 3.02→3.04; Haaland stayed 4.85. These are timestamped examples, not a promise that live values will stay fixed before the deadline.

## Validation and limits

The walk-forward backtest uses only earlier Gameweeks to estimate each target week. Its historical inputs lack original official team-strength snapshots, availability news and the live multi-season priors. The new fallback was compared with the previous synthetic strength calculation on the same observations:

| Holdout | Method | All-player MAE | All-player within ±2 | Active-player MAE | Active-player within ±2 |
| --- | --- | ---: | ---: | ---: | ---: |
| 2025–26 GW4–38 | Previous | 1.0496 | 85.99% | 1.9620 | 71.41% |
| 2025–26 GW4–38 | v1.4.6 fallback | 1.0496 | 85.99% | 1.9620 | 71.40% |
| 2026–27 GW4–7 | Previous | 1.2035 | 83.43% | 1.9730 | 70.21% |
| 2026–27 GW4–7 | v1.4.6 fallback | 1.2035 | 83.54% | 1.9731 | 70.31% |

The differences are tiny and do not establish an accuracy gain. The production fix is justified by the missing live input and bounded impact, not by a claim that it solves the model's error rate. The historical replay is an approximation of live pre-deadline information, as its JSON reports explain.

We also tested removing the entire negative calibration adjustment from the genuine frozen GW8 and GW9 player rows with at least 1% ownership. Within ±2 fell from 66.1% to 59.1% for GW8 and from 71.5% to 65.6% for GW9. That counterfactual raises many xPts but makes this cohort less accurate. GW9's final official point values did not change when FPL switched its fixtures from provisional to final.

The GW10 forecast remains live until the official deadline, then the scheduled Modelbook lock fixes its exact version and hash. No result from GW10 was used to choose this adjustment.
