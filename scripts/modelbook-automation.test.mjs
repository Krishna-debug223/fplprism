import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { archiveReport, isCaptureWindow, isCheckpointDue, isValidCheckpoint, metricSet, CHECKPOINT_INTERVAL_MS } from "./modelbook-automation.mjs";

test("report metrics use actual minus forecast and one consistent active cohort", () => {
  const locked = {
    gameweek: 8,
    modelVersion: "1.3.0",
    contentHash: "snapshot-hash",
    lockedAt: "2026-10-23T17:20:00.000Z",
    snapshot: {
      training: { trainedThroughGameweek: 7, targetGameweek: 8, method: "walk-forward", validation: "prior weeks" },
      rows: [
        { id: 1, name: "Forward", position: "FWD", projected: 3.5 },
        { id: 2, name: "Midfielder", position: "MID", projected: 3 },
        { id: 3, name: "Keeper", position: "GKP", projected: 1 },
      ],
    },
  };
  const live = {
    elements: [
      { id: 1, stats: { minutes: 90, total_points: 4 } },
      { id: 2, stats: { minutes: 90, total_points: 1 } },
      { id: 3, stats: { minutes: 0, total_points: 0 } },
    ],
  };
  const fixtures = [
    { started: true, finished: false, finished_provisional: true, minutes: 90 },
    { started: true, finished: false, finished_provisional: true, minutes: 90 },
  ];

  const report = archiveReport(8, locked, live, fixtures, "2026-10-25T20:00:00.000Z");
  assert.equal(report.overall.count, 3);
  assert.equal(report.overall.mae, 1.167);
  assert.equal(report.overall.bias, -0.833);
  assert.equal(report.activeCohort.count, 2);
  assert.equal(report.activeCohort.mae, 1.25);
  assert.equal(report.activeCohort.bias, -0.75);
  assert.equal(report.activeCohort.within2, 100);
  assert.deepEqual(Object.keys(report.byPosition), ["MID", "FWD"]);
  assert.equal(report.actualsFinality.fixtureCount, 2);
  assert.equal(report.actualsFinality.finishedProvisional, 2);
  assert.equal(report.final, false);
  assert.equal(report.bestPredictions[0].name, "Forward");
  assert.equal(report.largestMisses[0].name, "Midfielder");

  const finalized = archiveReport(8, locked, live, fixtures.map((fixture) => ({ ...fixture, finished: true })), "2026-10-25T20:00:00.000Z");
  assert.equal(finalized.final, true);
});

test("empty metric cohorts fail instead of publishing misleading zeros", () => {
  assert.throws(() => metricSet([]), /empty report cohort/);
});

test("a deadline snapshot can only be captured in the final ten minutes", () => {
  const deadline = Date.parse("2026-10-23T17:30:00.000Z");
  assert.equal(isCaptureWindow(deadline, deadline - 60 * 60 * 1000), false);
  assert.equal(isCaptureWindow(deadline, deadline - 10 * 60 * 1000), true);
  assert.equal(isCaptureWindow(deadline, deadline - 1), true);
  assert.equal(isCaptureWindow(deadline, deadline), false);
});

test("pre-deadline checkpoints cover a missed final lock without updating too frequently", () => {
  const deadline = Date.parse("2026-10-23T17:30:00.000Z");
  const now = deadline - 45 * 60 * 1000;
  assert.equal(isCheckpointDue(deadline, null, now), true);
  assert.equal(isCheckpointDue(deadline, new Date(now).toISOString(), now + 30 * 60 * 1000), false);
  assert.equal(isCheckpointDue(deadline, new Date(now - CHECKPOINT_INTERVAL_MS).toISOString(), now), true);
  assert.equal(isCheckpointDue(deadline, null, deadline - 5 * 60 * 1000), false);
  assert.equal(isCheckpointDue(deadline, null, deadline + 1), false);
});

test("only a verified snapshot captured before its matching deadline can be recovered", () => {
  const deadline = "2026-10-23T17:30:00.000Z";
  const snapshot = { gameweek: 8, generatedAt: "2026-10-23T17:14:00.000Z", rows: [{ id: 1, projected: 5 }] };
  const contentHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const candidate = { gameweek: 8, capturedAt: snapshot.generatedAt, deadlineTime: deadline, contentHash, snapshot };
  assert.equal(isValidCheckpoint(candidate, 8, deadline), true);
  assert.equal(isValidCheckpoint(candidate, 7, deadline), false);
  assert.equal(isValidCheckpoint(candidate, 8, "2026-10-23T17:25:00.000Z"), false);
  assert.equal(isValidCheckpoint({ ...candidate, contentHash: "tampered" }, 8, deadline), false);
  const late = { ...candidate, capturedAt: deadline, snapshot: { ...snapshot, generatedAt: deadline } };
  late.contentHash = createHash("sha256").update(JSON.stringify(late.snapshot)).digest("hex");
  assert.equal(isValidCheckpoint(late, 8, deadline), false);
});

test("fallback report provenance clearly identifies the last saved checkpoint", () => {
  const locked = {
    gameweek: 8,
    modelVersion: "1.3.0",
    contentHash: "checkpoint-hash",
    lockMode: "automatic-predeadline-fallback",
    snapshot: { rows: [{ id: 1, name: "Forward", position: "FWD", projected: 4 }] },
  };
  const report = archiveReport(8, locked, { elements: [{ id: 1, stats: { minutes: 90, total_points: 5 } }] }, [{ finished: true }], "2026-10-25T20:00:00.000Z");
  assert.equal(report.forecastProvenance, "predeadline-fallback");
  assert.match(report.provenanceNote, /latest saved GW8 checkpoint/);
});

test("retrospective reports identify a reconstruction and never call it a deadline forecast", () => {
  const locked = {
    gameweek: 7,
    modelVersion: "1.4.0",
    contentHash: "reconstruction-hash",
    lockMode: "retrospective-reconstruction",
    lockNote: "The original GW7 pre-deadline forecast is unavailable.",
    snapshot: {
      training: { trainedThroughGameweek: 6, targetGameweek: 7 },
      rows: [{ id: 1, name: "Player", position: "MID", projected: 4.5 }],
    },
  };
  const report = archiveReport(
    7,
    locked,
    { elements: [{ id: 1, stats: { minutes: 90, total_points: 5 } }] },
    [{ finished: false, finished_provisional: true, started: true, minutes: 90 }],
    "2026-10-20T03:00:00.000Z",
  );
  assert.equal(report.forecastProvenance, "reconstructed-after-deadline");
  assert.equal(report.final, false);
  assert.match(report.provenanceNote, /original GW7 pre-deadline forecast is unavailable/i);
  assert.match(report.bestPredictionsNote, /not the original GW deadline calls/i);
  assert.doesNotMatch(report.provenanceNote, /captured before its deadline/i);
});
