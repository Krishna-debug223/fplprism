import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl();
  return [
    { url: siteUrl },
    { url: `${siteUrl}/about` },
    { url: `${siteUrl}/contact` },
    { url: `${siteUrl}/modelbook` },
    { url: `${siteUrl}/modelbook/benchmark` },
    { url: `${siteUrl}/modelbook/squad-of-the-week` },
    { url: `${siteUrl}/modelbook/reports/gw7` },
    { url: `${siteUrl}/modelbook/reports/gw6` },
    { url: `${siteUrl}/modelbook/reports/gw5` },
    { url: `${siteUrl}/modelbook/reports/gw4` },
    { url: `${siteUrl}/modelbook/reports/gw3` },
    { url: `${siteUrl}/how-it-works` },
    { url: `${siteUrl}/fpl-captain-picks` },
    { url: `${siteUrl}/fpl-transfer-planner` },
    { url: `${siteUrl}/fpl-expected-points` },
    { url: `${siteUrl}/fpl-team-risk` },
    { url: `${siteUrl}/pricing` },
    { url: `${siteUrl}/privacy` },
    { url: `${siteUrl}/terms` },
  ];
}
