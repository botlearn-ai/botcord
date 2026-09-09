"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import {
  ArrowLeft,
  Hash,
  Info,
  Loader2,
  LockKeyhole,
  Send,
  X,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { spaceError, type SpaceUser } from "@/lib/team-spaces";
import {
  conversationName,
  teamConversationsApi,
  type TeamConversation,
} from "@/lib/team-conversations";
import { createTeamThreadStore } from "@/store/team-thread-store";
import { teamButton } from "./TeamConversationDialog";

export default function TeamThread({
  spaceId,
  conversation,
  userId,
  users,
  onBack,
  onUpdated,
}: {
  spaceId: string;
  conversation: TeamConversation;
  userId: string;
  users: SpaceUser[];
  onBack: () => void;
  onUpdated: () => void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const store = useMemo(
    () => createTeamThreadStore(spaceId, conversation.id),
    [spaceId, conversation.id]
  );
  const {
    messages,
    loading,
    loadingOlder,
    hasOlder,
    error,
    load,
    older,
    refresh,
  } = useStore(store);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const [details, setDetails] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const retry = useRef<{ content: string; id: string } | null>(null);
  const mounted = useRef(false);
  const locked = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastRead = useRef(0);
  const latest = messages.at(-1)?.sequence ?? 0;
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;
  useEffect(() => {
    mounted.current = true;
    void load();
    const poll = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(poll, 4000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      store.getState().cancel();
    };
  }, [load, refresh, store]);
  useEffect(() => {
    if (atBottom && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [latest, atBottom, loading]);
  useEffect(() => {
    const read = () => {
      if (
        !latest ||
        !atBottom ||
        document.visibilityState !== "visible" ||
        latest <= lastRead.current
      )
        return;
      lastRead.current = latest;
      void teamConversationsApi
        .read(spaceId, conversation.id, latest)
        .then(() => {
          if (mounted.current) onUpdatedRef.current();
        })
        .catch(() => {
          lastRead.current = 0;
        });
    };
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, [latest, atBottom, spaceId, conversation.id]);
  const name = conversationName(
    conversation,
    userId,
    t("成员已离开", "Member has left")
  );
  const people =
    conversation.visibility === "organization"
      ? users.filter((u) => u.status === "active")
      : conversation.participants;
  async function send() {
    const content = draft.trim();
    if (
      !content ||
      locked.current ||
      error ||
      loading ||
      conversation.can_send === false
    )
      return;
    locked.current = true;
    setSending(true);
    setSendError(null);
    if (retry.current?.content !== content)
      retry.current = { content, id: crypto.randomUUID() };
    try {
      const sent = await teamConversationsApi.send(
        spaceId,
        conversation.id,
        content,
        retry.current.id
      );
      if (!mounted.current) return;
      retry.current = null;
      setDraft("");
      setAtBottom(true);
      // Fetch all intervening messages before advancing the cursor to our send.
      await refresh();
      if (
        mounted.current &&
        !store.getState().error &&
        (store.getState().messages.at(-1)?.sequence ?? 0) < sent.sequence
      )
        await refresh();
      if (mounted.current) onUpdatedRef.current();
    } catch (cause) {
      if (mounted.current) setSendError(cause);
    } finally {
      locked.current = false;
      if (mounted.current) setSending(false);
    }
  }
  return (
    <div className="flex h-full min-h-0 min-w-0">
      <section className="flex min-w-0 flex-1 flex-col" aria-label={name}>
        <header className="flex h-[76px] shrink-0 items-center gap-3 border-b border-glass-border px-4 sm:px-6">
          <button
            className="rounded-lg p-2 md:hidden"
            onClick={onBack}
            aria-label={t("返回会话列表", "Back to conversations")}
          >
            <ArrowLeft size={20} />
          </button>
          <div className="rounded-xl bg-neon-cyan/10 p-2.5 text-neon-cyan">
            {conversation.visibility === "private" ? (
              <LockKeyhole size={20} />
            ) : (
              <Hash size={20} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold">{name}</h1>
            <p className="mt-1 text-xs text-text-secondary">
              {conversation.kind === "dm"
                ? t("组织内私聊", "Organization direct message")
                : conversation.visibility === "organization"
                ? t(
                    "组织全体成员可见",
                    "Visible to everyone in this organization"
                  )
                : t("仅房间成员可见", "Visible to room members only")}
            </p>
          </div>
          <button
            className="rounded-lg p-2 hover:bg-glass-bg"
            aria-label={t("会话详情", "Conversation details")}
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          >
            <Info size={20} />
          </button>
        </header>
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8"
          onScroll={() => {
            const el = scroller.current;
            if (el)
              setAtBottom(
                el.scrollHeight - el.scrollTop - el.clientHeight < 60
              );
          }}
        >
          {loading && (
            <p
              role="status"
              className="text-center text-sm text-text-secondary"
            >
              {t("正在加载消息…", "Loading messages…")}
            </p>
          )}
          {error != null && (
            <div role="alert" className="space-y-3 text-center text-sm">
              <p>{spaceError(error, zh)}</p>
              <button className={teamButton} onClick={() => void load()}>
                {t("重试", "Retry")}
              </button>
            </div>
          )}
          {hasOlder && (
            <div className="mb-6 text-center">
              <button
                className="text-xs text-neon-cyan disabled:opacity-50"
                disabled={loadingOlder}
                onClick={async () => {
                  const el = scroller.current;
                  const height = el?.scrollHeight ?? 0;
                  const top = el?.scrollTop ?? 0;
                  setAtBottom(false);
                  await older();
                  requestAnimationFrame(() => {
                    if (el && mounted.current)
                      el.scrollTop = top + el.scrollHeight - height;
                  });
                }}
              >
                {loadingOlder
                  ? t("加载中…", "Loading…")
                  : t("查看更早的消息", "Load earlier messages")}
              </button>
            </div>
          )}
          {!loading && !error && !messages.length && (
            <div className="mx-auto max-w-sm py-16 text-center">
              <Hash className="mx-auto mb-4 text-neon-cyan" size={36} />
              <h2 className="font-semibold">
                {t("从第一条消息开始", "Start with a message")}
              </h2>
              <p className="mt-2 text-sm leading-6 text-text-secondary">
                {t(
                  "在这里同步进展、讨论问题，让协作有上下文。",
                  "Share progress and discuss ideas with your team."
                )}
              </p>
            </div>
          )}
          <ol
            className="space-y-5"
            aria-label={t("消息记录", "Message history")}
          >
            {messages.map((message) => {
              const own = message.author_user_id === userId;
              return (
                <li
                  key={message.sequence}
                  className={`flex gap-3 ${own ? "flex-row-reverse" : ""}`}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neon-cyan/10 text-sm font-medium text-neon-cyan">
                    {message.author_name.slice(0, 1)}
                  </div>
                  <div
                    className={`min-w-0 max-w-[85%] sm:max-w-[75%] ${
                      own ? "text-right" : ""
                    }`}
                  >
                    <div className="mb-1.5 text-xs text-text-secondary">
                      <span>{message.author_name}</span>
                      <time className="ml-2" dateTime={message.created_at}>
                        {new Date(message.created_at).toLocaleString(
                          zh ? "zh-CN" : "en",
                          {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          }
                        )}
                      </time>
                    </div>
                    <p
                      className={`inline-block whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-left text-sm leading-6 [overflow-wrap:anywhere] ${
                        own
                          ? "bg-neon-cyan/10"
                          : "border border-glass-border bg-glass-bg"
                      }`}
                    >
                      {message.content}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
        <form
          className="shrink-0 border-t border-glass-border p-4 sm:px-6"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {conversation.can_send === false && (
            <p className="mb-2 text-sm text-text-secondary">
              {t(
                "对方已离开或暂停组织成员身份，当前仅可查看历史消息。",
                "The other member has left or is suspended. This conversation is read-only."
              )}
            </p>
          )}
          {sendError != null && (
            <p role="alert" className="mb-2 text-sm text-red-500">
              {spaceError(sendError, zh)}{" "}
              {t(
                "草稿已保留，可重试发送。",
                "Your draft is saved here. Retry sending."
              )}
            </p>
          )}
          <div className="rounded-2xl border border-glass-border bg-glass-bg p-3 focus-within:border-neon-cyan/40">
            <textarea
              className="max-h-40 min-h-16 w-full resize-y bg-transparent text-sm leading-6 outline-none disabled:opacity-50"
              aria-label={t("消息内容", "Message")}
              placeholder={t(
                "发送消息，Enter 发送，Shift + Enter 换行",
                "Message · Enter to send, Shift + Enter for a new line"
              )}
              value={draft}
              maxLength={8000}
              disabled={
                sending ||
                loading ||
                error != null ||
                conversation.can_send === false
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-text-secondary">
                {t(
                  "以你的组织成员身份发送",
                  "Sending as an organization member"
                )}
              </span>
              <button
                className="inline-flex items-center gap-2 rounded-lg bg-neon-cyan/10 px-3 py-2 text-sm text-neon-cyan disabled:opacity-40"
                disabled={
                  sending ||
                  loading ||
                  error != null ||
                  conversation.can_send === false ||
                  !draft.trim()
                }
              >
                {sending ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Send size={16} />
                )}
                {t("发送", "Send")}
              </button>
            </div>
          </div>
        </form>
      </section>
      {details && (
        <aside
          className="absolute inset-0 z-10 overflow-y-auto border-l border-glass-border bg-deep-black p-5 sm:inset-y-0 sm:left-auto sm:w-72 lg:static lg:shrink-0"
          aria-label={t("会话详情", "Conversation details")}
        >
          <div className="mb-6 flex items-center justify-between">
            <h2 className="font-semibold">
              {t("会话详情", "Conversation details")}
            </h2>
            <button
              className="rounded p-2"
              aria-label={t("关闭详情", "Close details")}
              onClick={() => setDetails(false)}
            >
              <X size={18} />
            </button>
          </div>
          <h3 className="break-words font-medium">{name}</h3>
          <p className="mt-2 text-xs leading-5 text-text-secondary">
            {conversation.visibility === "organization"
              ? t(
                  "组织内当前和之后加入的成员均可查看全部历史。",
                  "Current and future organization members can read the full history."
                )
              : t(
                  "只有此会话的参与者可以访问消息。",
                  "Only participants can access these messages."
                )}
          </p>
          <h3 className="mb-3 mt-6 text-sm text-text-secondary">
            {t("成员", "Members")} · {people.length}
          </h3>
          <ul className="space-y-3">
            {people.map((person) => (
              <li
                key={person.user_id}
                className="break-words rounded-xl bg-glass-bg p-3 text-sm"
              >
                {person.display_name}
                {person.user_id === userId ? t("（你）", " (you)") : ""}
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
