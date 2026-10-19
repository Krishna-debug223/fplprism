"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { isAdFreeRoute } from "@/lib/ads";

const client = process.env.NEXT_PUBLIC_ADSENSE_CLIENT || "ca-pub-1252559919094271";

export default function AdSenseLoader() {
  const pathname = usePathname();
  if (isAdFreeRoute(pathname)) return null;

  return (
    <Script
      id="google-adsense"
      async
      strategy="afterInteractive"
      src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}`}
      crossOrigin="anonymous"
    />
  );
}
