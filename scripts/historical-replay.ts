import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { MODEL_VERSION } from "../lib/risk-v12";
import {
  actualsByPlayer, column, forecastGameweek, forecastMetadata, gwOf, integer, metrics, parseCsv,
  type CsvRow, type HistoricalForecast, type Observation, type TeamCsv,
} from "./backtest";

const season = process.env.REPLAY_SEASON ?? "2025-26";
const startGw = Number(process.env.REPLAY_START_GW ?? 4);
const endGw = Number(process.env.REPLAY_END_GW ?? 38);
const phase = process.env.REPLAY_PHASE ?? "forecast";
const base = `https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/${season}`;
const forecastPath = resolve(`reports/historical-replay/forecast-${MODEL_VERSION}-${season}-GW${startGw}-${endGw}.json`);
const scorePath = resolve(`reports/historical-replay/score-${MODEL_VERSION}-${season}-GW${startGw}-${endGw}.json`);

function sha(value: string) { return createHash("sha256").update(value).digest("hex"); }
function modelCodeHash() {
  return sha(["lib/risk.ts", "lib/risk-v12.ts", "lib/types.ts", "scripts/backtest.ts", "scripts/historical-replay.ts"]
    .map((path) => readFileSync(resolve(path), "utf8")).join("\n"));
}
async function source(name: string): Promise<{ rows: CsvRow[]; hash: string; url: string }> {
  const url = `${base}/${name}`;
  const response = await fetch(url, { headers: { "User-Agent": "FPL-Prism-Historical-Replay/1.0" } });
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  const body = await response.text();
  return { rows: parseCsv(body), hash: sha(body), url };
}
function teamsFrom(rows: CsvRow[]): TeamCsv[] {
  return rows.map((row) => ({
    id: integer(column(row, "id")),
    name: column(row, "name"),
    shortName: column(row, "short_name", "shortName", "name").slice(0, 3).toUpperCase(),
  })).filter((team) => team.id && team.name);
}
type ForecastFile = {
  modelVersion: string; season: string; startGw: number; endGw: number;
  generatedAt: string; codeHash: string; source: { mergedGw: string; teams: string; mergedGwHash: string; teamsHash: string };
  predictions: HistoricalForecast[]; forecastHash: string;
};
function metricViews(rows: Observation[]) {
  return {
    calibrated: metrics(rows),
    uncalibrated: metrics(rows, (row) => row.rawPredicted ?? row.predicted, undefined, false),
    flatTwo: metrics(rows, () => 2, undefined, false),
  };
}
async function forecast() {
  const [data, teamSource] = await Promise.all([source("gws/merged_gw.csv"), source("teams.csv")]);
  const teams = teamsFrom(teamSource.rows);
  const predictions: HistoricalForecast[] = [];
  for (let gw = startGw; gw <= endGw; gw += 1) {
    const target = data.rows.filter((row) => gwOf(row) === gw).map(forecastMetadata);
    if (!target.length) continue;
    const history = data.rows.filter((row) => gwOf(row) > 0 && gwOf(row) < gw);
    const weekly = forecastGameweek(target, history, teams, gw);
    predictions.push(...weekly);
    console.log(`GW${gw}: froze ${weekly.length} player forecasts from ${history.length} earlier fixture rows`);
  }
  if (!predictions.length) throw new Error(`No predictions for ${season} GW${startGw}-${endGw}`);
  const file: ForecastFile = {
    modelVersion: MODEL_VERSION, season, startGw, endGw,
    generatedAt: new Date().toISOString(), codeHash: modelCodeHash(),
    source: { mergedGw: data.url, teams: teamSource.url, mergedGwHash: data.hash, teamsHash: teamSource.hash },
    predictions, forecastHash: sha(JSON.stringify(predictions)),
  };
  mkdirSync(dirname(forecastPath), { recursive: true });
  writeFileSync(forecastPath, JSON.stringify(file, null, 2));
  console.log(`Forecasts frozen: ${forecastPath}\nSHA256: ${file.forecastHash}`);
}
async function score() {
  const file = JSON.parse(readFileSync(forecastPath, "utf8")) as ForecastFile;
  if (file.season !== season || file.modelVersion !== MODEL_VERSION || file.startGw !== startGw || file.endGw !== endGw) throw new Error("Forecast artifact metadata mismatch");
  if (file.forecastHash !== sha(JSON.stringify(file.predictions))) throw new Error("Forecast artifact hash mismatch");
  if (file.codeHash !== modelCodeHash()) throw new Error("Model source changed between forecast and score phases");
  for (const row of file.predictions) {
    if (Object.keys(row).some((key) => /actual|minutes|total_points|bonus/i.test(key))) throw new Error("Outcome data found in forecast artifact");
  }
  const [data, teamSource] = await Promise.all([source("gws/merged_gw.csv"), source("teams.csv")]);
  if (file.source.mergedGwHash !== data.hash || file.source.teamsHash !== teamSource.hash) throw new Error("Historical source changed between phases");
  const actuals = new Map<number, ReturnType<typeof actualsByPlayer>>();
  for (const gw of new Set(file.predictions.map((row) => row.gw))) {
    actuals.set(gw, actualsByPlayer(data.rows.filter((row) => gwOf(row) === gw)));
  }
  let doubleGameweekPlayerWeeks = 0;
  const rows: Observation[] = file.predictions.map((prediction) => {
    const outcome = actuals.get(prediction.gw)?.get(prediction.playerId);
    if (!outcome) throw new Error(`Missing outcome for GW${prediction.gw} player ${prediction.playerId}`);
    if (outcome.fixtures > 1) doubleGameweekPlayerWeeks += 1;
    return { ...prediction, actual: outcome.points, appeared: outcome.minutes > 0 ? 1 : 0 };
  });
  const positions = ["GKP", "DEF", "MID", "FWD"];
  const gameweeks = [...new Set(rows.map((row) => row.gw))].sort((a, b) => a - b);
  const topN = (n: number) => gameweeks.flatMap((gw) => rows.filter((row) => row.gw === gw).sort((a, b) => b.predicted - a.predicted).slice(0, n));
  const topPickView = (n: number) => {
    const picks = topN(n);
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      n: picks.length,
      expectedAverage: Number(average(picks.map((row) => row.predicted)).toFixed(4)),
      actualAverage: Number(average(picks.map((row) => row.actual)).toFixed(4)),
      haulRate: Number(average(picks.map((row) => row.actual >= 10 ? 1 : 0)).toFixed(4)),
      calibrated: metrics(picks),
      uncalibrated: metrics(picks, (row) => row.rawPredicted ?? row.predicted, undefined, false),
    };
  };
  const report = {
    modelVersion: MODEL_VERSION, season, scoredAt: new Date().toISOString(), forecastPath,
    forecastHash: file.forecastHash, codeHash: file.codeHash,
    sample: { playerGameweeks: rows.length, gameweeks, doubleGameweekPlayerWeeks, activePlayers: rows.filter((row) => row.appeared).length },
    methodology: {
      forecastFirst: true,
      targetDataAllowedInForecast: "Player identity, position, team and fixture metadata only; target points, minutes, xG and bonus are excluded.",
      scoring: "One prediction per player per Gameweek compared with summed FPL points across all fixtures in that Gameweek.",
      calibrationTrainingSeason: "2024-25",
      caveats: [
        "This is a walk-forward reconstruction from post-match public archives, not a literal pre-deadline forecast archive.",
        "Target-week player identity/team/fixture metadata are reconstructed from the archive; roster and fixture changes may not have been knowable at the original deadline.",
        "Historical injury, suspension, official team-strength, and sportsbook snapshots are unavailable; the replay substitutes neutral availability and lagged team xG strength.",
        "Historical multi-season player-prior profiles are unavailable, so this replay uses current-season prior rows only.",
        "Players without any current-season prior row are excluded. The 2024-25 calibration used an earlier harness later found to score double Gameweeks by fixture, which can bias its coefficients.",
        "2025-26 was examined during v1.4.1 development, so it is after the coefficient-training season but not an untouched pre-registered test set.",
      ],
    },
    all: metricViews(rows),
    active: metricViews(rows.filter((row) => row.appeared)),
    byPosition: Object.fromEntries(positions.map((position) => [position, { all: metricViews(rows.filter((row) => row.position === position)), active: metricViews(rows.filter((row) => row.position === position && row.appeared)) }])),
    byGameweek: Object.fromEntries(gameweeks.map((gw) => [gw, metricViews(rows.filter((row) => row.gw === gw))])),
    topPicks: Object.fromEntries([10, 20, 50].map((n) => [n, topPickView(n)])),
  };
  writeFileSync(scorePath, JSON.stringify(report, null, 2));
  console.log(`Scored: ${scorePath}`);
  console.log(JSON.stringify({ sample: report.sample, all: report.all, active: report.active, topPicks: report.topPicks }, null, 2));
}
if (!Number.isInteger(startGw) || !Number.isInteger(endGw) || startGw < 2 || endGw > 38 || startGw > endGw) throw new Error("Invalid Gameweek range");
(phase === "forecast" ? forecast() : phase === "score" ? score() : Promise.reject(new Error(`Unknown phase: ${phase}`)))
  .catch((error) => { console.error(error); process.exitCode = 1; });
