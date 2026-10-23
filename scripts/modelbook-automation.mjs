import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "public/modelbook/data");
const STATE_DIR = path.join(ROOT, ".modelbook-state");
const MODELBOOK_TS = path.join(ROOT, "lib/modelbook.ts");
const SITE_URL = (process.env.FPL_PRISM_SITE_URL || "https://fplprism.com").replace(/\/$/, "");
const FPL_API = "https://fantasy.premierleague.com/api";
const CAPTURE_WINDOW_MS = 10 * 60 * 1000;
// GitHub's scheduled workflows can run hours late. Keep a verified forecast
// from the entire pre-deadline comparison window as a fallback.
const CHECKPOINT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_INTERVAL_MS = 45 * 60 * 1000;
const ARCHIVE_IMPORT_MARKER = "// Modelbook archive imports are registered below.";
const requestedEvent = Number(process.env.MODELBOOK_GAMEWEEK || process.argv[2] || 0);

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "FPL-Prism-Modelbook-Archive/1.0" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
  return response.json();
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function isCaptureWindow(deadline, now = Date.now()) {
  const remaining = Number(deadline) - now;
  return Number.isFinite(remaining) && remaining > 0 && remaining <= CAPTURE_WINDOW_MS;
}

function isCheckpointDue(deadline, lastCapturedAt, now = Date.now()) {
  const remaining = Number(deadline) - now;
  if (!Number.isFinite(remaining) || remaining <= CAPTURE_WINDOW_MS || remaining > CHECKPOINT_WINDOW_MS) return false;
  const previous = Date.parse(lastCapturedAt ?? "");
  return !Number.isFinite(previous) || now - previous >= CHECKPOINT_INTERVAL_MS;
}

function isValidCheckpoint(candidate, gameweek, deadline) {
  if (!candidate?.snapshot || Number(candidate.gameweek) !== Number(gameweek)) return false;
  if (candidate.deadlineTime !== deadline || !candidate.contentHash || !candidate.snapshot.rows?.length) return false;
  const capturedAt = Date.parse(candidate.capturedAt ?? candidate.snapshot.generatedAt ?? "");
  return Number.isFinite(capturedAt) && capturedAt < Date.parse(deadline)
    && digest(JSON.stringify(candidate.snapshot)) === candidate.contentHash;
}

function writeJson(file, value) {
  return writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function snapshotFile(gameweek) {
  return path.join(DATA_DIR, `gw${gameweek}-locked.json`);
}

function checkpointFile(gameweek) {
  return path.join(STATE_DIR, `gw${gameweek}-predeadline-candidate.json`);
}

function snapshotMetaFile(gameweek) {
  return path.join(DATA_DIR, `gw${gameweek}-snapshot-meta.json`);
}

function reportFile(gameweek) {
  return path.join(DATA_DIR, `gw${gameweek}-report.json`);
}

function actualsFile(gameweek) {
  return path.join(DATA_DIR, `gw${gameweek}-actuals-cache.json`);
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function normalizePosition(value) {
  const position = String(value ?? "—").trim().toUpperCase();
  return position === "GK" || position === "GOALKEEPER" || position === "GOALKEEPERS" ? "GKP" : position;
}

function metricSet(rows) {
  const count = rows.length;
  if (!count) throw new Error("Cannot score an empty report cohort");
  const errors = rows.map((row) => row.actual - row.projected);
  const abs = errors.map(Math.abs);
  return {
    count,
    mae: round(abs.reduce((sum, value) => sum + value, 0) / count),
    rmse: round(Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / count)),
    bias: round(errors.reduce((sum, value) => sum + value, 0) / count),
    within1: round(abs.filter((value) => value <= 1).length / count * 100, 1),
    within2: round(abs.filter((value) => value <= 2).length / count * 100, 1),
    within3: round(abs.filter((value) => value <= 3).length / count * 100, 1),
  };
}

function topPickResults(rows) {
  if (!rows.length) return [];
  const ranked = [...rows].sort((a, b) => b.projected - a.projected || a.name.localeCompare(b.name));
  const requestedCounts = [10, 20, 50].filter((count) => count <= ranked.length);
  const counts = requestedCounts.length ? requestedCounts : [ranked.length];
  const fieldAverageActual = round(rows.reduce((sum, row) => sum + row.actual, 0) / rows.length, 2);
  return counts.map((count) => {
    const picks = ranked.slice(0, count);
    const averageActual = round(picks.reduce((sum, row) => sum + row.actual, 0) / picks.length, 2);
    return {
      count,
      matchedPlayers: picks.length,
      fieldPlayers: rows.length,
      playersWithMinutes: picks.filter((row) => row.minutes > 0).length,
      totalActual: picks.reduce((sum, row) => sum + row.actual, 0),
      averageActual,
      fieldAverageActual,
      uplift: round(averageActual - fieldAverageActual, 2),
    };
  });
}

function archiveReport(gameweek, locked, livePayload, fixturePayload, fetchedAt) {
  const actualById = new Map((livePayload.elements ?? []).map((player) => [Number(player.id), player]));
  const scored = (locked.snapshot?.rows ?? []).flatMap((row) => {
    const actual = actualById.get(Number(row.id));
    if (!actual || !Number.isFinite(Number(row.projected))) return [];
    const minutes = Number(actual.stats?.minutes ?? 0);
    const points = Number(actual.stats?.total_points ?? 0);
    const error = points - Number(row.projected);
    return [{
      id: Number(row.id),
      name: String(row.name ?? `Player ${row.id}`),
      position: normalizePosition(row.position),
      projected: Number(row.projected),
      actual: points,
      error,
      absoluteError: Math.abs(error),
      minutes,
    }];
  });
  const active = scored.filter((row) => row.minutes > 0);
  const byPosition = {};
  for (const position of ["GKP", "DEF", "MID", "FWD"]) {
    const cohort = active.filter((row) => row.position === position);
    if (cohort.length) byPosition[position] = metricSet(cohort);
  }
  const fixtures = fixturePayload ?? [];
  const allFixturesOfficiallyFinished = fixtures.length > 0 && fixtures.every((fixture) => fixture.finished);
  const isReconstructed = locked.lockMode === "retrospective-reconstruction";
  const report = {
    gameweek,
    modelVersion: locked.modelVersion ?? locked.snapshot?.modelVersion ?? "unknown",
    final: allFixturesOfficiallyFinished,
    generatedAt: fetchedAt,
    snapshotHash: locked.contentHash,
    actualsFetchedAt: fetchedAt,
    actualsSource: `${FPL_API}/event/${gameweek}/live/`,
    actualsFinality: {
      fixtureCount: fixtures.length,
      started: fixtures.filter((fixture) => fixture.started).length,
      finished: fixtures.filter((fixture) => fixture.finished).length,
      finishedProvisional: fixtures.filter((fixture) => fixture.finished_provisional).length,
      ninetyMinutes: fixtures.filter((fixture) => Number(fixture.minutes ?? 0) >= 90).length,
    },
    forecastProvenance: isReconstructed
      ? "reconstructed-after-deadline"
      : locked.lockMode === "automatic-predeadline-fallback" ? "predeadline-fallback" : "predeadline-published",
    provenanceNote: isReconstructed
      ? `${locked.lockNote ?? `GW${gameweek} was reconstructed after its deadline because the original forecast is unavailable.`} The fixed audit fingerprint is ${locked.contentHash}.${allFixturesOfficiallyFinished ? " FPL has marked every fixture finished." : " These points are provisional and will be checked again until FPL marks every fixture finished."}`
      : `${locked.lockMode === "automatic-predeadline-fallback" ? `The final deadline capture was missed, so this report uses the latest saved GW${gameweek} checkpoint from before the deadline.` : `Scored against official FPL points using the immutable GW${gameweek} snapshot captured before its deadline.`} The forecast fingerprint is ${locked.contentHash}.${allFixturesOfficiallyFinished ? " FPL has marked every fixture finished." : " These points are provisional and will be checked again until FPL marks every fixture finished."}`,
    training: locked.snapshot?.training ?? undefined,
    overall: metricSet(scored),
    activeCohort: metricSet(active),
    flatTwoBaseline: metricSet(active.map((row) => ({ ...row, projected: 2 }))),
    topPickResults: topPickResults(scored),
    topPickResultsNote: isReconstructed
      ? "GW7 is reconstructed after the deadline, so treat this as audit-only selection signal, not a pre-deadline result."
      : "This is selection signal from the frozen forecast pool, not a guaranteed squad result.",
    byPosition,
    largestMisses: [...scored]
      .sort((a, b) => b.absoluteError - a.absoluteError || a.name.localeCompare(b.name))
      .slice(0, 12),
    bestPredictions: active
      .filter((row) => row.actual >= 4 && row.absoluteError <= 1.5)
      .sort((a, b) => b.actual - a.actual || a.absoluteError - b.absoluteError || a.name.localeCompare(b.name))
      .slice(0, 12),
    bestPredictionsTitle: isReconstructed ? "Closest calls in the reconstruction" : undefined,
    bestPredictionsNote: isReconstructed
      ? "High-output players scoring at least 4 points where the reconstructed baseline was within 1.5 points. These are not the original GW deadline calls."
      : "High-output players scoring at least 4 points where the pre-deadline forecast was within 1.5 points of the official result.",
  };
  return report;
}

async function registerReport(gameweek, activeGameweek) {
  let source = await readFile(MODELBOOK_TS, "utf8");
  const reportImport = `import gw${gameweek}Report from "@/public/modelbook/data/gw${gameweek}-report.json";`;
  const metaImport = `import gw${gameweek}Meta from "@/public/modelbook/data/gw${gameweek}-snapshot-meta.json";`;
  if (!source.includes(reportImport)) {
    if (!source.includes(ARCHIVE_IMPORT_MARKER)) throw new Error("Could not locate the Modelbook archive import marker");
    source = source.replace(ARCHIVE_IMPORT_MARKER, `${reportImport}\n${metaImport}\n${ARCHIVE_IMPORT_MARKER}`);
  }
  const entry = `  ${gameweek}: { report: gw${gameweek}Report as ModelbookReport, meta: gw${gameweek}Meta as SnapshotMeta },`;
  const archiveMarker = "const ARCHIVE: Record<number, { report: ModelbookReport; meta?: SnapshotMeta }> = {\n";
  if (!source.includes(entry)) {
    if (!source.includes(archiveMarker)) throw new Error("Could not locate the Modelbook archive map");
    source = source.replace(archiveMarker, `${archiveMarker}${entry}\n`);
  }
  source = source.replace(/export const CURRENT_GAMEWEEK = \d+;/, `export const CURRENT_GAMEWEEK = ${activeGameweek};`);
  await writeFile(MODELBOOK_TS, source, "utf8");
}

async function captureUpcomingSnapshot(events) {
  const now = Date.now();
  let candidates = events.filter((event) => !event.finished && event.deadline_time && (!requestedEvent || Number(event.id) === requestedEvent));
  candidates = candidates.sort((a, b) => Date.parse(a.deadline_time) - Date.parse(b.deadline_time));
  for (const event of candidates) {
    const gameweek = Number(event.id);
    const deadline = Date.parse(event.deadline_time);
    const remaining = deadline - now;
    if (remaining <= 0) {
      if (requestedEvent) console.log(`GW${gameweek} deadline has passed; refusing to create a retroactive forecast lock.`);
      continue;
    }
    if (await readJson(snapshotFile(gameweek))) continue;

    const candidate = await readJson(checkpointFile(gameweek));
    if (remaining > CAPTURE_WINDOW_MS) {
      if (!isCheckpointDue(deadline, candidate?.capturedAt, now)) continue;
      const source = `${SITE_URL}/api/ledger/snapshot?event=${gameweek}`;
      const response = await fetch(`${source}&capture=${now}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Projection endpoint returned ${response.status} for GW${gameweek} checkpoint`);
      const snapshot = await response.json();
      const generatedAt = Date.parse(snapshot.generatedAt ?? "");
      if (Number(snapshot.gameweek) !== gameweek || !Array.isArray(snapshot.rows) || !snapshot.rows.length || !Number.isFinite(generatedAt) || generatedAt >= deadline) {
        throw new Error(`Projection endpoint returned an invalid or late GW${gameweek} checkpoint`);
      }
      const canonicalSnapshot = JSON.stringify(snapshot);
      const contentHash = digest(canonicalSnapshot);
      await mkdir(STATE_DIR, { recursive: true });
      await writeJson(checkpointFile(gameweek), {
        gameweek,
        capturedAt: snapshot.generatedAt,
        deadlineTime: event.deadline_time,
        contentHash,
        contentHashAlgorithm: "sha256",
        snapshot,
      });
      console.log(`Saved a GW${gameweek} pre-deadline checkpoint ${Math.max(0, Math.ceil(remaining / 60_000))} minutes before the deadline; SHA-256 ${contentHash}.`);
      return true;
    }
    if (!isCaptureWindow(deadline, now)) continue;

    const source = `${SITE_URL}/api/ledger/snapshot?event=${gameweek}`;
    const fetchUrl = `${source}&freeze=${now}`;
    const response = await fetch(fetchUrl, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Projection endpoint returned ${response.status} for GW${gameweek}`);
    const raw = await response.text();
    const snapshot = JSON.parse(raw);
    if (Number(snapshot.gameweek) !== gameweek || !Array.isArray(snapshot.rows) || !snapshot.rows.length) {
      throw new Error(`Projection endpoint returned an invalid GW${gameweek} snapshot`);
    }
    if (Date.now() >= deadline) {
      console.log(`GW${gameweek} deadline passed during capture; refusing to publish a late lock.`);
      return false;
    }
    const capturedAt = snapshot.generatedAt ?? new Date().toISOString();
    const canonicalSnapshot = JSON.stringify(snapshot);
    const contentHash = digest(canonicalSnapshot);
    const lock = {
      lockSchemaVersion: 3,
      gameweek,
      lockedAt: capturedAt,
      lockMode: "automatic-predeadline",
      lockNote: "Automatically captured shortly before the official FPL deadline. This exact export is the immutable scoring baseline.",
      deadlineTime: event.deadline_time,
      modelVersion: snapshot.modelVersion,
      source,
      contentHashAlgorithm: "sha256",
      contentHash,
      sourceByteLength: Buffer.byteLength(canonicalSnapshot),
      snapshot,
    };
    const sampleProjections = [...snapshot.rows]
      .sort((a, b) => Number(b.projected ?? 0) - Number(a.projected ?? 0))
      .slice(0, 8)
      .map((row) => ({ id: row.id, name: row.name, projected: row.projected, fixture: row.fixture }));
    const meta = {
      season: "2026-27",
      gameweek,
      lockedAt: capturedAt,
      deadline: event.deadline_time,
      modelVersion: snapshot.modelVersion,
      sourceModelVersion: snapshot.modelVersion,
      lockedBeforeDeadline: true,
      contentHash,
      feeds: ["Official Fantasy Premier League bootstrap and fixture data", "FPL Prism production projection endpoint"],
      sampleProjections,
    };
    await writeJson(snapshotFile(gameweek), lock);
    await writeJson(snapshotMetaFile(gameweek), meta);
    await unlink(checkpointFile(gameweek)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    console.log(`Locked GW${gameweek} ${Math.max(0, Math.ceil(remaining / 60_000))} minutes before the deadline; SHA-256 ${contentHash}.`);
    return true;
  }
  if (requestedEvent) console.log(`No new snapshot captured for requested GW${requestedEvent}.`);
  return false;
}

async function recoverMissedDeadlineLocks(events) {
  const now = Date.now();
  for (const event of events) {
    const gameweek = Number(event.id);
    const deadline = Date.parse(event.deadline_time ?? "");
    if (!Number.isInteger(gameweek) || !Number.isFinite(deadline) || deadline > now) continue;
    if (await readJson(snapshotFile(gameweek))) continue;
    const candidate = await readJson(checkpointFile(gameweek));
    if (!isValidCheckpoint(candidate, gameweek, event.deadline_time)) {
      if (candidate) console.warn(`Discarding invalid or post-deadline GW${gameweek} checkpoint; no forecast lock was created.`);
      continue;
    }
    const contentHash = candidate.contentHash;
    const canonicalSnapshot = JSON.stringify(candidate.snapshot);
    const lock = {
      lockSchemaVersion: 3,
      gameweek,
      lockedAt: candidate.capturedAt,
      lockMode: "automatic-predeadline-fallback",
      lockNote: "The scheduled final lock was missed. This immutable fallback uses the most recent verified checkpoint captured before the official deadline.",
      deadlineTime: event.deadline_time,
      modelVersion: candidate.snapshot.modelVersion,
      source: `${SITE_URL}/api/ledger/snapshot?event=${gameweek}`,
      contentHashAlgorithm: "sha256",
      contentHash,
      sourceByteLength: Buffer.byteLength(canonicalSnapshot),
      snapshot: candidate.snapshot,
    };
    await writeJson(snapshotFile(gameweek), lock);
    await writeJson(snapshotMetaFile(gameweek), {
      season: "2026-27",
      gameweek,
      lockedAt: candidate.capturedAt,
      deadline: event.deadline_time,
      modelVersion: candidate.snapshot.modelVersion,
      sourceModelVersion: candidate.snapshot.modelVersion,
      lockedBeforeDeadline: true,
      captureType: "last-predeadline-checkpoint",
      contentHash,
      feeds: ["Official Fantasy Premier League bootstrap and fixture data", "FPL Prism production projection endpoint"],
      sampleProjections: [...candidate.snapshot.rows]
        .sort((a, b) => Number(b.projected ?? 0) - Number(a.projected ?? 0))
        .slice(0, 8)
        .map((row) => ({ id: row.id, name: row.name, projected: row.projected, fixture: row.fixture })),
    });
    await unlink(checkpointFile(gameweek));
    console.warn(`Recovered a missed GW${gameweek} deadline lock from its verified pre-deadline checkpoint (${candidate.capturedAt}).`);
  }
}

async function archiveFinishedGameweeks(activeGameweek) {
  const files = (await readdir(DATA_DIR)).filter((name) => /^gw\d+-locked\.json$/.test(name));
  for (const file of files) {
    const lock = await readJson(path.join(DATA_DIR, file));
    const gameweek = Number(lock?.gameweek);
    if (!Number.isInteger(gameweek) || !lock?.contentHash || !lock?.snapshot?.rows?.length) continue;
    const isManagedLock = ["automatic-predeadline", "automatic-predeadline-fallback"].includes(lock.lockMode);
    const isReconstructed = lock.lockMode === "retrospective-reconstruction";
    if ((isManagedLock || isReconstructed)
      && digest(JSON.stringify(lock.snapshot)) !== lock.contentHash) {
      throw new Error(`GW${gameweek} frozen snapshot hash does not match its contents`);
    }
    const currentReport = await readJson(reportFile(gameweek));
    if (!isManagedLock && !isReconstructed && currentReport) continue;
    // A finalized archive is immutable. Later FPL fixture responses can omit
    // finished=true even after an earlier response marked every match final.
    if (currentReport?.final === true) continue;
    if (currentReport?.actualsFinality?.fixtureCount > 0
      && currentReport.actualsFinality.finished === currentReport.actualsFinality.fixtureCount) continue;
    const [fixtures, livePayload] = await Promise.all([
      fetchJson(`${FPL_API}/fixtures/?event=${gameweek}`),
      fetchJson(`${FPL_API}/event/${gameweek}/live/`),
    ]);
    if (!Array.isArray(fixtures) || !fixtures.length || !fixtures.every((fixture) => fixture.finished_provisional || fixture.finished)) continue;
    const fetchedAt = new Date().toISOString();
    const nextReport = archiveReport(gameweek, lock, livePayload, fixtures, fetchedAt);
    const comparable = (value) => {
      if (!value) return null;
      const clone = structuredClone(value);
      delete clone.generatedAt;
      delete clone.actualsFetchedAt;
      return clone;
    };
    const reportChanged = JSON.stringify(comparable(currentReport)) !== JSON.stringify(comparable(nextReport));
    if (!reportChanged) continue;

    const snapshotMeta = await readJson(snapshotMetaFile(gameweek)) ?? {
      lockedAt: lock.lockedAt,
      deadline: lock.deadlineTime,
      contentHash: lock.contentHash,
      lockedBeforeDeadline: !isReconstructed,
      reconstruction: isReconstructed,
    };
    await writeJson(reportFile(gameweek), nextReport);
    await writeJson(actualsFile(gameweek), {
      gameweek,
      fetchedAt,
      source: `${FPL_API}/event/${gameweek}/live/`,
      fixturesSource: `${FPL_API}/fixtures/?event=${gameweek}`,
      finality: nextReport.actualsFinality,
      elements: livePayload.elements,
      fixtures,
    });
    await writeJson(snapshotMetaFile(gameweek), snapshotMeta);
    await registerReport(gameweek, activeGameweek);
    console.log(`Published the GW${gameweek} report from its frozen snapshot (${nextReport.activeCohort.count} active players).`);
  }
}

async function main() {
  const bootstrap = await fetchJson(`${FPL_API}/bootstrap-static/`);
  const captured = await captureUpcomingSnapshot(bootstrap.events ?? []);
  await recoverMissedDeadlineLocks(bootstrap.events ?? []);
  const activeGameweek = Number(bootstrap.events?.find((event) => event.is_next)?.id ?? bootstrap.events?.find((event) => event.is_current)?.id ?? 8);
  await archiveFinishedGameweeks(activeGameweek);
  if (!captured && !requestedEvent) console.log("No deadline snapshot was due on this run.");
}

export { archiveReport, isCaptureWindow, isCheckpointDue, isValidCheckpoint, metricSet, CHECKPOINT_INTERVAL_MS, CHECKPOINT_WINDOW_MS };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
