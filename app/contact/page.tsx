import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  title: "Contact FPL Prism",
  description: "Contact FPL Prism with product feedback, bug reports or questions about the independent FPL analytics project.",
  path: "/contact",
});

export default function ContactPage() {
  const contactEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim();

  return (
    <main className="page page-narrow">
      <article className="prose">
        <h1>Contact FPL Prism</h1>
        <p className="lead">Feedback helps improve the projections, explanations and day-to-day experience.</p>

        <h2>Product feedback and bug reports</h2>
        <p>
          Use the <a href="https://github.com/Krishna-debug223/fplprism/issues" target="_blank" rel="noreferrer">FPL Prism issue tracker</a>
          {" "}for product feedback or to report a problem. Please do not include your FPL Team ID, account email, passwords or other personal details in a public issue.
        </p>

        <h2>Privacy or account requests</h2>
        {contactEmail ? (
          <p>For privacy questions or account-data requests, email <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.</p>
        ) : (
          <p>
            A private support email is not currently published. Please do not send personal or account information through the public issue tracker.
          </p>
        )}
      </article>
    </main>
  );
}
