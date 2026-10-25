import { NextResponse } from "next/server";
import { fplFetch } from "@/lib/server-fpl";
import { enrichUnderlyingTeamData } from "@/lib/fpl-enrichment";
import type { BootstrapPayload, FplEvent, FplFixture, FplPlayer, FplTeam } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  try {
    const [data, fixtures] = await Promise.all([
      fplFetch<{ elements: FplPlayer[]; teams: FplTeam[]; events: FplEvent[] }>("/bootstrap-static/", 60),
      fplFetch<FplFixture[]>("/fixtures/", 30),
    ]);
    const payload: BootstrapPayload = {
      elements: data.elements,
      teams: enrichUnderlyingTeamData(data.elements, data.teams, fixtures),
      events: data.events,
      fetchedAt: new Date().toISOString(),
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "public, s-maxage=60" } });
  } catch {
    return NextResponse.json({ error: "Live FPL data is temporarily unavailable." }, { status: 502 });
  }
}
