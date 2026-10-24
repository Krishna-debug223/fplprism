# Bookmaker odds study: opening prices and team scoring

The existing sportsbook connector remains disabled in production. This study tests whether odds can improve the team-scoring inputs that feed FPL Prism's player projections. It does **not** establish an improvement in player xPts or Free Hit squad points.

## Method

- Source: [Football-Data](https://www.football-data.co.uk/downloadm.php) Premier League season CSVs. Only the columns without `C` (earlier average 1X2 and over/under 2.5 odds) were used. Closing odds were excluded because they can reflect news after the FPL deadline.
- De-vig each market, infer a total-goals mean from over/under 2.5, then divide it between teams using the 1X2 probabilities.
- Build the comparison team's expected goals from only *earlier* FPL Gameweeks' team xG. No target-match xG or result is used in the forecast.
- Select the blend weight on 2023–24 and 2024–25 (701 matched fixtures). Evaluate once on 2025–26 (350 matched fixtures), which was not used to select the weight.
- Results are reproducible with `npm run sportsbook:calibrate`; the full numeric report is in `sportsbook-calibration-opening-2025-26.json`.

| 2025–26 holdout measure | Team xG baseline | + 25% market blend | Change |
| --- | ---: | ---: | ---: |
| Goal-count root mean square error | 1.0859 | 1.0803 | 0.0056 lower |
| Poisson negative log-likelihood | 1.4438 | 1.4398 | 0.00396 lower |
| Clean-sheet Brier score | 0.18067 | 0.17923 | 0.00144 lower |

The 2,000-resample Gameweek-cluster bootstrap intervals for improvement were +0.00159 to +0.00647 in goal negative log-likelihood and +0.00075 to +0.00218 in clean-sheet Brier. These intervals describe this *match-level* reconstruction; they do not cover source-timing uncertainty or player-model error.

An additional sensitivity check applied the same bounded market factor to 27,102 reconstructed 2025–26 player forecasts. For the 10,416 players who actually appeared, average absolute point error moved from **1.9677 to 1.9683** and the share within two points moved from **70.86% to 70.81%**; root mean square error improved slightly from 3.1023 to 3.0977. Among active defenders, average absolute error moved from 2.1964 to 2.1936, a very small improvement. This check approximates where the market factor enters the full player model, and the reconstructed forecasts are not independent prospective predictions. The mixed result is not a basis for switching the live model.

## Deployment gate

The blend **is not enabled** in the live FPL Prism model. Football-Data identifies the earlier prices as collected after market opening, but the CSV does not provide a timestamp for each quote. A price cannot be certified as available before every FPL deadline. The test uses a simplified team-xG baseline and an approximate player-model adjustment. Before enabling the feed, collect timestamped odds before several upcoming deadlines, freeze those inputs with the corresponding player projections, and compare player MAE, ranking quality, clean-sheet calibration and actual Free Hit scores with the existing model. Purchase of historical The Odds API access is not needed for this exploratory study; its timestamped historical endpoint is a paid plan feature.

The live feed already accepts The Odds API when configured. It remains behind `SPORTSBOOK_ENABLED` and `SPORTSBOOK_MODEL_WEIGHT=0`. The connector now matches each quote to its exact FPL fixture, avoiding cross-contamination when a club plays twice in one Gameweek.
