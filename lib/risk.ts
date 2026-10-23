import type { FplEvent, FplFixture, FplPlayer, FplTeam, HistoricalPayload, HistoricalSeasonSummary, UsedChip } from "./types";

export const MODEL_VERSION = "1.4.3";

export type HistoricalProfileMap = HistoricalPayload["players"];
export type ModelConfidence = "High" | "Medium" | "Low";

export type HistoryBlendInfo = {
  seasons: number;
  historicalPpg: number | null;
  historicalXgi90: number | null;
  historicalXg90: number | null;
  historicalXa90: number | null;
  historicalXgc90: number | null;
  historicalDc90: number | null;
  historicalSaves90: number | null;
  historicalBonus90: number | null;
  historicalYellow90: number | null;
  historicalStartRate: number | null;
  historicalMinutesPerStart: number | null;
  influence: number;
};

export type ProjectedFixtureIdentity = {
  id: number;
  event: number | null;
  homeTeamId: number;
  awayTeamId: number;
};

export type FixtureContext = {
  event: number | null;
  label: string;
  fixtures: ProjectedFixtureIdentity[];
  fdr: number;
  overallFactor: number;
  fdrFactor: number;
  teamStrengthFactor: number;
  recentFormFactor: number;
  eloFactor: number;
  underlyingFactor: number;
  attackFactor: number;
  ownTeamQuality: number;
  opponentQuality: number;
  ownTeamXgPerMatch: number;
  opponentXgaPerMatch: number;
  expectedGoalsAgainst: number;
  cleanSheetProbability: number;
};

export type ProjectionComponents = {
  appearance: number;
  attack: number;
  cleanSheet: number;
  saves: number;
  defensiveContribution: number;
  bonus: number;
  discipline: number;
  empiricalAnchor: number;
  calibrationAdjustment: number;
};

/**
 * Playing-time uncertainty for one projected fixture. The model keeps
 * minutes uncertainty separate from scoring-rate uncertainty so rotation,
 * bench cameos and substitutions are visible rather than hidden in a generic
 * volatility multiplier.
 */
export type MinutesDistribution = {
  expected: number;
  p10: number;
  p50: number;
  p90: number;
  variance: number;
  startProbability: number;
  cameoProbability: number;
  appearanceProbability: number;
  minutesIfStart: number;
  minutesIfStartSd: number;
  minutesIfCameo: number;
  minutesIfCameoSd: number;
  rotationRisk: number;
};

export type MinutesSummary = {
  expected: number;
  p10: number;
  p50: number;
  p90: number;
  variance: number;
  rotationRisk: number;
};

export type Projection = {
  playerId: number;
  horizon: number;
  expected: number;
  volatility: number;
  fixtureMeans: number[];
  fixtureLabels: string[];
  fixtureContexts: FixtureContext[];
  appearanceProbabilities: number[];
  risk: "Low" | "Medium" | "High";
  dataQuality: number;
  confidence: ModelConfidence;
  components: ProjectionComponents;
  minutes: MinutesSummary;
  minutesByFixture: MinutesDistribution[];
  distribution?: ProjectionDistribution;
};

export type ProjectionDistribution = {
  p10: number;
  median: number;
  p90: number;
  standardDeviation: number;
  sharpe: number;
  bands: {
    bust: number;
    floor: number;
    middle: number;
    haul: number;
  };
  simulations: number;
};

export type TransferResult = {
  expectedGain: number;
  successProbability: number;
  downsideProbability: number;
  p10: number;
  median: number;
  p90: number;
  volatility: number;
  samples: number[];
};

const n = (value: string | number | null | undefined, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const average = (values: number[]) => values.length ? sum(values) / values.length : 0;

export const positionName = (type: number) => ["", "GKP", "DEF", "MID", "FWD"][type] ?? "—";

export function upcomingPlayerFixtures(player: FplPlayer, fixtures: FplFixture[], teams: FplTeam[], horizon: number, eventIdsOverride?: number[]) {
  const teamMap = new Map(teams.map((team) => [team.id, team]));
  const eventIds = eventIdsOverride ?? [...new Set(fixtures
    .filter((fixture) => !fixture.finished && fixture.event != null)
    .map((fixture) => fixture.event as number))]
    .sort((a, b) => a - b)
    .slice(0, horizon);
  const eventSet = new Set(eventIds);

  return fixtures
    .filter((fixture) => !fixture.finished && fixture.event != null && eventSet.has(fixture.event) && (fixture.team_h === player.team || fixture.team_a === player.team))
    .sort((a, b) => (a.event ?? 99) - (b.event ?? 99) || (a.kickoff_time ?? "").localeCompare(b.kickoff_time ?? ""))
    .map((fixture) => {
      const home = fixture.team_h === player.team;
      const opponentId = home ? fixture.team_a : fixture.team_h;
      const opponent = teamMap.get(opponentId);
      return {
        fixture,
        home,
        opponentId,
        difficulty: home ? fixture.team_h_difficulty : fixture.team_a_difficulty,
        label: `${opponent?.short_name ?? "?"} ${home ? "(H)" : "(A)"}`,
      };
    });
}

function historyRows(player: FplPlayer, history?: HistoricalProfileMap) {
  return history?.[String(player.code)]?.filter((row) => row.minutes >= 90).slice(0, 3) ?? [];
}

function weightedHistoryValue(rows: HistoricalSeasonSummary[], selector: (row: HistoricalSeasonSummary) => number | null | undefined) {
  const recency = [0.58, 0.28, 0.14];
  let numerator = 0;
  let denominator = 0;
  rows.forEach((row, index) => {
    const value = selector(row);
    if (value == null || !Number.isFinite(value)) return;
    const sampleReliability = clamp(row.minutes / 1800, 0.2, 1);
    const weight = (recency[index] ?? 0.1) * sampleReliability;
    numerator += value * weight;
    denominator += weight;
  });
  return denominator > 0 ? numerator / denominator : null;
}

export function historyBlendInfo(player: FplPlayer, history?: HistoricalProfileMap): HistoryBlendInfo {
  const rows = historyRows(player, history);
  const historicalPpg = weightedHistoryValue(rows, (row) => row.pointsPerGame > 0 ? row.pointsPerGame : null);
  const historicalXgi90 = weightedHistoryValue(rows, (row) => row.xgi90 > 0 ? row.xgi90 : null);
  const influence = rows.length ? 0.55 * clamp(1 - player.minutes / 900, 0, 1) : 0;

  return {
    seasons: rows.length,
    historicalPpg,
    historicalXgi90,
    historicalXg90: weightedHistoryValue(rows, (row) => row.expectedGoalsPer90 && row.expectedGoalsPer90 > 0 ? row.expectedGoalsPer90 : null),
    historicalXa90: weightedHistoryValue(rows, (row) => row.expectedAssistsPer90 && row.expectedAssistsPer90 > 0 ? row.expectedAssistsPer90 : null),
    historicalXgc90: weightedHistoryValue(rows, (row) => row.expectedGoalsConcededPer90 && row.expectedGoalsConcededPer90 > 0 ? row.expectedGoalsConcededPer90 : null),
    historicalDc90: weightedHistoryValue(rows, (row) => row.defensiveContributionPer90 && row.defensiveContributionPer90 > 0 ? row.defensiveContributionPer90 : null),
    historicalSaves90: weightedHistoryValue(rows, (row) => row.savesPer90 && row.savesPer90 > 0 ? row.savesPer90 : null),
    historicalBonus90: weightedHistoryValue(rows, (row) => row.bonusPer90 != null ? row.bonusPer90 : null),
    historicalYellow90: weightedHistoryValue(rows, (row) => row.yellowCardsPer90 != null ? row.yellowCardsPer90 : null),
    historicalStartRate: weightedHistoryValue(rows, (row) => row.startsPerMatch != null ? row.startsPerMatch : null),
    historicalMinutesPerStart: weightedHistoryValue(rows, (row) => row.minutesPerStart != null ? row.minutesPerStart : null),
    influence,
  };
}

type TeamFormSnapshot = {
  matches: number;
  attackIndex: number;
  defenceIndex: number;
  pointsPerMatch: number;
};

function leagueGoalBaselines(fixtures: FplFixture[]) {
  const completed = fixtures.filter((fixture) => fixture.finished && fixture.team_h_score != null && fixture.team_a_score != null);
  const priorMatches = 40;
  const homePrior = 1.52;
  const awayPrior = 1.24;
  const homeGoals = completed.reduce((total, fixture) => total + (fixture.team_h_score ?? 0), 0);
  const awayGoals = completed.reduce((total, fixture) => total + (fixture.team_a_score ?? 0), 0);
  const home = (homeGoals + homePrior * priorMatches) / (completed.length + priorMatches);
  const away = (awayGoals + awayPrior * priorMatches) / (completed.length + priorMatches);
  return { home: clamp(home, 1.1, 1.9), away: clamp(away, 0.9, 1.6), overall: (home + away) / 2 };
}

function recentTeamForm(teamId: number, fixtures: FplFixture[]): TeamFormSnapshot {
  const leagueAvg = leagueGoalBaselines(fixtures).overall;
  const recent = fixtures
    .filter((fixture) => fixture.finished && fixture.team_h_score != null && fixture.team_a_score != null && (fixture.team_h === teamId || fixture.team_a === teamId))
    .sort((a, b) => (b.event ?? 0) - (a.event ?? 0) || (b.kickoff_time ?? "").localeCompare(a.kickoff_time ?? ""))
    .slice(0, 8);

  if (!recent.length) return { matches: 0, attackIndex: 1, defenceIndex: 1, pointsPerMatch: 1.35 };

  let weightSum = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let points = 0;
  recent.forEach((fixture, index) => {
    const weight = Math.pow(0.84, index);
    const home = fixture.team_h === teamId;
    const gf = home ? fixture.team_h_score ?? 0 : fixture.team_a_score ?? 0;
    const ga = home ? fixture.team_a_score ?? 0 : fixture.team_h_score ?? 0;
    const resultPoints = gf > ga ? 3 : gf === ga ? 1 : 0;
    weightSum += weight;
    goalsFor += gf * weight;
    goalsAgainst += ga * weight;
    points += resultPoints * weight;
  });

  // A four-match league-average prior stops GW1/GW2 scorelines from dominating the model.
  const priorWeight = 4;
  const attackRate = (goalsFor + leagueAvg * priorWeight) / (weightSum + priorWeight);
  const concedeRate = (goalsAgainst + leagueAvg * priorWeight) / (weightSum + priorWeight);
  const pointsPerMatch = (points + 1.35 * priorWeight) / (weightSum + priorWeight);

  return {
    matches: recent.length,
    attackIndex: clamp(attackRate / leagueAvg, 0.72, 1.28),
    defenceIndex: clamp(leagueAvg / Math.max(concedeRate, 0.35), 0.72, 1.28),
    pointsPerMatch,
  };
}

function averageStrength(teams: FplTeam[], key: keyof FplTeam) {
  const values = teams.map((team) => n(team[key] as number | undefined)).filter((value) => value > 0);
  return values.length ? sum(values) / values.length : 1000;
}

function relativeStrength(value: number, average: number, exponent: number, inverse = false) {
  if (!value || !average) return 1;
  const ratio = inverse ? average / value : value / average;
  return clamp(Math.pow(ratio, exponent), 0.88, 1.12);
}

function averageElo(teams: FplTeam[]) {
  const values = teams.map((team) => n(team.elo)).filter((value) => value > 1200);
  return values.length ? sum(values) / values.length : 1500;
}

function leagueUnderlyingBaselines(teams: FplTeam[]) {
  const attackXg = teams.map((team) => n(team.underlying_attack_xg_per_match)).filter((value) => value > 0);
  const attackXa = teams.map((team) => n(team.underlying_attack_xa_per_match)).filter((value) => value > 0);
  const defenceXga = teams.map((team) => n(team.underlying_defence_xga_per_match)).filter((value) => value > 0);
  const average = (values: number[], fallback: number) => values.length ? sum(values) / values.length : fallback;
  return {
    attackXg: clamp(average(attackXg, 1.42), 1.05, 1.8),
    attackXa: clamp(average(attackXa, 1.05), 0.72, 1.45),
    defenceXga: clamp(average(defenceXga, 1.42), 1.05, 1.8),
  };
}

function shrinkTeamMetric(value: number, leagueAverage: number, matches: number, priorMatches = 6) {
  if (!(value > 0)) return leagueAverage;
  const sample = clamp(matches, 0, 38);
  return (value * sample + leagueAverage * priorMatches) / (sample + priorMatches);
}

function fixtureContext(
  player: FplPlayer,
  item: ReturnType<typeof upcomingPlayerFixtures>[number],
  teams: FplTeam[],
  fixtures: FplFixture[],
): FixtureContext {
  const team = teams.find((row) => row.id === player.team);
  const opponent = teams.find((row) => row.id === item.opponentId);

  // FDR is useful context, but deliberately narrow so it cannot overpower the underlying data.
  const fdrAttackMap: Record<number, number> = { 1: 1.04, 2: 1.02, 3: 1, 4: 0.98, 5: 0.96 };
  const fdrGoalsAgainstMap: Record<number, number> = { 1: 0.94, 2: 0.97, 3: 1, 4: 1.04, 5: 1.08 };
  const fdrFactor = fdrAttackMap[item.difficulty] ?? 1;
  const homeAttackFactor = item.home ? 1.04 : 0.98;
  const leagueGoals = leagueGoalBaselines(fixtures);
  const underlyingLeague = leagueUnderlyingBaselines(teams);

  if (!team || !opponent) {
    const expectedGoalsAgainst = (item.home ? leagueGoals.away : leagueGoals.home) * (fdrGoalsAgainstMap[item.difficulty] ?? 1);
    return {
      event: item.fixture.event,
      label: item.label,
      fixtures: [{
        id: item.fixture.id,
        event: item.fixture.event,
        homeTeamId: item.fixture.team_h,
        awayTeamId: item.fixture.team_a,
      }],
      fdr: item.difficulty,
      overallFactor: fdrFactor * homeAttackFactor,
      fdrFactor,
      teamStrengthFactor: 1,
      recentFormFactor: 1,
      eloFactor: 1,
      underlyingFactor: 1,
      attackFactor: fdrFactor * homeAttackFactor,
      ownTeamQuality: 1,
      opponentQuality: 1,
      ownTeamXgPerMatch: underlyingLeague.attackXg,
      opponentXgaPerMatch: underlyingLeague.defenceXga,
      expectedGoalsAgainst,
      cleanSheetProbability: Math.exp(-expectedGoalsAgainst),
    };
  }

  const ownAttackKey: keyof FplTeam = item.home ? "strength_attack_home" : "strength_attack_away";
  const ownDefKey: keyof FplTeam = item.home ? "strength_defence_home" : "strength_defence_away";
  const oppAttackKey: keyof FplTeam = item.home ? "strength_attack_away" : "strength_attack_home";
  const oppDefKey: keyof FplTeam = item.home ? "strength_defence_away" : "strength_defence_home";

  const ownAttack = n(team[ownAttackKey] as number | undefined, team.strength);
  const ownDef = n(team[ownDefKey] as number | undefined, team.strength);
  const oppAttack = n(opponent[oppAttackKey] as number | undefined, opponent.strength);
  const oppDef = n(opponent[oppDefKey] as number | undefined, opponent.strength);
  const avgOwnAttack = averageStrength(teams, ownAttackKey);
  const avgOwnDef = averageStrength(teams, ownDefKey);
  const avgOppAttack = averageStrength(teams, oppAttackKey);
  const avgOppDef = averageStrength(teams, oppDefKey);

  const ownForm = recentTeamForm(team.id, fixtures);
  const oppForm = recentTeamForm(opponent.id, fixtures);
  const ownAttackFactor = relativeStrength(ownAttack, avgOwnAttack, 0.14);
  const opponentDefenceWeakness = relativeStrength(oppDef, avgOppDef, 0.18, true);
  const teamStrengthFactor = clamp(ownAttackFactor * opponentDefenceWeakness, 0.9, 1.11);

  // Actual scorelines are noisy. They only make a small residual adjustment after xG/xGA.
  const recentFormFactor = clamp(Math.pow(ownForm.attackIndex / Math.max(oppForm.defenceIndex, 0.7), 0.08), 0.975, 1.025);

  const avgElo = averageElo(teams);
  const ownElo = n(team.elo, avgElo);
  const opponentElo = n(opponent.elo, avgElo);
  const eloFactor = clamp(Math.pow(10, (ownElo - opponentElo) / 2600), 0.94, 1.06);

  const ownMatches = n(team.underlying_matches);
  const oppMatches = n(opponent.underlying_matches);
  const ownXg = shrinkTeamMetric(n(team.underlying_attack_xg_per_match), underlyingLeague.attackXg, ownMatches);
  const ownXa = shrinkTeamMetric(n(team.underlying_attack_xa_per_match), underlyingLeague.attackXa, ownMatches);
  const oppXga = shrinkTeamMetric(n(opponent.underlying_defence_xga_per_match), underlyingLeague.defenceXga, oppMatches);
  const ownXgIndex = ownXg / underlyingLeague.attackXg;
  const ownXaIndex = ownXa / underlyingLeague.attackXa;
  const oppDefWeaknessIndex = oppXga / underlyingLeague.defenceXga;
  const underlyingFactor = clamp(
    Math.pow(ownXgIndex, 0.18) * Math.pow(ownXaIndex, 0.06) * Math.pow(oppDefWeaknessIndex, 0.2),
    0.88,
    1.14,
  );

  const attackFactor = clamp(
    homeAttackFactor * fdrFactor * teamStrengthFactor * recentFormFactor * eloFactor * underlyingFactor,
    0.78,
    1.24,
  );

  const opponentAttackRelative = clamp(oppAttack / Math.max(avgOppAttack, 1), 0.78, 1.22);
  const ownDefenceRelative = clamp(ownDef / Math.max(avgOwnDef, 1), 0.78, 1.22);
  const opponentXg = shrinkTeamMetric(n(opponent.underlying_attack_xg_per_match), underlyingLeague.attackXg, oppMatches);
  const ownXga = shrinkTeamMetric(n(team.underlying_defence_xga_per_match), underlyingLeague.defenceXga, ownMatches);
  const opponentXgIndex = opponentXg / underlyingLeague.attackXg;
  const ownDefWeaknessIndex = ownXga / underlyingLeague.defenceXga;
  const defensiveFormFactor = clamp(Math.pow(oppForm.attackIndex / Math.max(ownForm.defenceIndex, 0.7), 0.08), 0.97, 1.03);
  const baselineAgainst = item.home ? leagueGoals.away : leagueGoals.home;

  // xGA is the centre of the defensive forecast; FDR/static ratings are supporting priors.
  const underlyingXga = baselineAgainst
    * Math.pow(opponentXgIndex, 0.48)
    * Math.pow(ownDefWeaknessIndex, 0.48);
  const staticXga = baselineAgainst
    * (fdrGoalsAgainstMap[item.difficulty] ?? 1)
    * Math.pow(opponentAttackRelative, 0.18)
    / Math.pow(ownDefenceRelative, 0.16)
    * defensiveFormFactor
    / eloFactor;
  const expectedGoalsAgainst = clamp(underlyingXga * 0.68 + staticXga * 0.32, 0.48, 2.75);
  const cleanSheetProbability = clamp(Math.exp(-expectedGoalsAgainst), 0.055, 0.62);
  const defenceFactor = clamp(leagueGoals.overall / expectedGoalsAgainst, 0.76, 1.26);
  const overallFactor = player.element_type <= 2
    ? clamp(attackFactor * 0.28 + defenceFactor * 0.72, 0.78, 1.24)
    : player.element_type === 3
      ? clamp(attackFactor * 0.92 + defenceFactor * 0.08, 0.8, 1.22)
      : attackFactor;

  return {
    event: item.fixture.event,
    label: item.label,
    fixtures: [{
      id: item.fixture.id,
      event: item.fixture.event,
      homeTeamId: item.fixture.team_h,
      awayTeamId: item.fixture.team_a,
    }],
    fdr: item.difficulty,
    overallFactor,
    fdrFactor,
    teamStrengthFactor,
    recentFormFactor,
    eloFactor,
    underlyingFactor,
    attackFactor,
    ownTeamQuality: ownAttack / Math.max(avgOwnAttack, 1),
    opponentQuality: oppDef / Math.max(avgOppDef, 1),
    ownTeamXgPerMatch: ownXg,
    opponentXgaPerMatch: oppXga,
    expectedGoalsAgainst,
    cleanSheetProbability,
  };
}

function newsAvailabilityFactor(player: FplPlayer) {
  const news = (player.news ?? "").trim().toLowerCase();
  if (!news || /^(no news|none|—|-)$/.test(news)) return 1;
  if (/(ruled out|out for|will miss|sidelined|suspended|suspension|not available|unavailable)/.test(news)) return 0.08;
  if (/(injured|injury|illness|hamstring|knock|ankle|knee|groin|back problem)/.test(news)) return 0.45;
  if (/(doubt|fitness test|late test|assess(ed|ment)?|being monitored|minor concern)/.test(news)) return 0.62;
  if (/(returned to training|back in training|passed fit|fit and available|available for selection|in contention)/.test(news)) return 1.04;
  return 0.94;
}

function playerAvailability(player: FplPlayer) {
  if (["u", "n", "s"].includes(player.status)) return 0;
  const fallbackChance = player.status === "a" ? 100 : player.status === "d" ? 65 : player.status === "i" ? 20 : 55;
  const feedChance = clamp((player.chance_of_playing_next_round ?? fallbackChance) / 100, 0, 1);
  return clamp(feedChance * newsAvailabilityFactor(player), 0, 1);
}

function futurePlayerAvailability(player: FplPlayer, gameweekOffset: number) {
  const current = playerAvailability(player);
  // Players marked unavailable/not selectable should not be assumed to recover during the horizon.
  if (["u", "n"].includes(player.status)) return 0;
  // Suspensions are zero for the next round, then recover conservatively because the public feed
  // does not expose a reliable suspension-length field for every case.
  if (player.status === "s") return gameweekOffset === 0 ? 0 : clamp(0.72 + (gameweekOffset - 1) * 0.14, 0, 1);
  if (player.status === "a") return current;
  const recoveryStep = player.status === "i" ? 0.14 : player.status === "d" ? 0.1 : 0.08;
  return clamp(current + gameweekOffset * recoveryStep, current, 1);
}

function pricePriorPpg(player: FplPlayer) {
  const price = player.now_cost / 10;
  const result = player.element_type === 1
    ? 3.0 + (price - 4) * 0.55
    : player.element_type === 2
      ? 2.8 + (price - 4) * 0.55
      : player.element_type === 3
        ? 2.45 + (price - 4.5) * 0.5
        : 2.55 + (price - 4.5) * 0.55;
  return clamp(result, 1.8, 6.4);
}

// This is only a weak calibration anchor. Current FPL points and Form are intentionally
// excluded: a one-week goal, clean sheet or bonus haul must not become a five-week forecast.
function empiricalNeutralRate(player: FplPlayer, historyInfo: HistoryBlendInfo) {
  const pricePrior = pricePriorPpg(player);
  const epNext = n(player.ep_next, pricePrior);
  const historical = historyInfo.historicalPpg ?? pricePrior;
  const historicalShare = historyInfo.historicalPpg == null ? 0 : clamp(historyInfo.influence / 0.55, 0, 1);
  const structuralPrior = historical * historicalShare + pricePrior * (1 - historicalShare);
  return clamp(structuralPrior * 0.72 + epNext * 0.10 + pricePrior * 0.18, 1.4, 7.0);
}

type MinutesEstimate = {
  availability: number;
  startProbability: number;
  cameoProbability: number;
  appearanceProbability: number;
  sixtyProbability: number;
  minutesIfStart: number;
  minutesIfStartSd: number;
  minutesIfCameo: number;
  minutesIfCameoSd: number;
  expectedMinutes: number;
  variance: number;
  p10: number;
  p50: number;
  p90: number;
  rotationRisk: number;
};

function completedTeamMatches(teamId: number, fixtures: FplFixture[]) {
  return fixtures.filter((fixture) => fixture.finished && (fixture.team_h === teamId || fixture.team_a === teamId)).length;
}

// Abramowitz-Stegun normal CDF approximation. Keeping this local avoids a
// runtime dependency on Math.erf, which is not available in every browser or
// Node version supported by the dashboard.
function normalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const absolute = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * absolute);
  const polynomial = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-absolute * absolute);
  return 0.5 * (1 + sign * polynomial);
}

function mixtureCdf(minutes: number, startProbability: number, cameoProbability: number, minutesIfStart: number, minutesIfStartSd: number, minutesIfCameo: number, minutesIfCameoSd: number) {
  if (minutes < 0) return 0;
  const noAppearance = Math.max(0, 1 - startProbability - cameoProbability);
  if (minutes === 0) return noAppearance;
  return noAppearance
    + startProbability * normalCdf((minutes - minutesIfStart) / Math.max(minutesIfStartSd, 1))
    + cameoProbability * normalCdf((minutes - minutesIfCameo) / Math.max(minutesIfCameoSd, 1));
}

function mixtureQuantile(probability: number, startProbability: number, cameoProbability: number, minutesIfStart: number, minutesIfStartSd: number, minutesIfCameo: number, minutesIfCameoSd: number) {
  if (probability <= Math.max(0, 1 - startProbability - cameoProbability)) return 0;
  let low = 0;
  let high = 90;
  for (let i = 0; i < 28; i += 1) {
    const middle = (low + high) / 2;
    if (mixtureCdf(middle, startProbability, cameoProbability, minutesIfStart, minutesIfStartSd, minutesIfCameo, minutesIfCameoSd) >= probability) high = middle;
    else low = middle;
  }
  return Math.round(high);
}

function minutesEstimate(player: FplPlayer, fixtures: FplFixture[], historyInfo: HistoryBlendInfo, availabilityOverride?: number): MinutesEstimate {
  const matches = completedTeamMatches(player.team, fixtures);
  const price = player.now_cost / 10;
  const positionFloor = player.element_type === 1 ? 0.9 : player.element_type === 2 ? 0.62 : 0.56;
  // Start probability is inferred from actual starts, historical role and a small price prior.
  // ep_next/Form are intentionally excluded so a points haul cannot secretly inflate expected minutes.
  const marketStartPrior = clamp(positionFloor + Math.max(0, price - 5) * 0.025, positionFloor, player.element_type === 1 ? 0.98 : 0.91);
  const startPrior = historyInfo.historicalStartRate == null
    ? marketStartPrior
    : clamp(historyInfo.historicalStartRate * 0.7 + marketStartPrior * 0.3, 0.25, 0.97);

  const observedStarts = Math.min(player.starts, matches);
  // Zero minutes after several team matches is strong evidence of a reserve
  // role only when there is no previous-season role information. Retain the
  // wider prior for players who have actually appeared this season.
  const unobservedReserve = historyInfo.historicalStartRate == null
    && player.minutes === 0 && player.starts === 0 && matches >= 2;
  const priorMatches = unobservedReserve ? (player.element_type === 1 ? 0.2 : 0.5) : 4;
  const healthyStartProbability = matches
    ? clamp((observedStarts + startPrior * priorMatches) / (matches + priorMatches), 0.08, 0.99)
    : startPrior;

  const availability = availabilityOverride ?? playerAvailability(player);
  const startProbability = healthyStartProbability * availability;
  const fallbackMinutes = player.element_type === 1 ? 90 : 78;
  const currentMinutesPerStart = player.starts > 0 ? clamp(player.minutes / player.starts, 48, 92) : null;
  const historyMinutes = historyInfo.historicalMinutesPerStart == null ? fallbackMinutes : clamp(historyInfo.historicalMinutesPerStart, 55, 92);
  const currentWeight = clamp(player.starts / 5, 0, 1);
  const minutesIfStart = currentMinutesPerStart == null
    ? historyMinutes
    : clamp(currentMinutesPerStart * currentWeight + historyMinutes * (1 - currentWeight), 52, 92);
  // Substitution uncertainty is wider for players with little starting
  // evidence, then narrows as observed starts establish a stable role.
  const minutesIfStartSd = clamp(15 - player.starts * 0.35, 5, 15);

  const cameoEvidence = unobservedReserve ? 0.35 : 1;
  const cameoConditional = (player.element_type === 1 ? 0.02 : player.element_type === 2 ? 0.16 : 0.24) * cameoEvidence;
  const cameoProbability = clamp((1 - startProbability) * availability * cameoConditional, 0, 0.35);
  const appearanceProbability = clamp(startProbability + cameoProbability, 0, 1);
  const minutesIfCameo = player.element_type === 1 ? 8 : 17;
  const minutesIfCameoSd = player.element_type === 1 ? 4 : 8;
  const sixtyIfStart = clamp((minutesIfStart - 55) / 12, 0.15, 1);
  const sixtyProbability = startProbability * sixtyIfStart;
  const expectedMinutes = startProbability * minutesIfStart + cameoProbability * minutesIfCameo;
  const secondMoment = startProbability * (minutesIfStartSd ** 2 + minutesIfStart ** 2)
    + cameoProbability * (minutesIfCameoSd ** 2 + minutesIfCameo ** 2);
  const variance = Math.max(0, secondMoment - expectedMinutes ** 2);

  return {
    availability,
    startProbability,
    cameoProbability,
    appearanceProbability,
    sixtyProbability,
    minutesIfStart,
    minutesIfStartSd,
    minutesIfCameo,
    minutesIfCameoSd,
    expectedMinutes,
    variance,
    p10: mixtureQuantile(0.1, startProbability, cameoProbability, minutesIfStart, minutesIfStartSd, minutesIfCameo, minutesIfCameoSd),
    p50: mixtureQuantile(0.5, startProbability, cameoProbability, minutesIfStart, minutesIfStartSd, minutesIfCameo, minutesIfCameoSd),
    p90: mixtureQuantile(0.9, startProbability, cameoProbability, minutesIfStart, minutesIfStartSd, minutesIfCameo, minutesIfCameoSd),
    rotationRisk: clamp(1 - startProbability, 0, 1),
  };
}

function positionUnderlyingPrior(player: FplPlayer) {
  if (player.element_type === 1) return { xg90: 0.005, xa90: 0.005, dc90: 0, saves90: 3.1, bonus90: 0.24, yellow90: 0.04 };
  if (player.element_type === 2) return { xg90: 0.075, xa90: 0.085, dc90: 7.2, saves90: 0, bonus90: 0.22, yellow90: 0.12 };
  if (player.element_type === 3) return { xg90: 0.22, xa90: 0.2, dc90: 6.4, saves90: 0, bonus90: 0.28, yellow90: 0.11 };
  return { xg90: 0.36, xa90: 0.14, dc90: 3.2, saves90: 0, bonus90: 0.3, yellow90: 0.1 };
}

function currentPer90(total: string | number | null | undefined, per90: string | number | null | undefined, minutes: number) {
  const reported = n(per90);
  if (reported > 0) return reported;
  const cumulative = n(total);
  return minutes > 0 && cumulative > 0 ? cumulative * 90 / minutes : 0;
}

function shrunkUnderlyingRate({
  live,
  historical,
  positional,
  minutes,
  historyInfluence,
  pseudoMinutes,
}: {
  live: number;
  historical: number | null;
  positional: number;
  minutes: number;
  historyInfluence: number;
  pseudoMinutes: number;
}) {
  const historicalShare = historical == null ? 0 : clamp(historyInfluence / 0.55, 0, 1);
  const prior = (historical ?? positional) * historicalShare + positional * (1 - historicalShare);
  if (!(live > 0)) return prior;
  const liveWeight = clamp(minutes / (minutes + pseudoMinutes), 0, 0.9);
  return live * liveWeight + prior * (1 - liveWeight);
}

function poissonTail(lambda: number, threshold: number) {
  if (lambda <= 0) return 0;
  let probability = Math.exp(-lambda);
  let cumulative = probability;
  for (let k = 1; k < threshold; k += 1) {
    probability *= lambda / k;
    cumulative += probability;
  }
  return clamp(1 - cumulative, 0, 1);
}

function expectedSavePoints(lambda: number) {
  // FPL awards one point for each complete set of three saves in a match.
  // Sum P(saves >= 3k) rather than dividing the expected save count by three.
  let points = 0;
  for (let threshold = 3; threshold <= 30; threshold += 3) {
    points += poissonTail(lambda, threshold);
  }
  return points;
}

function expectedConcededPenalty(lambda: number) {
  if (lambda <= 0) return 0;
  let probability = Math.exp(-lambda);
  let expected = 0;
  for (let goals = 0; goals <= 10; goals += 1) {
    if (goals > 0) probability *= lambda / goals;
    if (goals >= 2) expected += Math.floor(goals / 2) * probability;
  }
  return -expected;
}

function projectionDataQuality(player: FplPlayer, historyInfo: HistoryBlendInfo, fixturesCovered: number, teams: FplTeam[]) {
  let score = 0;
  score += clamp(player.minutes / 900, 0, 1) * 30;
  score += clamp(historyInfo.seasons / 3, 0, 1) * 20;
  if (n(player.expected_goal_involvements_per_90) > 0 || historyInfo.historicalXgi90 != null) score += 13;
  if (player.chance_of_playing_next_round != null || player.status === "a") score += 6;
  if (fixturesCovered > 0) score += clamp(fixturesCovered / 5, 0, 1) * 11;
  const team = teams.find((row) => row.id === player.team);
  if (team?.strength_attack_home && team?.strength_defence_home) score += 10;
  if (n(team?.elo) > 1200) score += 5;
  if (n(player.ep_next) > 0) score += 5;
  return clamp(Math.round(score), 0, 100);
}

function confidenceFromQuality(quality: number): ModelConfidence {
  if (quality >= 75) return "High";
  if (quality >= 50) return "Medium";
  return "Low";
}

function zeroComponents(): ProjectionComponents {
  return { appearance: 0, attack: 0, cleanSheet: 0, saves: 0, defensiveContribution: 0, bonus: 0, discipline: 0, empiricalAnchor: 0, calibrationAdjustment: 0 };
}

export function projectPlayer(player: FplPlayer, fixtures: FplFixture[], teams: FplTeam[], horizon = 5, history?: HistoricalProfileMap, eventIdsOverride?: number[]): Projection {
  const historyInfo = historyBlendInfo(player, history);
  const eventIds = eventIdsOverride ?? [...new Set(fixtures
    .filter((fixture) => !fixture.finished && fixture.event != null)
    .map((fixture) => fixture.event as number))]
    .sort((a, b) => a - b)
    .slice(0, horizon);
  const upcoming = upcomingPlayerFixtures(player, fixtures, teams, horizon, eventIds);
  const contexts = upcoming.map((item) => fixtureContext(player, item, teams, fixtures));

  const empiricalRate = empiricalNeutralRate(player, historyInfo);
  const priors = positionUnderlyingPrior(player);
  const liveXg90 = currentPer90(player.expected_goals, player.expected_goals_per_90, player.minutes);
  const liveXa90 = currentPer90(player.expected_assists, player.expected_assists_per_90, player.minutes);
  const historicalXgFallback = historyInfo.historicalXg90 ?? (historyInfo.historicalXgi90 != null ? historyInfo.historicalXgi90 * 0.56 : null);
  const historicalXaFallback = historyInfo.historicalXa90 ?? (historyInfo.historicalXgi90 != null ? historyInfo.historicalXgi90 * 0.44 : null);
  const xg90 = shrunkUnderlyingRate({ live: liveXg90, historical: historicalXgFallback, positional: priors.xg90, minutes: player.minutes, historyInfluence: historyInfo.influence, pseudoMinutes: 720 });
  const xa90 = shrunkUnderlyingRate({ live: liveXa90, historical: historicalXaFallback, positional: priors.xa90, minutes: player.minutes, historyInfluence: historyInfo.influence, pseudoMinutes: 720 });
  const dc90 = shrunkUnderlyingRate({ live: n(player.defensive_contribution_per_90), historical: historyInfo.historicalDc90, positional: priors.dc90, minutes: player.minutes, historyInfluence: historyInfo.influence, pseudoMinutes: 540 });
  const saves90 = shrunkUnderlyingRate({ live: n(player.saves_per_90), historical: historyInfo.historicalSaves90, positional: priors.saves90, minutes: player.minutes, historyInfluence: historyInfo.influence, pseudoMinutes: 540 });
  const liveBonus90 = player.minutes > 0 ? player.bonus * 90 / player.minutes : 0;
  const bonus90 = clamp(shrunkUnderlyingRate({ live: liveBonus90, historical: historyInfo.historicalBonus90, positional: priors.bonus90, minutes: player.minutes, historyInfluence: historyInfo.influence, pseudoMinutes: 1800 }), 0, 1.0);
  const liveYellow90 = player.minutes > 0 ? n(player.yellow_cards) * 90 / player.minutes : 0;
  const yellow90 = clamp(shrunkUnderlyingRate({ live: liveYellow90, historical: historyInfo.historicalYellow90, positional: priors.yellow90, minutes: player.minutes, historyInfluence: historyInfo.influence, pseudoMinutes: 900 }), 0, 0.45);

  const componentReliability = clamp((player.minutes / 1200) * 0.6 + (historyInfo.seasons / 3) * 0.4, 0, 1);
  const componentWeight = 0.92 + componentReliability * 0.06;
  const fixtureMeans: number[] = [];
  const fixtureLabels: string[] = [];
  const representativeContexts: FixtureContext[] = [];
  const appearanceProbabilities: number[] = [];
  const minutesByFixture: MinutesDistribution[] = [];
  const components = zeroComponents();
  const goalPoints = player.element_type === 1 ? 10 : player.element_type === 2 ? 6 : player.element_type === 3 ? 5 : 4;
  const cleanSheetPoints = player.element_type <= 2 ? 4 : player.element_type === 3 ? 1 : 0;

  eventIds.forEach((eventId, index) => {
    const eventContexts = contexts.filter((context) => context.event === eventId);
    if (!eventContexts.length) {
      fixtureMeans.push(0);
      fixtureLabels.push("BLANK");
      appearanceProbabilities.push(0);
      minutesByFixture.push({
        expected: 0,
        p10: 0,
        p50: 0,
        p90: 0,
        variance: 0,
        startProbability: 0,
        cameoProbability: 0,
        appearanceProbability: 0,
        minutesIfStart: 0,
        minutesIfStartSd: 0,
        minutesIfCameo: 0,
        minutesIfCameoSd: 0,
        rotationRisk: 1,
      });
      return;
    }

    const futureAvailability = futurePlayerAvailability(player, index);
    const minutes = minutesEstimate(player, fixtures, historyInfo, futureAvailability);
    let eventMean = 0;
    let eventAppearance = 0;

    eventContexts.forEach((context) => {
      const minutesFraction = minutes.expectedMinutes / 90;
      const appearancePoints = minutes.appearanceProbability + minutes.sixtyProbability;
      const attackPoints = (xg90 * context.attackFactor * minutesFraction * goalPoints)
        + (xa90 * context.attackFactor * minutesFraction * 3);
      const cleanSheetPointsExpected = cleanSheetPoints * context.cleanSheetProbability * minutes.sixtyProbability;
      const savePoints = player.element_type === 1
        ? minutes.startProbability * expectedSavePoints(saves90 * minutes.minutesIfStart / 90)
          + minutes.cameoProbability * expectedSavePoints(saves90 * minutes.minutesIfCameo / 90)
        : 0;
      const threshold = player.element_type === 2 ? 10 : 12;
      const startDcLambda = dc90 * (minutes.minutesIfStart / 90);
      const cameoDcLambda = dc90 * (minutes.minutesIfCameo / 90);
      const defensiveContribution = player.element_type === 1 ? 0
        : 2 * (minutes.startProbability * poissonTail(startDcLambda, threshold) + minutes.cameoProbability * poissonTail(cameoDcLambda, threshold));
      const concededPenalty = player.element_type <= 2
        ? expectedConcededPenalty(context.expectedGoalsAgainst * minutesFraction)
        : 0;
      const bonusPoints = bonus90 * minutesFraction * clamp(0.92 + context.attackFactor * 0.08, 0.9, 1.08);
      const discipline = -yellow90 * minutesFraction;
      const componentEstimate = Math.max(0, appearancePoints + attackPoints + cleanSheetPointsExpected + savePoints + defensiveContribution + concededPenalty + bonusPoints + discipline);
      const empiricalEstimate = empiricalRate * context.overallFactor * clamp(minutes.expectedMinutes / 78, 0, 1.12);
      const expectedCap = player.element_type === 1 ? 7.6 : player.element_type === 2 ? 8.4 : player.element_type === 3 ? 10.2 : 10.8;
      const matchMean = clamp(componentEstimate * componentWeight + empiricalEstimate * (1 - componentWeight), 0, expectedCap);

      eventMean += matchMean;
      eventAppearance = 1 - (1 - eventAppearance) * (1 - minutes.appearanceProbability);
      components.appearance += appearancePoints * componentWeight;
      components.attack += attackPoints * componentWeight;
      components.cleanSheet += (cleanSheetPointsExpected + concededPenalty) * componentWeight;
      components.saves += savePoints * componentWeight;
      components.defensiveContribution += defensiveContribution * componentWeight;
      components.bonus += bonusPoints * componentWeight;
      components.discipline += discipline * componentWeight;
      components.empiricalAnchor += empiricalEstimate * (1 - componentWeight);
    });

    fixtureMeans.push(eventMean);
    fixtureLabels.push(eventContexts.map((context) => context.label).join(" + "));
    appearanceProbabilities.push(clamp(eventAppearance, 0, 1));
    minutesByFixture.push({
      expected: minutes.expectedMinutes,
      p10: minutes.p10,
      p50: minutes.p50,
      p90: minutes.p90,
      variance: minutes.variance,
      startProbability: minutes.startProbability,
      cameoProbability: minutes.cameoProbability,
      appearanceProbability: minutes.appearanceProbability,
      minutesIfStart: minutes.minutesIfStart,
      minutesIfStartSd: minutes.minutesIfStartSd,
      minutesIfCameo: minutes.minutesIfCameo,
      minutesIfCameoSd: minutes.minutesIfCameoSd,
      rotationRisk: minutes.rotationRisk,
    });
    representativeContexts.push(eventContexts.length === 1 ? eventContexts[0] : {
      ...eventContexts[0],
      label: eventContexts.map((context) => context.label).join(" + "),
      fixtures: eventContexts.flatMap((context) => context.fixtures),
      overallFactor: sum(eventContexts.map((context) => context.overallFactor)) / eventContexts.length,
      fdrFactor: sum(eventContexts.map((context) => context.fdrFactor)) / eventContexts.length,
      teamStrengthFactor: sum(eventContexts.map((context) => context.teamStrengthFactor)) / eventContexts.length,
      recentFormFactor: sum(eventContexts.map((context) => context.recentFormFactor)) / eventContexts.length,
      eloFactor: sum(eventContexts.map((context) => context.eloFactor)) / eventContexts.length,
      underlyingFactor: sum(eventContexts.map((context) => context.underlyingFactor)) / eventContexts.length,
      attackFactor: sum(eventContexts.map((context) => context.attackFactor)) / eventContexts.length,
      ownTeamXgPerMatch: sum(eventContexts.map((context) => context.ownTeamXgPerMatch)) / eventContexts.length,
      opponentXgaPerMatch: sum(eventContexts.map((context) => context.opponentXgaPerMatch)) / eventContexts.length,
      expectedGoalsAgainst: sum(eventContexts.map((context) => context.expectedGoalsAgainst)) / eventContexts.length,
      cleanSheetProbability: sum(eventContexts.map((context) => context.cleanSheetProbability)) / eventContexts.length,
    });
  });

  while (fixtureMeans.length < horizon) {
    fixtureMeans.push(0);
    fixtureLabels.push("BLANK");
    appearanceProbabilities.push(0);
    minutesByFixture.push({
      expected: 0,
      p10: 0,
      p50: 0,
      p90: 0,
      variance: 0,
      startProbability: 0,
      cameoProbability: 0,
      appearanceProbability: 0,
      minutesIfStart: 0,
      minutesIfStartSd: 0,
      minutesIfCameo: 0,
      minutesIfCameoSd: 0,
      rotationRisk: 1,
    });
  }

  const expected = sum(fixtureMeans);
  const roleVolatility = player.element_type === 1 ? 0.78 : player.element_type === 2 ? 0.9 : player.element_type === 3 ? 1.05 : 1.12;
  const variance = fixtureMeans.reduce((total, mean, index) => {
    if (mean <= 0) return total;
    const minutes = minutesByFixture[index];
    const pointsPerMinute = mean / Math.max(minutes?.expected ?? 1, 1);
    const minutesVariance = pointsPerMinute ** 2 * (minutes?.variance ?? 0);
    // Conditional scoring still has event variance, but the larger minutes
    // mixture now carries the rotation/substitution contribution explicitly.
    const scoringSd = (1.7 + mean * 0.64) * roleVolatility * 0.78;
    return total + minutesVariance + scoringSd * scoringSd;
  }, 0);
  const volatility = Math.sqrt(variance);
  const cv = volatility / Math.max(expected, 1);
  const risk: Projection["risk"] = cv < 0.46 ? "Low" : cv < 0.63 ? "Medium" : "High";
  const dataQuality = projectionDataQuality(player, historyInfo, representativeContexts.length, teams);
  const minutesExpected = sum(minutesByFixture.map((minutes) => minutes.expected));
  const minutesVariance = sum(minutesByFixture.map((minutes) => minutes.variance));
  const minutesP10 = sum(minutesByFixture.map((minutes) => minutes.p10));
  const minutesP50 = sum(minutesByFixture.map((minutes) => minutes.p50));
  const minutesP90 = sum(minutesByFixture.map((minutes) => minutes.p90));
  const rotationRisk = minutesByFixture.length
    ? average(minutesByFixture.map((minutes) => minutes.rotationRisk))
    : 1;

  return {
    playerId: player.id,
    horizon,
    expected,
    volatility,
    fixtureMeans,
    fixtureLabels,
    fixtureContexts: representativeContexts,
    appearanceProbabilities,
    risk,
    dataQuality,
    confidence: confidenceFromQuality(dataQuality),
    components,
    minutes: {
      expected: minutesExpected,
      p10: minutesP10,
      p50: minutesP50,
      p90: minutesP90,
      variance: minutesVariance,
      rotationRisk,
    },
    minutesByFixture,
  };
}

function hashSeed(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalRandom(random: () => number) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function boundedNormal(mean: number, standardDeviation: number, random: () => number) {
  return clamp(mean + normalRandom(random) * standardDeviation, 0, 90);
}

function simulateGameweek(mean: number, minutes: MinutesDistribution, player: FplPlayer, random: () => number) {
  if (mean <= 0 || minutes.appearanceProbability <= 0) return 0;
  const state = random();
  const starterCutoff = minutes.startProbability;
  const cameoCutoff = starterCutoff + minutes.cameoProbability;
  const sampledMinutes = state < starterCutoff
    ? boundedNormal(minutes.minutesIfStart, minutes.minutesIfStartSd, random)
    : state < cameoCutoff
      ? boundedNormal(minutes.minutesIfCameo, minutes.minutesIfCameoSd, random)
      : 0;
  if (sampledMinutes <= 0) return 0;

  // The fixture mean already includes the expected minutes mixture. Draw
  // state first, then scale conditional scoring to the sampled minutes before
  // applying the existing event-scoring noise.
  const conditionalMean = mean * sampledMinutes / Math.max(minutes.expected, 1);
  const cv = player.element_type === 1 ? 0.58 : player.element_type === 2 ? 0.76 : player.element_type === 3 ? 0.9 : 0.96;
  const sigmaSquared = Math.log(1 + cv * cv);
  const mu = Math.log(Math.max(conditionalMean, 0.15)) - sigmaSquared / 2;
  const sampled = Math.exp(mu + Math.sqrt(sigmaSquared) * normalRandom(random));
  return clamp(Math.round(sampled), 0, 26);
}

function percentile(sorted: number[], p: number) {
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Deterministic player-level Monte Carlo summary. The seeded stream keeps
 * rankings stable between renders while using the same appearance and
 * fixture scoring assumptions as transfer simulations.
 */
export function simulateProjection(
  player: FplPlayer,
  projection: Projection,
  simulations = 768,
): ProjectionDistribution {
  const count = Math.max(128, Math.floor(simulations));
  const seed = hashSeed([
    MODEL_VERSION,
    "player-distribution",
    player.id,
    projection.horizon,
    projection.fixtureMeans.map((value) => value.toFixed(3)).join(","),
    projection.appearanceProbabilities.map((value) => value.toFixed(3)).join(","),
    projection.minutesByFixture.map((value) => `${value.startProbability.toFixed(3)}:${value.cameoProbability.toFixed(3)}:${value.expected.toFixed(1)}`).join(","),
  ].join("|"));
  const random = seededRandom(seed);
  const samples = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    let total = 0;
    for (let gw = 0; gw < projection.horizon; gw += 1) {
      total += simulateGameweek(
        projection.fixtureMeans[gw] ?? 0,
        projection.minutesByFixture[gw] ?? {
          expected: 0,
          p10: 0,
          p50: 0,
          p90: 0,
          variance: 0,
          startProbability: projection.appearanceProbabilities[gw] ?? 0,
          cameoProbability: 0,
          appearanceProbability: projection.appearanceProbabilities[gw] ?? 0,
          minutesIfStart: 0,
          minutesIfStartSd: 0,
          minutesIfCameo: 0,
          minutesIfCameoSd: 0,
          rotationRisk: 1,
        },
        player,
        random,
      );
    }
    samples[index] = total;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  const standardDeviation = Math.sqrt(variance);
  const bandCount = (predicate: (value: number) => boolean) =>
    (samples.filter(predicate).length / samples.length) * 100;

  return {
    p10: percentile(sorted, 0.1),
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    standardDeviation,
    sharpe: mean / Math.max(standardDeviation, 0.35),
    bands: {
      bust: bandCount((value) => value <= 2),
      floor: bandCount((value) => value >= 3 && value <= 5),
      middle: bandCount((value) => value >= 6 && value <= 9),
      haul: bandCount((value) => value >= 10),
    },
    simulations: samples.length,
  };
}

export function simulateTransfer(
  outgoing: FplPlayer,
  incoming: FplPlayer,
  fixtures: FplFixture[],
  teams: FplTeam[],
  horizon = 5,
  simulations = 10000,
  hitCost = 0,
  history?: HistoricalProfileMap,
): TransferResult {
  const outProjection = projectPlayer(outgoing, fixtures, teams, horizon, history);
  const inProjection = projectPlayer(incoming, fixtures, teams, horizon, history);
  const seed = hashSeed([
    MODEL_VERSION,
    outgoing.id,
    incoming.id,
    horizon,
    simulations,
    hitCost,
    outProjection.fixtureMeans.map((value) => value.toFixed(3)).join(","),
    inProjection.fixtureMeans.map((value) => value.toFixed(3)).join(","),
    outProjection.minutesByFixture.map((value) => `${value.startProbability.toFixed(3)}:${value.cameoProbability.toFixed(3)}:${value.expected.toFixed(1)}`).join(","),
    inProjection.minutesByFixture.map((value) => `${value.startProbability.toFixed(3)}:${value.cameoProbability.toFixed(3)}:${value.expected.toFixed(1)}`).join(","),
  ].join("|"));
  const random = seededRandom(seed);
  const diffs = new Array<number>(simulations);

  for (let i = 0; i < simulations; i += 1) {
    let hold = 0;
    let transfer = -hitCost;
    for (let gw = 0; gw < horizon; gw += 1) {
      hold += simulateGameweek(outProjection.fixtureMeans[gw] ?? 0, outProjection.minutesByFixture[gw], outgoing, random);
      transfer += simulateGameweek(inProjection.fixtureMeans[gw] ?? 0, inProjection.minutesByFixture[gw], incoming, random);
    }
    diffs[i] = transfer - hold;
  }

  const sorted = [...diffs].sort((a, b) => a - b);
  const mean = sum(diffs) / diffs.length;
  const variance = diffs.reduce((total, value) => total + Math.pow(value - mean, 2), 0) / diffs.length;
  return {
    expectedGain: mean,
    successProbability: (diffs.filter((value) => value > 0).length / diffs.length) * 100,
    downsideProbability: (diffs.filter((value) => value <= -5).length / diffs.length) * 100,
    p10: percentile(sorted, 0.1),
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    volatility: Math.sqrt(variance),
    samples: diffs,
  };
}

export function histogram(samples: number[], bins = 28) {
  if (!samples.length) return [];
  const min = Math.floor(Math.min(...samples));
  const max = Math.ceil(Math.max(...samples));
  const width = Math.max((max - min) / bins, 1);
  const output = Array.from({ length: bins }, (_, index) => ({ x: min + width * (index + 0.5), count: 0 }));
  samples.forEach((sample) => {
    const index = clamp(Math.floor((sample - min) / width), 0, bins - 1);
    output[index].count += 1;
  });
  return output;
}

export type Recommendation = {
  outgoingId: number;
  incomingId: number;
  budget: number;
  rawExpectedGain: number;
  transferCost: number;
  expectedGain: number;
  outgoingExpected: number;
  incomingExpected: number;
  outgoingRisk: Projection["risk"];
  incomingRisk: Projection["risk"];
  score: number;
  fixtureEdge: number;
  dataQuality: number;
  confidence: ModelConfidence;
  reasons: string[];
};

type RecommendationOptions = {
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
};

function recommendationConfidence(edge: number, outgoing: Projection, incoming: Projection): ModelConfidence {
  const quality = (outgoing.dataQuality + incoming.dataQuality) / 2;
  const combinedRisk = Math.sqrt(outgoing.volatility ** 2 + incoming.volatility ** 2);
  const signal = edge / Math.max(1.5, combinedRisk * 0.22);
  if (quality >= 72 && edge >= 2.5 && signal >= 0.75) return "High";
  if (quality >= 48 && edge >= 0.9 && signal >= 0.25) return "Medium";
  return "Low";
}

function legalClubTransfer(incoming: FplPlayer, outgoing: FplPlayer, squad: FplPlayer[]) {
  const remainingAtClub = squad.filter((player) => player.id !== outgoing.id && player.team === incoming.team).length;
  return remainingAtClub < 3;
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
}: RecommendationOptions): Recommendation[] {
  const sale = sellingPrice ?? outgoing.now_cost;
  const budget = sale + Math.max(bank, 0);
  const squadIds = new Set(squad.map((player) => player.id));
  const outProjection = projectPlayer(outgoing, fixtures, teams, horizon, history);
  const transferCost = freeTransfers > 0 ? 0 : 4;

  return players
    .filter((candidate) => candidate.id !== outgoing.id)
    .filter((candidate) => candidate.element_type === outgoing.element_type)
    .filter((candidate) => !squadIds.has(candidate.id))
    .filter((candidate) => candidate.now_cost <= budget)
    .filter((candidate) => legalClubTransfer(candidate, outgoing, squad))
    .filter((candidate) => !["u", "s", "n"].includes(candidate.status))
    .filter((candidate) => playerAvailability(candidate) >= 0.5)
    .map((candidate) => {
      const incomingProjection = projectPlayer(candidate, fixtures, teams, horizon, history);
      const rawExpectedGain = incomingProjection.expected - outProjection.expected;
      const expectedGain = rawExpectedGain - transferCost;
      const riskIncrease = Math.max(0, incomingProjection.volatility - outProjection.volatility);
      const availability = playerAvailability(candidate);
      const priceHeadroom = Math.max(0, budget - candidate.now_cost) / 10;
      const incomingFixtureAvg = incomingProjection.fixtureContexts.length
        ? sum(incomingProjection.fixtureContexts.map((context) => context.overallFactor)) / incomingProjection.fixtureContexts.length
        : 1;
      const outgoingFixtureAvg = outProjection.fixtureContexts.length
        ? sum(outProjection.fixtureContexts.map((context) => context.overallFactor)) / outProjection.fixtureContexts.length
        : 1;
      const fixtureEdge = incomingFixtureAvg - outgoingFixtureAvg;
      const rollValue = freeTransfers === 1 ? 0.45 : freeTransfers === 2 ? 0.18 : freeTransfers >= 5 ? -0.1 : 0.04;
      const quality = (outProjection.dataQuality + incomingProjection.dataQuality) / 2;
      const combinedVolatility = Math.sqrt(outProjection.volatility ** 2 + incomingProjection.volatility ** 2);
      const signalToNoise = expectedGain / Math.max(combinedVolatility, 1.5);
      const uncertaintyPenalty = riskIncrease * 0.08 + Math.max(0, 55 - quality) * 0.008;
      const score = expectedGain + signalToNoise * 0.35 - uncertaintyPenalty - rollValue + (availability - 0.85) * 0.35 + Math.min(priceHeadroom, 1.5) * 0.01;
      const reasons: string[] = [];

      if (transferCost > 0) reasons.push(`Includes the -4 hit; raw projection edge is +${rawExpectedGain.toFixed(1)} points`);
      else if (freeTransfers >= 5) reasons.push("You are at the five-transfer bank cap, so rolling has less option value");
      else if (freeTransfers === 1 && expectedGain < 2) reasons.push("The edge is modest, so banking the transfer remains a real alternative");
      if (expectedGain >= 2) reasons.push(`Projects ${expectedGain.toFixed(1)} net points more over ${horizon} GWs`);
      else if (expectedGain > 0) reasons.push(`Adds ${expectedGain.toFixed(1)} net projected points over ${horizon} GWs`);
      else reasons.push("Ranks highest among the legal options, but does not beat the hold on net expected value");
      if (fixtureEdge >= 0.04) reasons.push("The underlying matchup is stronger after team xG/xGA, opponent quality, home/away and FDR are included");
      else if (fixtureEdge <= -0.04 && expectedGain > 0) reasons.push("Still projects ahead despite the tougher xG/xGA-adjusted schedule");
      if (incomingProjection.risk === "Low" && outProjection.risk !== "Low") reasons.push("Reduces modelled outcome risk");
      else if (incomingProjection.volatility + 0.3 < outProjection.volatility) reasons.push("Has a tighter projected outcome range");
      if (availability >= 0.95) reasons.push("Carries a strong current availability signal");
      if (quality >= 70) reasons.push("Both sides of the comparison have strong model data coverage");

      return {
        outgoingId: outgoing.id,
        incomingId: candidate.id,
        budget,
        rawExpectedGain,
        transferCost,
        expectedGain,
        outgoingExpected: outProjection.expected,
        incomingExpected: incomingProjection.expected,
        outgoingRisk: outProjection.risk,
        incomingRisk: incomingProjection.risk,
        score,
        fixtureEdge,
        dataQuality: Math.round(quality),
        confidence: recommendationConfidence(expectedGain, outProjection, incomingProjection),
        reasons: reasons.slice(0, 3),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function recommendTeamTransfer({
  players,
  squad,
  fixtures,
  teams,
  bank,
  sellingPrices = new Map<number, number>(),
  horizon = 5,
  history,
  freeTransfers = 1,
}: {
  players: FplPlayer[];
  squad: FplPlayer[];
  fixtures: FplFixture[];
  teams: FplTeam[];
  bank: number;
  sellingPrices?: Map<number, number>;
  horizon?: number;
  history?: HistoricalProfileMap;
  freeTransfers?: number;
}): Recommendation | null {
  if (!players.length || !squad.length) return null;

  const candidates = squad.flatMap((outgoing) => recommendReplacements({
    players,
    squad,
    fixtures,
    teams,
    outgoing,
    bank,
    sellingPrice: sellingPrices.get(outgoing.id),
    horizon,
    limit: 1,
    history,
    freeTransfers,
  }));

  if (!candidates.length) return null;
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  const minimumEdge = freeTransfers === 0 ? 0.9 : freeTransfers >= 5 ? 0.3 : freeTransfers >= 2 ? 0.55 : 0.9;
  const minimumScore = freeTransfers === 0 ? 0.35 : freeTransfers >= 5 ? 0.05 : freeTransfers >= 2 ? 0.2 : 0.4;
  return best.expectedGain > minimumEdge && best.score > minimumScore ? best : null;
}

export type ChipKey = "wildcard" | "freehit" | "bboost" | "3xc";
export type ChipAdvice = {
  key: ChipKey;
  label: string;
  status: "PLAY" | "CONSIDER" | "HOLD" | "USED" | "UNAVAILABLE";
  targetGw: number | null;
  score: number;
  headline: string;
  reason: string;
};

const CHIP_LABELS: Record<ChipKey, string> = {
  wildcard: "Wildcard",
  freehit: "Free Hit",
  bboost: "Bench Boost",
  "3xc": "Triple Captain",
};

function normalizeChipName(name: string): ChipKey | null {
  const normalized = name.toLowerCase().replace(/[-_\s]/g, "");
  if (normalized.includes("wildcard")) return "wildcard";
  if (normalized.includes("freehit")) return "freehit";
  if (normalized.includes("bboost") || normalized.includes("benchboost")) return "bboost";
  if (normalized.includes("3xc") || normalized.includes("triplecaptain")) return "3xc";
  return null;
}

function projectedEventPoints(player: FplPlayer, eventId: number, fixtures: FplFixture[], teams: FplTeam[], history?: HistoricalProfileMap) {
  const eventFixtures = fixtures.filter((fixture) => !fixture.finished && fixture.event === eventId && (fixture.team_h === player.team || fixture.team_a === player.team));
  if (!eventFixtures.length) return 0;
  return projectPlayer(player, fixtures, teams, 1, history, [eventId]).expected;
}

function upcomingEvents(events: FplEvent[]) {
  const next = events.find((event) => event.is_next)?.id;
  if (next) return next;
  const current = events.find((event) => event.is_current)?.id;
  return current ? Math.min(current + 1, 38) : 1;
}

export function assessChips({
  players,
  squad,
  starters,
  bench,
  fixtures,
  teams,
  events,
  history,
  chipsUsed,
  freeTransfers,
}: {
  players: FplPlayer[];
  squad: FplPlayer[];
  starters: FplPlayer[];
  bench: FplPlayer[];
  fixtures: FplFixture[];
  teams: FplTeam[];
  events: FplEvent[];
  history?: HistoricalProfileMap;
  chipsUsed: UsedChip[];
  freeTransfers: number;
}): ChipAdvice[] {
  if (!squad.length || !events.length) return [];

  const nextGw = upcomingEvents(events);
  const halfStart = nextGw <= 19 ? 1 : 20;
  const halfEnd = nextGw <= 19 ? 19 : 38;
  const candidateGws = Array.from({ length: Math.min(6, halfEnd - nextGw + 1) }, (_, index) => nextGw + index);
  const usedThisHalf = new Set<ChipKey>();
  chipsUsed.forEach((chip) => {
    const key = normalizeChipName(chip.name);
    if (key && chip.event >= halfStart && chip.event <= halfEnd) usedThisHalf.add(key);
  });

  const markUsed = (key: ChipKey): ChipAdvice => ({
    key,
    label: CHIP_LABELS[key],
    status: "USED",
    targetGw: null,
    score: 0,
    headline: "Already used this half",
    reason: `Your ${CHIP_LABELS[key]} for this half of the season has already been played.`,
  });

  const expiryUrgency = halfEnd - nextGw <= 2 ? 1 : 0;
  const advice: ChipAdvice[] = [];

  if (usedThisHalf.has("wildcard")) advice.push(markUsed("wildcard"));
  else if (nextGw === 1) {
    advice.push({ key: "wildcard", label: CHIP_LABELS.wildcard, status: "UNAVAILABLE", targetGw: null, score: 0, headline: "Not available in Gameweek 1", reason: "Wildcard cannot be activated for the opening Gameweek." });
  } else {
    const unavailable = squad.filter((player) => playerAvailability(player) < 0.75).length;
    const weak = squad.filter((player) => projectPlayer(player, fixtures, teams, 5, history).expected < (player.element_type === 1 ? 12 : player.element_type === 2 ? 13 : 15)).length;
    const repairLoad = unavailable * 1.55 + Math.min(weak, 6) * 0.5 - Math.min(freeTransfers, 5) * 0.45 + expiryUrgency * 1.2;
    const status: ChipAdvice["status"] = repairLoad >= 5.4 ? "PLAY" : repairLoad >= 3.6 ? "CONSIDER" : "HOLD";
    advice.push({
      key: "wildcard",
      label: CHIP_LABELS.wildcard,
      status,
      targetGw: status === "HOLD" ? null : nextGw,
      score: repairLoad,
      headline: status === "PLAY" ? "Squad repair pressure is high" : status === "CONSIDER" ? "A restructure is becoming viable" : "Keep the reset in reserve",
      reason: `${unavailable} availability concern${unavailable === 1 ? "" : "s"}, ${weak} weak five-GW projection${weak === 1 ? "" : "s"}, and ${freeTransfers} free transfer${freeTransfers === 1 ? "" : "s"} available.`,
    });
  }

  if (usedThisHalf.has("freehit")) advice.push(markUsed("freehit"));
  else if (nextGw === 1) {
    advice.push({ key: "freehit", label: CHIP_LABELS.freehit, status: "UNAVAILABLE", targetGw: null, score: 0, headline: "Not available in Gameweek 1", reason: "Free Hit cannot be played in the opening Gameweek." });
  } else {
    const priorFreeHit = chipsUsed.filter((chip) => normalizeChipName(chip.name) === "freehit").sort((a, b) => b.event - a.event)[0];
    const scans = candidateGws.map((gw) => {
      const blank = starters.filter((player) => projectedEventPoints(player, gw, fixtures, teams, history) === 0).length;
      const unavailable = starters.filter((player) => playerAvailability(player) < 0.75).length;
      const total = starters.reduce((total, player) => total + projectedEventPoints(player, gw, fixtures, teams, history), 0);
      const pressure = blank * 2.5 + unavailable * 0.75 + Math.max(0, 47 - total) * 0.08 - Math.min(freeTransfers, 5) * 0.35;
      return { gw, blank, total, pressure };
    }).sort((a, b) => b.pressure - a.pressure);
    const best = scans[0];
    const consecutiveBlocked = Boolean(priorFreeHit && priorFreeHit.event === best.gw - 1);
    const status: ChipAdvice["status"] = consecutiveBlocked ? "UNAVAILABLE" : best.pressure >= 7 ? "PLAY" : best.pressure >= 4.5 || expiryUrgency ? "CONSIDER" : "HOLD";
    advice.push({
      key: "freehit",
      label: CHIP_LABELS.freehit,
      status,
      targetGw: status === "HOLD" || status === "UNAVAILABLE" ? null : best.gw,
      score: best.pressure,
      headline: consecutiveBlocked ? "Consecutive Free Hits are blocked" : status === "PLAY" ? `GW${best.gw} creates major squad pressure` : status === "CONSIDER" ? `GW${best.gw} is the strongest window` : "No major blank-week pressure yet",
      reason: `${best.blank} current starter${best.blank === 1 ? "" : "s"} blank in the modelled GW and the XI projects ${best.total.toFixed(1)} points before transfers.`,
    });
  }

  if (usedThisHalf.has("bboost")) advice.push(markUsed("bboost"));
  else {
    const scans = candidateGws.map((gw) => {
      const points = bench.reduce((total, player) => total + projectedEventPoints(player, gw, fixtures, teams, history), 0);
      const active = bench.filter((player) => projectedEventPoints(player, gw, fixtures, teams, history) > 1).length;
      return { gw, points, active };
    }).sort((a, b) => b.points - a.points);
    const best = scans[0];
    const score = best.points + best.active * 0.55 + expiryUrgency;
    const status: ChipAdvice["status"] = best.active === 4 && best.points >= 16 ? "PLAY" : best.active >= 3 && best.points >= 11.5 ? "CONSIDER" : expiryUrgency ? "CONSIDER" : "HOLD";
    advice.push({
      key: "bboost",
      label: CHIP_LABELS.bboost,
      status,
      targetGw: status === "HOLD" ? null : best.gw,
      score,
      headline: status === "PLAY" ? `Bench projects strongly in GW${best.gw}` : status === "CONSIDER" ? `GW${best.gw} is your best near-term bench window` : "Bench value is not high enough yet",
      reason: `Current bench projects ${best.points.toFixed(1)} points with ${best.active}/4 players carrying a usable fixture projection.`,
    });
  }

  if (usedThisHalf.has("3xc")) advice.push(markUsed("3xc"));
  else {
    const scans = candidateGws.flatMap((gw) => squad.map((player) => ({
      gw,
      player,
      points: projectedEventPoints(player, gw, fixtures, teams, history),
      fixtures: fixtures.filter((fixture) => !fixture.finished && fixture.event === gw && (fixture.team_h === player.team || fixture.team_a === player.team)).length,
      quality: projectPlayer(player, fixtures, teams, 1, history, [gw]).dataQuality,
    }))).sort((a, b) => b.points - a.points);
    const best = scans[0];
    const score = best.points + (best.fixtures > 1 ? 2.5 : 0) + expiryUrgency + (best.quality >= 70 ? 0.4 : 0);
    const status: ChipAdvice["status"] = best.fixtures > 1 && best.points >= 9.5 && best.quality >= 50
      ? "PLAY"
      : best.points >= 8.2 || (expiryUrgency && best.points >= 7.2)
        ? "CONSIDER"
        : "HOLD";
    advice.push({
      key: "3xc",
      label: CHIP_LABELS["3xc"],
      status,
      targetGw: status === "HOLD" ? null : best.gw,
      score,
      headline: status === "PLAY" ? `${best.player.web_name} gives a premium Double-GW captain window` : status === "CONSIDER" ? `Watch ${best.player.web_name} in GW${best.gw}` : "No elite captain window yet",
      reason: `${best.player.web_name} projects ${best.points.toFixed(1)} points in GW${best.gw}${best.fixtures > 1 ? ` across ${best.fixtures} fixtures` : ""}.`,
    });
  }

  return advice;
}
