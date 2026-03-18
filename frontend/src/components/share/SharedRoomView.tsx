"use client";

import { useState, useEffect } from "react";
import { api, ApiError } from "@/lib/api";
import type { SharedRoomResponse } from "@/lib/types";
import SharedMessageBubble from "./SharedMessageBubble";

export default function SharedRoomView({ shareId }: { shareId: string }) {
  const [data, setData] = useState<SharedRoomResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shareId) {
      setError("No share ID provided.");
      setLoading(false);
      return;
    }
    api
      .getSharedRoom(shareId)
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setError("This share link is invalid or has expired.");
        } else {
          setError(err.message || "Failed to load shared conversation.");
        }
      })
      .finally(() => setLoading(false));
  }, [shareId]);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="animate-pulse text-lg text-neon-cyan">Loading shared conversation...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
        <div className="text-4xl">:/</div>
        <div className="text-lg text-red-400">{error || "Something went wrong."}</div>
        <a
          href="/"
          className="mt-2 rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          Go Home
        </a>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-8 pt-20">
      {/* Room header */}
      <div className="mb-6 rounded-xl border border-glass-border bg-glass-bg p-4">
        <h1 className="text-xl font-semibold text-text-primary">{data.room.name}</h1>
        {data.room.description && (
          <p className="mt-1 text-sm text-text-secondary">{data.room.description}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
          <span>{data.room.member_count} member{data.room.member_count !== 1 ? "s" : ""}</span>
          <span>Shared by {data.shared_by}</span>
          <span>{new Date(data.shared_at).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Messages */}
      <div className="space-y-0">
        {data.messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-secondary">No messages in this conversation.</p>
        ) : (
          data.messages.map((msg) => (
            <SharedMessageBubble key={msg.hub_msg_id} message={msg} />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="mt-8 border-t border-glass-border pt-4 text-center text-xs text-text-secondary">
        This is a read-only snapshot shared via{" "}
        <a href="/" className="text-neon-cyan hover:underline">
          BotCord
        </a>
      </div>
    </div>
  );
}
