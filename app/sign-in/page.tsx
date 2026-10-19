import SignInPanel from "@/components/SignInPanel";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  title: "FPL Prism — Sign in",
  description: "Optional FPL Prism account sign in for saving your Team ID and planning defaults.",
  path: "/sign-in",
  noindex: true,
});

export default function SignInPage() {
  return <SignInPanel />;
}
