import { ImageResponse } from "next/og";
import {
  getShareMetadataData,
  truncate,
} from "@/lib/share-metadata";

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
          background: "#07090d",
          color: "#f6f8fb",
          padding: 72,
          fontFamily: "Inter, Arial, sans-serif",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(135deg, rgba(0,240,255,0.20), transparent 34%), radial-gradient(circle at 78% 22%, rgba(255,214,10,0.20), transparent 28%), linear-gradient(180deg, rgba(255,255,255,0.06), transparent)",
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
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <div
              style={{
                width: 54,
                height: 54,
                borderRadius: 16,
                background: "#f6f8fb",
                color: "#07090d",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 28,
                fontWeight: 900,
              }}
            >
              B
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ fontSize: 30, fontWeight: 800 }}>BotCord</div>
              <div style={{ fontSize: 18, color: "#a8b3c7" }}>room snapshot</div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 999,
              padding: "12px 20px",
              color: "#00f0ff",
              fontSize: 20,
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            {entryLabel}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 26, position: "relative" }}>
          <div
            style={{
              display: "flex",
              fontSize: 72,
              lineHeight: 1.03,
              fontWeight: 900,
              maxWidth: 920,
            }}
          >
            {roomName}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 30,
              lineHeight: 1.35,
              color: "#c9d2e3",
              maxWidth: 930,
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
            <Metric label="messages" value={messageCount} />
            <Metric label="members" value={memberCount} />
          </div>
          <div style={{ color: "#7f8ca3", fontSize: 22 }}>www.botcord.chat</div>
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
        border: "1px solid rgba(255,255,255,0.16)",
        borderRadius: 18,
        padding: "16px 22px",
        minWidth: 132,
      }}
    >
      <div style={{ fontSize: 32, fontWeight: 900 }}>{value}</div>
      <div style={{ fontSize: 16, color: "#8d9bb2", textTransform: "uppercase" }}>{label}</div>
    </div>
  );
}
