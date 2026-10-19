import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import AdSlot from "@/components/AdSlot";
import AdSenseLoader from "@/components/AdSenseLoader";
import SiteAnalytics from "@/components/SiteAnalytics";
import SlidingIndicators from "@/components/SlidingIndicators";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { getSiteUrl } from "@/lib/site-url";
import "./globals.css";

const inter = Inter({
  variable: "--font-app-sans",
  subsets: ["latin"],
  display: "swap",
});

const siteUrl = getSiteUrl();
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "FPL Prism — Fantasy Premier League decision analytics",
    template: "%s · FPL Prism",
  },
  description: "Import a public FPL squad, compare legal transfers after hits and budget, and see the expected points and outcome range behind each decision.",
  applicationName: "FPL Prism",
  keywords: ["FPL", "Fantasy Premier League", "FPL transfers", "FPL expected points", "FPL planner"],
  alternates: { canonical: "/" },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.png", type: "image/png", sizes: "64x64" },
    ],
    shortcut: ["/favicon.ico"],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "FPL Prism",
    title: "FPL Prism — Fantasy Premier League decision analytics",
    description: "Import a public FPL squad and compare transfers using expected points, outcome ranges, hits and budget.",
  },
  twitter: {
    card: "summary_large_image",
    title: "FPL Prism — Fantasy Premier League decision analytics",
    description: "Compare FPL transfers using expected points, outcome ranges, hits and budget.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#14181d",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB" className={inter.variable}>
      <body>
        <SiteHeader />
        <AdSlot placement="top" />
        <div id="main-content" tabIndex={-1}>{children}</div>
        <AdSlot placement="bottom" />
        <SiteFooter />
        <SiteAnalytics />
        <SlidingIndicators />
        <AdSenseLoader />
      </body>
    </html>
  );
}
