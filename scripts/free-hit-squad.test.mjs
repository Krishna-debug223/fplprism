import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { selectFreeHitSquad, scoreFreeHitSquad, validateFreeHitSquad } = require("../.squad-check/free-hit-squad.js");

test("optimizes the frozen GW8 forecast under squad and lineup constraints", async () => {
  const lock = JSON.parse(await readFile(new URL("../public/modelbook/data/gw8-locked.json", import.meta.url), "utf8"));
  const result = await selectFreeHitSquad(lock.snapshot.rows);
  assert.equal(result.modelStatus, "Optimal");
  assert.equal(result.picks.length, 15);
  assert.ok(result.totalPrice <= 1000);
  assert.equal(result.picks.filter((pick) => pick.role === "captain").length, 1);
  // Keep the already-published GW8 selection stable when adding explanations or future strategies.
  assert.deepEqual(result.picks.map((pick) => `${pick.id}:${pick.role}`).sort(), [
    "106:starter", "110:benchGoalkeeper", "173:starter", "200:starter", "272:bench3",
    "304:bench1", "305:bench2", "40:starter", "411:captain", "426:starter",
    "427:vice", "533:starter", "542:starter", "572:starter", "68:starter",
  ]);
  validateFreeHitSquad(result.picks);
});

test("a forced defender produces a legal, no-better counterfactual without changing the archived optimum", async () => {
  const lock = JSON.parse(await readFile(new URL("../public/modelbook/data/gw8-locked.json", import.meta.url), "utf8"));
  const players = lock.snapshot.rows;
  const gabriel = players.find((row) => row.name === "Gabriel" && row.team === "ARS" && row.position === "DEF");
  assert.ok(gabriel);
  const [original, alternative] = await Promise.all([
    selectFreeHitSquad(players),
    selectFreeHitSquad(players, gabriel.id),
  ]);
  validateFreeHitSquad(alternative.picks);
  assert.ok(alternative.picks.some((pick) => pick.id === gabriel.id));
  assert.ok(alternative.weightedExpectedPoints <= original.weightedExpectedPoints + 1e-8);
  assert.equal(original.picks.some((pick) => pick.id === gabriel.id), false);
  await assert.rejects(selectFreeHitSquad(players, -1), /not in the eligible forecast pool/);
});

test("official scoring respects bench order, formation and vice-captain fallback", () => {
  const players = [
    [1, "GKP", "starter"], [2, "GKP", "benchGoalkeeper"],
    [3, "DEF", "starter"], [4, "DEF", "starter"], [5, "DEF", "starter"], [6, "DEF", "bench2"], [7, "DEF", "bench3"],
    [8, "MID", "vice"], [9, "MID", "starter"], [10, "MID", "starter"], [11, "MID", "starter"], [12, "MID", "bench1"],
    [13, "FWD", "captain"], [14, "FWD", "starter"], [15, "FWD", "starter"],
  ];
  const picks = players.map(([id, position, role]) => ({ id, name: String(id), teamId: id, team: "T", position, role, price: 50, projected: 2, multiplier: 1 }));
  const points = picks.map((pick) => ({ id: pick.id, minutes: [3, 9, 13].includes(pick.id) ? 0 : 90, points: pick.id === 8 ? 5 : pick.id === 12 ? 3 : pick.id === 6 ? 4 : pick.id === 7 ? 6 : 2 }));
  const score = scoreFreeHitSquad(picks, points);
  assert.equal(score.captainBonusId, 8);
  assert.deepEqual(score.substitutedIds, [12, 6, 7]);
  assert.equal(score.points, 37);
  const onlyDefenderMissing = points.map((item) => ({ ...item, minutes: item.id === 3 ? 0 : 90 }));
  const defenderScore = scoreFreeHitSquad(picks, onlyDefenderMissing);
  assert.deepEqual(defenderScore.substitutedIds, [6]);
  assert.equal(defenderScore.captainBonusId, 13);
  const keeperOut = onlyDefenderMissing.map((item) => ({ ...item, minutes: item.id === 1 ? 0 : item.minutes }));
  const keeperScore = scoreFreeHitSquad(picks, keeperOut);
  assert.ok(keeperScore.substitutedIds.includes(2));
  const bothCaptainsOut = points.map((item) => ({ ...item, minutes: [8, 13].includes(item.id) ? 0 : 90 }));
  assert.equal(scoreFreeHitSquad(picks, bothCaptainsOut).captainBonusId, null);
});
