export type SportsbookFixtureSignal = {
  fixtureId: number;
  event: number | null;
  homeTeamId: number;
  awayTeamId: number;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  homeWinProbability: number | null;
  drawProbability: number | null;
  awayWinProbability: number | null;
  expectedTotalGoals: number | null;
  expectedHomeGoals: number | null;
  expectedAwayGoals: number | null;
  homeCleanSheetProbability: number | null;
  awayCleanSheetProbability: number | null;
  bookmakerCount: number;
  quality: number;
  marketUpdatedAt?: string;
};

export type SportsbookPayload = {
  available: boolean;
  provider: "the-odds-api" | "none";
  sourceLabel: string;
  fetchedAt: string;
  configuredWeight: number;
  calibrationStatus: "configured" | "disabled-until-calibrated";
  fixtures: SportsbookFixtureSignal[];
  note?: string;
};

export const clampProbability = (value: number) => Math.max(0.001, Math.min(0.999, value));

export function removeVig(probabilities: number[]) {
  const valid = probabilities.map((value) => Number.isFinite(value) && value > 0 ? value : 0);
  const total = valid.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return valid.map(() => 0);
  return valid.map((value) => value / total);
}

export function decimalOddsToProbability(price: number) {
  return Number.isFinite(price) && price > 1 ? 1 / price : 0;
}

function poissonCdf(k: number, lambda: number) {
  let term = Math.exp(-lambda);
  let total = term;
  for (let i = 1; i <= k; i += 1) {
    term *= lambda / i;
    total += term;
  }
  return total;
}

/**
 * Convert a de-vigged over probability into an implied Poisson total-goals mean.
 * Only half-goal lines have a binary over/under result. Whole- and quarter-goal
 * Asian lines can push or half-win, so they cannot use this conversion.
 */
export function impliedGoalMeanFromTotal(overProbability: number, line = 2.5) {
  if (!Number.isFinite(line) || Math.abs(line % 1 - 0.5) > 1e-8) {
    throw new RangeError("A half-goal totals line is required to infer a Poisson goal mean");
  }
  const target = clampProbability(overProbability);
  const threshold = Math.max(1, Math.floor(line) + 1);
  let low = 0.2;
  let high = 6.5;
  for (let i = 0; i < 50; i += 1) {
    const mid = (low + high) / 2;
    const probabilityOver = 1 - poissonCdf(threshold - 1, mid);
    if (probabilityOver < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Allocate a market-implied total-goals mean between home and away sides.
 * 1X2 probabilities supply directional information while the clamp prevents a
 * single noisy bookmaker market from creating implausible team totals.
 */
export function splitExpectedGoals(totalGoals: number, homeWin: number, awayWin: number) {
  const decisive = Math.max(homeWin + awayWin, 0.05);
  const edge = (homeWin - awayWin) / decisive;
  const homeShare = Math.max(0.34, Math.min(0.66, 0.5 + edge * 0.16));
  const home = Math.max(0.2, Math.min(3.8, totalGoals * homeShare));
  const away = Math.max(0.2, Math.min(3.8, totalGoals - home));
  return { home, away };
}

export function normalizeTeamName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "")
    .replace(/footballclub|fc$/g, "");
}
