"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type MouseEvent } from "react";
import { dashboardHref, dashboardView, guideLinks, isPlainClick, showDashboardView, type DashboardView } from "@/lib/navigation";
import BrandMark from "./BrandMark";
import styles from "./SiteHeader.module.css";

const learnLinks = [{ href: "/how-it-works", label: "How FPL Prism works" }, ...guideLinks];

type NavLink = { href: string; label: string; active: boolean; inPage?: boolean };

function HeaderContent({ search = "" }: { search?: string }) {
  const pathname = usePathname();
  const headerRef = useRef<HTMLElement>(null);
  const [rememberedTeam, setRememberedTeam] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [learnOpen, setLearnOpen] = useState(false);

  const onDashboard = pathname === "/dashboard";
  const view = dashboardView(search);
  // Keep the imported team in the URL when moving between dashboard views.
  const dashboardSearch = onDashboard ? search : rememberedTeam ? `team=${rememberedTeam}` : "";
  const dash = (target: DashboardView, label: string): NavLink => ({
    href: dashboardHref(target, dashboardSearch),
    label,
    active: onDashboard && view === target,
    inPage: onDashboard,
  });
  // Already on the dashboard: swap the view in place instead of reloading the route.
  const linkProps = (link: NavLink) => ({
    href: link.href,
    "aria-current": link.active ? ("page" as const) : undefined,
    onClick: link.inPage
      ? (event: MouseEvent<HTMLAnchorElement>) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        setMenuOpen(false);
        setLearnOpen(false);
        showDashboardView(link.href);
      }
      : undefined,
  });

  const primary: NavLink[] = [
    dash("overview", "Dashboard"),
    dash("team", "My team"),
    dash("transfer", "Transfers"),
    dash("market", "Players"),
    { href: "/planner", label: "Planner", active: pathname === "/planner" },
    { href: "/modelbook", label: "Modelbook", active: pathname.startsWith("/modelbook") },
  ];
  const learn: NavLink[] = [
    ...learnLinks.map((link) => ({ ...link, active: pathname === link.href })),
    dash("model", "Model details"),
  ];
  const learnActive = learn.some((link) => link.active);

  useEffect(() => {
    const saved = window.localStorage.getItem("fpl-risk-team-id") ?? "";
    setRememberedTeam(/^\d+$/.test(saved) ? saved : "");
    setMenuOpen(false);
    setLearnOpen(false);
  }, [pathname, search]);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !header.contains(event.target)) {
        setLearnOpen(false);
        setMenuOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLearnOpen(false);
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  return (
    <header className={styles.header} ref={headerRef}>
      <a className={styles.skip} href="#main-content">Skip to content</a>
      <div className={styles.bar}>
        <Link href="/" className={styles.brand} aria-label="FPL Prism home">
          <BrandMark className={styles.mark} />
          <span>FPL Prism</span>
        </Link>

        <nav className={styles.primary} aria-label="Main" data-slide="underline">
          {primary.map((link) => (
            <Link key={link.label} {...linkProps(link)}>{link.label}</Link>
          ))}
        </nav>

        <div className={styles.secondary}>
          <div className={styles.menuWrap}>
            <button
              type="button"
              className={learnActive ? styles.activeButton : undefined}
              aria-expanded={learnOpen}
              aria-controls="learn-menu"
              onClick={() => setLearnOpen((open) => !open)}
            >
              Learn <span className={styles.caret} aria-hidden="true" />
            </button>
            {learnOpen && (
              <div className={styles.dropdown} id="learn-menu">
                {learn.map((link) => (
                  <Link key={link.href} {...linkProps(link)}>{link.label}</Link>
                ))}
              </div>
            )}
          </div>
          <Link href="/pricing" aria-current={pathname === "/pricing" ? "page" : undefined}>Pricing</Link>
          <Link href="/account" aria-current={pathname === "/account" || pathname === "/sign-in" ? "page" : undefined}>Account</Link>
        </div>

        <button
          type="button"
          className={styles.menuButton}
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className={styles.menuIcon} aria-hidden="true"><span /><span /><span /></span>
          {menuOpen ? "Close" : "Menu"}
        </button>
      </div>

      {/* Always rendered so it can slide open and closed; inert while closed. */}
      <nav className={styles.mobile} id="mobile-menu" aria-label="Main" data-open={menuOpen || undefined} inert={!menuOpen}>
        <div className={styles.mobileInner}>
          <div>
            <span className={styles.mobileHeading}>Tools</span>
            {primary.map((link) => (
              <Link key={link.label} {...linkProps(link)}>{link.label}</Link>
            ))}
          </div>
          <div>
            <span className={styles.mobileHeading}>Learn</span>
            {learn.map((link) => (
              <Link key={link.href} {...linkProps(link)}>{link.label}</Link>
            ))}
          </div>
          <div>
            <span className={styles.mobileHeading}>Site</span>
            <Link href="/pricing">Pricing</Link>
            <Link href="/about">About</Link>
            <Link href="/contact">Contact</Link>
            <Link href="/account">Account</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </div>
        </div>
      </nav>
    </header>
  );
}

function SearchAwareHeader() {
  const searchParams = useSearchParams();
  return <HeaderContent search={searchParams.toString()} />;
}

export default function SiteHeader() {
  return <Suspense fallback={<HeaderContent />}><SearchAwareHeader /></Suspense>;
}
