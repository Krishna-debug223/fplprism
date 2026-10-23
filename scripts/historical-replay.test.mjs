import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { actualsByPlayer, forecastMetadata } = require("../.backtest-build/scripts/backtest.js");

test("target-Gameweek outcome fields cannot enter forecasting metadata", () => {
  const target = {
    GW: "12", element: "42", team: "Arsenal", fixture: "99", was_home: "True",
    total_points: "18", minutes: "90", expected_goals: "2.1", bonus: "3", value: "105",
  };
  const safe = forecastMetadata(target);
  assert.equal(safe.element, "42");
  assert.equal(safe.fixture, "99");
  for (const forbidden of ["total_points", "minutes", "expected_goals", "bonus", "value"]) {
    assert.equal(Object.hasOwn(safe, forbidden), false, forbidden);
  }
});

test("double Gameweek scoring combines fixtures into one player outcome", () => {
  const actuals = actualsByPlayer([
    { GW: "33", element: "42", total_points: "8", minutes: "90" },
    { GW: "33", element: "42", total_points: "4", minutes: "65" },
    { GW: "33", element: "53", total_points: "2", minutes: "15" },
  ]);
  assert.deepEqual(actuals.get(42), { points: 12, minutes: 155, fixtures: 2 });
  assert.deepEqual(actuals.get(53), { points: 2, minutes: 15, fixtures: 1 });
  assert.equal(actuals.size, 2);
});
