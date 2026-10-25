import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getSiteUrl } from "@/lib/site-url";
import { fplFetch } from "@/lib/server-fpl";
import { enrichUnderlyingTeamData } from "@/lib/fpl-enrichment";
import { playerForForecastEvent } from "@/lib/fpl-availability";
import { MODEL_VERSION, positionName, projectPlayer } from "@/lib/risk-v12";
import { buildNewsScan } from "@/lib/news-scan";
import type { SportsbookFixtureSignal, SportsbookPayload } from "@/lib/sportsbook";
import type {
  BootstrapPayload,
  FplFixture,
  HistoricalPayload,
  ModelTrainingStatus,
  NewsScanPayload,
} from "@/lib/types";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedOrigins = new Set([
  "https://fpl-ledger-azure.vercel.app",
  "https://fpl-risk-ui-refresh.vercel.app",
  "https://fplprism.com",
]);

function jsonHeaders(request: NextRequest) {
  const capture = request.nextUrl.searchParams.has("capture") || request.nextUrl.searchParams.has("freeze");
  const headers = new Headers({
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": capture ? "no-store, max-age=0" : "public, s-maxage=30",
  });
  const origin = request.headers.get("origin");
  if (origin && allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

type SnapshotPayload = {
  schemaVersion: number;
  gameweek: number;
  eventName: string;
  deadlineTime: string;
  generatedAt: string;
  modelVersion: string;
  training: ModelTrainingStatus;
  source: string;
  sportsbook: {
    available: boolean;
    configuredWeight: number;
    calibrationStatus: string;
    sourceLabel?: string;
    observedAt?: string;
    fixtures?: SportsbookFixtureSignal[];
  };
  playerCount: number;
  fixtures: FplFixture[];
  newsScan?: NewsScanPayload;
  rows: Array<Record<string, unknown>>;
  forecastMode?: "deadline" | "fixture" | "rolling";
  fixtureId?: number;
  fixtureKickoffTime?: string;
  forecastStates?: Record<string, "upcoming" | "kickoff-locked" | "pre-kickoff-checkpoint" | "deadline-fallback">;
  fixtureForecasts?: Array<{ fixtureId: number; fixture: string; kickoffTime: string | null; state: "upcoming" | "kickoff-locked" | "pre-kickoff-checkpoint" | "deadline-fallback"; capturedAt: string; contentHash: string | null }>;
};

const SNAPSHOT_TTL_MS = 30_000;
const snapshotCache = new Map<string, { expiresAt: number; promise: Promise<SnapshotPayload> }>();
const LOCKED_DATA_DIR = path.join(process.cwd(), "public", "modelbook", "data");

function fixtureHasStarted(fixture: FplFixture) {
  const kickoff = Date.parse(fixture.kickoff_time ?? "");
  return fixture.started || fixture.finished || (Number.isFinite(kickoff) && Date.now() >= kickoff);
}

async function verifiedFixtureArtifact(eventId: number, fixture: FplFixture) {
  const names = [
    `gw${eventId}-fixture-${fixture.id}-locked.json`,
    `gw${eventId}-fixture-${fixture.id}-candidate.json`,
  ];
  for (const name of names) {
    try {
      const artifact = JSON.parse(await readFile(path.join(process.cwd(), "public", "modelbook", "data", name), "utf8")) as {
        gameweek: number; fixtureId: number; fixtureKickoffTime: string;
        contentHash: string; snapshot: SnapshotPayload;
      };
      const capturedAt = Date.parse(artifact.snapshot?.generatedAt ?? "");
      const kickoff = Date.parse(fixture.kickoff_time ?? "");
      if (artifact.gameweek === eventId && artifact.fixtureId === fixture.id
        && artifact.fixtureKickoffTime === fixture.kickoff_time
        && artifact.snapshot?.fixtureId === fixture.id
        && Array.isArray(artifact.snapshot.rows) && artifact.snapshot.rows.length
        && Number.isFinite(capturedAt) && capturedAt < kickoff
        && createHash("sha256").update(JSON.stringify(artifact.snapshot)).digest("hex") === artifact.contentHash) {
        return { snapshot: artifact.snapshot, checkpoint: name.endsWith("-candidate.json"), contentHash: artifact.contentHash };
      }
    } catch {
      // An optional checkpoint may not have been published yet.
    }
  }
  return null;
}

async function optionalJson(url: string) {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return null;
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

async function frozenSnapshot(eventId: number) {
  try {
    const text = await readFile(path.join(LOCKED_DATA_DIR, `gw${eventId}-locked.json`), "utf8");
    const artifact = JSON.parse(text) as {
      gameweek?: number;
      snapshot?: SnapshotPayload;
      contentHash?: string;
      lockMode?: string;
    } & SnapshotPayload;
    const snapshot = artifact.snapshot ?? artifact;
    const isRetrospectiveReconstruction = artifact.lockMode === "retrospective-reconstruction";
    const requiresHash = ["automatic-predeadline", "automatic-predeadline-fallback", "retrospective-reconstruction"].includes(artifact.lockMode ?? "");
    const validHash = Boolean(artifact.snapshot && artifact.contentHash)
      && (!requiresHash
        || createHash("sha256").update(JSON.stringify(artifact.snapshot)).digest("hex") === artifact.contentHash);
    return !isRetrospectiveReconstruction && validHash && Number(snapshot.gameweek ?? artifact.gameweek) === eventId && Array.isArray(snapshot.rows) && snapshot.rows.length
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

function cachedSnapshot(key: string, build: () => Promise<SnapshotPayload>) {
  const now = Date.now();
  const current = snapshotCache.get(key);
  if (current && current.expiresAt > now) return current.promise;

  const promise = build();
  snapshotCache.set(key, { expiresAt: now + SNAPSHOT_TTL_MS, promise });
  promise.catch(() => {
    if (snapshotCache.get(key)?.promise === promise) snapshotCache.delete(key);
  });
  return promise;
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: jsonHeaders(request) });
}

export async function GET(request: NextRequest) {
  const limit = rateLimit(request, "ledger-snapshot", 30);
  if (!limit.allowed) {
    const headers = jsonHeaders(request);
    headers.set("Cache-Control", "no-store, max-age=0");
    headers.set("Retry-After", String(limit.retryAfter));
    return NextResponse.json({ error: "Too many projection requests. Try again shortly." }, { status: 429, headers });
  }

  // Preview deployment hostnames may be access-protected. Use the canonical
  // public host for our own FPL proxy routes so snapshots work in every env.
  const origin = getSiteUrl();
  const requestedEvent = Number(request.nextUrl.searchParams.get("event") ?? "");
  const requestedFixture = Number(request.nextUrl.searchParams.get("fixture") ?? "");
  const fixtureRequest = Number.isInteger(requestedFixture) && requestedFixture > 0;
  const rolling = request.nextUrl.searchParams.get("view") === "rolling";
  const capture = request.nextUrl.searchParams.has("capture") || request.nextUrl.searchParams.has("freeze");
  const cacheKey = `${Number.isInteger(requestedEvent) && requestedEvent > 0 ? `event:${requestedEvent}` : "next"}:${fixtureRequest ? requestedFixture : rolling ? "rolling" : "deadline"}`;

  try {
    const build = async (): Promise<SnapshotPayload> => {
      // Read the official feeds directly instead of calling this app's own public
      // domain. A self-request can be redirected by deployment protection and turn
      // a valid FPL feed into an HTML login page inside the function.
      const [rawBootstrap, fixtures, historyPayload, sportsbookPayload] = await Promise.all([
        fplFetch<Pick<BootstrapPayload, "elements" | "teams" | "events">>("/bootstrap-static/", fixtureRequest || rolling ? 60 : 300),
        fplFetch<FplFixture[]>("/fixtures/", fixtureRequest || rolling ? 30 : 120),
        optionalJson(`${origin}/api/fpl/history`),
        optionalJson(`${origin}/api/sportsbook`),
      ]);
      const bootstrap: BootstrapPayload = {
        ...rawBootstrap,
        teams: enrichUnderlyingTeamData(rawBootstrap.elements, rawBootstrap.teams, fixtures),
        fetchedAt: new Date().toISOString(),
      };
      const history = historyPayload as HistoricalPayload | null;
      const sportsbook = sportsbookPayload as SportsbookPayload | null;
      const event = Number.isInteger(requestedEvent) && requestedEvent > 0
        ? bootstrap.events.find((item) => item.id === requestedEvent)
        : bootstrap.events.find((item) => item.is_next) ??
          bootstrap.events.find((item) => item.is_current);

      if (!event) throw new Error("NO_MATCHING_EVENT");
      const deadline = Date.parse(event.deadline_time);
      if (!fixtureRequest && !rolling && Number.isFinite(deadline) && Date.now() >= deadline) {
        const frozen = await frozenSnapshot(event.id);
        if (frozen) return frozen;
        throw new Error("NO_FROZEN_SNAPSHOT");
      }

      const teamMap = new Map(bootstrap.teams.map((team) => [team.id, team]));
      const eventFixtures = fixtures.filter((fixture) => fixture.event === event.id);
      const selectedFixture = fixtureRequest ? eventFixtures.find((item) => item.id === requestedFixture) : null;
      if (fixtureRequest && !selectedFixture) throw new Error("NO_MATCHING_FIXTURE");
      if (selectedFixture && fixtureHasStarted(selectedFixture)) throw new Error("FIXTURE_STARTED");
      const newsScan = buildNewsScan(bootstrap, fixtures, event.id);
      const kickoffByTeam = new Map<number, string | null>();

      eventFixtures.forEach((fixture) => {
        kickoffByTeam.set(fixture.team_h, fixture.kickoff_time);
        kickoffByTeam.set(fixture.team_a, fixture.kickoff_time);
      });

      const buildRow = (player: BootstrapPayload["elements"][number], target?: FplFixture) => {
        const projectionFixtures = target
          ? fixtures.filter((item) => item.event !== event.id || item.id === target.id)
          : fixtures;
        const projection = projectPlayer(
          playerForForecastEvent(player, event),
          projectionFixtures,
          bootstrap.teams,
          1,
          history?.players,
          sportsbook,
          [event.id],
          true,
        );
        const team = teamMap.get(player.team);

        return {
          id: player.id,
          code: player.code,
          name: player.web_name,
          firstName: player.first_name,
          secondName: player.second_name,
          teamId: player.team,
          team: team?.short_name ?? "—",
          position: positionName(player.element_type),
          price: player.now_cost,
          ownership: Number.parseFloat(player.selected_by_percent || "0"),
          status: player.status,
          fixture: projection.fixtureLabels[0] ?? "BLANK",
          kickoffTime: target?.kickoff_time ?? kickoffByTeam.get(player.team) ?? null,
          fixtureId: target?.id ?? null,
          projected: projection.expected,
          volatility: projection.volatility,
          risk: projection.risk,
          confidence: projection.confidence,
          dataQuality: projection.dataQuality,
          floor: projection.distribution?.p10 ?? Math.max(0, projection.expected - projection.volatility * 1.28),
          median: projection.distribution?.median ?? projection.expected,
          ceiling: projection.distribution?.p90 ?? projection.expected + projection.volatility * 1.28,
          sharpe: projection.distribution?.sharpe ?? projection.expected / Math.max(projection.volatility, 0.35),
          probabilities: projection.distribution?.bands ?? null,
          simulations: projection.distribution?.simulations ?? null,
          components: projection.components,
          news: player.news ?? null,
          newsAdded: player.news_added ?? null,
          chanceOfPlayingThisRound: player.chance_of_playing_this_round ?? null,
        };
      };

      const rows = selectedFixture
        ? bootstrap.elements.filter((player) => player.team === selectedFixture.team_h || player.team === selectedFixture.team_a)
          .map((player) => buildRow(player, selectedFixture))
        : rolling ? [] : bootstrap.elements.map((player) => buildRow(player));

      const generatedAt = new Date().toISOString();
      const historicalPriorCount = history?.seasons.length ?? 0;
      const training: ModelTrainingStatus = {
        trainedThroughGameweek: Math.max(0, event.id - 1),
        targetGameweek: event.id,
        updatedAt: generatedAt,
        source: historicalPriorCount > 0
          ? `Official FPL live feed + ${historicalPriorCount} completed-season priors`
          : "Official FPL live feed; historical priors unavailable",
        method: "Walk-forward, minutes-weighted current-season blending",
        validation: "GW4–GW5 walk-forward validation",
      };

      const snapshot: SnapshotPayload = {
        schemaVersion: 2,
        gameweek: event.id,
        eventName: event.name,
        deadlineTime: event.deadline_time,
        generatedAt,
        modelVersion: MODEL_VERSION,
        training,
        source: "FPL Prism production projection engine",
        sportsbook: {
          available: sportsbook?.available ?? false,
          configuredWeight: sportsbook?.configuredWeight ?? 0,
          calibrationStatus: sportsbook?.calibrationStatus ?? "disabled-until-calibrated",
          sourceLabel: sportsbook?.available ? sportsbook.sourceLabel : undefined,
          observedAt: sportsbook?.available ? sportsbook.fetchedAt : undefined,
          // Freeze derived predeadline market observations beside projections.
          // They are for prospective validation and do not affect xPts at weight 0.
          fixtures: sportsbook?.fixtures.filter((fixture) => fixture.event === event.id) ?? [],
        },
        playerCount: rows.length,
        fixtures: eventFixtures,
        newsScan,
        rows,
        forecastMode: selectedFixture ? "fixture" : rolling ? "rolling" : "deadline",
        fixtureId: selectedFixture?.id,
        fixtureKickoffTime: selectedFixture?.kickoff_time ?? undefined,
      };

      if (!rolling) return snapshot;

      // Keep every match independent: the deadline export is immutable for
      // comparisons, while this view is refreshed only until each kickoff.
      const baseline = await frozenSnapshot(event.id);
      const baselineRows = new Map((baseline?.rows ?? []).map((row) => [Number(row.id), row]));
      const fixtureParts = await Promise.all(eventFixtures.map(async (fixture) => {
        if (!fixtureHasStarted(fixture)) {
          return { fixture, state: "upcoming" as const,
            capturedAt: snapshot.generatedAt, contentHash: null,
            rows: bootstrap.elements.filter((player) => player.team === fixture.team_h || player.team === fixture.team_a)
              .map((player) => buildRow(player, fixture)) };
        }
        const saved = await verifiedFixtureArtifact(event.id, fixture);
        if (saved) return { fixture, state: saved.checkpoint ? "pre-kickoff-checkpoint" as const : "kickoff-locked" as const,
          capturedAt: saved.snapshot.generatedAt, contentHash: saved.contentHash, rows: saved.snapshot.rows };
        // Never recompute a match after kickoff. A deadline forecast is a
        // labelled fallback if the final per-fixture capture was missed.
        const fixtureCountForTeam = (teamId: number) => eventFixtures.filter((item) => item.team_h === teamId || item.team_a === teamId).length;
        if (!baseline || fixtureCountForTeam(fixture.team_h) !== 1 || fixtureCountForTeam(fixture.team_a) !== 1) {
          throw new Error("NO_FROZEN_SNAPSHOT");
        }
        return { fixture, state: "deadline-fallback" as const,
          capturedAt: baseline.generatedAt, contentHash: null,
          rows: bootstrap.elements.filter((player) => player.team === fixture.team_h || player.team === fixture.team_a)
            .map((player) => baselineRows.get(player.id)).filter((row): row is Record<string, unknown> => Boolean(row)) };
      }));
      const byPlayer = new Map<number, Array<Record<string, unknown>>>();
      for (const part of fixtureParts) {
        for (const row of part.rows) {
          const id = Number(row.id);
          byPlayer.set(id, [...(byPlayer.get(id) ?? []), row]);
        }
      }
      snapshot.rows = bootstrap.elements.map((player) => {
        const parts = byPlayer.get(player.id) ?? [];
        if (!parts.length) return { ...(baselineRows.get(player.id) ?? buildRow(player)), projected: 0, fixture: "BLANK", floor: 0, median: 0, ceiling: 0, probabilities: null };
        if (parts.length === 1) return { ...parts[0], forecastState: fixtureParts.find((part) => part.fixture.id === Number(parts[0].fixtureId))?.state ?? "deadline-fallback" };
        const total = (key: string) => parts.reduce((sum, part) => sum + Number(part[key] ?? 0), 0);
        const volatility = Math.sqrt(parts.reduce((sum, part) => sum + Number(part.volatility ?? 0) ** 2, 0));
        return { ...parts[0], projected: total("projected"), volatility,
          fixture: parts.map((part) => part.fixture).join(" + "),
          floor: total("floor"), median: total("median"), ceiling: total("ceiling"),
          sharpe: total("projected") / Math.max(volatility, 0.35),
          probabilities: null, simulations: null, forecastState: "mixed-fixtures" };
      });
      snapshot.playerCount = snapshot.rows.length;
      snapshot.forecastStates = Object.fromEntries(fixtureParts.map((part) => [String(part.fixture.id), part.state]));
      snapshot.fixtureForecasts = fixtureParts.map((part) => ({
        fixtureId: part.fixture.id,
        fixture: `${teamMap.get(part.fixture.team_h)?.short_name ?? "?"} v ${teamMap.get(part.fixture.team_a)?.short_name ?? "?"}`,
        kickoffTime: part.fixture.kickoff_time,
        state: part.state,
        capturedAt: part.capturedAt,
        contentHash: part.contentHash,
      }));
      return snapshot;
    };
    const payload = capture ? await build() : await cachedSnapshot(cacheKey, build);

    return NextResponse.json(payload, { headers: jsonHeaders(request) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (!["NO_FROZEN_SNAPSHOT", "FIXTURE_STARTED", "NO_MATCHING_FIXTURE"].includes(message)) {
      console.error(JSON.stringify({
        level: "error",
        route: "/api/ledger/snapshot",
        requestId: request.headers.get("x-vercel-id"),
        error: message,
      }));
    }
    const status = error instanceof Error && ["NO_MATCHING_EVENT", "NO_MATCHING_FIXTURE"].includes(error.message)
      ? 404
      : error instanceof Error && error.message === "NO_FROZEN_SNAPSHOT"
        ? 409
        : error instanceof Error && error.message === "FIXTURE_STARTED"
          ? 409
        : 503;
    const headers = jsonHeaders(request);
    headers.set("Cache-Control", "no-store, max-age=0");
    return NextResponse.json(
      {
        error: status === 404
          ? message === "NO_MATCHING_FIXTURE" ? "No matching fixture was found in that Gameweek." : "No matching FPL event was found."
          : status === 409
            ? message === "FIXTURE_STARTED"
              ? "This fixture has kicked off. Its forecast can no longer be recalculated."
              : "The Gameweek deadline has passed and its frozen forecast is unavailable. Recalculated projections are hidden to protect the historical record."
            : "Live projection data is temporarily unavailable.",
      },
      { status, headers },
    );
  }
}
