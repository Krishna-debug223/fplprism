import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { evaluateForecast, buildBenchmarkReport } from "./benchmark-modelbook.mjs";

function fixture() {
  const snapshot = {
    fixtures: [{ team_h: 1, team_a: 2 }],
    rows: [
      { id: 1, name: "A", teamId: 1, projected: 4, ownership: 10 },
      { id: 2, name: "B", teamId: 2, projected: 2, ownership: 1 },
      { id: 3, name: "C", teamId: 2, projected: 9, ownership: 0.9 },
      { id: 4, name: "D", teamId: 3, projected: 8, ownership: 50 },
    ],
  };
  const lock = {
    gameweek: 8, modelVersion: "test", lockMode: "automatic-predeadline",
    lockedAt: "2026-10-23T15:00:00Z", deadlineTime: "2026-10-23T17:30:00Z", snapshot,
    contentHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  };
  const actuals = {
    fetchedAt: "2026-10-25T21:00:00Z",
    finality: { ninetyMinutes: 1, finished: 1 },
    elements: [
      { id: 1, stats: { total_points: 0, minutes: 0 } },
      { id: 2, stats: { total_points: 6, minutes: 90 } },
      { id: 3, stats: { total_points: 12, minutes: 90 } },
      { id: 4, stats: { total_points: 15, minutes: 90 } },
    ],
  };
  return { lock, actuals };
}

test("applies ownership and fixture filters without excluding zero-minute players", () => {
  const { lock, actuals } = fixture();
  const result = evaluateForecast(lock, actuals);
  assert.equal(result.ownershipCohort.players, 2);
  assert.equal(result.ownershipCohort.mae, 4);
  assert.equal(result.ownershipCohort.rmse, 4);
  assert.equal(result.ranking.eligiblePlayers, 3);
  assert.equal(result.pointsStatus, "final");
});

test("rejects reconstructed, late, unfinished, or tampered forecasts", () => {
  const { lock, actuals } = fixture();
  assert.equal(evaluateForecast({ ...lock, lockMode: "retrospective-reconstruction" }, actuals), null);
  assert.equal(evaluateForecast({ ...lock, lockedAt: lock.deadlineTime }, actuals), null);
  assert.equal(evaluateForecast({ ...lock, snapshot: { ...lock.snapshot, rows: [] } }, actuals), null);
  assert.equal(evaluateForecast(lock, { ...actuals, finality: { ninetyMinutes: 0 } }), null);
  assert.equal(evaluateForecast({ ...lock, snapshot: { ...lock.snapshot, rows: lock.snapshot.rows.slice(1) } }, actuals), null);
});

test("checked-in benchmark report matches source archives", async () => {
  const checkedIn = JSON.parse(await readFile(new URL("../public/modelbook/data/benchmark-report.json", import.meta.url), "utf8"));
  assert.deepEqual(checkedIn, await buildBenchmarkReport());
  // Future automatic locks can add more weeks; GW7 remains excluded because
  // its forecast was reconstructed after the deadline.
  assert.deepEqual(checkedIn.weeks.map((week) => week.gameweek).filter((gw) => gw <= 8), [5, 6, 8]);
});
