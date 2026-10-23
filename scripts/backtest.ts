import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { MODEL_VERSION, projectPlayer } from "../lib/risk-v12";
import { projectPlayer as projectPlayerBase } from "../lib/risk";
import type { SportsbookPayload } from "../lib/sportsbook";
import type { FplFixture, FplPlayer, FplTeam } from "../lib/types";

export type CsvRow = Record<string, string>;
export type Observation = {
  gw: number;
  playerId: number;
  player: string;
  position: string;
  predicted: number;
  rawPredicted?: number;
  actual: number;
  appearanceProbability: number;
  appeared: number;
  p10: number;
  p90: number;
};

export type MetricSet = {
  n: number;
  mae: number | null;
  rmse: number | null;
  bias: number | null;
  within2: number | null;
  pearson: number | null;
  spearman: number | null;
  appearanceBrier: number | null;
  interval80Coverage: number | null;
  topDecileActualAverage: number | null;
  topDecileHaulRate: number | null;
  overallHaulRate: number | null;
};

export type TeamCsv = { id: number; name: string; shortName: string };

export type HistoricalForecast = {
  gw: number;
  playerId: number;
  player: string;
  position: string;
  predicted: number;
  rawPredicted: number;
  appearanceProbability: number;
  p10: number;
  p90: number;
};

const TARGET_SEASON = process.env.BACKTEST_SEASON ?? "2025-26";
const START_GW = Math.max(2, Number.parseInt(process.env.BACKTEST_START_GW ?? "4", 10) || 4);
const END_GW = Math.min(38, Number.parseInt(process.env.BACKTEST_END_GW ?? "38", 10) || 38);
const BASE = `https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/${TARGET_SEASON}`;

export function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field); field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export async function fetchCsv(url: string) {
  const response = await fetch(url, { headers: { "User-Agent": "FPL-Prism-Backtest/1.0" } });
  if (!response.ok) throw new Error(`Backtest source returned ${response.status}: ${url}`);
  return parseCsv(await response.text());
}

const num = (value: string | undefined, fallback = 0) => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
};
export const integer = (value: string | undefined, fallback = 0) => Math.trunc(num(value, fallback));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function column(row: CsvRow, ...names: string[]) {
  for (const name of names) if (row[name] != null && row[name] !== "") return row[name];
  return "";
}

export function gwOf(row: CsvRow) {
  return integer(column(row, "GW", "round"));
}

export function playerId(row: CsvRow) {
  return integer(column(row, "element", "id"));
}

function positionType(row: CsvRow) {
  const raw = column(row, "position").toUpperCase();
  if (raw.includes("GK")) return 1;
  if (raw.includes("DEF")) return 2;
  if (raw.includes("MID")) return 3;
  if (raw.includes("FWD") || raw.includes("FOR")) return 4;
  return 3;
}

function boolean(value: string | undefined) {
  return ["true", "1", "yes"].includes((value ?? "").toLowerCase());
}

function teamName(row: CsvRow) {
  return column(row, "team", "team_name").trim();
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function teamLookup(teams: TeamCsv[]) {
  const lookup = new Map<string, TeamCsv>();
  teams.forEach((team) => {
    lookup.set(normalizeName(team.name), team);
    lookup.set(normalizeName(team.shortName), team);
  });
  return lookup;
}

function rowsByFixture(rows: CsvRow[]) {
  const grouped = new Map<number, CsvRow[]>();
  rows.forEach((row) => {
    const id = integer(column(row, "fixture"));
    if (!id) return;
    const bucket = grouped.get(id) ?? [];
    bucket.push(row);
    grouped.set(id, bucket);
  });
  return grouped;
}

function buildFixtures(rows: CsvRow[], teams: TeamCsv[], targetGw: number): FplFixture[] {
  const lookup = teamLookup(teams);
  const fixtures: FplFixture[] = [];
  rowsByFixture(rows.filter((row) => gwOf(row) <= targetGw)).forEach((fixtureRows, id) => {
    const sample = fixtureRows[0];
    const homeRow = fixtureRows.find((row) => boolean(column(row, "was_home"))) ?? sample;
    const awayRow = fixtureRows.find((row) => !boolean(column(row, "was_home"))) ?? sample;
    const home = lookup.get(normalizeName(teamName(homeRow)));
    const away = lookup.get(normalizeName(teamName(awayRow)));
    if (!home || !away || home.id === away.id) return;
    const event = gwOf(sample);
    const finished = event < targetGw;
    fixtures.push({
      id,
      event,
      team_h: home.id,
      team_a: away.id,
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      team_h_score: finished ? integer(column(sample, "team_h_score")) : undefined,
      team_a_score: finished ? integer(column(sample, "team_a_score")) : undefined,
      kickoff_time: column(sample, "kickoff_time") || null,
      finished,
      started: finished,
    });
  });
  return fixtures;
}

function buildTeams(priorRows: CsvRow[], teamRows: TeamCsv[]): FplTeam[] {
  const lookup = teamLookup(teamRows);
  const fixtureGroups = rowsByFixture(priorRows);
  const attack = new Map<number, number[]>();
  const concede = new Map<number, number[]>();

  fixtureGroups.forEach((rows) => {
    const teamsInFixture = [...new Set(rows.map(teamName).filter(Boolean))];
    if (teamsInFixture.length !== 2) return;
    teamsInFixture.forEach((name) => {
      const team = lookup.get(normalizeName(name));
      const opponentName = teamsInFixture.find((candidate) => candidate !== name);
      const opponent = opponentName ? lookup.get(normalizeName(opponentName)) : null;
      if (!team || !opponent) return;
      const ownRows = rows.filter((row) => normalizeName(teamName(row)) === normalizeName(name));
      const opponentRows = rows.filter((row) => normalizeName(teamName(row)) === normalizeName(opponentName ?? ""));
      const ownXg = ownRows.reduce((sum, row) => sum + num(column(row, "expected_goals")), 0);
      const opponentXg = opponentRows.reduce((sum, row) => sum + num(column(row, "expected_goals")), 0);
      attack.set(team.id, [...(attack.get(team.id) ?? []), ownXg]);
      concede.set(team.id, [...(concede.get(team.id) ?? []), opponentXg]);
    });
  });

  const leagueAttack = mean([...attack.values()].flat()) || 1.42;
  return teamRows.map((team) => {
    const attackValues = attack.get(team.id) ?? [];
    const concedeValues = concede.get(team.id) ?? [];
    const xg = attackValues.length ? mean(attackValues) : leagueAttack;
    const xga = concedeValues.length ? mean(concedeValues) : leagueAttack;
    const attackStrength = clamp(Math.round(1000 * Math.pow(xg / leagueAttack, 0.45)), 800, 1250);
    const defenceStrength = clamp(Math.round(1000 * Math.pow(leagueAttack / Math.max(xga, 0.35), 0.45)), 800, 1250);
    return {
      id: team.id,
      name: team.name,
      short_name: team.shortName,
      strength: 3,
      strength_attack_home: Math.round(attackStrength * 1.03),
      strength_attack_away: Math.round(attackStrength * 0.98),
      strength_defence_home: Math.round(defenceStrength * 1.03),
      strength_defence_away: Math.round(defenceStrength * 0.98),
      underlying_matches: attackValues.length,
      underlying_attack_xg_per_match: xg,
      underlying_attack_xa_per_match: Math.max(0.55, xg * 0.73),
      underlying_defence_xga_per_match: xga,
    };
  });
}

function aggregatePlayer(target: CsvRow, prior: CsvRow[], teamId: number): FplPlayer {
  const minutes = prior.reduce((sum, row) => sum + integer(column(row, "minutes")), 0);
  const starts = prior.reduce((sum, row) => sum + integer(column(row, "starts")), 0);
  const xg = prior.reduce((sum, row) => sum + num(column(row, "expected_goals")), 0);
  const xa = prior.reduce((sum, row) => sum + num(column(row, "expected_assists")), 0);
  const points = prior.reduce((sum, row) => sum + integer(column(row, "total_points")), 0);
  const bonus = prior.reduce((sum, row) => sum + integer(column(row, "bonus")), 0);
  const saves = prior.reduce((sum, row) => sum + integer(column(row, "saves")), 0);
  const yellows = prior.reduce((sum, row) => sum + integer(column(row, "yellow_cards")), 0);
  const defcon = prior.reduce((sum, row) => sum + num(column(row, "defensive_contribution", "defensive_contributions")), 0);
  const games = prior.filter((row) => integer(column(row, "minutes")) > 0).length;
  const per90 = (value: number) => minutes > 0 ? 90 * value / minutes : 0;
  const name = column(target, "name", "web_name") || `Player ${playerId(target)}`;
  const parts = name.split(" ");
  const position = positionType(target);
  // The target-GW archive row was scraped after the match. Use the latest
  // earlier price so an in-Gameweek price change cannot enter the forecast.
  const lastKnown = prior.reduce((latest, row) => gwOf(row) >= gwOf(latest) ? row : latest, prior[0]);
  const price = Math.max(35, integer(column(lastKnown, "value"), 50));
  const ppg = games ? points / games : 0;

  return {
    id: playerId(target),
    code: playerId(target),
    web_name: parts.at(-1) ?? name,
    first_name: parts[0] ?? name,
    second_name: parts.slice(1).join(" "),
    team: teamId,
    element_type: position,
    now_cost: price,
    total_points: points,
    minutes,
    starts,
    form: "0",
    points_per_game: ppg.toFixed(2),
    selected_by_percent: "0",
    ep_next: null,
    chance_of_playing_next_round: 100,
    status: "a",
    expected_goals: xg.toFixed(4),
    expected_assists: xa.toFixed(4),
    expected_goal_involvements: (xg + xa).toFixed(4),
    expected_goals_per_90: per90(xg).toFixed(4),
    expected_assists_per_90: per90(xa).toFixed(4),
    expected_goal_involvements_per_90: per90(xg + xa).toFixed(4),
    expected_goals_conceded_per_90: "1.4",
    clean_sheets: prior.reduce((sum, row) => sum + integer(column(row, "clean_sheets")), 0),
    saves,
    saves_per_90: per90(saves).toFixed(4),
    bonus,
    bps: prior.reduce((sum, row) => sum + integer(column(row, "bps")), 0),
    yellow_cards: yellows,
    red_cards: prior.reduce((sum, row) => sum + integer(column(row, "red_cards")), 0),
    defensive_contribution: defcon,
    defensive_contribution_per_90: per90(defcon).toFixed(4),
    transfers_in_event: 0,
    transfers_out_event: 0,
  };
}

const FORECAST_METADATA_COLUMNS = [
  "GW", "round", "element", "id", "name", "web_name", "position",
  "team", "team_name", "fixture", "was_home", "kickoff_time",
] as const;

/** Target-GW scores, minutes, xG, bonus and other match stats never enter this object. */
export function forecastMetadata(row: CsvRow): CsvRow {
  return Object.fromEntries(FORECAST_METADATA_COLUMNS.map((key) => [key, row[key] ?? ""]));
}

export function forecastGameweek(
  targetRows: CsvRow[],
  priorRows: CsvRow[],
  teams: TeamCsv[],
  gw: number,
  sportsbook: SportsbookPayload | null = null,
): HistoricalForecast[] {
  const safeTargets = targetRows.map(forecastMetadata);
  const modelTeams = buildTeams(priorRows, teams);
  const modelFixtures = buildFixtures([...priorRows, ...safeTargets], teams, gw);
  const lookup = teamLookup(teams);
  const priorByPlayer = new Map<number, CsvRow[]>();
  priorRows.forEach((row) => {
    const id = playerId(row);
    if (!id) return;
    const bucket = priorByPlayer.get(id) ?? [];
    bucket.push(row);
    priorByPlayer.set(id, bucket);
  });

  // One forecast per player and Gameweek, even when they have two fixtures.
  const playerTargets = new Map<number, CsvRow>();
  safeTargets.forEach((target) => {
    const id = playerId(target);
    if (id && !playerTargets.has(id)) playerTargets.set(id, target);
  });

  const forecasts: HistoricalForecast[] = [];
  playerTargets.forEach((target, id) => {
    const team = lookup.get(normalizeName(teamName(target)));
    const prior = priorByPlayer.get(id) ?? [];
    if (!team || !prior.length) return;
    const modelPlayer = aggregatePlayer(target, prior, team.id);
    const projection = projectPlayer(modelPlayer, modelFixtures, modelTeams, 1, undefined, sportsbook);
    const rawProjection = projectPlayerBase(modelPlayer, modelFixtures, modelTeams, 1);
    const interval = 1.2815515655446004 * projection.volatility;
    forecasts.push({
      gw,
      playerId: id,
      player: column(target, "name", "web_name"),
      position: ["", "GKP", "DEF", "MID", "FWD"][modelPlayer.element_type] ?? "UNK",
      predicted: projection.expected,
      rawPredicted: rawProjection.expected,
      appearanceProbability: projection.appearanceProbabilities[0] ?? 0,
      p10: Math.max(0, projection.expected - interval),
      p90: projection.expected + interval,
    });
  });
  return forecasts;
}

export function actualsByPlayer(targetRows: CsvRow[]) {
  const actuals = new Map<number, { points: number; minutes: number; fixtures: number }>();
  targetRows.forEach((row) => {
    const id = playerId(row);
    if (!id) return;
    const prior = actuals.get(id) ?? { points: 0, minutes: 0, fixtures: 0 };
    actuals.set(id, {
      points: prior.points + integer(column(row, "total_points")),
      minutes: prior.minutes + integer(column(row, "minutes")),
      fixtures: prior.fixtures + 1,
    });
  });
  return actuals;
}

function ranks(values: number[]) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const output = new Array<number>(values.length);
  for (let i = 0; i < indexed.length;) {
    let j = i + 1;
    while (j < indexed.length && indexed[j].value === indexed[i].value) j += 1;
    const rank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k += 1) output[indexed[k].index] = rank;
    i = j;
  }
  return output;
}

function pearson(a: number[], b: number[]) {
  if (a.length < 2 || a.length !== b.length) return null;
  const ma = mean(a); const mb = mean(b);
  let numerator = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) {
    const xa = a[i] - ma; const xb = b[i] - mb;
    numerator += xa * xb; da += xa * xa; db += xb * xb;
  }
  return da > 0 && db > 0 ? numerator / Math.sqrt(da * db) : null;
}

export function metrics(
  rows: Observation[],
  prediction: (row: Observation) => number = (row) => row.predicted,
  interval: (row: Observation) => [number, number] = (row) => [row.p10, row.p90],
  includeReliability = true,
): MetricSet {
  if (!rows.length) return { n: 0, mae: null, rmse: null, bias: null, within2: null, pearson: null, spearman: null, appearanceBrier: null, interval80Coverage: null, topDecileActualAverage: null, topDecileHaulRate: null, overallHaulRate: null };
  const predicted = rows.map(prediction);
  const errors = rows.map((row, index) => predicted[index] - row.actual);
  const actual = rows.map((row) => row.actual);
  const sortedByProjection = [...rows].sort((a, b) => prediction(b) - prediction(a));
  const top = sortedByProjection.slice(0, Math.max(1, Math.ceil(rows.length * 0.1)));
  const round = (value: number | null) => value == null ? null : Number(value.toFixed(4));
  return {
    n: rows.length,
    mae: round(mean(errors.map(Math.abs))),
    rmse: round(Math.sqrt(mean(errors.map((error) => error * error)))),
    bias: round(mean(errors)),
    within2: round(mean(errors.map((error) => Math.abs(error) <= 2 ? 1 : 0))),
    pearson: round(pearson(predicted, actual)),
    spearman: round(pearson(ranks(predicted), ranks(actual))),
    appearanceBrier: includeReliability ? round(mean(rows.map((row) => Math.pow(row.appearanceProbability - row.appeared, 2)))) : null,
    interval80Coverage: includeReliability ? round(mean(rows.map((row) => {
      const [p10, p90] = interval(row);
      return row.actual >= p10 && row.actual <= p90 ? 1 : 0;
    }))) : null,
    topDecileActualAverage: round(mean(top.map((row) => row.actual))),
    topDecileHaulRate: round(mean(top.map((row) => row.actual >= 10 ? 1 : 0))),
    overallHaulRate: round(mean(rows.map((row) => row.actual >= 10 ? 1 : 0)),
    ),
  };
}

function fitLinearCalibration(rows: Observation[]) {
  if (rows.length < 2) return { intercept: 0, slope: 1, samples: rows.length };
  const xMean = mean(rows.map((row) => row.predicted));
  const yMean = mean(rows.map((row) => row.actual));
  const numerator = rows.reduce((sum, row) => sum + (row.predicted - xMean) * (row.actual - yMean), 0);
  const denominator = rows.reduce((sum, row) => sum + (row.predicted - xMean) ** 2, 0);
  const slope = denominator > 0 ? numerator / denominator : 1;
  return { intercept: yMean - slope * xMean, slope, samples: rows.length };
}

function calibrationEvaluation(rows: Observation[], positions: string[], startGw: number, endGw: number) {
  const splitGw = startGw + Math.floor((endGw - startGw + 1) * 2 / 3);
  const training = rows.filter((row) => row.gw < splitGw && row.predicted > 0);
  const validation = rows.filter((row) => row.gw >= splitGw);
  const appearedValidation = validation.filter((row) => row.appeared === 1);
  const pooled = fitLinearCalibration(training);
  const byPosition = Object.fromEntries(positions.map((position) => {
    const cohort = training.filter((row) => row.position === position);
    return [position, fitLinearCalibration(cohort.length >= 100 ? cohort : training)];
  }));
  const correctedValue = (value: number, row: Observation) => {
    if (row.predicted <= 0) return 0;
    const calibration = byPosition[row.position] ?? pooled;
    return Math.max(0, calibration.intercept + calibration.slope * value);
  };
  const corrected = (row: Observation) => correctedValue(row.predicted, row);
  const correctedInterval = (row: Observation): [number, number] => [
    row.p10 <= 0 ? 0 : correctedValue(row.p10, row),
    row.p90 <= 0 ? 0 : correctedValue(row.p90, row),
  ];
  return {
    split: { trainingGameweeks: `${startGw}-${splitGw - 1}`, validationGameweeks: `${splitGw}-${endGw}`, trainingPlayers: training.length, validationPlayers: validation.length },
    baseline: { allPlayers: metrics(validation), playersWhoAppeared: metrics(validation.filter((row) => row.appeared === 1)) },
    flatTwo: { playersWhoAppeared: metrics(appearedValidation, () => 2) },
    conditionalOnAppearance: {
      note: "For players with minutes, unconditional expected points are divided by the model's appearance probability. This is conditional expected points, not the pre-deadline all-player xPts used for transfers.",
      playersWhoAppeared: metrics(appearedValidation, (row) => row.appearanceProbability > 0 ? row.predicted / row.appearanceProbability : row.predicted, undefined, false),
    },
    positionLinearCalibration: {
      coefficients: byPosition,
      allPlayers: metrics(validation, corrected, correctedInterval),
      playersWhoAppeared: metrics(validation.filter((row) => row.appeared === 1), corrected, correctedInterval),
    },
  };
}

function fullSeasonCalibration(rows: Observation[], positions: string[]) {
  const training = rows.filter((row) => row.predicted > 0);
  const pooled = fitLinearCalibration(training);
  const byPosition = Object.fromEntries(positions.map((position) => {
    const cohort = training.filter((row) => row.position === position);
    return [position, fitLinearCalibration(cohort.length >= 100 ? cohort : training)];
  }));
  return { pooled, byPosition };
}

function externalCalibrationEvaluation(rows: Observation[], coefficientsPath: string | undefined) {
  if (!coefficientsPath) return { status: "not-run" as const };
  const source = JSON.parse(readFileSync(resolve(coefficientsPath), "utf-8")) as {
    targetSeason?: string;
    fullSeasonPositionCalibration?: { pooled?: { intercept: number; slope: number }; byPosition?: Record<string, { intercept: number; slope: number }> };
  };
  const calibration = source.fullSeasonPositionCalibration;
  const pooled = calibration?.pooled;
  const byPosition = calibration?.byPosition;
  if (!pooled || !byPosition) throw new Error(`Missing fullSeasonPositionCalibration in ${coefficientsPath}`);
  const correctedValue = (value: number, row: Observation) => {
    if (row.predicted <= 0) return 0;
    const params = byPosition[row.position] ?? pooled;
    return Math.max(0, params.intercept + params.slope * value);
  };
  const corrected = (row: Observation) => correctedValue(row.predicted, row);
  const correctedInterval = (row: Observation): [number, number] => [
    row.p10 <= 0 ? 0 : correctedValue(row.p10, row),
    row.p90 <= 0 ? 0 : correctedValue(row.p90, row),
  ];
  return {
    status: "evaluated" as const,
    trainedOnSeason: source.targetSeason ?? "unknown",
    coefficients: byPosition,
    baseline: { allPlayers: metrics(rows), playersWhoAppeared: metrics(rows.filter((row) => row.appeared === 1)) },
    calibrated: { allPlayers: metrics(rows, corrected, correctedInterval), playersWhoAppeared: metrics(rows.filter((row) => row.appeared === 1), corrected, correctedInterval) },
  };
}

function loadOptionalSportsbook(): SportsbookPayload | null {
  const path = process.env.SPORTSBOOK_BACKTEST_JSON?.trim();
  if (!path) return null;
  return JSON.parse(readFileSync(resolve(path), "utf-8")) as SportsbookPayload;
}

async function main() {
  console.log(`FPL Prism walk-forward backtest · model ${MODEL_VERSION} · season ${TARGET_SEASON}`);
  console.log(`Target GWs ${START_GW}-${END_GW}; each prediction uses only rows from earlier Gameweeks.`);

  const [allRows, rawTeams] = await Promise.all([
    fetchCsv(`${BASE}/gws/merged_gw.csv`),
    fetchCsv(`${BASE}/teams.csv`),
  ]);
  const teams: TeamCsv[] = rawTeams.map((row) => ({
    id: integer(column(row, "id")),
    name: column(row, "name"),
    shortName: column(row, "short_name", "shortName", "name").slice(0, 3).toUpperCase(),
  })).filter((team) => team.id && team.name);
  const sportsbook = loadOptionalSportsbook();
  const observations: Observation[] = [];
  let doubleGameweekPlayerWeeks = 0;

  for (let gw = START_GW; gw <= END_GW; gw += 1) {
    const targetRows = allRows.filter((row) => gwOf(row) === gw);
    if (!targetRows.length) continue;
    const priorRows = allRows.filter((row) => gwOf(row) > 0 && gwOf(row) < gw);
    const forecasts = forecastGameweek(targetRows, priorRows, teams, gw, sportsbook);
    const actuals = actualsByPlayer(targetRows);
    forecasts.forEach((forecast) => {
      const outcome = actuals.get(forecast.playerId);
      if (!outcome) throw new Error(`Missing actual for GW${gw} player ${forecast.playerId}`);
      if (outcome.fixtures > 1) doubleGameweekPlayerWeeks += 1;
      observations.push({
        ...forecast,
        actual: outcome.points,
        appeared: outcome.minutes > 0 ? 1 : 0,
      });
    });
    console.log(`GW${gw}: ${targetRows.length} source rows, ${forecasts.length} player-Gameweek predictions.`);
  }

  const positions = ["GKP", "DEF", "MID", "FWD"];
  const fullSeasonPositionCalibration = fullSeasonCalibration(observations, positions);
  const externalPath = process.env.BACKTEST_CALIBRATION_JSON?.trim();
  const report = {
    modelVersion: MODEL_VERSION,
    targetSeason: TARGET_SEASON,
    generatedAt: new Date().toISOString(),
    methodology: {
      walkForward: true,
      noLookahead: "Player/team rates and player price for target GW N are built only from rows where GW < N. Target-GW rows supply identity and fixture metadata during forecasting; points and minutes are used only during scoring.",
      source: "vaastav/Fantasy-Premier-League historical data",
      startingGw: START_GW,
      endingGw: END_GW,
      doubleGameweekPlayerWeeks,
      limitations: [
        "Historical injury/suspension snapshots are not reconstructed, so availability is neutral in this harness.",
        "Official historical FDR/static team-strength snapshots are not reconstructed; lagged team xG-derived strength is used instead.",
        "Historical multi-season priors are omitted from this first walk-forward harness.",
        sportsbook ? "Sportsbook backtest signals were loaded from SPORTSBOOK_BACKTEST_JSON." : "No historical sportsbook archive supplied; sportsbook before/after calibration is intentionally not claimed.",
      ],
    },
    overall: metrics(observations),
    playersWhoAppeared: metrics(observations.filter((row) => row.appeared === 1)),
    flatTwoBaselineForPlayersWhoAppeared: metrics(observations.filter((row) => row.appeared === 1), () => 2),
    temporalCalibrationExperiment: calibrationEvaluation(observations, positions, START_GW, END_GW),
    fullSeasonPositionCalibration,
    externalCalibrationExperiment: externalCalibrationEvaluation(observations, externalPath),
    byPosition: Object.fromEntries(positions.map((position) => [position, metrics(observations.filter((row) => row.position === position))])),
    byGameweek: Object.fromEntries([...new Set(observations.map((row) => row.gw))].map((gw) => [String(gw), metrics(observations.filter((row) => row.gw === gw))])),
    sportsbookComparison: sportsbook ? { status: "signals-loaded", note: "This run includes the supplied historical market payload. Run again without SPORTSBOOK_BACKTEST_JSON for a diffable baseline." } : { status: "not-run", note: "Historical sportsbook odds were not supplied, so no market-improvement claim is made." },
  };

  const output = resolve(`reports/backtest-${MODEL_VERSION}-${TARGET_SEASON}.json`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(`Wrote ${output}`);
  console.log(JSON.stringify({ overall: report.overall, byPosition: report.byPosition, sportsbookComparison: report.sportsbookComparison }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
