import Link from "next/link";
import ModelbookNav from "@/components/modelbook/ModelbookNav";
import { CURRENT_GAMEWEEK } from "@/lib/modelbook";
import { pageMetadata } from "@/lib/metadata";
import report from "@/public/modelbook/data/benchmark-report.json";

export const metadata = pageMetadata({
  title: "FPL Prism forecast benchmark — independent comparison data",
  description: "Ownership-matched forecast error and top-15 ranking diagnostics from frozen FPL Prism Gameweek projections, plus a public CSV export.",
  path: "/modelbook/benchmark",
});

export default function BenchmarkPage() {
  return <main className="page">
    <ModelbookNav active="benchmark" />
    <div className="page-head">
      <div>
        <h1>Compare the forecasts</h1>
        <p className="lead">Frozen projections, official points and a downloadable forecast feed for independent benchmarks. These are diagnostic calculations, not a position on FPL Bench&apos;s leaderboard.</p>
      </div>
    </div>
    <section className="card">
      <h2>Submit the current Gameweek</h2>
      <p className="muted" style={{ marginTop: 6 }}>The GW{CURRENT_GAMEWEEK} export includes every player&apos;s official FPL ID, expected points, price in £m, club ID, position and ownership. It refreshes before the deadline; the Modelbook lock preserves the final available forecast afterward.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 14 }}>
        <a className="btn btn-primary" href={`/api/benchmark/forecast?event=${CURRENT_GAMEWEEK}`}>Download GW{CURRENT_GAMEWEEK} CSV</a>
        <a className="btn" href={`/api/ledger/snapshot?event=${CURRENT_GAMEWEEK}`}>View complete JSON</a>
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>The CSV response includes the generation time, model version and SHA-256 of the exported bytes in its HTTP headers. For a fair deadline comparison, fetch it during the benchmark&apos;s collection window.</p>
      <p className="small" style={{ marginTop: 10 }}><Link href="/modelbook/squad-of-the-week">See the legal Free Hit Squad of the Week →</Link></p>
    </section>
    <section style={{ marginTop: 28 }}>
      <h2>Scored Gameweeks</h2>
      <p className="small muted" style={{ marginTop: 5 }}>MAE and RMSE use players with at least 1% ownership and a scheduled fixture, including players who scored zero. Rankings use every forecast player with a fixture. Lower error is better; higher top-15 overlap and ranking score are better.</p>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="table">
          <thead><tr><th>GW</th><th>Forecast timing</th><th>Points</th><th className="r">1% cohort</th><th className="r">MAE</th><th className="r">RMSE</th><th className="r">Top 15 overlap</th><th className="r">Local NDCG@15</th></tr></thead>
          <tbody>{report.weeks.map((week) => <tr key={week.gameweek}>
            <td><Link href={`/modelbook/reports/gw${week.gameweek}`}>GW{week.gameweek}</Link></td>
            <td>{week.captureWindow === "within-24-hours" ? `${week.hoursBeforeDeadline}h before deadline` : `${week.hoursBeforeDeadline}h early checkpoint`}</td>
            <td>{week.pointsStatus === "final" ? "Final" : "Provisional"}</td>
            <td className="r">{week.ownershipCohort.players}</td>
            <td className="r">{week.ownershipCohort.mae.toFixed(2)}</td>
            <td className="r">{week.ownershipCohort.rmse.toFixed(2)}</td>
            <td className="r">{week.ranking.top15Overlap}/15</td>
            <td className="r">{week.ranking.localLinearNdcg15?.toFixed(3) ?? "—"}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>The local NDCG score uses nonnegative actual points as linear gain. The benchmark has not published its exact gain and tie rules, so this number should not be treated as its official NDCG. GW6 was captured more than 24 hours before deadline and is not a like-for-like last-day entry.</p>
    </section>
    <section className="card" style={{ marginTop: 28 }}>
      <h2>What the comparison covers</h2>
      <p className="muted" style={{ marginTop: 7 }}>GW7 is left out because its forecast was rebuilt after the deadline. GW4 has no frozen ownership field for the same cohort filter. The historical GW5 source was provisionally scored; its points may be revised by the official feed. Older source hashes refer to the original export bytes and cannot be independently recomputed from the embedded JSON. Future automatic locks are rehashed before analysis.</p>
      <p className="muted" style={{ marginTop: 7 }}>The <Link href="/modelbook/squad-of-the-week">Squad of the Week</Link> solves the published £100m Free Hit selection with the specified captain and bench weights and scores completed weeks with official player points. FPL Bench&apos;s own collection time, solver tie-breaking and published score remain authoritative for its leaderboard.</p>
      <p className="small" style={{ marginTop: 12 }}><a href="https://www.fplbench.com/methodology">Read FPL Bench&apos;s methodology ↗</a></p>
    </section>
  </main>;
}
