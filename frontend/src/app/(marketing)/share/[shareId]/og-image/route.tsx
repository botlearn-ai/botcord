import { ImageResponse } from "next/og";
import { BRAND_CORD_PATH } from "@/components/ui/BrandMark";
import { CORD_FIELD } from "@/components/ui/CordField";
import {
  getShareMetadataData,
  truncate,
} from "@/lib/share-metadata";

// VI v1.0 dark palette (docs/brand/botcord-vi/VI.md §2.4, §3). next/og cannot
// read CSS variables, so the hex values are spelled out here.
const BG = "#090B0E";
const INK = "#F1F6FA";
const BRAND = "#0BB6C5";
const ACCENT_TEXT = "#50CFDD";
const TEXT_SECONDARY = "#A1A5A9";
const TEXT_TERTIARY = "#777B7F";
const BORDER = "#26292D";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ shareId: string }> },
) {
  const { shareId } = await params;
  const data = await getShareMetadataData(shareId);
  const roomName = data ? truncate(data.roomName, 72) : "BotCord shared room";
  const description = data
    ? truncate(data.roomDescription || `Shared by ${data.sharedBy}`, 132)
    : "Open this BotCord room snapshot and continue in the chat app.";
  const messageCount = data?.messageCount ?? 0;
  const memberCount = data?.memberCount ?? 0;
  const entryLabel = data?.entryType === "paid_room"
    ? "Paid room"
    : data?.entryType === "private_room"
      ? "Private snapshot"
      : "Shared room";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: BG,
          color: INK,
          padding: 72,
          fontFamily: "Geist, Inter, Arial, sans-serif",
          position: "relative",
        }}
      >
        {/* VI §11: cord field on the right, faded out behind the copy. */}
        <svg
          width={1200}
          height={630}
          viewBox="0 0 1200 630"
          style={{ position: "absolute", top: 0, left: 0 }}
        >
          <path
            d={CORD_FIELD.d}
            stroke={INK}
            strokeOpacity={0.22}
            strokeWidth={1.6}
            strokeLinecap="round"
            fill="none"
          />
          {CORD_FIELD.nodes.map((node) => (
            <circle
              key={`${node.x}-${node.y}`}
              cx={node.x}
              cy={node.y}
              r={node.accent ? 4 : 3.2}
              fill={node.accent ? BRAND : INK}
              fillOpacity={node.accent ? 1 : 0.4}
            />
          ))}
        </svg>
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 1200,
            height: 630,
            background: `linear-gradient(90deg, ${BG} 0%, ${BG} 45%, rgba(9,11,14,0.85) 62%, rgba(9,11,14,0) 100%)`,
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            position: "relative",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <svg width={56} height={56} viewBox="0 0 48 48">
              <path d={BRAND_CORD_PATH} stroke={INK} strokeWidth={5.5} strokeLinecap="round" fill="none" />
              <circle cx={8.5} cy={34} r={7} fill={INK} />
              <circle cx={39.5} cy={14} r={7} fill={BRAND} />
            </svg>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.03em" }}>BotCord</div>
              <div style={{ fontSize: 18, color: TEXT_SECONDARY }}>Room snapshot</div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              border: `1px solid ${BORDER}`,
              background: BG,
              borderRadius: 999,
              padding: "10px 20px",
              color: ACCENT_TEXT,
              fontSize: 20,
              fontWeight: 500,
            }}
          >
            {entryLabel}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24, position: "relative" }}>
          <div
            style={{
              display: "flex",
              fontSize: 64,
              lineHeight: 1.05,
              fontWeight: 600,
              letterSpacing: "-0.04em",
              maxWidth: 860,
            }}
          >
            {roomName}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 28,
              lineHeight: 1.4,
              color: TEXT_SECONDARY,
              maxWidth: 820,
            }}
          >
            {description}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            position: "relative",
          }}
        >
          <div style={{ display: "flex", gap: 16 }}>
            <Metric label="Messages" value={messageCount} />
            <Metric label="Members" value={memberCount} />
          </div>
          <div style={{ color: TEXT_TERTIARY, fontSize: 22 }}>www.botcord.chat</div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        border: `1px solid ${BORDER}`,
        background: BG,
        borderRadius: 16,
        padding: "16px 22px",
        minWidth: 132,
      }}
    >
      <div style={{ fontSize: 32, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 16, color: TEXT_TERTIARY }}>{label}</div>
    </div>
  );
}
