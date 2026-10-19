import AnalyticsPrivacyControls from "@/components/AnalyticsPrivacyControls";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  title: "FPL Prism — Privacy Policy",
  description: "How FPL Prism handles manager data, optional accounts, analytics and model inputs.",
  path: "/privacy",
});

export default function PrivacyPage() {
  const contactEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL;
  return (
    <main className="page page-narrow">
      <article className="legal prose">
        <h1>Privacy Policy</h1>
        <p className="effective">Effective 19 October 2026</p>
        <p>FPL Prism is built to work without an account. An optional account can be used to save a small set of planning preferences across sessions and devices.</p>

        <h2>Information you provide</h2>
        <p>When you enter a Fantasy Premier League Team ID, FPL Prism sends that public numeric ID from our server to the public Fantasy Premier League data service so the app can display the squad and manager information associated with it. We do not ask for or store your official FPL password.</p>
        <p>Guest-mode preferences may be stored in your browser. If you choose to create an FPL Prism account, your login email is handled by our authentication provider and the account can store the preferences you choose to save, currently including your public FPL Team ID, default free-transfer count and planner strategy mode.</p>

        <h2>Account authentication</h2>
        <p>Optional account authentication is provided through Supabase. Passwords are submitted directly through the authentication flow and are not stored in FPL Prism application code or exposed to our analytics. Email confirmation and password-recovery messages may be sent by the authentication provider when those features are enabled.</p>

        <h2>Analytics and performance data</h2>
        <p>We use Vercel Web Analytics for aggregate traffic measurement and Vercel Speed Insights for performance metrics. This can include page views, referrer, approximate location, device/browser information and real-user performance measurements.</p>
        <p>We also record a small allow-listed set of product events, such as a successful team import, selecting a model recommendation or running a simulation, through Vercel Web Analytics. Event properties are deliberately limited to coarse product context such as horizon, gameweek, recommendation rank or whether a transfer hit was applied. We do not intentionally add FPL Team IDs, manager/team names, player names, email addresses or free-form text to product analytics.</p>
        <AnalyticsPrivacyControls />

        <h2>Advertising</h2>
        <p>FPL Prism may display responsive advertisements through Google AdSense. If ads are served, Google and its partners may use cookies or similar device information to measure, limit or personalise advertising under their own policies. Ads are disabled on dashboard, planner, account and authentication screens. You can manage Google&apos;s advertising preferences through <a href="https://adssettings.google.com" rel="noreferrer">Google Ads Settings</a>; where applicable, your browser or regional consent choices also control personalised advertising.</p>

        <h2>AI and automated recommendations</h2>
        <p>Projections and recommendations in FPL Prism are produced by an explainable statistical recommendation engine, not a general-purpose chatbot. It uses football/FPL statistics, fixture data, squad rules, historical priors and probabilistic simulations. We do not currently send your FPL squad to a third-party generative-AI provider.</p>

        <h2>Third-party services and data sources</h2>
        <p>FPL Prism currently relies on Vercel for hosting, analytics and performance monitoring; Supabase for optional account authentication and saved account preferences when enabled; public Fantasy Premier League endpoints for current game data; the Vaastav Fantasy Premier League historical dataset for completed-season player priors; and optional team-strength research feeds. These services have their own terms and privacy practices.</p>

        <h2>Payments and subscriptions</h2>
        <p>The pricing page currently describes launch and roadmap tiers only. No paid checkout, automatic renewal or stored payment method is active. If paid subscriptions launch later, this policy and the Terms will be updated before payment details are collected.</p>

        <h2>Data retention and account control</h2>
        <p>Guest preferences remain on your device until you clear site data. Signed-in preferences remain attached to the account until they are changed or the account is removed. FPL Prism is intentionally keeping the saved account profile small during launch.</p>

        <h2>Children and sensitive data</h2>
        <p>The service is not designed to collect sensitive personal information. Do not submit payment data, health information or other sensitive information into the Team ID field, account profile or other product inputs.</p>

        <h2>Contact</h2>
        {contactEmail
          ? <p>For privacy questions or account-data requests, email <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.</p>
          : <p>For contact options, see the <a href="/contact">FPL Prism contact page</a>. Please do not send personal or account information through public product-feedback channels.</p>}

        <h2>Changes</h2>
        <p>We may update this policy as the product changes. The effective date at the top of this page will be updated when material changes are made.</p>

        <div className="notice notice-neutral" style={{ marginTop: 28 }}>FPL Prism is an independent project and is not affiliated with, endorsed by or sponsored by the Premier League.</div>
      </article>
    </main>
  );
}
