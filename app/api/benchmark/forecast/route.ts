import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { GET as getSnapshot } from "@/app/api/ledger/snapshot/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const event = Number(request.nextUrl.searchParams.get("event"));
  if (!Number.isInteger(event) || event < 1 || event > 38) {
    return NextResponse.json({ error: "Provide a Gameweek from 1 to 38." }, { status: 400 });
  }
  const snapshotUrl = new URL("/api/ledger/snapshot", request.url);
  snapshotUrl.searchParams.set("event", String(event));
  const snapshotResponse = await getSnapshot(new NextRequest(snapshotUrl, { headers: request.headers }));
  if (!snapshotResponse.ok) return snapshotResponse;
  const snapshot = await snapshotResponse.json() as {
    generatedAt: string; modelVersion: string;
    rows: Array<{ id: number; projected: number; price: number; teamId: number; position: string; ownership: number }>;
  };
  const csv = [
    "fpl_id,expected_points,price_millions,team_id,position,ownership_percent",
    ...snapshot.rows.map((row) => [row.id, row.projected, Number(row.price) / 10, row.teamId, row.position, row.ownership].join(",")),
  ].join("\n") + "\n";
  const hash = createHash("sha256").update(csv).digest("hex");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="fpl-prism-gw${event}-forecasts.csv"`,
      "Cache-Control": "no-store",
      "X-Forecast-Generated-At": snapshot.generatedAt,
      "X-Model-Version": snapshot.modelVersion,
      "X-CSV-SHA256": hash,
    },
  });
}
