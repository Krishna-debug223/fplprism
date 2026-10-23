import Link from "next/link";
import { ARCHIVED_GAMEWEEKS, CURRENT_GAMEWEEK } from "@/lib/modelbook";
import styles from "./Modelbook.module.css";

export default function ModelbookNav({ active }: { active: "current" | "benchmark" | number }) {
  return (
    <nav className={styles.nav} aria-label="Modelbook Gameweeks">
      <div className="segmented">
        <Link href="/modelbook" aria-current={active === "current" ? "page" : undefined}>GW{CURRENT_GAMEWEEK} · live</Link>
        <Link href="/modelbook/benchmark" aria-current={active === "benchmark" ? "page" : undefined}>Benchmark</Link>
        {ARCHIVED_GAMEWEEKS.map((gw) => (
          <Link key={gw} href={`/modelbook/reports/gw${gw}`} aria-current={active === gw ? "page" : undefined}>GW{gw}</Link>
        ))}
      </div>
    </nav>
  );
}
