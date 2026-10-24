import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { parseCsv, column, gwOf, actualsByPlayer } = require("../.backtest-build/scripts/backtest.js");
const { buildFreeHitModel, selectFreeHitSquad, scoreFreeHitSquad, validateFreeHitSquad } = require("../.squad-check/free-hit-squad.js");
const loadHighs = require("highs");

const seasons = [
  ["2025-26", 38],
  ["2026-27", 7],
];
const variants = {
  calibrated: (row) => row.predicted,
  raw: (row) => row.rawPredicted,
  halfBlend: (row) => (row.predicted + row.rawPredicted) / 2,
  defenderBoost: (row) => row.predicted + (row.position === "DEF" ? 0.5 : 0),
};
const roleWeight = { captain: 2, vice: 1.0322, starter: 1, benchGoalkeeper: 0.0194, bench1: 0.2603, bench2: 0.0751, bench3: 0.0165 };
const normalized = (value) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const highs = await loadHighs();

function starterFirstNearTie(pool, optimum, tolerance) {
  const { model, choices } = buildFreeHitModel(pool);
  const weighted = choices.map(({ player, role, variable }) => `${(player.projected * roleWeight[role]).toFixed(8)} ${variable}`).join(" + ");
  const starters = choices.map(({ player, role, variable }) => ({ coefficient: player.projected * (role === "captain" ? 2 : role === "vice" || role === "starter" ? 1 : 0), variable }))
    .filter(({ coefficient }) => coefficient > 0)
    .map(({ coefficient, variable }) => `${coefficient.toFixed(8)} ${variable}`).join(" + ");
  const adjusted = model.replace(/ obj: .*\nSubject To/, ` obj: ${starters}\nSubject To`)
    .replace(/\nBinaries\n/, `\n primary_floor: ${weighted} >= ${(optimum - tolerance).toFixed(8)}\nBinaries\n`);
  const solution = highs.solve(adjusted, { output_flag: false, mip_rel_gap: 0, time_limit: 30 });
  if (solution.Status !== "Optimal") throw new Error(`Tie-break status: ${solution.Status}`);
  const picks = choices.filter(({ variable }) => solution.Columns[variable]?.Primal > 0.5)
    .map(({ player, role }) => ({ ...player, role, multiplier: roleWeight[role] }));
  validateFreeHitSquad(picks);
  return picks;
}

for (const [season, endGw] of seasons) {
  const forecast = JSON.parse(await readFile(new URL(`../reports/historical-replay/forecast-1.4.3-${season}-GW4-${endGw}.json`, import.meta.url), "utf8"));
  const base = `https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/${season}`;
  const [dataResponse, teamsResponse] = await Promise.all([fetch(`${base}/gws/merged_gw.csv`), fetch(`${base}/teams.csv`)]);
  if (!dataResponse.ok || !teamsResponse.ok) throw new Error(`Missing ${season} historical source`);
  const [dataText, teamsText] = await Promise.all([dataResponse.text(), teamsResponse.text()]);
  if (sha256(dataText) !== forecast.source.mergedGwHash || sha256(teamsText) !== forecast.source.teamsHash) {
    throw new Error(`${season} historical source changed since the forecasts were frozen`);
  }
  const rows = parseCsv(dataText);
  const teams = parseCsv(teamsText);
  const teamIds = new Map(teams.flatMap((team) => [
    [normalized(column(team, "name")), Number(column(team, "id"))],
    [normalized(column(team, "short_name")), Number(column(team, "id"))],
  ]));
  const rowsByGw = new Map();
  for (const row of rows) {
    const gw = gwOf(row);
    rowsByGw.set(gw, [...(rowsByGw.get(gw) ?? []), row]);
  }
  const forecastByGw = new Map();
  for (const row of forecast.predictions) forecastByGw.set(row.gw, [...(forecastByGw.get(row.gw) ?? []), row]);
  const lastPrice = new Map();
  const results = [];
  for (let gw = 1; gw <= endGw; gw += 1) {
    const target = rowsByGw.get(gw) ?? [];
    const targetById = new Map(target.map((row) => [Number(column(row, "element")), row]));
    const predictions = forecastByGw.get(gw) ?? [];
    if (predictions.length) {
      const pool = predictions.flatMap((row) => {
        const targetRow = targetById.get(row.playerId);
        const price = lastPrice.get(row.playerId);
        const teamId = teamIds.get(normalized(column(targetRow ?? {}, "team")));
        return targetRow && price && teamId ? [{
          id: row.playerId, name: row.player, teamId, team: column(targetRow, "team"),
          position: row.position, price, projected: row.predicted, forecast: row,
        }] : [];
      });
      const actuals = actualsByPlayer(target);
      const actualPoints = [...actuals].map(([id, value]) => ({ id, points: value.points, minutes: value.minutes }));
      const week = { gw, pool: pool.length, scores: {} };
      let calibratedSquad;
      for (const [name, value] of Object.entries(variants)) {
        const squad = await selectFreeHitSquad(pool.map((row) => ({ ...row, projected: value(row.forecast) })));
        if (name === "calibrated") calibratedSquad = squad;
        week.scores[name] = scoreFreeHitSquad(squad.picks, actualPoints).points;
      }
      for (const tolerance of [0.1, 0.25]) {
        const name = `starterTie${tolerance}`;
        const picks = starterFirstNearTie(pool, calibratedSquad.weightedExpectedPoints, tolerance);
        week.scores[name] = scoreFreeHitSquad(picks, actualPoints).points;
      }
      results.push(week);
      console.log(`${season} GW${gw} ${JSON.stringify(week.scores)}`);
    }
    for (const row of target) {
      const id = Number(column(row, "element"));
      const price = Number(column(row, "value"));
      if (id && price) lastPrice.set(id, price);
    }
  }
  const summary = Object.fromEntries([...Object.keys(variants), "starterTie0.1", "starterTie0.25"].map((name) => [name, {
    total: results.reduce((sum, row) => sum + row.scores[name], 0),
    mean: results.reduce((sum, row) => sum + row.scores[name], 0) / results.length,
    betterThanCalibrated: results.filter((row) => row.scores[name] > row.scores.calibrated).length,
    worseThanCalibrated: results.filter((row) => row.scores[name] < row.scores.calibrated).length,
  }]));
  console.log(`SUMMARY ${season} ${JSON.stringify({ gameweeks: results.length, summary })}`);
}
