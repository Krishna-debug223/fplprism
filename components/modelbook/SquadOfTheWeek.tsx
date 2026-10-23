"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ARCHIVED_GAMEWEEKS, CURRENT_GAMEWEEK } from "@/lib/modelbook";
import ModelbookNav from "./ModelbookNav";
import styles from "./SquadOfTheWeek.module.css";

type Pick = {
  id: number; name: string; team: string; position: string; price: number;
  projected: number; role: string; multiplier: number;
};
export type SquadOfTheWeekPayload = {
  gameweek: number; modelVersion: string; generatedAt: string; deadlineTime: string;
  snapshotHash: string; status: "live-preview" | "frozen";
  lockMode: string | null;
  squad: { picks: Pick[]; totalPrice: number; weightedExpectedPoints: number; modelStatus: string };
  actual: { score: { points: number; countedIds: number[]; substitutedIds: number[]; captainBonusId: number | null }; players: Array<{ id: number; points: number; minutes: number }>; fetchedAt: string } | null;
};

const prettyRole: Record<string, string> = {
  captain: "Captain", vice: "Vice-captain", starter: "Starter", benchGoalkeeper: "Bench GK",
  bench1: "Bench 1", bench2: "Bench 2", bench3: "Bench 3",
};
const positionOrder = ["GKP", "DEF", "MID", "FWD"];
const money = (tenths: number) => `£${(tenths / 10).toFixed(1)}m`;
const date = (value: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(value));

function PlayerCard({ pick, actual }: { pick: Pick; actual: SquadOfTheWeekPayload["actual"] }) {
  const points = actual?.score.countedIds.includes(pick.id) ? "Counted" : actual ? "Bench / absent" : null;
  const substituted = actual?.score.substitutedIds.includes(pick.id);
  const actualPlayer = actual?.players.find((player) => player.id === pick.id);
  return <div className={styles.player}>
    <div className={styles.playerTop}>
      <span className={styles.position}>{pick.position}</span>
      <strong>{pick.name}</strong>
      {pick.role === "captain" && <span className={styles.armband}>C</span>}
      {pick.role === "vice" && <span className={styles.armband}>V</span>}
    </div>
    <span className={styles.meta}>{pick.team} · {money(pick.price)} · {prettyRole[pick.role]}</span>
    <span className={styles.forecast}>{pick.projected.toFixed(2)} <small>xPts</small></span>
    {points && <span className={styles.meta}>{actualPlayer?.points ?? 0} actual pts · {substituted ? "Auto-sub on" : points}</span>}
  </div>;
}

export default function SquadOfTheWeek({ initial }: { initial: SquadOfTheWeekPayload | null }) {
  const [gameweek, setGameweek] = useState(CURRENT_GAMEWEEK);
  const [data, setData] = useState<SquadOfTheWeekPayload | null>(initial);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);
  const initialConsumed = useRef(Boolean(initial));
  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setRefreshing(true);
    try {
      const response = await fetch(`/api/squad-of-the-week?event=${gameweek}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "The squad is temporarily unavailable.");
      if (currentRequest !== requestId.current) return;
      setData(payload as SquadOfTheWeekPayload);
      setError("");
    } catch (cause) {
      if (currentRequest !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : "The squad is temporarily unavailable.");
    } finally {
      if (currentRequest === requestId.current) setRefreshing(false);
    }
  }, [gameweek]);

  useEffect(() => {
    if (initialConsumed.current) { initialConsumed.current = false; return; }
    setData(null);
    setError("");
    void load();
  }, [load]);
  const starters = data?.squad.picks.filter((pick) => ["captain", "vice", "starter"].includes(pick.role)) ?? [];
  const bench = data?.squad.picks.filter((pick) => pick.role.startsWith("bench")) ?? [];
  bench.sort((a, b) => ["benchGoalkeeper", "bench1", "bench2", "bench3"].indexOf(a.role) - ["benchGoalkeeper", "bench1", "bench2", "bench3"].indexOf(b.role));
  const hoursBeforeDeadline = data ? (Date.parse(data.deadlineTime) - Date.parse(data.generatedAt)) / 3_600_000 : null;

  return <main className="page">
    <ModelbookNav active="squad" />
    <div className="page-head">
      <div>
        <h1>Squad of the Week</h1>
        <p className="lead">The 15-player Free Hit squad that maximizes FPL Prism&apos;s weighted GW{gameweek} forecast under the published benchmark rules.</p>
      </div>
      {data && <span className={`badge ${data.status === "frozen" ? "badge-good" : "badge-info"}`}>{data.status === "frozen" ? "Archived forecast" : "Live preview"}</span>}
    </div>

    <div className="field" style={{ maxWidth: 230, marginBottom: 18 }}>
      <label htmlFor="squad-gameweek">Gameweek</label>
      <select id="squad-gameweek" className="select" value={gameweek} onChange={(event) => setGameweek(Number(event.target.value))}>
        <option value={CURRENT_GAMEWEEK}>GW{CURRENT_GAMEWEEK} · current</option>
        {ARCHIVED_GAMEWEEKS.filter((gw) => gw >= 5 && gw !== 7).map((gw) => <option key={gw} value={gw}>GW{gw} · archive</option>)}
      </select>
    </div>

    {error && <div className="notice notice-bad" role="alert"><strong>Squad unavailable.</strong> {error} <button className="link-button" onClick={() => void load()}>Try again</button></div>}
    {!data && !error && <div className="empty" role="status">Calculating the legal squad…</div>}
    {data && <>
      <section className="stats" aria-label="Squad summary">
        <div className="stat"><span className="label">Budget used</span><span className="stat-value">{money(data.squad.totalPrice)}</span><span className="stat-note">of £100.0m</span></div>
        <div className="stat"><span className="label">Weighted forecast</span><span className="stat-value">{data.squad.weightedExpectedPoints.toFixed(2)}</span><span className="stat-note">selection score · role weights applied</span></div>
        <div className="stat"><span className="label">Optimization</span><span className="stat-value">{data.squad.modelStatus}</span><span className="stat-note">legal 15-player solution</span></div>
        <div className="stat"><span className="label">Actual squad score</span><span className="stat-value">{data.actual ? data.actual.score.points : "—"}</span><span className="stat-note">{data.actual ? "official points · captain and auto-subs" : "available after the Gameweek is finished"}</span></div>
      </section>
      <div className="row-between" style={{ marginTop: 15, alignItems: "start" }}>
        <p className="small muted">Forecast generated {date(data.generatedAt)} · model {data.modelVersion}. {data.status === "live-preview" ? "This squad can change before the deadline; the frozen version will be the public scoring baseline." : `Built from the archived predeadline Modelbook forecast${hoursBeforeDeadline != null && hoursBeforeDeadline > 24 ? `, captured ${Math.round(hoursBeforeDeadline)} hours before the deadline` : ""}.`}</p>
        <button className="btn btn-sm" type="button" onClick={() => void load()} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh squad"}</button>
      </div>
      <div className={styles.layout}>
        <section className="card">
          <h2>Starting XI</h2>
          <p className="small muted" style={{ marginTop: 4 }}>The captain&apos;s official points count twice. The vice takes over only if the captain plays no minutes.</p>
          {positionOrder.map((position) => <div className={styles.group} key={position}>
            <h3>{position}</h3>
            <div className={styles.players}>{starters.filter((pick) => pick.position === position).sort((a, b) => b.projected - a.projected).map((pick) => <PlayerCard key={pick.id} pick={pick} actual={data.actual} />)}</div>
          </div>)}
        </section>
        <aside className="card">
          <h2>Bench order</h2>
          <p className="small muted" style={{ marginTop: 4 }}>Outfield substitutes enter in this order when a starter misses the whole Gameweek and formation rules permit it.</p>
          <div className={styles.bench}>{bench.map((pick) => <PlayerCard key={pick.id} pick={pick} actual={data.actual} />)}</div>
          <h2 style={{ marginTop: 26 }}>The selection rules</h2>
          <ul className={styles.rules}>
            <li>15 players: 2 GKP, 5 DEF, 5 MID, 3 FWD.</li>
            <li>£100m maximum; at most three from each club.</li>
            <li>Starting XI: one goalkeeper, at least three defenders and one forward.</li>
            <li>Forecast weights: captain ×2, vice ×1.0322; other starters ×1; bench GK ×0.0194; outfield bench ×0.2603, ×0.0751, ×0.0165.</li>
          </ul>
        </aside>
      </div>
      <section className="card" style={{ marginTop: 22 }}>
        <h2>Independent comparison</h2>
        <p className="muted" style={{ marginTop: 7 }}>Every choice above comes from the same public forecast pool as the <a href={`/api/benchmark/forecast?event=${gameweek}`}>GW{gameweek} CSV</a> and <a href={`/api/ledger/snapshot?event=${gameweek}`}>complete JSON</a>. The snapshot fingerprint is <code className={styles.hash}>{data.snapshotHash}</code>.</p>
        <p className="small muted" style={{ marginTop: 7 }}>FPL Bench collects its own copy within 24 hours before deadline; its published lineup and score are authoritative for its leaderboard. This page uses the same published constraints and role weights, but its live preview may change after their collection.</p>
      </section>
    </>}
  </main>;
}
