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
  Loader2,
  MessageCircle,
  Plus,
  Search,
  Send,
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
  const test = useAgentGatewayStore((s) => s.test);

  const [addMode, setAddMode] = useState<AddMode>(null);
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

  async function handleTest(g: AgentGatewayConnection) {
    if (daemonOffline) return;
    setBusyId(g.id);
    setErr(g.id, null);
    setOk(g.id, null);
    const r = await test(agentId, g.id);
    setBusyId(null);
    if (r.ok) setOk(g.id, r.message || "连接正常");
    else setErr(g.id, r.message || "测试失败");
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
              本地 daemon 当前不在线，已连接列表仍可读，但无法创建、扫码、启用、停用、测试或删除接入。
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
                        onClick={() => handleTest(g)}
                        disabled={daemonOffline || busyId === g.id}
                        className="rounded-md border border-glass-border bg-glass-bg/60 px-2 py-1 text-[11px] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                      >
                        测试
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
  const [acceptEmpty, setAcceptEmpty] = useState(false);
  const [discoveringChats, setDiscoveringChats] = useState(false);
  const [discoveredChats, setDiscoveredChats] = useState<
    { id: string; type: string | null; label: string | null }[]
  >([]);
  const [discoverHint, setDiscoverHint] = useState<string | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [copiedChatId, setCopiedChatId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allowedChatIds = csvToList(chatIds);
  const allowedSenderIds = csvToList(senderIds);
  const whitelistEmpty = allowedChatIds.length === 0 && allowedSenderIds.length === 0;
  const canSave =
    !!token.trim() &&
    !daemonOffline &&
    !saving &&
    (!whitelistEmpty || acceptEmpty);

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
    try {
      let chats: { id: string; type: string | null; label: string | null }[] = [];
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
        setDiscoverHint("已自动填入发现的 chat id。");
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

  async function copyChatId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedChatId(id);
      window.setTimeout(() => setCopiedChatId(null), 1600);
    } catch {
      setDiscoverError("复制失败，请手动复制 chat id。");
    }
  }

  return (
    <div className="space-y-3">
      <Field label="Bot token">
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={saving}
          placeholder="123456:ABC-..."
          className="w-full rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 font-mono text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
        />
        <p className="mt-1 text-[10px] text-text-tertiary">
          Token 仅在创建/替换时填写，保存后只显示 token preview。
        </p>
      </Field>
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
      <Field label="允许的发送者 user id（逗号或换行分隔）">
        <textarea
          value={senderIds}
          onChange={(e) => setSenderIds(e.target.value)}
          disabled={saving}
          rows={2}
          placeholder="123456789"
          className="w-full resize-none rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 font-mono text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
        />
      </Field>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-text-primary">
        <input
          type="checkbox"
          checked={enableNow}
          onChange={(e) => setEnableNow(e.target.checked)}
          disabled={saving}
          className="accent-neon-cyan"
        />
        立即启用
      </label>
      {whitelistEmpty && (
        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
          <input
            type="checkbox"
            checked={acceptEmpty}
            onChange={(e) => setAcceptEmpty(e.target.checked)}
            disabled={saving}
            className="mt-0.5 accent-amber-300"
          />
          <span>
            白名单为空将拒绝所有第三方消息。我已确认仍然要创建。
          </span>
        </label>
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
          保存
        </button>
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
  const [acceptEmpty, setAcceptEmpty] = useState(false);
  const [copied, setCopied] = useState(false);
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
  const canSave =
    phase === "ready" &&
    !!loginId &&
    !daemonOffline &&
    !busy &&
    (!whitelistEmpty || acceptEmpty);

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

  const statusText: Record<WechatLoginStatus, string> = {
    pending: "等待扫码",
    scanned: "等待手机确认",
    confirmed: "已登录",
    expired: "已过期",
    failed: "登录失败",
  };

  return (
    <div className="space-y-3">
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
        <div className="space-y-3">
          <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-2 text-[11px] text-emerald-200">
            已授权
            {tokenPreview ? (
              <span className="ml-1 font-mono">· token {tokenPreview}</span>
            ) : null}
          </div>
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
          <Field label="允许的微信用户 ID（逗号或换行分隔）">
            <textarea
              value={senderIds}
              onChange={(e) => setSenderIds(e.target.value)}
              disabled={busy}
              rows={2}
              placeholder="xxx@im.wechat"
              className="w-full resize-none rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 font-mono text-xs text-text-primary outline-none focus:border-neon-cyan/40 disabled:opacity-50"
            />
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
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
              <input
                type="checkbox"
                checked={acceptEmpty}
                onChange={(e) => setAcceptEmpty(e.target.checked)}
                disabled={busy}
                className="mt-0.5 accent-amber-300"
              />
              <span>白名单为空将拒绝所有第三方消息。我已确认仍然要创建。</span>
            </label>
          )}
        </div>
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
        {phase === "ready" && (
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="inline-flex items-center gap-1 rounded-md border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            保存
          </button>
        )}
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
