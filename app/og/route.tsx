import { ImageResponse } from "next/og";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const title = (searchParams.get("title") || "Risk-aware FPL decisions").slice(0, 105);
  const description = (searchParams.get("description") || "Expected points, outcome ranges and squad-aware transfer comparisons.").slice(0, 190);

  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#37003c", color: "#fff", padding: 64, fontFamily: "Arial, Helvetica, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div style={{ width: 54, height: 54, borderRadius: 16, background: "#00ff87", display: "flex", alignItems: "center", justifyContent: "center", color: "#37003c", fontSize: 28, fontWeight: 800 }}>P</div>
        <span style={{ fontSize: 30, letterSpacing: 2, fontWeight: 700 }}>FPL PRISM</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 22, maxWidth: 1060 }}>
        <div style={{ fontSize: 60, lineHeight: 1.08, fontWeight: 700, letterSpacing: -1 }}>{title}</div>
        <div style={{ fontSize: 28, lineHeight: 1.35, color: "#e4d8e7" }}>{description}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: "2px solid #6f4a73", paddingTop: 22, color: "#cdbad0", fontSize: 20 }}>
        <span>Independent Fantasy Premier League decision support</span>
        <span>fplprism.com</span>
      </div>
      <div style={{ position: "absolute", right: -110, top: -120, width: 370, height: 370, borderRadius: 185, background: "#00ff87", opacity: 0.08 }} />
    </div>,
    { width: 1200, height: 630 },
  );
}
