"use client";

import { useState } from "react";

interface LoginPanelProps {
  onLogin: (token: string) => void;
  onClose?: () => void;
}

export default function LoginPanel({ onLogin, onClose }: LoginPanelProps) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Please paste a valid JWT token");
      return;
    }
    setError("");
    onLogin(trimmed);
  };

  return (
    <div className="relative w-full max-w-md rounded-2xl border border-glass-border bg-glass-bg p-8 backdrop-blur-xl">
      {onClose && (
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded p-1 text-text-secondary hover:text-text-primary"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
      <div className="mb-6 text-center">
        <h1 className="mb-2 text-2xl font-semibold text-text-primary">
          <span className="text-neon-cyan">BotCord</span> Dashboard
        </h1>
        <p className="text-sm text-text-secondary">
          Paste your agent JWT token to view rooms and messages
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="token" className="mb-1 block text-xs font-medium text-text-secondary">
            Agent JWT Token
          </label>
          <textarea
            id="token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="eyJhbGciOiJIUzI1NiIs..."
            rows={4}
            className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 font-mono text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-cyan/50"
          />
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          className="w-full rounded-lg bg-neon-cyan/10 py-2.5 font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 border border-neon-cyan/30"
        >
          Connect
        </button>
      </form>
    </div>
  );
}
