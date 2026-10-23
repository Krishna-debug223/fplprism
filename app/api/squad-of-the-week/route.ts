import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { GET as getSnapshot } from "@/app/api/ledger/snapshot/route";
import { selectFreeHitSquad, scoreFreeHitSquad, type SquadPlayer, type SquadResult } from "@/lib/free-hit-squad";
import { rateLimit } from "@/lib/rate-limit";
import { fplFetch } from "@/lib/server-fpl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Fixture = { event: number; team_h: number; team_a: number; finished: boolean; finished_provisional?: boolean; kickoff_time?: string | null };
type Snapshot = {
  gameweek: number; generatedAt: string; deadlineTime: string; modelVersion: string;
  fixtures: Fixture[];
  rows: SquadPlayer[];
};
type Live = { elements: Array<{ id: number; stats?: { total_points?: number; minutes?: number; yellow_cards?: number; red_cards?: number } }> };

const solved = new Map<string, Promise<SquadResult>>();

export async function GET(request: NextRequest) {
  const limit = rateLimit(request, "squad-of-the-week", 12);
  if (!limit.allowed) return NextResponse.json({ error: "Too many squad requests. Please retry shortly." }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  const event = Number(request.nextUrl.searchParams.get("event"));
  if (!Number.isInteger(event) || event < 1 || event > 38) return NextResponse.json({ error: "Provide a Gameweek from 1 to 38." }, { status: 400 });
  const snapshotUrl = new URL("/api/ledger/snapshot", request.url);
  snapshotUrl.searchParams.set("event", String(event));
  const response = await getSnapshot(new NextRequest(snapshotUrl, { headers: request.headers }));
  if (!response.ok) return response;
  const snapshot = await response.json() as Snapshot;
  const fixtures = snapshot.fixtures.filter((fixture) => fixture.event === event);
  const clubsWithFixture = new Set(fixtures.flatMap((fixture) => [fixture.team_h, fixture.team_a]));
  const forecastPool = snapshot.rows.filter((row) => clubsWithFixture.has(row.teamId));
  const frozen = Date.now() >= Date.parse(snapshot.deadlineTime);
  let snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  let lockMode: string | null = null;
  if (frozen) {
    try {
      const lock = JSON.parse(await readFile(path.join(process.cwd(), "public", "modelbook", "data", `gw${event}-locked.json`), "utf8")) as {
        gameweek: number; contentHash: string; lockMode: string; snapshot: Snapshot;
      };
      if (lock.gameweek === event && lock.snapshot.generatedAt === snapshot.generatedAt) {
        snapshotHash = lock.contentHash;
        lockMode = lock.lockMode;
      }
    } catch { /* The snapshot route already verified the available lock. */ }
  }
  try {
    let squadPromise = solved.get(snapshotHash);
    if (!squadPromise) {
      squadPromise = selectFreeHitSquad(forecastPool);
      solved.set(snapshotHash, squadPromise);
      squadPromise.catch(() => solved.delete(snapshotHash));
      if (solved.size > 4) solved.delete(solved.keys().next().value!);
    }
    const squad = await squadPromise;
    let actual: { score: ReturnType<typeof scoreFreeHitSquad>; players: Array<{ id: number; points: number; minutes: number }>; fetchedAt: string } | null = null;
    if (frozen && fixtures.length && fixtures.every((fixture) => Date.parse(fixture.kickoff_time ?? "") < Date.now())) {
      try {
        const [live, latestFixtures] = await Promise.all([
          fplFetch<Live>(`/event/${event}/live/`, 30),
          fplFetch<Fixture[]>(`/fixtures/?event=${event}`, 60),
        ]);
        const complete = latestFixtures.length === fixtures.length && latestFixtures.every((fixture) => fixture.finished);
        if (complete) {
          const officialPlayers = live.elements.map((element) => ({
            id: element.id,
            points: element.stats?.total_points ?? 0,
            minutes: element.stats?.minutes ?? 0,
            appeared: Boolean((element.stats?.yellow_cards ?? 0) || (element.stats?.red_cards ?? 0)),
          }));
          actual = {
            score: scoreFreeHitSquad(squad.picks, officialPlayers),
            players: officialPlayers.filter((player) => squad.picks.some((pick) => pick.id === player.id))
              .map(({ id, points, minutes }) => ({ id, points, minutes })),
            fetchedAt: new Date().toISOString(),
          };
        }
      } catch {
        // The forecast remains available if the official live feed is delayed.
      }
    }
    return NextResponse.json({
      gameweek: event, modelVersion: snapshot.modelVersion, generatedAt: snapshot.generatedAt,
      deadlineTime: snapshot.deadlineTime, snapshotHash,
      status: frozen ? "frozen" : "live-preview", lockMode,
      rules: { budget: 1000, positions: { GKP: 2, DEF: 5, MID: 5, FWD: 3 }, maxPerClub: 3, captain: 2, vice: 1.0322, benchGoalkeeper: 0.0194, benchOutfield: [0.2603, 0.0751, 0.0165] },
      squad, actual,
    }, { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30" } });
  } catch (error) {
    console.error(JSON.stringify({ route: "/api/squad-of-the-week", gameweek: event, error: error instanceof Error ? error.message : "Unknown error" }));
    return NextResponse.json({ error: "The legal squad could not be calculated right now." }, { status: 503 });
  }
}
