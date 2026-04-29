"use client";

/**
 * [INPUT]: PolicySettingsClient for agent policy configuration
 * [OUTPUT]: SettingsModal — modal overlay for dashboard settings (对话与回复)
 * [POS]: triggered from AccountMenu "Settings" action; replaces full-page /settings navigation
 * [PROTOCOL]: update header on changes
 */

import PolicySettingsClient from "@/app/(dashboard)/settings/policy/PolicySettingsClient";

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm py-8 px-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl rounded-2xl border border-glass-border bg-deep-black-light shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-glass-border/50 px-6 py-4">
          <span className="text-sm font-semibold text-text-primary">设置</span>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary/60 transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-6">
          <PolicySettingsClient />
        </div>
      </div>
    </div>
  );
}
