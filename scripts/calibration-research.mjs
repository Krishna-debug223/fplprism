import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseCsv, actualsByPlayer, gwOf } = require("../.backtest-build/scripts/backtest.js");
const reportDir = "reports/historical-replay";
const version = process.env.RESEARCH_MODEL_VERSION ?? "1.4.1";

async function observations(season, endGw) {
  const file = JSON.parse(readFileSync(`${reportDir}/forecast-${version}-${season}-GW4-${endGw}.json`, "utf8"));
  const response = await fetch(file.source.mergedGw);
  if (!response.ok) throw new Error(`Historical data ${response.status}`);
  const rows = parseCsv(await response.text());
  const actuals = new Map();
  for (const gw of new Set(file.predictions.map((prediction) => prediction.gw))) {
    actuals.set(gw, actualsByPlayer(rows.filter((row) => gwOf(row) === gw)));
  }
  return file.predictions.map((prediction) => {
    const outcome = actuals.get(prediction.gw)?.get(prediction.playerId);
    if (!outcome) throw new Error(`Missing ${season} GW${prediction.gw} player ${prediction.playerId}`);
    return {
      ...prediction, season, actual: outcome.points,
      appeared: outcome.minutes > 0, fixtures: outcome.fixtures,
    };
  });
}

function solve(matrix, values) {
  const n = values.length;
  const rows = matrix.map((row, i) => [...row, values[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    if (Math.abs(rows[col][col]) < 1e-10) return null;
    const divisor = rows[col][col];
    for (let j = col; j <= n; j += 1) rows[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = rows[row][col];
      for (let j = col; j <= n; j += 1) rows[row][j] -= factor * rows[col][j];
    }
  }
  return rows.map((row) => row[n]);
}

function fit(rows, features) {
  const x = rows.map(features);
  const n = x[0].length;
  const xx = Array.from({ length: n }, () => Array(n).fill(0));
  const xy = Array(n).fill(0);
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = 0; j < n; j += 1) {
      xy[j] += x[i][j] * rows[i].actual;
      for (let k = 0; k < n; k += 1) xx[j][k] += x[i][j] * x[i][k];
    }
  }
  for (let j = 0; j < n; j += 1) xx[j][j] += 0.001;
  return solve(xx, xy);
}

function evaluate(rows, predictor) {
  const scored = rows.map((row) => ({ ...row, estimate: Math.max(0, predictor(row)) }));
  const metric = (cohort) => {
    const errors = cohort.map((row) => row.estimate - row.actual);
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      n: cohort.length,
      mae: +mean(errors.map(Math.abs)).toFixed(4),
      rmse: +Math.sqrt(mean(errors.map((error) => error ** 2))).toFixed(4),
      within2: +mean(errors.map((error) => Math.abs(error) <= 2 ? 1 : 0)).toFixed(4),
      bias: +mean(errors).toFixed(4),
    };
  };
  const gameweeks = [...new Set(scored.map((row) => `${row.season}:${row.gw}`))];
  const topTen = gameweeks.flatMap((key) => scored.filter((row) => `${row.season}:${row.gw}` === key).sort((a, b) => b.estimate - a.estimate).slice(0, 10));
  return {
    all: metric(scored), active: metric(scored.filter((row) => row.appeared)),
    topTen: { n: topTen.length, actualAverage: +(topTen.reduce((sum, row) => sum + row.actual, 0) / topTen.length).toFixed(4) },
  };
}

const [previous, current] = await Promise.all([observations("2025-26", 38), observations("2026-27", 7)]);
const useOldTraining = process.env.RESEARCH_TRAIN === "older-seasons";
const older = useOldTraining ? (await Promise.all([observations("2023-24", 38), observations("2024-25", 38)])).flat() : [];
const train = useOldTraining ? older : previous.filter((row) => row.gw <= 22);
const validation = useOldTraining ? previous : previous.filter((row) => row.gw > 22);
const positions = ["GKP", "DEF", "MID", "FWD"];
const fitPositions = (rows, features) => Object.fromEntries(positions.map((position) => [position, fit(rows.filter((row) => row.position === position && row.fixtures === 1), features)]));
const candidates = {
  current: { predict: (row) => row.predicted },
  conditionalIfAppeared: { predict: (row) => row.appearanceProbability > 0.05 ? row.predicted / row.appearanceProbability : row.predicted },
  raw: { predict: (row) => row.rawPredicted },
  flatTwo: { predict: () => 2 },
  appearanceTwo: { predict: (row) => 2 * row.appearanceProbability * row.fixtures },
};
for (const [name, features] of [
  ["positionLinear", (row) => [1, row.rawPredicted]],
  ["positionSlope", (row) => [row.rawPredicted]],
  ["positionRawAppearance", (row) => [1, row.rawPredicted, row.appearanceProbability]],
]) {
  const coefficients = fitPositions(train, features);
  candidates[name] = {
    coefficients,
    predict: (row) => {
      const fitted = coefficients[row.position];
      const input = features(row);
      if (input.length > 1) input[0] *= row.fixtures;
      return fitted.reduce((sum, value, index) => sum + value * input[index], 0);
    },
  };
}
for (const weight of [0.25, 0.5, 0.75]) {
  candidates[`linearBlend${weight}`] = {
    predict: (row) => (1 - weight) * row.predicted + weight * Math.max(0, candidates.positionLinear.predict(row)),
  };
}
const bandBucket = (row) => `${row.position}:${Math.min(6, Math.floor(row.predicted))}`;
const activeBandBuckets = new Map();
for (const row of train.filter((item) => item.appeared)) {
  const key = bandBucket(row);
  activeBandBuckets.set(key, [...(activeBandBuckets.get(key) ?? []), row]);
}
const bandMode = Object.fromEntries([...activeBandBuckets].map(([key, rows]) => {
  const best = rows.length < 100 ? 2 : Array.from({ length: 12 }, (_, estimate) => ({
    estimate,
    within2: rows.filter((row) => Math.abs(estimate - row.actual) <= 2).length,
  })).sort((a, b) => b.within2 - a.within2 || Math.abs(a.estimate - 2) - Math.abs(b.estimate - 2))[0].estimate;
  return [key, { estimate: best, samples: rows.length }];
}));
candidates.typicalScore = { coefficients: bandMode, predict: (row) => bandMode[bandBucket(row)]?.estimate ?? 2 };
const report = {
  modelVersion: version, generatedAt: new Date().toISOString(),
  design: useOldTraining
    ? "Fit on 2023-24 and 2024-25, test on 2025-26 and 2026-27 GW4-6. Older seasons use different FPL scoring rules."
    : "Fit on 2025-26 GW4-22; compare on GW23-38; then inspect 2026-27 GW4-6 without fitting to it.",
  candidates: Object.fromEntries(Object.entries(candidates).map(([name, candidate]) => [name, {
    coefficients: candidate.coefficients ?? null,
    training: evaluate(train, candidate.predict),
    validation: evaluate(validation, candidate.predict),
    nextSeason: evaluate(current, candidate.predict),
  }])),
  appearanceReliability: Object.fromEntries([['training', train], ['validation', validation], ['nextSeason', current]].map(([name, rows]) => [name,
    Object.fromEntries(positions.map((position) => [position, Array.from({ length: 5 }, (_, index) => {
      const bucket = rows.filter((row) => row.position === position && Math.min(4, Math.floor(row.appearanceProbability * 5)) === index);
      if (!bucket.length) return { n: 0 };
      return {
        n: bucket.length,
        predicted: +(bucket.reduce((sum, row) => sum + row.appearanceProbability, 0) / bucket.length).toFixed(4),
        appeared: +(bucket.filter((row) => row.appeared).length / bucket.length).toFixed(4),
      };
    })])),
  ])),
};
writeFileSync(`${reportDir}/calibration-research-${version}${useOldTraining ? '-older-training' : ''}.json`, JSON.stringify(report, null, 2));
for (const [name, candidate] of Object.entries(report.candidates)) {
  console.log(name, "late-2025", candidate.validation.active, "GW4-6-2026", candidate.nextSeason.active, "top10", candidate.nextSeason.topTen.actualAverage);
}
