import "server-only";

import type { FplFixture, FplTeam } from "./types";
import {
  decimalOddsToProbability,
  impliedGoalMeanFromTotal,
  normalizeTeamName,
  removeVig,
  splitExpectedGoals,
  type SportsbookFixtureSignal,
  type SportsbookPayload,
} from "./sportsbook";

type OddsOutcome = { name: string; price: number; point?: number };
type OddsMarket = { key: string; last_update?: string; outcomes: OddsOutcome[] };
type OddsBookmaker = { key: string; title: string; last_update?: string; markets: OddsMarket[] };
type OddsEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
};

const provider = () => (process.env.SPORTSBOOK_PROVIDER ?? "the-odds-api").toLowerCase();
const configuredWeight = () => {
  const parsed = Number.parseFloat(process.env.SPORTSBOOK_MODEL_WEIGHT ?? "0");
  return Number.isFinite(parsed) ? Math.max(0, Math.min(0.25, parsed)) : 0;
};

const alias = (name: string) => {
  const normalized = normalizeTeamName(name);
  const aliases: Record<string, string> = {
    manchestercity: "mancity",
    manchesterunited: "manutd",
    tottenhamhotspur: "spurs",
    tottenham: "spurs",
    wolverhamptonwanderers: "wolves",
    wolverhampton: "wolves",
    brightonandhovealbion: "brighton",
    nottinghamforest: "nottmforest",
    westhamunited: "westham",
    newcastleunited: "newcastle",
    leedsunited: "leeds",
  };
  return aliases[normalized] ?? normalized;
};

function matchTeam(name: string, teams: FplTeam[]) {
  const target = alias(name);
  return teams.find((team) => alias(team.name) === target || alias(team.short_name) === target);
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function aggregateEvent(event: OddsEvent, fetchedAt: number) {
  const homeProbabilities: number[] = [];
  const drawProbabilities: number[] = [];
  const awayProbabilities: number[] = [];
  const totalMeans: number[] = [];
  const quoteTimes: number[] = [];

  event.bookmakers.forEach((bookmaker) => {
    const h2h = bookmaker.markets.find((market) => market.key === "h2h");
    const totals = bookmaker.markets.find((market) => market.key === "totals");
    const h2hUpdated = Date.parse(h2h?.last_update ?? bookmaker.last_update ?? "");
    const totalsUpdated = Date.parse(totals?.last_update ?? bookmaker.last_update ?? "");
    const fresh = (time: number) => Number.isFinite(time)
      && time <= fetchedAt + 5 * 60_000 && fetchedAt - time <= 72 * 60 * 60_000;
    if (h2h && fresh(h2hUpdated)) {
      const home = h2h.outcomes.find((outcome) => outcome.name === event.home_team);
      const away = h2h.outcomes.find((outcome) => outcome.name === event.away_team);
      const draw = h2h.outcomes.find((outcome) => outcome.name.toLowerCase() === "draw");
      if (home && away && draw) {
        const [pHome, pDraw, pAway] = removeVig([
          decimalOddsToProbability(home.price),
          decimalOddsToProbability(draw.price),
          decimalOddsToProbability(away.price),
        ]);
        if (pHome && pDraw && pAway) {
          homeProbabilities.push(pHome);
          drawProbabilities.push(pDraw);
          awayProbabilities.push(pAway);
          quoteTimes.push(h2hUpdated);
        }
      }
    }

    if (totals && fresh(totalsUpdated)) {
      const points = [...new Set(totals.outcomes.map((outcome) => outcome.point).filter((point): point is number =>
        typeof point === "number" && Math.abs(point % 1 - 0.5) < 1e-8))]
        .sort((a, b) => Math.abs(a - 2.5) - Math.abs(b - 2.5));
      const point = points[0];
      if (point != null) {
        const over = totals.outcomes.find((outcome) => outcome.name.toLowerCase() === "over" && outcome.point === point);
        const under = totals.outcomes.find((outcome) => outcome.name.toLowerCase() === "under" && outcome.point === point);
        if (over && under) {
          const [pOver] = removeVig([decimalOddsToProbability(over.price), decimalOddsToProbability(under.price)]);
          if (pOver) {
            totalMeans.push(impliedGoalMeanFromTotal(pOver, point));
            quoteTimes.push(totalsUpdated);
          }
        }
      }
    }
  });

  const homeWin = average(homeProbabilities);
  const draw = average(drawProbabilities);
  const awayWin = average(awayProbabilities);
  const expectedTotalGoals = average(totalMeans);
  if (homeWin == null || awayWin == null || expectedTotalGoals == null) return null;
  const split = splitExpectedGoals(expectedTotalGoals, homeWin, awayWin);
  return {
    homeWin,
    draw,
    awayWin,
    expectedTotalGoals,
    expectedHomeGoals: split.home,
    expectedAwayGoals: split.away,
    bookmakerCount: Math.min(homeProbabilities.length, totalMeans.length),
    marketUpdatedAt: new Date(Math.min(...quoteTimes)).toISOString(),
  };
}

function emptyPayload(note: string): SportsbookPayload {
  const weight = configuredWeight();
  return {
    available: false,
    provider: "none",
    sourceLabel: "Sportsbook market prior",
    fetchedAt: new Date().toISOString(),
    configuredWeight: weight,
    calibrationStatus: weight > 0 ? "configured" : "disabled-until-calibrated",
    fixtures: [],
    note,
  };
}

export async function loadSportsbookSignals(teams: FplTeam[], fixtures: FplFixture[]): Promise<SportsbookPayload> {
  const apiKey = process.env.THE_ODDS_API_KEY?.trim();
  if (provider() === "none") return emptyPayload("Sportsbook provider disabled.");
  if (!apiKey) return emptyPayload("Set THE_ODDS_API_KEY to enable current EPL sportsbook signals.");

  const regions = process.env.SPORTSBOOK_REGIONS?.trim() || "uk";
  const url = new URL("https://api.the-odds-api.com/v4/sports/soccer_epl/odds");
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", regions);
  url.searchParams.set("markets", "h2h,totals");
  url.searchParams.set("oddsFormat", "decimal");
  url.searchParams.set("dateFormat", "iso");

  try {
    const response = await fetch(url, { next: { revalidate: 300 }, headers: { Accept: "application/json" } });
    if (!response.ok) return emptyPayload(`Sportsbook provider returned ${response.status}; base model remains active.`);
    const events = await response.json() as OddsEvent[];
    const fetchedAt = Date.now();
    const signals: SportsbookFixtureSignal[] = [];

    events.forEach((event) => {
      const home = matchTeam(event.home_team, teams);
      const away = matchTeam(event.away_team, teams);
      const market = aggregateEvent(event, fetchedAt);
      if (!home || !away || !market) return;

      const commence = new Date(event.commence_time).getTime();
      if (!Number.isFinite(commence) || commence <= fetchedAt) return;
      const fixture = fixtures
        .filter((candidate) => !candidate.finished && candidate.team_h === home.id && candidate.team_a === away.id)
        .sort((a, b) => Math.abs(new Date(a.kickoff_time ?? 0).getTime() - commence) - Math.abs(new Date(b.kickoff_time ?? 0).getTime() - commence))[0];
      if (!fixture) return;
      if (fixture.started) return;
      const kickoff = new Date(fixture.kickoff_time ?? event.commence_time).getTime();
      if (Math.abs(kickoff - commence) > 48 * 60 * 60 * 1000) return;

      signals.push({
        fixtureId: fixture.id,
        event: fixture.event,
        homeTeamId: home.id,
        awayTeamId: away.id,
        homeTeam: home.name,
        awayTeam: away.name,
        commenceTime: event.commence_time,
        homeWinProbability: market.homeWin,
        drawProbability: market.draw,
        awayWinProbability: market.awayWin,
        expectedTotalGoals: market.expectedTotalGoals,
        expectedHomeGoals: market.expectedHomeGoals,
        expectedAwayGoals: market.expectedAwayGoals,
        homeCleanSheetProbability: Math.exp(-market.expectedAwayGoals),
        awayCleanSheetProbability: Math.exp(-market.expectedHomeGoals),
        bookmakerCount: market.bookmakerCount,
        quality: Math.max(0.25, Math.min(1, market.bookmakerCount / 8)),
        marketUpdatedAt: market.marketUpdatedAt,
      });
    });

    const weight = configuredWeight();
    return {
      available: signals.length > 0,
      provider: "the-odds-api",
      sourceLabel: "The Odds API consensus (de-vigged h2h + totals)",
      fetchedAt: new Date(fetchedAt).toISOString(),
      configuredWeight: weight,
      calibrationStatus: weight > 0 ? "configured" : "disabled-until-calibrated",
      fixtures: signals,
      note: signals.length
        ? weight > 0
          ? "Market probabilities are blended as a bounded external prior."
          : "Market feed is live, but model influence is disabled until SPORTSBOOK_MODEL_WEIGHT is configured from calibration."
        : "No matching EPL markets are currently available; the base model remains active.",
    };
  } catch {
    return emptyPayload("Sportsbook feed unavailable; the base model remains active.");
  }
}
