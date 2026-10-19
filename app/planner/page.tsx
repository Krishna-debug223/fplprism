import StrategyPlanner from "@/components/StrategyPlanner";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  title: "FPL Prism Planner — Eight-gameweek planning",
  description: "Plan FPL transfers across the next eight Gameweeks with roll decisions, legal transfer packages and risk-aware strategy modes.",
  path: "/planner",
  noindex: true,
});

export default function PlannerPage() {
  return <StrategyPlanner />;
}
