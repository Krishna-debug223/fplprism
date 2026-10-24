# Squad of the Week selection check

The published squad maximizes the weighted single-Gameweek forecast subject to the FPL Bench Free Hit rules: 15 legal players, £100m budget, at most three per club, legal XI, captain and bench-role weights. Its expected score is a forecast, not a promise of the highest actual score.

For GW8, Gabriel (Arsenal) was the highest projected defender left out at 3.34 xPts and £7.9m. The published squad's weighted forecast was 48.557. Re-solving the same frozen forecast with Gabriel required gave 48.503, only **0.054 points lower**. The alternative replaces Lacroix, Rushworth and Mukiele with Gabriel, van Ewijk and Dubravka. This is a near tie, not a confident prediction that Gabriel would score less. The original GW8 selection and its [snapshot hash](../public/modelbook/data/gw8-snapshot-meta.json) remain unchanged.

We tested simple selection changes on the archived v1.4.3 walk-forward forecasts. Historical prices came from the last recorded Gameweek; target-week team membership and results came from the public archive. Each squad was scored with captain and legal auto-subs. These are exploratory reconstructions, not literal saved pre-deadline squads.

| Selection input or tie-break | 2025–26, 35 GWs | 2026–27, GW4–6 |
| --- | ---: | ---: |
| Published calibrated xPts objective | **2,200** | 145 |
| Raw xPts before position calibration | 2,167 | 147 |
| Half calibrated, half raw | 2,183 | 142 |
| Add 0.5 xPts to every defender | 2,170 | 142 |
| Prefer starter points within 0.1 weighted xPts | 2,173 | 142 |
| Prefer starter points within 0.25 weighted xPts | 2,170 | **153** |

The small current-season sample does not offset the weaker full-season results. We therefore retained the original maximum-forecast selection rule and added a forced-player comparison to explain close omissions. The historical forecast source, scoring limitations and calibration caveats are documented in [the replay method](historical-replay/README.md). Run `npm run squad:research` to repeat this comparison against the frozen forecast files and matching historical source hashes.
