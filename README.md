# FPL Prism

FPL Prism is a Fantasy Premier League decision workspace for managers who want to compare expected points, uncertainty, transfer cost and squad legality before making a move.

The product is live at **[fplprism.com](https://fplprism.com/dashboard)**. It uses the public FPL feed and keeps the reasoning visible: every projection can be opened, inspected by scoring component and compared across a real fixture horizon.

## Product

| Surface | What it does |
| --- | --- |
| [Dashboard](https://fplprism.com/dashboard) | Imports a public FPL Team ID, shows the current Gameweek, live projections, confidence, the decision desk, the live market rail and a model snapshot. |
| **Overview** | Forecast, fixture and reasoning views for the leading players, with one, three and five Gameweek horizons. |
| **My Team** | Displays the imported 15-player squad, starting XI, bench order, captaincy, bank, team value, projected points, team risk, squad signals and chip guidance. |
| **Transfer Lab** | Selects players from the pitch, evaluates joint transfer packages and enforces position, budget, ownership, club-limit, availability, free-transfer and hit rules. |
| **Player Market** | Ranks the current player pool by projected points and opens the same component-level explanation used elsewhere in the app. |
| **Model** | Explains the expected-points components, fixture context, data quality, confidence, horizons, legal-transfer checks and optional market prior. |
| [8-GW Path Planner](https://fplprism.com/planner) | Searches roll, single-transfer and two-transfer paths across eight Gameweeks in Safe, Balanced and Aggressive modes. |
| [Pricing](https://fplprism.com/pricing) | Keeps the complete product free during launch. Pro and Elite are roadmap tiers; no paid checkout or automatic renewal is active. |
| **Account / sign in** | Optional Supabase-backed settings for saving a public Team ID, free-transfer default and planner style. An FPL password is never requested. |
| [FPL Prism Modelbook](https://fplprism.com/modelbook) | Public, timestamped forward-test workspace linked from the dashboard. |
| [Forecast benchmark](https://fplprism.com/modelbook/benchmark) | Frozen-forecast error and ranking diagnostics with a machine-readable CSV feed for independent comparisons. |
| [Squad of the Week](https://fplprism.com/modelbook/squad-of-the-week) | Optimizes a legal Free Hit squad, captain, vice and bench from the same public projection snapshot. |
| [About](https://fplprism.com/about) and [Contact](https://fplprism.com/contact) | Explain the project, its limits, and where to send feedback or privacy questions. |

The production dashboard reports the current Gameweek and model version from the live feed. The current source model is **`1.4.3`**; the live Modelbook follows **Gameweek 9**. GW3–GW6 and GW8 retain their archived forecasts; GW8's points remain provisional until FPL marks every fixture final. GW7 is explicitly labelled a retrospective audit because its original pre-deadline export was not retained. It is excluded from prospective benchmark results. Both surfaces show the target Gameweek and training status.

The scheduled Modelbook workflow checks the official FPL deadline every five minutes, captures an immutable production export in the final ten minutes before the deadline, fingerprints it with SHA-256 and publishes it to `main`. If a lock is missing after a deadline, the Modelbook hides the recalculated forecast instead of presenting it as the original. Once all fixtures are provisionally finished, the workflow builds the historical report from that frozen export and official points.

### Advertising

AdSense Auto ads are enabled for eligible public pages, with the required [`ads.txt`](public/ads.txt) declaration. The publisher client is `ca-pub-1252559919094271`. Dashboard, planner, account and authentication routes are excluded in both the app and AdSense so ads stay off interactive and private screens. Fixed responsive display units can be added later with `NEXT_PUBLIC_ADSENSE_SLOT_TOP` and `NEXT_PUBLIC_ADSENSE_SLOT_BOTTOM` in Vercel. Final ad serving still depends on Google approving the site.

## Model overview

The active model is component-based and fixture-aware. It combines:

- an explicit start / cameo / no-appearance minutes mixture with p10–p90 minutes, substitution variance and rotation risk;
- official FPL status, chance-of-playing fields and injury/fitness news as availability signals;
- position-specific goals, assists, clean sheets, saves, bonus, defensive contribution and discipline;
- player xG, xA and defensive rates with small-sample shrinkage;
- team and opponent attack/defence strength, venue, FDR, recent results and optional ClubElo;
- historical player priors from completed seasons when current-season samples are thin;
- event-aware horizons where Double Gameweeks count twice and Blank Gameweeks contribute no fixture points;
- legal transfer filtering before ranking, including budget, position, ownership and the three-player club limit;
- seeded 10,000-path simulation for expected gain, beat-hold probability, downside and p10/p50/p90 outcomes.

The optional [The Odds API](https://the-odds-api.com/) connector uses its free EPL coverage when `THE_ODDS_API_KEY` is set as a server-side Vercel environment variable. It requests one UK region and the win/draw/loss and total-goals markets, caches each provider response for 12 hours, and skips requests when no EPL fixture is due within 14 days. The free plan provides 500 credits a month; the two-market request costs two credits, so a continuously warm cache would use roughly 120 credits in a 30-day month. Cache eviction, deployments or other uses of the same key can increase that number, so monitor the provider's usage counter. Set `SPORTSBOOK_ENABLED=false` to stop requests. No key is configured in the repository.

Market observations are stored with future predeadline Modelbook snapshots for prospective evaluation. The production model weight remains `0`, so the connector cannot alter current player xPts, frozen forecasts or Squad of the Week until a player-level test supports it. When no market data is available, the core model continues unchanged.

[The opening-odds study](reports/sportsbook-opening-study.md) found a small improvement in historical match-goal and clean-sheet predictions, while an approximate player-point check was mixed. Its free CSV source is restricted to personal or academic use, so it is not part of the commercial model pipeline. The production weight stays at zero while commercially permitted, timestamped predeadline odds and full player-model outcomes are collected.

The model version is defined in [`lib/risk-v12.ts`](lib/risk-v12.ts). A version change is required for material changes to weights, priors, thresholds, simulation logic or data sources.

The latest current-season walk-forward validation is recorded in [`reports/backtest-1.4.3-2025-26.json`](reports/backtest-1.4.3-2025-26.json). Each target Gameweek is evaluated using only earlier Gameweek rows. Backtests are separate from frozen live forecasts.

### Independent benchmark feed

`GET /api/benchmark/forecast?event=8` returns a CSV with `fpl_id`, `expected_points`, `price_millions`, `team_id`, `position`, and `ownership_percent`. The HTTP headers include its generation time, model version, and CSV SHA-256. `GET /api/ledger/snapshot?event=8` remains the complete JSON source, including fixture and scoring components. Before the deadline, both reflect the latest model; after the deadline they only serve a genuine frozen snapshot. The scheduled Modelbook job updates [`benchmark-report.json`](public/modelbook/data/benchmark-report.json) from archived locks and official points.

The [benchmark page](https://fplprism.com/modelbook/benchmark) uses the >=1% ownership and scheduled-fixture cohort for MAE/RMSE, and all forecast players with a fixture for top-15 diagnostics. Its NDCG uses a disclosed local gain rule; it is not an official FPL Bench score. GW6 is an early checkpoint, GW5 official points are still marked provisional in the stored feed, and GW7 is excluded because its forecast was reconstructed after the deadline.

The [Squad of the Week](https://fplprism.com/modelbook/squad-of-the-week) uses the permissively licensed HiGHS mixed-integer solver to maximize the published role-weighted xPts: 2 GKP, 5 DEF, 5 MID, 3 FWD, £100m or less, at most three per club, a legal XI, captain, vice and ordered bench. It runs against the exact Modelbook export and shows the optimizer status and snapshot hash. Completed Gameweeks are scored separately with official player points, vice-captain fallback and formation-safe auto-subs. The FPL Bench organizer's own collected snapshot and score remain the benchmark authority.

### Weekly learning loop

When a Gameweek closes, its official minutes, starts, underlying rates, player
availability and fixture outcomes flow into the next projection. The model gives
current-season evidence more weight as its sample grows and keeps historical priors
for players with limited minutes. Every update is checked with deterministic model
tests and a walk-forward backtest; we do not apply a one-week blanket correction
that could overfit a noisy result. The dashboard and Modelbook publish the target
Gameweek, training cutoff and data refresh time together so the live number has a
clear provenance.

## Data and privacy

- Current player, team, event and fixture data comes from the public FPL endpoints through the routes in [`app/api/fpl`](app/api/fpl).
- Historical player priors come from the [Vaastav Fantasy Premier League archive](https://github.com/vaastav/Fantasy-Premier-League).
- Optional team-strength enrichment comes from [FPL-Core-Insights](https://github.com/olbauday/FPL-Core-Insights) / ClubElo.
- Optional sign-in and saved defaults use Supabase. Guest use remains available.
- Vercel Analytics and Speed Insights measure product usage and performance without sending Team IDs, manager names, player names, email addresses or free-form text in product events.

Read the [privacy page](https://fplprism.com/privacy) and [terms](https://fplprism.com/terms) before using or redistributing the product.

## Run locally

```bash
npm install
npm run dev
```

Create `.env.local` from [`.env.example`](.env.example) when you need canonical URL, contact, Supabase or sportsbook settings. The public dashboard and model checks run without a database or FPL credentials.

Useful checks:

```bash
npm run typecheck
npm run build
npm run model:check
npm run model:check:v12
npm run modelbook:check
```

The GitHub Actions workflow runs the type check, both deterministic model suites, the walk-forward backtest and the production build on pushes and pull requests.

## Repository map

| Directory | Purpose |
| --- | --- |
| `app/` | Next.js routes, metadata, legal pages and API endpoints. |
| `components/` | Dashboard, decision desk, squad pitch, planner, account and shared UI components. |
| `lib/` | FPL types and data access, projection engines, transfer logic, strategy planner, analytics and optional integrations. |
| `scripts/` | Deterministic validation, backtesting and Modelbook automation utilities. |
| `.github/workflows/` | Continuous validation and production-build checks. |

## Deployment

The repository is connected to Vercel. A push to `main` builds the Next.js app using the checked-in [`vercel.json`](vercel.json). Keep secrets in Vercel environment variables; never commit `.env.local` or provider keys.

## Disclaimer

FPL Prism is an independent project and is not affiliated with, endorsed by or sponsored by the Premier League. Forecasts and transfer recommendations are probabilistic decision aids, not guarantees. Third-party football data remains subject to its providers' terms and licensing requirements.
