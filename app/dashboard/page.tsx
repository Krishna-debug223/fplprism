import LiveRefreshV12 from "@/components/LiveRefreshV12";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  title: "FPL Prism Dashboard — Live FPL decision support",
  description: "Import a squad and see expected points, ranges, risk and legal transfer ideas for the current Gameweek.",
  path: "/dashboard",
  noindex: true,
});

// The dashboard owns live Gameweek context. Keep its shell dynamic so a normal
// reload cannot serve a stale prerendered GW label or bundle after a promotion.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function DashboardPage() {
  return (
    <>
      <noscript>
        <section className="seo-noscript" aria-label="FPL Prism dashboard overview">
          <h1>Risk-aware FPL decisions for every Gameweek</h1>
          <p>FPL Prism compares expected points, outcome ranges and transfer risk using simulated outcomes. Enable JavaScript to import a Team ID and view the live dashboard.</p>
        </section>
      </noscript>
      <LiveRefreshV12 />
    </>
  );
}
