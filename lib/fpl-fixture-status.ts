import type { FplFixture } from "./types";

/** A played match can supply prior evidence before FPL finalizes bonus points. */
export function hasCompletedScore(fixture: FplFixture) {
  return (fixture.finished || fixture.finished_provisional === true)
    && fixture.team_h_score != null && fixture.team_a_score != null;
}
