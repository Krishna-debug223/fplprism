import type { FplEvent, FplPlayer } from "./types";

/**
 * FPL exposes separate availability estimates for the current and next round.
 * Once the deadline moves on, the next-round field may describe the following
 * Gameweek even while this week's later fixtures have not kicked off.
 */
export function playerForForecastEvent(player: FplPlayer, event: Pick<FplEvent, "is_current"> | undefined): FplPlayer {
  if (!event?.is_current || player.chance_of_playing_this_round == null) return player;
  return { ...player, chance_of_playing_next_round: player.chance_of_playing_this_round };
}
