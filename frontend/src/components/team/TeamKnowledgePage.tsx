"use client";
/**
 * [INPUT]: 组织 Space ID；`lib/team-kb.ts` 用户鉴权接口
 * [OUTPUT]: Team 工作区「知识库」页：目录树/搜索、页面阅读与编辑、草稿审核
 * [POS]: TeamWorkspacePage 的 view=knowledge；设计见 docs/space-knowledge-base-design.md
 * [PROTOCOL]: 变更时同步 components/team/README.md
 */
import Alert from "@/components/ui/Alert";
import Badge from "@/components/ui/Badge";
import { BotCordLoadingBlock } from "@/components/ui/BotCordLoader";
import Button from "@/components/ui/Button";
import Disclosure from "@/components/ui/Disclosure";
import EmptyState from "@/components/ui/EmptyState";
import Field from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import MarkdownContent from "@/components/ui/MarkdownContent";
import SearchInput from "@/components/ui/SearchInput";
import Tabs from "@/components/ui/Tabs";
import { ApiError } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import {
  buildPageInput,
  kbDepth,
  kbName,
  teamKbApi,
  type KbNode,
  type KbPage,
  type KbRevision,
  type KbSearchResult,
} from "@/lib/team-kb";
import { useConfirm } from "@/store/useConfirmStore";
import { toast } from "@/store/useToastStore";
import { ArrowLeft, BookOpen, FileText, Folder, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Tab = "pages" | "review";
interface Draft {
  path: string;
  title: string;
  content: string;
  description: string;
  summary: string;
}

const README_TEMPLATE = "# 团队手册\n\n- 我们是谁、在做什么\n- 协作约定\n- 常用入口\n";

export default function TeamKnowledgePage({
  spaceId,
  names = {},
}: {
  spaceId: string;
  /** hu_/ag_ id → display name, so authors show as people rather than IDs. */
  names?: Record<string, string>;
}) {
  const zh = useLanguage() === "zh";
  const t = useCallback((cn: string, en: string) => (zh ? cn : en), [zh]);
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>("pages");
  const [nodes, setNodes] = useState<KbNode[] | null>(null);
  const [canPublish, setCanPublish] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KbSearchResult[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<KbPage | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingNew, setEditingNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revisions, setRevisions] = useState<KbRevision[]>([]);
  const [review, setReview] = useState<{ revision: KbRevision; current: KbPage | null } | null>(null);

  const message = useCallback(
    (err: unknown) => {
      const code = err instanceof ApiError ? err.message : "";
      if (code === "kb_version_conflict" || code === "kb_revision_stale") {
        return t("页面已被其他人修改，请刷新后重新编辑。", "Someone changed this page. Reload and edit again.");
      }
      if (code === "kb_page_too_large") return t("页面超过 50KB，请拆分。", "Pages are limited to 50 KB; split it up.");
      if (code.startsWith("kb_invalid_path") || code.includes("path")) {
        return t("路径无效：以 / 开头、不含空格、页面以 .md 结尾、最多 6 层。", "Invalid path: start with /, no spaces, pages end in .md, at most 6 levels.");
      }
      return t("操作失败，请稍后重试。", "Something went wrong. Try again.");
    },
    [t],
  );

  const loadTree = useCallback(async () => {
    try {
      const [tree, pending] = await Promise.all([teamKbApi.tree(spaceId), teamKbApi.revisions(spaceId)]);
      setNodes(tree.nodes);
      setCanPublish(tree.can_publish);
      setRevisions(pending.revisions);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [spaceId, message]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    if (!selected) return setPage(null);
    const controller = new AbortController();
    teamKbApi
      .page(spaceId, selected, controller.signal)
      .then(setPage)
      .catch((err) => {
        if (!controller.signal.aborted) setError(message(err));
      });
    return () => controller.abort();
  }, [spaceId, selected, message]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return setResults(null);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      teamKbApi
        .search(spaceId, trimmed, controller.signal)
        .then((r) => setResults(r.results))
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [spaceId, query]);

  const startEdit = (target: KbPage | null, path = "") => {
    setEditingNew(!target);
    setDraft({
      path: target?.path ?? path,
      title: target?.title ?? "",
      content: target?.content ?? (path === "/README.md" ? README_TEMPLATE : ""),
      description: target?.description ?? "",
      summary: target?.summary ?? "",
    });
  };

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const original = editingNew || !page ? null : page;
      const result = await teamKbApi.write(spaceId, buildPageInput(original, draft));
      toast({
        title:
          result.status === "published"
            ? t("已发布", "Published")
            : t("已提交草稿，等待 owner/admin 审核", "Draft submitted for owner/admin review"),
        tone: "success",
      });
      setDraft(null);
      await loadTree();
      // Same path: refresh in place (no empty-state flash); new path: the selection effect loads it.
      if (result.node.path === selected) setPage(await teamKbApi.page(spaceId, result.node.path));
      else setSelected(result.node.path);
    } catch (err) {
      toast({ title: message(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: KbPage) => {
    const ok = await confirm({
      title: `${t("删除", "Delete")} ${target.path}`,
      message:
        target.kind === "dir"
          ? t("目录下的所有页面和待审核草稿都会删除。", "Every page and pending draft under this folder is deleted.")
          : t("页面和它的待审核草稿都会删除。", "The page and its pending drafts are deleted."),
      confirmLabel: t("删除", "Delete"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      await teamKbApi.remove(spaceId, target.path);
      setSelected(null);
      await loadTree();
    } catch (err) {
      toast({ title: message(err), tone: "danger" });
    }
  };

  const openReview = async (revisionId: string) => {
    try {
      setReview(await teamKbApi.revision(spaceId, revisionId));
    } catch (err) {
      toast({ title: message(err), tone: "danger" });
    }
  };

  const decide = async (approve: boolean) => {
    if (!review || busy) return;
    setBusy(true);
    try {
      if (approve) await teamKbApi.approve(spaceId, review.revision.revision_id);
      else await teamKbApi.reject(spaceId, review.revision.revision_id);
      toast({ title: approve ? t("已发布", "Published") : t("已拒绝", "Rejected"), tone: "success" });
    } catch (err) {
      toast({ title: message(err), tone: "danger" });
    } finally {
      setReview(null);
      setBusy(false);
      await loadTree();
    }
  };

  const nameOf = (id: string) =>
    names[id] ?? (id.startsWith("ag_") ? t("已离开的 Agent", "Former Agent") : t("已离开的成员", "Former member"));
  const sourceBadge = (source: string | null | undefined) =>
    source === "agent" ? <Badge size="sm">{t("agent 生成", "Agent-written")}</Badge> : null;

  const list = results ?? nodes ?? [];
  const header = (
    <header className="flex min-h-[76px] flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
      <div className="flex items-center gap-3">
        <h1 className="font-semibold">{t("知识库", "Knowledge base")}</h1>
        <Tabs
          variant="segmented"
          size="sm"
          ariaLabel={t("知识库视图", "Knowledge base view")}
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          items={[
            { value: "pages", label: t("页面", "Pages") },
            {
              value: "review",
              label: t("待审核", "Review"),
              badge: revisions.length ? <Badge size="sm" tone="accent">{revisions.length}</Badge> : undefined,
            },
          ]}
        />
      </div>
      {tab === "pages" && !draft && (
        <Button variant="primary" size="sm" onClick={() => startEdit(null, "/knowledge/")}>
          <Plus size={16} aria-hidden />
          {t("新建页面", "New page")}
        </Button>
      )}
    </header>
  );

  if (error && !nodes) {
    return (
      <div>
        {header}
        <div className="p-6">
          <Alert tone="danger">{error}</Alert>
        </div>
      </div>
    );
  }
  if (!nodes) {
    return (
      <div>
        {header}
        <BotCordLoadingBlock label={t("正在加载知识库", "Loading knowledge base")} />
      </div>
    );
  }

  const editor = draft && (
    <div className="space-y-4">
      {!canPublish && (
        <Alert tone="neutral">
          {t("你的修改会作为草稿提交，owner/admin 审核后发布。", "Your change is submitted as a draft; an owner/admin publishes it.")}
        </Alert>
      )}
      {editingNew && (
        <Field label={t("路径", "Path")} hint={t("例如 /handbook/release.md", "e.g. /handbook/release.md")}>
          <Input
            value={draft.path}
            className="font-mono text-[13px]"
            onChange={(e) => setDraft({ ...draft, path: e.target.value })}
          />
        </Field>
      )}
      <Field label={t("标题", "Title")}>
        <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </Field>
      <Field label={t("正文（Markdown）", "Body (Markdown)")}>
        <Textarea
          rows={18}
          value={draft.content}
          className="font-mono text-[13px]"
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
        />
      </Field>
      <Disclosure title={t("描述与摘要（留空由 agent 补写）", "Description and summary (agents fill blanks)")}>
        <div className="space-y-3 pt-3">
          <Field
            label={t("描述：什么时候该读这一页", "Description: when to read this page")}
            hint={t("最多 200 字。你填写后 agent 不会覆盖。", "Up to 200 characters. Agents never overwrite what you write.")}
          >
            <Textarea
              rows={2}
              maxLength={200}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </Field>
          <Field label={t("摘要：这一页说了什么", "Summary: what this page says")} hint={t("最多 500 字。", "Up to 500 characters.")}>
            <Textarea
              rows={3}
              maxLength={500}
              value={draft.summary}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            />
          </Field>
        </div>
      </Disclosure>
      <div className="flex justify-end gap-2">
        <Button onClick={() => setDraft(null)} disabled={busy}>
          {t("取消", "Cancel")}
        </Button>
        <Button variant="primary" loading={busy} onClick={save}>
          {canPublish ? t("发布", "Publish") : t("提交草稿", "Submit draft")}
        </Button>
      </div>
    </div>
  );

  const detail = page && (
    <article className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="type-heading-3 break-words">{page.title ?? kbName(page.path)}</h2>
          <p className="font-mono text-[13px] text-text-secondary">{page.path}</p>
        </div>
        <div className="flex gap-2">
          {page.kind === "page" && <Button size="sm" onClick={() => startEdit(page)}>{t("编辑", "Edit")}</Button>}
          {canPublish && (
            <Button size="sm" variant="danger" onClick={() => remove(page)}>
              {t("删除", "Delete")}
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {page.kind === "page" &&
          (page.version > 0 ? <Badge size="sm">v{page.version}</Badge> : <Badge size="sm" tone="warning">{t("草稿", "Draft")}</Badge>)}
        {page.updated_by && <Badge size="sm" variant="outline">{t("最后编辑", "Edited by")} {nameOf(page.updated_by)}</Badge>}
        {page.tags.map((tag) => (
          <Badge key={tag} size="sm" variant="outline">{tag}</Badge>
        ))}
      </div>
      {page.pending_revisions.length > 0 && (
        <Alert
          tone="warning"
          actions={
            <Button size="sm" onClick={() => { setTab("review"); void openReview(page.pending_revisions[0].revision_id); }}>
              {t("查看", "View")}
            </Button>
          }
        >
          {t(`${page.pending_revisions.length} 个修改待审核`, `${page.pending_revisions.length} pending change(s)`)}
        </Alert>
      )}
      <dl className="space-y-3 rounded-xl border border-border bg-surface-sunken p-4 text-sm">
        <div>
          <dt className="type-caption flex items-center gap-2 text-text-secondary">
            {t("描述", "Description")} {sourceBadge(page.description_source)}
          </dt>
          <dd className="mt-1">{page.description ?? <span className="text-text-secondary">{t("待 agent 补写", "Waiting for an agent")}</span>}</dd>
        </div>
        <div>
          <dt className="type-caption flex items-center gap-2 text-text-secondary">
            {t("摘要", "Summary")} {sourceBadge(page.summary_source)}
            {page.summary_stale && <Badge size="sm" tone="warning">{t("已过期", "Stale")}</Badge>}
          </dt>
          <dd className="mt-1">{page.summary ?? <span className="text-text-secondary">{t("待 agent 补写", "Waiting for an agent")}</span>}</dd>
        </div>
      </dl>
      {page.kind === "page" ? (
        page.content ? <MarkdownContent content={page.content} /> : (
          <p className="text-sm text-text-secondary">{t("草稿尚未发布，内容在待审核里。", "Not published yet; the content is in Review.")}</p>
        )
      ) : (
        <p className="text-sm text-text-secondary">{t(`目录，包含 ${page.children ?? 0} 项。`, `Folder with ${page.children ?? 0} items.`)}</p>
      )}
    </article>
  );

  // Mobile shows the list or the detail, never both (like the message workspace).
  const pageOpen = Boolean(draft || selected);
  const backToList = (
    <Button variant="inline" className="mb-4 md:hidden" onClick={() => { setDraft(null); setSelected(null); setReview(null); }}>
      <ArrowLeft size={16} aria-hidden />
      {t("返回目录", "Back to list")}
    </Button>
  );

  const pagesView = (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className={`flex min-h-0 shrink-0 flex-col gap-3 p-3 max-md:flex-1 md:w-72 md:border-r md:border-border ${pageOpen ? "max-md:hidden" : ""}`}>
        <SearchInput
          label={t("搜索知识库", "Search knowledge base")}
          placeholder={t("搜索标题、描述、正文", "Search titles, descriptions, text")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <nav aria-label={t("知识库目录", "Knowledge base tree")} className="flex flex-col gap-0.5 overflow-y-auto">
          {list.length === 0 && (
            <p className="px-2 py-3 text-sm text-text-secondary">
              {results ? t("没有结果", "No results") : t("还没有页面", "No pages yet")}
            </p>
          )}
          {list.map((n) => (
            <Button
              key={n.node_id}
              variant="row"
              aria-current={selected === n.path ? "page" : undefined}
              onClick={() => { setDraft(null); setSelected(n.path); }}
            >
              <span className="flex min-w-0 items-center gap-2" style={results ? undefined : { paddingLeft: kbDepth(n.path) * 12 }}>
                {n.kind === "dir" ? <Folder size={16} aria-hidden /> : <FileText size={16} aria-hidden />}
                <span className="min-w-0 flex-1 truncate text-left">{results ? n.path : kbName(n.path)}</span>
                {n.kind === "page" && n.version === 0 && <Badge size="sm" tone="warning">{t("草稿", "Draft")}</Badge>}
                {n.pending > 0 && n.version > 0 && <Badge size="sm" tone="accent">{n.pending}</Badge>}
              </span>
            </Button>
          ))}
        </nav>
      </aside>
      <section className={`min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 ${pageOpen || nodes.length === 0 ? "" : "max-md:hidden"}`}>
        {pageOpen && backToList}
        {draft ? editor : detail ?? (
          nodes.length === 0 ? (
            <EmptyState
              icon={<BookOpen />}
              title={t("还没有知识页面", "No knowledge pages yet")}
              description={t(
                "从 README 开始：写下团队约定，组织房间里的 agent 每轮都会读到它。",
                "Start with a README: team conventions here are shown to agents on every turn in organization rooms.",
              )}
              action={<Button variant="primary" onClick={() => startEdit(null, "/README.md")}>{t("创建 README", "Create README")}</Button>}
            />
          ) : (
            <EmptyState
              compact
              icon={<FileText />}
              title={t("选择一个页面", "Select a page")}
              description={t("agent 通过 botcord kb 命令检索这些页面。", "Agents retrieve these pages with botcord kb.")}
            />
          )
        )}
      </section>
    </div>
  );

  const reviewView = (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className={`flex min-h-0 shrink-0 flex-col gap-1 overflow-y-auto p-3 max-md:flex-1 md:w-72 md:border-r md:border-border ${review ? "max-md:hidden" : ""}`}>
        {revisions.length === 0 && <p className="px-2 py-3 text-sm text-text-secondary">{t("没有待审核的修改", "Nothing to review")}</p>}
        {revisions.map((r) => (
          <Button
            key={r.revision_id}
            variant="row"
            aria-current={review?.revision.revision_id === r.revision_id ? "page" : undefined}
            onClick={() => openReview(r.revision_id)}
          >
            <span className="flex min-w-0 flex-col items-start">
              <span className="w-full truncate font-mono text-[13px]">{r.path}</span>
              <span className="type-caption text-text-secondary">{nameOf(r.author)}</span>
            </span>
          </Button>
        ))}
      </aside>
      <section className={`min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 ${review ? "" : "max-md:hidden"}`}>
        {review && backToList}
        {review ? (
          <article className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <h2 className="type-heading-3 break-words">{review.revision.title ?? review.revision.path}</h2>
                <p className="font-mono text-[13px] text-text-secondary">
                  {review.revision.path} · {t("提交者", "by")} {nameOf(review.revision.author)} · {t("基于", "based on")} v{review.revision.base_version}
                </p>
              </div>
              {canPublish ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => decide(false)}>{t("拒绝", "Reject")}</Button>
                  <Button size="sm" variant="primary" loading={busy} onClick={() => decide(true)}>{t("发布", "Publish")}</Button>
                </div>
              ) : (
                <Badge>{t("仅 owner/admin 可审核", "Owners/admins review")}</Badge>
              )}
            </div>
            {review.current && review.current.version !== review.revision.base_version && (
              <Alert tone="warning">{t("页面在草稿提交后已更新，发布会失败。", "The page changed after this draft; publishing will fail.")}</Alert>
            )}
            {review.revision.note && <Alert tone="neutral">{review.revision.note}</Alert>}
            {(review.revision.description || review.revision.summary) && (
              <dl className="space-y-2 rounded-xl border border-border bg-surface-sunken p-4 text-sm">
                {review.revision.description && <div><dt className="type-caption text-text-secondary">{t("描述", "Description")}</dt><dd>{review.revision.description}</dd></div>}
                {review.revision.summary && <div><dt className="type-caption text-text-secondary">{t("摘要", "Summary")}</dt><dd>{review.revision.summary}</dd></div>}
              </dl>
            )}
            <MarkdownContent content={review.revision.content ?? ""} />
            {review.current?.content && (
              <Disclosure title={t("当前已发布版本", "Currently published version")}>
                <div className="pt-3">
                  <MarkdownContent content={review.current.content} />
                </div>
              </Disclosure>
            )}
          </article>
        ) : (
          <EmptyState compact icon={<FileText />} title={t("选择一个草稿", "Select a draft")} />
        )}
      </section>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      {tab === "pages" ? pagesView : reviewView}
    </div>
  );
}
