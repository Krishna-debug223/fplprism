import LandingPage from "@/components/LandingPage";
import { pageMetadata } from "@/lib/metadata";
import { getSiteUrl } from "@/lib/site-url";

export const metadata = pageMetadata({
  title: "FPL Prism — Risk-aware FPL decisions",
  description: "See the expected points, range and risk behind every Fantasy Premier League transfer, captain and squad decision.",
  path: "/",
});

export default function Home() {
  const siteUrl = getSiteUrl();
  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${siteUrl}/#organization`,
        name: "FPL Prism",
        url: `${siteUrl}/`,
        logo: `${siteUrl}/icon-512.png`,
        sameAs: ["https://github.com/Krishna-debug223/fplprism"],
      },
      {
        "@type": "WebSite",
        "@id": `${siteUrl}/#website`,
        name: "FPL Prism",
        alternateName: "FPLPrism",
        url: `${siteUrl}/`,
        publisher: { "@id": `${siteUrl}/#organization` },
      },
      {
        "@type": "WebApplication",
        "@id": `${siteUrl}/#app`,
        name: "FPL Prism",
        url: `${siteUrl}/`,
        description: "Risk-aware Fantasy Premier League decision analytics with expected points, outcome ranges and legal transfer comparisons.",
        applicationCategory: "SportsApplication",
        operatingSystem: "Web",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@id": `${siteUrl}/#organization` },
      },
    ],
  };

  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />
    <LandingPage />
  </>;
}
