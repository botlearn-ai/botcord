/** Space knowledge base (dashboard side): browse, edit, review drafts. User auth only. */
import { ApiError, apiFetch } from "./api";

export type KbNodeKind = "dir" | "page";
export type KbSource = "human" | "agent" | null;

export interface KbNode {
  node_id: string;
  path: string;
  kind: KbNodeKind;
  title: string | null;
  description: string | null;
  description_missing: boolean;
  description_source: KbSource;
  tags: string[];
  /** 0 = draft-only page that was never published. */
  version: number;
  pending: number;
  size_bytes: number;
  updated_by: string;
  updated_at: string | null;
  summary?: string | null;
  summary_source?: KbSource;
  summary_stale?: boolean;
  summary_missing?: boolean;
  children?: number;
}

export interface KbRevision {
  revision_id: string;
  node_id: string;
  path: string | null;
  kind: "content" | "meta";
  base_version: number;
  status: "proposed" | "published" | "rejected" | "superseded";
  title: string | null;
  description: string | null;
  summary: string | null;
  tags: string[] | null;
  author: string;
  reviewer: string | null;
  note: string | null;
  created_at: string | null;
  reviewed_at: string | null;
  content?: string | null;
}

export interface KbPage extends KbNode {
  content: string | null;
  content_hash: string | null;
  source_refs: { type: string; id: string }[];
  created_by: string;
  pending_revisions: KbRevision[];
}

export interface KbSearchResult extends KbNode {
  score: number;
  snippet: string | null;
}

export interface KbPageInput {
  path: string;
  content: string;
  title?: string;
  description?: string;
  summary?: string;
  base_version?: number;
  note?: string;
}

export interface KbWriteResult {
  status: "published" | "proposed";
  revision_id: string;
  node: KbNode;
}

/** Hub error code (`detail` may be a string or `{ code, ... }`). */
function errorCode(body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && typeof (detail as { code?: unknown }).code === "string") {
    return (detail as { code: string }).code;
  }
  return "kb_request_failed";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, { ...init, cache: "no-store" }, null);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, errorCode(body));
  }
  return response.json() as Promise<T>;
}

const base = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/kb`;
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const teamKbApi = {
  tree: (spaceId: string, signal?: AbortSignal) =>
    request<{ nodes: KbNode[]; can_publish: boolean }>(`${base(spaceId)}/tree`, { signal }),
  page: (spaceId: string, path: string, signal?: AbortSignal) =>
    request<KbPage>(`${base(spaceId)}/page?${q({ path })}`, { signal }),
  search: (spaceId: string, query: string, signal?: AbortSignal) =>
    request<{ results: KbSearchResult[] }>(`${base(spaceId)}/search?${q({ q: query })}`, { signal }),
  write: (spaceId: string, input: KbPageInput) =>
    request<KbWriteResult>(`${base(spaceId)}/page`, json("PUT", input)),
  setMeta: (spaceId: string, input: { path: string; description?: string; summary?: string; content_hash?: string }) =>
    request<{ result: Record<string, string>; node: KbNode }>(`${base(spaceId)}/meta`, json("PATCH", input)),
  remove: (spaceId: string, path: string) =>
    request<{ deleted: number }>(`${base(spaceId)}/node?${q({ path })}`, { method: "DELETE" }),
  revisions: (spaceId: string, signal?: AbortSignal) =>
    request<{ revisions: KbRevision[] }>(`${base(spaceId)}/revisions`, { signal }),
  revision: (spaceId: string, revisionId: string, signal?: AbortSignal) =>
    request<{ revision: KbRevision; current: KbPage | null }>(
      `${base(spaceId)}/revisions/${encodeURIComponent(revisionId)}`,
      { signal },
    ),
  approve: (spaceId: string, revisionId: string) =>
    request<{ status: string }>(`${base(spaceId)}/revisions/${encodeURIComponent(revisionId)}/approve`, { method: "POST" }),
  reject: (spaceId: string, revisionId: string, note?: string) =>
    request<{ status: string }>(
      `${base(spaceId)}/revisions/${encodeURIComponent(revisionId)}/reject`,
      json("POST", note ? { note } : {}),
    ),
};

/** Nesting depth for indentation: "/a" → 0, "/a/b.md" → 1. */
export function kbDepth(path: string): number {
  return Math.max(0, path.split("/").length - 2);
}

export function kbName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Only send metadata the editor actually changed: re-sending an agent-written
 * description would silently mark it human-owned.
 */
export function buildPageInput(
  original: { description: string | null; summary?: string | null; version: number } | null,
  draft: { path: string; title: string; content: string; description: string; summary: string },
): KbPageInput {
  const input: KbPageInput = { path: draft.path.trim(), content: draft.content };
  if (draft.title.trim()) input.title = draft.title.trim();
  const description = draft.description.trim();
  const summary = draft.summary.trim();
  if (description && description !== (original?.description ?? "")) input.description = description;
  if (summary && summary !== (original?.summary ?? "")) input.summary = summary;
  if (original) input.base_version = original.version;
  return input;
}
