import type { FplFixture, FplPlayer, FplTeam } from "./types";
import type { SportsbookPayload, SportsbookFixtureSignal } from "./sportsbook";
import {
  assessChips,
  positionName,
  projectPlayer as projectPlayerBase,
  type ChipAdvice,
  type HistoricalProfileMap,
  type ModelConfidence,
  type Projection,
  type ProjectionDistribution,
  type Recommendation,
  simulateProjection,
} from "./risk";

export const MODEL_VERSION = "1.4.3";
export { assessChips, positionName };
export type { ChipAdvice, HistoricalProfileMap, ModelConfidence, Recommendation, ProjectionDistribution };

/**
 * Cross-season position calibration. Coefficients were fit on walk-forward
 * forecasts from 2024-25 and evaluated, without refitting, on 2025-26.
 * The coefficients came from an earlier harness that scored double
 * Gameweeks per fixture; the holdout figures below use the corrected
 * one-player-one-Gameweek replay. Refit before relying on the calibration
 * as a settled improvement.
 * Keeping the profile explicit makes the adjustment auditable and easy to
 * replace after a future season-level validation.
 */
export const POSITION_CALIBRATION = {
  trainedOnSeason: "2024-25",
  coefficients: {
    GKP: { intercept: -0.5800954423, slope: 0.9289719047, samples: 2654 },
    DEF: { intercept: -0.3142582469, slope: 0.8591202595, samples: 8470 },
    MID: { intercept: -0.1464379820, slope: 0.9622678744, samples: 11644 },
    FWD: { intercept: -0.3186483583, slope: 1.0445026962, samples: 2788 },
  },
  holdout: {
    season: "2025-26",
    allPlayerGameweeks: 27102,
    baselineMae: 1.2319,
    calibratedMae: 1.0487,
    baselineWithin2: 0.8225,
    calibratedWithin2: 0.8553,
    appearedMaeBaseline: 1.9676,
    appearedMaeCalibrated: 1.9677,
    appearedRmseBaseline: 2.9829,
    appearedRmseCalibrated: 3.1023,
    appearedWithin2Baseline: 0.6780,
    appearedWithin2Calibrated: 0.7086,
    appearedWithin2FlatTwo: 0.7717,
  },
} as const;

export const MINUTES_EVIDENCE_VALIDATION = {
  previousVersion: "1.4.1",
  testedSeason: "2025-26",
  allPlayerMaeBefore: 1.1635,
  allPlayerMaeAfter: 1.0507,
  appearanceBrierBefore: 0.1535,
  appearanceBrierAfter: 0.1260,
  activeWithin2Before: 0.7068,
  activeWithin2After: 0.7066,
  activeMaeBefore: 1.9631,
  activeMaeAfter: 1.9676,
  nextSeasonPartial: {
    season: "2026-27",
    gameweeks: "4-6",
    allPlayerMaeBefore: 1.5186,
    allPlayerMaeAfter: 1.2066,
    appearanceBrierBefore: 0.1882,
    appearanceBrierAfter: 0.1316,
  },
} as const;

export type RiskMode = "protect" | "balanced" | "chase" | "mini";

export type MarketProjection = Omit<Projection, "components"> & {
  components: Projection["components"] & {
    fixtureDifficulty: number;
    sportsbookMarket: number;
  };
  sportsbook: {
    applied: boolean;
    fixturesUsed: number;
    configuredWeight: number;
    effectiveWeight: number;
    source: string | null;
  };
  distribution?: ProjectionDistribution;
};

export type JointTransferMove = {
  outgoingId: number;
  incomingId: number;
  outgoingExpected: number;
  incomingExpected: number;
  expectedGain: number;
};

export type JointTransferPlan = {
  moves: JointTransferMove[];
  rawExpectedGain: number;
  transferCost: number;
  expectedGain: number;
  totalIncomingCost: number;
  totalBudget: number;
  confidence: ModelConfidence;
  dataQuality: number;
  reasons: string[];
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function positionCalibration(player: FplPlayer) {
  const name = positionName(player.element_type) as keyof typeof POSITION_CALIBRATION.coefficients;
  return POSITION_CALIBRATION.coefficients[name] ?? POSITION_CALIBRATION.coefficients.MID;
}

function calibratedMean(player: FplPlayer, value: number) {
  if (!(value > 0)) return 0;
  const calibration = positionCalibration(player);
  return Math.max(0, calibration.intercept + calibration.slope * value);
}

function calibratedVolatility(player: FplPlayer, fixtureMeans: number[], minutesByFixture: Projection["minutesByFixture"]) {
  const roleVolatility = player.element_type === 1 ? 0.78 : player.element_type === 2 ? 0.9 : player.element_type === 3 ? 1.05 : 1.12;
  const variance = fixtureMeans.reduce((total, mean, index) => {
    if (mean <= 0) return total;
    const minutes = minutesByFixture[index];
    const pointsPerMinute = mean / Math.max(minutes?.expected ?? 1, 1);
    const minutesVariance = pointsPerMinute ** 2 * (minutes?.variance ?? 0);
    const scoringSd = (1.7 + mean * 0.64) * roleVolatility * 0.78;
    return total + minutesVariance + scoringSd * scoringSd;
  }, 0);
  return Math.sqrt(variance);
}

function availability(player: FplPlayer) {
  if (["u", "n", "s"].includes(player.status)) return 0;
  const fallback = player.status === "a" ? 100 : player.status === "d" ? 65 : player.status === "i" ? 20 : 55;
  return clamp((player.chance_of_playing_next_round ?? fallback) / 100, 0, 1);
}

function marketSignalsFor(player: FplPlayer, projection: Projection, index: number, sportsbook?: SportsbookPayload | null) {
  if (!sportsbook?.available) return [];
  const fixtureIds = new Set(projection.fixtureContexts[index]?.fixtures.map((fixture) => fixture.id) ?? []);
  if (!fixtureIds.size) return [];
  return sportsbook.fixtures.filter((signal) => fixtureIds.has(signal.fixtureId)
    && (signal.homeTeamId === player.team || signal.awayTeamId === player.team));
}

function teamMarketGoals(player: FplPlayer, signal: SportsbookFixtureSignal) {
  return signal.homeTeamId === player.team ? signal.expectedHomeGoals : signal.expectedAwayGoals;
}

function teamMarketCleanSheet(player: FplPlayer, signal: SportsbookFixtureSignal) {
  return signal.homeTeamId === player.team ? signal.homeCleanSheetProbability : signal.awayCleanSheetProbability;
}

function marketFactor(player: FplPlayer, projection: Projection, index: number, sportsbook?: SportsbookPayload | null) {
  const context = projection.fixtureContexts[index];
  if (!context || !sportsbook?.available || sportsbook.configuredWeight <= 0) return { factor: 1, weight: 0, fixtures: 0 };
  const signals = marketSignalsFor(player, projection, index, sportsbook);
  if (!signals.length) return { factor: 1, weight: 0, fixtures: 0 };

  const validGoalSignals = signals.map((signal) => teamMarketGoals(player, signal)).filter((value): value is number => value != null && Number.isFinite(value));
  const validCleanSignals = signals.map((signal) => teamMarketCleanSheet(player, signal)).filter((value): value is number => value != null && Number.isFinite(value));
  const quality = average(signals.map((signal) => signal.quality));
  const effectiveWeight = clamp(sportsbook.configuredWeight * quality, 0, 0.25);
  if (!(effectiveWeight > 0)) return { factor: 1, weight: 0, fixtures: signals.length };

  const modelGoals = Math.max(context.ownTeamXgPerMatch, 0.35);
  const marketGoals = validGoalSignals.length ? average(validGoalSignals) : modelGoals;
  const attackRatio = clamp(marketGoals / modelGoals, 0.72, 1.28);
  const attackFactor = 1 + (attackRatio - 1) * effectiveWeight;

  const modelClean = Math.max(context.cleanSheetProbability, 0.04);
  const marketClean = validCleanSignals.length ? average(validCleanSignals) : modelClean;
  const cleanRatio = clamp(marketClean / modelClean, 0.7, 1.3);
  const cleanFactor = 1 + (cleanRatio - 1) * effectiveWeight;

  const positionFactor = player.element_type === 1
    ? cleanFactor
    : player.element_type === 2
      ? attackFactor * 0.35 + cleanFactor * 0.65
      : player.element_type === 3
        ? attackFactor * 0.94 + cleanFactor * 0.06
        : attackFactor;

  return { factor: clamp(positionFactor, 0.94, 1.06), weight: effectiveWeight, fixtures: signals.length };
}

/**
 * Make the FPL fixture-difficulty signal visible in the scoring breakdown.
 * The core model already uses FDR inside its fixture context, so this isolates
 * the approximate portion of projected points attributable to that FDR
 * adjustment without applying it a second time. FDR 1/2 is positive, FDR 3
 * is neutral, and FDR 4/5 is negative.
 */
function fixtureDifficultyComponent(projection: Projection) {
  return projection.fixtureMeans.reduce((total, mean, index) => {
    const context = projection.fixtureContexts[index];
    if (!context || !(mean > 0)) return total;
    const fdrFactor = clamp(context.fdrFactor || 1, 0.9, 1.1);
    if (Math.abs(fdrFactor - 1) < 1e-9) return total;
    const neutralMean = mean / fdrFactor;
    const isolatedEffect = mean - neutralMean;
    const cap = Math.max(0.15, mean * 0.12);
    return total + clamp(isolatedEffect, -cap, cap);
  }, 0);
}

function confidenceFromQuality(quality: number): ModelConfidence {
  if (quality >= 75) return "High";
  if (quality >= 50) return "Medium";
  return "Low";
}

export function projectPlayer(
  player: FplPlayer,
  fixtures: FplFixture[],
  teams: FplTeam[],
  horizon = 5,
  history?: HistoricalProfileMap,
  sportsbook?: SportsbookPayload | null,
  eventIdsOverride?: number[],
  includeDistribution = false,
): MarketProjection {
  const base = projectPlayerBase(player, fixtures, teams, horizon, history, eventIdsOverride);
  const adjustments = base.fixtureMeans.map((mean, index) => marketFactor(player, base, index, sportsbook));
  const marketFixtureMeans = base.fixtureMeans.map((mean, index) => mean * (adjustments[index]?.factor ?? 1));
  const adjustedFixtureMeans = marketFixtureMeans.map((mean) => calibratedMean(player, mean));
  const expected = adjustedFixtureMeans.reduce((sum, value) => sum + value, 0);
  const calibrationAdjustment = expected - marketFixtureMeans.reduce((sum, value) => sum + value, 0);
  const volatility = calibratedVolatility(player, adjustedFixtureMeans, base.minutesByFixture);
  const fixtureDifficulty = fixtureDifficultyComponent(base);
  const sportsbookMarket = marketFixtureMeans.reduce((sum, value) => sum + value, 0) - base.expected;
  const fixturesUsed = adjustments.reduce((sum, item) => sum + item.fixtures, 0);
  const effectiveWeight = adjustments.length ? average(adjustments.map((item) => item.weight)) : 0;
  const dataQuality = clamp(base.dataQuality + (fixturesUsed > 0 ? Math.round(effectiveWeight * 20) : 0), 0, 100);
  const cv = volatility / Math.max(expected, 1);
  const distribution = includeDistribution
    ? simulateProjection(player, { ...base, expected, volatility, fixtureMeans: adjustedFixtureMeans }, 768)
    : undefined;

  return {
    ...base,
    expected,
    volatility,
    fixtureMeans: adjustedFixtureMeans,
    risk: cv < 0.46 ? "Low" : cv < 0.63 ? "Medium" : "High",
    dataQuality,
    confidence: confidenceFromQuality(dataQuality),
    components: { ...base.components, fixtureDifficulty, sportsbookMarket, calibrationAdjustment },
    distribution,
    sportsbook: {
      applied: fixturesUsed > 0 && effectiveWeight > 0,
      fixturesUsed,
      configuredWeight: sportsbook?.configuredWeight ?? 0,
      effectiveWeight,
      source: sportsbook?.available ? sportsbook.sourceLabel : null,
    },
  };
}

function recommendationConfidence(edge: number, outgoing: MarketProjection, incoming: MarketProjection): ModelConfidence {
  const quality = (outgoing.dataQuality + incoming.dataQuality) / 2;
  const combinedRisk = Math.sqrt(outgoing.volatility ** 2 + incoming.volatility ** 2);
  const signal = edge / Math.max(1.5, combinedRisk * 0.22);
  if (quality >= 72 && edge >= 2.5 && signal >= 0.75) return "High";
  if (quality >= 48 && edge >= 0.9 && signal >= 0.25) return "Medium";
  return "Low";
}

export function recommendReplacements({
  players,
  squad,
  fixtures,
  teams,
  outgoing,
  bank,
  sellingPrice,
  horizon = 5,
  limit = 3,
  history,
  freeTransfers = 1,
  sportsbook,
  riskMode = "balanced",
}: {
  players: FplPlayer[];
  squad: FplPlayer[];
  fixtures: FplFixture[];
  teams: FplTeam[];
  outgoing: FplPlayer;
  bank: number;
  sellingPrice?: number;
  horizon?: number;
  limit?: number;
  history?: HistoricalProfileMap;
  freeTransfers?: number;
  sportsbook?: SportsbookPayload | null;
  riskMode?: RiskMode;
}): Recommendation[] {
  const sale = sellingPrice ?? outgoing.now_cost;
  const budget = sale + Math.max(bank, 0);
  const squadIds = new Set(squad.map((player) => player.id));
  const outgoingProjection = projectPlayer(outgoing, fixtures, teams, horizon, history, sportsbook);
  const transferCost = freeTransfers > 0 ? 0 : 4;

  return players
    .filter((candidate) => candidate.id !== outgoing.id)
    .filter((candidate) => candidate.element_type === outgoing.element_type)
    .filter((candidate) => !squadIds.has(candidate.id))
    .filter((candidate) => candidate.now_cost <= budget)
    .filter((candidate) => squad.filter((player) => player.id !== outgoing.id && player.team === candidate.team).length < 3)
    .filter((candidate) => !["u", "s", "n"].includes(candidate.status))
    .filter((candidate) => availability(candidate) >= 0.5)
    .map((candidate) => {
      const incomingProjection = projectPlayer(candidate, fixtures, teams, horizon, history, sportsbook);
      const rawExpectedGain = incomingProjection.expected - outgoingProjection.expected;
      const expectedGain = rawExpectedGain - transferCost;
      const quality = (outgoingProjection.dataQuality + incomingProjection.dataQuality) / 2;
      const combinedVolatility = Math.sqrt(outgoingProjection.volatility ** 2 + incomingProjection.volatility ** 2);
      const signalToNoise = expectedGain / Math.max(combinedVolatility, 1.5);
      const riskIncrease = Math.max(0, incomingProjection.volatility - outgoingProjection.volatility);
      const uncertaintyPenalty = riskIncrease * 0.08 + Math.max(0, 55 - quality) * 0.008;
      const priceHeadroom = Math.max(0, budget - candidate.now_cost) / 10;
      const rollValue = freeTransfers === 1 ? 0.45 : freeTransfers === 2 ? 0.18 : freeTransfers >= 5 ? -0.1 : 0.04;
      const outgoingFixture = outgoingProjection.fixtureContexts.length ? average(outgoingProjection.fixtureContexts.map((context) => context.overallFactor)) : 1;
      const incomingFixture = incomingProjection.fixtureContexts.length ? average(incomingProjection.fixtureContexts.map((context) => context.overallFactor)) : 1;
      const fixtureEdge = incomingFixture - outgoingFixture;
      const riskPreference =
        riskMode === "protect"
          ? -0.30 * (incomingProjection.volatility - outgoingProjection.volatility)
          : riskMode === "chase"
            ? 0.26 * (incomingProjection.volatility - outgoingProjection.volatility)
            : riskMode === "mini"
              ? 0.12 * (incomingProjection.volatility - outgoingProjection.volatility)
              : 0;
      const score = expectedGain + signalToNoise * 0.35 - uncertaintyPenalty - rollValue + riskPreference + (availability(candidate) - 0.85) * 0.35 + Math.min(priceHeadroom, 1.5) * 0.01;
      const reasons: string[] = [];
      if (transferCost > 0) reasons.push(`Includes the -4 hit; raw projection edge is +${rawExpectedGain.toFixed(1)} points`);
      if (expectedGain >= 2) reasons.push(`Projects ${expectedGain.toFixed(1)} net points more over ${horizon} GWs`);
      else if (expectedGain > 0) reasons.push(`Adds ${expectedGain.toFixed(1)} net projected points over ${horizon} GWs`);
      else reasons.push("Ranks highest among the legal options, but holding still has the stronger net expectation");
      if (fixtureEdge >= 0.04) reasons.push("Moves into the stronger modelled fixture run");
      if (incomingProjection.sportsbook.applied && Math.abs(incomingProjection.components.sportsbookMarket) >= 0.15) reasons.push("De-vigged sportsbook markets support the incoming player's team-level scoring outlook");
      if (incomingProjection.risk === "Low" && outgoingProjection.risk !== "Low") reasons.push("Reduces modelled outcome risk");
      if (riskMode === "protect" && incomingProjection.volatility < outgoingProjection.volatility) reasons.push("Protects rank with a tighter simulated range");
      if (riskMode === "chase" && incomingProjection.volatility > outgoingProjection.volatility) reasons.push("Adds controlled variance for a rank-chasing profile");
      if (riskMode === "mini" && incomingProjection.volatility > outgoingProjection.volatility) reasons.push("Balances expected gain with mini-league upside");
      if (quality >= 70) reasons.push("Both sides of the comparison have strong model data coverage");

      return {
        outgoingId: outgoing.id,
        incomingId: candidate.id,
        budget,
        rawExpectedGain,
        transferCost,
        expectedGain,
        outgoingExpected: outgoingProjection.expected,
        incomingExpected: incomingProjection.expected,
        outgoingRisk: outgoingProjection.risk,
        incomingRisk: incomingProjection.risk,
        score,
        fixtureEdge,
        dataQuality: Math.round(quality),
        confidence: recommendationConfidence(expectedGain, outgoingProjection, incomingProjection),
        reasons: reasons.slice(0, 3),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function recommendTeamTransfer(options: Parameters<typeof recommendReplacements>[0] & { sellingPrices?: Map<number, number> }) {
  const { players, squad, fixtures, teams, bank, history, freeTransfers = 1, sportsbook, sellingPrices = new Map<number, number>() } = options;
  const candidates = squad.flatMap((outgoing) => recommendReplacements({
    players,
    squad,
    fixtures,
    teams,
    outgoing,
    bank,
    sellingPrice: sellingPrices.get(outgoing.id),
    horizon: 5,
    limit: 1,
    history,
    freeTransfers,
    sportsbook,
  }));
  if (!candidates.length) return null;
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  const minimumEdge = freeTransfers === 0 ? 0.9 : freeTransfers >= 5 ? 0.3 : freeTransfers >= 2 ? 0.55 : 0.9;
  const minimumScore = freeTransfers === 0 ? 0.35 : freeTransfers >= 5 ? 0.05 : freeTransfers >= 2 ? 0.2 : 0.4;
  return best.expectedGain > minimumEdge && best.score > minimumScore ? best : null;
}

export function recommendJointTransferPlan({
  players,
  squad,
  fixtures,
  teams,
  outgoingIds,
  bank,
  sellingPrices,
  freeTransfers = 1,
  history,
  sportsbook,
  horizon = 5,
}: {
  players: FplPlayer[];
  squad: FplPlayer[];
  fixtures: FplFixture[];
  teams: FplTeam[];
  outgoingIds: number[];
  bank: number;
  sellingPrices: Map<number, number>;
  freeTransfers?: number;
  history?: HistoricalProfileMap;
  sportsbook?: SportsbookPayload | null;
  horizon?: number;
}): JointTransferPlan | null {
  const outgoing = outgoingIds.map((id) => squad.find((player) => player.id === id)).filter((player): player is FplPlayer => Boolean(player));
  if (!outgoing.length || outgoing.length !== outgoingIds.length) return null;

  const outgoingSet = new Set(outgoingIds);
  const remaining = squad.filter((player) => !outgoingSet.has(player.id));
  const remainingIds = new Set(remaining.map((player) => player.id));
  const totalBudget = Math.max(bank, 0) + outgoing.reduce((sum, player) => sum + (sellingPrices.get(player.id) ?? player.now_cost), 0);
  const transferCost = 4 * Math.max(0, outgoing.length - freeTransfers);
  const outgoingProjections = new Map(outgoing.map((player) => [player.id, projectPlayer(player, fixtures, teams, horizon, history, sportsbook)]));
  const rawOutgoing = outgoing.reduce((sum, player) => sum + (outgoingProjections.get(player.id)?.expected ?? 0), 0);

  const clubCounts = new Map<number, number>();
  remaining.forEach((player) => clubCounts.set(player.team, (clubCounts.get(player.team) ?? 0) + 1));

  const pools = outgoing.map((player) => players
    .filter((candidate) => candidate.element_type === player.element_type)
    .filter((candidate) => !remainingIds.has(candidate.id) && !outgoingSet.has(candidate.id))
    .filter((candidate) => !["u", "s", "n"].includes(candidate.status) && availability(candidate) >= 0.5)
    .map((candidate) => ({ player: candidate, projection: projectPlayer(candidate, fixtures, teams, horizon, history, sportsbook) }))
    .sort((a, b) => b.projection.expected - a.projection.expected)
    .slice(0, 18));

  type Beam = { incoming: Array<{ player: FplPlayer; projection: MarketProjection }>; cost: number; clubs: Map<number, number>; score: number };
  let beam: Beam[] = [{ incoming: [], cost: 0, clubs: clubCounts, score: 0 }];

  pools.forEach((pool) => {
    const next: Beam[] = [];
    beam.forEach((state) => {
      pool.forEach((candidate) => {
        if (state.incoming.some((item) => item.player.id === candidate.player.id)) return;
        const cost = state.cost + candidate.player.now_cost;
        if (cost > totalBudget) return;
        const currentClub = state.clubs.get(candidate.player.team) ?? 0;
        if (currentClub >= 3) return;
        const clubs = new Map(state.clubs);
        clubs.set(candidate.player.team, currentClub + 1);
        next.push({
          incoming: [...state.incoming, candidate],
          cost,
          clubs,
          score: state.score + candidate.projection.expected,
        });
      });
    });
    beam = next.sort((a, b) => b.score - a.score).slice(0, 300);
  });

  const best = beam[0];
  if (!best || best.incoming.length !== outgoing.length) return null;
  const rawIncoming = best.incoming.reduce((sum, item) => sum + item.projection.expected, 0);
  const rawExpectedGain = rawIncoming - rawOutgoing;
  const expectedGain = rawExpectedGain - transferCost;
  const qualityValues = [
    ...outgoing.map((player) => outgoingProjections.get(player.id)?.dataQuality ?? 0),
    ...best.incoming.map((item) => item.projection.dataQuality),
  ];
  const dataQuality = Math.round(average(qualityValues));
  const confidence: ModelConfidence = dataQuality >= 72 && expectedGain >= 3 ? "High" : dataQuality >= 48 && expectedGain >= 1 ? "Medium" : "Low";
  const moves = outgoing.map((player, index) => {
    const incoming = best.incoming[index];
    const outExpected = outgoingProjections.get(player.id)?.expected ?? 0;
    return {
      outgoingId: player.id,
      incomingId: incoming.player.id,
      outgoingExpected: outExpected,
      incomingExpected: incoming.projection.expected,
      expectedGain: incoming.projection.expected - outExpected,
    };
  });
  const reasons = [
    `Jointly optimised ${moves.length} move${moves.length === 1 ? "" : "s"} under one shared £${(totalBudget / 10).toFixed(1)}m transfer budget.`,
    `The combination adds ${rawExpectedGain.toFixed(1)} projected points before ${transferCost ? `${transferCost} points of hits` : "transfer costs"}.`,
    "Position, duplicate-player and maximum-three-per-club constraints are enforced across the whole plan.",
  ];

  return { moves, rawExpectedGain, transferCost, expectedGain, totalIncomingCost: best.cost, totalBudget, confidence, dataQuality, reasons };
}
