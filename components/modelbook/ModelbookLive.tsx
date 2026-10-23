"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatClock, formatDeadline, riskBadge, timeUntil } from "@/components/dashboard/format";
import {
  ARCHIVED_GAMEWEEKS,
  CURRENT_GAMEWEEK,
  SNAPSHOT_URL,
  actualPointsFor,
  ledgerStatus,
  loadCurrentLedger,
  loadLivePoints,
  type Ledger,
  type LedgerRow,
  type LivePoints,
} from "@/lib/modelbook";
import ModelbookNav from "./ModelbookNav";
import styles from "./Modelbook.module.css";

type Sort = "projected" | "actual" | "quality" | "ownership" | "price" | "name";

const PAGE_SIZE = 50;
const EMPTY_LIVE: LivePoints = { available: false, fetchedAt: null, players: {} };

export default function ModelbookLive() {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState("");
  const [live, setLive] = useState<LivePoints>(EMPTY_LIVE);
  const [refreshing, setRefreshing] = useState(false);
  const [, setTick] = useState(0);

  const [query, setQuery] = useState("");
  const [position, setPosition] = useState("");
  const [risk, setRisk] = useState("");
  const [sort, setSort] = useState<Sort>("projected");
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      setLedger(await loadCurrentLedger());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The projection export couldn't be loaded.");
    }
  }, []);

  const refreshLive = useCallback(async () => {
    setRefreshing(true);
    setLive(await loadLivePoints());
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
    void refreshLive();
  }, [load, refreshLive]);

  // Poll official points: quickly once matches can be under way, slowly before
  // the deadline, and rarely while the tab is hidden.
  const deadline = ledger?.data.deadlineTime ?? null;
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      const beforeDeadline = deadline != null && Date.now() < Date.parse(deadline);
      const delay = document.hidden ? 120_000 : beforeDeadline ? 60_000 : 15_000;
      timer = window.setTimeout(async () => {
        await refreshLive();
        schedule();
      }, delay);
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (!document.hidden) void refreshLive();
      schedule();
    };
    schedule();
    const clock = window.setInterval(() => setTick((value) => value + 1), 30_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [deadline, refreshLive]);

  const playedCount = useMemo(
    () => Object.values(live.players).filter((player) => player.played || player.minutes > 0).length,
    [live],
  );
  const actualsLive = live.available && playedCount > 0;
  const effectiveSort: Sort = sort === "actual" && !actualsLive ? "projected" : sort;

  const filtered = useMemo(() => {
    const rows = ledger?.data.rows ?? [];
    const q = query.trim().toLocaleLowerCase();
    const matches = rows.filter((row) => {
      const haystack = `${row.name} ${row.firstName ?? ""} ${row.secondName ?? ""} ${row.team}`.toLocaleLowerCase();
      return (!q || haystack.includes(q)) && (!position || row.position === position) && (!risk || row.risk === risk);
    });
    const byProjected = (a: LedgerRow, b: LedgerRow) => Number(b.projected || 0) - Number(a.projected || 0);
    return matches.sort((a, b) => {
      if (effectiveSort === "actual") {
        const actualA = actualPointsFor(a, live);
        const actualB = actualPointsFor(b, live);
        if (actualA == null && actualB == null) return byProjected(a, b);
        if (actualA == null) return 1;
        if (actualB == null) return -1;
        return actualB - actualA || byProjected(a, b);
      }
      if (effectiveSort === "quality") return Number(b.dataQuality || 0) - Number(a.dataQuality || 0);
      if (effectiveSort === "ownership") return Number(b.ownership || 0) - Number(a.ownership || 0);
      if (effectiveSort === "price") return Number(b.price || 0) - Number(a.price || 0);
      if (effectiveSort === "name") return a.name.localeCompare(b.name);
      return byProjected(a, b);
    });
  }, [ledger, query, position, risk, effectiveSort, live]);

  const visible = showAll ? filtered : filtered.slice(0, PAGE_SIZE);
  const status = ledger ? ledgerStatus(ledger) : null;
  const filtersActive = Boolean(query || position || risk);
  const countdown = ledger?.mode === "prelock" ? timeUntil(ledger.data.deadlineTime) : null;
  const latestReport = ARCHIVED_GAMEWEEKS[0];
  const missingCompletedGameweeks = [7].filter((gameweek) =>
    gameweek < CURRENT_GAMEWEEK && !ARCHIVED_GAMEWEEKS.includes(gameweek),
  );

  return (
    <main className="page">
      <ModelbookNav active="current" />

      <div className="page-head">
        <div>
          <h1>Modelbook</h1>
          <p className="lead">
            We publish forecasts before the deadline, freeze the available snapshot, then score it against official points — misses included. GW7 is labelled as an audit reconstruction because its original deadline snapshot is unavailable.
            {latestReport ? <> The latest scored week is <Link href={`/modelbook/reports/gw${latestReport}`}>GW{latestReport}</Link>.</> : null}
          </p>
        </div>
      </div>

      {missingCompletedGameweeks.length > 0 && (
        <div className="notice notice-warn" role="status" style={{ marginTop: 16 }}>
          <strong>GW{missingCompletedGameweeks.join(", GW")} forecast archive is awaiting its original snapshot.</strong>{" "}
          The pre-deadline export is not available in the repository or live deployment, so we won&apos;t replace it with projections recalculated after the deadline. The current table is for GW{CURRENT_GAMEWEEK}; verified reports remain available below.
        </div>
      )}

      <section className="card">
        <div className="row-between">
          <h2>GW{CURRENT_GAMEWEEK} forecasts</h2>
          {status && <span className={`badge ${status.tone === "good" ? "badge-good" : status.tone === "warn" ? "badge-warn" : "badge-info"}`}>{status.label}</span>}
        </div>
        {status && <p className="muted small" style={{ marginTop: 4 }}>{status.detail}</p>}
        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>Deadline</dt>
          <dd>{ledger ? <>{formatDeadline(ledger.data.deadlineTime)}{countdown ? ` · ${countdown}` : ""}</> : "Loading…"}</dd>
          <dt>Players</dt>
          <dd>{ledger ? ledger.data.playerCount ?? ledger.data.rows.length : "Loading…"}</dd>
          <dt>Official points</dt>
          <dd>
            {actualsLive
              ? `${playedCount} players have played · updated ${formatClock(live.fetchedAt)}`
              : live.available || !ledger || ledger.mode === "prelock"
                ? "Appear here once matches start"
                : "Temporarily unavailable — retrying automatically"}
          </dd>
        </dl>
        <details className="disclosure" style={{ marginTop: 12 }}>
          <summary>Snapshot details</summary>
          <div className="disclosure-body">
            <dl className="kv">
              <dt>Model version</dt><dd>{ledger?.data.modelVersion ?? "—"}</dd>
              <dt>{ledger?.mode === "locked" ? "Frozen" : "Generated"}</dt>
              <dd>{ledger ? formatDeadline(ledger.mode === "locked" ? ledger.lockedAt : ledger.data.generatedAt) : "—"}</dd>
              {ledger?.data.training && (
                <>
                  <dt>Training</dt>
                  <dd>Uses results through GW{ledger.data.training.trainedThroughGameweek}. {ledger.data.training.method}. Validation: {ledger.data.training.validation}.</dd>
                </>
              )}
              <dt>Fingerprint</dt>
              <dd className={styles.hash}>{ledger?.contentHash ?? "Published when the deadline snapshot is frozen"}</dd>
            </dl>
          </div>
        </details>
      </section>

      <section style={{ marginTop: 24 }} aria-labelledby="ledger-heading">
        <h2 id="ledger-heading">Player forecasts</h2>
        <p className="muted small" style={{ marginTop: 2 }}>
          Sorting and filtering only change the view; stored forecasts never change. A dash under Actual means no minutes yet.
        </p>
        <p className="muted small" style={{ marginTop: 6 }}>
          Independent comparisons can use the <a href={SNAPSHOT_URL}>complete GW{CURRENT_GAMEWEEK} JSON export</a>, including FPL player IDs, club, position, price and projected points. Before the deadline it can update with new information; the deadline snapshot is frozen for scoring.
        </p>

        <div className={`${styles.filters} card card-tight`} style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="mb-search">Search</label>
            <input id="mb-search" className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Player or club" />
          </div>
          <div className="field">
            <label htmlFor="mb-position">Position</label>
            <select id="mb-position" className="select" value={position} onChange={(event) => setPosition(event.target.value)}>
              <option value="">All</option>
              <option value="GKP">Goalkeepers</option>
              <option value="DEF">Defenders</option>
              <option value="MID">Midfielders</option>
              <option value="FWD">Forwards</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="mb-risk">Risk</label>
            <select id="mb-risk" className="select" value={risk} onChange={(event) => setRisk(event.target.value)}>
              <option value="">All</option>
              <option value="Low">Low</option>
              <option value="Medium">Medium</option>
              <option value="High">High</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="mb-sort">Sort by</label>
            <select id="mb-sort" className="select" value={effectiveSort} onChange={(event) => setSort(event.target.value as Sort)}>
              <option value="projected">Expected points</option>
              <option value="actual" disabled={!actualsLive}>Actual points{actualsLive ? "" : " (after kick-off)"}</option>
              <option value="quality">Data quality</option>
              <option value="ownership">Ownership</option>
              <option value="price">Price</option>
              <option value="name">Name</option>
            </select>
          </div>
        </div>

        {error ? (
          <div className="notice notice-bad" role="alert" style={{ marginTop: 12 }}>
            <strong>Forecasts unavailable.</strong> {error}{" "}
            <button type="button" className="link-button" onClick={() => void load()}>Try again</button>
          </div>
        ) : !ledger ? (
          <div className="empty" style={{ marginTop: 12 }}>Loading forecasts…</div>
        ) : filtered.length === 0 ? (
          <div className="empty" style={{ marginTop: 12 }}>
            No players match these filters.{" "}
            <button type="button" className="link-button" onClick={() => { setQuery(""); setPosition(""); setRisk(""); }}>Clear filters</button>
          </div>
        ) : (
          <>
            <div className={`table-wrap ${styles.sticky}`} style={{ marginTop: 12 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Pos</th>
                    <th className="r">Expected</th>
                    <th className="r">Actual</th>
                    <th className="r">Likely range</th>
                    <th className="r" title="Chance of 0–2 points / 10+ points">Blank / haul</th>
                    <th>Risk</th>
                    <th>Confidence</th>
                    <th className="r">Data quality</th>
                    <th className="r" title="Expected points relative to the spread of outcomes">Sharpe</th>
                    <th className="r">Price</th>
                    <th className="r">Owned</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => {
                    const actual = actualPointsFor(row, live);
                    const flagged = row.status !== "a" || (row.chanceOfPlayingThisRound != null && row.chanceOfPlayingThisRound < 100);
                    return (
                      <tr key={row.id}>
                        <td className={styles.playerCell}>
                          <strong>
                            {row.name}
                            {flagged && <span className={styles.flag} title={row.news || "Flagged by FPL"} aria-label={`Flagged: ${row.news || "availability doubt"}`}>!</span>}
                          </strong>
                          <span>{row.team} · {row.fixture}</span>
                        </td>
                        <td>{row.position}</td>
                        <td className="r strong">{Number(row.projected).toFixed(1)}</td>
                        <td className="r">{actual ?? "—"}</td>
                        <td className="r nowrap">{row.floor == null || row.ceiling == null ? "—" : `${Number(row.floor).toFixed(0)}–${Number(row.ceiling).toFixed(0)}`}</td>
                        <td className="r nowrap">{row.probabilities ? `${Math.round(Number(row.probabilities.bust ?? 0))}% / ${Math.round(Number(row.probabilities.haul ?? 0))}%` : "—"}</td>
                        <td><span className={`badge ${riskBadge(row.risk)}`}>{row.risk}</span></td>
                        <td>{row.confidence}</td>
                        <td className="r">{Math.round(Number(row.dataQuality || 0))}</td>
                        <td className="r">{row.sharpe == null ? "—" : Number(row.sharpe).toFixed(2)}</td>
                        <td className="r">£{(Number(row.price || 0) / 10).toFixed(1)}m</td>
                        <td className="r">{Number(row.ownership || 0).toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className={styles.tableFoot}>
              <span className="small muted">
                Showing {visible.length} of {filtered.length}{filtersActive ? " matching" : ""} players
              </span>
              <div className="row">
                {filtered.length > PAGE_SIZE && (
                  <button type="button" className="btn btn-sm" onClick={() => setShowAll((value) => !value)} aria-expanded={showAll}>
                    {showAll ? `Show top ${PAGE_SIZE}` : `Show all ${filtered.length}`}
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={() => void refreshLive()} disabled={refreshing}>
                  {refreshing ? "Refreshing…" : "Refresh points"}
                </button>
              </div>
            </div>
          </>
        )}
      </section>

      <details className="disclosure" style={{ marginTop: 24 }}>
        <summary>How to read this table</summary>
        <div className="disclosure-body prose small">
          <ul>
            <li><strong>Expected</strong>: average points across simulated outcomes for this Gameweek.</li>
            <li><strong>Likely range</strong>: 10th to 90th percentile; about 1 in 10 results fall on each side.</li>
            <li><strong>Blank / haul</strong>: chance of 0–2 points and of 10 or more.</li>
            <li><strong>Risk</strong> is how wide the range is. <strong>Confidence</strong> is how strong the evidence is. <strong>Data quality</strong> (0–100) is input coverage, not accuracy.</li>
            <li><strong>Sharpe</strong>: expected points relative to the spread; higher means steadier for the same average.</li>
            <li><strong>!</strong> marks a player flagged by FPL (injury, doubt or suspension). Hover for the official note.</li>
          </ul>
        </div>
      </details>
    </main>
  );
}
