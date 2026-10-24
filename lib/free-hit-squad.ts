import loadHighs from "highs";

export type SquadPosition = "GKP" | "DEF" | "MID" | "FWD";
export type SquadRole = "captain" | "vice" | "starter" | "benchGoalkeeper" | "bench1" | "bench2" | "bench3";
export type SquadPlayer = {
  id: number;
  name: string;
  teamId: number;
  team: string;
  position: SquadPosition;
  price: number; // Official FPL tenths of £m.
  projected: number;
};

export type SquadPick = SquadPlayer & { role: SquadRole; multiplier: number };
export type SquadResult = {
  picks: SquadPick[];
  totalPrice: number;
  weightedExpectedPoints: number;
  modelStatus: "Optimal";
};
export type OfficialPlayerPoints = { id: number; points: number; minutes: number; appeared?: boolean };
export type SquadScore = {
  points: number;
  countedIds: number[];
  substitutedIds: number[];
  captainBonusId: number | null;
};

const roleMultipliers: Record<SquadRole, number> = {
  captain: 2,
  vice: 1.0322,
  starter: 1,
  benchGoalkeeper: 0.0194,
  bench1: 0.2603,
  bench2: 0.0751,
  bench3: 0.0165,
};
const roles: SquadRole[] = ["captain", "vice", "starter", "benchGoalkeeper", "bench1", "bench2", "bench3"];
const starters = new Set<SquadRole>(["captain", "vice", "starter"]);
const positionCounts: Record<SquadPosition, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };

function availableRoles(position: SquadPosition): SquadRole[] {
  return position === "GKP"
    ? ["captain", "vice", "starter", "benchGoalkeeper"]
    : ["captain", "vice", "starter", "bench1", "bench2", "bench3"];
}

function term(player: SquadPlayer, role: SquadRole) {
  return `p${player.id}_${role}`;
}

function linear(terms: Array<{ variable: string; coefficient: number }>) {
  const included = terms.filter((item) => item.coefficient !== 0);
  return included.length
    ? included.map((item, index) => `${index ? (item.coefficient < 0 ? " - " : " + ") : item.coefficient < 0 ? "- " : ""}${Math.abs(item.coefficient)} ${item.variable}`).join("")
    : "0";
}

export function buildFreeHitModel(players: SquadPlayer[], requiredPlayerId?: number) {
  const eligible = players.filter((player) =>
    Number.isInteger(player.id) && Number.isInteger(player.teamId) && Number.isInteger(player.price)
    && player.price > 0 && Number.isFinite(player.projected)
    && Object.hasOwn(positionCounts, player.position));
  if (new Set(eligible.map((player) => player.id)).size !== eligible.length) throw new Error("Duplicate FPL player IDs in forecast pool");
  if (requiredPlayerId !== undefined && !eligible.some((player) => player.id === requiredPlayerId)) {
    throw new Error(`Required player ${requiredPlayerId} is not in the eligible forecast pool`);
  }
  const choices = eligible.flatMap((player) => availableRoles(player.position).map((role) => ({ player, role, variable: term(player, role) })));
  const subjectTo: string[] = [];
  const add = (name: string, selected: typeof choices, coefficient: (choice: (typeof choices)[number]) => number, relation: string, bound: number) => {
    subjectTo.push(` ${name}: ${linear(selected.map((choice) => ({ variable: choice.variable, coefficient: coefficient(choice) })))} ${relation} ${bound}`);
  };
  for (const role of roles) {
    add(`role_${role}`, choices.filter((choice) => choice.role === role), () => 1, "=", role === "starter" ? 9 : 1);
  }
  for (const [position, count] of Object.entries(positionCounts)) {
    add(`position_${position}`, choices.filter((choice) => choice.player.position === position), () => 1, "=", count);
  }
  add("budget", choices, (choice) => choice.player.price, "<=", 1000);
  const clubIds = [...new Set(eligible.map((player) => player.teamId))];
  for (const clubId of clubIds) add(`club_${clubId}`, choices.filter((choice) => choice.player.teamId === clubId), () => 1, "<=", 3);
  for (const player of eligible) add(`once_${player.id}`, choices.filter((choice) => choice.player.id === player.id), () => 1, "<=", 1);
  if (requiredPlayerId !== undefined) {
    add(`required_${requiredPlayerId}`, choices.filter((choice) => choice.player.id === requiredPlayerId), () => 1, "=", 1);
  }
  for (const [position, relation, bound] of [["GKP", "=", 1], ["DEF", ">=", 3], ["FWD", ">=", 1]] as const) {
    add(`starting_${position}`, choices.filter((choice) => choice.player.position === position && starters.has(choice.role)), () => 1, relation, bound);
  }
  const objective = linear(choices.map((choice) => ({
    variable: choice.variable,
    coefficient: Number((choice.player.projected * roleMultipliers[choice.role]).toFixed(8)),
  })));
  const model = `Maximize\n obj: ${objective}\nSubject To\n${subjectTo.join("\n")}\nBinaries\n ${choices.map((choice) => choice.variable).join(" ")}\nEnd`;
  return { model, choices, eligible };
}

let highsPromise: ReturnType<typeof loadHighs> | null = null;

export async function selectFreeHitSquad(players: SquadPlayer[], requiredPlayerId?: number): Promise<SquadResult> {
  const { model, choices } = buildFreeHitModel(players, requiredPlayerId);
  highsPromise ??= loadHighs().catch((error) => { highsPromise = null; throw error; });
  const highs = await highsPromise;
  const solution = highs.solve(model, { output_flag: false, mip_rel_gap: 0, time_limit: 30 });
  if (solution.Status !== "Optimal") throw new Error(`Free Hit optimizer status: ${solution.Status}`);
  const picks = choices.filter((choice) => solution.Columns[choice.variable]?.Primal > 0.5)
    .map((choice) => ({ ...choice.player, role: choice.role, multiplier: roleMultipliers[choice.role] }));
  validateFreeHitSquad(picks);
  return {
    picks,
    totalPrice: picks.reduce((sum, pick) => sum + pick.price, 0),
    weightedExpectedPoints: picks.reduce((sum, pick) => sum + pick.projected * pick.multiplier, 0),
    modelStatus: "Optimal",
  };
}

export function validateFreeHitSquad(picks: SquadPick[]) {
  if (picks.length !== 15 || new Set(picks.map((pick) => pick.id)).size !== 15) throw new Error("Free Hit squad must contain 15 unique players");
  if (picks.reduce((sum, pick) => sum + pick.price, 0) > 1000) throw new Error("Free Hit squad exceeds £100m");
  for (const [position, count] of Object.entries(positionCounts)) {
    if (picks.filter((pick) => pick.position === position).length !== count) throw new Error(`Invalid ${position} squad count`);
  }
  for (const club of new Set(picks.map((pick) => pick.teamId))) {
    if (picks.filter((pick) => pick.teamId === club).length > 3) throw new Error("Free Hit squad exceeds the club limit");
  }
  for (const role of roles) {
    if (picks.filter((pick) => pick.role === role).length !== (role === "starter" ? 9 : 1)) throw new Error(`Invalid ${role} count`);
  }
  const eleven = picks.filter((pick) => starters.has(pick.role));
  if (eleven.filter((pick) => pick.position === "GKP").length !== 1 || eleven.filter((pick) => pick.position === "DEF").length < 3 || eleven.filter((pick) => pick.position === "FWD").length < 1) throw new Error("Invalid starting formation");
  if (picks.find((pick) => pick.role === "benchGoalkeeper")?.position !== "GKP") throw new Error("Invalid bench goalkeeper");
  if (picks.some((pick) => ["bench1", "bench2", "bench3"].includes(pick.role) && pick.position === "GKP")) throw new Error("Outfield bench contains a goalkeeper");
}

/** Score a completed Gameweek using official player points and bench priority. */
export function scoreFreeHitSquad(picks: SquadPick[], points: OfficialPlayerPoints[]): SquadScore {
  validateFreeHitSquad(picks);
  const byId = new Map(points.map((item) => [item.id, item]));
  const appeared = (pick: SquadPick) => {
    const player = byId.get(pick.id);
    return Boolean(player && (player.minutes > 0 || player.appeared));
  };
  const ordered = [...picks].sort((a, b) => a.id - b.id);
  const starting = ordered.filter((pick) => starters.has(pick.role));
  const counted = starting.filter(appeared);
  const missing = starting.filter((pick) => !appeared(pick));
  const formation: Record<SquadPosition, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const pick of starting) formation[pick.position] += 1;
  const substitutions: SquadPick[] = [];
  const goalkeeper = picks.find((pick) => pick.role === "benchGoalkeeper")!;
  const missingKeeper = missing.find((pick) => pick.position === "GKP");
  if (missingKeeper && appeared(goalkeeper)) {
    counted.push(goalkeeper);
    substitutions.push(goalkeeper);
    missing.splice(missing.indexOf(missingKeeper), 1);
  }
  for (const role of ["bench1", "bench2", "bench3"] as const) {
    const benchPick = picks.find((pick) => pick.role === role)!;
    if (!appeared(benchPick)) continue;
    const replacementIndex = missing.findIndex((absent) => {
      if (absent.position === "GKP") return false;
      const updated = { ...formation };
      updated[absent.position] -= 1;
      updated[benchPick.position] += 1;
      return updated.GKP === 1 && updated.DEF >= 3 && updated.FWD >= 1;
    });
    if (replacementIndex === -1) continue;
    const [replaced] = missing.splice(replacementIndex, 1);
    formation[replaced.position] -= 1;
    formation[benchPick.position] += 1;
    counted.push(benchPick);
    substitutions.push(benchPick);
  }
  const captain = picks.find((pick) => pick.role === "captain")!;
  const vice = picks.find((pick) => pick.role === "vice")!;
  const captainBonusId = appeared(captain) ? captain.id : appeared(vice) ? vice.id : null;
  const base = counted.reduce((sum, pick) => sum + (byId.get(pick.id)?.points ?? 0), 0);
  return {
    points: base + (captainBonusId == null ? 0 : byId.get(captainBonusId)?.points ?? 0),
    countedIds: counted.map((pick) => pick.id),
    substitutedIds: substitutions.map((pick) => pick.id),
    captainBonusId,
  };
}
