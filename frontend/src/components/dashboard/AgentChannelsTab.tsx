"use client";

/**
 * [INPUT]: agentId; uses useAgentGatewayStore for data + actions
 * [OUTPUT]: AgentChannelsTab — content of the "接入 / Channels" tab inside
 *          AgentSettingsDrawer. Provider-specific add forms are split into
 *          TelegramAddForm and WechatAddForm so future providers (LINE, Discord)
 *          can drop into the same surface without tangling.
 * [POS]: dashboard third-party gateway management UI
 * [PROTOCOL]: update header on changes
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Info,
  Loader2,
  MessageCircle,
  Plus,
  Search,
  Send,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  useAgentGatewayStore,
  type AgentGatewayConnection,
  type GatewayProvider,
  type GatewayStatus,
  type WechatLoginStatus,
} from "@/store/useAgentGatewayStore";

interface Props {
  agentId: string;
}

type AddMode = null | "telegram" | "wechat";
type TelegramDiscoveryChat = { id: string; type: string | null; label: string | null };
type TelegramDiscoverySender = { id: string; label: string | null };

const STATUS_LABELS: Record<GatewayStatus, string> = {
  active: "运行中",
  disabled: "已停用",
  error: "错误",
  pending: "等待中",
};

const STATUS_STYLES: Record<GatewayStatus, string> = {
  active: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  disabled: "border-glass-border bg-glass-bg/40 text-text-secondary",
  error: "border-red-400/40 bg-red-400/10 text-red-300",
  pending: "border-amber-400/40 bg-amber-400/10 text-amber-300",
};

function ProviderIcon({ provider }: { provider: GatewayProvider }) {
  if (provider === "telegram") {
    return <Send className="h-3.5 w-3.5" />;
  }
  return <MessageCircle className="h-3.5 w-3.5" />;
}

function providerName(provider: GatewayProvider): string {
  return provider === "telegram" ? "Telegram" : "微信";
}

function StepSection({
  step,
  title,
  description,
  complete,
  children,
}: {
  step: number;
  title: string;
  description?: string;
  complete?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-glass-border bg-deep-black/30 p-3">
      <div className="mb-3 flex items-start gap-2.5">
        <span
          className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
            complete
              ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
              : "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan"
          }`}
        >
          {complete ? <CheckCircle2 className="h-3.5 w-3.5" /> : step}
        </span>
        <div className="min-w-0">
          <h4 className="text-xs font-semibold text-text-primary">{title}</h4>
          {description ? (
            <p className="mt-0.5 text-[10px] leading-relaxed text-text-tertiary">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}

// Stable empty list reference — must live outside the component so selectors
// don't return a fresh `[]` each render and trigger zustand's
// useSyncExternalStore infinite-render guard (React #185).
const EMPTY_LIST: AgentGatewayConnection[] = [];

export default function AgentChannelsTab({ agentId }: Props) {
  const list = useAgentGatewayStore((s) => s.byAgent[agentId]) ?? EMPTY_LIST;
  const loading = useAgentGatewayStore((s) => Boolean(s.loading[agentId]));
  const daemonOffline = useAgentGatewayStore((s) =>
    Boolean(s.daemonOffline[agentId]),
  );
  const lastError = useAgentGatewayStore((s) => s.lastError[agentId]) ?? null;
  const load = useAgentGatewayStore((s) => s.load);
  const enable = useAgentGatewayStore((s) => s.enable);
  const disable = useAgentGatewayStore((s) => s.disable);
  const remove = useAgentGatewayStore((s) => s.remove);

  const [addMode, setAddMode] = useState<AddMode>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [rowOk, setRowOk] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<AgentGatewayConnection | null>(
    null,
  );

  useEffect(() => {
    void load(agentId).catch(() => {});
  }, [agentId, load]);

  const setErr = useCallback((id: string, msg: string | null) => {
    setRowError((prev) => {
      const next = { ...prev };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });
  }, []);

  const setOk = useCallback((id: string, msg: string | null) => {
    setRowOk((prev) => {
      const next = { ...prev };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });
  }, []);

  async function handleToggle(g: AgentGatewayConnection) {
    if (daemonOffline) return;
    setBusyId(g.id);
    setErr(g.id, null);
    setOk(g.id, null);
    try {
      if (g.enabled) await disable(agentId, g.id);
      else await enable(agentId, g.id);
    } catch (err) {
      setErr(g.id, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return;
    const g = pendingDelete;
    setBusyId(g.id);
    setErr(g.id, null);
    try {
      await remove(agentId, g.id);
      setPendingDelete(null);
    } catch (err) {
      setErr(g.id, err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      {daemonOffline && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2.5 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">Daemon 离线</div>
            <div className="text-amber-200/80">
              本地 daemon 当前不在线，已连接列表仍可读，但无法创建、扫码、编辑、启用、停用或删除接入。
            </div>
          </div>
        </div>
      )}

      {/* BotCord built-in entry — read-only. */}
      <section className="rounded-2xl border border-glass-border bg-glass-bg/40 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">BotCord 内置入口</h3>
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${STATUS_STYLES.active}`}
          >
            <CheckCircle2 className="h-3 w-3" />
            始终启用
          </span>
        </div>
        <div className="font-mono text-[11px] text-text-secondary/80">{agentId}</div>
        <p className="mt-2 text-xs text-text-secondary">
          这是 BotCord agent 的基础数据面入口，无法删除或停用。
        </p>
      </section>

      {/* Connected gateways. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">第三方接入</h3>
          {!addMode && (
            <button
              type="button"
              onClick={() => setAddMode("telegram")}
              disabled={daemonOffline}
              className="inline-flex items-center gap-1 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-2.5 py-1 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-3 w-3" />
              添加接入
            </button>
          )}
        </div>

        {loading && list.length === 0 ? (
          <div className="rounded-xl border border-glass-border bg-glass-bg/40 p-4 text-xs text-text-secondary">
            加载中…
          </div>
        ) : list.length === 0 ? (
          <div className="rounded-xl border border-dashed border-glass-border/60 bg-transparent p-4 text-center text-xs text-text-tertiary">
            尚未连接任何第三方入口
          </div>
        ) : (
          <ul className="space-y-2">
            {list.map((g) => {
              const cfg = (g.config ?? {}) as {
                tokenPreview?: string;
                allowedSenderIds?: string[];
                allowedChatIds?: string[];
              };
              const status: GatewayStatus = g.last_error
                ? "error"
                : !g.enabled
                  ? "disabled"
                  : g.status;
              return (
                <li
                  key={g.id}
                  className="rounded-xl border border-glass-border bg-glass-bg/40 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-glass-bg text-text-secondary">
                          <ProviderIcon provider={g.provider} />
                        </span>
                        <span className="truncate text-sm font-medium text-text-primary">
                          {g.label || providerName(g.provider)}
                        </span>
                        <span
                          className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] ${STATUS_STYLES[status]}`}
                        >
                          {STATUS_LABELS[status]}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-text-secondary/80">
                        {providerName(g.provider)}
                        {cfg.tokenPreview ? ` · token ${cfg.tokenPreview}` : ""}
                      </div>
                      {g.last_error && (
                        <div className="mt-1 truncate text-[11px] text-red-300">
                          {g.last_error}
                        </div>
                      )}
                      {rowError[g.id] && (
                        <div className="mt-1 text-[11px] text-red-300">
                          {rowError[g.id]}
                        </div>
                      )}
                      {rowOk[g.id] && (
                        <div className="mt-1 text-[11px] text-emerald-300">
                          {rowOk[g.id]}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleToggle(g)}
                        disabled={daemonOffline || busyId === g.id}
                        className="rounded-md border border-glass-border bg-glass-bg/60 px-2 py-1 text-[11px] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                      >
                        {g.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId((cur) => (cur === g.id ? null : g.id));
                          setErr(g.id, null);
                          setOk(g.id, null);
                        }}
                        disabled={daemonOffline || busyId === g.id}
                        className="inline-flex items-center gap-1 rounded-md border border-glass-border bg-glass-bg/60 px-2 py-1 text-[11px] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                      >
                        <SquarePen className="h-3 w-3" />
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(g)}
                        disabled={daemonOffline || busyId === g.id}
                        className="rounded-md border border-red-400/40 bg-red-500/10 p-1 text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                        title="删除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {editingId === g.id && (
                    <GatewayEditForm
                      agentId={agentId}
                      gateway={g}
                      daemonOffline={daemonOffline}
                      onCancel={() => setEditingId(null)}
                      onSaved={() => {
                        setEditingId(null);
                        setOk(g.id, "已保存");
                      }}
                      onError={(msg) => setErr(g.id, msg)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {!addMode && lastError && !daemonOffline && (
          <div className="text-[11px] text-red-300">{lastError}</div>
        )}
      </section>

      {/* Add gateway form. */}
      {addMode && (
        <section className="rounded-2xl border border-glass-border bg-glass-bg/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary">添加接入</h3>
            <button
              type="button"
              onClick={() => setAddMode(null)}
              className="rounded-full p-1 text-text-secondary hover:bg-glass-bg hover:text-text-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* provider segmented control */}
          <div className="mb-4 inline-flex rounded-lg border border-glass-border bg-deep-black/40 p-0.5">
            {(["wechat", "telegram"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setAddMode(p)}
                className={`rounded-md px-3 py-1 text-xs transition-colors ${
                  addMode === p
                    ? "bg-neon-cyan/20 text-neon-cyan"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {p === "wechat" ? "微信" : "Telegram"}
              </button>
            ))}
          </div>
          {addMode === "telegram" ? (
            <TelegramAddForm
              agentId={agentId}
              daemonOffline={daemonOffline}
              onCancel={() => setAddMode(null)}
              onCreated={() => setAddMode(null)}
            />
          ) : (
            <WechatAddForm
              agentId={agentId}
              daemonOffline={daemonOffline}
              onCancel={() => setAddMode(null)}
              onCreated={() => setAddMode(null)}
            />
          )}
        </section>
      )}

      {pendingDelete && (
        <DeleteConfirmDialog
          gateway={pendingDelete}
          busy={busyId === pendingDelete.id}
          onCancel={() => setPendingDelete(null)}
          onConfirm={handleConfirmDelete}
        />
      )}
    </div>
  );
}

function csvToList(raw: string): string[] {
  return raw
    .split(/[\s,，;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function TelegramAddForm({
  agentId,
  daemonOffline,
  onCancel,
  onCreated,
}: {
  agentId: string;
  daemonOffline: boolean;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const create = useAgentGatewayStore((s) => s.create);
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [chatIds, setChatIds] = useState("");
  const [senderIds, setSenderIds] = useState("");
  const [enableNow, setEnableNow] = useState(true);
  const [discoveringChats, setDiscoveringChats] = useState(false);
  const [discoveredChats, setDiscoveredChats] = useState<TelegramDiscoveryChat[]>([]);
  const [discoveredSenders, setDiscoveredSenders] = useState<TelegramDiscoverySender[]>([]);
  const [discoverHint, setDiscoverHint] = useState<string | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [copiedChatId, setCopiedChatId] = useState<string | null>(null);
  const [copiedSenderId, setCopiedSenderId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenGuideOpen, setTokenGuideOpen] = useState(false);

  const allowedChatIds = csvToList(chatIds);
  const allowedSenderIds = csvToList(senderIds);
  const tokenReady = !!token.trim();
  const chatReady = allowedChatIds.length > 0;
  const senderReady = allowedSenderIds.length > 0;
  const whitelistIncomplete = !chatReady || !senderReady;
  const canSave = tokenReady && !whitelistIncomplete && !daemonOffline && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await create(agentId, {
        provider: "telegram",
        label: label.trim() || null,
        enabled: enableNow,
        secret: { botToken: token.trim() },
        config: {
          label: label.trim() || undefined,
          allowedChatIds,
          allowedSenderIds,
        },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDiscoverChats() {
    const botToken = token.trim();
    if (!botToken || discoveringChats) return;
    setDiscoveringChats(true);
    setDiscoverHint("等待 Telegram 最近消息...");
    setDiscoverError(null);
    setDiscoveredChats([]);
    setDiscoveredSenders([]);
    try {
      let chats: TelegramDiscoveryChat[] = [];
      let senders: TelegramDiscoverySender[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        setDiscoverHint(
          attempt === 1
            ? "等待 Telegram 最近消息..."
            : `还没发现消息，继续等待 ${attempt}/3...`,
        );
        const res = await fetch("/api/telegram/chat-ids", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ botToken, timeoutSeconds: 8 }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          chats?: TelegramDiscoveryChat[];
          senders?: TelegramDiscoverySender[];
          message?: string;
          error?: string;
        };
        if (!res.ok) {
          throw new Error(json.message || json.error || `HTTP ${res.status}`);
        }
        chats = Array.isArray(json.chats) ? json.chats : [];
        senders = Array.isArray(json.senders) ? json.senders : [];
        if (chats.length > 0 || senders.length > 0) break;
      }
      setDiscoveredChats(chats);
      setDiscoveredSenders(senders);
      if (chats.length === 1) {
        setChatIds(chats[0].id);
      }
      if (senders.length === 1) {
        setSenderIds(senders[0].id);
      }
      if (chats.length === 1 && senders.length === 1) {
        setDiscoverHint("已自动填入发现的 chat id 和发送者 user id。");
      } else if (chats.length === 1) {
        setDiscoverHint("已自动填入发现的 chat id。");
      } else if (senders.length === 1) {
        setDiscoverHint("已自动填入发现的发送者 user id。");
      } else if (chats.length === 0) {
        setDiscoverHint(null);
        setDiscoverError("还没有发现会话。请先在目标私聊或群聊里给 bot 发一条消息，然后再读取。");
      } else {
        setDiscoverHint("发现多个会话，请选择要允许的 chat id。");
      }
    } catch (err) {
      setDiscoverHint(null);
      setDiscoverError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscoveringChats(false);
    }
  }

  function appendChatId(id: string) {
    const existing = new Set(csvToList(chatIds));
    existing.add(id);
    setChatIds(Array.from(existing).join("\n"));
  }

  function appendSenderId(id: string) {
    const existing = new Set(csvToList(senderIds));
    existing.add(id);
    setSenderIds(Array.from(existing).join("\n"));
  }

  async function copyChatId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedChatId(id);
      window.setTimeout(() => setCopiedChatId(null), 1600);
    } catch {
      setDiscoverError("复制失败，请手动复制 chat id。");
    }
  }

  async function copySenderId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedSenderId(id);
      window.setTimeout(() => setCopiedSenderId(null), 1600);
    } catch {
      setDiscoverError("复制失败，请手动复制发送者 user id。");
    }
  }

  return (
    <div className="space-y-3">
      <StepSection
        step={1}
        title="填写 Bot token"
        description="先从 BotFather 创建 bot 并复制 token；没有 token 就不能读取最近消息或保存接入。"
        complete={tokenReady}
      >
        <Field label="Bot token">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={saving}
              placeholder="123456:ABC-..."
              className="w-full rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 font-mono text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setTokenGuideOpen(true)}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-amber-300/45 bg-amber-300/12 px-3 py-2 text-[11px] font-medium text-amber-100 shadow-[0_0_18px_rgba(251,191,36,0.14)] hover:bg-amber-300/20"
            >
              <Info className="h-3.5 w-3.5" />
              如何获取 token
            </button>
          </div>
          <p className="mt-1 text-[10px] text-text-tertiary">
            Token 仅在创建/替换时填写，保存后只显示 token preview。
          </p>
        </Field>
      </StepSection>
      {tokenReady && (
        <>
          <StepSection
            step={2}
            title="让目标会话发消息，读取 chat id"
            description="chat id 限定 BotCord 只处理指定私聊、群或频道里的消息。"
            complete={chatReady}
          >
          <Field label="允许的 chat id（逗号或换行分隔）">
            <textarea
              value={chatIds}
              onChange={(e) => setChatIds(e.target.value)}
              disabled={saving}
              rows={2}
              placeholder="-1001234567890, 987654321"
              className="w-full resize-none rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 font-mono text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleDiscoverChats}
                disabled={!token.trim() || saving || discoveringChats}
                className="inline-flex items-center gap-1 rounded-md border border-glass-border bg-glass-bg/50 px-2.5 py-1 text-[11px] text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
              >
                {discoveringChats ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Search className="h-3 w-3" />
                )}
                读取最近 chat id
              </button>
              <span className="text-[10px] text-text-tertiary">
                先在目标私聊或群聊里给 bot 发一条消息。
              </span>
            </div>
            {discoveredChats.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {discoveredChats.map((chat) => (
                  <div
                    key={chat.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-glass-border bg-glass-bg/45 px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="max-w-[180px] truncate text-[11px] font-medium text-text-primary">
                          {chat.label || "未命名会话"}
                        </span>
                        {chat.type ? (
                          <span className="rounded border border-glass-border px-1.5 py-0.5 text-[9px] uppercase text-text-tertiary">
                            {chat.type}
                          </span>
                        ) : null}
                      </div>
                      <code className="mt-1 block break-all font-mono text-[10px] text-neon-cyan">
                        {chat.id}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setChatIds(chat.id)}
                        disabled={saving}
                        className="rounded border border-neon-cyan/35 bg-neon-cyan/10 px-2 py-1 text-[10px] text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
                      >
                        填入
                      </button>
                      <button
                        type="button"
                        onClick={() => appendChatId(chat.id)}
                        disabled={saving}
                        className="rounded border border-glass-border px-2 py-1 text-[10px] text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
                      >
                        追加
                      </button>
                      <button
                        type="button"
                        onClick={() => copyChatId(chat.id)}
                        disabled={saving}
                        title={copiedChatId === chat.id ? "已复制" : "复制 chat id"}
                        className="inline-flex h-6 w-6 items-center justify-center rounded border border-glass-border text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
                      >
                        {copiedChatId === chat.id ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {discoverHint && (
              <p className="mt-1 text-[10px] leading-relaxed text-text-tertiary">
                {discoverHint}
              </p>
            )}
            {discoverError && (
              <p className="mt-1 text-[10px] leading-relaxed text-amber-200">
                {discoverError}
              </p>
            )}
          </Field>
          </StepSection>
          {chatReady && (
            <StepSection
              step={3}
              title="确认允许的发送者 user id"
              description="同一个群里可能有多人发言；必须限制具体 Telegram 用户。第 2 步读取最近消息时会尽量自动带出发送者。"
              complete={senderReady}
            >
          <Field label="允许的发送者 user id（逗号或换行分隔）">
            <textarea
              value={senderIds}
              onChange={(e) => setSenderIds(e.target.value)}
              disabled={saving}
              rows={2}
              placeholder="123456789"
              className="w-full resize-none rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 font-mono text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
            />
            <p className="mt-1 text-[10px] text-text-tertiary">
              必填；Telegram 需要同时限制 chat id 和发送者 user id。
            </p>
            {discoveredSenders.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {discoveredSenders.map((sender) => (
                  <div
                    key={sender.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-glass-border bg-glass-bg/45 px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block max-w-[180px] truncate text-[11px] font-medium text-text-primary">
                        {sender.label || "未命名用户"}
                      </span>
                      <code className="mt-1 block break-all font-mono text-[10px] text-neon-cyan">
                        {sender.id}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setSenderIds(sender.id)}
                        disabled={saving}
                        className="rounded border border-neon-cyan/35 bg-neon-cyan/10 px-2 py-1 text-[10px] text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
                      >
                        填入
                      </button>
                      <button
                        type="button"
                        onClick={() => appendSenderId(sender.id)}
                        disabled={saving}
                        className="rounded border border-glass-border px-2 py-1 text-[10px] text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
                      >
                        追加
                      </button>
                      <button
                        type="button"
                        onClick={() => copySenderId(sender.id)}
                        disabled={saving}
                        title={copiedSenderId === sender.id ? "已复制" : "复制 user id"}
                        className="inline-flex h-6 w-6 items-center justify-center rounded border border-glass-border text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
                      >
                        {copiedSenderId === sender.id ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Field>
            </StepSection>
          )}
          {senderReady && (
            <StepSection
              step={4}
              title="命名并保存接入"
              description="保存后 token 只留在 daemon 侧，前端只展示 token preview。"
            >
              <Field label="接入名称（可选）">
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  disabled={saving}
                  placeholder="例如：客服 Bot"
                  className="w-full rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
                />
              </Field>
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-text-primary">
                <input
                  type="checkbox"
                  checked={enableNow}
                  onChange={(e) => setEnableNow(e.target.checked)}
                  disabled={saving}
                  className="accent-neon-cyan"
                />
                立即启用
              </label>
            </StepSection>
          )}
          {chatReady && whitelistIncomplete && (
            <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
              必须同时填写允许的 chat id 和发送者 user id，才能保存 Telegram 接入。
            </p>
          )}
          {error && (
            <p className="rounded-lg border border-red-400/30 bg-red-400/10 p-2 text-[11px] text-red-300">
              {error}
            </p>
          )}
        </>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-glass-border bg-glass-bg/60 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!tokenReady || !canSave}
          className={`inline-flex items-center gap-1 rounded-md border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50 ${
            senderReady ? "" : "hidden"
          }`}
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          保存
        </button>
      </div>
      {tokenGuideOpen && (
        <TelegramTokenGuideDialog onClose={() => setTokenGuideOpen(false)} />
      )}
    </div>
  );
}

function TelegramTokenGuideDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-glass-border bg-deep-black p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-text-primary">
              从 BotFather 获取 Bot token
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              Token 来自 Telegram 官方 BotFather，创建后复制到这里即可继续配置接入。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-glass-border text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ol className="space-y-3 text-xs text-text-secondary">
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-neon-cyan/35 bg-neon-cyan/10 text-[10px] font-semibold text-neon-cyan">
              1
            </span>
            <span>打开 Telegram，搜索并进入官方账号 @BotFather。</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-neon-cyan/35 bg-neon-cyan/10 text-[10px] font-semibold text-neon-cyan">
              2
            </span>
            <span>发送 /newbot，按提示填写 bot 显示名称和以 bot 结尾的用户名。</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-neon-cyan/35 bg-neon-cyan/10 text-[10px] font-semibold text-neon-cyan">
              3
            </span>
            <span>BotFather 会返回一串 HTTP API token，格式通常类似 123456:ABC-...。</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-neon-cyan/35 bg-neon-cyan/10 text-[10px] font-semibold text-neon-cyan">
              4
            </span>
            <span>复制 token，粘贴到 Bot token 输入框；不要把 token 发到群聊或提交到代码仓库。</span>
          </li>
        </ol>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan hover:bg-neon-cyan/20"
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}

function WechatAddForm({
  agentId,
  daemonOffline,
  onCancel,
  onCreated,
}: {
  agentId: string;
  daemonOffline: boolean;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const startWechatLogin = useAgentGatewayStore((s) => s.startWechatLogin);
  const pollWechatLogin = useAgentGatewayStore((s) => s.pollWechatLogin);
  const discoverWechatSenders = useAgentGatewayStore((s) => s.discoverWechatSenders);
  const create = useAgentGatewayStore((s) => s.create);

  const [phase, setPhase] = useState<"idle" | "scanning" | "ready">("idle");
  const [loginId, setLoginId] = useState<string | null>(null);
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [qrcodeUrl, setQrcodeUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<WechatLoginStatus>("pending");
  const [tokenPreview, setTokenPreview] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // form fields shown after confirmed
  const [label, setLabel] = useState("");
  const [senderIds, setSenderIds] = useState("");
  const [enableNow, setEnableNow] = useState(true);
  const [copied, setCopied] = useState(false);
  const [discoveringSenders, setDiscoveringSenders] = useState(false);
  const [discoveredSenders, setDiscoveredSenders] = useState<
    { id: string; label?: string | null }[]
  >([]);
  const [senderDiscoverHint, setSenderDiscoverHint] = useState<string | null>(null);
  const [senderDiscoverError, setSenderDiscoverError] = useState<string | null>(null);
  const [copiedSenderId, setCopiedSenderId] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  async function handleStart() {
    setBusy(true);
    setError(null);
    try {
      const r = await startWechatLogin(agentId, {});
      setLoginId(r.loginId);
      setQrcode(r.qrcode);
      setQrcodeUrl(r.qrcodeUrl ?? null);
      setStatus("pending");
      setPhase("scanning");
      // start polling
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = setInterval(() => {
        void doPoll(r.loginId);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doPoll(id: string) {
    try {
      const r = await pollWechatLogin(agentId, id);
      setStatus(r.status);
      if (r.tokenPreview) setTokenPreview(r.tokenPreview);
      if (r.baseUrl) setBaseUrl(r.baseUrl);
      if (r.status === "confirmed") {
        if (pollTimer.current) {
          clearInterval(pollTimer.current);
          pollTimer.current = null;
        }
        setPhase("ready");
      } else if (r.status === "expired" || r.status === "failed") {
        if (pollTimer.current) {
          clearInterval(pollTimer.current);
          pollTimer.current = null;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }
  }

  const allowedSenderIds = csvToList(senderIds);
  const whitelistEmpty = allowedSenderIds.length === 0;
  const loginReady = phase === "ready" && !!loginId;
  const senderReady = allowedSenderIds.length > 0;
  const canSave = phase === "ready" && !!loginId && !whitelistEmpty && !daemonOffline && !busy;

  async function handleSave() {
    if (!canSave || !loginId) return;
    setBusy(true);
    setError(null);
    try {
      await create(agentId, {
        provider: "wechat",
        label: label.trim() || null,
        enabled: enableNow,
        loginId,
        config: {
          label: label.trim() || undefined,
          allowedSenderIds,
          baseUrl: baseUrl ?? undefined,
        },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscoverSenders() {
    if (!loginId || discoveringSenders) return;
    setDiscoveringSenders(true);
    setSenderDiscoverHint("等待最近微信消息...");
    setSenderDiscoverError(null);
    setDiscoveredSenders([]);
    try {
      let senders: { id: string; label?: string | null }[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        setSenderDiscoverHint(
          attempt === 1
            ? "等待最近微信消息..."
            : `还没发现消息，继续等待 ${attempt}/3...`,
        );
        const result = await discoverWechatSenders(agentId, loginId, {
          timeoutSeconds: 8,
        });
        senders = result.senders;
        if (senders.length > 0) break;
      }
      setDiscoveredSenders(senders);
      if (senders.length === 1) {
        setSenderIds(senders[0].id);
        setSenderDiscoverHint("已自动填入发现的微信用户 ID。");
      } else if (senders.length === 0) {
        setSenderDiscoverHint(null);
        setSenderDiscoverError("还没有发现用户。请先用要授权的微信账号发一条消息，再读取。");
      } else {
        setSenderDiscoverHint("发现多个用户，请选择要允许的微信用户 ID。");
      }
    } catch (err) {
      setSenderDiscoverHint(null);
      setSenderDiscoverError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscoveringSenders(false);
    }
  }

  function appendSenderId(id: string) {
    const existing = new Set(csvToList(senderIds));
    existing.add(id);
    setSenderIds(Array.from(existing).join("\n"));
  }

  async function copySenderId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedSenderId(id);
      window.setTimeout(() => setCopiedSenderId(null), 1600);
    } catch {
      setSenderDiscoverError("复制失败，请手动复制微信用户 ID。");
    }
  }

  const statusText: Record<WechatLoginStatus, string> = {
    pending: "等待扫码",
    scanned: "等待手机确认",
    confirmed: "已登录",
    expired: "已过期",
    failed: "登录失败",
  };

  return (
    <div className="space-y-3">
      <StepSection
        step={1}
        title="扫码授权微信登录"
        description="先让 daemon 拿到临时登录态；未授权前不能读取微信用户 ID，也不能保存接入。"
        complete={loginReady}
      >
        {phase === "idle" && (
          <button
            type="button"
            onClick={handleStart}
            disabled={daemonOffline || busy}
            className="inline-flex items-center gap-2 rounded-md border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-xs font-medium text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            扫码登录
          </button>
        )}

        {phase === "scanning" && (
          <div className="space-y-2 rounded-lg border border-glass-border bg-deep-black/40 p-3">
            <div className="text-xs text-text-secondary">{statusText[status]}</div>
            {qrcodeUrl ? (
              <div className="inline-flex h-44 w-44 items-center justify-center rounded-md border border-glass-border bg-white p-2">
                <QRCodeSVG
                  value={qrcodeUrl}
                  size={160}
                  marginSize={1}
                  level="M"
                  title="WeChat 二维码"
                />
              </div>
            ) : qrcode ? (
              <div className="space-y-1.5">
                <div className="break-all rounded-md border border-glass-border bg-glass-bg/40 p-2 font-mono text-[10px] text-text-secondary">
                  {qrcode}
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(qrcode);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    } catch {
                      /* noop */
                    }
                  }}
                  className="rounded-md border border-glass-border bg-glass-bg/60 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
                >
                  {copied ? "已复制" : "复制二维码内容"}
                </button>
              </div>
            ) : null}
            {(status === "expired" || status === "failed") && (
              <button
                type="button"
                onClick={handleStart}
                disabled={busy}
                className="rounded-md border border-glass-border bg-glass-bg/60 px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-50"
              >
                重新获取二维码
              </button>
            )}
          </div>
        )}

        {phase === "ready" && (
          <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-2 text-[11px] text-emerald-200">
            已授权
            {tokenPreview ? (
              <span className="ml-1 font-mono">· token {tokenPreview}</span>
            ) : null}
          </div>
        )}
      </StepSection>

      {loginReady && (
        <StepSection
          step={2}
          title="让授权用户发消息，读取微信用户 ID"
          description="保存时必须限制 allowedSenderIds；先用要授权的微信账号发一条消息，再读取最近用户。"
          complete={senderReady}
        >
          <Field label="允许的微信用户 ID（逗号或换行分隔）">
            <textarea
              value={senderIds}
              onChange={(e) => setSenderIds(e.target.value)}
              disabled={busy}
              rows={2}
              placeholder="xxx@im.wechat"
              className="w-full resize-none rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 font-mono text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleDiscoverSenders}
                disabled={!loginId || busy || discoveringSenders}
                className="inline-flex items-center gap-1 rounded-md border border-glass-border bg-glass-bg/50 px-2.5 py-1 text-[11px] text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
              >
                {discoveringSenders ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Search className="h-3 w-3" />
                )}
                读取最近微信用户 ID
              </button>
              <span className="text-[10px] text-text-tertiary">
                先用要授权的微信账号发一条消息。
              </span>
            </div>
            {discoveredSenders.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {discoveredSenders.map((sender) => (
                  <div
                    key={sender.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-glass-border bg-glass-bg/45 px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block max-w-[180px] truncate text-[11px] font-medium text-text-primary">
                        {sender.label || "未命名用户"}
                      </span>
                      <code className="mt-1 block break-all font-mono text-[10px] text-neon-cyan">
                        {sender.id}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setSenderIds(sender.id)}
                        disabled={busy}
                        className="rounded border border-neon-cyan/35 bg-neon-cyan/10 px-2 py-1 text-[10px] text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
                      >
                        填入
                      </button>
                      <button
                        type="button"
                        onClick={() => appendSenderId(sender.id)}
                        disabled={busy}
                        className="rounded border border-glass-border px-2 py-1 text-[10px] text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
                      >
                        追加
                      </button>
                      <button
                        type="button"
                        onClick={() => copySenderId(sender.id)}
                        disabled={busy}
                        title={copiedSenderId === sender.id ? "已复制" : "复制微信用户 ID"}
                        className="inline-flex h-6 w-6 items-center justify-center rounded border border-glass-border text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
                      >
                        {copiedSenderId === sender.id ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {senderDiscoverHint && (
              <p className="mt-1 text-[10px] leading-relaxed text-text-tertiary">
                {senderDiscoverHint}
              </p>
            )}
            {senderDiscoverError && (
              <p className="mt-1 text-[10px] leading-relaxed text-amber-200">
                {senderDiscoverError}
              </p>
            )}
          </Field>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              checked={enableNow}
              onChange={(e) => setEnableNow(e.target.checked)}
              disabled={busy}
              className="accent-neon-cyan"
            />
            立即启用
          </label>
          {whitelistEmpty && (
            <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
              必须填写至少一个允许的微信用户 ID，才能保存微信接入。
            </p>
          )}
        </StepSection>
      )}

      {senderReady && (
        <StepSection
          step={3}
          title="确认接入名称和启用状态"
          description="名称只用于后台识别；启用后会立即开始处理来自允许用户的微信消息。"
          complete
        >
          <Field label="接入名称（可选）">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
              placeholder="例如：我的微信"
              className="w-full rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
            />
          </Field>
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              checked={enableNow}
              onChange={(e) => setEnableNow(e.target.checked)}
              disabled={busy}
              className="accent-neon-cyan"
            />
            立即启用
          </label>
        </StepSection>
      )}

      {senderReady && (
        <StepSection
          step={4}
          title="保存微信接入"
          description="保存后会用本次 loginId 在 daemon 侧创建连接，后续列表里可以停用、编辑或删除。"
        >
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="inline-flex items-center gap-1 rounded-md border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            保存
          </button>
        </StepSection>
      )}

      {error && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/10 p-2 text-[11px] text-red-300">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-glass-border bg-glass-bg/60 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          取消
        </button>
      </div>
    </div>
  );
}

function GatewayEditForm({
  agentId,
  gateway,
  daemonOffline,
  onCancel,
  onSaved,
  onError,
}: {
  agentId: string;
  gateway: AgentGatewayConnection;
  daemonOffline: boolean;
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string | null) => void;
}) {
  const patch = useAgentGatewayStore((s) => s.patch);
  const startWechatLogin = useAgentGatewayStore((s) => s.startWechatLogin);
  const pollWechatLogin = useAgentGatewayStore((s) => s.pollWechatLogin);
  const discoverWechatSenders = useAgentGatewayStore((s) => s.discoverWechatSenders);
  const cfg = (gateway.config ?? {}) as {
    allowedChatIds?: unknown;
    allowedSenderIds?: unknown;
    baseUrl?: unknown;
  };
  const initialChatIds = Array.isArray(cfg.allowedChatIds)
    ? cfg.allowedChatIds.filter((id): id is string => typeof id === "string").join("\n")
    : "";
  const initialSenderIds = Array.isArray(cfg.allowedSenderIds)
    ? cfg.allowedSenderIds.filter((id): id is string => typeof id === "string").join("\n")
    : "";
  const [label, setLabel] = useState(gateway.label ?? "");
  const [chatIds, setChatIds] = useState(initialChatIds);
  const [senderIds, setSenderIds] = useState(initialSenderIds);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [discoveringChats, setDiscoveringChats] = useState(false);
  const [discoveredChats, setDiscoveredChats] = useState<
    { id: string; type: string | null; label: string | null }[]
  >([]);
  const [chatDiscoverHint, setChatDiscoverHint] = useState<string | null>(null);
  const [chatDiscoverError, setChatDiscoverError] = useState<string | null>(null);
  const [copiedChatId, setCopiedChatId] = useState<string | null>(null);
  const [wechatLoginId, setWechatLoginId] = useState<string | null>(null);
  const [wechatQrcodeUrl, setWechatQrcodeUrl] = useState<string | null>(null);
  const [wechatQrcode, setWechatQrcode] = useState<string | null>(null);
  const [wechatStatus, setWechatStatus] = useState<WechatLoginStatus>("pending");
  const [wechatLoginBusy, setWechatLoginBusy] = useState(false);
  const [discoveringSenders, setDiscoveringSenders] = useState(false);
  const [discoveredSenders, setDiscoveredSenders] = useState<
    { id: string; label?: string | null }[]
  >([]);
  const [senderDiscoverHint, setSenderDiscoverHint] = useState<string | null>(null);
  const [senderDiscoverError, setSenderDiscoverError] = useState<string | null>(null);
  const [copiedSenderId, setCopiedSenderId] = useState<string | null>(null);
  const editPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (editPollTimer.current) clearInterval(editPollTimer.current);
    };
  }, []);

  const allowedChatIds = csvToList(chatIds);
  const allowedSenderIds = csvToList(senderIds);
  const whitelistIncomplete =
    gateway.provider === "telegram"
      ? allowedChatIds.length === 0 || allowedSenderIds.length === 0
      : allowedSenderIds.length === 0;
  const canSave = !whitelistIncomplete && !daemonOffline && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    onError(null);
    try {
      await patch(agentId, gateway.id, {
        label: label.trim() || null,
        config: {
          label: label.trim() || undefined,
          ...(gateway.provider === "telegram" ? { allowedChatIds } : {}),
          allowedSenderIds,
          ...(typeof cfg.baseUrl === "string" ? { baseUrl: cfg.baseUrl } : {}),
        },
        ...(gateway.provider === "telegram" && token.trim()
          ? { secret: { botToken: token.trim() } }
          : {}),
      });
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDiscoverTelegramChats() {
    const botToken = token.trim();
    if (!botToken || discoveringChats || gateway.provider !== "telegram") {
      if (!botToken) setChatDiscoverError("请先填写 Bot token，Telegram 不会在前端保存明文 token。");
      return;
    }
    setDiscoveringChats(true);
    setChatDiscoverHint("等待 Telegram 最近消息...");
    setChatDiscoverError(null);
    setDiscoveredChats([]);
    try {
      let chats: { id: string; type: string | null; label: string | null }[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        setChatDiscoverHint(
          attempt === 1
            ? "等待 Telegram 最近消息..."
            : `还没发现消息，继续等待 ${attempt}/3...`,
        );
        const res = await fetch("/api/telegram/chat-ids", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ botToken, timeoutSeconds: 8 }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          chats?: { id: string; type: string | null; label: string | null }[];
          message?: string;
          error?: string;
        };
        if (!res.ok) {
          throw new Error(json.message || json.error || `HTTP ${res.status}`);
        }
        chats = Array.isArray(json.chats) ? json.chats : [];
        if (chats.length > 0) break;
      }
      setDiscoveredChats(chats);
      if (chats.length === 1) {
        setChatIds(chats[0].id);
        setChatDiscoverHint("已自动填入发现的 chat id。");
      } else if (chats.length === 0) {
        setChatDiscoverHint(null);
        setChatDiscoverError("还没有发现会话。请先在目标私聊或群聊里给 bot 发一条消息，然后再读取。");
      } else {
        setChatDiscoverHint("发现多个会话，请选择要允许的 chat id。");
      }
    } catch (err) {
      setChatDiscoverHint(null);
      setChatDiscoverError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscoveringChats(false);
    }
  }

  function appendChatId(id: string) {
    const existing = new Set(csvToList(chatIds));
    existing.add(id);
    setChatIds(Array.from(existing).join("\n"));
  }

  async function copyChatId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedChatId(id);
      window.setTimeout(() => setCopiedChatId(null), 1600);
    } catch {
      setChatDiscoverError("复制失败，请手动复制 chat id。");
    }
  }

  async function handleStartWechatDiscoveryLogin() {
    if (daemonOffline || saving || wechatLoginBusy || gateway.provider !== "wechat") return;
    setWechatLoginBusy(true);
    setSenderDiscoverError(null);
    setSenderDiscoverHint(null);
    setDiscoveredSenders([]);
    try {
      const r = await startWechatLogin(agentId, {
        gatewayId: gateway.id,
        ...(typeof cfg.baseUrl === "string" ? { baseUrl: cfg.baseUrl } : {}),
      });
      setWechatLoginId(r.loginId);
      setWechatQrcodeUrl(r.qrcodeUrl ?? null);
      setWechatQrcode(r.qrcode);
      setWechatStatus("pending");
      if (editPollTimer.current) clearInterval(editPollTimer.current);
      editPollTimer.current = setInterval(() => {
        void pollEditWechatLogin(r.loginId);
      }, 2000);
    } catch (err) {
      setSenderDiscoverError(err instanceof Error ? err.message : String(err));
    } finally {
      setWechatLoginBusy(false);
    }
  }

  async function pollEditWechatLogin(loginId: string) {
    try {
      const r = await pollWechatLogin(agentId, loginId);
      setWechatStatus(r.status);
      if (r.status === "confirmed" || r.status === "expired" || r.status === "failed") {
        if (editPollTimer.current) {
          clearInterval(editPollTimer.current);
          editPollTimer.current = null;
        }
      }
      if (r.status === "confirmed") {
        setSenderDiscoverHint("已确认登录，可以读取最近微信用户 ID。");
      }
    } catch (err) {
      setSenderDiscoverError(err instanceof Error ? err.message : String(err));
      if (editPollTimer.current) {
        clearInterval(editPollTimer.current);
        editPollTimer.current = null;
      }
    }
  }

  async function handleDiscoverWechatSenders() {
    if (!wechatLoginId || discoveringSenders || wechatStatus !== "confirmed") return;
    setDiscoveringSenders(true);
    setSenderDiscoverHint("等待最近微信消息...");
    setSenderDiscoverError(null);
    setDiscoveredSenders([]);
    try {
      let senders: { id: string; label?: string | null }[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        setSenderDiscoverHint(
          attempt === 1
            ? "等待最近微信消息..."
            : `还没发现消息，继续等待 ${attempt}/3...`,
        );
        const result = await discoverWechatSenders(agentId, wechatLoginId, {
          timeoutSeconds: 8,
        });
        senders = result.senders;
        if (senders.length > 0) break;
      }
      setDiscoveredSenders(senders);
      if (senders.length === 1) {
        setSenderIds(senders[0].id);
        setSenderDiscoverHint("已自动填入发现的微信用户 ID。");
      } else if (senders.length === 0) {
        setSenderDiscoverHint(null);
        setSenderDiscoverError("还没有发现用户。请先用要授权的微信账号发一条消息，再读取。");
      } else {
        setSenderDiscoverHint("发现多个用户，请选择要允许的微信用户 ID。");
      }
    } catch (err) {
      setSenderDiscoverHint(null);
      setSenderDiscoverError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscoveringSenders(false);
    }
  }

  function appendSenderId(id: string) {
    const existing = new Set(csvToList(senderIds));
    existing.add(id);
    setSenderIds(Array.from(existing).join("\n"));
  }

  async function copySenderId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedSenderId(id);
      window.setTimeout(() => setCopiedSenderId(null), 1600);
    } catch {
      setSenderDiscoverError("复制失败，请手动复制微信用户 ID。");
    }
  }

  const wechatStatusText: Record<WechatLoginStatus, string> = {
    pending: "等待扫码",
    scanned: "等待手机确认",
    confirmed: "已确认",
    expired: "已过期",
    failed: "登录失败",
  };

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-glass-border bg-deep-black/35 p-3">
      <Field label="接入名称（可选）">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={saving}
          placeholder={gateway.provider === "wechat" ? "例如：我的微信" : "例如：客服 Bot"}
          className="w-full rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
        />
      </Field>
      {gateway.provider === "telegram" && (
        <>
          <Field label="允许的 chat id（逗号或换行分隔）">
            <textarea
              value={chatIds}
              onChange={(e) => setChatIds(e.target.value)}
              disabled={saving}
              rows={2}
              placeholder="-1001234567890, 987654321"
              className="w-full resize-none rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 font-mono text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
            />
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleDiscoverTelegramChats}
                  disabled={!token.trim() || saving || discoveringChats}
                  className="inline-flex items-center gap-1 rounded-md border border-glass-border bg-glass-bg/50 px-2.5 py-1 text-[11px] text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
                >
                  {discoveringChats ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Search className="h-3 w-3" />
                  )}
                  读取最近 chat id
                </button>
                <span className="text-[10px] text-text-tertiary">
                  先填写 Bot token，并在目标私聊或群聊里给 bot 发一条消息。
                </span>
              </div>
              {discoveredChats.length > 0 && (
                <div className="space-y-1.5">
                  {discoveredChats.map((chat) => (
                    <div
                      key={chat.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-glass-border bg-glass-bg/45 px-2.5 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="max-w-[180px] truncate text-[11px] font-medium text-text-primary">
                            {chat.label || "未命名会话"}
                          </span>
                          {chat.type ? (
                            <span className="rounded border border-glass-border px-1.5 py-0.5 text-[9px] uppercase text-text-tertiary">
                              {chat.type}
                            </span>
                          ) : null}
                        </div>
                        <code className="mt-1 block break-all font-mono text-[10px] text-neon-cyan">
                          {chat.id}
                        </code>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setChatIds(chat.id)}
                          disabled={saving}
                          className="rounded border border-neon-cyan/35 bg-neon-cyan/10 px-2 py-1 text-[10px] text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
                        >
                          填入
                        </button>
                        <button
                          type="button"
                          onClick={() => appendChatId(chat.id)}
                          disabled={saving}
                          className="rounded border border-glass-border px-2 py-1 text-[10px] text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
                        >
                          追加
                        </button>
                        <button
                          type="button"
                          onClick={() => copyChatId(chat.id)}
                          disabled={saving}
                          title={copiedChatId === chat.id ? "已复制" : "复制 chat id"}
                          className="inline-flex h-6 w-6 items-center justify-center rounded border border-glass-border text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
                        >
                          {copiedChatId === chat.id ? (
                            <CheckCircle2 className="h-3 w-3" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {chatDiscoverHint && (
                <p className="text-[10px] leading-relaxed text-text-tertiary">
                  {chatDiscoverHint}
                </p>
              )}
              {chatDiscoverError && (
                <p className="text-[10px] leading-relaxed text-amber-200">
                  {chatDiscoverError}
                </p>
              )}
            </div>
          </Field>
          <Field label="替换 Bot token（可选）">
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={saving}
              placeholder="不填写则保持当前 token"
              className="w-full rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 font-mono text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
            />
          </Field>
        </>
      )}
      <Field
        label={
          gateway.provider === "wechat"
            ? "允许的微信用户 ID（逗号或换行分隔）"
            : "允许的发送者 user id（逗号或换行分隔）"
        }
      >
        <textarea
          value={senderIds}
          onChange={(e) => setSenderIds(e.target.value)}
          disabled={saving}
          rows={2}
          placeholder={gateway.provider === "wechat" ? "xxx@im.wechat" : "123456789"}
          className="w-full resize-none rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 font-mono text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
        />
        {gateway.provider === "wechat" && (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleStartWechatDiscoveryLogin}
                disabled={daemonOffline || saving || wechatLoginBusy}
                className="inline-flex items-center gap-1 rounded-md border border-glass-border bg-glass-bg/50 px-2.5 py-1 text-[11px] text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
              >
                {wechatLoginBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Search className="h-3 w-3" />
                )}
                {wechatLoginId ? "重新扫码检测用户 ID" : "检测微信用户 ID"}
              </button>
              <button
                type="button"
                onClick={handleDiscoverWechatSenders}
                disabled={
                  !wechatLoginId ||
                  wechatStatus !== "confirmed" ||
                  saving ||
                  discoveringSenders
                }
                className="inline-flex items-center gap-1 rounded-md border border-glass-border bg-glass-bg/50 px-2.5 py-1 text-[11px] text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
              >
                {discoveringSenders ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Search className="h-3 w-3" />
                )}
                读取最近微信用户 ID
              </button>
              <span className="text-[10px] text-text-tertiary">
                扫码确认后，用要授权的微信账号发一条消息。
              </span>
            </div>
            {wechatLoginId && wechatStatus !== "confirmed" && (
              <div className="space-y-2 rounded-lg border border-glass-border bg-glass-bg/35 p-2">
                <div className="text-[11px] text-text-secondary">
                  {wechatStatusText[wechatStatus]}
                </div>
                {wechatQrcodeUrl ? (
                  <div className="inline-flex h-36 w-36 items-center justify-center rounded-md border border-glass-border bg-white p-2">
                    <QRCodeSVG
                      value={wechatQrcodeUrl}
                      size={128}
                      marginSize={1}
                      level="M"
                      title="WeChat 二维码"
                    />
                  </div>
                ) : wechatQrcode ? (
                  <div className="break-all rounded-md border border-glass-border bg-deep-black/40 p-2 font-mono text-[10px] text-text-secondary">
                    {wechatQrcode}
                  </div>
                ) : null}
              </div>
            )}
            {discoveredSenders.length > 0 && (
              <div className="space-y-1.5">
                {discoveredSenders.map((sender) => (
                  <div
                    key={sender.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-glass-border bg-glass-bg/45 px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block max-w-[180px] truncate text-[11px] font-medium text-text-primary">
                        {sender.label || "未命名用户"}
                      </span>
                      <code className="mt-1 block break-all font-mono text-[10px] text-neon-cyan">
                        {sender.id}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setSenderIds(sender.id)}
                        disabled={saving}
                        className="rounded border border-neon-cyan/35 bg-neon-cyan/10 px-2 py-1 text-[10px] text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
                      >
                        填入
                      </button>
                      <button
                        type="button"
                        onClick={() => appendSenderId(sender.id)}
                        disabled={saving}
                        className="rounded border border-glass-border px-2 py-1 text-[10px] text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
                      >
                        追加
                      </button>
                      <button
                        type="button"
                        onClick={() => copySenderId(sender.id)}
                        disabled={saving}
                        title={copiedSenderId === sender.id ? "已复制" : "复制微信用户 ID"}
                        className="inline-flex h-6 w-6 items-center justify-center rounded border border-glass-border text-text-secondary hover:border-neon-cyan/35 hover:text-neon-cyan disabled:opacity-50"
                      >
                        {copiedSenderId === sender.id ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {senderDiscoverHint && (
              <p className="text-[10px] leading-relaxed text-text-tertiary">
                {senderDiscoverHint}
              </p>
            )}
            {senderDiscoverError && (
              <p className="text-[10px] leading-relaxed text-amber-200">
                {senderDiscoverError}
              </p>
            )}
          </div>
        )}
      </Field>
      {whitelistIncomplete && (
        <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
          {gateway.provider === "telegram"
            ? "必须同时保留允许的 chat id 和发送者 user id，才能保存修改。"
            : "必须保留至少一个允许的微信用户 ID，才能保存修改。"}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-glass-border bg-glass-bg/60 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
          className="inline-flex items-center gap-1 rounded-md border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          保存修改
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-text-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}

function DeleteConfirmDialog({
  gateway,
  busy,
  onCancel,
  onConfirm,
}: {
  gateway: AgentGatewayConnection;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-glass-border bg-deep-black p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 text-base font-semibold text-text-primary">
          删除接入
        </h3>
        <p className="text-xs text-text-secondary">
          即将删除 <span className="text-text-primary">{gateway.label || providerName(gateway.provider)}</span>。
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[11px] text-text-secondary">
          <li>仅移除第三方接入。</li>
          <li>不会删除 BotCord agent。</li>
          <li>不会删除 agent workspace、memory 或 runtime 配置。</li>
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-glass-border bg-glass-bg/60 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-red-400/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            确认删除
          </button>
        </div>
      </div>
    </div>
  );
}
