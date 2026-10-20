import Link from "next/link";
import { notFound } from "next/navigation";
import ModelbookNav from "@/components/modelbook/ModelbookNav";
import { ARCHIVED_GAMEWEEKS, CURRENT_GAMEWEEK, POSITION_LABEL, POSITION_ORDER, archivedReport } from "@/lib/modelbook";
import { pageMetadata } from "@/lib/metadata";
import styles from "@/components/modelbook/Modelbook.module.css";

type Params = { params: Promise<{ gw: string }> };

function parseGameweek(slug: string) {
  const match = /^gw(\d+)$/.exec(slug);
  return match ? Number(match[1]) : null;
}

export function generateStaticParams() {
  return ARCHIVED_GAMEWEEKS.map((gw) => ({ gw: `gw${gw}` }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Params) {
  const gw = parseGameweek((await params).gw);
  return pageMetadata({
    title: `FPL Prism Modelbook — GW${gw} report`,
    description: `How FPL Prism's published GW${gw} forecasts compared with official FPL points: average error, bias by position and the largest misses.`,
    path: `/modelbook/reports/gw${gw}`,
  });
}

const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}`;

function formatDate(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(value));
}

export default async function ModelbookReportPage({ params }: Params) {
  const gw = parseGameweek((await params).gw);
  const archived = gw == null ? null : archivedReport(gw);
  if (!archived) notFound();
  const { report, meta } = archived;
  const active = report.activeCohort;
  const positions = POSITION_ORDER.filter((position) => report.byPosition[position]);
  const hash = report.snapshotHash ?? meta?.contentHash;
  const isReconstructed = report.forecastProvenance === "reconstructed-after-deadline";
  const isPredeadlinePublished = report.forecastProvenance === "predeadline-published";
  const isPredeadlineFallback = report.forecastProvenance === "predeadline-fallback";

  return (
    <main className="page">
      <ModelbookNav active={report.gameweek} />

      <div className="page-head">
        <div>
          <h1>GW{report.gameweek} forecast report</h1>
          <p className="lead">
            {isReconstructed
              ? `A reconstructed GW${report.gameweek} forecast scored against official FPL points.`
              : isPredeadlineFallback
                ? `The latest saved GW${report.gameweek} checkpoint from before the deadline, scored against official FPL points.`
              : isPredeadlinePublished
                ? `The GW${report.gameweek} forecast published before the deadline, scored against official FPL points.`
                : `The forecasts frozen at the GW${report.gameweek} deadline, scored against official FPL points.`} The forecast baseline stays fixed when the model changes later.
            {!report.final && " FPL's points are provisional and this report will update until every fixture is marked finished."}
          </p>
          {report.provenanceNote && <p className="small muted" style={{ marginTop: 10 }}>{report.provenanceNote}</p>}
        </div>
        <span className={`badge ${!report.final ? "badge-warn" : "badge-good"}`}>
          {isReconstructed ? "Audit" : !report.final ? "Provisional" : isPredeadlineFallback ? "Checkpoint" : isPredeadlinePublished ? "Published" : "Final"}
        </span>
      </div>

      <section className="stats" aria-label="Headline accuracy for players who played">
        <div className="stat">
          <span className="label">Average miss</span>
          <span className="stat-value">{active.mae.toFixed(2)} pts</span>
          <span className="stat-note">mean absolute error</span>
        </div>
        <div className="stat">
          <span className="label">Within 2 points</span>
          <span className="stat-value">{active.within2.toFixed(1)}%</span>
          <span className="stat-note">of players who played</span>
        </div>
        <div className="stat">
          <span className="label">Bias</span>
          <span className="stat-value">{signed(active.bias)}</span>
          <span className="stat-note">{active.bias >= 0 ? "scored more than forecast on average" : "scored less than forecast on average"}</span>
        </div>
        <div className="stat">
          <span className="label">Players scored</span>
          <span className="stat-value">{active.count}</span>
          <span className="stat-note">recorded minutes</span>
        </div>
      </section>
      <p className="small muted" style={{ marginTop: 8 }}>
        Headline figures cover only players who played, since forecasting zero for a benched player is easy and would flatter the numbers.
        Across all {report.overall.count} players the average miss was {report.overall.mae.toFixed(2)} pts.
      </p>

      <div className="grid-2" style={{ marginTop: 24, alignItems: "start" }}>
        <section>
          <h2>By position</h2>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="table">
              <thead>
                <tr><th>Position</th><th className="r hide-sm">Players</th><th className="r">Avg miss</th><th className="r hide-sm">RMSE</th><th className="r">Bias</th><th className="r">Within 2</th></tr>
              </thead>
              <tbody>
                {positions.map((position) => {
                  const values = report.byPosition[position];
                  return (
                    <tr key={position}>
                      <td>{POSITION_LABEL[position] ?? position}</td>
                      <td className="r hide-sm">{values.count}</td>
                      <td className="r">{values.mae.toFixed(2)}</td>
                      <td className="r hide-sm">{values.rmse.toFixed(2)}</td>
                      <td className="r">{signed(values.bias)}</td>
                      <td className="r">{values.within2.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {report.adjustmentsForNextGw && (
            <p className="small muted" style={{ marginTop: 8 }}>
              Calibration applied to the following Gameweek:{" "}
              {POSITION_ORDER.filter((p) => report.adjustmentsForNextGw?.[p] != null).map((p) => `${p} ${signed(report.adjustmentsForNextGw![p])}`).join(" · ")} pts.
            </p>
          )}
          {report.bestPredictions?.length ? (
            <div style={{ marginTop: 24 }}>
              <h2>{report.bestPredictionsTitle ?? "Best calls"}</h2>
              <p className="small muted" style={{ marginTop: 4 }}>
                {report.bestPredictionsNote ?? "High-output scores where the forecast stayed close to the official result."}
              </p>
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table className="table">
                  <thead>
                    <tr><th>Player</th><th>Pos</th><th className="r">Forecast</th><th className="r">Actual</th><th className="r">Gap</th></tr>
                  </thead>
                  <tbody>
                    {report.bestPredictions.map((row) => (
                      <tr key={`${row.name}-${row.position}`}>
                        <td>{row.name}</td>
                        <td>{row.position}</td>
                        <td className="r">{row.projected.toFixed(1)}</td>
                        <td className="r"><strong>{row.actual}</strong></td>
                        <td className="r">{row.error > 0 ? "+" : ""}{row.error.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </section>

        <section>
          <h2>Largest misses</h2>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="table">
              <thead>
                <tr><th>Player</th><th>Pos</th><th className="r">Forecast</th><th className="r">Actual</th><th className="r">Miss</th></tr>
              </thead>
              <tbody>
                {report.largestMisses.map((row) => (
                  <tr key={`${row.name}-${row.position}`}>
                    <td>{row.name}</td>
                    <td>{row.position}</td>
                    <td className="r">{row.projected.toFixed(1)}</td>
                    <td className="r">{row.actual}</td>
                    <td className="r">{(row.absoluteError ?? Math.abs(row.error)).toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <details className="disclosure" style={{ marginTop: 24 }}>
        <summary>What these measures mean</summary>
        <div className="disclosure-body prose small">
          <ul>
            <li><strong>Average miss (MAE)</strong>: the typical gap between forecast and actual points, ignoring direction.</li>
            <li><strong>RMSE</strong>: like the average miss, but big misses count for more.</li>
            <li><strong>Bias</strong>: actual minus forecast on average. Positive means players outscored their forecasts.</li>
            <li><strong>Within 2</strong>: share of players whose actual score was within 2 points of the forecast.</li>
          </ul>
        </div>
      </details>

      <details className="disclosure" style={{ marginTop: 8 }}>
        <summary>Snapshot and data source</summary>
        <div className="disclosure-body">
          <dl className="kv">
            <dt>Model version</dt><dd>{report.modelVersion}</dd>
            {report.forecastProvenance && <><dt>Forecast source</dt><dd>{report.forecastProvenance === "reconstructed-after-deadline" ? "Reconstructed after the deadline" : report.forecastProvenance === "predeadline-fallback" ? "Latest saved pre-deadline checkpoint" : report.forecastProvenance === "predeadline-published" ? "Published pre-deadline export" : "Frozen deadline export"}</dd></>}
            {report.training && <><dt>Training window</dt><dd>Results through GW{report.training.trainedThroughGameweek}; {report.training.validation}.</dd></>}
            {meta && <><dt>{isReconstructed ? "Reconstruction locked" : isPredeadlinePublished ? "Published" : isPredeadlineFallback ? "Checkpoint captured" : "Frozen"}</dt><dd>{formatDate(meta.lockedAt)}{meta.lockedBeforeDeadline ? ", before the deadline" : ""}</dd></>}
            <dt>Report generated</dt><dd>{formatDate(report.generatedAt)}</dd>
            {report.actualsSource && <><dt>Points source</dt><dd>{report.actualsSource}</dd></>}
            {report.actualsFinality && (
              <><dt>Result status</dt><dd>{report.actualsFinality.finishedProvisional} of {report.actualsFinality.fixtureCount} fixtures provisionally finished when scored</dd></>
            )}
            {hash && <><dt>Snapshot fingerprint</dt><dd className={styles.hash}>{hash}</dd></>}
          </dl>
        </div>
      </details>

      <p className="small muted" style={{ marginTop: 24 }}>
        This report is historical evidence for GW{report.gameweek}, not a test of the current model. <Link href="/modelbook">See the live GW{CURRENT_GAMEWEEK} forecasts</Link>.
      </p>
    </main>
  );
}
