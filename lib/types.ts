export type FplPlayer = {
  id: number;
  code: number;
  web_name: string;
  first_name: string;
  second_name: string;
  team: number;
  element_type: number;
  now_cost: number;
  total_points: number;
  minutes: number;
  starts: number;
  form: string;
  points_per_game: string;
  selected_by_percent: string;
  ep_next: string | null;
  chance_of_playing_next_round: number | null;
  status: string;
  news?: string;
  news_added?: string | null;
  chance_of_playing_this_round?: number | null;
  expected_goals: string;
  expected_assists: string;
  expected_goal_involvements: string;
  expected_goals_per_90: string;
  expected_assists_per_90: string;
  expected_goal_involvements_per_90: string;
  expected_goals_conceded?: string;
  expected_goals_conceded_per_90: string;
  clean_sheets: number;
  clean_sheets_per_90?: string;
  saves: number;
  saves_per_90?: string;
  goals_conceded_per_90?: string;
  bonus: number;
  bps: number;
  yellow_cards?: number;
  red_cards?: number;
  penalties_saved?: number;
  penalties_missed?: number;
  penalties_order?: number | null;
  defensive_contribution?: number;
  defensive_contribution_per_90?: string;
  transfers_in_event: number;
  transfers_out_event: number;
  /** Live bootstrap fields used by the market tape when available. */
  event_points?: number;
  cost_change_event?: number;
  cost_change_start?: number;
};

export type FplTeam = {
  id: number;
  name: string;
  short_name: string;
  strength: number;
  strength_overall_home?: number;
  strength_overall_away?: number;
  strength_attack_home: number;
  strength_attack_away: number;
  strength_defence_home: number;
  strength_defence_away: number;
  elo?: number;
  underlying_matches?: number;
  underlying_attack_xg_per_match?: number;
  underlying_attack_xa_per_match?: number;
  underlying_defence_xga_per_match?: number;
};

export type FplEvent = {
  id: number;
  name: string;
  deadline_time: string;
  finished: boolean;
  is_current: boolean;
  is_next: boolean;
  average_entry_score: number;
  highest_score: number;
};

export type FplFixture = {
  id: number;
  event: number | null;
  team_h: number;
  team_a: number;
  team_h_difficulty: number;
  team_a_difficulty: number;
  team_h_score?: number | null;
  team_a_score?: number | null;
  kickoff_time: string | null;
  finished: boolean;
  finished_provisional?: boolean;
  started: boolean;
};

export type BootstrapPayload = {
  elements: FplPlayer[];
  teams: FplTeam[];
  events: FplEvent[];
  fetchedAt: string;
};

export type NewsScanAlert = {
  playerId: number;
  playerName: string;
  teamId: number;
  team: string;
  status: string;
  chanceOfPlaying: number | null;
  news: string;
  newsAdded: string | null;
  kickoffTime: string | null;
  severity: "high" | "medium" | "low";
};

export type NewsScanPayload = {
  schemaVersion: 1;
  eventId: number;
  eventName: string;
  deadlineTime: string;
  scanWindowStart: string;
  windowState: "scheduled" | "active" | "closed";
  scannedAt: string;
  source: "official-fpl-bootstrap";
  alerts: NewsScanAlert[];
  summary: { high: number; medium: number; low: number; total: number };
};

export type LivePointsPayload = {
  eventId: number;
  fetchedAt: string;
  elements: Array<{ id: number; points: number; minutes: number; played: boolean }>;
};

export type ManagerPick = {
  element: number;
  position: number;
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
  purchase_price?: number;
  selling_price?: number;
};

export type HistoricalSeasonSummary = {
  season: string;
  minutes: number;
  starts: number;
  totalPoints: number;
  pointsPerGame: number;
  xgi90: number;
  expectedGoalsPer90?: number;
  expectedAssistsPer90?: number;
  expectedGoalsConcededPer90?: number;
  defensiveContributionPer90?: number;
  savesPer90?: number;
  cleanSheetsPer90?: number;
  bonusPer90?: number;
  yellowCardsPer90?: number;
  startsPerMatch?: number;
  minutesPerStart?: number;
};

export type HistoricalPayload = {
  players: Record<string, HistoricalSeasonSummary[]>;
  seasons: string[];
  fetchedAt: string;
  source: string;
  partial?: boolean;
};

/**
 * Public training provenance shared by the live Modelbook and dashboard.
 * A Gameweek forecast is trained through the last completed Gameweek, while
 * current-season minutes and rates are blended into stable historical priors.
 */
export type ModelTrainingStatus = {
  trainedThroughGameweek: number;
  targetGameweek: number;
  updatedAt: string;
  source: string;
  method: string;
  validation: string;
};

export type TeamIntelligencePayload = {
  teams: Array<{ id: number; shortName: string; elo: number }>;
  fetchedAt: string;
  source: string;
};

export type UsedChip = {
  name: string;
  event: number;
  time?: string;
};

export type ManagerPayload = {
  id: number;
  teamName: string;
  managerName: string;
  overallPoints: number | null;
  overallRank: number | null;
  gameweekPoints: number | null;
  bank: number | null;
  teamValue: number | null;
  eventId: number;
  activeChip: string | null;
  chipsUsed: UsedChip[];
  picks: ManagerPick[];
  /**
   * Set when a Free Hit was played on the latest public picks. FPL restores the
   * squad from the previous deadline, so `picks`, `bank` and `teamValue` hold
   * that restored squad and the Free Hit picks are kept here for scoring views.
   */
  freeHitRevert?: { freeHitEvent: number; squadEvent: number; freeHitPicks: ManagerPick[] } | null;
  fetchedAt: string;
};
