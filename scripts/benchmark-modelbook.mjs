import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "public", "modelbook", "data");
const outputFile = path.join(dataDir, "benchmark-report.json");

export function evaluateForecast(lock, actuals) {
  if (lock.lockMode === "retrospective-reconstruction") return null;
  const snapshot = lock.snapshot;
  const deadline = Date.parse(lock.deadlineTime ?? snapshot?.deadlineTime ?? "");
  const captured = Date.parse(lock.lockedAt ?? "");
  if (!snapshot?.rows?.length || !Number.isFinite(deadline) || !Number.isFinite(captured) || captured >= deadline) return null;
  if (!Array.isArray(snapshot.fixtures) || !Array.isArray(actuals?.elements)) return null;
  const allFixturesPlayed = actuals.finality?.ninetyMinutes === snapshot.fixtures.length;
  if (!allFixturesPlayed) return null;
  const expectedHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const managed = ["automatic-predeadline", "automatic-predeadline-fallback"].includes(lock.lockMode);
  if (managed && expectedHash !== lock.contentHash) return null;

  const clubsWithFixture = new Set(snapshot.fixtures.flatMap((fixture) => [fixture.team_h, fixture.team_a]));
  const pointsById = new Map(actuals.elements.map((element) => [Number(element.id), Number(element.stats?.total_points ?? 0)]));
  const field = snapshot.rows
    .filter((row) => clubsWithFixture.has(Number(row.teamId)) && Number.isFinite(Number(row.projected)))
    .map((row) => ({
      id: Number(row.id), name: String(row.name), position: String(row.position),
      forecast: Number(row.projected), ownership: Number(row.ownership),
      actual: pointsById.get(Number(row.id)),
    }));
  if (!field.length || field.some((row) => row.actual === undefined)) return null;
  const cohort = field.filter((row) => Number.isFinite(row.ownership) && row.ownership >= 1);
  if (!cohort.length) return null;
  const mae = cohort.reduce((sum, row) => sum + Math.abs(row.forecast - row.actual), 0) / cohort.length;
  const rmse = Math.sqrt(cohort.reduce((sum, row) => sum + (row.forecast - row.actual) ** 2, 0) / cohort.length);
  const predicted = [...field].sort((a, b) => b.forecast - a.forecast || a.id - b.id);
  const actual = [...field].sort((a, b) => b.actual - a.actual || a.id - b.id);
  const top15 = predicted.slice(0, 15);
  const actualTop15 = new Set(actual.slice(0, 15).map((row) => row.id));
  // A local ranking diagnostic only. FPL Bench does not disclose its exact NDCG gain/tie policy.
  const dcg = (rows) => rows.slice(0, 15).reduce((sum, row, index) =>
    sum + Math.max(0, row.actual) / Math.log2(index + 2), 0);
  const idealDcg = dcg(actual);
  const hoursBeforeDeadline = (deadline - captured) / 3_600_000;
  return {
    gameweek: Number(lock.gameweek), modelVersion: String(lock.modelVersion),
    capturedAt: lock.lockedAt, deadlineTime: lock.deadlineTime,
    hoursBeforeDeadline: Number(hoursBeforeDeadline.toFixed(1)),
    captureWindow: hoursBeforeDeadline <= 24 ? "within-24-hours" : "earlier-checkpoint",
    sourceHash: String(lock.contentHash),
    hashCheck: managed ? "embedded-snapshot-verified" : "legacy-source-hash-not-reproducible",
    officialPointsFetchedAt: actuals.fetchedAt,
    pointsStatus: actuals.finality?.finished === snapshot.fixtures.length ? "final" : "provisional",
    forecastPlayers: field.length,
    ownershipCohort: { players: cohort.length, mae: Number(mae.toFixed(3)), rmse: Number(rmse.toFixed(3)) },
    ranking: {
      eligiblePlayers: field.length,
      top15Overlap: top15.filter((row) => actualTop15.has(row.id)).length,
      top15ActualPoints: top15.reduce((sum, row) => sum + row.actual, 0),
      localLinearNdcg15: idealDcg ? Number((dcg(predicted) / idealDcg).toFixed(4)) : null,
    },
  };
}

export async function buildBenchmarkReport() {
  const files = (await readdir(dataDir)).filter((file) => /^gw\d+-locked\.json$/.test(file));
  const weeks = [];
  for (const file of files) {
    const gw = Number(/^gw(\d+)/.exec(file)?.[1]);
    const actualFile = path.join(dataDir, `gw${gw}-actuals-cache.json`);
    let lock;
    let actuals;
    try {
      [lock, actuals] = await Promise.all([
        readFile(path.join(dataDir, file), "utf8").then(JSON.parse),
        readFile(actualFile, "utf8").then(JSON.parse),
      ]);
    } catch { continue; }
    const result = evaluateForecast(lock, actuals);
    if (result) weeks.push(result);
  }
  weeks.sort((a, b) => a.gameweek - b.gameweek);
  return {
    schemaVersion: 1,
    methodology: "FPL Bench-style cohort diagnostics, not an official FPL Bench score",
    notes: [
      "MAE and RMSE include every frozen forecast with at least 1% ownership and a fixture, including players with zero minutes.",
      "Ranking uses all frozen players with a fixture. Missing post-deadline additions cannot be reconstructed from the frozen ownership feed.",
      "Local NDCG@15 uses nonnegative actual points as linear gain and player ID as a tie break; it may differ from FPL Bench's undisclosed gain and tie conventions.",
      "GW7 is excluded because its forecast was reconstructed after the deadline. GW4 lacks frozen ownership and price fields for a matched-cohort calculation.",
      "Legacy GW5 and GW6 source hashes were calculated on original export bytes and cannot be rehashed from the embedded JSON; managed future locks are verified against their embedded snapshot.",
    ],
    weeks,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await buildBenchmarkReport();
  await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${report.weeks.length} benchmark weeks to ${outputFile}`);
}
