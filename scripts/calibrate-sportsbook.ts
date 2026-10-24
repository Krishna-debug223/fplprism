import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  decimalOddsToProbability,
  impliedGoalMeanFromTotal,
  removeVig,
  splitExpectedGoals,
} from "../lib/sportsbook";

type CsvRow = Record<string, string>;
type Match = {
  gw: number;
  fixture: number;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  homeXg: number;
  awayXg: number;
};
type Odds = {
  home: string;
  away: string;
  homePrice: number;
  drawPrice: number;
  awayPrice: number;
  over25: number;
  under25: number;
};
type Evaluation = {
  weight: number;
  nMatches: number;
  goalRmse: number;
  poissonNll: number;
  cleanSheetBrier: number;
};
type ForecastRecord = {
  gw: number;
  fixture: number;
  actualHome: number; actualAway: number;
  baseHome: number; baseAway: number;
  marketHome: number; marketAway: number;
};
type ReplayPrediction = { gw: number; playerId: number; position: string; predicted: number };

const TRAINING_SEASONS = ["2023-24", "2024-25"];
const TEST_SEASON = "2025-26";
const VAASTAV_BASE = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data";
const FOOTBALL_DATA_BASE = "https://www.football-data.co.uk/mmz4281";

function parseCsv(text: string): CsvRow[] {
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
  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

async function fetchCsv(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "FPL-Prism-Sportsbook-Calibration/1.0", Accept: "text/csv,*/*" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Calibration source returned ${response.status}: ${url}`);
    return parseCsv(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

const num = (value: string | undefined, fallback = 0) => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
};
const integer = (value: string | undefined, fallback = 0) => Math.trunc(num(value, fallback));
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const col = (row: CsvRow, ...names: string[]) => {
  for (const name of names) if (row[name] != null && row[name] !== "") return row[name];
  return "";
};
const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function alias(value: string) {
  const key = normal(value);
  const aliases: Record<string, string> = {
    manchesterunited: "manutd",
    manunited: "manutd",
    manchesterutd: "manutd",
    manchestercity: "mancity",
    nottmforest: "nottmforest",
    tottenhamhotspur: "spurs",
    tottenham: "spurs",
    wolverhamptonwanderers: "wolves",
    wolverhampton: "wolves",
    brightonandhovealbion: "brighton",
    newcastleunited: "newcastle",
    westhamunited: "westham",
    leedsunited: "leeds",
    sheffieldunited: "sheffieldutd",
    sheffutd: "sheffieldutd",
    nottinghamforest: "nottmforest",
  };
  return aliases[key] ?? key;
}

function fplMatches(rows: CsvRow[]): Match[] {
  const grouped = new Map<number, CsvRow[]>();
  rows.forEach((row) => {
    const fixture = integer(col(row, "fixture"));
    if (!fixture) return;
    const bucket = grouped.get(fixture) ?? [];
    bucket.push(row);
    grouped.set(fixture, bucket);
  });

  const output: Match[] = [];
  grouped.forEach((fixtureRows, fixture) => {
    const homeRows = fixtureRows.filter((row) => ["true", "1"].includes(col(row, "was_home").toLowerCase()));
    const awayRows = fixtureRows.filter((row) => !["true", "1"].includes(col(row, "was_home").toLowerCase()));
    if (!homeRows.length || !awayRows.length) return;
    const home = col(homeRows[0], "team", "team_name");
    const away = col(awayRows[0], "team", "team_name");
    if (!home || !away) return;
    output.push({
      gw: integer(col(fixtureRows[0], "GW", "round")),
      fixture,
      home,
      away,
      homeGoals: integer(col(fixtureRows[0], "team_h_score")),
      awayGoals: integer(col(fixtureRows[0], "team_a_score")),
      homeXg: homeRows.reduce((sum, row) => sum + num(col(row, "expected_goals")), 0),
      awayXg: awayRows.reduce((sum, row) => sum + num(col(row, "expected_goals")), 0),
    });
  });
  return output.filter((match) => match.gw > 0).sort((a, b) => a.gw - b.gw || a.fixture - b.fixture);
}

function oddsRows(rows: CsvRow[]): Odds[] {
  return rows
    .map((row) => ({
      home: col(row, "HomeTeam"),
      away: col(row, "AwayTeam"),
      // Football-Data's columns without C are the earlier prices. Never
      // substitute closing prices: they can contain post-FPL-deadline news.
      homePrice: num(col(row, "AvgH", "B365H")),
      drawPrice: num(col(row, "AvgD", "B365D")),
      awayPrice: num(col(row, "AvgA", "B365A")),
      over25: num(col(row, "Avg>2.5", "B365>2.5")),
      under25: num(col(row, "Avg<2.5", "B365<2.5")),
    }))
    .filter((row) => row.home && row.away && row.homePrice > 1 && row.drawPrice > 1 && row.awayPrice > 1 && row.over25 > 1 && row.under25 > 1);
}

function sportsbookExpectedGoals(odds: Odds) {
  const [homeWin, , awayWin] = removeVig([
    decimalOddsToProbability(odds.homePrice),
    decimalOddsToProbability(odds.drawPrice),
    decimalOddsToProbability(odds.awayPrice),
  ]);
  const [over] = removeVig([
    decimalOddsToProbability(odds.over25),
    decimalOddsToProbability(odds.under25),
  ]);
  if (!(homeWin > 0 && awayWin > 0 && over > 0)) return null;
  const total = impliedGoalMeanFromTotal(over, 2.5);
  return splitExpectedGoals(total, homeWin, awayWin);
}

function shrunkMean(values: number[], prior: number, pseudoMatches = 6) {
  return (values.reduce((sum, value) => sum + value, 0) + prior * pseudoMatches) / (values.length + pseudoMatches);
}

function baseExpectedGoals(target: Match, prior: Match[]) {
  const leagueHome = mean(prior.map((match) => match.homeXg)) || 1.55;
  const leagueAway = mean(prior.map((match) => match.awayXg)) || 1.25;
  const league = (leagueHome + leagueAway) / 2;
  const homeAttack = prior.filter((match) => alias(match.home) === alias(target.home)).map((match) => match.homeXg)
    .concat(prior.filter((match) => alias(match.away) === alias(target.home)).map((match) => match.awayXg));
  const homeConcede = prior.filter((match) => alias(match.home) === alias(target.home)).map((match) => match.awayXg)
    .concat(prior.filter((match) => alias(match.away) === alias(target.home)).map((match) => match.homeXg));
  const awayAttack = prior.filter((match) => alias(match.home) === alias(target.away)).map((match) => match.homeXg)
    .concat(prior.filter((match) => alias(match.away) === alias(target.away)).map((match) => match.awayXg));
  const awayConcede = prior.filter((match) => alias(match.home) === alias(target.away)).map((match) => match.awayXg)
    .concat(prior.filter((match) => alias(match.away) === alias(target.away)).map((match) => match.homeXg));
  const hAtt = shrunkMean(homeAttack, league);
  const hDef = shrunkMean(homeConcede, league);
  const aAtt = shrunkMean(awayAttack, league);
  const aDef = shrunkMean(awayConcede, league);
  return {
    home: clamp(leagueHome * Math.sqrt((hAtt / league) * (aDef / league)), 0.35, 3.6),
    away: clamp(leagueAway * Math.sqrt((aAtt / league) * (hDef / league)), 0.25, 3.2),
  };
}

function logFactorial(k: number) {
  let total = 0;
  for (let i = 2; i <= k; i += 1) total += Math.log(i);
  return total;
}

function poissonNll(lambda: number, observed: number) {
  const safe = Math.max(lambda, 0.05);
  return safe - observed * Math.log(safe) + logFactorial(observed);
}

function evaluate(records: ForecastRecord[], weight: number): Evaluation {
  const squaredErrors: number[] = [];
  const nll: number[] = [];
  const csBrier: number[] = [];
  records.forEach((record) => {
    const home = record.baseHome * (1 - weight) + record.marketHome * weight;
    const away = record.baseAway * (1 - weight) + record.marketAway * weight;
    squaredErrors.push((home - record.actualHome) ** 2, (away - record.actualAway) ** 2);
    nll.push(poissonNll(home, record.actualHome), poissonNll(away, record.actualAway));
    const homeCs = Math.exp(-away);
    const awayCs = Math.exp(-home);
    csBrier.push((homeCs - (record.actualAway === 0 ? 1 : 0)) ** 2, (awayCs - (record.actualHome === 0 ? 1 : 0)) ** 2);
  });
  return {
    weight,
    nMatches: records.length,
    goalRmse: Math.sqrt(mean(squaredErrors)),
    poissonNll: mean(nll),
    cleanSheetBrier: mean(csBrier),
  };
}

function bootstrapHoldout(records: ForecastRecord[], selectedWeight: number) {
  const byGameweek = new Map<number, ForecastRecord[]>();
  records.forEach((record) => byGameweek.set(record.gw, [...(byGameweek.get(record.gw) ?? []), record]));
  const groups = [...byGameweek.values()];
  let seed = 20261024;
  const draw = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const nllDeltas: number[] = [];
  const brierDeltas: number[] = [];
  for (let sample = 0; sample < 2000; sample += 1) {
    const subset = Array.from({ length: groups.length }, () => groups[Math.floor(draw() * groups.length)]).flat();
    const baseline = evaluate(subset, 0);
    const market = evaluate(subset, selectedWeight);
    nllDeltas.push(baseline.poissonNll - market.poissonNll);
    brierDeltas.push(baseline.cleanSheetBrier - market.cleanSheetBrier);
  }
  const interval = (values: number[]) => {
    values.sort((a, b) => a - b);
    return [values[49], values[1949]].map((value) => Number(value.toFixed(6)));
  };
  return {
    clusteredBy: "FPL Gameweek",
    gameweeks: groups.length,
    samples: 2000,
    poissonNllImprovement95PercentInterval: interval(nllDeltas),
    cleanSheetBrierImprovement95PercentInterval: interval(brierDeltas),
  };
}

function playerSensitivity(records: ForecastRecord[], fplRows: CsvRow[], weight: number) {
  const path = resolve(`reports/historical-replay/forecast-1.4.3-${TEST_SEASON}-GW4-38.json`);
  const replay = JSON.parse(readFileSync(path, "utf8")) as { predictions: ReplayPrediction[] };
  const fixtureMap = new Map(records.map((record) => [record.fixture, record]));
  const playerRows = new Map<string, CsvRow[]>();
  fplRows.forEach((row) => {
    const key = `${integer(row.GW)}:${integer(row.element)}`;
    playerRows.set(key, [...(playerRows.get(key) ?? []), row]);
  });
  const cohorts = { all: [] as Array<{ base: number; market: number; actual: number }>, active: [] as Array<{ base: number; market: number; actual: number }> };
  const byPosition = new Map<string, Array<{ base: number; market: number; actual: number }>>();
  let withoutMatchOdds = 0;
  replay.predictions.forEach((prediction) => {
    const rows = playerRows.get(`${prediction.gw}:${prediction.playerId}`);
    if (!rows?.length || !Number.isFinite(prediction.predicted)) return;
    const factors = rows.map((row) => {
      const record = fixtureMap.get(integer(row.fixture));
      if (!record) return null;
      const home = ["true", "1"].includes(row.was_home.toLowerCase());
      const modelGoals = home ? record.baseHome : record.baseAway;
      const marketGoals = home ? record.marketHome : record.marketAway;
      const modelAgainst = home ? record.baseAway : record.baseHome;
      const marketAgainst = home ? record.marketAway : record.marketHome;
      const attackRatio = clamp(marketGoals / Math.max(modelGoals, 0.35), 0.72, 1.28);
      const cleanRatio = clamp(Math.exp(-marketAgainst) / Math.max(Math.exp(-modelAgainst), 0.04), 0.7, 1.3);
      const attackFactor = 1 + (attackRatio - 1) * weight;
      const cleanFactor = 1 + (cleanRatio - 1) * weight;
      const positionFactor = prediction.position === "GKP" ? cleanFactor
        : prediction.position === "DEF" ? attackFactor * 0.35 + cleanFactor * 0.65
          : prediction.position === "MID" ? attackFactor * 0.94 + cleanFactor * 0.06 : attackFactor;
      return clamp(positionFactor, 0.94, 1.06);
    }).filter((value): value is number => value != null);
    if (!factors.length) { withoutMatchOdds += 1; return; }
    const actual = rows.reduce((sum, row) => sum + integer(row.total_points), 0);
    const minutes = rows.reduce((sum, row) => sum + integer(row.minutes), 0);
    const item = { base: prediction.predicted, market: prediction.predicted * mean(factors), actual };
    cohorts.all.push(item);
    if (minutes > 0) {
      cohorts.active.push(item);
      byPosition.set(prediction.position, [...(byPosition.get(prediction.position) ?? []), item]);
    }
  });
  const evaluateCohort = (rows: typeof cohorts.all) => {
    const evaluateSide = (field: "base" | "market") => ({
      mae: mean(rows.map((row) => Math.abs(row[field] - row.actual))),
      rmse: Math.sqrt(mean(rows.map((row) => (row[field] - row.actual) ** 2))),
      within2: mean(rows.map((row) => Number(Math.abs(row[field] - row.actual) <= 2))),
    });
    return { players: rows.length, baseline: evaluateSide("base"), withMarket: evaluateSide("market") };
  };
  return {
    caveat: "Sensitivity check on reconstructed historical FPL Prism forecasts. Applies the bounded market factor after player calibration and uses fixture team xG from a simplified baseline; this is not an exact rerun of the full player model or a timestamp-certified predeadline forecast.",
    withoutMatchOdds,
    all: evaluateCohort(cohorts.all),
    active: evaluateCohort(cohorts.active),
    activeByPosition: Object.fromEntries([...byPosition.entries()].map(([position, rows]) => [position, evaluateCohort(rows)])),
  };
}

async function seasonRecords(season: string) {
  const shortSeason = season.slice(2, 4) + season.slice(5, 7);
  const [fplRows, historicalOddsRows] = await Promise.all([
    fetchCsv(`${VAASTAV_BASE}/${season}/gws/merged_gw.csv`),
    fetchCsv(`${FOOTBALL_DATA_BASE}/${shortSeason}/E0.csv`),
  ]);
  const matches = fplMatches(fplRows);
  const odds = oddsRows(historicalOddsRows);
  const oddsMap = new Map(odds.map((row) => [`${alias(row.home)}::${alias(row.away)}`, row]));
  const records: ForecastRecord[] = [];

  matches.forEach((match) => {
    if (match.gw < 4) return;
    const price = oddsMap.get(`${alias(match.home)}::${alias(match.away)}`);
    if (!price) return;
    const market = sportsbookExpectedGoals(price);
    if (!market) return;
    const prior = matches.filter((candidate) => candidate.gw < match.gw);
    if (!prior.length) return;
    const base = baseExpectedGoals(match, prior);
    records.push({
      gw: match.gw,
      fixture: match.fixture,
      actualHome: match.homeGoals,
      actualAway: match.awayGoals,
      baseHome: base.home,
      baseAway: base.away,
      marketHome: market.home,
      marketAway: market.away,
    });
  });

  if (records.length < 100) throw new Error(`Only matched ${records.length} fixtures in ${season}; calibration would be unreliable.`);
  return { records, fplRows };
}

async function main() {
  const seasonData = await Promise.all([...TRAINING_SEASONS, TEST_SEASON].map(async (season) => ({
    season, data: await seasonRecords(season),
  })));
  const training = seasonData.slice(0, -1).flatMap((item) => item.data.records);
  const holdout = seasonData.at(-1)!.data.records;
  const weights = Array.from({ length: 11 }, (_, index) => index * 0.025);
  const results = weights.map((weight) => evaluate(training, weight));
  const selected = [...results].sort((a, b) => a.poissonNll - b.poissonNll || a.cleanSheetBrier - b.cleanSheetBrier)[0];
  const holdoutBaseline = evaluate(holdout, 0);
  const holdoutSelected = evaluate(holdout, selected.weight);
  const holdoutUncertainty = bootstrapHoldout(holdout, selected.weight);
  const nllImprovement = holdoutBaseline.poissonNll > 0
    ? (holdoutBaseline.poissonNll - holdoutSelected.poissonNll) / holdoutBaseline.poissonNll : 0;
  const brierImprovement = holdoutBaseline.cleanSheetBrier > 0
    ? (holdoutBaseline.cleanSheetBrier - holdoutSelected.cleanSheetBrier) / holdoutBaseline.cleanSheetBrier : 0;
  const candidateWeight = nllImprovement >= 0.001 && brierImprovement > 0 ? selected.weight : 0;

  const report = {
    trainingSeasons: TRAINING_SEASONS,
    testSeason: TEST_SEASON,
    generatedAt: new Date().toISOString(),
    matchedFixtures: Object.fromEntries(seasonData.map((item) => [item.season, item.data.records.length])),
    sources: {
      fpl: "vaastav/Fantasy-Premier-League merged_gw.csv",
      sportsbook: "football-data.co.uk season CSV, opening 1X2 and O/U 2.5 average prices (never closing prices)",
    },
    methodology: "Walk-forward within-season team xG baseline; opening 1X2 and O/U 2.5 odds are de-vigged and converted to market expected goals. Choose blend weight on 2023-24 and 2024-25; evaluate the odds-weight choice on 2025-26, which was not used to select that weight. No target-match result or xG enters its forecast. Football-Data does not give per-quote timestamps, so opening odds cannot be guaranteed to predate every FPL deadline. The player sensitivity check uses reconstructed model forecasts and is not an independent prospective trial.",
    trainingResults: results.map((result) => ({
      ...result,
      goalRmse: Number(result.goalRmse.toFixed(6)),
      poissonNll: Number(result.poissonNll.toFixed(6)),
      cleanSheetBrier: Number(result.cleanSheetBrier.toFixed(6)),
    })),
    selectedTrainingWeight: selected.weight,
    holdoutBaseline,
    holdoutSelected,
    holdoutUncertainty,
    playerSensitivity: playerSensitivity(holdout, seasonData.at(-1)!.data.fplRows, selected.weight),
    candidateWeight,
    productionRecommendedWeight: 0,
    holdoutRelativePoissonNllImprovementPercent: Number((nllImprovement * 100).toFixed(4)),
    holdoutRelativeCleanSheetBrierImprovementPercent: Number((brierImprovement * 100).toFixed(4)),
    note: candidateWeight === 0
      ? "The out-of-season holdout did not improve both goal likelihood and clean-sheet accuracy; leave live market influence disabled."
      : `A ${candidateWeight.toFixed(3)} market prior improved team-goal metrics, but the reconstructed player sensitivity check worsened overall point MAE and within-two accuracy. Live influence stays at zero pending timestamped predeadline odds and prospective player testing.`,
  };

  const path = resolve(`reports/sportsbook-calibration-opening-${TEST_SEASON}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${path}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
