import { NextResponse } from "next/server";
import { fplFetch } from "@/lib/server-fpl";
import type { FplFixture } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  try {
    const fixtures = await fplFetch<FplFixture[]>("/fixtures/", 30);
    return NextResponse.json({ fixtures, fetchedAt: new Date().toISOString() }, {
      headers: { "Cache-Control": "public, s-maxage=30" },
    });
  } catch {
    return NextResponse.json({ error: "Live fixture data is temporarily unavailable." }, { status: 502 });
  }
}
