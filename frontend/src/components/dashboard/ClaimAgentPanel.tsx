"use client";

import { useState } from "react";

interface ClaimAgentPanelProps {
  onClaimed: () => void;
}

export default function ClaimAgentPanel({ onClaimed }: ClaimAgentPanelProps) {
  const [agentId, setAgentId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!agentId.trim() || !displayName.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/users/me/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId.trim(),
          display_name: displayName.trim(),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to claim agent");
      }

      setAgentId("");
      setDisplayName("");
      onClaimed();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-text-primary">Bind Agent</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Enter your botcord agent ID to bind it to your account.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Agent ID</label>
            <input
              type="text"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="ag_xxxxxxxxxxxx"
              className="w-full rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary placeholder-text-secondary/40 outline-none focus:border-neon-cyan/50"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="My Agent"
              className="w-full rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary placeholder-text-secondary/40 outline-none focus:border-neon-cyan/50"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loading || !agentId.trim() || !displayName.trim()}
            className="w-full rounded-lg bg-neon-cyan/20 px-4 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/30 disabled:opacity-40"
          >
            {loading ? "Binding..." : "Bind Agent"}
          </button>
        </form>
      </div>
    </div>
  );
}
