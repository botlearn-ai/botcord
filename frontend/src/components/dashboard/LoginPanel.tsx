"use client";

import Card from "@/components/ui/Card";
import Field from "@/components/ui/Field";
import Alert from "@/components/ui/Alert";
import IconButton from "@/components/ui/IconButton";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { useState } from "react";
import { useLanguage } from '@/lib/i18n';
import { loginPanel } from '@/lib/i18n/translations/auth';

interface LoginPanelProps {
  onLogin: (token: string) => void;
  onClose?: () => void;
}

export default function LoginPanel({ onLogin, onClose }: LoginPanelProps) {
  const locale = useLanguage();
  const t = loginPanel[locale];
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError(t.invalidToken);
      return;
    }
    setError("");
    onLogin(trimmed);
  };

  return (
    <Card padding="lg" className="relative w-full max-w-md">
      {onClose && (
        <IconButton label={locale === "zh" ? "关闭" : "Close"} size="sm"
          onClick={onClose}
          className="absolute right-4 top-4"
        >
          <X size={16} strokeWidth={1.75} />
        </IconButton>
      )}
      <div className="mb-6 text-center">
        <h1 className="mb-2 text-2xl font-semibold text-text-primary">
          <span className="text-accent-text">BotCord</span> Chat App
        </h1>
        <p className="text-sm text-text-secondary">
          {t.pasteToken}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label={t.agentJwtToken} htmlFor="token">
          <Textarea
            id="token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="eyJhbGciOiJIUzI1NiIs..."
            rows={4}
            className="w-full"
          />
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}

        <Button variant="primary" size="sm"
          type="submit"
          className="w-full"
        >
          {t.connect}
        </Button>
      </form>
    </Card>
  );
}
