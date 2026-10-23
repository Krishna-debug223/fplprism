# Model v1.4.1 historical replay

For subsequent model changes and their comparisons against this baseline, see the [v1.4.2 playing-time findings](v1.4.2-findings.md) and [v1.4.3 goalkeeper scoring findings](v1.4.3-findings.md).

The replay saved each Gameweek's player forecasts before a separate process loaded the corresponding FPL points. Each forecast used only earlier Gameweek player and team statistics. The target Gameweek supplied identity, team and fixture metadata only; the scoring pass later summed points across any double Gameweek fixtures. Forecast files and source files are SHA-256 checked during scoring.

This is a **walk-forward reconstruction**, not an archived prediction made before those deadlines. Target-week squad and fixture metadata come from the post-match archive, and historical injury, suspension, team-strength, multi-season player priors and bookmaker snapshots are unavailable. Players without a prior current-season row are excluded. The 2024–25 calibration coefficients in the tested model were fitted with an older harness that scored double Gameweeks incorrectly, so the calibration needs refitting before any claim of definitive improvement.

Source: [vaastav/Fantasy-Premier-League historical Gameweek data](https://github.com/vaastav/Fantasy-Premier-League). The 2026–27 archive currently has rows through GW6; GW7 cannot be scored from this source yet.

## Players who appeared (at least one minute)

`Within ±2` means absolute forecast error of at most 2 FPL points. `Bias` is forecast minus actual; a negative value means the model underpredicted. The flat-two benchmark predicts 2 points for everyone.

| Season | GWs | Players | Model MAE | Model RMSE | Model within ±2 | Raw within ±2 | Flat-two within ±2 | Model bias |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2023–24¹ | 4–38 | 10,183 | 1.910 | 3.125 | 72.21% | 68.39% | 76.88% | −0.935 |
| 2024–25¹ | 4–38 | 10,485 | 1.817 | 2.933 | 73.95% | 69.72% | 78.43% | −0.848 |
| **2025–26** | **4–38** | **10,416** | **1.963** | **3.096** | **70.68%** | **67.57%** | **77.17%** | **−1.057** |
| 2026–27 | 4–6 | 923 | 1.948 | 3.122 | 70.10% | 68.47% | 76.38% | −0.988 |

¹ These seasons precede or overlap the calibration training data and are exploratory stress tests. **2025–26 is the first full season after the 2024–25 coefficient-training period**, but its results were inspected during v1.4.1 development, so it is not an untouched pre-registered test set. The 2026–27 archive is partial.

For 2025–26, raw (uncalibrated) MAE was 1.969 and RMSE 2.981. Calibration gained 3.11 percentage points within ±2, but improved MAE by just 0.006 points and worsened RMSE by 0.115 points. The flat-two benchmark achieved a higher within-±2 rate than the model, although the model had slightly better MAE (1.963 vs 1.970) and RMSE (3.096 vs 3.189). The within-±2 target alone rewards a trivial two-point forecast and should not be the sole model goal.

### 2025–26 by position, players who appeared

| Position | Players | Model MAE | Model within ±2 | Flat-two within ±2 | Bias |
| --- | ---: | ---: | ---: | ---: | ---: |
| Goalkeeper | 696 | 2.043 | 66.09% | 73.13% | −1.004 |
| Defender | 3,582 | 2.193 | 65.72% | 73.31% | −1.317 |
| Midfielder | 4,833 | 1.779 | 74.96% | 80.65% | −0.876 |
| Forward | 1,305 | 1.974 | 70.88% | 77.01% | −1.041 |

Goalkeeper and defender errors remain the clearest weakness. Defender forecasts underpredicted by an average 1.32 points among players who appeared. A flat two-point prediction still beats the calibrated model on within ±2 in every position.

### Decision-useful top picks

Across 2025–26, the ten highest projected players in each GW averaged **4.39 projected points and 4.78 actual points** (350 player-GW picks); 15.14% scored at least 10 points. In the current 2026–27 archive (GW4–6), the top ten averaged **3.79 projected and 4.23 actual** (30 picks). These are ranking diagnostics, not proof that a manager following recommendations would gain that many points over their existing squad.

## Reproduce

From the repository root:

```sh
npm run replay:compile
REPLAY_SEASON=2025-26 REPLAY_START_GW=4 REPLAY_END_GW=38 npm run replay:forecast
REPLAY_SEASON=2025-26 REPLAY_START_GW=4 REPLAY_END_GW=38 npm run replay:score
```

Forecasts and score reports are saved separately in this directory. The 2025–26 forecast SHA-256 is `24d57a818e5b0f73bd267c949270865424ba965aa7f0b6f01823aa6a9e3989f1`; the score phase refuses altered forecasts, changed model source, or changed archive sources. The other seasons use the same procedure with `REPLAY_SEASON=2023-24`, `2024-25`, or `2026-27` (the last with `REPLAY_END_GW=7`, though only GWs 4–6 are present).
