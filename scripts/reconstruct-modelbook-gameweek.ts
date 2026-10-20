import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { MODEL_VERSION, positionName, projectPlayer } from "../lib/risk-v12";
import type { FplFixture, FplPlayer, FplTeam } from "../lib/types";

type ApiResult<T> = { data: T; sha256: string; fetchedAt: string };
type LivePlayer = { id: number; stats?: Record<string, number | string | boolean | null> };
type LiveEvent = { elements?: LivePlayer[] };
type Bootstrap = {
  events: Array<{ id: number; name: string; deadline_time: string; finished: boolean }>;
  teams: Array<{ id: number; name: string; short_name: string }>;
};
type OfficialFixture = FplFixture & {
  finished_provisional?: boolean;
  minutes?: number;
};
type ArchivedPlayer = {
  id: number;
  code: number;
  name: string;
  firstName?: string;
  secondName?: string;
  teamId: number;
  team: string;
  position: string;
  price: number;
};
type LockedSource = {
  snapshot?: { rows?: ArchivedPlayer[] };
};

const DATA_DIR = path.join(process.cwd(), "public/modelbook/data");
const FPL_API = "https://fantasy.premierleague.com/api";
const POSITION_TYPE: Record<string, number> = { GKP: 1, DEF: 2, MID: 3, FWD: 4 };
const TARGET_GAMEWEEK = Number(process.argv[2] ?? process.env.MODELBOOK_GAMEWEEK ?? 7);

const number = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};
const round = (value: number, places = 3) => Number(value.toFixed(places));
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function fetchJson<T>(url: string): Promise<ApiResult<T>> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "FPL-Prism-Retrospective-Audit/1.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Official FPL endpoint returned ${response.status}: ${url}`);
  const text = await response.text();
  return { data: JSON.parse(text) as T, sha256: sha256(text), fetchedAt: new Date().toISOString() };
}

function sumStats(rows: Array<Record<string, number | string | boolean | null>>, key: string) {
  return rows.reduce((total, stats) => total + number(stats[key]), 0);
}

function buildTeams(
  sourceTeams: Bootstrap["teams"],
  archivedPlayers: ArchivedPlayer[],
  liveByEvent: Map<number, LiveEvent>,
  pastFixtures: OfficialFixture[],
): FplTeam[] {
  const teamIds = [...new Set(archivedPlayers.map((player) => player.teamId))];
  const eventXgByTeam = new Map<number, Map<number, number>>();

  for (const [eventId, payload] of liveByEvent) {
    for (const element of payload.elements ?? []) {
      const archivedPlayer = archivedPlayers.find((player) => player.id === Number(element.id));
      if (!archivedPlayer) continue;
      const byEvent = eventXgByTeam.get(archivedPlayer.teamId) ?? new Map<number, number>();
      byEvent.set(eventId, (byEvent.get(eventId) ?? 0) + number(element.stats?.expected_goals));
      eventXgByTeam.set(archivedPlayer.teamId, byEvent);
    }
  }

  const fixtureCountByTeamEvent = new Map<string, number>();
  for (const fixture of pastFixtures) {
    if (fixture.event == null) continue;
    for (const teamId of [fixture.team_h, fixture.team_a]) {
      const key = `${teamId}:${fixture.event}`;
      fixtureCountByTeamEvent.set(key, (fixtureCountByTeamEvent.get(key) ?? 0) + 1);
    }
  }

  const attackValues = new Map<number, number[]>();
  const concedeValues = new Map<number, number[]>();
  for (const fixture of pastFixtures) {
    if (fixture.event == null) continue;
    const homeXgTotal = eventXgByTeam.get(fixture.team_h)?.get(fixture.event) ?? 0;
    const awayXgTotal = eventXgByTeam.get(fixture.team_a)?.get(fixture.event) ?? 0;
    const homeCount = fixtureCountByTeamEvent.get(`${fixture.team_h}:${fixture.event}`) ?? 1;
    const awayCount = fixtureCountByTeamEvent.get(`${fixture.team_a}:${fixture.event}`) ?? 1;
    const homeXg = homeXgTotal / homeCount;
    const awayXg = awayXgTotal / awayCount;
    attackValues.set(fixture.team_h, [...(attackValues.get(fixture.team_h) ?? []), homeXg]);
    attackValues.set(fixture.team_a, [...(attackValues.get(fixture.team_a) ?? []), awayXg]);
    concedeValues.set(fixture.team_h, [...(concedeValues.get(fixture.team_h) ?? []), awayXg]);
    concedeValues.set(fixture.team_a, [...(concedeValues.get(fixture.team_a) ?? []), homeXg]);
  }

  const mean = (values: number[]) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
  const leagueAttack = mean([...attackValues.values()].flat()) || 1.42;
  const byId = new Map(sourceTeams.map((team) => [team.id, team]));
  return teamIds.flatMap((id) => {
    const source = byId.get(id);
    if (!source) return [];
    const xgValues = attackValues.get(id) ?? [];
    const xgaValues = concedeValues.get(id) ?? [];
    const xg = xgValues.length ? mean(xgValues) : leagueAttack;
    const xga = xgaValues.length ? mean(xgaValues) : leagueAttack;
    const attackStrength = Math.max(800, Math.min(1250, Math.round(1000 * Math.pow(xg / leagueAttack, 0.45))));
    const defenceStrength = Math.max(800, Math.min(1250, Math.round(1000 * Math.pow(leagueAttack / Math.max(xga, 0.35), 0.45))));
    return [{
      id,
      name: source.name,
      short_name: source.short_name,
      strength: 3,
      strength_attack_home: Math.round(attackStrength * 1.03),
      strength_attack_away: Math.round(attackStrength * 0.98),
      strength_defence_home: Math.round(defenceStrength * 1.03),
      strength_defence_away: Math.round(defenceStrength * 0.98),
      underlying_matches: xgValues.length,
      underlying_attack_xg_per_match: xg,
      underlying_attack_xa_per_match: Math.max(0.55, xg * 0.73),
      underlying_defence_xga_per_match: xga,
    } satisfies FplTeam];
  });
}

function buildPlayer(archived: ArchivedPlayer, history: Array<Record<string, number | string | boolean | null>>): FplPlayer {
  const minutes = sumStats(history, "minutes");
  const starts = sumStats(history, "starts");
  const totalPoints = sumStats(history, "total_points");
  const goals = sumStats(history, "expected_goals");
  const assists = sumStats(history, "expected_assists");
  const involvement = sumStats(history, "expected_goal_involvements");
  const conceded = sumStats(history, "expected_goals_conceded");
  const saves = sumStats(history, "saves");
  const bonus = sumStats(history, "bonus");
  const bps = sumStats(history, "bps");
  const yellowCards = sumStats(history, "yellow_cards");
  const redCards = sumStats(history, "red_cards");
  const cleanSheets = sumStats(history, "clean_sheets");
  const defensiveContribution = sumStats(history, "defensive_contribution");
  const games = history.filter((stats) => number(stats.minutes) > 0).length;
  const per90 = (value: number) => minutes > 0 ? 90 * value / minutes : 0;
  return {
    id: archived.id,
    code: archived.code,
    web_name: archived.name,
    first_name: archived.firstName || archived.name,
    second_name: archived.secondName || "",
    team: archived.teamId,
    element_type: POSITION_TYPE[archived.position] ?? 3,
    now_cost: archived.price || 50,
    total_points: totalPoints,
    minutes,
    starts,
    form: games ? (totalPoints / games).toFixed(2) : "0",
    points_per_game: games ? (totalPoints / games).toFixed(2) : "0",
    selected_by_percent: "0",
    ep_next: null,
    chance_of_playing_next_round: 100,
    status: "a",
    news: "",
    news_added: null,
    chance_of_playing_this_round: 100,
    expected_goals: goals.toFixed(4),
    expected_assists: assists.toFixed(4),
    expected_goal_involvements: involvement.toFixed(4),
    expected_goals_per_90: per90(goals).toFixed(4),
    expected_assists_per_90: per90(assists).toFixed(4),
    expected_goal_involvements_per_90: per90(involvement).toFixed(4),
    expected_goals_conceded: conceded.toFixed(4),
    expected_goals_conceded_per_90: per90(conceded).toFixed(4),
    clean_sheets: cleanSheets,
    clean_sheets_per_90: per90(cleanSheets).toFixed(4),
    saves,
    saves_per_90: per90(saves).toFixed(4),
    goals_conceded_per_90: "0",
    bonus,
    bps,
    yellow_cards: yellowCards,
    red_cards: redCards,
    penalties_saved: sumStats(history, "penalties_saved"),
    penalties_missed: sumStats(history, "penalties_missed"),
    defensive_contribution: defensiveContribution,
    defensive_contribution_per_90: per90(defensiveContribution).toFixed(4),
    transfers_in_event: 0,
    transfers_out_event: 0,
  };
}

function metricSet(rows: Array<{ actual: number; projected: number }>) {
  const count = rows.length;
  if (!count) throw new Error("Cannot build a reconstruction report from an empty cohort.");
  const errors = rows.map((row) => row.actual - row.projected);
  const absolute = errors.map(Math.abs);
  const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / count;
  return {
    count,
    mae: round(mean(absolute)),
    rmse: round(Math.sqrt(mean(errors.map((error) => error ** 2)))),
    bias: round(mean(errors)),
    within1: round(absolute.filter((error) => error <= 1).length / count * 100, 1),
    within2: round(absolute.filter((error) => error <= 2).length / count * 100, 1),
    within3: round(absolute.filter((error) => error <= 3).length / count * 100, 1),
  };
}

async function main() {
  if (!Number.isInteger(TARGET_GAMEWEEK) || TARGET_GAMEWEEK < 2 || TARGET_GAMEWEEK > 38) {
    throw new Error("Pass a valid target Gameweek number.");
  }
  const lockPath = path.join(DATA_DIR, `gw${TARGET_GAMEWEEK}-locked.json`);
  const metaPath = path.join(DATA_DIR, `gw${TARGET_GAMEWEEK}-snapshot-meta.json`);
  const reportPath = path.join(DATA_DIR, `gw${TARGET_GAMEWEEK}-report.json`);
  for (const file of [lockPath, metaPath, reportPath]) {
    try {
      await readFile(file, "utf8");
      throw new Error(`Refusing to overwrite existing Modelbook history: ${path.basename(file)}`);
    } catch (error) {
      if (error instanceof Error && !((error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
  }

  const archivedText = await readFile(path.join(DATA_DIR, `gw${TARGET_GAMEWEEK - 1}-locked.json`), "utf8");
  const archivedLock = JSON.parse(archivedText) as LockedSource;
  const archivedPlayers = archivedLock.snapshot?.rows ?? [];
  if (!archivedPlayers.length) throw new Error(`GW${TARGET_GAMEWEEK - 1} has no frozen player set to define a no-lookahead reconstruction.`);

  const [bootstrapResult, fixturesResult, liveResults] = await Promise.all([
    fetchJson<Bootstrap>(`${FPL_API}/bootstrap-static/`),
    fetchJson<OfficialFixture[]>(`${FPL_API}/fixtures/`),
    Promise.all(Array.from({ length: TARGET_GAMEWEEK }, (_, index) => fetchJson<LiveEvent>(`${FPL_API}/event/${index + 1}/live/`))),
  ]);
  const bootstrap = bootstrapResult.data;
  const event = bootstrap.events.find((item) => item.id === TARGET_GAMEWEEK);
  if (!event) throw new Error(`The official FPL feed has no GW${TARGET_GAMEWEEK} event.`);
  const deadline = Date.parse(event.deadline_time);
  if (!Number.isFinite(deadline) || Date.now() < deadline) {
    throw new Error(`GW${TARGET_GAMEWEEK} has not passed its official deadline; this script only creates retrospective audit locks.`);
  }
  for (let gameweek = 1; gameweek < TARGET_GAMEWEEK; gameweek += 1) {
    const priorEvent = bootstrap.events.find((item) => item.id === gameweek);
    if (!priorEvent?.finished) throw new Error(`GW${gameweek} is not marked finished; the reconstruction training window is incomplete.`);
  }

  const sourceFixtures = fixturesResult.data;
  const pastFixtures = sourceFixtures.filter((fixture) => Number(fixture.event) < TARGET_GAMEWEEK && fixture.finished);
  const targetSourceFixtures = sourceFixtures.filter((fixture) => Number(fixture.event) === TARGET_GAMEWEEK);
  if (!targetSourceFixtures.length) throw new Error(`The official FPL feed has no GW${TARGET_GAMEWEEK} fixtures.`);
  const forecastFixtures: FplFixture[] = targetSourceFixtures.map((fixture) => ({
    id: fixture.id,
    event: TARGET_GAMEWEEK,
    team_h: fixture.team_h,
    team_a: fixture.team_a,
    team_h_difficulty: fixture.team_h_difficulty,
    team_a_difficulty: fixture.team_a_difficulty,
    kickoff_time: fixture.kickoff_time,
    finished: false,
    started: false,
  }));
  const teams = buildTeams(bootstrap.teams, archivedPlayers, new Map(
    liveResults.slice(0, TARGET_GAMEWEEK - 1).map((result, index) => [index + 1, result.data]),
  ), pastFixtures);
  const historyByPlayer = new Map<number, Array<Record<string, number | string | boolean | null>>>();
  liveResults.slice(0, TARGET_GAMEWEEK - 1).forEach((result) => {
    for (const player of result.data.elements ?? []) {
      const bucket = historyByPlayer.get(Number(player.id)) ?? [];
      bucket.push(player.stats ?? {});
      historyByPlayer.set(Number(player.id), bucket);
    }
  });

  const rows = archivedPlayers.map((archived) => {
    const player = buildPlayer(archived, historyByPlayer.get(archived.id) ?? []);
    const projection = projectPlayer(player, [...pastFixtures, ...forecastFixtures], teams, 1, undefined, undefined, [TARGET_GAMEWEEK]);
    const team = teams.find((item) => item.id === archived.teamId);
    return {
      id: archived.id,
      code: archived.code,
      name: archived.name || player.web_name,
      firstName: archived.firstName ?? player.first_name,
      secondName: archived.secondName ?? player.second_name,
      teamId: archived.teamId,
      team: team?.short_name ?? archived.team,
      position: positionName(player.element_type),
      price: archived.price,
      ownership: 0,
      status: "neutral-assumption",
      fixture: projection.fixtureLabels[0] ?? "BLANK",
      kickoffTime: forecastFixtures.find((fixture) => fixture.team_h === archived.teamId || fixture.team_a === archived.teamId)?.kickoff_time ?? null,
      projected: projection.expected,
      volatility: projection.volatility,
      risk: projection.risk,
      confidence: projection.confidence,
      dataQuality: projection.dataQuality,
      floor: Math.max(0, projection.expected - projection.volatility * 1.2815515655),
      median: projection.expected,
      ceiling: projection.expected + projection.volatility * 1.2815515655,
      sharpe: projection.expected / Math.max(projection.volatility, 0.35),
      probabilities: null,
      simulations: null,
      components: projection.components,
      news: null,
      newsAdded: null,
      chanceOfPlayingThisRound: null,
    };
  });

  const generatedAt = new Date().toISOString();
  const snapshot = {
    schemaVersion: 2,
    gameweek: TARGET_GAMEWEEK,
    eventName: event.name,
    deadlineTime: event.deadline_time,
    generatedAt,
    modelVersion: MODEL_VERSION,
    training: {
      trainedThroughGameweek: TARGET_GAMEWEEK - 1,
      targetGameweek: TARGET_GAMEWEEK,
      method: "Retrospective walk-forward reconstruction using official FPL live player statistics and completed fixtures through GW6.",
      validation: "Not a recovered deadline forecast; neutral availability and no historical news/market snapshot.",
      source: "Official FPL bootstrap, fixtures, and event live feeds.",
    },
    source: "FPL Prism retrospective Modelbook audit; reconstructed after the GW7 deadline.",
    playerCount: rows.length,
    fixtures: forecastFixtures,
    rows,
  };
  const canonicalSnapshot = JSON.stringify(snapshot);
  const contentHash = sha256(canonicalSnapshot);
  const lock = {
    lockSchemaVersion: 1,
    gameweek: TARGET_GAMEWEEK,
    lockedAt: generatedAt,
    lockMode: "retrospective-reconstruction",
    lockNote: "Original GW7 pre-deadline forecast and checkpoint are unavailable. This fixed audit baseline was reconstructed after the deadline from data through GW6 and must not be described as the published GW7 prediction.",
    deadlineTime: event.deadline_time,
    modelVersion: MODEL_VERSION,
    source: "FPL Prism retrospective walk-forward reconstruction",
    contentHashAlgorithm: "sha256",
    contentHash,
    sourceByteLength: Buffer.byteLength(canonicalSnapshot),
    reconstruction: {
      trainedThroughGameweek: TARGET_GAMEWEEK - 1,
      targetGameweek: TARGET_GAMEWEEK,
      noLookahead: "Projection features use only event live feeds for GW1-GW6 and finished fixtures before GW7. GW7 actuals, scores, team form, and live player news are used only in the separate scoring report.",
      limitations: [
        "The original GW7 deadline model version and exact player/news state cannot be recovered.",
        "Availability and injury news are neutral assumptions because a GW7 pre-deadline news snapshot is missing.",
        "The player universe, team, position, and price baseline come from the frozen GW6 export.",
        "Model code version 1.4.0 is applied retrospectively and is not the model version published for GW7.",
        "The archive is an audit reconstruction and is not directly comparable to published pre-deadline reports.",
      ],
      inputs: {
        bootstrap: { source: `${FPL_API}/bootstrap-static/`, sha256: bootstrapResult.sha256, fetchedAt: bootstrapResult.fetchedAt },
        fixtures: { source: `${FPL_API}/fixtures/`, sha256: fixturesResult.sha256, fetchedAt: fixturesResult.fetchedAt },
        history: liveResults.slice(0, TARGET_GAMEWEEK - 1).map((result, index) => ({
          gameweek: index + 1,
          source: `${FPL_API}/event/${index + 1}/live/`,
          sha256: result.sha256,
          fetchedAt: result.fetchedAt,
        })),
      },
    },
    snapshot,
  };
  const metadata = {
    season: "2026/27",
    gameweek: TARGET_GAMEWEEK,
    lockedAt: generatedAt,
    deadline: event.deadline_time,
    modelVersion: MODEL_VERSION,
    sourceModelVersion: MODEL_VERSION,
    lockedBeforeDeadline: false,
    reconstruction: true,
    contentHash,
    method: lock.reconstruction.noLookahead,
    limitations: lock.reconstruction.limitations,
  };

  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
  await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({
    gameweek: TARGET_GAMEWEEK,
    rows: rows.length,
    modelVersion: MODEL_VERSION,
    lockedAt: generatedAt,
    deadline: event.deadline_time,
    contentHash,
    artifact: path.relative(process.cwd(), lockPath),
    actualsSource: `${FPL_API}/event/${TARGET_GAMEWEEK}/live/ (scoring only; excluded from projection)`,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
