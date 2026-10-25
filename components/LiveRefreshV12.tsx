"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { dashboardHref, dashboardView, dashboardViews, isPlainClick, showDashboardView, type DashboardView as Tab } from "@/lib/navigation";

import SquadPitch, { type SquadPitchPlayer } from "./SquadPitch";
import PlayerDetail, { type HorizonEvent } from "./dashboard/PlayerDetail";
import {
  chipStatus, compact, formatClock, formatDeadline, money, officialAvailability, positionShort,
  pts, range, riskBadge, signed, teamDisplayName, timeUntil, toneBadge,
} from "./dashboard/format";
import styles from "./LiveRefreshV12.module.css";
import type {
  BootstrapPayload,
  FplFixture,
  FplPlayer,
  HistoricalPayload,
  LivePointsPayload,
  ManagerPayload,
  ManagerPick,
} from "@/lib/types";
import type { SportsbookPayload } from "@/lib/sportsbook";
import {
  MODEL_VERSION,
  MINUTES_EVIDENCE_VALIDATION,
  POSITION_CALIBRATION,
  assessChips,
  projectPlayer,
  recommendJointTransferPlan,
  recommendReplacements,
  type MarketProjection,
  type Recommendation,
  type RiskMode,
} from "@/lib/risk-v12";
import { analyzePortfolioRisk } from "@/lib/portfolio-risk";
import { createClient as createSupabaseClient } from "@/lib/supabase/client";

type ProjectionRow = {
  player: FplPlayer;
  one: MarketProjection;
  three: MarketProjection;
  five: MarketProjection;
  value: number;
};
type LockedProjectionRow = {
  id: number;
  fixture: string;
  projected: number;
  volatility: number;
  risk: MarketProjection["risk"];
  confidence: MarketProjection["confidence"];
  dataQuality: number;
  floor: number;
  median: number;
  ceiling: number;
  sharpe: number;
  probabilities: NonNullable<MarketProjection["distribution"]>["bands"] | null;
  simulations: number | null;
  components: Partial<MarketProjection["components"]>;
};
type SquadItem = SquadPitchPlayer;
type Horizon = "one" | "three" | "five";
type MarketSort = "one" | "three" | "five" | "value" | "price" | "risk" | "sharpe" | "ownership";

const SAMPLE_TEAM_ID = "1";
const TRANSFER_HORIZON = 5;

const rankingPreferences: Record<RiskMode, { label: string; detail: string }> = {
  protect: { label: "Protect rank", detail: "Prefers replacements with a narrower outcome range." },
  balanced: { label: "Balanced", detail: "Weighs expected points and uncertainty evenly." },
  chase: { label: "Chase rank", detail: "Gives more weight to upside and tolerates a wider range." },
  mini: { label: "Mini-league", detail: "Slight preference for less-owned upside. Does not use your league data." },
};

const sortLabels: Record<MarketSort, string> = {
  five: "Expected points, 5 GW",
  three: "Expected points, 3 GW",
  one: "Expected points, next GW",
  value: "Value (5 GW points per £m)",
  sharpe: "Points-to-uncertainty, 5 GW",
  price: "Price (high to low)",
  risk: "Lowest risk, 5 GW",
  ownership: "Ownership",
};

const chipNames: Record<string, string> = { wildcard: "Wildcard", freehit: "Free Hit", bboost: "Bench Boost", "3xc": "Triple Captain" };

const riskRank: Record<MarketProjection["risk"], number> = { Low: 1, Medium: 2, High: 3 };
const horizonCount: Record<Horizon, number> = { one: 1, three: 3, five: 5 };

export default function LiveRefreshV12() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = dashboardView(searchParams.toString());
  const setTab = useCallback(
    (view: Tab) => showDashboardView(dashboardHref(view, searchParams.toString())),
    [searchParams],
  );

  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [fixtures, setFixtures] = useState<FplFixture[]>([]);
  const [history, setHistory] = useState<HistoricalPayload | null>(null);
  const [sportsbook, setSportsbook] = useState<SportsbookPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [feedError, setFeedError] = useState("");

  const [manager, setManager] = useState<ManagerPayload | null>(null);
  const [isSample, setIsSample] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [teamError, setTeamError] = useState("");
  const [loadingTeam, setLoadingTeam] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const [selectedOut, setSelectedOut] = useState<number[]>([]);
  const [freeTransfers, setFreeTransfers] = useState(1);
  const [decisionContext, setDecisionContext] = useState<RiskMode>("balanced");
  const [detail, setDetail] = useState<{ row: ProjectionRow; horizon: Horizon } | null>(null);
  const [teamMode, setTeamMode] = useState<"next" | "result">("next");

  const [marketQuery, setMarketQuery] = useState("");
  const [marketPosition, setMarketPosition] = useState(0);
  const [marketTeam, setMarketTeam] = useState(0);
  const [marketMaxPrice, setMarketMaxPrice] = useState<number | null>(null);
  const [marketSort, setMarketSort] = useState<MarketSort>("five");
  const [marketHorizon, setMarketHorizon] = useState<Horizon>("five");
  const [marketVisibleCount, setMarketVisibleCount] = useState(50);

  const [livePoints, setLivePoints] = useState<Record<number, { points: number; played: boolean }>>({});
  const [lockedEventId, setLockedEventId] = useState<number | null>(null);
  const [lockedProjectionRows, setLockedProjectionRows] = useState<Record<number, LockedProjectionRow>>({});

  // ---------- Guest preferences (device-local) ----------

  useEffect(() => {
    const saved = window.localStorage.getItem("fpl-risk-decision-context") as RiskMode | null;
    if (saved && saved in rankingPreferences) setDecisionContext(saved);
    const savedFt = Number(window.localStorage.getItem("fpl-risk-free-transfers"));
    if (window.localStorage.getItem("fpl-risk-free-transfers") != null && Number.isInteger(savedFt) && savedFt >= 0 && savedFt <= 5) setFreeTransfers(savedFt);
  }, []);

  function chooseDecisionContext(mode: RiskMode) {
    setDecisionContext(mode);
    window.localStorage.setItem("fpl-risk-decision-context", mode);
  }

  function chooseFreeTransfers(count: number) {
    setFreeTransfers(count);
    window.localStorage.setItem("fpl-risk-free-transfers", String(count));
  }

  // ---------- Public FPL feeds ----------

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setFeedError("");
      try {
        const [bootstrapResponse, fixtureResponse, sportsbookResponse] = await Promise.all([
          fetch("/api/fpl/bootstrap", { cache: "no-store" }),
          fetch("/api/fpl/fixtures", { cache: "no-store" }),
          fetch("/api/sportsbook", { cache: "no-store" }),
        ]);
        if (!bootstrapResponse.ok || !fixtureResponse.ok) throw new Error("Live FPL feed unavailable");
        const bootstrapData = (await bootstrapResponse.json()) as BootstrapPayload;
        const fixtureData = (await fixtureResponse.json()) as { fixtures: FplFixture[] };
        if (!cancelled) {
          setBootstrap(bootstrapData);
          setFixtures(fixtureData.fixtures ?? []);
          if (sportsbookResponse.ok) setSportsbook((await sportsbookResponse.json()) as SportsbookPayload);
        }
        try {
          const historicalResponse = await fetch("/api/fpl/history", { cache: "no-store" });
          if (historicalResponse.ok && !cancelled) setHistory((await historicalResponse.json()) as HistoricalPayload);
        } catch {
          // Historical priors are optional. The current-season model remains usable without them.
        }
      } catch {
        if (!cancelled) setFeedError("FPL data could not be loaded. Older data is kept if it was already loaded; try Refresh in a moment.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [refreshKey]);

  const players = useMemo(() => bootstrap?.elements ?? [], [bootstrap]);
  const teams = useMemo(() => bootstrap?.teams ?? [], [bootstrap]);
  const events = useMemo(() => bootstrap?.events ?? [], [bootstrap]);
  const liveEventId = events.find((event) => event.is_current)?.id ?? events.find((event) => event.is_next)?.id;
  const transferEventId = events.find((event) => event.is_next)?.id ?? events.find((event) => event.is_current)?.id;
  const historicalProfiles = history?.players;
  const nextEvent = events.find((event) => event.is_next) ?? events.find((event) => event.is_current);

  // The projection engine forecasts the next Gameweeks that still have
  // unfinished fixtures. Name them so every horizon has a real label.
  const projectionEvents = useMemo<HorizonEvent[]>(() => {
    const ids = [...new Set(fixtures.filter((f) => !f.finished && f.event != null).map((f) => f.event as number))]
      .sort((a, b) => a - b)
      .slice(0, 5);
    return ids.map((id) => ({ id, name: events.find((event) => event.id === id)?.name ?? `Gameweek ${id}` }));
  }, [events, fixtures]);
  const horizonSpan = (count: number) => {
    const slice = projectionEvents.slice(0, count);
    if (!slice.length) return `${count} GW`;
    if (slice.length === 1) return `GW${slice[0].id}`;
    return `GW${slice[0].id}–${slice[slice.length - 1].id}`;
  };

  useEffect(() => {
    if (!liveEventId) return;
    let cancelled = false;
    const refreshLivePoints = async () => {
      try {
        const response = await fetch(`/api/fpl/live/${liveEventId}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as LivePointsPayload;
        if (cancelled) return;
        setLivePoints(Object.fromEntries(payload.elements.map((player) => [player.id, { points: player.points, played: player.played }])));
      } catch {
        // Keep the last successful snapshot.
      }
    };
    void refreshLivePoints();
    const interval = window.setInterval(refreshLivePoints, 60_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [liveEventId, refreshKey]);

  useEffect(() => {
    if (!liveEventId) {
      setLockedEventId(null);
      setLockedProjectionRows({});
      return;
    }
    let cancelled = false;
    async function loadLockedSnapshot() {
      try {
        const response = await fetch(`/modelbook/data/gw${liveEventId}-locked.json`, { cache: "no-store" });
        if (!response.ok) throw new Error("No locked snapshot");
        const artifact = (await response.json()) as { gameweek?: number; snapshot?: { gameweek?: number; rows?: LockedProjectionRow[] }; rows?: LockedProjectionRow[] };
        const snapshot = artifact.snapshot ?? artifact;
        const eventId = Number(snapshot.gameweek ?? artifact.gameweek);
        const rows = snapshot.rows ?? [];
        if (!cancelled && eventId === liveEventId && rows.length) {
          setLockedEventId(eventId);
          setLockedProjectionRows(Object.fromEntries(rows.map((row) => [row.id, row])));
        }
      } catch {
        if (!cancelled) {
          setLockedEventId(null);
          setLockedProjectionRows({});
        }
      }
    }
    void loadLockedSnapshot();
    return () => { cancelled = true; };
  }, [liveEventId, refreshKey]);

  // ---------- Projections ----------

  const teamMap = useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams]);
  const playerMap = useMemo(() => new Map(players.map((player) => [player.id, player])), [players]);

  const projectionRows = useMemo<ProjectionRow[]>(() => {
    if (!bootstrap || !fixtures.length) return [];
    return players.map((player) => {
      const one = projectPlayer(player, fixtures, teams, 1, historicalProfiles, sportsbook, undefined, true);
      const three = projectPlayer(player, fixtures, teams, 3, historicalProfiles, sportsbook, undefined, true);
      const five = projectPlayer(player, fixtures, teams, 5, historicalProfiles, sportsbook, undefined, true);
      // Value keeps a £3.5m floor on the denominator, as the engine always has.
      const price = Math.max(player.now_cost / 10, 3.5);
      return { player, one, three, five, value: five.expected / price };
    });
  }, [bootstrap, fixtures, historicalProfiles, players, sportsbook, teams]);

  const projectionMap = useMemo(() => new Map(projectionRows.map((row) => [row.player.id, row])), [projectionRows]);
  const projectableMarket = useMemo(
    () => projectionRows
      .filter(({ player }) => !["u", "n", "s"].includes(player.status))
      .filter(({ five }) => five.expected > 0.1),
    [projectionRows],
  );
  const topNext = useMemo(
    () => [...projectableMarket].sort((a, b) => b.one.expected - a.one.expected).slice(0, 8),
    [projectableMarket],
  );

  const marketPriceFloor = useMemo(() => (players.length ? Math.max(0, Math.floor(Math.min(...players.map((p) => p.now_cost)) / 5) * 5) : 40), [players]);
  const marketPriceCeiling = useMemo(() => (players.length ? Math.max(150, Math.ceil(Math.max(...players.map((p) => p.now_cost)) / 5) * 5) : 150), [players]);
  const effectiveMarketMaxPrice = marketMaxPrice ?? marketPriceCeiling;

  // ---------- Imported squad ----------

  const buildSquad = useCallback(
    (picks: ManagerPick[] | undefined) => picks
      ?.map((pick) => {
        const player = playerMap.get(pick.element);
        const row = player ? projectionMap.get(player.id) : null;
        return player && row ? { pick, player, one: row.one, three: row.three, five: row.five } : null;
      })
      .filter((item): item is SquadItem => Boolean(item)) ?? [],
    [playerMap, projectionMap],
  );
  // `picks` is the squad going into the next deadline (restored after a Free
  // Hit); the result view scores whatever was actually fielded on eventId.
  const squad = useMemo<SquadItem[]>(() => buildSquad(manager?.picks), [buildSquad, manager]);
  const fieldedSquad = useMemo<SquadItem[]>(
    () => (manager?.freeHitRevert ? buildSquad(manager.freeHitRevert.freeHitPicks) : squad),
    [buildSquad, manager, squad],
  );

  const hasLockedScoringComparison = Boolean(manager && lockedEventId === manager.eventId && Object.keys(lockedProjectionRows).length);
  const scoringSquad = useMemo<SquadItem[]>(() => {
    if (!manager || lockedEventId !== manager.eventId) return fieldedSquad;
    return fieldedSquad.map((item) => {
      const locked = lockedProjectionRows[item.player.id];
      if (!locked) return item;
      return { ...item, one: { ...item.one, expected: locked.projected, fixtureLabels: [locked.fixture] } };
    });
  }, [fieldedSquad, lockedEventId, lockedProjectionRows, manager]);

  // Decisions are about the next deadline, so the one-Gameweek view of the
  // squad is projected against that event specifically.
  const nextSquad = useMemo<SquadItem[]>(() => {
    if (!transferEventId) return squad;
    return squad.map((item) => ({
      ...item,
      one: projectPlayer(item.player, fixtures, teams, 1, historicalProfiles, sportsbook, [transferEventId], true),
    }));
  }, [fixtures, historicalProfiles, squad, sportsbook, teams, transferEventId]);

  const squadPlayers = useMemo(() => squad.map((item) => item.player), [squad]);
  // Public FPL picks do not include personal selling prices, so the listed
  // price is used whenever the pick has none. This is disclosed in the UI.
  const sellingPrices = useMemo(
    () => new Map(squad.map((item) => [item.player.id, item.pick.selling_price ?? item.player.now_cost])),
    [squad],
  );
  const usesListedPrices = squad.some((item) => item.pick.selling_price == null);
  const starters = useMemo(() => squad.filter((item) => item.pick.position <= 11), [squad]);
  const bench = useMemo(() => squad.filter((item) => item.pick.position > 11), [squad]);
  const nextStarters = useMemo(() => nextSquad.filter((item) => item.pick.position <= 11), [nextSquad]);

  const xiNextWithCaptain = useMemo(
    () => nextStarters.reduce((total, item) => total + item.one.expected * Math.max(item.pick.multiplier, 1), 0),
    [nextStarters],
  );
  const xiFive = useMemo(() => starters.reduce((total, item) => total + item.five.expected, 0), [starters]);
  const captainPick = squad.find((item) => item.pick.is_captain);

  const portfolioRisk = useMemo(
    () => analyzePortfolioRisk(
      starters.map((item) => ({ player: item.player, projection: item.five, weight: Math.max(item.pick.multiplier, 1) })),
      teams,
    ),
    [starters, teams],
  );

  const autoRecommendation = useMemo<Recommendation | null>(() => {
    if (!manager || !squadPlayers.length) return null;
    const candidates = squadPlayers.flatMap((outgoing) => recommendReplacements({
      players,
      squad: squadPlayers,
      fixtures,
      teams,
      outgoing,
      bank: manager.bank ?? 0,
      sellingPrice: sellingPrices.get(outgoing.id),
      horizon: TRANSFER_HORIZON,
      limit: 1,
      history: historicalProfiles,
      freeTransfers,
      sportsbook,
      riskMode: decisionContext,
    }));
    if (!candidates.length) return null;
    const best = candidates.sort((a, b) => b.score - a.score)[0];
    const minimumEdge = freeTransfers === 0 ? 0.9 : freeTransfers >= 5 ? 0.3 : freeTransfers >= 2 ? 0.55 : 0.9;
    return best.expectedGain > minimumEdge && best.score > 0.15 ? best : null;
  }, [decisionContext, fixtures, freeTransfers, historicalProfiles, manager, players, sellingPrices, sportsbook, squadPlayers, teams]);

  const chipAdvice = useMemo(() => {
    if (!manager || !bootstrap || !squad.length) return [];
    return assessChips({
      players,
      squad: squadPlayers,
      starters: starters.map((item) => item.player),
      bench: bench.map((item) => item.player),
      fixtures,
      teams,
      events,
      history: historicalProfiles,
      chipsUsed: manager.chipsUsed,
      freeTransfers,
    });
  }, [bench, bootstrap, events, fixtures, freeTransfers, historicalProfiles, manager, players, squad, squadPlayers, starters, teams]);

  const jointPlan = useMemo(() => {
    if (!manager || !selectedOut.length) return null;
    return recommendJointTransferPlan({
      players,
      squad: squadPlayers,
      fixtures,
      teams,
      outgoingIds: selectedOut,
      bank: manager.bank ?? 0,
      sellingPrices,
      freeTransfers,
      history: historicalProfiles,
      sportsbook,
      horizon: TRANSFER_HORIZON,
    });
  }, [fixtures, freeTransfers, historicalProfiles, manager, players, selectedOut, sellingPrices, sportsbook, squadPlayers, teams]);

  // On narrow screens the result card sits below the pitch. Track whether it is
  // on screen so a compact summary bar can stand in for it while it isn't.
  const resultRef = useRef<HTMLElement | null>(null);
  const [resultInView, setResultInView] = useState(true);
  const hasSelection = selectedOut.length > 0;
  useEffect(() => {
    const node = resultRef.current;
    if (tab !== "transfer" || !hasSelection || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setResultInView(entry.isIntersecting), { threshold: 0.15 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [tab, hasSelection, manager]);

  const singleAlternatives = useMemo(() => {
    if (!manager || selectedOut.length !== 1) return [];
    const outgoing = playerMap.get(selectedOut[0]);
    if (!outgoing) return [];
    return recommendReplacements({
      players,
      squad: squadPlayers,
      fixtures,
      teams,
      outgoing,
      bank: manager.bank ?? 0,
      sellingPrice: sellingPrices.get(outgoing.id),
      horizon: TRANSFER_HORIZON,
      limit: 5,
      history: historicalProfiles,
      freeTransfers,
      sportsbook,
      riskMode: decisionContext,
    });
  }, [decisionContext, fixtures, freeTransfers, historicalProfiles, manager, playerMap, players, selectedOut, sellingPrices, sportsbook, squadPlayers, teams]);

  const captainOptions = useMemo(
    () => [...nextStarters].sort((a, b) => b.one.expected - a.one.expected).slice(0, 3),
    [nextStarters],
  );
  const availabilityFlags = useMemo(
    () => squad.filter((item) => officialAvailability(item.player).flagged),
    [squad],
  );
  const weakest = useMemo(() => [...squad].sort((a, b) => a.five.expected - b.five.expected).slice(0, 3), [squad]);

  // ---------- Player research ----------

  const marketRows = useMemo(() => {
    const query = marketQuery.trim().toLowerCase();
    const filtered = projectableMarket.filter(({ player }) => {
      if (query && !`${player.web_name} ${player.first_name} ${player.second_name}`.toLowerCase().includes(query)) return false;
      if (marketPosition && player.element_type !== marketPosition) return false;
      if (marketTeam && player.team !== marketTeam) return false;
      if (player.now_cost > effectiveMarketMaxPrice) return false;
      return true;
    });
    return filtered.sort((a, b) => {
      if (marketSort === "one") return b.one.expected - a.one.expected;
      if (marketSort === "three") return b.three.expected - a.three.expected;
      if (marketSort === "five") return b.five.expected - a.five.expected;
      if (marketSort === "value") return b.value - a.value;
      if (marketSort === "price") return b.player.now_cost - a.player.now_cost;
      if (marketSort === "risk") return riskRank[a.five.risk] - riskRank[b.five.risk] || b.five.expected - a.five.expected;
      if (marketSort === "sharpe") return (b.five.distribution?.sharpe ?? 0) - (a.five.distribution?.sharpe ?? 0);
      return Number.parseFloat(b.player.selected_by_percent || "0") - Number.parseFloat(a.player.selected_by_percent || "0");
    });
  }, [effectiveMarketMaxPrice, marketPosition, marketQuery, marketSort, marketTeam, projectableMarket]);
  const displayedMarketRows = useMemo(() => marketRows.slice(0, marketVisibleCount), [marketRows, marketVisibleCount]);
  // The three highest five-Gameweek projections within the active filters,
  // whatever the table is sorted by.
  const marketLeaders = useMemo(
    () => [...marketRows].sort((a, b) => b.five.expected - a.five.expected).slice(0, 3),
    [marketRows],
  );
  const filtersActive = Boolean(marketQuery || marketPosition || marketTeam || marketMaxPrice != null);

  function resetFilters() {
    setMarketQuery("");
    setMarketPosition(0);
    setMarketTeam(0);
    setMarketMaxPrice(null);
    setMarketVisibleCount(50);
  }

  // Market signals always describe the whole player list, never the filtered view.
  const marketSignals = useMemo(() => {
    const all = projectionRows;
    const byDesc = (score: (row: ProjectionRow) => number) => [...all].sort((a, b) => score(b) - score(a))[0] ?? null;
    const riser = byDesc((row) => row.player.cost_change_event ?? 0);
    const faller = byDesc((row) => -(row.player.cost_change_event ?? 0));
    const inflow = byDesc((row) => (row.player.transfers_in_event ?? 0) - (row.player.transfers_out_event ?? 0));
    const outflow = byDesc((row) => (row.player.transfers_out_event ?? 0) - (row.player.transfers_in_event ?? 0));
    const haul = [...projectableMarket].sort((a, b) => (b.one.distribution?.bands.haul ?? 0) - (a.one.distribution?.bands.haul ?? 0))[0] ?? null;
    const scorer = byDesc((row) => row.player.event_points ?? -1);
    return {
      riser: riser && (riser.player.cost_change_event ?? 0) > 0 ? riser : null,
      faller: faller && (faller.player.cost_change_event ?? 0) < 0 ? faller : null,
      inflow,
      outflow,
      haul,
      scorer: scorer && Number.isFinite(scorer.player.event_points) ? scorer : null,
    };
  }, [projectableMarket, projectionRows]);

  // ---------- Team import ----------

  async function loadTeam(requested: string, options: { sample?: boolean } = {}) {
    const requestedTeamId = requested.trim();
    if (!/^\d{1,12}$/.test(requestedTeamId)) {
      setTeamError("Team IDs are numbers only, for example 123456. Copy it from your FPL team page address.");
      return;
    }
    setLoadingTeam(true);
    setTeamError("");
    try {
      const response = await fetch("/api/fpl/entry", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId: requestedTeamId }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 429) {
        const wait = Number(response.headers.get("Retry-After"));
        throw new Error(`Too many imports in a short time. Try again${Number.isFinite(wait) && wait > 0 ? ` in ${wait} seconds` : " shortly"}.`);
      }
      if (!response.ok) throw new Error(data.error || "Could not import that team.");
      const sample = Boolean(options.sample);
      setManager(data as ManagerPayload);
      setIsSample(sample);
      setSelectedOut([]);
      setShowImport(false);
      setTeamId(sample ? "" : requestedTeamId);
      if (!sample) window.localStorage.setItem("fpl-risk-team-id", requestedTeamId);
      // Keep the squad in the URL so reloads and navigation reopen it.
      if (window.location.pathname === "/dashboard") {
        const params = new URLSearchParams(window.location.search);
        if (sample) {
          params.set("demo", "1");
          params.delete("team");
        } else {
          params.set("team", requestedTeamId);
          params.delete("demo");
        }
        router.replace(dashboardHref(dashboardView(params.toString()), params.toString()), { scroll: false });
      }
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : "Could not import that team.");
    } finally {
      setLoadingTeam(false);
    }
  }

  function importTeam(event: FormEvent) {
    event.preventDefault();
    void loadTeam(teamId);
  }

  function refreshDashboard() {
    setRefreshKey((value) => value + 1);
    if (manager) void loadTeam(String(manager.id), { sample: isSample });
  }

  // Entry: ?demo=1 opens the sample, ?team= opens that squad, otherwise the
  // remembered Team ID (account first, then this device) is reopened.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const queryTeam = params.get("team")?.trim() ?? "";
    if (params.get("demo") === "1" && !/^\d+$/.test(queryTeam)) {
      void loadTeam(SAMPLE_TEAM_ID, { sample: true });
      return;
    }
    if (/^\d+$/.test(queryTeam)) {
      setTeamId(queryTeam);
      void loadTeam(queryTeam);
      return;
    }
    async function reopenSavedTeam() {
      let accountTeamId = "";
      try {
        const { data: { user } } = await createSupabaseClient().auth.getUser();
        const metadataTeamId = user?.user_metadata?.fpl_team_id;
        if (typeof metadataTeamId === "string" && /^\d+$/.test(metadataTeamId.trim())) accountTeamId = metadataTeamId.trim();
      } catch {
        // Accounts are optional; fall back to this device's saved Team ID.
      }
      if (cancelled) return;
      const saved = accountTeamId || window.localStorage.getItem("fpl-risk-team-id")?.trim() || "";
      if (/^\d+$/.test(saved)) {
        setTeamId(saved);
        void loadTeam(saved);
      }
    }
    void reopenSavedTeam();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleOutgoing(id: number) {
    setSelectedOut((current) => (current.includes(id) ? current.filter((playerId) => playerId !== id) : [...current, id]));
  }

  function openDetail(item: { player: FplPlayer }, horizon: Horizon = "one") {
    const row = projectionMap.get(item.player.id);
    if (row) setDetail({ row, horizon });
  }

  // ---------- Shared pieces ----------

  const importForm = (id: string, autoFocus = false) => (
    <form onSubmit={importTeam} className="stack-sm" noValidate>
      <div className="field">
        <label htmlFor={id}>FPL Team ID</label>
        <div className="inline-form">
          <input
            id={id}
            className="input"
            inputMode="numeric"
            autoComplete="off"
            value={teamId}
            onChange={(event) => setTeamId(event.target.value)}
            placeholder="e.g. 123456"
            aria-invalid={Boolean(teamError)}
            aria-describedby={`${id}-hint${teamError ? ` ${id}-error` : ""}`}
            autoFocus={autoFocus}
          />
          <button className="btn btn-primary" disabled={loadingTeam}>{loadingTeam ? "Importing…" : "Import squad"}</button>
        </div>
      </div>
      <p id={`${id}-hint`} className="field-hint">
        Find it in your FPL points page address: fantasy.premierleague.com/entry/<strong>123456</strong>/event/7 (example ID).
        Only public squad data is read. Never enter your FPL password.
      </p>
      {teamError && (
        <p id={`${id}-error`} className="field-error" role="alert">
          {teamError}
          {manager && ` Still showing ${manager.teamName}, fetched at ${formatClock(manager.fetchedAt)}.`}
        </p>
      )}
    </form>
  );

  const needSquad = (task: string) => (
    <div className={`card ${styles.needSquad}`}>
      <h2>Import a squad to {task}</h2>
      <p className="muted" style={{ marginTop: 4, marginBottom: 14 }}>A public Team ID is enough. Nothing is changed in your FPL account.</p>
      {importForm(`import-${tab}`)}
      <p className="small" style={{ marginTop: 12 }}>
        <button type="button" className="link-button" onClick={() => void loadTeam(SAMPLE_TEAM_ID, { sample: true })} disabled={loadingTeam}>
          Use a sample squad instead
        </button>
      </p>
    </div>
  );

  const playerCell = (player: FplPlayer, onClick?: () => void) => (
    <div className={styles.playerCell}>
      {onClick ? (
        <button type="button" className="link-button" onClick={onClick}>{player.web_name}</button>
      ) : <strong>{player.web_name}</strong>}
      <span className="muted tiny">{teamMap.get(player.team)?.short_name ?? ""} · {positionShort(player.element_type)}</span>
    </div>
  );

  const deadlineIn = timeUntil(nextEvent?.deadline_time);
  const squadView = tab === "overview" || tab === "team" || tab === "transfer";

  // ---------- Render ----------

  return (
    <main className={styles.shell}>
      {/* Context: which squad, which deadline, how fresh. Shown on every dashboard view. */}
      <div className={styles.context}>
        <div className={styles.contextInner}>
          <div className={styles.contextItem}>
            <span className="label">{isSample ? "Sample squad" : "Squad"}</span>
            {manager ? (
              <span>
                <strong>{manager.teamName}</strong>
                <span className="muted"> · {isSample ? "public demo team, not yours" : manager.managerName} · {manager.freeHitRevert ? `GW${manager.freeHitRevert.squadEvent} squad, restored after Free Hit` : `picks as of GW${manager.eventId}`}</span>
                {" "}
                <button type="button" className="link-button small" onClick={() => setShowImport((open) => !open)} aria-expanded={showImport}>
                  {showImport ? "Cancel" : "Change"}
                </button>
              </span>
            ) : (
              <span>
                <span className="muted">{loadingTeam ? "Importing…" : "None loaded"}</span>
                {!loadingTeam && tab !== "overview" && (
                  <>
                    {" "}
                    <button type="button" className="link-button small" onClick={() => setShowImport((open) => !open)} aria-expanded={showImport}>
                      Import
                    </button>
                  </>
                )}
              </span>
            )}
          </div>
          <div className={styles.contextItem}>
            <span className="label">Next deadline</span>
            <span>
              <strong>{nextEvent?.name ?? "—"}</strong>
              <span className="muted"> · {formatDeadline(nextEvent?.deadline_time)}{deadlineIn ? ` (${deadlineIn})` : ""}</span>
            </span>
          </div>
          <div className={`${styles.contextItem} ${styles.contextData}`}>
            <span className="label">FPL data</span>
            <span>
              {loading ? <span className="muted">Updating…</span>
                : feedError && !bootstrap ? <span className="neg">Unavailable</span>
                  : <span className="muted">Fetched {formatClock(bootstrap?.fetchedAt)}</span>}
              {" "}
              <button type="button" className="link-button small" onClick={refreshDashboard} disabled={loading || loadingTeam}>Refresh</button>
            </span>
          </div>
        </div>
        {showImport && (
          <div className={styles.contextImport}>
            {importForm("context-team-id", true)}
          </div>
        )}
        {/* The header holds these links on wide screens; below that they live here so switching views is one tap. */}
        <nav className={styles.viewTabs} aria-label="Dashboard views" data-slide="underline">
          {dashboardViews.map(({ view, label }) => (
            <Link
              key={view}
              href={dashboardHref(view, searchParams.toString())}
              aria-current={tab === view ? "page" : undefined}
              scroll={false}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                showDashboardView(dashboardHref(view, searchParams.toString()), false);
              }}
            >
              {label}
              {view === "transfer" && selectedOut.length > 0 && <span className={styles.tabCount}>{selectedOut.length}</span>}
            </Link>
          ))}
        </nav>
      </div>

      <div className="page">
        {feedError && <div className="notice notice-bad" role="alert" style={{ marginBottom: 16 }}>{feedError}</div>}
        {!showImport && teamError && manager && (
          <div className="notice notice-warn" role="alert" style={{ marginBottom: 16 }}>
            Squad refresh failed: {teamError} Still showing {manager.teamName}, fetched at {formatClock(manager.fetchedAt)}.
          </div>
        )}
        {manager && squadView && (isSample || manager.freeHitRevert) && (
          <div className="notice notice-neutral" style={{ marginBottom: 16 }}>
            {isSample && <>This is a sample squad, a public FPL team used for demonstration. </>}
            {manager.freeHitRevert && (
              <>Free Hit was played in GW{manager.freeHitRevert.freeHitEvent}, so this is the GW{manager.freeHitRevert.squadEvent} squad FPL restores for the next deadline. </>
            )}
            {isSample && <button type="button" className="link-button" onClick={() => setShowImport(true)}>Import your own squad</button>}
          </div>
        )}

        {manager?.activeChip === "freehit" && squadView && (manager.freeHitRevert ? null : (
          <div className="notice notice-warn" style={{ marginBottom: 16 }}>
            <strong>These are Free Hit picks.</strong> The squad FPL restores after GW{manager.eventId} couldn&apos;t be loaded, so projections
            here describe the temporary Free Hit team.
          </div>
        ))}

        <div>
        {/* ============ OVERVIEW ============ */}
        {tab === "overview" && (
          <div className="stack-lg">
            {!manager ? (
              <div className={styles.overviewIntro}>
                <section className="card">
                  <h1>Start with your squad</h1>
                  <p className="muted" style={{ marginTop: 6, marginBottom: 18 }}>
                    Import your public FPL squad to see its projected points, availability issues and whether a transfer beats holding.
                  </p>
                  {loadingTeam ? <p className="muted">Importing squad…</p> : importForm("overview-team-id")}
                  <hr className="divider" />
                  <div className="row small">
                    <button type="button" className="btn btn-sm" onClick={() => void loadTeam(SAMPLE_TEAM_ID, { sample: true })} disabled={loadingTeam}>Try a sample squad</button>
                    <button type="button" className="btn btn-sm" onClick={() => setTab("market")}>Research players without a squad</button>
                  </div>
                </section>
                <section className={styles.whatYouGet}>
                  <h2>What you can do here</h2>
                  <ul>
                    <li><strong>My team</strong> — your starting XI, bench and captain with next-Gameweek projections and availability flags.</li>
                    <li><strong>Transfers</strong> — pick players to sell and compare legal replacements after budget and points hits.</li>
                    <li><strong>Players</strong> — search every player by club, position and price, and see why each forecast is what it is.</li>
                    <li><strong>Planner</strong> — compare moving now with rolling a transfer across the next eight Gameweeks.</li>
                  </ul>
                  <p className="muted small" style={{ marginTop: 12 }}>
                    FPL Prism never edits your FPL team. Transfers, captain changes and chips are still made in the official FPL app.
                  </p>
                </section>
              </div>
            ) : (
              <>
                <div className="page-head" style={{ marginBottom: 0 }}>
                  <div>
                    <h1>{nextEvent?.name ?? "Next Gameweek"} at a glance</h1>
                    <p className="muted">Projections for {manager.teamName}. Deadline {formatDeadline(nextEvent?.deadline_time)}.</p>
                  </div>
                </div>

                <section className={`card ${styles.decision}`}>
                  <span className="label">Suggested transfer · next {TRANSFER_HORIZON} Gameweeks ({horizonSpan(TRANSFER_HORIZON)})</span>
                  {autoRecommendation ? (() => {
                    const out = playerMap.get(autoRecommendation.outgoingId);
                    const into = playerMap.get(autoRecommendation.incomingId);
                    return (
                      <>
                        <h2 className={styles.decisionTitle}>
                          Sell {out?.web_name}, buy {into?.web_name}
                        </h2>
                        <p>
                          <strong className="pos">{signed(autoRecommendation.expectedGain)} projected points</strong> over {TRANSFER_HORIZON} Gameweeks
                          {autoRecommendation.transferCost ? ` after a ${autoRecommendation.transferCost}-point hit` : " using a free transfer"}
                          {" "}({pts(autoRecommendation.outgoingExpected)} → {pts(autoRecommendation.incomingExpected)}). Confidence: {autoRecommendation.confidence.toLowerCase()}.
                        </p>
                        <div className="row" style={{ marginTop: 12 }}>
                          <button type="button" className="btn btn-primary" onClick={() => { setSelectedOut([autoRecommendation.outgoingId]); setTab("transfer"); }}>
                            Review in Transfers
                          </button>
                          <span className="muted small">Assumes {freeTransfers} free transfer{freeTransfers === 1 ? "" : "s"} and listed prices.</span>
                        </div>
                      </>
                    );
                  })() : (
                    <>
                      <h2 className={styles.decisionTitle}>Hold — no single transfer clears the bar</h2>
                      <p className="muted">
                        No one-for-one move gains enough projected points after {freeTransfers ? "using a free transfer" : "a 4-point hit"} to be worth it under these assumptions.
                        Rolling the transfer keeps flexibility for later weeks.
                      </p>
                      <div className="row" style={{ marginTop: 12 }}>
                        <button type="button" className="btn" onClick={() => setTab("transfer")}>Test your own transfers</button>
                        <Link className="btn" href="/planner">Compare rolling in the Planner</Link>
                      </div>
                    </>
                  )}
                </section>

                <div className="stats">
                  <div className="stat">
                    <span className="label">Starting XI · {nextEvent ? `GW${nextEvent.id}` : "next GW"}</span>
                    <div className="stat-value">{pts(xiNextWithCaptain)}</div>
                    <div className="stat-note">projected, captain counted ×{captainPick?.pick.multiplier ?? 2}</div>
                  </div>
                  <div className="stat">
                    <span className="label">Starting XI · {horizonSpan(5)}</span>
                    <div className="stat-value">{pts(xiFive)}</div>
                    <div className="stat-note">projected, no captain bonus</div>
                  </div>
                  <div className="stat">
                    <span className="label">Bank</span>
                    <div className="stat-value">{money(manager.bank)}</div>
                    <div className="stat-note">as of the last deadline</div>
                  </div>
                  <div className="stat">
                    <span className="label">Free transfers</span>
                    <div className="stat-value">{freeTransfers}</div>
                    <div className="stat-note">your assumption · <button type="button" className="link-button" onClick={() => setTab("transfer")}>change</button></div>
                  </div>
                </div>

                <div className="grid-2">
                  <section className="card">
                    <div className="card-head">
                      <div>
                        <h3>Captain options</h3>
                        <p>Highest projected starters for {nextEvent?.name ?? "the next Gameweek"}, before the captain multiplier.</p>
                      </div>
                    </div>
                    <CaptainList items={captainOptions} onOpen={(item) => openDetail(item)} />
                  </section>
                  <section className="card">
                    <div className="card-head">
                      <div>
                        <h3>Availability</h3>
                        <p>Official FPL flags in your squad.</p>
                      </div>
                    </div>
                    <AvailabilityList items={availabilityFlags} onOpen={(item) => openDetail(item)} />
                  </section>
                </div>
              </>
            )}

            <section>
              <div className="row-between" style={{ marginBottom: 10 }}>
                <div>
                  <h2>Highest projected players · {projectionEvents[0]?.name ?? "next Gameweek"}</h2>
                  <p className="muted small">Across all clubs. Select a name to see how the forecast is built.</p>
                </div>
                <button type="button" className="btn btn-sm" onClick={() => setTab("market")}>All players</button>
              </div>
              {topNext.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Player</th><th>Fixture</th><th className="r">Price</th><th className="r">Expected pts</th><th className="r">Likely range</th><th>Risk</th></tr></thead>
                    <tbody>
                      {topNext.map((row) => (
                        <tr key={row.player.id}>
                          <td>{playerCell(row.player, () => setDetail({ row, horizon: "one" }))}</td>
                          <td>{row.one.fixtureLabels[0] === "BLANK" ? "Blank" : row.one.fixtureLabels[0]}</td>
                          <td className="r">{money(row.player.now_cost)}</td>
                          <td className="r strong">{pts(row.one.expected)}</td>
                          <td className="r">{range(row.one.distribution?.p10, row.one.distribution?.p90)}</td>
                          <td><span className={riskBadge(row.one.risk)}>{row.one.risk}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">{loading ? "Loading forecasts…" : "Forecasts are unavailable until FPL data loads."}</div>
              )}
            </section>
          </div>
        )}

        {/* ============ MY TEAM ============ */}
        {tab === "team" && (
          !manager ? needSquad("see your team") : (
            <div className="stack-lg">
              <div className="page-head" style={{ marginBottom: 0 }}>
                <div>
                  <h1>{manager.teamName}</h1>
                  <p className="muted">
                    {isSample ? "Sample squad" : manager.managerName} · {manager.freeHitRevert
                      ? `the GW${manager.freeHitRevert.squadEvent} squad, restored after the GW${manager.freeHitRevert.freeHitEvent} Free Hit.`
                      : `squad as published for the GW${manager.eventId} deadline.`}{" "}
                    Transfers you have made since then are not visible until FPL publishes them.
                  </p>
                </div>
              </div>

              <div className="stats">
                <div className="stat"><span className="label">Overall points</span><div className="stat-value">{manager.overallPoints ?? "—"}</div><div className="stat-note">official, to date</div></div>
                <div className="stat"><span className="label">Overall rank</span><div className="stat-value">{manager.overallRank ? compact(manager.overallRank) : "—"}</div><div className="stat-note">official</div></div>
                <div className="stat"><span className="label">GW{manager.eventId} points</span><div className="stat-value">{manager.gameweekPoints ?? "—"}</div><div className="stat-note">official{events.find((event) => event.id === manager.eventId)?.finished ? "" : ", provisional"}</div></div>
                <div className="stat"><span className="label">Bank</span><div className="stat-value">{money(manager.bank)}</div><div className="stat-note">last deadline</div></div>
                <div className="stat"><span className="label">Team value</span><div className="stat-value">{money(manager.teamValue)}</div><div className="stat-note">last deadline</div></div>
              </div>

              <div className={styles.teamLayout}>
                <section className="stack-sm">
                  <div className="row-between">
                    <h2>Squad</h2>
                    {hasLockedScoringComparison ? (
                      <div className="segmented" role="group" aria-label="Pitch numbers">
                        <button type="button" aria-pressed={teamMode === "next"} onClick={() => setTeamMode("next")}>{nextEvent ? `GW${nextEvent.id}` : "Next"} forecast</button>
                        <button type="button" aria-pressed={teamMode === "result"} onClick={() => setTeamMode("result")}>GW{manager.eventId} result</button>
                      </div>
                    ) : null}
                  </div>
                  <SquadPitch
                    players={teamMode === "result" && hasLockedScoringComparison ? scoringSquad : nextSquad}
                    teams={teams}
                    metric={teamMode === "result" && hasLockedScoringComparison ? "result" : "next"}
                    actualPoints={livePoints}
                    onInspect={(item) => openDetail(item)}
                  />
                  <p className="muted small">
                    {teamMode === "result" && hasLockedScoringComparison
                      ? `Official GW${manager.eventId} points beside the forecast preserved at the deadline. "Not played" means no minutes recorded yet.`
                      : `Numbers are projected points for ${nextEvent?.name ?? "the next Gameweek"} (before captaincy). C = captain, V = vice-captain, ! = official availability flag. Select a player for details.`}
                  </p>
                </section>

                <div className="stack">
                  <section className="card">
                    <div className="card-head"><div><h3>Captain options</h3><p>{nextEvent?.name ?? "Next Gameweek"}, before the multiplier.</p></div></div>
                    <CaptainList items={captainOptions} onOpen={(item) => openDetail(item)} />
                  </section>
                  <section className="card">
                    <div className="card-head"><div><h3>Availability</h3><p>Official FPL flags.</p></div></div>
                    <AvailabilityList items={availabilityFlags} onOpen={(item) => openDetail(item)} />
                  </section>
                  <section className="card">
                    <div className="card-head"><div><h3>Weakest over {horizonSpan(5)}</h3><p>Lowest projected points across all 15.</p></div></div>
                    <ul className={styles.plainList}>
                      {weakest.map((item) => (
                        <li key={item.player.id}>
                          <button type="button" className="link-button" onClick={() => openDetail(item, "five")}>{item.player.web_name}</button>
                          <span className="num">{pts(item.five.expected)} pts</span>
                        </li>
                      ))}
                    </ul>
                    <div className="card-foot">
                      <button type="button" className="link-button" onClick={() => { setSelectedOut(weakest[0] ? [weakest[0].player.id] : []); setTab("transfer"); }}>
                        Compare replacements for {weakest[0]?.player.web_name}
                      </button>
                    </div>
                  </section>
                </div>
              </div>

              <section className="card">
                <div className="card-head">
                  <div>
                    <h2>Chips</h2>
                    <p>Based on your public chip history and current squad. These are prompts to consider a chip, not a calculation of the points it would add.</p>
                  </div>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Chip</th><th>Assessment</th><th>Window</th><th>Why</th></tr></thead>
                    <tbody>
                      {chipAdvice.map((chip) => (
                        <tr key={chip.key}>
                          <td className="strong nowrap">{chip.label}</td>
                          <td><span className={toneBadge(chipStatus[chip.status].tone)}>{chipStatus[chip.status].label}</span></td>
                          <td className="nowrap">{chip.status === "USED" || chip.status === "UNAVAILABLE" ? "—" : chip.targetGw ? `GW${chip.targetGw}` : "None yet"}</td>
                          <td className="small">{chip.headline}. {chip.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {manager.activeChip && <p className="small" style={{ marginTop: 10 }}>Chip active on the GW{manager.eventId} picks: <strong>{chipNames[manager.activeChip] ?? manager.activeChip}</strong>.</p>}
              </section>

              <details className="disclosure">
                <summary>
                  <span>Squad concentration<small>How much your starting XI depends on the same clubs and matches over {horizonSpan(5)}.</small></span>
                </summary>
                <div className="disclosure-body stack">
                  <div className="stats">
                    <div className="stat"><span className="label">Biggest club share</span><div className="stat-value">{portfolioRisk.topTeam}</div><div className="stat-note">{Math.round(portfolioRisk.topTeamShare * 100)}% of the XI&apos;s expected points</div></div>
                    <div className="stat"><span className="label">Biggest single match share</span><div className="stat-value small">{portfolioRisk.topFixture}</div><div className="stat-note">{Math.round(portfolioRisk.topFixtureShare * 100)}% of the XI&apos;s expected points</div></div>
                    <div className="stat"><span className="label">Spread of XI total</span><div className="stat-value">±{pts(portfolioRisk.portfolioVolatility)}</div><div className="stat-note">one standard deviation, with shared outcomes</div></div>
                    <div className="stat"><span className="label">Shared-outcome effect</span><div className="stat-value">{signed(portfolioRisk.correlationImpact)}</div><div className="stat-note">vs ±{pts(portfolioRisk.independentVolatility)} if players were independent</div></div>
                  </div>
                  <p className="small muted">
                    Teammates and players in the same match tend to score or blank together. {portfolioRisk.correlationImpact >= 0
                      ? "Here that widens the likely spread of your XI total."
                      : "Here your picks partly offset each other, narrowing the spread."}{" "}
                    Shares are of expected points (captain weighted), not squad slots or money. The links between players are model assumptions, not measured correlations.
                    Overall concentration: <strong>{portfolioRisk.risk}</strong>. High concentration is context, not a reason to sell on its own.
                  </p>
                </div>
              </details>
            </div>
          )
        )}

        {/* ============ TRANSFERS ============ */}
        {tab === "transfer" && (
          !manager ? needSquad("compare transfers") : (
            <div className="stack-lg">
              <div className="page-head" style={{ marginBottom: 0 }}>
                <div>
                  <h1>Transfers</h1>
                  <p className="muted">
                    Select the players you want to sell. FPL Prism finds the best legal replacements under one shared budget,
                    compared over the next {TRANSFER_HORIZON} Gameweeks ({horizonSpan(TRANSFER_HORIZON)}).
                  </p>
                </div>
              </div>

              <section className={`card card-tight ${styles.assumptions}`}>
                <div className="field">
                  <span id="ft-label">Free transfers available</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="ft-label">
                    {[0, 1, 2, 3, 4, 5].map((count) => (
                      <button key={count} type="button" role="radio" aria-checked={freeTransfers === count} onClick={() => chooseFreeTransfers(count)}>{count}</button>
                    ))}
                  </div>
                  <span className="field-hint">Your assumption — FPL&apos;s public data doesn&apos;t include it. Each extra transfer costs 4 points.</span>
                </div>
                <div className="field">
                  <span>Budget</span>
                  <strong className="num">{money(manager.bank)} in the bank</strong>
                  <span className="field-hint">From the last deadline.</span>
                </div>
                <div className="field">
                  <span>Sale prices</span>
                  <strong>{usesListedPrices ? "Listed prices used" : "Your selling prices"}</strong>
                  <span className="field-hint">{usesListedPrices ? "Public data has no sale prices. Yours may be lower; check in FPL before acting." : "From your picks."}</span>
                </div>
              </section>

              <div className={styles.transferLayout}>
                <section className="stack-sm">
                  <div className="row-between">
                    <div>
                      <h2>Your squad</h2>
                      <p className="muted small">Select the players you would move on from.</p>
                    </div>
                    <span className="small muted">
                      {selectedOut.length ? `${selectedOut.length} selected to sell` : "Tap players to sell"}
                      {selectedOut.length > 0 && <> · <button type="button" className="link-button" onClick={() => setSelectedOut([])}>Clear</button></>}
                    </span>
                  </div>
                  <section className={styles.selectionTray} aria-labelledby="transfer-selection-heading">
                    <div className={styles.selectionTrayHead}>
                      <div>
                        <span className="label">YOUR TRANSFER TARGETS</span>
                        <h3 id="transfer-selection-heading">
                          {selectedOut.length ? `${selectedOut.length} player${selectedOut.length === 1 ? "" : "s"} selected` : "Who are you considering selling?"}
                        </h3>
                      </div>
                      <span className={styles.selectionHint}>
                        {selectedOut.length ? "The model will find replacements for these players." : "Tap a squad tile to start."}
                      </span>
                    </div>
                    {selectedOut.length ? (
                      <div className={styles.selectionChips} aria-live="polite">
                        {selectedOut.map((playerId) => {
                          const player = playerMap.get(playerId);
                          if (!player) return null;
                          return (
                            <span className={styles.selectionChip} key={player.id}>
                              <span className={styles.selectionChipText}>
                                <strong>{player.web_name}</strong>
                                <small>{positionShort(player.element_type)} · {money(player.now_cost)}</small>
                              </span>
                              <button
                                type="button"
                                className={styles.removeSelection}
                                onClick={() => toggleOutgoing(player.id)}
                                aria-label={`Remove ${player.web_name} from transfer targets`}
                              >
                                ×
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    ) : (
                      <p className={styles.selectionEmpty}>
                        Choose one or more players from your squad. The optimizer will only rank replacements for the players you pick.
                      </p>
                    )}
                  </section>
                  <SquadPitch
                    players={squad}
                    teams={teams}
                    mode="transfer"
                    metric="five"
                    selectedIds={selectedOut}
                    onSelect={(item) => toggleOutgoing(item.player.id)}
                    onInspect={(item) => openDetail(item, "five")}
                  />
                  <p className="muted small">Numbers are projected points over {horizonSpan(TRANSFER_HORIZON)}.</p>
                </section>

                <section className="card" aria-live="polite" ref={resultRef} id="transfer-result">
                  {!selectedOut.length ? (
                    <>
                      <h2>Nothing selected</h2>
                      <p className="muted" style={{ marginTop: 6 }}>
                        Select one or more players on the pitch. Multiple sales are solved together, so two moves can&apos;t spend the same money or buy the same player.
                      </p>
                      {autoRecommendation && (
                        <p className={styles.modelSuggestion}>
                          <strong>Optional model starting point.</strong>{" "}
                          Prefer to choose yourself? Select players above. Or start with:{" "}
                          <button type="button" className="link-button" onClick={() => setSelectedOut([autoRecommendation.outgoingId])}>
                            sell {playerMap.get(autoRecommendation.outgoingId)?.web_name}
                          </button>
                        </p>
                      )}
                    </>
                  ) : !jointPlan ? (
                    <>
                      <h2>No legal replacement found</h2>
                      <p className="muted" style={{ marginTop: 6 }}>
                        This search found no combination that fits your budget, keeps the same positions and stays within three players per club.
                        The search checks the top candidates for each position, so try selling a different or more expensive player.
                      </p>
                    </>
                  ) : (
                    <TransferResult
                      plan={jointPlan}
                      playerMap={playerMap}
                      freeTransfers={freeTransfers}
                      usesListedPrices={usesListedPrices}
                      sellingPrices={sellingPrices}
                      onOpen={(player) => openDetail({ player }, "five")}
                    />
                  )}
                </section>
              </div>

              {hasSelection && !resultInView && (
                <div className={styles.resultBar} role="status">
                  <div className={styles.resultBarText}>
                    {jointPlan ? (
                      <>
                        <strong className={jointPlan.expectedGain > 0 ? "pos" : undefined}>
                          {jointPlan.expectedGain > 0 ? `${signed(jointPlan.expectedGain)} pts` : "Hold"}
                        </strong>
                        <span className="muted"> · {jointPlan.moves.map((move) => `${playerMap.get(move.outgoingId)?.web_name} → ${playerMap.get(move.incomingId)?.web_name}`).join(", ")}</span>
                      </>
                    ) : (
                      <span className="muted">No legal replacement found</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  >
                    See result
                  </button>
                </div>
              )}

              {selectedOut.length === 1 && singleAlternatives.length > 0 && (
                <section className="card">
                  <div className="card-head">
                    <div>
                      <h2>Other replacements for {playerMap.get(selectedOut[0])?.web_name}</h2>
                      <p>Ranked by your ranking preference. Points are over {horizonSpan(TRANSFER_HORIZON)}; net gain includes any hit.</p>
                    </div>
                    <div className="field">
                      <span id="pref-label">Ranking preference</span>
                      <div className="segmented" role="radiogroup" aria-labelledby="pref-label">
                        {(Object.keys(rankingPreferences) as RiskMode[]).map((mode) => (
                          <button key={mode} type="button" role="radio" aria-checked={decisionContext === mode} onClick={() => chooseDecisionContext(mode)}>
                            {rankingPreferences[mode].label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <p className="small muted" style={{ marginBottom: 10 }}>
                    {rankingPreferences[decisionContext].detail} This changes this list and the suggested transfer, not the forecasts or the joint search above.
                  </p>
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr><th>Player</th><th className="r">Price</th><th className="r">Projected</th><th className="r">Net gain</th><th>Risk</th><th>Confidence</th></tr></thead>
                      <tbody>
                        {singleAlternatives.map((pick) => {
                          const incoming = playerMap.get(pick.incomingId);
                          if (!incoming) return null;
                          return (
                            <tr key={pick.incomingId}>
                              <td>{playerCell(incoming, () => openDetail({ player: incoming }, "five"))}</td>
                              <td className="r">{money(incoming.now_cost)}</td>
                              <td className="r">{pts(pick.incomingExpected)}</td>
                              <td className={`r strong ${pick.expectedGain > 0 ? "pos" : "neg"}`}>{signed(pick.expectedGain)}</td>
                              <td><span className={riskBadge(pick.incomingRisk)}>{pick.incomingRisk}</span></td>
                              <td>{pick.confidence}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </div>
          )
        )}

        {/* ============ PLAYERS ============ */}
        {tab === "market" && (
          <div className="stack">
            <div className="page-head" style={{ marginBottom: 0 }}>
              <div>
                <h1>Players</h1>
                <p className="muted">
                  Forecasts for {horizonSpan(5)}. Lists {projectableMarket.length || "—"} players with projected minutes;
                  injured-out, suspended and departed players are left out.
                </p>
              </div>
            </div>

            <section className={`card card-tight ${styles.filters}`} aria-label="Filters">
              <div className="field">
                <label htmlFor="market-search">Name</label>
                <input id="market-search" className="input" value={marketQuery} placeholder="e.g. Saka"
                  onChange={(event) => { setMarketQuery(event.target.value); setMarketVisibleCount(50); }} />
              </div>
              <div className="field">
                <label htmlFor="market-position">Position</label>
                <select id="market-position" className="select" value={marketPosition}
                  onChange={(event) => { setMarketPosition(Number(event.target.value)); setMarketVisibleCount(50); }}>
                  <option value={0}>All positions</option>
                  <option value={1}>Goalkeepers</option>
                  <option value={2}>Defenders</option>
                  <option value={3}>Midfielders</option>
                  <option value={4}>Forwards</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="market-club">Club</label>
                <select id="market-club" className="select" value={marketTeam}
                  onChange={(event) => { setMarketTeam(Number(event.target.value)); setMarketVisibleCount(50); }}>
                  <option value={0}>All clubs</option>
                  {[...teams].sort((a, b) => teamDisplayName(a).localeCompare(teamDisplayName(b))).map((team) => (
                    <option key={team.id} value={team.id}>{teamDisplayName(team)}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="market-price">Max price: <span className="num">{money(effectiveMarketMaxPrice)}</span></label>
                <input id="market-price" type="range" min={marketPriceFloor} max={marketPriceCeiling} step={1} value={effectiveMarketMaxPrice}
                  onChange={(event) => { setMarketMaxPrice(Number(event.target.value)); setMarketVisibleCount(50); }} />
              </div>
              <div className="field">
                <label htmlFor="market-sort">Sort by</label>
                <select id="market-sort" className="select" value={marketSort}
                  onChange={(event) => { setMarketSort(event.target.value as MarketSort); setMarketVisibleCount(50); }}>
                  {(Object.keys(sortLabels) as MarketSort[]).map((key) => <option key={key} value={key}>{sortLabels[key]}</option>)}
                </select>
              </div>
            </section>

            <div className="row-between">
              <p className="small muted" aria-live="polite">
                {marketRows.length ? `Showing ${displayedMarketRows.length} of ${marketRows.length} matching players` : ""}
                {filtersActive && <> · <button type="button" className="link-button" onClick={resetFilters}>Reset filters</button></>}
              </p>
              <div className="row small">
                <span className="muted" id="range-label">Range and risk for</span>
                <div className="segmented" role="group" aria-labelledby="range-label">
                  {(["one", "three", "five"] as Horizon[]).map((h) => (
                    <button key={h} type="button" aria-pressed={marketHorizon === h} onClick={() => setMarketHorizon(h)}>{horizonCount[h]} GW</button>
                  ))}
                </div>
              </div>
            </div>

            {!projectableMarket.length ? (
              <div className="empty">{loading ? "Loading forecasts…" : "Forecasts are unavailable until FPL data loads."}</div>
            ) : !marketRows.length ? (
              <div className="empty">
                <strong>No players match these filters</strong>
                <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={resetFilters}>Reset filters</button>
              </div>
            ) : (
              <>
                {marketLeaders.length > 0 && (
                  <section aria-labelledby="market-leaders-heading">
                    <h2 id="market-leaders-heading" className={styles.leadersTitle}>Top 5-Gameweek projections{filtersActive ? " for these filters" : ""}</h2>
                    <ol className={styles.leaders}>
                      {marketLeaders.map((row, index) => (
                        <li key={row.player.id}>
                          <button type="button" className={`card card-tight ${styles.leader}`} onClick={() => setDetail({ row, horizon: "five" })}>
                            <span className={styles.leaderRank}>{index + 1}</span>
                            <span className={styles.leaderName}>
                              <strong>{row.player.web_name}</strong>
                              <span className="muted tiny">{teamMap.get(row.player.team)?.short_name} · {positionShort(row.player.element_type)} · {money(row.player.now_cost)}</span>
                            </span>
                            <span className={styles.leaderScore}>
                              <strong className="num">{pts(row.five.expected)}</strong>
                              <span className="muted tiny">{range(row.five.distribution?.p10, row.five.distribution?.p90)}</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
                <div className={`table-wrap ${styles.marketTable}`}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th className="r">Price</th>
                        <th>Next</th>
                        <th className="r">{projectionEvents[0] ? `GW${projectionEvents[0].id}` : "1 GW"}</th>
                        <th className="r">3 GW</th>
                        <th className="r">5 GW</th>
                        <th className="r">Likely range · {horizonCount[marketHorizon]} GW</th>
                        <th>Risk</th>
                        {marketSort === "value" && <th className="r">Pts per £m</th>}
                        {marketSort === "sharpe" && <th className="r">Pts ÷ spread</th>}
                        <th className="r">Owned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedMarketRows.map((row) => {
                        const h = row[marketHorizon];
                        const flag = officialAvailability(row.player);
                        return (
                          <tr key={row.player.id}>
                            <td>
                              <div className={styles.playerCell}>
                                <button type="button" className="link-button" onClick={() => setDetail({ row, horizon: marketHorizon })}>{row.player.web_name}</button>
                                <span className="muted tiny">
                                  {teamMap.get(row.player.team)?.short_name} · {positionShort(row.player.element_type)}
                                  {flag.flagged && <> · <span className={flag.tone === "bad" ? "neg" : styles.warnText}>{flag.short}</span></>}
                                </span>
                              </div>
                            </td>
                            <td className="r">{money(row.player.now_cost)}</td>
                            <td className="nowrap">{row.one.fixtureLabels[0] === "BLANK" ? <span className="muted">Blank</span> : row.one.fixtureLabels[0]}</td>
                            <td className={`r ${marketSort === "one" ? "strong" : ""}`}>{pts(row.one.expected)}</td>
                            <td className={`r ${marketSort === "three" ? "strong" : ""}`}>{pts(row.three.expected)}</td>
                            <td className={`r ${marketSort === "five" ? "strong" : ""}`}>{pts(row.five.expected)}</td>
                            <td className="r">{range(h.distribution?.p10, h.distribution?.p90)}</td>
                            <td><span className={riskBadge(h.risk)}>{h.risk}</span></td>
                            {marketSort === "value" && <td className="r strong">{row.value.toFixed(2)}</td>}
                            {marketSort === "sharpe" && <td className="r strong">{row.five.distribution?.sharpe.toFixed(2) ?? "—"}</td>}
                            <td className="r">{row.player.selected_by_percent}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {displayedMarketRows.length < marketRows.length && (
                  <button type="button" className="btn" style={{ alignSelf: "center" }}
                    onClick={() => setMarketVisibleCount((count) => Math.min(count + 50, marketRows.length))}>
                    Show 50 more
                  </button>
                )}
                {(marketSort === "value" || marketSort === "sharpe") && (
                  <p className="small muted">
                    {marketSort === "value"
                      ? "Value = 5-Gameweek expected points ÷ price in £m, with prices under £3.5m counted as £3.5m."
                      : "Points ÷ spread = 5-Gameweek expected points divided by the forecast's standard deviation. Higher means steadier for the points, not risk-free."}
                  </p>
                )}
              </>
            )}

            <details className="disclosure">
              <summary><span>Market signals<small>Price changes, transfer activity and the biggest scorer, across all players.</small></span></summary>
              <div className="disclosure-body">
                <dl className="kv">
                  <dt>Biggest price rise this Gameweek</dt>
                  <dd>{marketSignals.riser ? `${marketSignals.riser.player.web_name} (+£${((marketSignals.riser.player.cost_change_event ?? 0) / 10).toFixed(1)}m)` : "No rises yet"}</dd>
                  <dt>Biggest price fall this Gameweek</dt>
                  <dd>{marketSignals.faller ? `${marketSignals.faller.player.web_name} (−£${(Math.abs(marketSignals.faller.player.cost_change_event ?? 0) / 10).toFixed(1)}m)` : "No falls yet"}</dd>
                  <dt>Most net transfers in</dt>
                  <dd>{marketSignals.inflow ? `${marketSignals.inflow.player.web_name} (${compact((marketSignals.inflow.player.transfers_in_event ?? 0) - (marketSignals.inflow.player.transfers_out_event ?? 0))})` : "—"}</dd>
                  <dt>Most net transfers out</dt>
                  <dd>{marketSignals.outflow ? `${marketSignals.outflow.player.web_name} (${compact((marketSignals.outflow.player.transfers_out_event ?? 0) - (marketSignals.outflow.player.transfers_in_event ?? 0))})` : "—"}</dd>
                  <dt>Highest chance of 10+ pts, {projectionEvents[0] ? `GW${projectionEvents[0].id}` : "next GW"} (model)</dt>
                  <dd>{marketSignals.haul?.one.distribution ? `${marketSignals.haul.player.web_name} (${Math.round(marketSignals.haul.one.distribution.bands.haul)}%)` : "Unavailable"}</dd>
                  <dt>Top scorer, {events.find((e) => e.is_current)?.name ?? "current Gameweek"} (official)</dt>
                  <dd>{marketSignals.scorer ? `${marketSignals.scorer.player.web_name} (${marketSignals.scorer.player.event_points} pts)` : "Unavailable"}</dd>
                </dl>
                <p className="small muted" style={{ marginTop: 10 }}>Price moves and transfer counts are what has already happened, not predictions. Popular transfers aren&apos;t necessarily good value.</p>
              </div>
            </details>
          </div>
        )}

        {/* ============ MODEL ============ */}
        {tab === "model" && (
          <article className="page-narrow prose" style={{ margin: 0 }}>
            <h1>How the forecasts are made</h1>
            <p className="lead" style={{ marginTop: 8 }}>
              Model {MODEL_VERSION}. Trained on completed Gameweeks{nextEvent ? ` through GW${Math.max(0, nextEvent.id - 1)}` : ""}; FPL data fetched {formatClock(bootstrap?.fetchedAt)}.
              {history ? ` Historical evidence from ${history.seasons.length} previous season${history.seasons.length === 1 ? "" : "s"}${history.partial ? " (partial coverage)" : ""}.` : " Historical evidence is not loaded, so confidence is lower."}
            </p>

            <h2>What goes into a player&apos;s expected points</h2>
            <ul>
              <li><strong>Playing time first.</strong> Each fixture is modelled as a start, a substitute appearance or no appearance, using starts, minutes and official availability.</li>
              <li><strong>Scoring by position.</strong> Goals, assists, clean sheets, saves, defensive contributions, bonus and cards are scored under FPL rules for that position.</li>
              <li><strong>Current form, steadied by history.</strong> This season&apos;s underlying numbers (xG, xA) are blended with previous seasons. This season counts for more as minutes build up.</li>
              <li><strong>Fixture context.</strong> Opponent strength, home or away, and fixture difficulty adjust each match.</li>
              <li><strong>Double and blank Gameweeks.</strong> A Gameweek with two matches counts both; a blank scores zero.</li>
            </ul>

            <h2>Position calibration</h2>
            <p>
              Raw points are adjusted with a separate straight-line calibration for each position. The adjustment was fit using walk-forward forecasts from {POSITION_CALIBRATION.trainedOnSeason} and then tested on {POSITION_CALIBRATION.holdout.season} without refitting. It corrects persistent over- or under-prediction; it does not use a player&apos;s actual points from the Gameweek being forecast.
            </p>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="table">
                <thead><tr><th>Position</th><th>Adjustment</th><th>Training player-weeks</th></tr></thead>
                <tbody>
                  {Object.entries(POSITION_CALIBRATION.coefficients).map(([position, value]) => (
                    <tr key={position}>
                      <td>{position}</td>
                      <td>{value.intercept.toFixed(2)} + {value.slope.toFixed(3)} × raw xPts</td>
                      <td>{value.samples.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginTop: 8 }}>
              On the {POSITION_CALIBRATION.holdout.allPlayerGameweeks.toLocaleString()} player-Gameweeks in the held-out season, all-player MAE changed from {POSITION_CALIBRATION.holdout.baselineMae.toFixed(3)} to {POSITION_CALIBRATION.holdout.calibratedMae.toFixed(3)}. Among players who appeared, within two points rose from {(POSITION_CALIBRATION.holdout.appearedWithin2Baseline * 100).toFixed(1)}% to {(POSITION_CALIBRATION.holdout.appearedWithin2Calibrated * 100).toFixed(1)}%, but RMSE worsened from {POSITION_CALIBRATION.holdout.appearedRmseBaseline.toFixed(3)} to {POSITION_CALIBRATION.holdout.appearedRmseCalibrated.toFixed(3)}. A flat two-point forecast reached {(POSITION_CALIBRATION.holdout.appearedWithin2FlatTwo * 100).toFixed(1)}% within two. The calibration training run used an earlier double-Gameweek scoring method and needs refitting before these gains can be relied on.
            </p>

            <h2>Playing-time evidence</h2>
            <p>
              When a player has no minutes after their team has played at least two matches, and no historical starting record is available, the model gives less weight to its pre-season playing-time assumption. Players who have appeared or have a known previous-season role keep the existing estimate. In a reconstructed {MINUTES_EVIDENCE_VALIDATION.testedSeason} replay, this reduced all-player average error from {MINUTES_EVIDENCE_VALIDATION.allPlayerMaeBefore.toFixed(3)} to {MINUTES_EVIDENCE_VALIDATION.allPlayerMaeAfter.toFixed(3)} points and appearance-probability error from {MINUTES_EVIDENCE_VALIDATION.appearanceBrierBefore.toFixed(3)} to {MINUTES_EVIDENCE_VALIDATION.appearanceBrierAfter.toFixed(3)}. Accuracy within two points among players who appeared stayed near {(MINUTES_EVIDENCE_VALIDATION.activeWithin2After * 100).toFixed(1)}%. The available {MINUTES_EVIDENCE_VALIDATION.nextSeasonPartial.season} GW{MINUTES_EVIDENCE_VALIDATION.nextSeasonPartial.gameweeks} replay also improved all-player error, though that sample is small.
            </p>

            <h2>Goalkeeper saves</h2>
            <p>
              Save points now count complete groups of three saves per match, as FPL awards them. The model estimates the chance of reaching each three-save threshold, including the chance that the goalkeeper does not play. Historical checks improved average error slightly but raised the size of some goalkeeper misses, so this remains under review.
            </p>

            <h2>Expected points, range and median</h2>
            <p>Expected points is the average outcome, not the most likely exact score. The likely range runs from the 10th to the 90th percentile of simulated outcomes, so roughly 1 in 10 results fall below it and 1 in 10 above. The median is the middle outcome and is often lower than the average because big hauls pull the average up.</p>

            <h2>Risk, confidence and data quality are different</h2>
            <ul>
              <li><strong>Risk</strong> describes how wide the range is for that player and horizon.</li>
              <li><strong>Confidence</strong> describes how strong the evidence behind the forecast is. It is not the chance of being right.</li>
              <li><strong>Data quality</strong> is a 0–100 coverage score for the inputs. It is not an accuracy percentage.</li>
            </ul>

            <h2>From forecasts to decisions</h2>
            <ul>
              <li><strong>Transfers</strong> compare projected points over five Gameweeks, subtract 4 points per transfer beyond your free ones, and keep budget, positions and the three-per-club rule legal. The search covers the top candidates per position, not every possible squad.</li>
              <li><strong>Holding is a valid answer.</strong> If the best move doesn&apos;t beat the hit, FPL Prism says so.</li>
              <li><strong>The Planner</strong> compares rolling with one- and two-transfer moves across eight Gameweeks.</li>
              <li><strong>Chip guidance</strong> flags plausible windows; it does not calculate the points a chip would add.</li>
            </ul>

            <h2>Betting-market prior</h2>
            <p>
              An optional prior from betting markets can nudge team-level goal and clean-sheet expectations.{" "}
              {sportsbook?.available && sportsbook.configuredWeight > 0
                ? `It is currently active at ${(sportsbook.configuredWeight * 100).toFixed(0)}% configured weight.`
                : "It is not applied in the current forecasts."}
            </p>
            <p>
              {sportsbook?.available
                ? `The free market feed currently covers ${sportsbook.fixtures.length} upcoming fixture${sportsbook.fixtures.length === 1 ? "" : "s"}. It is being observed before we decide whether it improves player forecasts.`
                : "No betting-market observations are currently connected."}
            </p>

            <h2>Limitations</h2>
            <p>Team news, rotation, injuries and tactics change after forecasts are made. Players with few minutes have thin evidence. Public data doesn&apos;t include your selling prices or remaining free transfers. Treat every number as an estimate.</p>

            <h2>Track record</h2>
            <p>Forecasts are preserved at each deadline and compared with official points, including the misses, in the <Link href="/modelbook">Modelbook</Link>.</p>
          </article>
        )}
        </div>
      </div>

      {detail && (
        <PlayerDetail
          key={detail.row.player.id}
          row={detail.row}
          team={teamMap.get(detail.row.player.team)}
          events={projectionEvents}
          marketPriorAvailable={Boolean(sportsbook?.available)}
          initialHorizon={detail.horizon}
          onClose={() => setDetail(null)}
        />
      )}
    </main>
  );
}

function CaptainList({ items, onOpen }: { items: SquadItem[]; onOpen: (item: SquadItem) => void }) {
  if (!items.length) return <p className="muted">No projections yet.</p>;
  return (
    <ol className={styles.captainList}>
      {items.map((item) => {
        const minutes = item.one.minutesByFixture[0];
        return (
          <li key={item.player.id}>
            <div>
              <button type="button" className="link-button" onClick={() => onOpen(item)}>{item.player.web_name}</button>
              {item.pick.is_captain && <span className="badge" style={{ marginLeft: 6 }}>Your captain</span>}
              {item.pick.is_vice_captain && <span className="badge" style={{ marginLeft: 6 }}>Your vice</span>}
              <div className="muted tiny">
                {item.one.fixtureLabels[0] === "BLANK" ? "No fixture" : item.one.fixtureLabels[0]}
                {minutes && item.one.fixtureLabels[0] !== "BLANK" ? ` · ${Math.round(minutes.startProbability * 100)}% to start` : ""}
                {` · range ${range(item.one.distribution?.p10, item.one.distribution?.p90)}`}
              </div>
            </div>
            <strong className="num">{pts(item.one.expected)}</strong>
          </li>
        );
      })}
    </ol>
  );
}

function AvailabilityList({ items, onOpen }: { items: SquadItem[]; onOpen: (item: SquadItem) => void }) {
  if (!items.length) return <p className="muted">No official flags on any of your 15 players.</p>;
  return (
    <ul className={styles.plainList}>
      {items.map((item) => {
        const status = officialAvailability(item.player);
        return (
          <li key={item.player.id}>
            <div>
              <button type="button" className="link-button" onClick={() => onOpen(item)}>{item.player.web_name}</button>
              {item.player.news && <div className="muted tiny">{item.player.news}</div>}
            </div>
            <span className={toneBadge(status.tone)}>{status.short}</span>
          </li>
        );
      })}
    </ul>
  );
}

function TransferResult({
  plan, playerMap, freeTransfers, usesListedPrices, sellingPrices, onOpen,
}: {
  plan: NonNullable<ReturnType<typeof recommendJointTransferPlan>>;
  playerMap: Map<number, FplPlayer>;
  freeTransfers: number;
  usesListedPrices: boolean;
  sellingPrices: Map<number, number>;
  onOpen: (player: FplPlayer) => void;
}) {
  const improves = plan.expectedGain > 0;
  const outgoingSale = plan.moves.reduce((sum, move) => sum + (sellingPrices.get(move.outgoingId) ?? 0), 0);
  const leftOver = plan.totalBudget - plan.totalIncomingCost;
  return (
    <div className="stack">
      <div>
        <span className={improves ? "badge badge-good" : "badge badge-warn"}>{improves ? "Transfer leads" : "Holding leads"}</span>
        <h2 style={{ marginTop: 8 }}>
          {improves
            ? `${signed(plan.expectedGain)} projected points over ${TRANSFER_HORIZON} Gameweeks`
            : `Best option is ${signed(plan.expectedGain)} after the hit`}
        </h2>
        <p className="muted small" style={{ marginTop: 4 }}>
          {improves
            ? `After ${plan.transferCost ? `a ${plan.transferCost}-point hit` : "using free transfers"}. Confidence: ${plan.confidence.toLowerCase()} · data quality ${plan.dataQuality}/100.`
            : plan.transferCost
              ? `These are the strongest legal replacements found, but their gain doesn't cover the ${plan.transferCost}-point hit. Keeping your current players has the higher projection.`
              : "These are the strongest legal replacements found, but they project fewer points than the players you would sell. Keeping your current players has the higher projection."}
        </p>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Sell</th><th>Buy</th><th className="r">Gain</th></tr></thead>
          <tbody>
            {plan.moves.map((move) => {
              const out = playerMap.get(move.outgoingId);
              const into = playerMap.get(move.incomingId);
              if (!out || !into) return null;
              return (
                <tr key={`${move.outgoingId}-${move.incomingId}`}>
                  <td>
                    <button type="button" className="link-button" onClick={() => onOpen(out)}>{out.web_name}</button>
                    <div className="muted tiny">{pts(move.outgoingExpected)} pts · sells {money(sellingPrices.get(out.id))}{usesListedPrices ? "*" : ""}</div>
                  </td>
                  <td>
                    <button type="button" className="link-button" onClick={() => onOpen(into)}>{into.web_name}</button>
                    <div className="muted tiny">{pts(move.incomingExpected)} pts · costs {money(into.now_cost)}</div>
                  </td>
                  <td className={`r ${move.expectedGain >= 0 ? "pos" : "neg"}`}>{signed(move.expectedGain)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <dl className="kv">
        <dt>Points gained before hits</dt><dd>{signed(plan.rawExpectedGain)}</dd>
        <dt>Hit ({Math.max(0, plan.moves.length - freeTransfers)} paid transfer{Math.max(0, plan.moves.length - freeTransfers) === 1 ? "" : "s"})</dt><dd>{plan.transferCost ? `−${plan.transferCost}` : "0"}</dd>
        <dt><strong>Net gain</strong></dt><dd><strong className={improves ? "pos" : "neg"}>{signed(plan.expectedGain)}</strong></dd>
        <dt>Money available</dt><dd>{money(plan.totalBudget)} <span className="muted small">(bank + {money(outgoingSale)} from sales)</span></dd>
        <dt>Spent on new players</dt><dd>{money(plan.totalIncomingCost)}</dd>
        <dt>Left in the bank</dt><dd>{money(leftOver)}</dd>
      </dl>

      {usesListedPrices && (
        <p className="small muted">* Sale values use current listed prices because public FPL data doesn&apos;t include your selling prices. If you bought a player for less, you may get less back — check affordability in FPL.</p>
      )}
      <p className="small muted">Per-move gains are before hits; the hit is counted once for the whole package. Make the transfers yourself in the official FPL app.</p>
    </div>
  );
}
