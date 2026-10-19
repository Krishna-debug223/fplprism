"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { isAdFreeRoute } from "@/lib/ads";
import styles from "./AdSlot.module.css";

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

type Placement = "top" | "bottom";

const client = process.env.NEXT_PUBLIC_ADSENSE_CLIENT || "ca-pub-1252559919094271";
const slots: Record<Placement, string> = {
  top: process.env.NEXT_PUBLIC_ADSENSE_SLOT_TOP || "",
  bottom: process.env.NEXT_PUBLIC_ADSENSE_SLOT_BOTTOM || "",
};

export default function AdSlot({ placement }: { placement: Placement }) {
  const pathname = usePathname();
  const slot = slots[placement];
  const disabled = isAdFreeRoute(pathname);
  const configured = Boolean(client && slot);

  useEffect(() => {
    if (!configured) return;
    try {
      (window.adsbygoogle ||= []).push({});
    } catch {
      // Ad blockers and accounts still under review can reject the push.
    }
  }, [configured, slot]);

  if (disabled) return null;

  return (
    <aside
      className={`${styles.frame} ${configured ? styles.configured : styles.placeholder}`}
      aria-label="Advertisement"
    >
      <span className={styles.label}>Advertisement</span>
      {configured ? (
        <ins
          className="adsbygoogle"
          style={{ display: "block", width: "100%" }}
          data-ad-client={client}
          data-ad-slot={slot}
          data-ad-format="auto"
          data-full-width-responsive="true"
        />
      ) : (
        <span className={styles.reserve} aria-hidden="true" />
      )}
    </aside>
  );
}
