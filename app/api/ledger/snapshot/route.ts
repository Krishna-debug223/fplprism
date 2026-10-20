import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getSiteUrl } from "@/lib/site-url";
import { fplFetch } from "@/lib/server-fpl";
import { enrichUnderlyingTeamData } from "@/lib/fpl-enrichment";
import { MODEL_VERSION, positionName, projectPlayer } from "@/lib/risk-v12";
import { buildNewsScan } from "@/lib/news-scan";
import type { SportsbookPayload } from "@/lib/sportsbook";
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
  const headers = new Headers({
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
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
  };
  playerCount: number;
  fixtures: FplFixture[];
  newsScan?: NewsScanPayload;
  rows: Array<Record<string, unknown>>;
};

const SNAPSHOT_TTL_MS = 30_000;
const snapshotCache = new Map<string, { expiresAt: number; promise: Promise<SnapshotPayload> }>();
const LOCKED_DATA_DIR = path.join(process.cwd(), "public", "modelbook", "data");

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
    const validHash = Boolean(artifact.snapshot && artifact.contentHash)
      && (artifact.lockMode !== "automatic-predeadline"
        || createHash("sha256").update(JSON.stringify(artifact.snapshot)).digest("hex") === artifact.contentHash);
    return validHash && Number(snapshot.gameweek ?? artifact.gameweek) === eventId && Array.isArray(snapshot.rows) && snapshot.rows.length
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
  const cacheKey = Number.isInteger(requestedEvent) && requestedEvent > 0 ? `event:${requestedEvent}` : "next";

  try {
    const payload = await cachedSnapshot(cacheKey, async () => {
      // Read the official feeds directly instead of calling this app's own public
      // domain. A self-request can be redirected by deployment protection and turn
      // a valid FPL feed into an HTML login page inside the function.
      const [rawBootstrap, fixtures, historyPayload, sportsbookPayload] = await Promise.all([
        fplFetch<Pick<BootstrapPayload, "elements" | "teams" | "events">>("/bootstrap-static/", 300),
        fplFetch<FplFixture[]>("/fixtures/", 120),
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
      if (Number.isFinite(deadline) && Date.now() >= deadline) {
        const frozen = await frozenSnapshot(event.id);
        if (frozen) return frozen;
        throw new Error("NO_FROZEN_SNAPSHOT");
      }

      const teamMap = new Map(bootstrap.teams.map((team) => [team.id, team]));
      const eventFixtures = fixtures.filter((fixture) => fixture.event === event.id);
      const newsScan = buildNewsScan(bootstrap, fixtures, event.id);
      const kickoffByTeam = new Map<number, string | null>();

      eventFixtures.forEach((fixture) => {
        kickoffByTeam.set(fixture.team_h, fixture.kickoff_time);
        kickoffByTeam.set(fixture.team_a, fixture.kickoff_time);
      });

      const rows = bootstrap.elements.map((player) => {
        const projection = projectPlayer(
          player,
          fixtures,
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
          kickoffTime: kickoffByTeam.get(player.team) ?? null,
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
      });

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

      return {
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
        },
        playerCount: rows.length,
        fixtures: eventFixtures,
        newsScan,
        rows,
      };
    });

    return NextResponse.json(payload, { headers: jsonHeaders(request) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message !== "NO_FROZEN_SNAPSHOT") {
      console.error(JSON.stringify({
        level: "error",
        route: "/api/ledger/snapshot",
        requestId: request.headers.get("x-vercel-id"),
        error: message,
      }));
    }
    const status = error instanceof Error && error.message === "NO_MATCHING_EVENT"
      ? 404
      : error instanceof Error && error.message === "NO_FROZEN_SNAPSHOT"
        ? 409
        : 503;
    const headers = jsonHeaders(request);
    headers.set("Cache-Control", "no-store, max-age=0");
    return NextResponse.json(
      {
        error: status === 404
          ? "No matching FPL event was found."
          : status === 409
            ? "The Gameweek deadline has passed and its frozen forecast is unavailable. Recalculated projections are hidden to protect the historical record."
            : "Live projection data is temporarily unavailable.",
      },
      { status, headers },
    );
  }
}
