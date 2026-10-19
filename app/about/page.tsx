import Link from "next/link";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  title: "About FPL Prism — Independent FPL decision support",
  description: "Learn what FPL Prism does, where its Fantasy Premier League data comes from, and how it reports model uncertainty and past results.",
  path: "/about",
});

export default function AboutPage() {
  return (
    <main className="page page-narrow">
      <article className="prose">
        <h1>About FPL Prism</h1>
        <p className="lead">
          FPL Prism is an independent decision-support tool for Fantasy Premier League managers. It puts expected points,
          likely ranges and squad constraints together so you can judge a move before making it.
        </p>

        <h2>What it helps with</h2>
        <p>
          You can review your squad, compare captain options, test transfers against holding and plan across future Gameweeks.
          Recommendations use the same player projections, then account for budget, position, club limits and points hits.
        </p>

        <h2>How to judge the model</h2>
        <p>
          Expected points are averages, not promises. FPL Prism also shows ranges and risk so a higher average is not mistaken
          for a guaranteed result. The <Link href="/modelbook">public Modelbook</Link> compares published forecasts with
          official points and keeps each report&apos;s provenance visible, including where an older forecast had to be reconstructed.
        </p>

        <h2>Data and privacy</h2>
        <p>
          The app uses public Fantasy Premier League information and historical football data. A Team ID is used to read a
          public squad; FPL Prism never asks for an official FPL password and cannot make transfers for you. Read the full
          <Link href="/privacy"> privacy policy</Link> for details.
        </p>

        <h2>Independent project</h2>
        <p>
          FPL Prism is not affiliated with, endorsed by or sponsored by the Premier League. Fantasy Premier League and related
          names and marks belong to their respective owners.
        </p>

        <p><Link href="/how-it-works">Read how the model works</Link> or <Link href="/contact">send product feedback</Link>.</p>
      </article>
    </main>
  );
}
