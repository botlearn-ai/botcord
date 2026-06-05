"use client";

/**
 * CommunityPanel — independent top-level tab.
 *
 * Layout inspired by BotLearn's /community page:
 *   - Left rail: channels (submolt-like)
 *   - Center: post feed for the active channel
 *   - Right rail: weekly highlights / contributors / pinned
 *   - Click post → post detail with comments
 */

import { useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Award,
  ChevronLeft,
  Hash,
  MessageCircle,
  Plus,
  Sparkles,
  Star,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  CHANNELS,
  type Channel,
  type CommunityPost,
  POSTS,
  TEAMS,
  channelBySlug,
  commentsByPost,
  postById,
  postsByChannel,
  teamById,
} from "@/lib/centaur-mock";
import { CentaurStack, CtaPill, DomainBadge, EmptyState, domainMeta } from "./atoms";

function deriveRoute(pathname: string): { mode: "channel" | "post"; slug: string; postId?: string } {
  const parts = pathname.split("/").filter(Boolean);
  // /chats/community            -> channel: general
  // /chats/community/[slug]     -> channel: slug
  // /chats/community/post/[id]  -> post detail
  if (parts[2] === "post" && parts[3]) {
    return { mode: "post", slug: "general", postId: parts[3] };
  }
  const slug = parts[2] || "general";
  return { mode: "channel", slug };
}

export default function CommunityPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const route = deriveRoute(pathname);

  return (
    <div className="flex h-full overflow-hidden bg-deep-black">
      {/* Left rail: channels */}
      <aside className="hidden h-full w-64 shrink-0 flex-col border-r border-glass-border bg-deep-black-light md:flex">
        <div className="border-b border-glass-border px-4 py-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">Channels</h2>
            <button
              onClick={() => alert("Demo: create channel")}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-glass-bg hover:text-neon-cyan"
              title="Create channel"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-0.5 text-[10px] text-text-secondary/60">半人马社区频道</p>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3">
          {CHANNELS.map((ch) => {
            const active = route.slug === ch.slug;
            return (
              <button
                key={ch.id}
                onClick={() => router.push(`/chats/community/${ch.slug}`)}
                className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors ${
                  active ? "bg-neon-cyan/10 text-neon-cyan" : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
                }`}
              >
                <Hash className={`h-3.5 w-3.5 shrink-0 ${active ? "text-neon-cyan" : "text-text-secondary/60"}`} />
                <span className="min-w-0 flex-1 truncate font-medium">{ch.name}</span>
                <span className="shrink-0 font-mono text-[9px] tabular-nums text-text-secondary/60">{ch.members.toLocaleString()}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Center pane */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {route.mode === "post" ? <PostDetail postId={route.postId!} /> : <ChannelFeed slug={route.slug} />}
      </div>

      {/* Right rail */}
      <RightRail />
    </div>
  );
}

// =============================================================
// Channel feed
// =============================================================

function ChannelFeed({ slug }: { slug: string }) {
  const router = useRouter();
  const channel = channelBySlug(slug);
  const posts = postsByChannel(slug);
  const [sort, setSort] = useState<"hot" | "new" | "top">("hot");

  const sorted = useMemo(() => {
    if (sort === "new") return [...posts].sort((a, b) => b.postedAt.localeCompare(a.postedAt));
    if (sort === "top") return [...posts].sort((a, b) => b.upvotes - a.upvotes);
    return posts;
  }, [posts, sort]);

  if (!channel) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <EmptyState title="频道不存在" hint="左侧选个频道" />
      </div>
    );
  }

  const meta = channel.domain !== "general" ? domainMeta(channel.domain) : null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-6 max-md:px-4 max-md:py-4">
      <header className="mb-6 rounded-2xl border border-glass-border bg-gradient-to-r from-deep-black-light to-deep-black-light/40 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-glass-border bg-glass-bg text-xl">
              {meta?.emoji ?? "#"}
            </div>
            <div>
              <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
                {channel.name}
                {meta && <DomainBadge domain={channel.domain as never} />}
              </h1>
              <p className="mt-1 text-[12px] text-text-secondary">{channel.description}</p>
              <div className="mt-2 flex items-center gap-3 text-[11px] text-text-secondary/70">
                <span className="flex items-center gap-1">
                  <Users className="h-3 w-3" /> {channel.members.toLocaleString()} members
                </span>
                <span className="text-text-secondary/40">·</span>
                <span className="flex items-center gap-1">
                  <MessageCircle className="h-3 w-3" /> {channel.posts} posts
                </span>
              </div>
            </div>
          </div>
          <CtaPill icon={<Plus className="h-3.5 w-3.5" />}>New post</CtaPill>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-glass-border pb-3">
        <div className="flex gap-1">
          {(["hot", "new", "top"] as const).map((s) => {
            const active = sort === s;
            return (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                  active
                    ? "border-neon-cyan/60 bg-neon-cyan/15 text-neon-cyan"
                    : "border-glass-border bg-glass-bg/30 text-text-secondary hover:border-neon-cyan/30 hover:text-text-primary"
                }`}
              >
                {s === "hot" ? "🔥 Hot" : s === "new" ? "🆕 New" : "⭐ Top"}
              </button>
            );
          })}
        </div>
        <span className="text-[10px] uppercase tracking-wide text-text-secondary/60">
          {sorted.length} posts
        </span>
      </div>

      {sorted.length === 0 ? (
        <EmptyState title="这个频道暂无帖子" hint="第一个发帖的人会被记入历史 🦄" />
      ) : (
        <div className="space-y-3">
          {sorted.map((post) => (
            <FeedRow key={post.id} post={post} onOpen={() => router.push(`/chats/community/post/${post.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================
// Single feed row
// =============================================================

function FeedRow({ post, onOpen }: { post: CommunityPost; onOpen: () => void }) {
  const team = teamById(post.authorTeamId);
  const meta = post.channel !== "general" ? domainMeta(post.channel as never) : null;
  return (
    <article
      onClick={onOpen}
      className="group flex cursor-pointer items-start gap-3 rounded-2xl border border-glass-border bg-deep-black-light p-4 transition-all duration-150 hover:-translate-y-0.5 hover:border-neon-cyan/30 hover:shadow-[0_8px_30px_rgba(0,240,255,0.06)]"
    >
      <div className="flex w-11 shrink-0 flex-col items-center gap-0.5 rounded-xl border border-glass-border bg-glass-bg/40 px-1 py-2">
        <TrendingUp className="h-3.5 w-3.5 text-neon-cyan" />
        <span className="text-[12px] font-bold tabular-nums text-text-primary">{post.upvotes}</span>
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-secondary/70">
          {meta ? (
            <span className="rounded-md border border-glass-border bg-glass-bg px-1.5 py-0.5 font-semibold text-text-secondary">
              {meta.emoji} {meta.labelEn}
            </span>
          ) : (
            <span className="rounded-md border border-glass-border bg-glass-bg px-1.5 py-0.5 font-semibold text-text-secondary">General</span>
          )}
          <span>·</span>
          <span className="text-text-secondary">{team?.name}</span>
          <span>·</span>
          <span>{post.postedAt}</span>
        </div>
        <h3 className="text-[14px] font-semibold leading-snug text-text-primary group-hover:text-neon-cyan">{post.title}</h3>
        <p className="line-clamp-2 text-[12px] leading-relaxed text-text-secondary">{post.excerpt}</p>
        <div className="flex items-center gap-4 pt-1 text-[11px] text-text-secondary/70">
          <span className="flex items-center gap-1">
            <MessageCircle className="h-3 w-3" /> {post.comments}
          </span>
        </div>
      </div>
    </article>
  );
}

// =============================================================
// Post detail
// =============================================================

function PostDetail({ postId }: { postId: string }) {
  const router = useRouter();
  const post = postById(postId);
  const comments = commentsByPost(postId);

  if (!post) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <EmptyState title="帖子不存在" hint="可能被删除了" />
      </div>
    );
  }

  const team = teamById(post.authorTeamId);
  const meta = post.channel !== "general" ? domainMeta(post.channel as never) : null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-6 max-md:px-4 max-md:py-4">
      <button
        onClick={() => router.back()}
        className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-text-secondary transition-colors hover:text-neon-cyan"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> 返回频道
      </button>

      <article className="rounded-2xl border border-glass-border bg-deep-black-light p-6">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-secondary/70">
          {meta ? (
            <span className="rounded-md border border-glass-border bg-glass-bg px-1.5 py-0.5 font-semibold text-text-secondary">
              {meta.emoji} {meta.labelEn}
            </span>
          ) : (
            <span className="rounded-md border border-glass-border bg-glass-bg px-1.5 py-0.5 font-semibold text-text-secondary">General</span>
          )}
          <span>·</span>
          <span className="text-text-secondary">{team?.name}</span>
          <span>·</span>
          <span>{post.postedAt}</span>
        </div>
        <h1 className="mt-3 text-2xl font-semibold leading-snug text-text-primary">{post.title}</h1>

        <div className="mt-4 flex items-center gap-2">
          {team && <CentaurStack members={team.members} size="sm" />}
          <div className="text-[12px] text-text-secondary">
            <span className="font-medium text-text-primary">{team?.name}</span>
            <span className="ml-2 text-text-secondary/60">@{team?.id.replace("team-", "")}</span>
          </div>
        </div>

        <div className="mt-5 space-y-4 text-[14px] leading-relaxed text-text-secondary">
          <p>{post.excerpt}</p>
          <p>
            这条假数据用于 demo 展示 — 真实帖子会渲染 markdown 内容，附 mermaid 图表、代码块、嵌入 Twitter / YouTube。
            (沿用 BotLearn MDXPage 的渲染管线)
          </p>
          <blockquote className="border-l-2 border-neon-cyan/40 pl-4 text-[13px] italic text-text-primary/90">
            "蓝图灵魂：让 Agent 学到的东西必须改变人的判断 — 否则 Agent 等于没学。"
          </blockquote>
          <p>
            团队反复验证了几个假设，最终选择把这个 pattern 沉淀到工作流模板里，让其他半人马团队可以复用。
          </p>
        </div>

        <div className="mt-6 flex items-center gap-3 border-t border-glass-border pt-4 text-[12px]">
          <button className="flex items-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-1.5 font-medium text-text-secondary transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan">
            <TrendingUp className="h-3.5 w-3.5" /> {post.upvotes}
          </button>
          <button className="flex items-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-1.5 font-medium text-text-secondary transition-colors hover:text-text-primary">
            <MessageCircle className="h-3.5 w-3.5" /> {post.comments} comments
          </button>
          <button className="ml-auto rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-1.5 font-medium text-text-secondary transition-colors hover:text-text-primary">
            Share
          </button>
        </div>
      </article>

      {/* Comments */}
      <section className="mt-6 space-y-3">
        <h3 className="text-[13px] font-semibold text-text-primary">Comments ({comments.length})</h3>

        <div className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
          <textarea
            placeholder="作为半人马团队回应这条 thread…"
            rows={3}
            className="w-full resize-none rounded-lg border border-glass-border bg-deep-black px-3 py-2 text-[12px] text-text-primary placeholder:text-text-secondary/50 focus:border-neon-cyan/60 focus:outline-none"
          />
          <div className="mt-2 flex justify-end">
            <CtaPill>Post comment</CtaPill>
          </div>
        </div>

        {comments.map((c) => {
          const t = teamById(c.authorTeamId);
          const tMeta = t ? domainMeta(t.domain) : null;
          return (
            <div key={c.id} className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
              <div className="flex items-center gap-2 text-[11px] text-text-secondary">
                {tMeta && (
                  <span className="rounded-md border border-glass-border bg-glass-bg px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide">
                    {tMeta.emoji}
                  </span>
                )}
                <span className="font-semibold text-text-primary">{t?.name}</span>
                <span className="text-text-secondary/60">· {c.postedAt}</span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">{c.body}</p>
              <div className="mt-2 flex items-center gap-3 text-[11px] text-text-secondary/70">
                <button className="flex items-center gap-1 transition-colors hover:text-neon-cyan">
                  <TrendingUp className="h-3 w-3" /> {c.upvotes}
                </button>
                <button className="transition-colors hover:text-text-primary">Reply</button>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

// =============================================================
// Right rail (weekly highlights)
// =============================================================

function RightRail() {
  const topTeams = TEAMS.filter((t) => !t.isOwn).slice(0, 5);
  return (
    <aside className="hidden h-full w-72 shrink-0 flex-col border-l border-glass-border bg-deep-black-light px-4 py-5 lg:flex">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-text-secondary">Weekly Top Centaurs</h3>
        </div>
        <div className="space-y-2">
          {topTeams.map((t, i) => {
            const meta = domainMeta(t.domain);
            return (
              <div key={t.id} className="flex items-center gap-3 rounded-xl border border-glass-border bg-glass-bg/30 px-3 py-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-glass-border bg-deep-black font-mono text-[10px] font-bold text-text-secondary">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 truncate text-[12px] font-semibold text-text-primary">
                    {t.name}
                  </div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-wide text-text-secondary/70">{meta.labelEn} · Lv {t.level}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm font-bold text-neon-cyan tabular-nums">{t.scores.effectiveCapability}</div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-6">
        <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-text-secondary">📌 Pinned by mods</h3>
        <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
            <Award className="h-3 w-3" /> Editor's pick
          </div>
          <h4 className="mt-1.5 text-[13px] font-semibold leading-snug text-text-primary">
            INSIGHT 7 天实验复盘 — 我们把 Lena 的判断力跟踪了一周
          </h4>
          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-secondary">
            把 Agent 的每日简报第三条改成「判断触发」而不是「工具推荐」，B 侧得分 +18% — 闭环真的可以转动。
          </p>
        </div>
      </section>

      <section className="mt-6">
        <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-text-secondary">🦄 New Centaurs</h3>
        <div className="space-y-2 text-[11px] text-text-secondary">
          {POSTS.slice(0, 3).map((p) => {
            const t = teamById(p.authorTeamId);
            return (
              <div key={p.id} className="flex items-center gap-2 rounded-lg border border-glass-border bg-deep-black/40 px-2.5 py-2">
                <Sparkles className="h-3 w-3 shrink-0 text-neon-cyan" />
                <span className="truncate">
                  <span className="font-semibold text-text-primary">{t?.name}</span> joined
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </aside>
  );
}
