import { headers } from "next/headers";
import { NextRequest } from "next/server";
import { GET as getSquad } from "@/app/api/squad-of-the-week/route";
import SquadOfTheWeek, { type SquadOfTheWeekPayload } from "@/components/modelbook/SquadOfTheWeek";
import { CURRENT_GAMEWEEK } from "@/lib/modelbook";
import { pageMetadata } from "@/lib/metadata";
import { getSiteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "FPL Prism Squad of the Week — benchmark Free Hit XI",
  description: "See FPL Prism's legal £100m Free Hit squad, captain, bench order and frozen forecast for the current Gameweek.",
  path: "/modelbook/squad-of-the-week",
});

export default async function SquadOfTheWeekPage() {
  const requestUrl = new URL(`/api/squad-of-the-week?event=${CURRENT_GAMEWEEK}`, getSiteUrl());
  const response = await getSquad(new NextRequest(requestUrl, { headers: await headers() }));
  const initial = response.ok ? await response.json() as SquadOfTheWeekPayload : null;
  return <SquadOfTheWeek initial={initial} />;
}
