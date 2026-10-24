import { projectPlayer as baseProjectPlayer } from "../lib/risk";
import { MODEL_VERSION, POSITION_CALIBRATION, projectPlayer, recommendJointTransferPlan } from "../lib/risk-v12";
import { analyzePortfolioRisk } from "../lib/portfolio-risk";
import { impliedGoalMeanFromTotal, type SportsbookPayload } from "../lib/sportsbook";
import type { FplFixture, FplPlayer, FplTeam } from "../lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`MODEL V${MODEL_VERSION} CHECK FAILED: ${message}`);
}

function player(overrides: Partial<FplPlayer> = {}): FplPlayer {
  return {
    id: 1,
    code: 1001,
    web_name: "Test",
    first_name: "Test",
    second_name: "Player",
    team: 1,
    element_type: 3,
    now_cost: 80,
    total_points: 12,
    minutes: 360,
    starts: 4,
    form: "4.0",
    points_per_game: "4.0",
    selected_by_percent: "10.0",
    ep_next: "4.5",
    chance_of_playing_next_round: 100,
    status: "a",
    expected_goals: "1.2",
    expected_assists: "0.8",
    expected_goal_involvements: "2.0",
    expected_goals_per_90: "0.30",
    expected_assists_per_90: "0.20",
    expected_goal_involvements_per_90: "0.50",
    expected_goals_conceded_per_90: "1.2",
    clean_sheets: 1,
    saves: 0,
    bonus: 2,
    bps: 45,
    yellow_cards: 0,
    red_cards: 0,
    defensive_contribution: 20,
    defensive_contribution_per_90: "5.0",
    transfers_in_event: 1000,
    transfers_out_event: 500,
    ...overrides,
  };
}

const teams: FplTeam[] = [
  { id: 1, name: "Alpha FC", short_name: "ALP", strength: 4, strength_attack_home: 1250, strength_attack_away: 1180, strength_defence_home: 1200, strength_defence_away: 1150, elo: 1700, underlying_matches: 4, underlying_attack_xg_per_match: 1.65, underlying_attack_xa_per_match: 1.2, underlying_defence_xga_per_match: 1.05 },
  { id: 2, name: "Beta FC", short_name: "BET", strength: 3, strength_attack_home: 1080, strength_attack_away: 1040, strength_defence_home: 1050, strength_defence_away: 1020, elo: 1550, underlying_matches: 4, underlying_attack_xg_per_match: 1.25, underlying_attack_xa_per_match: 0.95, underlying_defence_xga_per_match: 1.55 },
  { id: 3, name: "Gamma FC", short_name: "GAM", strength: 3, strength_attack_home: 1100, strength_attack_away: 1070, strength_defence_home: 1080, strength_defence_away: 1050, elo: 1580, underlying_matches: 4, underlying_attack_xg_per_match: 1.35, underlying_attack_xa_per_match: 1.0, underlying_defence_xga_per_match: 1.4 },
  { id: 4, name: "Delta FC", short_name: "DEL", strength: 3, strength_attack_home: 1080, strength_attack_away: 1060, strength_defence_home: 1090, strength_defence_away: 1060, elo: 1570, underlying_matches: 4, underlying_attack_xg_per_match: 1.3, underlying_attack_xa_per_match: 1.0, underlying_defence_xga_per_match: 1.45 },
  { id: 5, name: "Epsilon FC", short_name: "EPS", strength: 3, strength_attack_home: 1090, strength_attack_away: 1060, strength_defence_home: 1070, strength_defence_away: 1040, elo: 1560, underlying_matches: 4, underlying_attack_xg_per_match: 1.28, underlying_attack_xa_per_match: 0.98, underlying_defence_xga_per_match: 1.48 },
];

const fixtures: FplFixture[] = [
  { id: 1, event: 1, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4, team_h_score: 2, team_a_score: 1, kickoff_time: "2026-08-15T14:00:00Z", finished: true, started: true },
  { id: 2, event: 1, team_h: 3, team_a: 4, team_h_difficulty: 3, team_a_difficulty: 3, team_h_score: 1, team_a_score: 1, kickoff_time: "2026-08-15T14:00:00Z", finished: true, started: true },
  { id: 10, event: 2, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4, kickoff_time: "2026-09-20T14:00:00Z", finished: false, started: false },
  { id: 11, event: 2, team_h: 3, team_a: 4, team_h_difficulty: 3, team_a_difficulty: 3, kickoff_time: "2026-09-20T14:00:00Z", finished: false, started: false },
  { id: 12, event: 3, team_h: 5, team_a: 1, team_h_difficulty: 4, team_a_difficulty: 2, kickoff_time: "2026-09-27T14:00:00Z", finished: false, started: false },
  { id: 13, event: 3, team_h: 2, team_a: 3, team_h_difficulty: 3, team_a_difficulty: 3, kickoff_time: "2026-09-27T14:00:00Z", finished: false, started: false },
];

const midfielder = player({ id: 1, code: 101, team: 1, element_type: 3 });
const base = baseProjectPlayer(midfielder, fixtures, teams, 1);
const noMarket = projectPlayer(midfielder, fixtures, teams, 1, undefined, null);
const midCalibration = POSITION_CALIBRATION.coefficients.MID;
assert(Math.abs(noMarket.expected - Math.max(0, midCalibration.intercept + midCalibration.slope * base.expected)) < 1e-10, "the position calibration must transform raw one-Gameweek expected points with the held-out coefficients");
assert(Math.abs(noMarket.components.calibrationAdjustment - (noMarket.expected - base.expected)) < 1e-10, "the calibration must be exposed separately in the points breakdown");
assert(noMarket.components.fixtureDifficulty > 0, "an easy FDR 1/2 fixture should expose a positive fixture-difficulty component");

const neutralFixtures = fixtures.map((fixture) => fixture.id === 10 ? { ...fixture, team_h_difficulty: 3 } : fixture);
const neutralFixtureProjection = projectPlayer(midfielder, neutralFixtures, teams, 1, undefined, null);
assert(Math.abs(neutralFixtureProjection.components.fixtureDifficulty) < 1e-10, "an FDR 3 fixture should expose a neutral fixture-difficulty component");

const hardFixtures = fixtures.map((fixture) => fixture.id === 10 ? { ...fixture, team_h_difficulty: 5 } : fixture);
const hardFixtureProjection = projectPlayer(midfielder, hardFixtures, teams, 1, undefined, null);
assert(hardFixtureProjection.components.fixtureDifficulty < 0, "an FDR 4/5 fixture should expose a negative fixture-difficulty component");
assert(noMarket.expected > hardFixtureProjection.expected, "making the same fixture materially harder must not increase the projection");

const zeroWeight: SportsbookPayload = {
  available: true,
  provider: "the-odds-api",
  sourceLabel: "Synthetic consensus",
  fetchedAt: "2026-09-15T00:00:00Z",
  configuredWeight: 0,
  calibrationStatus: "disabled-until-calibrated",
  fixtures: [{
    fixtureId: 10,
    event: 2,
    homeTeamId: 1,
    awayTeamId: 2,
    homeTeam: "Alpha FC",
    awayTeam: "Beta FC",
    commenceTime: "2026-09-20T14:00:00Z",
    homeWinProbability: 0.72,
    drawProbability: 0.18,
    awayWinProbability: 0.10,
    expectedTotalGoals: 3.4,
    expectedHomeGoals: 2.65,
    expectedAwayGoals: 0.75,
    homeCleanSheetProbability: Math.exp(-0.75),
    awayCleanSheetProbability: Math.exp(-2.65),
    bookmakerCount: 8,
    quality: 1,
  }],
};
const zeroWeightProjection = projectPlayer(midfielder, fixtures, teams, 1, undefined, zeroWeight);
assert(Math.abs(noMarket.expected - zeroWeightProjection.expected) < 1e-10, "a connected market feed with zero configured weight must not change calibrated xPts");
assert(zeroWeightProjection.components.sportsbookMarket === 0, "zero market weight must expose a zero sportsbook component");

const weighted: SportsbookPayload = { ...zeroWeight, configuredWeight: 0.2, calibrationStatus: "configured" };
assert(Math.abs(impliedGoalMeanFromTotal(0.5, 2.5) - 2.674) < 0.01,
  "a balanced over/under 2.5 market should imply a sensible goal mean");
let asianLineRejected = false;
try { impliedGoalMeanFromTotal(0.5, 2.0); } catch (error) { asianLineRejected = error instanceof RangeError; }
assert(asianLineRejected, "a whole-goal Asian total with possible pushes must not be treated as a binary over/under");
const weightedProjection = projectPlayer(midfielder, fixtures, teams, 1, undefined, weighted);
assert(weightedProjection.expected > noMarket.expected, "a materially stronger market attack signal should lift an attacking player's calibrated projection");
assert(weightedProjection.sportsbook.applied, "matching weighted sportsbook data should be marked as applied");
assert(weightedProjection.expected / Math.max(noMarket.expected, 0.1) <= 1.061, "sportsbook influence must remain inside the six-percent per-fixture cap");
const unrelatedSameEvent = {
  ...weighted.fixtures[0], fixtureId: 999, expectedHomeGoals: 0.35, expectedAwayGoals: 3.5,
  homeCleanSheetProbability: 0.03, awayCleanSheetProbability: 0.75,
};
const withUnrelatedQuote = projectPlayer(midfielder, fixtures, teams, 1, undefined, {
  ...weighted, fixtures: [...weighted.fixtures, unrelatedSameEvent],
});
assert(Math.abs(withUnrelatedQuote.expected - weightedProjection.expected) < 1e-10,
  "a bookmaker quote for another fixture in the same Gameweek must not affect this player's forecast");

const goalkeeper = player({ id: 2, code: 102, team: 1, element_type: 1, now_cost: 50, expected_goals: "0", expected_assists: "0", expected_goal_involvements: "0", expected_goals_per_90: "0", expected_assists_per_90: "0", expected_goal_involvements_per_90: "0", saves: 12, saves_per_90: "3.0", defensive_contribution: 0, defensive_contribution_per_90: "0" });
const goalkeeperBase = projectPlayer(goalkeeper, fixtures, teams, 1, undefined, zeroWeight);
const goalkeeperMarket = projectPlayer(goalkeeper, fixtures, teams, 1, undefined, weighted);
assert(goalkeeperBase.expected < baseProjectPlayer(goalkeeper, fixtures, teams, 1).expected, "goalkeeper overprediction calibration should reduce raw expected points");
assert(goalkeeperMarket.expected > goalkeeperBase.expected, "stronger market clean-sheet odds should lift a goalkeeper projection");

const observedFixtures: FplFixture[] = [
  ...fixtures,
  ...[3, 4, 5].map((id) => ({ ...fixtures[0], id, event: 1, finished: true, started: true })),
];
const reserveGoalkeeper = player({ id: 200, code: 1200, element_type: 1, now_cost: 45, minutes: 0, starts: 0, total_points: 0 });
const startingGoalkeeper = player({ id: 201, code: 1201, element_type: 1, now_cost: 45, minutes: 360, starts: 4 });
const reserveMidfielder = player({ id: 202, code: 1202, element_type: 3, now_cost: 50, minutes: 0, starts: 0, total_points: 0 });
const reserveProjection = projectPlayer(reserveGoalkeeper, observedFixtures, teams, 1);
const starterProjection = projectPlayer(startingGoalkeeper, observedFixtures, teams, 1);
const reserveMidfielderProjection = projectPlayer(reserveMidfielder, observedFixtures, teams, 1);
const returningStarterProjection = baseProjectPlayer(reserveGoalkeeper, observedFixtures, teams, 1, {
  [String(reserveGoalkeeper.code)]: [{
    season: "2025-26", minutes: 2700, starts: 30, totalPoints: 110,
    pointsPerGame: 3.7, xgi90: 0, startsPerMatch: 0.8, minutesPerStart: 90,
  }],
});
assert(reserveProjection.appearanceProbabilities[0] < 0.15, "a goalkeeper with no minutes after four team matches must not retain a starter-like appearance chance");
assert(reserveMidfielderProjection.appearanceProbabilities[0] < 0.2, "an outfield reserve with no minutes after four team matches must not retain a regular appearance chance");
assert(starterProjection.appearanceProbabilities[0] > 0.8, "four observed starts must preserve a high starter appearance chance");
assert(returningStarterProjection.appearanceProbabilities[0] > 0.4, "a previous-season regular must not receive the unobserved-reserve cameo penalty");

const defender = player({ id: 3, code: 103, team: 1, element_type: 2, expected_goals: "0.2", expected_assists: "0.3", expected_goal_involvements: "0.5", expected_goals_per_90: "0.05", expected_assists_per_90: "0.08", expected_goal_involvements_per_90: "0.13" });
const defenderCalibrated = projectPlayer(defender, fixtures, teams, 1, undefined, null);
assert(defenderCalibrated.expected < baseProjectPlayer(defender, fixtures, teams, 1).expected, "defender calibration should temper the positive historical bias");

// Portfolio covariance must use actual fixture identity. Sharing an event is
// insufficient because most players in a Gameweek play in unrelated matches.
const alphaProjection = projectPlayer(player({ id: 40, code: 140, team: 1 }), fixtures, teams, 1);
const alphaTeammateProjection = projectPlayer(player({ id: 41, code: 141, team: 1 }), fixtures, teams, 1);
const betaOpponentProjection = projectPlayer(player({ id: 42, code: 142, team: 2 }), fixtures, teams, 1);
const gammaUnrelatedProjection = projectPlayer(player({ id: 43, code: 143, team: 3 }), fixtures, teams, 1);
assert(alphaProjection.fixtureContexts[0]?.fixtures[0]?.id === 10, "projection context must expose the real fixture id");
assert(betaOpponentProjection.fixtureContexts[0]?.fixtures[0]?.id === 10, "opponents must share the same real fixture id");
assert(gammaUnrelatedProjection.fixtureContexts[0]?.fixtures[0]?.id === 11, "same-Gameweek unrelated players must retain a different fixture id");

const unrelatedPortfolio = analyzePortfolioRisk([
  { player: player({ id: 40, code: 140, team: 1 }), projection: alphaProjection, weight: 1 },
  { player: player({ id: 43, code: 143, team: 3 }), projection: gammaUnrelatedProjection, weight: 1 },
], teams);
assert(Math.abs(unrelatedPortfolio.portfolioVolatility - unrelatedPortfolio.independentVolatility) < 1e-10, "players in unrelated matches in the same Gameweek must have zero covariance");

const teammatePortfolio = analyzePortfolioRisk([
  { player: player({ id: 40, code: 140, team: 1 }), projection: alphaProjection, weight: 1 },
  { player: player({ id: 41, code: 141, team: 1 }), projection: alphaTeammateProjection, weight: 1 },
], teams);
assert(teammatePortfolio.portfolioVolatility > teammatePortfolio.independentVolatility, "teammates in the same real fixture must have positive covariance");
assert(teammatePortfolio.topFixture === "GW2 · ALP v BET" && teammatePortfolio.topFixtureShare > 0.999, "teammate exposure must group under one canonical fixture");

const opponentPortfolio = analyzePortfolioRisk([
  { player: player({ id: 40, code: 140, team: 1 }), projection: alphaProjection, weight: 1 },
  { player: player({ id: 42, code: 142, team: 2 }), projection: betaOpponentProjection, weight: 1 },
], teams);
assert(opponentPortfolio.portfolioVolatility < opponentPortfolio.independentVolatility, "opponents in the same real fixture must carry the opposing match covariance");
assert(opponentPortfolio.topFixture === "GW2 · ALP v BET" && opponentPortfolio.topFixtureShare > 0.999, "opponent exposure must group under the same canonical fixture");

// Joint planning must respect one shared budget and the three-per-club limit.
const outMid = player({ id: 10, code: 110, web_name: "Out Mid", team: 3, element_type: 3, now_cost: 70, expected_goals_per_90: "0.12", expected_assists_per_90: "0.10", expected_goal_involvements_per_90: "0.22" });
const outDef = player({ id: 11, code: 111, web_name: "Out Def", team: 4, element_type: 2, now_cost: 55, expected_goals_per_90: "0.03", expected_assists_per_90: "0.05", expected_goal_involvements_per_90: "0.08" });
const clubOneMid = player({ id: 20, code: 120, web_name: "Club1 Mid", team: 1, element_type: 3, now_cost: 75, expected_goals_per_90: "0.50", expected_assists_per_90: "0.30", expected_goal_involvements_per_90: "0.80" });
const clubOneDef = player({ id: 21, code: 121, web_name: "Club1 Def", team: 1, element_type: 2, now_cost: 60, expected_goals_per_90: "0.10", expected_assists_per_90: "0.12", expected_goal_involvements_per_90: "0.22" });
const altDef = player({ id: 22, code: 122, web_name: "Alt Def", team: 2, element_type: 2, now_cost: 58, expected_goals_per_90: "0.08", expected_assists_per_90: "0.10", expected_goal_involvements_per_90: "0.18" });
const fixedClubOneA = player({ id: 30, code: 130, web_name: "Fixed A", team: 1, element_type: 4, now_cost: 70 });
const fixedClubOneB = player({ id: 31, code: 131, web_name: "Fixed B", team: 1, element_type: 1, now_cost: 50 });
const fixedOther = player({ id: 32, code: 132, web_name: "Fixed C", team: 5, element_type: 4, now_cost: 65 });
const squad = [outMid, outDef, fixedClubOneA, fixedClubOneB, fixedOther];
const universe = [...squad, clubOneMid, clubOneDef, altDef];
const plan = recommendJointTransferPlan({
  players: universe,
  squad,
  fixtures,
  teams,
  outgoingIds: [outMid.id, outDef.id],
  bank: 10,
  sellingPrices: new Map([[outMid.id, 70], [outDef.id, 55]]),
  freeTransfers: 1,
  sportsbook: zeroWeight,
  horizon: 2,
});
assert(plan, "joint optimizer should find a legal two-transfer combination");
assert(plan.transferCost === 4, "two transfers with one free transfer must cost exactly four points");
assert(plan.totalIncomingCost <= plan.totalBudget, "joint optimizer must respect the shared transfer budget");
const resultingIds = new Set(squad.filter((item) => ![outMid.id, outDef.id].includes(item.id)).map((item) => item.id));
plan.moves.forEach((move) => resultingIds.add(move.incomingId));
assert(resultingIds.size === squad.length, "joint optimizer must not buy the same incoming player twice");
const resultingPlayers = [...resultingIds].map((id) => universe.find((item) => item.id === id)).filter((item): item is FplPlayer => Boolean(item));
const clubOneCount = resultingPlayers.filter((item) => item.team === 1).length;
assert(clubOneCount <= 3, "joint optimizer must enforce the maximum-three-per-club rule across the resulting squad");

console.log(`Model v${MODEL_VERSION} checks passed: reserve/starter minutes evidence, position-calibration mapping and transparency, fixture-component directionality, sportsbook fail-open/zero-weight invariance, bounded market influence, directional attack/clean-sheet response, real-fixture portfolio covariance, and joint-transfer legality.`);
