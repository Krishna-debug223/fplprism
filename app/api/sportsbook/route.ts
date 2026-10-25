import { NextResponse } from "next/server";

import { fplFetch } from "@/lib/server-fpl";
import { loadSportsbookSignals } from "@/lib/sportsbook-server";
import type { FplFixture, FplTeam } from "@/lib/types";

const disabledPayload = () => ({
  available: false,
  provider: "none" as const,
  sourceLabel: "Sportsbook market prior",
  fetchedAt: new Date().toISOString(),
  configuredWeight: 0,
  calibrationStatus: "disabled-until-calibrated" as const,
  fixtures: [],
  note: "Sportsbook integration is intentionally disabled for this release; the base FPL Prism model remains active.",
});

export async function GET() {
  if (process.env.SPORTSBOOK_ENABLED === "false") {
    return NextResponse.json(disabledPayload(), {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" },
    });
  }

  try {
    const [bootstrap, fixtures] = await Promise.all([
      fplFetch<{ teams: FplTeam[] }>("/bootstrap-static/", 300),
      fplFetch<FplFixture[]>("/fixtures/", 300),
    ]);
    const payload = await loadSportsbookSignals(bootstrap.teams, fixtures);
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" },
    });
  } catch {
    return NextResponse.json(disabledPayload());
  }
}
