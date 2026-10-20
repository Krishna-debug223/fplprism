import gw3Report from "@/public/modelbook/data/gw3-report.json";
import gw3Meta from "@/public/modelbook/data/gw3-snapshot-meta.json";
import gw4Report from "@/public/modelbook/data/gw4-report.json";
import gw5Report from "@/public/modelbook/data/gw5-report.json";
import gw6Report from "@/public/modelbook/data/gw6-report.json";
import gw6Meta from "@/public/modelbook/data/gw6-snapshot-meta.json";

// Modelbook archive imports are registered below.

// GW7 has no recoverable deadline snapshot, so GW8 is the active forecast.
// The archive workflow advances this when it publishes each future report.
export const CURRENT_GAMEWEEK = 8;
export const SNAPSHOT_URL = `/api/ledger/snapshot?event=${CURRENT_GAMEWEEK}`;
export const LOCKED_URL = `/modelbook/data/gw${CURRENT_GAMEWEEK}-locked.json`;
export const LIVE_POINTS_URL = `/api/fpl/live/${CURRENT_GAMEWEEK}`;

export type ErrorMetrics = {
  count: number;
  mae: number;
  rmse: number;
  bias: number;
  within1: number;
  within2: number;
  within3: number;
};

export type ModelbookReport = {
  gameweek: number;
  modelVersion: string;
  final: boolean;
  generatedAt: string;
  snapshotHash?: string;
  actualsFetchedAt?: string;
  actualsSource?: string;
  actualsFinality?: { fixtureCount: number; started: number; finished: number; finishedProvisional: number; ninetyMinutes: number };
  forecastProvenance?: "deadline-frozen" | "predeadline-published" | "reconstructed-after-deadline";
  provenanceNote?: string;
  training?: { trainedThroughGameweek: number; targetGameweek: number; method: string; validation: string; source?: string };
  overall: ErrorMetrics;
  activeCohort: ErrorMetrics;
  byPosition: Record<string, ErrorMetrics>;
  adjustmentsForNextGw?: Record<string, number>;
  largestMisses: Array<{ name: string; position: string; projected: number; actual: number; error: number; absoluteError?: number; minutes?: number }>;
  bestPredictions?: Array<{ name: string; position: string; projected: number; actual: number; error: number; absoluteError?: number; minutes?: number }>;
  bestPredictionsTitle?: string;
  bestPredictionsNote?: string;
};

export type SnapshotMeta = {
  lockedAt: string;
  deadline: string;
  contentHash: string;
  lockedBeforeDeadline: boolean;
};

const ARCHIVE: Record<number, { report: ModelbookReport; meta?: SnapshotMeta }> = {
  6: { report: gw6Report as ModelbookReport, meta: gw6Meta as SnapshotMeta },
  5: { report: gw5Report as ModelbookReport },
  4: { report: gw4Report as ModelbookReport },
  3: { report: gw3Report as ModelbookReport, meta: gw3Meta as SnapshotMeta },
};

export const ARCHIVED_GAMEWEEKS = Object.keys(ARCHIVE).map(Number).sort((a, b) => b - a);

export const POSITION_ORDER = ["GKP", "DEF", "MID", "FWD"];
export const POSITION_LABEL: Record<string, string> = { GKP: "Goalkeepers", DEF: "Defenders", MID: "Midfielders", FWD: "Forwards" };

/**
 * Keep the headline and position breakdown on the same evaluation cohort.
 * Reports are immutable, so fail closed if one was generated with a different
 * denominator in one of these sections.
 */
export function validateActiveCohortReport(data: ModelbookReport) {
  const activeCount = Number(data.activeCohort?.count);
  const positions = Object.values(data.byPosition ?? {});
  const positionCount = positions.reduce((sum, values) => sum + Number(values.count ?? 0), 0);
  if (!Number.isFinite(activeCount) || positionCount !== activeCount) {
    throw new Error(`Active cohort mismatch: headline=${activeCount}, positions=${positionCount}`);
  }
  const headlineWithin2 = Number(data.activeCohort.within2);
  const weightedWithin2 = positionCount > 0
    ? positions.reduce((sum, values) => sum + values.count * values.within2, 0) / positionCount
    : 0;
  // Position percentages are stored to one decimal place, so allow rounding noise.
  if (!Number.isFinite(headlineWithin2) || Math.abs(weightedWithin2 - headlineWithin2) > 0.2) {
    throw new Error(`Within ±2 mismatch: headline=${headlineWithin2}, weighted positions=${weightedWithin2.toFixed(1)}`);
  }
  return data;
}

export function archivedReport(gameweek: number) {
  const entry = ARCHIVE[gameweek];
  if (!entry) return null;
  return { report: validateActiveCohortReport(entry.report), meta: entry.meta ?? null };
}

// ---------- Live ledger (current Gameweek) ----------

export type LedgerRow = {
  id: number;
  name: string;
  firstName?: string;
  secondName?: string;
  team: string;
  position: string;
  price: number;
  ownership: number;
  status: string;
  fixture: string;
  projected: number;
  risk: "Low" | "Medium" | "High";
  confidence: string;
  dataQuality: number;
  floor: number | null;
  ceiling: number | null;
  sharpe: number | null;
  probabilities: { bust?: number; haul?: number } | null;
  news?: string | null;
  chanceOfPlayingThisRound?: number | null;
};

export type LedgerSnapshot = {
  gameweek: number;
  eventName?: string;
  deadlineTime: string;
  generatedAt: string;
  modelVersion: string;
  playerCount?: number;
  training?: { trainedThroughGameweek: number; targetGameweek: number; method: string; validation: string; source?: string };
  rows: LedgerRow[];
};

export type LedgerMode = "prelock" | "lock-pending" | "locked";

export type Ledger = {
  mode: LedgerMode;
  data: LedgerSnapshot;
  lockedAt: string | null;
  contentHash: string | null;
  lockMode: "official-deadline" | "manual-predeadline" | "automatic-predeadline";
};

type LockedArtifact = {
  snapshot?: LedgerSnapshot;
  lockedAt?: string;
  contentHash?: string;
  lockMode?: Ledger["lockMode"];
} & Partial<LedgerSnapshot>;

export async function loadCurrentLedger(): Promise<Ledger> {
  try {
    const lockedResponse = await fetch(LOCKED_URL, { cache: "no-store" });
    if (lockedResponse.ok) {
      const artifact = (await lockedResponse.json()) as LockedArtifact;
      const snapshot = (artifact.snapshot ?? artifact) as LedgerSnapshot & { lockedAt?: string; contentHash?: string };
      return {
        mode: "locked",
        data: snapshot,
        lockedAt: artifact.lockedAt ?? snapshot.lockedAt ?? null,
        contentHash: artifact.contentHash ?? snapshot.contentHash ?? null,
        lockMode: artifact.lockMode ?? "official-deadline",
      };
    }
  } catch {
    // The lock artifact intentionally does not exist before the deadline.
  }

  const response = await fetch(SNAPSHOT_URL, { cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Projection export unavailable (${response.status})`);
  }
  const data = (await response.json()) as LedgerSnapshot;
  const deadline = Date.parse(data.deadlineTime);
  const mode: LedgerMode = Number.isFinite(deadline) && Date.now() >= deadline ? "lock-pending" : "prelock";
  if (mode === "lock-pending") {
    throw new Error(
      `GW${data.gameweek}'s deadline has passed, but its frozen forecast is missing. To avoid showing projections recalculated after the deadline, this table is hidden until the original snapshot is restored.`,
    );
  }
  return { mode, data, lockedAt: null, contentHash: null, lockMode: "official-deadline" };
}

export type LivePoints = {
  available: boolean;
  fetchedAt: string | null;
  players: Record<string, { minutes: number; played: boolean; totalPoints: number }>;
};

/**
 * The official live feed may be unavailable before the Gameweek starts; the
 * forecast stays visible and actual points fill in as minutes arrive.
 */
export async function loadLivePoints(): Promise<LivePoints> {
  try {
    const response = await fetch(LIVE_POINTS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error();
    const payload = (await response.json()) as { elements?: Array<Record<string, unknown> & { id: number; stats?: Record<string, number> }> };
    const players = Object.fromEntries((payload.elements ?? []).map((element) => {
      // The Prism proxy returns { points, minutes, played }. Accept the raw FPL
      // { stats } shape as well for local development and future proxies.
      const stats = element.stats ?? {};
      const minutes = Number(element.minutes ?? stats.minutes ?? 0);
      return [String(element.id), {
        minutes,
        played: Boolean(element.played ?? minutes > 0),
        totalPoints: Number(element.points ?? stats.total_points ?? 0),
      }];
    }));
    return { available: true, players, fetchedAt: new Date().toISOString() };
  } catch {
    return { available: false, players: {}, fetchedAt: null };
  }
}

export function actualPointsFor(row: Pick<LedgerRow, "id">, live: LivePoints) {
  const player = live.players[String(row.id)];
  if (!player || (player.minutes <= 0 && !player.played)) return null;
  return Number.isFinite(player.totalPoints) ? player.totalPoints : null;
}

export function ledgerStatus(ledger: Pick<Ledger, "mode" | "lockMode">) {
  if (ledger.mode === "locked") {
    if (ledger.lockMode === "automatic-predeadline") {
      return {
        label: "Locked before deadline",
        tone: "good" as const,
        detail: "This snapshot was automatically captured and fingerprinted shortly before the official deadline. These are the forecasts that will be scored.",
      };
    }
    return {
      label: ledger.lockMode === "manual-predeadline" ? "Locked early" : "Locked",
      tone: "good" as const,
      detail: ledger.lockMode === "manual-predeadline"
        ? "This exact export was frozen ahead of the official deadline. These are the forecasts that will be scored."
        : "The deadline snapshot is frozen. These are the exact forecasts that will be scored.",
    };
  }
  if (ledger.mode === "lock-pending") {
    return {
      label: "Lock pending",
      tone: "warn" as const,
      detail: "The deadline has passed, but the frozen snapshot is unavailable. Post-deadline recalculated projections are hidden to protect the historical record.",
    };
  }
  return {
    label: "Live until deadline",
    tone: "info" as const,
    detail: "Forecasts update until the FPL deadline. The exact deadline output is then frozen, fingerprinted and scored against official points.",
  };
}
