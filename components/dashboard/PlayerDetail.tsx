"use client";

import { useEffect, useRef, useState } from "react";
import type { FplPlayer, FplTeam } from "@/lib/types";
import type { MarketProjection } from "@/lib/risk-v12";
import {
  money, officialAvailability, pct, positionLong, pts, range, riskBadge, signed, teamDisplayName, toneBadge,
} from "./format";
import styles from "./PlayerDetail.module.css";

export type PlayerRow = {
  player: FplPlayer;
  one: MarketProjection;
  three: MarketProjection;
  five: MarketProjection;
};

export type HorizonEvent = { id: number; name: string };

type Horizon = "one" | "three" | "five";
const horizonCount: Record<Horizon, number> = { one: 1, three: 3, five: 5 };

const componentLabels: Array<[keyof MarketProjection["components"], string]> = [
  ["appearance", "Playing time (appearance points)"],
  ["attack", "Goals and assists"],
  ["cleanSheet", "Clean sheets and goals conceded"],
  ["saves", "Saves"],
  ["defensiveContribution", "Defensive contribution"],
  ["bonus", "Bonus"],
  ["discipline", "Cards"],
  ["empiricalAnchor", "Blend with past points record"],
  ["calibrationAdjustment", "Position calibration adjustment"],
];

type Props = {
  row: PlayerRow;
  team?: FplTeam;
  events: HorizonEvent[];
  marketPriorAvailable: boolean;
  initialHorizon?: Horizon;
  onClose: () => void;
};

export default function PlayerDetail({ row, team, events, marketPriorAvailable, initialHorizon = "one", onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [horizon, setHorizon] = useState<Horizon>(initialHorizon);
  const forecast = row[horizon];
  const count = horizonCount[horizon];
  const dist = forecast.distribution;
  const availability = officialAvailability(row.player);
  const nextMinutes = row.one.minutesByFixture[0];
  const span = events.length
    ? count === 1 ? events[0].name : `${events[0].name}–${events[Math.min(count, events.length) - 1].name.replace(/^Gameweek /, "")}`
    : `${count} Gameweek${count === 1 ? "" : "s"}`;
  const additive = componentLabels.map(([key, label]) => [label, forecast.components[key] ?? 0] as const);
  const marketAdjustment = forecast.components.sportsbookMarket ?? 0;

  // Focus management: trap Tab inside, close on Escape, restore focus on close.
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const panel = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>("button, a[href], input, select, [tabindex='0']"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
      prior?.focus();
    };
  }, [onClose]);

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="player-detail-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="dialog-close" onClick={onClose} aria-label="Close player details">×</button>

        <header className={styles.head}>
          <h2 id="player-detail-title">{row.player.first_name} {row.player.second_name}</h2>
          <p className="muted">
            {teamDisplayName(team) || "Unknown club"} · {positionLong(row.player.element_type)} · {money(row.player.now_cost)} · {row.player.selected_by_percent}% owned
          </p>
          <div className={styles.availability}>
            <span className={toneBadge(availability.tone)}>Official FPL status: {availability.label}</span>
          </div>
          {row.player.news && <p className={styles.news}><strong>Official FPL news:</strong> {row.player.news}</p>}
        </header>

        <div className="row-between" style={{ marginTop: 18 }}>
          <div className="segmented" role="group" aria-label="Forecast horizon">
            {(["one", "three", "five"] as Horizon[]).map((h) => (
              <button key={h} type="button" aria-pressed={horizon === h} onClick={() => setHorizon(h)}>
                {horizonCount[h]} GW
              </button>
            ))}
          </div>
          <span className="muted small">Forecast for {span}</span>
        </div>

        <div className="stats" style={{ marginTop: 12 }}>
          <div className="stat">
            <span className="label">Expected points</span>
            <div className="stat-value">{pts(forecast.expected)}</div>
            <div className="stat-note">average across simulated outcomes</div>
          </div>
          <div className="stat">
            <span className="label">Median</span>
            <div className="stat-value">{pts(dist?.median)}</div>
            <div className="stat-note">half of outcomes fall below</div>
          </div>
          <div className="stat">
            <span className="label">Likely range (p10–p90)</span>
            <div className="stat-value">{range(dist?.p10, dist?.p90)}</div>
            <div className="stat-note">8 in 10 outcomes; not a min or max</div>
          </div>
        </div>

        <dl className={styles.qualities}>
          <div>
            <dt>Risk <span className={riskBadge(forecast.risk)}>{forecast.risk}</span></dt>
            <dd>How wide the outcome range is relative to the expectation.</dd>
          </div>
          <div>
            <dt>Confidence <span className="badge">{forecast.confidence}</span></dt>
            <dd>How strong the supporting evidence is. Not a probability of being right.</dd>
          </div>
          <div>
            <dt>Data quality <span className="badge">{forecast.dataQuality} / 100</span></dt>
            <dd>A coverage score for minutes, history and fixture inputs. Not an accuracy percentage.</dd>
          </div>
        </dl>

        <section className={styles.section}>
          <h3>Fixtures in this forecast</h3>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="table">
              <thead><tr><th>Gameweek</th><th>Opponent</th><th className="r">Projected points</th></tr></thead>
              <tbody>
                {forecast.fixtureLabels.map((label, index) => {
                  const event = events[index];
                  const blank = label === "BLANK";
                  return (
                    <tr key={index}>
                      <td>{event?.name ?? "Not yet scheduled"}</td>
                      <td>
                        {!event ? <span className="muted">No published Gameweek</span>
                          : blank ? <span className="muted">No fixture (blank Gameweek)</span>
                            : label.includes(" + ") ? <>{label} <span className="badge badge-info">Double Gameweek</span></>
                              : label}
                      </td>
                      <td className="r">{event ? pts(forecast.fixtureMeans[index]) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>(H) home, (A) away.</p>
        </section>

        {dist && (
          <section className={styles.section}>
            <h3>Chance of each points total over {count === 1 ? "this Gameweek" : `${count} Gameweeks`}</h3>
            <div className={styles.bands}>
              {([
                ["0–2 pts", dist.bands.bust],
                ["3–5 pts", dist.bands.floor],
                ["6–9 pts", dist.bands.middle],
                ["10+ pts", dist.bands.haul],
              ] as const).map(([label, value]) => (
                <div key={label}>
                  <span className="label">{label}</span>
                  <strong className="num">{pct(value)}</strong>
                  <div className="bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
                </div>
              ))}
            </div>
            {count > 1 && <p className="muted small" style={{ marginTop: 6 }}>These totals cover all {count} Gameweeks combined, so 10+ here is not a single-week haul.</p>}
          </section>
        )}

        <section className={styles.section}>
          <h3>Where the expected points come from</h3>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="table">
              <tbody>
                {additive.map(([label, value]) => (
                  <tr key={label}><td>{label}</td><td className="r">{signed(value, 2)}</td></tr>
                ))}
                {Math.abs(marketAdjustment) > 0.005 && (
                  <tr><td>Betting-market prior adjustment</td><td className="r">{signed(marketAdjustment, 2)}</td></tr>
                )}
                <tr className={styles.totalRow}><td>Expected points</td><td className="r">{pts(forecast.expected, 2)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>
            Fixture difficulty is already built into the rows above. Its estimated effect for this horizon
            is {signed(forecast.components.fixtureDifficulty, 2)} points — shown for context, not added again.
            {Math.abs(forecast.components.calibrationAdjustment) > 0.005
              ? " Position calibration is learned from historical walk-forward forecasts and applied once to each Gameweek estimate."
              : " Position calibration made no material change to this forecast."}
          </p>
        </section>

        <section className={styles.section}>
          <h3>Playing time{events[0] ? ` · ${events[0].name}` : ""}</h3>
          {nextMinutes && row.one.fixtureLabels[0] !== "BLANK" ? (
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Expected minutes</dt><dd>{Math.round(nextMinutes.expected)} (range {Math.round(nextMinutes.p10)}–{Math.round(nextMinutes.p90)})</dd>
              <dt>Model: chance of starting</dt><dd>{pct(nextMinutes.startProbability * 100)}</dd>
              <dt>Model: chance of a substitute appearance</dt><dd>{pct(nextMinutes.cameoProbability * 100)}</dd>
              <dt>Official FPL chance of playing</dt><dd>{row.player.chance_of_playing_next_round == null ? "Not published (no flag)" : `${row.player.chance_of_playing_next_round}%`}</dd>
            </dl>
          ) : (
            <p className="muted" style={{ marginTop: 8 }}>No fixture in the next Gameweek, so no playing time is projected.</p>
          )}
          <p className="muted small" style={{ marginTop: 8 }}>
            The model&apos;s starting estimate and FPL&apos;s official chance of playing measure different things and can disagree.
          </p>
        </section>

        <p className="muted small" style={{ marginTop: 18 }}>
          {forecast.sportsbook.applied
            ? `A betting-market prior was applied at ${(forecast.sportsbook.effectiveWeight * 100).toFixed(1)}% effective weight.`
            : marketPriorAvailable
              ? "A betting-market feed is connected but carries no weight in this forecast."
              : "Core model only: no betting-market prior was applied."}
          {dist ? ` Range and chances come from ${dist.simulations.toLocaleString()} simulated outcomes.` : ""}
        </p>
      </div>
    </div>
  );
}
