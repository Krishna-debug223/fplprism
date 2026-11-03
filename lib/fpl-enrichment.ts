import type { FplFixture, FplPlayer, FplTeam } from "./types";
import { hasCompletedScore } from "./fpl-fixture-status";

const numberValue = (value: string | number | null | undefined, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function enrichUnderlyingTeamData(players: FplPlayer[], teams: FplTeam[], fixtures: FplFixture[]) {
  const enriched = teams.map((team) => {
    const teamPlayers = players.filter((player) => player.team === team.id);
    // FPL adds a completed match to cumulative player xG before the match is
    // officially final. Count that match in the denominator as well.
    const completedMatches = fixtures.filter((fixture) => hasCompletedScore(fixture) && (fixture.team_h === team.id || fixture.team_a === team.id)).length;
    if (!completedMatches) return { ...team, underlying_matches: 0 };

    // Player xG sums to a useful approximation of team chance quality. xA is kept separately
    // as a secondary creation signal rather than added to xG (which would double count attacks).
    const xg = teamPlayers.reduce((total, player) => total + numberValue(player.expected_goals), 0);
    const xa = teamPlayers.reduce((total, player) => total + numberValue(player.expected_assists), 0);

    // Goalkeepers are the cleanest team xGC proxy because defenders duplicate the same team value.
    const keepers = teamPlayers.filter((player) => player.element_type === 1 && player.minutes > 0);
    const defensivePool = keepers.length
      ? keepers
      : teamPlayers.filter((player) => player.element_type === 2 && player.minutes > 0);
    const xgcMinutes = defensivePool.reduce((total, player) => total + player.minutes, 0);
    const xgaPer90 = xgcMinutes > 0
      ? defensivePool.reduce((total, player) => total + numberValue(player.expected_goals_conceded_per_90) * player.minutes, 0) / xgcMinutes
      : 0;

    return {
      ...team,
      underlying_matches: completedMatches,
      underlying_attack_xg_per_match: xg / completedMatches,
      underlying_attack_xa_per_match: xa / completedMatches,
      underlying_defence_xga_per_match: xgaPer90,
    };
  });

  return withFallbackTeamStrengths(enriched);
}

/** Restore relative ratings when the official strength fields are all zero. */
export function withFallbackTeamStrengths(enriched: FplTeam[]) {
  // Six league-average matches of prior weight limit early-season noise.
  const average = (values: number[], fallback: number) => values.length
    ? values.reduce((total, value) => total + value, 0) / values.length : fallback;
  const leagueXg = average(enriched.map((team) => team.underlying_attack_xg_per_match ?? 0).filter((value) => value > 0), 1.42);
  const leagueXga = average(enriched.map((team) => team.underlying_defence_xga_per_match ?? 0).filter((value) => value > 0), 1.42);
  const rating = (ratio: number) => Math.max(800, Math.min(1250, Math.round(1000 * Math.pow(ratio, 0.45))));

  return enriched.map((team) => {
    const matches = Math.max(0, team.underlying_matches ?? 0);
    if (!matches) return team;
    const observedXg = team.underlying_attack_xg_per_match || leagueXg;
    const observedXga = team.underlying_defence_xga_per_match || leagueXga;
    const attackXg = (observedXg * matches + leagueXg * 6) / (matches + 6);
    const defenceXga = (observedXga * matches + leagueXga * 6) / (matches + 6);
    const attack = rating(attackXg / leagueXg);
    const defence = rating(leagueXga / Math.max(defenceXga, 0.35));
    return {
      ...team,
      strength_attack_home: team.strength_attack_home || Math.round(attack * 1.03),
      strength_attack_away: team.strength_attack_away || Math.round(attack * 0.98),
      strength_defence_home: team.strength_defence_home || Math.round(defence * 1.03),
      strength_defence_away: team.strength_defence_away || Math.round(defence * 0.98),
    };
  });
}
